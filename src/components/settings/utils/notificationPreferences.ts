import type { NotificationPreferencesState } from '../types/types';

export const createDefaultNotificationPreferences = (): NotificationPreferencesState => ({
  alarmEnabled: true,
  channels: {
    inApp: true,
    webPush: false,
    desktop: false,
    sound: true,
  },
  events: {
    actionRequired: true,
    stop: true,
    liveStop: true,
    error: true,
  },
});

export const normalizeNotificationPreferences = (
  preferences?: Partial<NotificationPreferencesState> | null,
): NotificationPreferencesState => {
  const defaults = createDefaultNotificationPreferences();

  return {
    alarmEnabled: preferences?.alarmEnabled !== false,
    channels: {
      inApp: preferences?.channels?.inApp ?? defaults.channels.inApp,
      webPush: preferences?.channels?.webPush ?? defaults.channels.webPush,
      desktop: preferences?.channels?.desktop ?? defaults.channels.desktop,
      sound: preferences?.channels?.sound ?? defaults.channels.sound,
    },
    events: {
      actionRequired: preferences?.events?.actionRequired ?? defaults.events.actionRequired,
      stop: preferences?.events?.stop ?? defaults.events.stop,
      liveStop: preferences?.events?.liveStop ?? defaults.events.liveStop,
      error: preferences?.events?.error ?? defaults.events.error,
    },
  };
};

export const toNotificationPreferencesPayload = (
  preferences: NotificationPreferencesState,
): NotificationPreferencesState => ({
  alarmEnabled: preferences.alarmEnabled,
  channels: { ...preferences.channels },
  events: { ...preferences.events },
});
