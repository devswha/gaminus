import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createUpdateHandler,
  createUpdateStatusHandler,
  getDeploymentHealth,
  resolveLatestStableReleaseTag,
} from '../system.js';

const APP_ROOT = '/srv/gaminus';
const SHA = 'a'.repeat(40);

const TEST_DEPLOYMENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gaminus-system-route-'));
let testUpdateHandlerCount = 0;

function createTestUpdateHandler(options) {
  const stateFile = path.join(TEST_DEPLOYMENT_DIR, `${testUpdateHandlerCount += 1}`, 'deployment.env');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  return createUpdateHandler({ stateFile, ...options });
}
function state(activeRoot = APP_ROOT, sha = SHA, extra = '') {
  return `release_tag=v1.37.0\nactive_root=${activeRoot}\nsha=${sha}\n${extra}`;
}

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
    },
  };
}

function createChild() {
  const child = new EventEmitter();
  child.unref = () => {};
  return child;
}

function stableReleaseFetch(releases = [{ tag_name: 'v1.38.0' }]) {
  return async () => ({ ok: true, json: async () => releases });
}

test('resolves the highest trusted stable semver release tag', async () => {
  const tag = await resolveLatestStableReleaseTag(stableReleaseFetch([
    { tag_name: 'v1.9.0' },
    { tag_name: 'v1.10.0' },
    { tag_name: 'v2.0.0-rc.1' },
    { tag_name: 'failure' },
    { tag_name: 'v3.0.0', draft: true },
  ]));

  assert.equal(tag, 'v1.10.0');
});
test('compares stable semver components beyond JavaScript safe integers', async () => {
  const tag = await resolveLatestStableReleaseTag(stableReleaseFetch([
    { tag_name: 'v9007199254740992.0.0' },
    { tag_name: 'v9007199254740993.0.0' },
    { tag_name: 'v1.9007199254740992.0' },
    { tag_name: 'v1.9007199254740993.0' },
  ]));

  assert.equal(tag, 'v9007199254740993.0.0');
});


test('managed deployment update launches only after systemd-run accepts the request', async () => {
  const calls = [];
  const child = createChild();
  const handler = createTestUpdateHandler({
    appRoot: APP_ROOT,
    readFileSync: () => state(),
    existsSync: () => false,
    getRunningSha: () => SHA,
    fetch: stableReleaseFetch(),
    now: () => 12345,
    createOperationId: () => 'operation-123',
    spawn: (...args) => {
      calls.push(args);
      return child;
    },
  });
  const res = response();

  await handler({ body: { installMode: 'unknown' } }, res);
  assert.equal(res.statusCode, null);
  child.emit('exit', 0);

  assert.equal(res.statusCode, 202);
  assert.equal(res.body.unit, 'gaminus-update-12345');
  assert.deepEqual(calls, [[
    'systemd-run',
    ['--user', '--collect', '--unit=gaminus-update-12345', '--setenv=GAMINUS_OPERATION_ID=operation-123', `${APP_ROOT}/scripts/gaminus.sh`, 'update', '--ref', 'v1.38.0'],
    { detached: true, stdio: 'ignore', shell: false },
  ]]);
});

test('untrusted releases fail closed without starting an update', async () => {
  let spawnCalls = 0;
  const handler = createTestUpdateHandler({
    appRoot: APP_ROOT,
    readFileSync: () => state(),
    existsSync: () => false,
    getRunningSha: () => SHA,
    fetch: async () => {
      throw new Error('offline');
    },
    spawn: () => {
      spawnCalls += 1;
      return createChild();
    },
  });
  const res = response();

  await handler({}, res);

  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /manual/i);
  assert.equal(spawnCalls, 0);
});

test('unmanaged or mismatched deployment state fails closed', async () => {
  let spawnCalls = 0;
  const handler = createTestUpdateHandler({
    appRoot: APP_ROOT,
    readFileSync: () => state('/manual/checkout'),
    existsSync: () => false,
    getRunningSha: () => SHA,
    spawn: () => {
      spawnCalls += 1;
      return createChild();
    },
  });
  const res = response();

  await handler({ body: { installMode: 'managed' } }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /manual/i);
  assert.equal(spawnCalls, 0);
});

test('the update route rejects an existing operation reservation', async () => {
  let spawnCalls = 0;
  const handler = createTestUpdateHandler({
    appRoot: APP_ROOT,
    readFileSync: () => state(APP_ROOT, SHA, 'update_state=preparing\n'),
    getRunningSha: () => SHA,
    openSync: () => {
      const error = new Error('exists');
      error.code = 'EEXIST';
      throw error;
    },
    spawn: () => {
      spawnCalls += 1;
      return createChild();
    },
  });
  const res = response();

  await handler({}, res);

  assert.equal(res.statusCode, 423);
  assert.equal(spawnCalls, 0);
});

