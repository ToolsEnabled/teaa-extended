'use strict';

/* WHICH PRODUCT THIS PROCESS IS, AND ITS OWN VERSION.
 *
 * One source tree builds more than one product. package.json carries the
 * ToolsEnabled Fleet release; fleetV2.json carries the Fleet V2 release that
 * bin/fleetV2.js serves and TEAA vendors (including existing Agent Kit installs). A Fleet V2 runtime (host-runtime sets
 * TOOLSENABLED_FLEET_PROFILE=fleetV2) reports Fleet V2 and fleetV2.json's
 * version; it never borrows the other product's name or number. When that
 * manifest cannot be read, the version is null and the reason is named. */

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function readVersion(file) {
  try {
    const manifest = JSON.parse(require('node:fs').readFileSync(path.join(ROOT, file), 'utf8'));
    return typeof manifest.version === 'string' && manifest.version ? { version: manifest.version } : { version: null, versionError: `${file} names no version` };
  } catch (error) {
    return { version: null, versionError: `${file} could not be read (${error.code || 'invalid JSON'})` };
  }
}

function generationName(generation) {
  if (generation === 5) return 'fleetV5';
  if (generation === 4) return 'fleetV4';
  if (generation === 3) return 'fleetV3';
  return 'fleetV2';
}

function transactionalGeneration(generation) {
  return generation === 3 || generation === 4 || generation === 5;
}

function productIdentity(env = process.env) {
  if (env.TOOLSENABLED_FLEET_PROFILE === 'fleetV2' && env.TOOLSENABLED_FLEET_GENERATION === '5') return Object.freeze({ name: 'fleetV5', ...readVersion('fleetV5.json') });
  if (env.TOOLSENABLED_FLEET_PROFILE === 'fleetV2' && env.TOOLSENABLED_FLEET_GENERATION === '3') return Object.freeze({ name: 'fleetV3', ...readVersion('fleetV3.json') });
  if (env.TOOLSENABLED_FLEET_PROFILE === 'fleetV2' && env.TOOLSENABLED_FLEET_GENERATION === '4') return Object.freeze({ name: 'fleetV4', ...readVersion('fleetV4.json') });
  if (env.TOOLSENABLED_FLEET_PROFILE === 'fleetV2') return Object.freeze({ name: 'fleetV2', ...readVersion('fleetV2.json') });
  return Object.freeze({ name: 'ToolsEnabled Fleet', ...readVersion('package.json') });
}

module.exports = Object.freeze({ productIdentity, generationName, transactionalGeneration });
