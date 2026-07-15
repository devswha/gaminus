import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { buildPromptArg, registerGjcProcessAlias } from './gjc-cli.js';

test('buildPromptArg: every prompt is a private temp file reference', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gjc-args-test-'));
  try {
    const message = 'Reply with exactly one word: PONG';
    const result = buildPromptArg(message, dir);

    assert.ok(result.tempFile, 'tempFile must be set for every prompt');
    assert.equal(result.arg, `@${result.tempFile}`);
    assert.ok(result.tempFile.startsWith(dir), 'temp file lives in the given dir');
    assert.ok(existsSync(result.tempFile), 'temp file is created on disk');
    assert.equal(readFileSync(result.tempFile, 'utf8'), message, 'file content is the verbatim prompt');
    assert.equal(statSync(result.tempFile).mode & 0o777, 0o600, 'temp file is owner-readable only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildPromptArg: nullish and empty prompts are private temp file references', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gjc-args-test-'));
  try {
    for (const message of [undefined, '']) {
      const result = buildPromptArg(message, dir);

      assert.ok(result.tempFile, 'tempFile must be set for every prompt');
      assert.equal(result.arg, `@${result.tempFile}`);
      assert.equal(readFileSync(result.tempFile, 'utf8'), '');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildPromptArg: rejects prompts over 10 MB', () => {
  const oversizedPrompt = 'x'.repeat((10 * 1024 * 1024) + 1);

  assert.throws(
    () => buildPromptArg(oversizedPrompt),
    /gjc prompt exceeds the 10485760-byte limit/,
  );
});

test('registerGjcProcessAlias: spawn handle remains abortable after provider header alias', () => {
  const processes = new Map();
  const child = {};

  registerGjcProcessAlias(processes, 'run-handle', child);
  registerGjcProcessAlias(processes, 'provider-session-id', child);

  assert.equal(processes.get('run-handle'), child, 'abort can still use the pre-header run handle');
  assert.equal(processes.get('provider-session-id'), child, 'abort can use the provider session id');
});
