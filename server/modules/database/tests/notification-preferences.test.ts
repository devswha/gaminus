import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { notificationPreferencesDb } from '@/modules/database/repositories/notification-preferences.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'notification-preferences-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  getConnection().prepare(
    'INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)'
  ).run(1, 'notification-preferences-test', 'test-password-hash');

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('returns alarmEnabled by default for a new user preference row', async () => {
  await withIsolatedDatabase(() => {
    const preferences = notificationPreferencesDb.getPreferences(1);

    assert.equal(preferences.alarmEnabled, true);
  });
});

test('treats legacy rows without alarmEnabled as enabled while preserving inApp', async () => {
  await withIsolatedDatabase(() => {
    getConnection().prepare(
      'INSERT INTO user_notification_preferences (user_id, preferences_json) VALUES (?, ?)'
    ).run(1, JSON.stringify({ channels: { inApp: false } }));

    const preferences = notificationPreferencesDb.getPreferences(1);

    assert.equal(preferences.alarmEnabled, true);
    assert.equal(preferences.channels.inApp, false);
  });
});

test('preserves an explicitly disabled alarmEnabled value', async () => {
  await withIsolatedDatabase(() => {
    notificationPreferencesDb.updatePreferences(1, {
      alarmEnabled: false,
    });

    const preferences = notificationPreferencesDb.getPreferences(1);

    assert.equal(preferences.alarmEnabled, false);
  });
});

test('round-trips alarmEnabled through preference updates', async () => {
  await withIsolatedDatabase(() => {
    notificationPreferencesDb.updatePreferences(1, {
      alarmEnabled: true,
      channels: { inApp: true },
    });

    const preferences = notificationPreferencesDb.getPreferences(1);

    assert.equal(preferences.alarmEnabled, true);
    assert.equal(preferences.channels.inApp, true);
  });
});
