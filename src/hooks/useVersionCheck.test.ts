import assert from 'node:assert/strict';
import test from 'node:test';

import { compareReleaseTags, fetchVersionCheck, parseReleaseTag } from './useVersionCheck';

type Payload = Record<string, unknown>;

function createFetchMock(...payloads: Payload[]) {
  const requests: string[] = [];
  const fetchMock = async (input: RequestInfo | URL) => {
    requests.push(String(input));
    const payload = payloads.shift();
    if (!payload) {
      throw new Error('Unexpected fetch request');
    }

    return {
      json: async () => payload,
    } as Response;
  };

  return { fetchMock: fetchMock as typeof fetch, requests };
}

test('strict release tags accept stable SemVer tags and reject prerelease or malformed tags', () => {
  assert.deepEqual(parseReleaseTag('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseReleaseTag('1.2.3+build.7'), [1, 2, 3]);
  assert.equal(parseReleaseTag('v1.2.3-rc.1'), null);
  assert.equal(parseReleaseTag('1.2'), null);
  assert.equal(parseReleaseTag('01.2.3'), null);
  assert.equal(parseReleaseTag('release-1.2.3'), null);
  assert.deepEqual(parseReleaseTag('9007199254740991.2.3'), [9007199254740991, 2, 3]);
  assert.equal(parseReleaseTag('9007199254740992.2.3'), null);
  assert.equal(parseReleaseTag('1.9007199254740992.3'), null);
  assert.equal(parseReleaseTag('1.2.9007199254740992'), null);
});

test('release tag comparison distinguishes ahead, equal, and behind versions', () => {
  assert.ok((compareReleaseTags('v1.3.0', 'v1.2.9') ?? 0) > 0);
  assert.equal(compareReleaseTags('v1.2.3', '1.2.3'), 0);
  assert.ok((compareReleaseTags('1.2.3', '1.2.4') ?? 0) < 0);
  assert.equal(compareReleaseTags('1.2.3-rc.1', '1.2.3'), null);
});

test('version checks use the installed release tag for ahead, equal, and behind states', async () => {
  const cases = [
    { installedReleaseTag: 'v1.2.3', latestTag: 'v1.3.0', status: 'ahead', updateAvailable: true },
    { installedReleaseTag: 'v1.2.3', latestTag: 'v1.2.3', status: 'equal', updateAvailable: false },
    { installedReleaseTag: 'v1.2.3', latestTag: 'v1.1.9', status: 'behind', updateAvailable: false },
  ] as const;

  for (const versionCase of cases) {
    const { fetchMock, requests } = createFetchMock(
      { installMode: 'managed', installedReleaseTag: versionCase.installedReleaseTag },
      { tag_name: versionCase.latestTag },
    );
    const result = await fetchVersionCheck('devswha', 'gaminus', fetchMock);

    assert.equal(result.releaseStatus, versionCase.status);
    assert.equal(result.updateAvailable, versionCase.updateAvailable);
    assert.equal(requests[1], 'https://api.github.com/repos/devswha/gaminus/releases/latest');
  }
});

test('version checks fail closed without an installed tag, releases, or a stable release tag', async () => {
  const missingInstalled = createFetchMock({ installMode: 'unknown', installedReleaseTag: null });
  const missingInstalledResult = await fetchVersionCheck('devswha', 'gaminus', missingInstalled.fetchMock);
  assert.equal(missingInstalledResult.updateAvailable, false);
  assert.equal(missingInstalledResult.releaseStatus, null);
  assert.deepEqual(missingInstalled.requests, ['/health']);

  const noRelease = createFetchMock(
    { installMode: 'managed', installedReleaseTag: 'v1.2.3' },
    {},
  );
  const noReleaseResult = await fetchVersionCheck('devswha', 'gaminus', noRelease.fetchMock);
  assert.equal(noReleaseResult.updateAvailable, false);
  assert.equal(noReleaseResult.latestVersion, null);

  const prereleaseOnly = createFetchMock(
    { installMode: 'managed', installedReleaseTag: 'v1.2.3' },
    { tag_name: 'v1.3.0-rc.1' },
  );
  const prereleaseOnlyResult = await fetchVersionCheck('devswha', 'gaminus', prereleaseOnly.fetchMock);
  assert.equal(prereleaseOnlyResult.updateAvailable, false);
  assert.equal(prereleaseOnlyResult.latestVersion, null);
});
