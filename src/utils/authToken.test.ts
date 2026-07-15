import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyRefreshedAuthToken,
  clearAuthToken,
  getAuthTokenSnapshot,
  setAuthToken,
} from './authToken';

test('late refresh cannot restore a token after logout', () => {
  clearAuthToken();
  setAuthToken('before-logout');
  const requestSnapshot = getAuthTokenSnapshot();
  clearAuthToken();

  assert.equal(applyRefreshedAuthToken(requestSnapshot, 'late-refresh'), false);
  assert.equal(getAuthTokenSnapshot().token, null);
});

test('refresh rotates only the token captured by its request', () => {
  clearAuthToken();
  setAuthToken('original');
  const requestSnapshot = getAuthTokenSnapshot();

  assert.equal(applyRefreshedAuthToken(requestSnapshot, 'rotated'), true);
  assert.equal(getAuthTokenSnapshot().token, 'rotated');
});

test('a newer token prevents an earlier request from overwriting it', () => {
  clearAuthToken();
  setAuthToken('first');
  const requestSnapshot = getAuthTokenSnapshot();
  setAuthToken('newer');

  assert.equal(applyRefreshedAuthToken(requestSnapshot, 'stale'), false);
  assert.equal(getAuthTokenSnapshot().token, 'newer');
});
