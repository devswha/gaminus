export type AlarmBroadcastMessage =
  | { type: 'completion-handled'; completionId: string }
  | { type: 'leader-claim'; candidateId: string; timestamp: number }
  | { type: 'leader-heartbeat'; candidateId: string; timestamp: number }
  | { type: 'leader-release'; candidateId: string };

type AlarmChannel = {
  postMessage(message: AlarmBroadcastMessage): void;
  close(): void;
  onmessage: ((event: MessageEvent<AlarmBroadcastMessage>) => void) | null;
};

type AlarmLockManager = {
  request(name: string, callback: () => Promise<void>): Promise<void>;
};

type AlarmLeaderOptions = {
  channelFactory?: (name: string) => AlarmChannel | null;
  locks?: AlarmLockManager | null;
  scope?: string;
};

const CHANNEL_NAME = 'gajae-alarm';
const LOCK_NAME = 'gajae-alarm-leader';
const HEARTBEAT_INTERVAL_MS = 100;
const ELECTION_WINDOW_MS = HEARTBEAT_INTERVAL_MS + 10;
const LEASE_DURATION_MS = HEARTBEAT_INTERVAL_MS * 3;

const defaultChannelFactory = (name: string): AlarmChannel | null => {
  if (typeof BroadcastChannel === 'undefined') return null;
  return new BroadcastChannel(name) as AlarmChannel;
};

const defaultLocks = (): AlarmLockManager | null => {
  if (typeof navigator === 'undefined' || !navigator.locks) return null;
  return navigator.locks as unknown as AlarmLockManager;
};

/**
 * Coordinates a single in-app completion alarm across a user's open tabs.
 *
 * Locks are authoritative when available. Without them, tabs elect the lowest
 * timestamp/random claim and retain that lease with BroadcastChannel heartbeats.
 */
export class AlarmLeader {
  private readonly channelFactory: (name: string) => AlarmChannel | null;
  private readonly locks: AlarmLockManager | null;
  private readonly handledCompletionIds = new Set<string>();
  private readonly leadershipListeners = new Set<(isLeader: boolean) => void>();
  private readonly handledListeners = new Set<(completionId: string) => void>();
  private readonly scope: string;
  private channel: AlarmChannel | null = null;
  private releaseLock: (() => void) | null = null;
  private readonly candidateId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  private readonly candidates = new Map<string, { timestamp: number; lastSeen: number }>();
  private electionTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  private currentLeaderId: string | null = null;
  private leader = false;
  private started = false;

  constructor({ channelFactory = defaultChannelFactory, locks = defaultLocks(), scope = 'anonymous' }: AlarmLeaderOptions = {}) {
    this.channelFactory = channelFactory;
    this.locks = locks;
    this.scope = scope;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.channel = this.channelFactory(`${CHANNEL_NAME}:${this.scope}`);
    if (this.channel) {
      this.channel.onmessage = ({ data }) => {
        if (!data) return;
        if (data.type === 'completion-handled' && data.completionId) {
          this.handledCompletionIds.add(data.completionId);
          for (const listener of this.handledListeners) listener(data.completionId);
          return;
        }
        if (!this.locks) this.handleElectionMessage(data);
      };
    }

    if (!this.locks) {
      this.startFallbackElection();
      return;
    }

    void this.locks.request(`${LOCK_NAME}:${this.scope}`, async () => {
      if (!this.started) return;
      this.setLeader(true);
      await new Promise<void>((resolve) => {
        this.releaseLock = resolve;
      });
      this.releaseLock = null;
      this.setLeader(false);
    });
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.releaseLock?.();
    this.releaseLock = null;
    if (!this.locks) {
      this.channel?.postMessage({ type: 'leader-release', candidateId: this.candidateId });
      this.clearFallbackTimers();
      this.candidates.clear();
      this.currentLeaderId = null;
    }
    this.setLeader(false);
    this.channel?.close();
    this.channel = null;
  }

  isLeader(): boolean {
    return this.leader;
  }

