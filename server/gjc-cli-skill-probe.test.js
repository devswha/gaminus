import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const RAW_SAMPLE_PATH = '/tmp/g001-skill-probe-ndjson.txt';
const SKILL_NAME = 'ralplan';
const SKILL_ARGS = '테스트용 더미 인자';
const PROMPT = `/skill:${SKILL_NAME} ${SKILL_ARGS}`;
const TIMEOUT_MS = 45_000;

function isAuthenticationFailure(errorOutput) {
  return /\b(?:not authenticated|unauthenticated|authentication required|please (?:log ?in|authenticate)|login required|invalid (?:api )?key|missing (?:api )?key|no credentials?|unauthorized|forbidden)\b/i.test(errorOutput);
}
function collectCliErrorText(value) {
  if (!value || typeof value !== 'object') {
    return '';
  }

  const parts = [];
  for (const [key, entry] of Object.entries(value)) {
    if (['error', 'errorMessage', 'errorStatus'].includes(key) && typeof entry === 'string') {
      parts.push(entry);
    } else if (entry && typeof entry === 'object') {
      parts.push(collectCliErrorText(entry));
    }
  }
  return parts.join('\n');
}

function findSkillPromptEvent(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  // Primary contract only: GJC emits the activation as customType 'skill-prompt'.
  // Looser structural matches (workflow-intent-diff, generic type names) are
  // intentionally NOT accepted here so regressions cannot pass as false
  // positives; compatible CLI versions need their own version-scoped probe.
  if (event.customType === 'skill-prompt') {
    return event;
  }

  for (const value of Object.values(event)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = findSkillPromptEvent(entry);
        if (found) return found;
      }
    } else if (value && typeof value === 'object') {
      const found = findSkillPromptEvent(value);
      if (found) return found;
    }
  }

  return null;
}

function findSkillEvidence(event) {
  const skillPrompt = findSkillPromptEvent(event);
  if (!skillPrompt) {
    return null;
  }

  // The activation event must preserve both the requested skill name and the
  // verbatim arguments; otherwise argument forwarding regressed.
  const serialized = JSON.stringify(skillPrompt);
  if (!serialized.includes(SKILL_NAME) || !serialized.includes(SKILL_ARGS)) {
    return null;
  }

  return `customType=skill-prompt with preserved name "${SKILL_NAME}" and args "${SKILL_ARGS}"`;
}

async function runGjcSkillProbe(sessionDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('gjc', ['-p', '--mode', 'json', '--session-dir', sessionDir], {
      cwd: process.cwd(),
      env: { ...process.env, GJC_NOTIFICATIONS: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let pendingLine = '';
    let evidence = null;
    let terminatedAfterEvidence = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      pendingLine += chunk;
      const completeLines = pendingLine.split(/\r?\n/);
      pendingLine = completeLines.pop();
      for (const line of completeLines) {
        try {
          evidence ||= findSkillEvidence(JSON.parse(line));
        } catch {
          // Keep raw output for diagnosis; non-JSON stdout is not evidence.
        }
      }
      if (evidence && !terminatedAfterEvidence) {
        terminatedAfterEvidence = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr, evidence, terminatedAfterEvidence, timedOut });
    });
    child.stdin.end(PROMPT);
  });
}

test('gjc raw NDJSON activates /skill:ralplan from stdin without home session writes', async (t) => {
  const version = spawnSync('gjc', ['--version'], { encoding: 'utf8', timeout: 5_000 });
  if (version.error?.code === 'ENOENT') {
    t.skip('gjc CLI is not installed');
    return;
  }
  if (version.error) {
    t.skip(`gjc CLI is unavailable: ${version.error.message}`);
    return;
  }
  if (version.status !== 0) {
    t.skip(`gjc CLI version check failed: ${(version.stderr || version.stdout).trim()}`);
    return;
  }

  const sessionDir = await mkdtemp(path.join(os.tmpdir(), 'g001-gjc-skill-sessions-'));
  try {
    const result = await runGjcSkillProbe(sessionDir);
    const lines = result.stdout.split(/\r?\n/).filter(Boolean);
    let evidenceIndex = -1;
    for (const [index, line] of lines.entries()) {
      try {
        if (findSkillEvidence(JSON.parse(line))) {
          evidenceIndex = index;
          break;
        }
      } catch {
        // The saved sample includes non-JSON stdout for diagnosis.
      }
    }
    await writeFile(
      RAW_SAMPLE_PATH,
      `${lines.slice(0, evidenceIndex >= 0 ? evidenceIndex + 1 : lines.length).join('\n')}\n`,
      'utf8',
    );

    const cliErrors = lines.flatMap((line) => {
      try {
        return collectCliErrorText(JSON.parse(line));
      } catch {
        return '';
      }
    }).join('\n');
    if (isAuthenticationFailure(`${result.stderr}\n${cliErrors}`)) {
      t.skip(`gjc CLI is not authenticated: ${`${result.stderr}\n${cliErrors}`.trim().slice(0, 300)}`);
      return;
    }
    const diagnostic = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    assert.equal(result.timedOut, false, `gjc skill probe timed out after ${TIMEOUT_MS}ms`);
    assert.notEqual(evidenceIndex, -1, `No skill activation event found in raw NDJSON. Output saved to ${RAW_SAMPLE_PATH}`);
    assert.ok(result.evidence, `Skill evidence missing. Output saved to ${RAW_SAMPLE_PATH}`);
    assert.ok(
      result.terminatedAfterEvidence || result.code === 0,
      `gjc exited before skill activation completed: ${result.code ?? result.signal}: ${diagnostic}`,
    );
    t.diagnostic(`skill activation evidence: ${result.evidence}; raw sample: ${RAW_SAMPLE_PATH}`);
  } finally {
    await rm(sessionDir, { recursive: true, force: true });
  }
});
