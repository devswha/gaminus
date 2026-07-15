import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  scanGjcCommandDirectory,
  dedupeCommandsByName,
  type LiveGjcCommand,
} from '@/modules/providers/services/live-commands.service.js';

test('scanGjcCommandDirectory maps files to slash commands with descriptions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gjc-cmd-'));
  try {
    await fs.writeFile(
      path.join(root, 'omg:easy.md'),
      '---\ndescription: Plain-language answers\n---\nbody\n',
      'utf8',
    );
    await fs.mkdir(path.join(root, 'group'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'group', 'deep.md'),
      '# First heading line\nmore\n',
      'utf8',
    );
    // Non-markdown files must be ignored.
    await fs.writeFile(path.join(root, 'notes.txt'), 'ignore me', 'utf8');

    const commands = await scanGjcCommandDirectory(root, 'user');
    const byName = new Map(commands.map((command) => [command.name, command]));

    assert.equal(commands.length, 2);
    assert.equal(byName.get('/omg:easy')?.description, 'Plain-language answers');
    assert.equal(byName.get('/omg:easy')?.namespace, 'user');
    assert.equal(byName.get('/omg:easy')?.scope, 'user');
    // A frontmatter-less file falls back to its first content line (heading stripped).
    assert.equal(byName.get('/group/deep')?.description, 'First heading line');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scanGjcCommandDirectory returns [] for a missing directory', async () => {
  const missing = path.join(os.tmpdir(), 'gjc-cmd-does-not-exist-xyz', 'nope');
  assert.deepEqual(await scanGjcCommandDirectory(missing, 'project'), []);
});

test('dedupeCommandsByName keeps the first occurrence of each name', () => {
  const input: LiveGjcCommand[] = [
    { name: '/omg:easy', description: 'native', namespace: 'user', scope: 'user' },
    { name: '/omg:easy', description: 'skill dupe', namespace: 'skill', scope: 'user' },
    { name: '/other', description: '', namespace: 'project', scope: 'project' },
  ];
  const out = dedupeCommandsByName(input);
  assert.equal(out.length, 2);
  assert.equal(out[0].description, 'native');
  assert.equal(out[1].name, '/other');
});