  onLeadershipChange(listener: (isLeader: boolean) => void): () => void {
    this.leadershipListeners.add(listener);
    return () => this.leadershipListeners.delete(listener);
  }
  onHandled(listener: (completionId: string) => void): () => void {
    this.handledListeners.add(listener);
    return () => this.handledListeners.delete(listener);
  }

  isHandled(completionId: string): boolean {
    return this.handledCompletionIds.has(completionId);
  }

  markHandled(completionId: string): boolean {
    if (!this.leader || this.handledCompletionIds.has(completionId)) return false;
    this.handledCompletionIds.add(completionId);
    this.channel?.postMessage({ type: 'completion-handled', completionId });
    return true;
  }

  private startFallbackElection(): void {
    this.recordCandidate(this.candidateId, Date.now());
    this.broadcastClaim();
    this.leaseTimer = setInterval(() => {
      this.recordCandidate(this.candidateId, Date.now());
      this.broadcastClaim();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer = setInterval(() => {
      if (!this.leader) return;
      this.currentLeaderId = this.candidateId;
      this.channel?.postMessage({
        type: 'leader-heartbeat',
        candidateId: this.candidateId,
        timestamp: Date.now(),
      });
    }, HEARTBEAT_INTERVAL_MS);
    this.scheduleElection();
  }

  private handleElectionMessage(message: AlarmBroadcastMessage): void {
    if (message.type === 'leader-claim') {
      this.recordCandidate(message.candidateId, message.timestamp);
      this.scheduleElection();
      return;
    }
    if (message.type === 'leader-heartbeat') {
      this.recordCandidate(message.candidateId, message.timestamp);
      this.currentLeaderId = message.candidateId;
      if (message.candidateId !== this.candidateId) this.setLeader(false);
      return;
    }
    if (message.type === 'leader-release') {
      this.candidates.delete(message.candidateId);
      if (this.currentLeaderId === message.candidateId) this.currentLeaderId = null;
      this.scheduleElection();
    }
  }

  private recordCandidate(candidateId: string, timestamp: number): void {
    const existing = this.candidates.get(candidateId);
    this.candidates.set(candidateId, {
      timestamp: Math.min(existing?.timestamp ?? timestamp, timestamp),
      lastSeen: Date.now(),
    });
  }

  private broadcastClaim(): void {
    this.channel?.postMessage({
      type: 'leader-claim',
      candidateId: this.candidateId,
      timestamp: this.candidates.get(this.candidateId)?.timestamp ?? Date.now(),
    });
  }

  private scheduleElection(): void {
    if (!this.started || this.electionTimer) return;
    this.electionTimer = setTimeout(() => {
      this.electionTimer = null;
      this.electFallbackLeader();
    }, ELECTION_WINDOW_MS);
  }

  private electFallbackLeader(): void {
    if (!this.started) return;
    const now = Date.now();
    for (const [candidateId, candidate] of this.candidates) {
      if (candidateId !== this.candidateId && now - candidate.lastSeen > LEASE_DURATION_MS) {
        this.candidates.delete(candidateId);
      }
    }
    const winner = [...this.candidates.entries()]
      .sort(([leftId, left], [rightId, right]) => left.timestamp - right.timestamp || leftId.localeCompare(rightId))[0]?.[0] ?? null;
    this.currentLeaderId = winner;
    this.setLeader(winner === this.candidateId);
    if (this.leader) {
      this.channel?.postMessage({
        type: 'leader-heartbeat',
        candidateId: this.candidateId,
        timestamp: now,
      });
    }
  }

  private clearFallbackTimers(): void {
    if (this.electionTimer) clearTimeout(this.electionTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.electionTimer = null;
    this.heartbeatTimer = null;
    this.leaseTimer = null;
  }
  private setLeader(isLeader: boolean): void {
    if (this.leader === isLeader) return;
    this.leader = isLeader;
    for (const listener of this.leadershipListeners) listener(isLeader);
  }
}
