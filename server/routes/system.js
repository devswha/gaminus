import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import express from 'express';

import { REPOSITORY_SLUG } from '../../shared/productIdentity.js';
import { legacyDataRoot } from '../utils/legacy-identity.js';

const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const STABLE_SEMVER_TAG_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const TERMINAL_UPDATE_STATES = new Set(['current', 'rolled_back', 'failed']);
const MANUAL_UPDATE_MESSAGE = 'Automatic updates are available only for managed deployments. Update manually from your installation directory.';
const UPDATE_IN_PROGRESS_MESSAGE = 'An update is already in progress. Check its status before starting another update.';

export function getDeploymentStateFile(homeDir = os.homedir()) {
  // Keep this in sync with scripts/gaminus.sh's STATE_FILE.
  const current = path.join(homeDir, '.gaminus', 'deployment', 'deployment.env');
  if (fs.existsSync(current)) return current;
  // A deployment whose last update ran before the Gaminus rename keeps its
  // state under the legacy data root until scripts/gaminus.sh adopts it on the
  // next managed install or update.
  const legacy = path.join(legacyDataRoot(homeDir), 'deployment', 'deployment.env');
  return fs.existsSync(legacy) ? legacy : current;
}
export function getUpdateOperationFile(stateFile = getDeploymentStateFile()) {
  return path.join(path.dirname(stateFile), 'update-operation.json');
}


export function readDeploymentState(stateFile = getDeploymentStateFile(), readFileSync = fs.readFileSync) {
  try {
    const state = Object.create(null);
    for (const line of readFileSync(stateFile, 'utf8').split(/\r?\n/)) {
      const separator = line.indexOf('=');
      if (separator <= 0) continue;
      const key = line.slice(0, separator);
      if (!/^[a-z_]+$/.test(key)) continue;
      state[key] = line.slice(separator + 1);
    }
    return state;
  } catch {
    return null;
  }
}

export function getDeploymentHealth(stateFile, appRoot, readFileSync) {
  const state = readDeploymentState(stateFile, readFileSync);
  const isManaged = Boolean(state && state.active_root === appRoot);
  return {
    installedReleaseTag: state?.release_tag || null,
    installMode: isManaged ? 'managed' : 'unknown',
  };
}

