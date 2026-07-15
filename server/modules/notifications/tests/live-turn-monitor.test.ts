import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLiveTurnMonitor,
  findAssistantTurnEnds,
} from '@/modules/notifications/services/live-turn-monitor.service.js';

// ─── findAssistantTurnEnds (실측 gjc transcript 스키마) ──────────────────────

const assistantLine = (stopReason: string) =>
  JSON.stringify({ type: 'message', id: 'x', message: { role: 'assistant', content: [], stopReason } });

test('findAssistantTurnEnds detects assistant stop and error terminators', () => {
  const delta = [
    assistantLine('toolUse'),
    '{"type":"text","text":"chunk"}',
    assistantLine('stop'),
    assistantLine('error'),
    '',
  ].join('\n');
  assert.deepEqual(findAssistantTurnEnds(delta), ['stop', 'error']);
});

test('findAssistantTurnEnds ignores toolUse, non-assistant roles, and foreign lines', () => {
  const delta = [
    assistantLine('toolUse'),
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi', stopReason: 'stop' } }),
    '{"type":"model_change","model":"m"}',
    'not json at all',
    '',
  ].join('\n');
  assert.deepEqual(findAssistantTurnEnds(delta), []);
});

test('findAssistantTurnEnds tolerates a partial trailing line', () => {
  const delta = `${assistantLine('stop')}\n{"type":"message","message":{"role":"assist`;
  assert.deepEqual(findAssistantTurnEnds(delta), ['stop']);
});

// ─── createLiveTurnMonitor tick 상태기계 ─────────────────────────────────────

function makeHarness() {
  const files = new Map<string, string>();
  const notifications: Array<{ sessionId: string; tmuxName: string | null; stopReason: string }> = [];
  let sessions: Array<{ id: string; tmuxName: string | null; claim: 'lineage' | 'cwd' | null }> = [];
  let transcriptPaths = new Map<string, string>();

  const monitor = createLiveTurnMonitor({
    getDetailed: async () => ({ sessions, transcriptPaths }),
    notify: ({ sessionId, tmuxName, stopReason }) => notifications.push({ sessionId, tmuxName, stopReason }),
    getUserId: () => 1,
    statSize: async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error('missing');
      return Buffer.byteLength(content);
    },
    readDelta: async (path, start, end) => Buffer.from(files.get(path) ?? '', 'utf8').subarray(start, end).toString('utf8'),
  });

  return {
    monitor,
    files,
    notifications,
    setLive(rows: typeof sessions, paths: Record<string, string>) {
      sessions = rows;
      transcriptPaths = new Map(Object.entries(paths));
    },
  };
}

const row = (id: string, tmuxName: string | null, claim: 'lineage' | 'cwd' | null) => ({ id, tmuxName, claim });

test('monitor baselines on first sight and only notifies on NEW turn ends', async () => {
  const h = makeHarness();
  // 기존 내용에 이미 stop이 있어도 (서버 재시작 시나리오) 재통보 금지.
  h.files.set('/t/a.jsonl', `${assistantLine('stop')}\n`);
  h.setLive([row('s1', 'flask', 'lineage')], { s1: '/t/a.jsonl' });

  await h.monitor.tick();
  assert.equal(h.notifications.length, 0, 'baseline tick must not replay history');

  await h.monitor.tick();
  assert.equal(h.notifications.length, 0, 'no growth → no notify');

  h.files.set('/t/a.jsonl', `${assistantLine('stop')}\n${assistantLine('toolUse')}\n${assistantLine('stop')}\n`);
  await h.monitor.tick();
  assert.deepEqual(h.notifications, [{ sessionId: 's1', tmuxName: 'flask', stopReason: 'stop' }]);

  await h.monitor.tick();
  assert.equal(h.notifications.length, 1, 'already-consumed delta must not re-notify');
});

test('monitor skips cwd-labeled, idle, and pathless rows (웹 구동 중복 방지)', async () => {
  const h = makeHarness();
  h.files.set('/t/b.jsonl', '');
  h.setLive(
    [
      row('cwd1', 'patina', 'cwd'),
      row('idle-gjc:omg', 'omg', 'lineage'),
      row('nopath', 'stock', 'lineage'),
    ],
    { cwd1: '/t/b.jsonl', 'idle-gjc:omg': '/t/b.jsonl' },
  );
  await h.monitor.tick();
  h.files.set('/t/b.jsonl', `${assistantLine('stop')}\n`);
  await h.monitor.tick();
  assert.equal(h.notifications.length, 0);
  assert.equal(h.monitor.cursorCount(), 0, 'no cursor may be tracked for excluded rows');
});

test('monitor reports error terminators and prunes cursors for departed sessions', async () => {
  const h = makeHarness();
  h.files.set('/t/c.jsonl', '');
  h.setLive([row('s2', 'horcrux', 'lineage')], { s2: '/t/c.jsonl' });
  await h.monitor.tick(); // baseline (size 0)
  h.files.set('/t/c.jsonl', `${assistantLine('error')}\n`);
  await h.monitor.tick();
  assert.deepEqual(h.notifications, [{ sessionId: 's2', tmuxName: 'horcrux', stopReason: 'error' }]);

  h.setLive([], {});
  await h.monitor.tick();
  assert.equal(h.monitor.cursorCount(), 0, 'departed session cursor must be pruned');
});

test('monitor FINAL SWEEP catches a short turn whose fd closed before the next tick (실측 e2e 버그)', async () => {
  // gjc closes the transcript when the turn ends — a quick reply lands its
  // terminator and disappears from the live set within one tick interval.
  const h = makeHarness();
  h.files.set('/t/d.jsonl', '');
  h.setLive([row('s3', 'notifyprobe', 'lineage')], { s3: '/t/d.jsonl' });
  await h.monitor.tick(); // baseline while briefly live

  // Turn completes AND the session leaves the live set before the next tick.
  h.files.set('/t/d.jsonl', `${assistantLine('stop')}\n`);
  h.setLive([], {});
  await h.monitor.tick();

  assert.deepEqual(h.notifications, [{ sessionId: 's3', tmuxName: 'notifyprobe', stopReason: 'stop' }]);
  assert.equal(h.monitor.cursorCount(), 0, 'cursor freed after the final sweep');
});
