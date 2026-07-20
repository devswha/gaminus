import { useEffect, useState } from 'react';

import { version } from '../../package.json';
import { ReleaseInfo } from '../types/sharedTypes';

type SemVer = readonly [number, number, number];

const RELEASE_TAG_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export type InstallMode = 'managed' | 'unknown';
export type ReleaseStatus = 'ahead' | 'equal' | 'behind' | null;

export type VersionCheckResult = {
  installMode: InstallMode;
  installedReleaseTag: string | null;
  latestVersion: string | null;
  releaseInfo: ReleaseInfo | null;
  releaseStatus: ReleaseStatus;
  runningVersion: string | null;
  updateAvailable: boolean;
};

export function parseReleaseTag(tag: unknown): SemVer | null {
  if (typeof tag !== 'string') {
    return null;
  }

  const match = RELEASE_TAG_PATTERN.exec(tag);
  if (!match) {
    return null;
  }

  const parsed = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return parsed.every(Number.isSafeInteger) ? parsed : null;
}

export function compareReleaseTags(left: string, right: string): number | null {
  const leftVersion = parseReleaseTag(left);
  const rightVersion = parseReleaseTag(right);
  if (!leftVersion || !rightVersion) {
    return null;
  }

  for (let index = 0; index < leftVersion.length; index += 1) {
    if (leftVersion[index] !== rightVersion[index]) {
      return leftVersion[index] - rightVersion[index];
    }
  }

  return 0;
}

function getReleaseStatus(latestTag: string, installedTag: string): ReleaseStatus {
  const comparison = compareReleaseTags(latestTag, installedTag);
  if (comparison === null) {
    return null;
  }

  if (comparison > 0) {
    return 'ahead';
  }

  if (comparison < 0) {
    return 'behind';
  }

  return 'equal';
}

function releaseInfoFrom(data: Record<string, unknown>, owner: string, repo: string): ReleaseInfo {
  const tagName = data.tag_name as string;
  return {
    title: typeof data.name === 'string' ? data.name : tagName,
    body: typeof data.body === 'string' ? data.body : '',
    htmlUrl:
      typeof data.html_url === 'string'
        ? data.html_url
        : `https://github.com/${owner}/${repo}/releases/latest`,
    publishedAt: typeof data.published_at === 'string' ? data.published_at : '',
  };
}

export async function fetchVersionCheck(
  owner: string,
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VersionCheckResult> {
  const healthResponse = await fetchImpl('/health');
  const health = (await healthResponse.json()) as Record<string, unknown>;
  const installedReleaseTag =
    typeof health.installedReleaseTag === 'string' && parseReleaseTag(health.installedReleaseTag)
      ? health.installedReleaseTag
      : null;

  const installMode: InstallMode = health.installMode === 'managed' ? 'managed' : 'unknown';
  const runningVersion = typeof health.version === 'string' && health.version.length > 0 ? health.version : null;

  if (!installedReleaseTag) {
    return {
      installMode,
      installedReleaseTag: null,
      latestVersion: null,
      releaseInfo: null,
      releaseStatus: null,
      runningVersion,
      updateAvailable: false,
    };
  }

  const releaseResponse = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
  const release = (await releaseResponse.json()) as Record<string, unknown>;
  const latestTag = typeof release.tag_name === 'string' && parseReleaseTag(release.tag_name)
    ? release.tag_name
    : null;
  const releaseStatus = latestTag ? getReleaseStatus(latestTag, installedReleaseTag) : null;

  return {
    installMode,
    installedReleaseTag,
    latestVersion: latestTag?.replace(/^v/, '') ?? null,
    releaseInfo: latestTag ? releaseInfoFrom(release, owner, repo) : null,
    releaseStatus,
    runningVersion,
    updateAvailable: releaseStatus === 'ahead',
  };
}

export const useVersionCheck = (owner: string, repo: string) => {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [releaseInfo, setReleaseInfo] = useState<ReleaseInfo | null>(null);
  const [installMode, setInstallMode] = useState<InstallMode>('unknown');
  const [runningVersion, setRunningVersion] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);

  useEffect(() => {
    let active = true;

    const checkVersion = async () => {
      try {
        const result = await fetchVersionCheck(owner, repo);
        if (!active) {
          return;
        }

        setInstallMode(result.installMode);
        setRunningVersion(result.runningVersion);
        setRestartRequired(result.runningVersion !== null && result.runningVersion !== version);
        setLatestVersion(result.latestVersion);
        setReleaseInfo(result.releaseInfo);
        setUpdateAvailable(result.updateAvailable);
      } catch (error) {
        console.error('Version check failed:', error);
        if (!active) {
          return;
        }

        setUpdateAvailable(false);
        setLatestVersion(null);
        setReleaseInfo(null);
      }
    };

    checkVersion();
    const interval = setInterval(checkVersion, 5 * 60 * 1000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [owner, repo]);

  return {
    updateAvailable,
    latestVersion,
    currentVersion: version,
    releaseInfo,
    installMode,
    runningVersion,
    restartRequired,
  };
};