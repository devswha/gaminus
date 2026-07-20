import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  notificationPreferencesDb,
  userDb,
} from '@/modules/database/index.js';
import {
  notifyLiveTurnEnded,
  notifySessionCompleted,
} from '@/modules/notifications/services/notification-orchestrator.service.js';
import { notifyRunTerminal } from '@/modules/notifications/services/run-terminal-notifier.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import {
  broadcastCompletionAlarm,
  connectedClients,
} from '@/modules/websocket/services/websocket-state.service.js';

class FakeConnection {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: (userId: number) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'notification-orchestrator-'));
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  closeConnection();
  await initializeDatabase();

  try {
    const { id } = userDb.createUser('notification-test', 'hash');
    await runTest(Number(id));
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('completion ids dedupe web-run and tmux completion paths', async () => {
  await withIsolatedDatabase((userId) => {
    const connection = new FakeConnection();
    connectedClients.add(connection as never);
    notificationPreferencesDb.updatePreferences(userId, { alarmEnabled: true, channels: { webPush: false } });

    notifySessionCompleted({
      userId,
      provider: 'gjc',
      sessionId: 'shared-session',
      stopReason: 'stop',
      completionId: 'shared-completion-id',
    });
    notifyLiveTurnEnded({
      userId,
      sessionId: 'shared-session',
      tmuxName: 'shared',
      stopReason: 'stop',
      completionId: 'shared-completion-id',
    });

    assert.equal(connection.frames.filter((frame) => frame.type === 'completion-alarm').length, 1);
  });
});

test('alarmEnabled false suppresses completion websocket alarms', async () => {
  await withIsolatedDatabase((userId) => {
    const connection = new FakeConnection();
    connectedClients.add(connection as never);
    notificationPreferencesDb.updatePreferences(userId, { alarmEnabled: false, channels: { webPush: true } });

    notifySessionCompleted({
      userId,
      provider: 'codex',
      sessionId: 'disabled-session',
      stopReason: 'stop',
      completionId: 'disabled-completion-id',
    });

    assert.equal(connection.frames.filter((frame) => frame.type === 'completion-alarm').length, 0);
  });
});
test('registry completion suppresses a subsequent runtime terminal notification', async () => {
  await withIsolatedDatabase((userId) => {
    const connection = new FakeConnection();
    connectedClients.add(connection as never);
    notificationPreferencesDb.updatePreferences(userId, { alarmEnabled: true, channels: { webPush: false } });

    const run = chatRunRegistry.startRun({
      appSessionId: 'registered-session',
      provider: 'claude',
      providerSessionId: null,
      connection: connection as never,
      userId,
    });
    assert.ok(run);
    chatRunRegistry.completeRun('registered-session', { exitCode: 0 });
    notifyRunTerminal({
      userId,
      provider: 'claude',
      sessionId: 'registered-session',
      stopReason: 'stop',
    });

    assert.equal(connection.frames.filter((frame) => frame.type === 'completion-alarm').length, 1);
  });
});

test('unregistered terminal failures dispatch one deterministic completion alarm', async () => {
  await withIsolatedDatabase((userId) => {
    const connection = new FakeConnection();
    connectedClients.add(connection as never);
    notificationPreferencesDb.updatePreferences(userId, { alarmEnabled: true, channels: { webPush: false } });

    const notification = {
      userId,
      provider: 'cursor',
      sessionId: 'spawn-failed-session',
      stopReason: 'error' as const,
    };
    notifyRunTerminal(notification);
    notifyRunTerminal(notification);

    assert.equal(connection.frames.filter((frame) => frame.type === 'completion-alarm').length, 1);
  });
});

test('alarmEnabled false suppresses unregistered terminal completion alarms', async () => {
  await withIsolatedDatabase((userId) => {
    const connection = new FakeConnection();
    connectedClients.add(connection as never);
    notificationPreferencesDb.updatePreferences(userId, { alarmEnabled: false, channels: { webPush: false } });

    notifyRunTerminal({
      userId,
      provider: 'opencode',
      sessionId: 'disabled-fallback-session',
      stopReason: 'error',
    });

    assert.equal(connection.frames.filter((frame) => frame.type === 'completion-alarm').length, 0);
  });
});
test('completion alarms isolate failed websocket sends and keep healthy clients', () => {
  const failingConnection = {
    readyState: 1,
    send(): void {
      throw new Error('socket closed');
    },
  };
  const healthyConnection = new FakeConnection();
  connectedClients.add(failingConnection as never);
  connectedClients.add(healthyConnection as never);

  assert.doesNotThrow(() => {
    broadcastCompletionAlarm({
      completionId: 'mixed-client-completion',
      sessionId: 'mixed-client-session',
      provider: 'claude',
      sessionName: null,
      stopReason: 'stop',
      timestamp: Date.now(),
    });
  });
  assert.equal(healthyConnection.frames.filter((frame) => frame.type === 'completion-alarm').length, 1);
  assert.equal(connectedClients.has(failingConnection as never), false);
  connectedClients.clear();
});