function defaultRunningSha(appRoot) {
  try {
    return execFileSync('git', ['-C', appRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function compareStableSemverTags(left, right) {
  const leftParts = left.replace(/^v/, '').split(/[.+]/, 3);
  const rightParts = right.replace(/^v/, '').split(/[.+]/, 3);

  for (let index = 0; index < 3; index += 1) {
    const leftPart = BigInt(leftParts[index]);
    const rightPart = BigInt(rightParts[index]);
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

export async function resolveLatestStableReleaseTag(fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/${REPOSITORY_SLUG}/releases?per_page=100`,
      { headers: { Accept: 'application/vnd.github+json' } },
    );
    if (!response?.ok) return null;

    const releases = await response.json();
    if (!Array.isArray(releases)) return null;

    const tags = releases
      .filter((release) => !release?.draft && !release?.prerelease)
      .map((release) => release?.tag_name)
      .filter((tag) => typeof tag === 'string' && STABLE_SEMVER_TAG_PATTERN.test(tag));

    return tags.sort(compareStableSemverTags).at(-1) || null;
  } catch {
    return null;
  }
}
function readUpdateOperation(operationFile, readFileSync) {
  try {
    const operation = JSON.parse(readFileSync(operationFile, 'utf8'));
    return typeof operation?.operationId === 'string' && typeof operation?.startedAt === 'string'
      ? operation
      : null;
  } catch {
    return null;
  }
}

function removeUpdateOperation(operationFile, unlinkSync) {
  try {
    unlinkSync(operationFile);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function reserveUpdateOperation(operationFile, operation, openSync, writeFileSync, closeSync) {
  let descriptor;
  try {
    descriptor = openSync(operationFile, 'wx');
    writeFileSync(descriptor, JSON.stringify(operation));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}


export function createUpdateStatusHandler({
  stateFile = getDeploymentStateFile(),
  readFileSync = fs.readFileSync,
  existsSync = fs.existsSync,
  unlinkSync = fs.unlinkSync,
  now = () => Date.now(),
} = {}) {
  const operationFile = getUpdateOperationFile(stateFile);
  return (req, res) => {
    const state = readDeploymentState(stateFile, readFileSync);
    const operation = readUpdateOperation(operationFile, readFileSync);
    const operationFileExists = existsSync(operationFile);
    const terminalForOperation = operation
      && TERMINAL_UPDATE_STATES.has(state?.update_state)
      && state?.operation_id === operation.operationId;
    const staleOperation = operation && Date.parse(operation.startedAt) <= now() - (60 * 60 * 1000);

    if (terminalForOperation || staleOperation) removeUpdateOperation(operationFile, unlinkSync);

    res.json({
      operationId: state?.operation_id || null,
      updateState: state?.update_state || null,
      releaseTag: state?.release_tag || null,
      sha: state?.sha || null,
      failure: state?.failure || null,
      inProgress: existsSync(path.join(path.dirname(stateFile), 'lock'))
        || (operationFileExists && !terminalForOperation && !staleOperation)
        || Boolean(state?.update_state && !TERMINAL_UPDATE_STATES.has(state.update_state)),
    });
  };
}

export function createUpdateHandler({
  appRoot,
  stateFile = getDeploymentStateFile(),
  readFileSync = fs.readFileSync,
  getRunningSha = () => defaultRunningSha(appRoot),
  fetch = globalThis.fetch,
  spawn = nodeSpawn,
  openSync = fs.openSync,
  writeFileSync = fs.writeFileSync,
  closeSync = fs.closeSync,
  unlinkSync = fs.unlinkSync,
  now = () => Date.now(),
  createOperationId = randomUUID,
} = {}) {
  const operationFile = getUpdateOperationFile(stateFile);
  return async (req, res) => {
    const state = readDeploymentState(stateFile, readFileSync);

    const runningSha = getRunningSha();
    if (
      !state
      || state.active_root !== appRoot
      || !SHA_PATTERN.test(state.sha || '')
      || !SHA_PATTERN.test(runningSha || '')
      || state.sha.toLowerCase() !== runningSha.toLowerCase()
    ) {
      res.status(409).json({ error: MANUAL_UPDATE_MESSAGE });
      return;
    }

    const operationId = createOperationId();
    try {
      reserveUpdateOperation(operationFile, {
        operationId,
        startedAt: new Date(now()).toISOString(),
      }, openSync, writeFileSync, closeSync);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        res.status(423).json({ error: UPDATE_IN_PROGRESS_MESSAGE });
        return;
      }
      res.status(503).json({ error: `Unable to reserve update: ${error.message}` });
      return;
    }

    const releaseTag = await resolveLatestStableReleaseTag(fetch);
    if (!releaseTag) {
      removeUpdateOperation(operationFile, unlinkSync);
      res.status(503).json({
        error: 'Unable to determine a trusted stable release. Update manually from your installation directory.',
      });
      return;
    }

    const updateScript = path.join(state.active_root, 'scripts', 'gaminus.sh');
    const unit = `gaminus-update-${now()}`;
    let child;
    try {
      child = spawn('systemd-run', [
        '--user',
        '--collect',
        `--unit=${unit}`,
        `--setenv=GAMINUS_OPERATION_ID=${operationId}`,
        updateScript,
        'update',
        '--ref',
        releaseTag,
      ], {
        detached: true,
        stdio: 'ignore',
        shell: false,
      });
    } catch (error) {
      removeUpdateOperation(operationFile, unlinkSync);
      res.status(502).json({ error: `Unable to launch update: ${error.message}` });
      return;
    }

    let responded = false;
    const failLaunch = (detail) => {
      if (responded) return;
      responded = true;
      removeUpdateOperation(operationFile, unlinkSync);
      res.status(502).json({ error: `Unable to launch update: ${detail}` });
    };
    child.once?.('error', (error) => failLaunch(error.message));
    child.once?.('exit', (code, signal) => {
      if (responded) return;
      if (code === 0) {
        responded = true;
        res.status(202).json({
          operationId,
          output: `Update started in systemd unit ${unit}.`,
          unit,
        });
        return;
      }
      failLaunch(`systemd-run exited with ${signal ? `signal ${signal}` : `status ${code}`}`);
    });
  };
}

export function createSystemRouter(options) {
  const router = express.Router();
  router.post('/update', createUpdateHandler(options));
  router.get('/update/status', createUpdateStatusHandler(options));
  return router;
}

export default createSystemRouter;
