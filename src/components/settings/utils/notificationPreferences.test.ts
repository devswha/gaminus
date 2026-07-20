import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDefaultNotificationPreferences,
  normalizeNotificationPreferences,
  toNotificationPreferencesPayload,
} from './notificationPreferences';

test('defaults an unset completion alarm preference to enabled', () => {
  assert.equal(normalizeNotificationPreferences({}).alarmEnabled, true);
});

test('preserves a disabled completion alarm preference', () => {
  assert.equal(normalizeNotificationPreferences({ alarmEnabled: false }).alarmEnabled, false);
});

test('preserves an enabled completion alarm preference', () => {
  assert.equal(normalizeNotificationPreferences({ alarmEnabled: true }).alarmEnabled, true);
});

test('includes an explicitly disabled completion alarm in the save payload', () => {
  const preferences = {
    ...createDefaultNotificationPreferences(),
    alarmEnabled: false,
  };

  assert.equal(JSON.parse(JSON.stringify(toNotificationPreferencesPayload(preferences))).alarmEnabled, false);
});
