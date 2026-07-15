import { SquareTerminal } from 'lucide-react';

import type { ExternalTerminalTarget, Project } from '../../../../types/app';
import type { ExternalCliSession } from '../../hooks/useExternalCliSessions';

const KIND_LABEL: Record<ExternalCliSession['kind'], string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  ssh: 'ssh (원격)',
};

const KIND_DOT: Record<ExternalCliSession['kind'], string> = {
  claude: 'bg-orange-500',
  codex: 'bg-emerald-500',
  ssh: 'bg-slate-400',
};

type SidebarExternalSectionProps = {
  sessions: ExternalCliSession[];
  projects: Project[];
  /** Opens the session as a full main-area terminal (like gjc sessions do). */
  onOpen: (target: ExternalTerminalTarget) => void;
};

/**
 * "외부 CLI" tab content: claude/codex tmux sessions (from
 * useExternalCliSessions). A row click hands the target to the app shell,
 * which renders it as a full main-area terminal (Termius-style attach) —
 * mirroring how gjc sessions fill the right side.
 */
export default function SidebarExternalSection({ sessions, projects, onOpen }: SidebarExternalSectionProps) {
  // Shell needs a real project only for the PTY cwd; attach ignores the cwd.
  const shellProject = projects[0] ?? null;

  if (sessions.length === 0 || !shellProject) {
    return (
      <div className="px-4 py-8 text-center text-sm text-muted-foreground">
        지금 tmux에서 작동 중인 claude/codex/ssh 세션이 없습니다.
      </div>
    );
  }

  return (
    <div className="space-y-0.5 px-1.5">
      {sessions.map((session) => (
        <button
          key={session.tmuxName}
          type="button"
          onClick={() => onOpen({ tmuxName: session.tmuxName, kind: KIND_LABEL[session.kind], project: shellProject })}
          title={`tmux 세션 '${session.tmuxName}' 터미널로 보기`}
          className="flex w-full items-start rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/50"
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-2">
              <span className={`inline-flex h-1.5 w-1.5 shrink-0 rounded-full ${KIND_DOT[session.kind]}`} aria-hidden />
              <span className="truncate text-sm font-medium text-foreground">{session.tmuxName}</span>
            </span>
            <span className="truncate pl-[1.375rem] text-[11px] text-muted-foreground">{KIND_LABEL[session.kind]}</span>
          </span>
          <SquareTerminal className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
        </button>
      ))}
    </div>
  );
}
