import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installRelease, readManifest, verifyRelease } from '../src/install.js';

function fixture(version = '0.1.0') {
  const dir = mkdtempSync(join(tmpdir(), 'teaa-install-'));
  const source = join(dir, "source with 'quote");
  const files = { 'package.json': JSON.stringify({ name: '@toolsenabled/teaa', version, type: 'module' }), 'bin/teaa.js': 'console.log(JSON.stringify(process.argv.slice(2)))', 'src/install.js': '// fixture installer payload', 'native/asset.txt': 'character' };
  const entries = Object.entries(files).map(([path, text]) => {
    mkdirSync(join(source, path, '..'), { recursive: true }); writeFileSync(join(source, path), text);
    return { path, size: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), mode: 0o644 };
  });
  writeFileSync(join(source, 'release-manifest.json'), JSON.stringify({ product: '@toolsenabled/teaa', version, platform: process.platform, arch: process.arch, files: entries }));
  const prefix = join(dir, "installation 'with spaces");
  const binDir = process.platform === 'win32' ? join(prefix, 'bin') : join(dir, 'commands');
  return { dir, source, prefix, binDir, shortcuts: false };
}
test('installer validates bytes, handles quoted paths, is repeatable, and preserves settings on uninstall', () => {
  const f = fixture();
  const result = installRelease(f);
  verifyRelease(result.app);
  if (process.platform !== 'win32') {
    const r = spawnSync(result.shim, ['hello $(not-a-command)', 'quote"', 'line\nnext'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), ['hello $(not-a-command)', 'quote"', 'line\nnext']);
  }
  assert.equal(installRelease(f).app, result.app);
  writeFileSync(join(f.prefix, 'personal-state.json'), 'keep');
  assert.equal(installRelease({ ...f, uninstall: true }).installed, false);
  assert.equal(existsSync(result.app), false); assert.equal(existsSync(result.shim), false);
  assert.equal(readFileSync(join(f.prefix, 'personal-state.json'), 'utf8'), 'keep');
});
test('upgrade replaces only a verified owned command and retains the prior version', () => {
  const first = fixture(), old = installRelease(first), second = fixture('0.2.0-alpha.1');
  writeFileSync(join(first.prefix, 'personal-state.json'), 'keep');
  const upgraded = installRelease({ ...second, prefix: first.prefix, binDir: first.binDir });
  assert.notEqual(upgraded.app, old.app);
  assert.equal(upgraded.shim, old.shim);
  assert.ok(readFileSync(upgraded.shim, 'utf8').includes('0.2.0-alpha.1'));
  verifyRelease(old.app); verifyRelease(upgraded.app);
  assert.equal(readFileSync(join(first.prefix, 'personal-state.json'), 'utf8'), 'keep');
  assert.equal(JSON.parse(readFileSync(join(upgraded.app, '.teaa-install.json'), 'utf8')).previousApp, old.app);
});
test('upgrade preserves a modified older command and does not install the next version', () => {
  const first = fixture(), old = installRelease(first), second = fixture('0.2.0-alpha.1');
  writeFileSync(old.shim, 'my own command');
  assert.throws(() => installRelease({ ...second, prefix: first.prefix, binDir: first.binDir }), /existing command/);
  assert.equal(readFileSync(old.shim, 'utf8'), 'my own command');
  assert.equal(existsSync(join(first.prefix, 'app', '0.2.0-alpha.1')), false);
});
test('installer refuses corrupted release before copying program files', () => {
  const f = fixture(); writeFileSync(join(f.source, 'native/asset.txt'), 'tampered');
  assert.throws(() => installRelease(f), /integrity check failed/);
  assert.equal(existsSync(join(f.prefix, 'app', '0.1.0')), false);
});
test('installer preserves an existing unrelated command and unowned target', () => {
  const f = fixture(); mkdirSync(f.binDir, { recursive: true });
  const command = join(f.binDir, process.platform === 'win32' ? 'teaa.cmd' : 'teaa'); writeFileSync(command, 'unrelated');
  assert.throws(() => installRelease(f), /existing command/); assert.equal(readFileSync(command, 'utf8'), 'unrelated');
  const g = fixture(); mkdirSync(join(g.prefix, 'app', '0.1.0'), { recursive: true }); writeFileSync(join(g.prefix, 'app', '0.1.0', 'mine'), 'keep');
  assert.throws(() => installRelease(g)); assert.equal(readFileSync(join(g.prefix, 'app', '0.1.0', 'mine'), 'utf8'), 'keep');
});
test('uninstall refuses modified or extra files without partial deletion', () => {
  const f = fixture(); const r = installRelease(f);
  writeFileSync(join(r.app, 'user-notes.txt'), 'keep me');
  assert.throws(() => installRelease({ ...f, uninstall: true }), /unexpected file/);
  assert.equal(readFileSync(join(r.app, 'user-notes.txt'), 'utf8'), 'keep me'); assert.ok(existsSync(r.shim));
  const g = fixture(); const s = installRelease(g); writeFileSync(join(s.app, 'native/asset.txt'), 'changed');
  assert.throws(() => installRelease({ ...g, uninstall: true }), /integrity/); assert.ok(existsSync(s.shim));
});
test('release paths cannot traverse outside archive or appear twice', () => {
  const f = fixture(); const p = join(f.source, 'release-manifest.json'); const m = readManifest(f.source);
  m.files.push({ ...m.files[0], path: '../outside' }); writeFileSync(p, JSON.stringify(m)); assert.throws(() => readManifest(f.source), /Invalid release file/);
  m.files.pop(); m.files.push(m.files[0]); writeFileSync(p, JSON.stringify(m)); assert.throws(() => readManifest(f.source), /Invalid release file/);
});
test('installer refuses dangling command links without following them', { skip: process.platform === 'win32' && 'Windows symlink privilege is not assumed' }, () => {
  const f = fixture(); mkdirSync(f.binDir, { recursive: true }); const target = join(f.dir, 'outside'); symlinkSync(target, join(f.binDir, 'teaa'));
  assert.throws(() => installRelease(f), /regular file/); assert.equal(existsSync(target), false);
});
