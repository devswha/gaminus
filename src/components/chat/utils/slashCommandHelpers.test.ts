import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dedupeProviderSkills,
  filterSlashCommands,
  getActiveSlashToken,
  insertSlashCommand,
  mapSkillToSlashCommand,
} from './slashCommandHelpers';

test('skill command prefixes match the standard slash palette', () => {
  const commands = [
    { name: '/help', description: 'Show help' },
    { name: '/skill:ralplan', description: 'Create a plan' },
    { name: '/skill:ultragoal', description: 'Execute a plan' },
  ];

  assert.deepEqual(filterSlashCommands(commands, '/sk').map((command) => command.name), [
    '/skill:ralplan',
    '/skill:ultragoal',
  ]);
  assert.deepEqual(filterSlashCommands(commands, '/skill:ral').map((command) => command.name), [
    '/skill:ralplan',
  ]);
});

test('namespaced queries retain path-completion behavior', () => {
  const commands = [
    { name: '/skill:ralplan' },
    { name: '/skill:ultragoal' },
    { name: '/plan' },
  ];

  assert.deepEqual(getActiveSlashToken('Run /skill:ral', 14), { start: 4, query: '/skill:ral' });
  assert.deepEqual(filterSlashCommands(commands, '/skill:missing'), []);
});

test('provider skills dedupe by invocation before mapping to slash commands', () => {
  const skills = dedupeProviderSkills([
    { name: 'ralplan', command: '/skill:ralplan', scope: 'project', sourcePath: '/one' },
    { name: 'ralplan-copy', command: '/skill:ralplan', scope: 'user', sourcePath: '/two' },
    { name: 'ultragoal', command: '/skill:ultragoal', scope: 'user' },
  ]);

  assert.deepEqual(skills.map((skill) => skill.command), ['/skill:ralplan', '/skill:ultragoal']);
  assert.deepEqual(mapSkillToSlashCommand(skills[0]), {
    name: '/skill:ralplan',
    description: undefined,
    namespace: 'skill',
    path: '/one',
    type: 'skill',
    metadata: {
      type: 'project',
      scope: 'project',
      sourcePath: '/one',
      pluginName: undefined,
      pluginId: undefined,
      skillName: 'ralplan',
    },
  });
});

test('command insertion preserves existing arguments after the active slash token', () => {
  assert.deepEqual(insertSlashCommand('/skill:ral --depth full', '/skill:ralplan', 0, 10, 10), {
    value: '/skill:ralplan --depth full',
    cursorPosition: 15,
  });
});

test('non-GJC command filtering remains unchanged', () => {
  const commands = [
    { name: '/help', description: 'Show all commands' },
    { name: '/compact', description: 'Compact the conversation' },
    { name: '/cost', description: 'Show token usage' },
  ];

  assert.deepEqual(filterSlashCommands(commands, 'token'), [commands[2]]);
  assert.deepEqual(filterSlashCommands(commands, '/co').map((command) => command.name), ['/compact', '/cost']);
});
