import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertPrivateDataPath, rebaseOwnedRuntimeEntries, rebindEarlierFleetRuntime } from '../src/bundle.js';

const FLEET_V4 = 'vendor/fleet/bin/fleetV4.js', FLEET_V5 = 'vendor/fleet/bin/fleetV5.js', FLEET_V2 = 'vendor/fleet/bin/fleetV2.js', REGULAR_FLEET = 'vendor/fleet/bin/toolsenabled-host.js';
// An earlier installed TEAA (old) next to this one (next). The earlier one bundled oldFleet.
function fixture(oldFleet = FLEET_V4) {
  const parent = mkdtempSync(join(tmpdir(), 'teaa-bundle-upgrade-'));
  const old = join(parent, '0.2.0-alpha.3'), next = join(parent, '0.4.0-alpha.1');
  const files = ['bin/teaa.js', 'src/install.js', 'package.json', oldFleet, FLEET_V5, 'vendor/toolsengine/bin/toolsengine.js'];
  const entries = [];
  for (const file of files) {
    const data = `fixture ${file}`;
    for (const dir of [old, next]) { const name = dir === next && file === oldFleet ? FLEET_V5 : file; mkdirSync(join(dir, name, '..'), { recursive: true }); writeFileSync(join(dir, name), data); }
    entries.push({ path: file, size: Buffer.byteLength(data), sha256: createHash('sha256').update(data).digest('hex') });
  }
  writeFileSync(join(old, 'release-manifest.json'), JSON.stringify({ product: '@toolsenabled/teaa', version: '0.1.1-alpha.2', platform: process.platform, arch: 'x64', files: entries }));
  writeFileSync(join(old, '.teaa-install.json'), JSON.stringify({ product: '@toolsenabled/teaa', app: old }));
  const cfg = {
    fleet: { command: process.execPath, args: [join(old, files[3]), 'serve', '--actor', 'agy'], env: {} },
    engine: { command: process.execPath, args: [join(old, files[5]), '--chrome-hidden'], env: { TOOLSENABLED_SETTINGS: join(parent, 'settings.json') } },
  };
  return { old, next, cfg, files };
}
test('a group-writable ancestor blocks Fleet state before any audit check is weakened', { skip: process.platform === 'win32' ? 'POSIX group-write modes are not a Windows ACL test; native ACL validation runs during Windows Fleet setup' : false }, () => {
  const parent = mkdtempSync(join(tmpdir(), 'teaa-private-'));
  try {
    const loose = join(parent, 'loose');
    mkdirSync(loose, { mode: 0o700 });
    chmodSync(loose, 0o775);
    assert.throws(() => assertPrivateDataPath(join(loose, 'fleetV4-state')), /audit signing key/);
    const tight = join(parent, 'tight');
    mkdirSync(tight, { mode: 0o700 });
    assert.doesNotThrow(() => assertPrivateDataPath(join(tight, 'fleetV4-state')));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
test('explicit legacy runtime remains unchanged while a verified TEAA engine version rebases', () => {
  const { next, cfg, files } = fixture(REGULAR_FLEET), settings = { ...cfg.engine.env };
  assert.deepEqual(rebaseOwnedRuntimeEntries(cfg, { root: next }), ['engine']);
  assert.equal(cfg.fleet.args[0].replace(/\\/g, '/').endsWith(REGULAR_FLEET), true, 'explicit legacy runtime is left unchanged');
  assert.deepEqual(cfg.engine.args, [join(next, files[5]), '--chrome-hidden']);
  assert.deepEqual(cfg.engine.env, settings);
  assert.deepEqual(rebaseOwnedRuntimeEntries(cfg, { root: next }), []);
});
test('unowned direct legacy Fleet entry remains unchanged', () => {
  const { next, cfg } = fixture(FLEET_V2);
  assert.deepEqual(rebaseOwnedRuntimeEntries(cfg, { root: next }), ['engine']);
  assert.equal(cfg.fleet.args[0].replace(/\\/g, '/').endsWith(FLEET_V2), true);
});
test('a modified earlier TEAA keeps its regular Fleet entry; nothing is cleared without verification', () => {
  const { old, next, cfg, files } = fixture(REGULAR_FLEET);
  writeFileSync(join(old, files[3]), 'user-modified runtime');
  const before = structuredClone(cfg);
  assert.deepEqual(rebaseOwnedRuntimeEntries(cfg, { root: next }), []);
  assert.deepEqual(cfg, before);
});
test('setup explicitly rebinds verified TEAA V4 to a fresh V5 generation without carrying the V4 state arguments', () => {
  const { next, cfg, files } = fixture(), settings = { ...cfg.engine.env };
  assert.deepEqual(rebaseOwnedRuntimeEntries(cfg, { root: next }), ['fleet-v4-to-v5', 'engine']);
  assert.deepEqual(cfg.fleet, { command: null, args: [], env: {} });
  assert.equal(files.includes(FLEET_V4), true);
  assert.equal(files.includes(FLEET_V5), true);
  assert.deepEqual(cfg.engine.args, [join(next, files[5]), '--chrome-hidden']);
  assert.deepEqual(cfg.engine.env, settings);
  assert.deepEqual(rebaseOwnedRuntimeEntries(cfg, { root: next }), []);
});
test('setup preserves modified older installations and explicitly external runtimes', () => {
  const { old, next, cfg, files } = fixture();
  writeFileSync(join(old, files[4]), 'user-modified runtime');
  const before = structuredClone(cfg);
  assert.deepEqual(rebaseOwnedRuntimeEntries(cfg, { root: next }), []);
  assert.deepEqual(cfg, before);
  const f = fixture();
  assert.deepEqual(rebaseOwnedRuntimeEntries(f.cfg, { root: join(f.next, 'external') }), []);
});

function ownedRelease(root, version, shim, fleetIdentity, fleetSource = null) {
  if (fleetSource) cpSync(fleetSource, join(root, 'vendor', 'fleet'), { recursive: true });
  const fleetEntry = join(root, 'vendor', 'fleet', 'bin', 'fleetV5.js');
  const files = new Map([
    ['bin/teaa.js', '#!/usr/bin/env node\n'],
    ['src/install.js', 'verified installer source\n'],
    ['package.json', JSON.stringify({ name: '@toolsenabled/teaa', version })],
    ['vendor/fleet/bin/fleetV5.js', fleetSource ? readFileSync(fleetEntry, 'utf8') : 'identical Fleet entry\n'],
    ['components.lock.json', JSON.stringify({ fleet: fleetIdentity })],
  ]);
  const manifestFiles = [];
  for (const [name, body] of files) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
    manifestFiles.push({ path: name, size: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') });
  }
  writeFileSync(join(root, 'release-manifest.json'), JSON.stringify({
    product: '@toolsenabled/teaa', version, platform: process.platform, arch: 'x64', files: manifestFiles,
  }));
  writeFileSync(join(root, '.teaa-install.json'), JSON.stringify({
    product: '@toolsenabled/teaa', version, app: root, shim, shimSha256: 'a'.repeat(64),
  }));
}

test('setup rebinds an in-place prior TEAA Fleet runtime only when its component identity matches', () => {
  const prefix = mkdtempSync(join(tmpdir(), 'teaa-runtime-rebind-'));
  try {
    const apps = join(prefix, 'app');
    const old = join(apps, '0.5.0-alpha.8');
    const next = join(apps, '0.5.0-alpha.9');
    const shim = join(prefix, 'bin', 'teaa');
    const stateRoot = join(prefix, 'data', 'toolsenabled-agent-kit', 'fleetV5-state');
    const identity = {
      version: '5.0.0-alpha.13', platform: `${process.platform === 'win32' ? 'windows' : 'linux'}-x64`,
      commit: '2c37a8a82ec35b014e957e3fe2be827658868658', archiveSha256: 'b'.repeat(64),
      identitySha256: 'c'.repeat(64), packagedFilesSha256: 'd'.repeat(64),
    };
    ownedRelease(old, '0.5.0-alpha.8', shim, identity);
    ownedRelease(next, '0.5.0-alpha.9', shim, identity);
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    const hostConfig = {
      schemaVersion: 1, mode: 'host', profile: 'fleetV2', generation: 5, treeStorage: 'sqlite-v1',
      workers: true, tier: 'unrestricted', workspace: join(prefix, 'workspace'), stateRoot,
      installRoot: join(old, 'vendor', 'fleet'), nodePath: process.execPath,
    };
    writeFileSync(join(stateRoot, 'host-mode.json'), JSON.stringify(hostConfig), { mode: 0o600 });
    const enrollment = join(prefix, 'data', 'extended', 'devices', 'default', 'enrollment.json');
    mkdirSync(join(enrollment, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(enrollment, 'synthetic-enrollment-preserved');
    const events = [];
    const rebound = rebindEarlierFleetRuntime({ root: next, stateRoot, fleetConfig: { enabled: true, command: process.execPath, args: [join(next, 'vendor', 'fleet', 'bin', 'fleetV5.js')] }, runFleet: (entry, args) => {
      events.push({ entry, args });
      return { status: 0, stdout: JSON.stringify({ rebind: 'rebound' }), stderr: '' };
    } });
    assert.equal(rebound.from, join(old, 'vendor', 'fleet'));
    assert.equal(events.length, 1);
    assert.equal(events[0].entry, join(next, 'vendor', 'fleet', 'bin', 'fleetV5.js'));
    assert.deepEqual(events[0].args, ['rebind', '--state-root', stateRoot]);
    assert.equal(readFileSync(enrollment, 'utf8'), 'synthetic-enrollment-preserved');
  } finally { rmSync(prefix, { recursive: true, force: true }); }
});



test('an in-place Fleet upgrade performs Fleet rebind and preserves real state plus enrollment', () => {
  const prefix = mkdtempSync(join(tmpdir(), 'teaa-runtime-rebind-live-'));
  try {
    const apps = join(prefix, 'app');
    const old = join(apps, '0.5.0-alpha.8');
    const next = join(apps, '0.5.0-alpha.9');
    const shim = join(prefix, 'bin', 'teaa');
    const stateRoot = join(prefix, 'data', 'toolsenabled-agent-kit', 'fleetV5-state');
    const workspace = join(prefix, 'workspace');
    const fleetSource = fileURLToPath(new URL('../vendor/fleet', import.meta.url));
    const lock = JSON.parse(readFileSync(new URL('../components.lock.json', import.meta.url), 'utf8')).fleet;
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    ownedRelease(old, '0.5.0-alpha.8', shim, lock, fleetSource);
    ownedRelease(next, '0.5.0-alpha.9', shim, lock, fleetSource);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^TOOLSENABLED_/i.test(name)));
    const oldEntry = join(old, 'vendor', 'fleet', 'bin', 'fleetV5.js');
    const invoke = (entry, args) => spawnSync(process.execPath, [entry, ...args], {
      cwd: workspace, env, encoding: 'utf8', windowsHide: true, timeout: 90_000,
    });
    const setup = invoke(oldEntry, ['setup', '--state-root', stateRoot, '--workspace', workspace, '--actor', 'local', '--coordination-only']);
    assert.equal(setup.status, 0, 'the prior bundled Fleet state should be created successfully');
    const enrollment = join(prefix, 'data', 'extended', 'devices', 'default', 'enrollment.json');
    mkdirSync(dirname(enrollment), { recursive: true, mode: 0o700 });
    writeFileSync(enrollment, 'synthetic-enrollment-preserved', { mode: 0o600 });
    const retained = join(stateRoot, 'synthetic-retained-state');
    writeFileSync(retained, 'fleet-user-state-preserved', { mode: 0o600 });
    const rebound = rebindEarlierFleetRuntime({
      root: next, stateRoot, fleetConfig: { enabled: true, command: process.execPath, args: [join(next, 'vendor', 'fleet', 'bin', 'fleetV5.js')] },
      runFleet: invoke,
    });
    assert.equal(rebound.rebound, true);
    const config = JSON.parse(readFileSync(join(stateRoot, 'host-mode.json'), 'utf8'));
    assert.equal(config.installRoot, join(next, 'vendor', 'fleet'));
    assert.equal(config.workers, false);
    assert.equal(config.workspace, workspace);
    assert.equal(readFileSync(retained, 'utf8'), 'fleet-user-state-preserved');
    assert.equal(readFileSync(enrollment, 'utf8'), 'synthetic-enrollment-preserved');
    assert.equal(existsSync(join(stateRoot, 'runtime-rebinds.jsonl')), true);
    const status = invoke(join(next, 'vendor', 'fleet', 'bin', 'fleetV5.js'), ['status', '--state-root', stateRoot, '--actor', 'local']);
    assert.equal(status.status, 0, 'the upgraded Fleet runtime should reopen the same state');
  } finally { rmSync(prefix, { recursive: true, force: true }); }
});

test('setup refuses a different Fleet identity with TEAA guidance and leaves state and enrollment unchanged', () => {
  const prefix = mkdtempSync(join(tmpdir(), 'teaa-runtime-rebind-mismatch-'));
  try {
    const apps = join(prefix, 'app');
    const old = join(apps, '0.5.0-alpha.8');
    const next = join(apps, '0.5.0-alpha.9');
    const shim = join(prefix, 'bin', 'teaa');
    const stateRoot = join(prefix, 'data', 'toolsenabled-agent-kit', 'fleetV5-state');
    const identity = (commit, archive, packaged) => ({
      version: '5.0.0-alpha.13', platform: `${process.platform === 'win32' ? 'windows' : 'linux'}-x64`,
      commit, archiveSha256: archive, identitySha256: 'c'.repeat(64), packagedFilesSha256: packaged,
    });
    ownedRelease(old, '0.5.0-alpha.8', shim, identity('1'.repeat(40), 'b'.repeat(64), 'd'.repeat(64)));
    ownedRelease(next, '0.5.0-alpha.9', shim, identity('2'.repeat(40), 'e'.repeat(64), 'f'.repeat(64)));
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    const hostFile = join(stateRoot, 'host-mode.json');
    writeFileSync(hostFile, JSON.stringify({
      schemaVersion: 1, mode: 'host', profile: 'fleetV2', generation: 5, treeStorage: 'sqlite-v1',
      workers: true, tier: 'unrestricted', workspace: join(prefix, 'workspace'), stateRoot,
      installRoot: join(old, 'vendor', 'fleet'), nodePath: process.execPath,
    }), { mode: 0o600 });
    const stateBefore = readFileSync(hostFile, 'utf8');
    const enrollment = join(prefix, 'data', 'extended', 'devices', 'default', 'enrollment.json');
    mkdirSync(join(enrollment, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(enrollment, 'synthetic-enrollment-preserved');
    const events = [];
    assert.throws(() => rebindEarlierFleetRuntime({
      root: next, stateRoot, fleetConfig: { enabled: true, command: process.execPath, args: [join(next, 'vendor', 'fleet', 'bin', 'fleetV5.js')] },
      runFleet: (...args) => { events.push(args); return { status: 0, stdout: '{"rebind":"rebound"}', stderr: '' }; },
    }), (error) => /TEAA/.test(error.message) && /teaa setup/.test(error.message) && !/fleetV5 rebind/i.test(error.message));
    assert.deepEqual(events, []);
    assert.equal(readFileSync(hostFile, 'utf8'), stateBefore);
    assert.equal(readFileSync(enrollment, 'utf8'), 'synthetic-enrollment-preserved');
  } finally { rmSync(prefix, { recursive: true, force: true }); }
});

test('runSetup performs the Fleet repair before rebasing the saved entry', () => {
  const setup = readFileSync(new URL('../src/setup.js', import.meta.url), 'utf8');
  const repair = setup.indexOf('rebindEarlierFleetRuntime({ fleetConfig: cfg.fleet })');
  const rebase = setup.indexOf('rebaseOwnedRuntimeEntries(cfg)');
  assert.ok(repair >= 0 && rebase > repair);
});
