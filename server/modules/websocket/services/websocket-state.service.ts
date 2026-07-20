import type { RealtimeClientConnection } from '@/shared/types.js';

/**
 * Numeric readyState for an open WebSocket connection.
 *
 * We keep this in module state so services that broadcast updates do not need
 * to import `ws` directly just to compare open/closed state.
 */
export const WS_OPEN_STATE = 1;

/**
 * Shared registry of active chat WebSocket connections.
 *
 * Project/session services publish realtime updates by iterating this set.
 */
export const connectedClients = new Set<RealtimeClientConnection>();
/**
 * Sends a session-completion alarm to every authenticated chat websocket.
 * `connectedClients` is populated only after the websocket authentication
 * boundary has accepted the connection.
 */
export function broadcastCompletionAlarm(frame: {
  completionId: string;
  sessionId: string | null;
  provider: string;
  sessionName: string | null;
  stopReason: 'stop' | 'error';
  timestamp: number;
}): void {
  const payload = JSON.stringify({ type: 'completion-alarm', ...frame });
  for (const client of connectedClients) {
    if (client.readyState !== WS_OPEN_STATE) {
      continue;
    }

    try {
      client.send(payload);
    } catch {
      connectedClients.delete(client);
    }
  }
}
