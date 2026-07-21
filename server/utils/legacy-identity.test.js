import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { legacyDataRoot, migrateLegacyDataRoot, CURRENT_DATA_DIRNAME } from './legacy-identity.js';

const silentLog = { log: () => {}, error: () => {} };

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gaminus-legacy-test-'));
}

test('moves user data, leaves manager-owned entries, removes empty legacy root', () => {
  const home = makeHome();
  const legacy = legacyDataRoot(home);
  fs.mkdirSync(path.join(legacy, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'auth.db'), 'db');
  fs.writeFileSync(path.join(legacy, 'assets', 'a.png'), 'img');
  fs.mkdirSync(path.join(legacy, 'deployment'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'deployment', 'deployment.env'), 'state');

  migrateLegacyDataRoot({ homeDir: home, log: silentLog });

  const current = path.join(home, CURRENT_DATA_DIRNAME);
  assert.equal(fs.readFileSync(path.join(current, 'auth.db'), 'utf8'), 'db');
  assert.equal(fs.readFileSync(path.join(current, 'assets', 'a.png'), 'utf8'), 'img');
  // manager-owned state stays for scripts adoption
  assert.ok(fs.existsSync(path.join(legacy, 'deployment', 'deployment.env')));
  assert.ok(!fs.existsSync(path.join(current, 'deployment')));
});

test('never clobbers data already written under the new root', () => {
  const home = makeHome();
  const legacy = legacyDataRoot(home);
  const current = path.join(home, CURRENT_DATA_DIRNAME);
  fs.mkdirSync(legacy, { recursive: true });
  fs.mkdirSync(current, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'auth.db'), 'old');
  fs.writeFileSync(path.join(current, 'auth.db'), 'new');

  migrateLegacyDataRoot({ homeDir: home, log: silentLog });

  assert.equal(fs.readFileSync(path.join(current, 'auth.db'), 'utf8'), 'new');
  // the losing legacy copy stays where it was instead of being destroyed
  assert.equal(fs.readFileSync(path.join(legacy, 'auth.db'), 'utf8'), 'old');
});

test('fully drained legacy root is removed', () => {
  const home = makeHome();
  const legacy = legacyDataRoot(home);
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'local-server.json'), '{}');

  migrateLegacyDataRoot({ homeDir: home, log: silentLog });

  assert.ok(!fs.existsSync(legacy));
  assert.ok(fs.existsSync(path.join(home, CURRENT_DATA_DIRNAME, 'local-server.json')));
});

test('no-op when there is no legacy data root', () => {
  const home = makeHome();
  migrateLegacyDataRoot({ homeDir: home, log: silentLog });
  assert.ok(!fs.existsSync(path.join(home, CURRENT_DATA_DIRNAME)));
});