test('launcher failures are reported only after the launcher exits', async () => {
  const child = createChild();
  const handler = createTestUpdateHandler({
    appRoot: APP_ROOT,
    readFileSync: () => state(),
    existsSync: () => false,
    getRunningSha: () => SHA,
    fetch: stableReleaseFetch(),
    spawn: () => child,
  });
  const res = response();

  await handler({}, res);
  child.emit('exit', 1);

  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /status 1/);
});
test('launcher errors are reported as gateway failures', async () => {
  const child = createChild();
  const handler = createTestUpdateHandler({
    appRoot: APP_ROOT,
    readFileSync: () => state(),
    existsSync: () => false,
    getRunningSha: () => SHA,
    fetch: stableReleaseFetch(),
    spawn: () => child,
  });
  const res = response();

  await handler({}, res);
  child.emit('error', new Error('systemd unavailable'));

  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /systemd unavailable/);
});

test('update status safely exposes deployment polling fields', () => {
  const handler = createUpdateStatusHandler({
    stateFile: '/state',
    readFileSync: () => state(APP_ROOT, SHA, 'update_state=failed\nfailure=build_failed\n'),
  });
  const res = response();

  handler({}, res);

  assert.deepEqual(res.body, {
    operationId: null,
    updateState: 'failed',
    releaseTag: 'v1.37.0',
    sha: SHA,
    failure: 'build_failed',
    inProgress: false,
  });
});
test('update status clears a matching terminal operation reservation', () => {
  const removed = [];
  const handler = createUpdateStatusHandler({
    stateFile: '/deployment/deployment.env',
    readFileSync: (file) => {
      if (file.endsWith('update-operation.json')) {
        return JSON.stringify({ operationId: 'operation-complete', startedAt: '2026-01-01T00:00:00.000Z' });
      }
      return state(APP_ROOT, SHA, 'operation_id=operation-complete\nupdate_state=current\n');
    },
    existsSync: () => false,
    unlinkSync: (file) => removed.push(file),
  });
  const res = response();

  handler({}, res);

  assert.equal(res.body.operationId, 'operation-complete');
  assert.equal(res.body.inProgress, false);
  assert.deepEqual(removed, ['/deployment/update-operation.json']);
});
test('concurrent updates reserve one operation before release lookup', async () => {
  const deploymentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaminus-update-operation-'));
  const stateFile = path.join(deploymentDir, 'deployment.env');
  fs.writeFileSync(stateFile, state());

  let releaseFetchStarted;
  const releaseFetchStartedPromise = new Promise((resolve) => { releaseFetchStarted = resolve; });
  let releaseFetch;
  const releaseFetchPromise = new Promise((resolve) => { releaseFetch = resolve; });
  const child = createChild();
  const handler = createUpdateHandler({
    appRoot: APP_ROOT,
    stateFile,
    getRunningSha: () => SHA,
    createOperationId: () => 'operation-concurrent',
    fetch: async () => {
      releaseFetchStarted();
      return releaseFetchPromise;
    },
    spawn: () => child,
  });
  const first = response();
  const second = response();

  try {
    const firstRequest = handler({}, first);
    await releaseFetchStartedPromise;
    await handler({}, second);

    assert.equal(second.statusCode, 423);
    releaseFetch({ ok: true, json: async () => [{ tag_name: 'v1.38.0' }] });
    await firstRequest;
    child.emit('exit', 0);
    assert.equal(first.statusCode, 202);
  } finally {
    fs.rmSync(deploymentDir, { recursive: true, force: true });
  }
});

test('current_release_tag does not preserve a failed candidate ref as a release tag', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gaminus-release-tag-'));
  try {
    const deploymentDir = path.join(home, '.gaminus', 'deployment');
    fs.mkdirSync(deploymentDir, { recursive: true });
    fs.writeFileSync(
      path.join(deploymentDir, 'deployment.env'),
      'ref=failure\nrelease_tag=failure\nupdate_state=failed\n',
    );

    const output = execFileSync(
      'bash',
      ['-c', 'source "$1" update; current_release_tag', '--', path.resolve('scripts/gaminus.sh')],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, GAMINUS_SOURCE_ONLY: '1' },
      },
    );
    assert.equal(output, '');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('deployment health safely exposes only state-derived display fields', () => {
  assert.deepEqual(getDeploymentHealth('/state', APP_ROOT, () => state()), {
    installedReleaseTag: 'v1.37.0',
    installMode: 'managed',
  });
  assert.deepEqual(getDeploymentHealth('/state', APP_ROOT, () => {
    throw new Error('missing');
  }), {
    installedReleaseTag: null,
    installMode: 'unknown',
  });
});
