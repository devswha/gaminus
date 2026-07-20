import assert from 'node:assert/strict';
import test from 'node:test';

import { decideUpdatePolling } from './updatePolling';

const operationId = 'operation-1';
const timeoutMs = 5 * 60 * 1_000;

test('continues through restart fetch failures until the matching operation completes', () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        assert.deepEqual(decideUpdatePolling({
            operationId,
            elapsedMs: attempt * 3_000,
            timeoutMs,
            networkError: new Error('fetch failed'),
        }), { action: 'continue' });
    }

    assert.deepEqual(decideUpdatePolling({
        operationId,
        elapsedMs: 12_000,
        timeoutMs,
        status: { operationId, updateState: 'current' },
    }), { action: 'success' });
});

test('continues for stale current status and then times out', () => {
    assert.deepEqual(decideUpdatePolling({
        operationId,
        elapsedMs: 3_000,
        timeoutMs,
        status: { operationId: 'operation-0', updateState: 'current' },
    }), { action: 'continue' });

    assert.deepEqual(decideUpdatePolling({
        operationId,
        elapsedMs: 6_000,
        timeoutMs,
        status: { updateState: 'current' },
    }), { action: 'continue' });

    assert.deepEqual(decideUpdatePolling({
        operationId,
        elapsedMs: timeoutMs,
        timeoutMs,
        status: { operationId: 'operation-0', updateState: 'current' },
    }), { action: 'timeout' });
});

test('fails when the matching operation is rolled back', () => {
    assert.deepEqual(decideUpdatePolling({
        operationId,
        elapsedMs: 3_000,
        timeoutMs,
        status: {
            operationId,
            updateState: 'rolled_back',
            failure: 'Health check failed.',
        },
    }), { action: 'failure', reason: 'Health check failed.' });
});
