import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXTERNAL_TMUX_NAME_RE,
  classifyExternalSessions,
  parseExternalPanes,
  parsePsTree,
} from '@/modules/providers/services/external-cli-sessions.service.js';

test('parseExternalPanes splits session_name<TAB>pane_pid<TAB>pane_current_command', () => {
  const out = parseExternalPanes('patina\t113501\tclaude\ntest\t360992\tnode\n\nbad-line\n');
  assert.deepEqual(out, [
    { name: 'patina', pid: 113501, command: 'claude' },
    { name: 'test', pid: 360992, command: 'node' },
  ]);
});

test('parsePsTree parses pid,ppid,comm rows and tolerates the header', () => {
  const out = parsePsTree('    PID    PPID COMM\n      1       0 systemd\n 360992    1278 node\n1731394 1731329 codex\n');
  assert.deepEqual(out, [
    { pid: 1, ppid: 0, comm: 'systemd' },
    { pid: 360992, ppid: 1278, comm: 'node' },
    { pid: 1731394, ppid: 1731329, comm: 'codex' },
  ]);
});

test('classifyExternalSessions: claude pane by pane_current_command (실측 shape)', () => {
  const result = classifyExternalSessions({
    panes: [{ name: 'patina', pid: 113501, command: 'claude' }],
    procs: [{ pid: 113501, ppid: 1, comm: 'claude' }],
  });
  assert.deepEqual(result, [{ tmuxName: 'patina', kind: 'claude' }]);
});

test('classifyExternalSessions: codex surfaces as node pane + codex descendant (실측 shape)', () => {
  // tmux pane shows 'node' (codex is a node wrapper); the vendor binary comm is 'codex'.
  const result = classifyExternalSessions({
    panes: [{ name: 'test', pid: 360992, command: 'node' }],
    procs: [
      { pid: 360992, ppid: 1278, comm: 'node' },
      { pid: 1731329, ppid: 360992, comm: 'node' },
      { pid: 1731394, ppid: 1731329, comm: 'codex' },
    ],
  });
  assert.deepEqual(result, [{ tmuxName: 'test', kind: 'codex' }]);
});

test('classifyExternalSessions: gjc anywhere in the session excludes it (live lane contract)', () => {
  const result = classifyExternalSessions({
    panes: [
      { name: 'flask', pid: 357760, command: 'gjc' },
      // Same session, second pane running claude: still excluded — gjc owns the session.
      { name: 'flask', pid: 357761, command: 'claude' },
      { name: 'stock', pid: 61685, command: 'claude' },
    ],
    procs: [
      { pid: 357760, ppid: 1, comm: 'gjc' },
      { pid: 357761, ppid: 1, comm: 'claude' },
      { pid: 61685, ppid: 1, comm: 'claude' },
    ],
  });
  assert.deepEqual(result, [{ tmuxName: 'stock', kind: 'claude' }]);
});

test('classifyExternalSessions: ssh tunnels surface as attach-only ssh rows (실측: company)', () => {
  // The far-side CLI is locally unprovable — the pane still deserves an
  // attach-only row instead of vanishing (하코 관찰: company 세션 안 보임).
  const result = classifyExternalSessions({
    panes: [{ name: 'company', pid: 3318360, command: 'ssh' }],
    procs: [{ pid: 3318360, ppid: 1, comm: 'ssh' }],
  });
  assert.deepEqual(result, [{ tmuxName: 'company', kind: 'ssh' }]);
});

test('classifyExternalSessions: plain shell panes (zsh) are still dropped', () => {
  const result = classifyExternalSessions({
    panes: [{ name: 'scratch', pid: 400, command: 'zsh' }],
    procs: [{ pid: 400, ppid: 1, comm: 'zsh' }],
  });
  assert.deepEqual(result, []);
});

test('classifyExternalSessions: local claude wins over an ssh pane in the same session', () => {
  const result = classifyExternalSessions({
    panes: [
      { name: 'mixed', pid: 500, command: 'claude' },
      { name: 'mixed', pid: 600, command: 'ssh' },
    ],
    procs: [
      { pid: 500, ppid: 1, comm: 'claude' },
      { pid: 600, ppid: 1, comm: 'ssh' },
    ],
  });
  assert.deepEqual(result, [{ tmuxName: 'mixed', kind: 'claude' }]);
});

test('classifyExternalSessions: multi-pane session unions comms and yields ONE row', () => {
  const result = classifyExternalSessions({
    panes: [
      { name: 'work', pid: 100, command: 'zsh' },
      { name: 'work', pid: 200, command: 'claude' },
    ],
    procs: [
      { pid: 100, ppid: 1, comm: 'zsh' },
      { pid: 200, ppid: 1, comm: 'claude' },
    ],
  });
  assert.deepEqual(result, [{ tmuxName: 'work', kind: 'claude' }]);
});

test('classifyExternalSessions: names unsafe to shell-embed are dropped', () => {
  const result = classifyExternalSessions({
    panes: [{ name: "evil;$(rm -rf ~)'", pid: 300, command: 'claude' }],
    procs: [{ pid: 300, ppid: 1, comm: 'claude' }],
  });
  assert.deepEqual(result, []);
  assert.equal(EXTERNAL_TMUX_NAME_RE.test("evil;$(rm -rf ~)'"), false);
});

test('classifyExternalSessions: descendant BFS is cycle-guarded', () => {
  const result = classifyExternalSessions({
    panes: [{ name: 'loop', pid: 1, command: 'zsh' }],
    procs: [
      { pid: 1, ppid: 2, comm: 'zsh' },
      { pid: 2, ppid: 1, comm: 'claude' }, // artificial cycle
    ],
  });
  assert.deepEqual(result, [{ tmuxName: 'loop', kind: 'claude' }]);
});

test('classifyExternalSessions: sorted by tmux name for stable rendering', () => {
  const result = classifyExternalSessions({
    panes: [
      { name: 'zeta', pid: 1, command: 'claude' },
      { name: 'alpha', pid: 2, command: 'claude' },
    ],
    procs: [
      { pid: 1, ppid: 0, comm: 'claude' },
      { pid: 2, ppid: 0, comm: 'claude' },
    ],
  });
  assert.deepEqual(result.map((s) => s.tmuxName), ['alpha', 'zeta']);
});
