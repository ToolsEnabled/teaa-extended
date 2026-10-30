import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { assertPrivateDataPath, rebaseOwnedRuntimeEntries } from '../src/bundle.js';

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
