import assert from 'node:assert/strict';
import test from 'node:test';

import { AlarmLeader, type AlarmBroadcastMessage } from './alarmLeader';

type Listener = (event: MessageEvent<AlarmBroadcastMessage>) => void;

class MockBroadcastChannel {
  static channels = new Map<string, Set<MockBroadcastChannel>>();
  onmessage: Listener | null = null;

  constructor(private readonly name: string) {
    const peers = MockBroadcastChannel.channels.get(name) || new Set();
    peers.add(this);
    MockBroadcastChannel.channels.set(name, peers);
  }

  postMessage(message: AlarmBroadcastMessage): void {
    for (const peer of MockBroadcastChannel.channels.get(this.name) || []) {
      if (peer !== this) peer.onmessage?.({ data: message } as MessageEvent<AlarmBroadcastMessage>);
    }
  }

  close(): void {
    MockBroadcastChannel.channels.get(this.name)?.delete(this);
  }
}

class MockLocks {
  private locked = false;
  private queue: Array<() => void> = [];

  async request(_name: string, callback: () => Promise<void>): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.locked) {
        this.locked = true;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });

    try {
      await callback();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.locked = false;
    }
  }
}

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const createLeader = (locks: MockLocks) => new AlarmLeader({
  locks,
  channelFactory: () => new MockBroadcastChannel('gajae-alarm'),
});
const createFallbackLeader = () => new AlarmLeader({
  locks: null,
  channelFactory: () => new MockBroadcastChannel('gajae-alarm-fallback'),
});

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const receiveCompletion = (leader: AlarmLeader, pending: Set<string>, completionId: string): void => {
  if (!leader.isHandled(completionId)) pending.add(completionId);
};

const firePendingCompletions = (leader: AlarmLeader, pending: Set<string>): number => {
  if (!leader.isLeader()) return 0;

  let alarmsFired = 0;
  for (const completionId of pending) {
    pending.delete(completionId);
    if (leader.markHandled(completionId)) alarmsFired += 1;
  }
  return alarmsFired;
};

class AsyncMockBroadcastChannel {
  static channels = new Map<string, Set<AsyncMockBroadcastChannel>>();
  onmessage: Listener | null = null;

  constructor(private readonly name: string) {
    const peers = AsyncMockBroadcastChannel.channels.get(name) || new Set();
    peers.add(this);
    AsyncMockBroadcastChannel.channels.set(name, peers);
  }

  postMessage(message: AlarmBroadcastMessage): void {
    for (const peer of AsyncMockBroadcastChannel.channels.get(this.name) || []) {
      if (peer !== this) queueMicrotask(() => peer.onmessage?.({ data: message } as MessageEvent<AlarmBroadcastMessage>));
    }
  }

  close(): void {
    AsyncMockBroadcastChannel.channels.get(this.name)?.delete(this);
  }
}

const createAsyncFallbackLeader = () => new AlarmLeader({
  locks: null,
  channelFactory: () => new AsyncMockBroadcastChannel('gajae-alarm-async-fallback'),
});

test('elects only one leader across two tabs', async () => {
  const locks = new MockLocks();
  const first = createLeader(locks);
  const second = createLeader(locks);
  first.start();
  second.start();
  await settle();

  assert.equal(Number(first.isLeader()) + Number(second.isLeader()), 1);

  first.stop();
  second.stop();
});

test('elects the waiting tab after the leader releases its lock', async () => {
  const locks = new MockLocks();
  const first = createLeader(locks);
  const second = createLeader(locks);
  first.start();
  second.start();
  await settle();

  const leader = first.isLeader() ? first : second;
  const standby = first.isLeader() ? second : first;
  leader.stop();
  await settle();

  assert.equal(standby.isLeader(), true);
  standby.stop();
});

test('concurrent startup has exactly one leader', async () => {
  const locks = new MockLocks();
  const leaders = Array.from({ length: 8 }, () => createLeader(locks));
  for (const leader of leaders) leader.start();
  await settle();

  assert.equal(leaders.filter((leader) => leader.isLeader()).length, 1);

  for (const leader of leaders) leader.stop();
});

