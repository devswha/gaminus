import os from 'node:os';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { appConfigDb, sessionsDb } from '@/modules/database/index.js';
import {
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import type { AnyRecord } from '@/shared/types.js';

const UNTITLED_GJC_SESSION = 'Untitled gjc Session';
const GJC_INITIAL_SCAN_DONE_KEY = 'gjc_initial_scan_done';
const GJC_PENDING_SESSION_FILES_KEY = 'gjc_pending_session_files';

type SessionFile = {
  filePath: string;
  rootPath: string;
};

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

/**
 * Joins the text parts of a gjc `message.content[]` array.
 *
 * gjc stores each turn's body as an array of typed parts, so the title/first
 * prompt is recovered from the `text` parts only.
 */
function extractGjcTextFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return '';
      }
      const record = part as AnyRecord;
      if (record.type === 'text' && typeof record.text === 'string') {
        return record.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Session indexer for Gajae Code (gjc) transcript artifacts.
 *
 * gjc writes one JSONL transcript per session under
 * `~/.gjc/agent/sessions/<cwd-slug>/`. The authoritative session id and cwd
 * live on the top-level header line (`{"type":"session","id":..,"cwd":..}`),
 * unlike Codex which nests them under `payload`.
 */
export class GjcSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'gjc' as const;
  private readonly sessionsDir = path.join(os.homedir(), '.gjc', 'agent', 'sessions');
  private readonly liveSessionsDir = process.env.GJC_LIVE_SESSION_DIR
    || path.join(os.tmpdir(), 'gjc-live-sessions');

  /**
   * A top-level session is `sessions/<cwd-slug>/<ts>_<uuid>.jsonl`. Subagent
   * transcripts (e.g. ralplan passes like `2-CriticPass1.jsonl`) live one level
   * deeper inside the session's sidecar dir `sessions/<slug>/<ts>_<uuid>/*.jsonl`
   * and relate to the parent session; indexing them as standalone sessions
   * pollutes the sidebar (~5.5x). Only depth-1 and depth-2 files are real
   * sessions because `--session-dir` may write directly into its root.
   */
  private async isSubagentTranscript(filePath: string, sessionRoot: string): Promise<boolean> {
    const [resolvedRoot, resolvedFile] = await Promise.all([
      this.resolveRealpathOrOriginal(sessionRoot),
      this.resolveRealpathOrOriginal(filePath),
    ]);
    const rel = path.relative(resolvedRoot, resolvedFile);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return false;
    }

    return rel.split(path.sep).length > 2;
  }

  private getSessionRoots(): string[] {
    return [...new Set([this.sessionsDir, this.liveSessionsDir])];
  }

  private async getSessionRootForFile(filePath: string): Promise<string | null> {
    for (const sessionRoot of this.getSessionRoots()) {
      const [resolvedRoot, resolvedFile] = await Promise.all([
        this.resolveRealpathOrOriginal(sessionRoot),
        this.resolveRealpathOrOriginal(filePath),
      ]);
      const rel = path.relative(resolvedRoot, resolvedFile);
      if (rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
        return sessionRoot;
      }
    }

    return null;
  }

  private async resolveRealpathOrOriginal(target: string): Promise<string> {
    try {
      return await realpath(target);
    } catch {
      return target;
    }
  }

  private getPendingSessionFiles(): Map<string, SessionFile> {
    const rawPendingFiles = appConfigDb.get(GJC_PENDING_SESSION_FILES_KEY);
    if (!rawPendingFiles) {
      return new Map();
    }

    try {
      const pendingFiles = JSON.parse(rawPendingFiles);
      if (!Array.isArray(pendingFiles)) {
        return new Map();
      }

      return new Map(
        pendingFiles
          .filter((file): file is SessionFile => (
            file
            && typeof file === 'object'
            && typeof file.filePath === 'string'
            && typeof file.rootPath === 'string'
          ))
          .map((file) => [file.filePath, file])
      );
    } catch {
      return new Map();
    }
  }

  private savePendingSessionFiles(pendingFiles: Map<string, SessionFile>): void {
    appConfigDb.set(GJC_PENDING_SESSION_FILES_KEY, JSON.stringify([...pendingFiles.values()]));
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      return (await stat(filePath)).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Scans persisted and live gjc session directories and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const initialScanDone = appConfigDb.get(GJC_INITIAL_SCAN_DONE_KEY) === 'true';
    const scanSince = initialScanDone ? since ?? null : null;
    const sessionFiles = new Map<string, SessionFile>();
    const pendingFiles = this.getPendingSessionFiles();

    for (const sessionRoot of this.getSessionRoots()) {
      const files = await findFilesRecursivelyCreatedAfter(sessionRoot, '.jsonl', scanSince);
      for (const filePath of files) {
        sessionFiles.set(filePath, { filePath, rootPath: sessionRoot });
      }
    }

    for (const pendingFile of pendingFiles.values()) {
      if (await this.fileExists(pendingFile.filePath)) {
        sessionFiles.set(pendingFile.filePath, pendingFile);
      } else {
        pendingFiles.delete(pendingFile.filePath);
      }
    }

    let processed = 0;
    let iterated = 0;
    for (const { filePath, rootPath } of sessionFiles.values()) {
      // Yield to the event loop periodically so a large first-index full sync
      // (thousands of sessions, concurrent with other providers) doesn't starve it.
      if (++iterated % 50 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (await this.isSubagentTranscript(filePath, rootPath)) {
        pendingFiles.delete(filePath);
        continue;
      }
      const parsed = await this.processSessionFile(filePath);
      if (!parsed) {
        // A live transcript can be observed while its header is still being written.
        // Keep it outside the shared scan cursor so a later scan retries it.
        pendingFiles.set(filePath, { filePath, rootPath });
        continue;
      }
      pendingFiles.delete(filePath);

      const existingSession = sessionsDb.getSessionByProviderSessionId(this.provider, parsed.sessionId)
        ?? sessionsDb.getSessionById(parsed.sessionId);
      if (existingSession) {
        // If the session is still untitled and we now have a name, update it.
        if (
          existingSession.custom_name === UNTITLED_GJC_SESSION
          && parsed.sessionName
          && parsed.sessionName !== UNTITLED_GJC_SESSION
        ) {
          sessionsDb.updateSessionCustomName(existingSession.session_id, parsed.sessionName);
        }
      }

      const timestamps = await readFileTimestamps(filePath);
      sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        filePath
      );
      processed += 1;
    }

    this.savePendingSessionFiles(pendingFiles);
    if (!initialScanDone && pendingFiles.size === 0) {
      appConfigDb.set(GJC_INITIAL_SCAN_DONE_KEY, 'true');
    }

    return processed;
  }

  /**
   * Parses and upserts one gjc session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }

    const sessionRoot = await this.getSessionRootForFile(filePath);
    if (!sessionRoot || await this.isSubagentTranscript(filePath, sessionRoot)) {
      return null;
    }

    const parsed = await this.processSessionFile(filePath);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );
  }

  /**
   * Extracts session metadata from one gjc JSONL session file.
   */
  private async processSessionFile(filePath: string): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      // gjc keeps the id/cwd at the top level of the header line, not under `payload`.
      const sessionId = typeof data.id === 'string' ? data.id : undefined;
      const projectPath = typeof data.cwd === 'string' ? data.cwd : undefined;

      if (data.type !== 'session' || !sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
      };
    });

    if (!parsed) {
      return null;
    }

    const existingSession = sessionsDb.getSessionByProviderSessionId(this.provider, parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name;
    if (existingSessionName && existingSessionName !== UNTITLED_GJC_SESSION) {
      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName, UNTITLED_GJC_SESSION),
      };
    }

    // gjc has no dedicated title field or session index, so the title is always
    // derived from the first user message (claude/codex-style).
    const firstUserMessage = await this.extractFirstUserMessageFromStart(filePath);
    return {
      ...parsed,
      sessionName: normalizeSessionName(firstUserMessage, UNTITLED_GJC_SESSION),
    };
  }

  /**
   * Returns the first user message text in a gjc transcript.
   *
   * Only `type:"message"` lines with `role:"user"` are considered, and the
   * text is joined from the message's content parts.
   */
  private async extractFirstUserMessageFromStart(filePath: string): Promise<string | undefined> {
    // Stream line-by-line and stop at the first user message instead of reading the
    // whole file. gjc has no title index (unlike claude/codex which read one index
    // file), so title derivation runs per session; a full readFile + split of a large
    // transcript (thousands of lines) during a full sync is the gjc-specific event-loop
    // hog. The first user message is near the top, so this reads only a few lines.
    let rl: ReturnType<typeof createInterface> | undefined;
    try {
      rl = createInterface({ input: createReadStream(filePath, 'utf8'), crlfDelay: Infinity });
      for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const data = parsed as Record<string, unknown>;
        if (data.type !== 'message') {
          continue;
        }

        const message = data.message as Record<string, unknown> | undefined;
        if (!message || message.role !== 'user') {
          continue;
        }

        const text = extractGjcTextFromContent(message.content);
        if (text.trim()) {
          return text;
        }
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    } finally {
      rl?.close();
    }

    return undefined;
  }
}
