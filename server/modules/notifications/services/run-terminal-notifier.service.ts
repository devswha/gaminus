import { sessionsDb } from '@/modules/database/index.js';
import { createCompletionId } from '@/modules/notifications/services/completion-id.service.js';
import { notifySessionCompleted } from '@/modules/notifications/services/notification-orchestrator.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';

/**
 * Dispatches a provider runtime terminal notification only when that runtime is
 * not owned by the chat run registry. Registered runs dispatch canonically when
 * their terminal complete frame is accepted by the registry.
 *
 * Fallback completion ids are deterministic: hash the app session id when
 * available, otherwise the provider name, with sequence zero.
 */
export function notifyRunTerminal({
  userId,
  provider,
  sessionId = null,
  sessionName = null,
  stopReason = 'stop',
}: {
  userId: number | string | null;
  provider: string;
  sessionId?: string | null;
  sessionName?: string | null;
  stopReason?: 'stop' | 'error';
}): void {
  // Session-id resolution and notification are best-effort side effects of a
  // terminal runtime event: a missing/uninitialized database or a notification
  // failure must never crash the provider runtime's close path. On resolution
  // failure, fall back to the provider-native id (the orchestrator normalizes
  // further where it can).
  let appSessionId: string | null = null;
  try {
    appSessionId = sessionId
      ? sessionsDb.getSessionById(sessionId)?.session_id
        ?? sessionsDb.getSessionByProviderSessionId(provider, sessionId)?.session_id
        ?? sessionId
      : null;
  } catch (error) {
    console.warn('[notifications] terminal session lookup failed; using native id:', error instanceof Error ? error.message : error);
    appSessionId = sessionId;
  }

  try {
    if (appSessionId && chatRunRegistry.getRun(appSessionId)) {
      return;
    }

    notifySessionCompleted({
      userId: userId == null ? null : Number(userId),
      provider,
      sessionId: appSessionId,
      sessionName,
      stopReason,
      completionId: createCompletionId(appSessionId || provider, 0),
    });
  } catch (error) {
    console.warn('[notifications] terminal notification failed:', error instanceof Error ? error.message : error);
  }
}