test('shares handled completion IDs through BroadcastChannel', async () => {
  const locks = new MockLocks();
  const first = createLeader(locks);
  const second = createLeader(locks);
  first.start();
  second.start();
  await settle();

  assert.equal(first.markHandled('completion-123'), true);
  assert.equal(second.isHandled('completion-123'), true);
  assert.equal(second.markHandled('completion-123'), false);
  assert.equal(first.markHandled('completion-123'), false);

  first.stop();
  second.stop();
});
test('elects one fallback leader across three tabs without navigator.locks', async () => {
  const leaders = Array.from({ length: 3 }, createFallbackLeader);
  for (const leader of leaders) leader.start();

  await wait(130);

  assert.equal(leaders.filter((leader) => leader.isLeader()).length, 1);
  for (const leader of leaders) leader.stop();
});

test('fails over to one fallback leader after the leader stops heartbeating', async () => {
  const leaders = Array.from({ length: 3 }, createFallbackLeader);
  for (const leader of leaders) leader.start();
  await wait(130);

  const leader = leaders.find((candidate) => candidate.isLeader());
  assert.ok(leader);
  leader.stop();

  await wait(130);

  assert.equal(leaders.filter((candidate) => candidate.isLeader()).length, 1);
  for (const candidate of leaders) candidate.stop();
});

test('fires a concurrently received completion only in the fallback leader tab', async () => {
  const leaders = Array.from({ length: 3 }, createAsyncFallbackLeader);
  for (const leader of leaders) leader.start();
  await wait(130);

  const alarmsFired = leaders.reduce((count, leader) => {
    const pending = new Set<string>();
    receiveCompletion(leader, pending, 'completion-concurrent');
    return count + firePendingCompletions(leader, pending);
  }, 0);
  await settle();

  assert.equal(alarmsFired, 1);
  for (const leader of leaders) leader.stop();
});

test('preserves a follower-first completion until the leader handles it once', async () => {
  const locks = new MockLocks();
  const first = createLeader(locks);
  const second = createLeader(locks);
  first.start();
  second.start();
  await settle();

  const leader = first.isLeader() ? first : second;
  const follower = first.isLeader() ? second : first;
  const leaderPending = new Set<string>();
  const followerPending = new Set<string>();
  follower.onHandled((completionId) => followerPending.delete(completionId));

  receiveCompletion(follower, followerPending, 'completion-follower-first');
  receiveCompletion(leader, leaderPending, 'completion-follower-first');

  assert.equal(followerPending.has('completion-follower-first'), true);
  assert.equal(firePendingCompletions(follower, followerPending), 0);
  assert.equal(firePendingCompletions(leader, leaderPending), 1);
  assert.equal(followerPending.size, 0);
  assert.equal(follower.isHandled('completion-follower-first'), true);

  first.stop();
  second.stop();
});

test('waits through an existing leader heartbeat before electing a new fallback tab', async () => {
  const existing = createFallbackLeader();
  existing.start();
  await wait(130);
  assert.equal(existing.isLeader(), true);

  const newcomer = createFallbackLeader();
  let simultaneousLeaders = false;
  const checkForSimultaneousLeaders = () => {
    if (existing.isLeader() && newcomer.isLeader()) simultaneousLeaders = true;
  };
  existing.onLeadershipChange(checkForSimultaneousLeaders);
  newcomer.onLeadershipChange(checkForSimultaneousLeaders);
  newcomer.start();

  const existingPending = new Set<string>();
  const newcomerPending = new Set<string>();
  newcomer.onHandled((completionId) => newcomerPending.delete(completionId));
  receiveCompletion(newcomer, newcomerPending, 'completion-during-election');
  receiveCompletion(existing, existingPending, 'completion-during-election');

  const alarmsFired = firePendingCompletions(newcomer, newcomerPending)
    + firePendingCompletions(existing, existingPending);
  await wait(130);

  assert.equal(alarmsFired, 1);
  assert.equal(simultaneousLeaders, false);
  assert.equal(existing.isLeader(), true);
  assert.equal(newcomer.isLeader(), false);

  existing.stop();
  newcomer.stop();
});
