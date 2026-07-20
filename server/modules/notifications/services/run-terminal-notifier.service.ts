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
  const appSessionId = sessionId
    ? sessionsDb.getSessionById(sessionId)?.session_id
      ?? sessionsDb.getSessionByProviderSessionId(provider, sessionId)?.session_id
      ?? sessionId
    : null;
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
}
