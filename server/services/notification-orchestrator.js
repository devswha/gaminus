import { notifyRunTerminal } from '../modules/notifications/services/run-terminal-notifier.service.js';

export {
  buildNotificationPayload,
  createNotificationEvent,
  notifyUserIfEnabled,
} from '../modules/notifications/services/notification-orchestrator.service.js';
export { notifyRunTerminal };

// Compatibility entry points retain their terminal semantics while routing
// through the canonical registry-aware notification delegate.
export function notifyRunStopped(args) {
  notifyRunTerminal({ ...args, stopReason: 'stop' });
}

export function notifyRunFailed(args) {
  notifyRunTerminal({ ...args, stopReason: 'error' });
}
