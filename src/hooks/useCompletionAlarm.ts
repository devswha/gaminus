import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '../components/auth/context/AuthContext';
import { useWebSocket, type ServerEvent } from '../contexts/WebSocketContext';
import { AlarmLeader } from '../utils/alarmLeader';
import { playChatCompletionSound } from '../utils/notificationSound';

type CompletionAlarmEvent = {
  type: 'completion-alarm';
  completionId: string;
  sessionId: string | null;
  provider: string;
  sessionName: string | null;
  stopReason: 'stop' | 'error';
  timestamp: number;
};

export type CompletionAlarmToast = {
  id: string;
  message: string;
};

const isCompletionAlarm = (event: ServerEvent): event is ServerEvent & CompletionAlarmEvent => {
  return event.type === 'completion-alarm'
    && typeof event.completionId === 'string'
    && typeof event.provider === 'string'
    && (event.stopReason === 'stop' || event.stopReason === 'error');
};

const formatAlarmMessage = ({ sessionName, provider, stopReason }: CompletionAlarmEvent): string => {
  const session = sessionName || provider;
  return stopReason === 'error' ? `${session} stopped with an error` : `${session} completed`;
};

/** Subscribes once at the app root so completion alarms are independent of selection. */
export function useCompletionAlarm(): CompletionAlarmToast | null {
  const { subscribe } = useWebSocket();
  const { user } = useAuth();
  const leaderRef = useRef<AlarmLeader | null>(null);
  const pendingRef = useRef(new Map<string, CompletionAlarmEvent>());
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [toast, setToast] = useState<CompletionAlarmToast | null>(null);

  const deliverPending = useCallback(() => {
    const leader = leaderRef.current;
    if (!leader?.isLeader()) return;

    for (const alarm of pendingRef.current.values()) {
      pendingRef.current.delete(alarm.completionId);
      if (!leader.markHandled(alarm.completionId)) continue;
      void playChatCompletionSound({ force: true });
      setToast({ id: alarm.completionId, message: formatAlarmMessage(alarm) });
    }
  }, []);

  useEffect(() => {
    const leader = new AlarmLeader({ scope: String(user?.id ?? user?.username ?? 'anonymous') });
    leaderRef.current = leader;
    leader.start();
    const unsubscribeLeadership = leader.onLeadershipChange((isLeader) => {
      if (isLeader) deliverPending();
    });
    const unsubscribeHandled = leader.onHandled((completionId) => {
      pendingRef.current.delete(completionId);
    });

    return () => {
      unsubscribeHandled();
      unsubscribeLeadership();
      leader.stop();
      leaderRef.current = null;
    };
  }, [deliverPending, user?.id, user?.username]);

  useEffect(() => {
    return subscribe((event) => {
      if (!isCompletionAlarm(event)) return;
      const leader = leaderRef.current;
      if (!leader || leader.isHandled(event.completionId)) return;
      pendingRef.current.set(event.completionId, event);
      deliverPending();
    });
  }, [deliverPending, subscribe]);

  useEffect(() => {
    if (!toast) return;
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = setTimeout(() => setToast(null), 3000);
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, [toast]);

  return toast;
}
