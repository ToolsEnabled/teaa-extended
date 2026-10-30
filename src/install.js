// Shared native Windows/Linux installer. Launch scripts only locate Node.
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir, isWindows } from './platform.js';

const PRODUCT = '@toolsenabled/teaa';
const MARKER = '.teaa-install.json';
const digest = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const present = (p) => { try { lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const regular = (p) => { const s = lstatSync(p); if (!s.isFile() || s.isSymbolicLink()) throw new Error(`Expected a regular file: ${p}`); return s; };
function plainAncestors(p) {
  for (let q = resolve(p); ; q = dirname(q)) {
    if (present(q) && (!lstatSync(q).isDirectory() || lstatSync(q).isSymbolicLink())) throw new Error(`Install path crosses a link or non-directory: ${q}`);
    if (dirname(q) === q) break;
  }
}
function safeRelative(p) {
  return typeof p === 'string' && p.length > 0 && !p.includes('\\') && !p.includes('\0') && !isAbsolute(p)
    && !p.split('/').some((x) => !x || x === '.' || x === '..') && !/^[A-Za-z]:/.test(p);
}
export function readManifest(root) {
  const path = join(root, 'release-manifest.json');
  regular(path);
  const m = JSON.parse(readFileSync(path, 'utf8'));
  if (m.product !== PRODUCT || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(m.version)
      || !['linux', 'win32'].includes(m.platform) || m.arch !== 'x64' || !Array.isArray(m.files) || !m.files.length || m.files.length > 20000) throw new Error('Invalid TEAA release manifest');
  const names = new Set();
  for (const f of m.files) {
    if (!safeRelative(f.path) || names.has(f.path) || !/^[a-f0-9]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size < 0) throw new Error('Invalid release file entry');
    names.add(f.path);
  }
  for (const p of ['bin/teaa.js', 'src/install.js', 'package.json']) if (!names.has(p)) throw new Error(`Release missing ${p}`);
  return m;
}
export function verifyRelease(root, m = readManifest(root)) {
  for (const f of m.files) {
    const path = join(root, f.path);
    plainAncestors(dirname(path));
    if (regular(path).size !== f.size || digest(path) !== f.sha256) throw new Error(`Release integrity check failed: ${f.path}`);
  }
  return m;
}
const shellQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
function shimText(app, binDir) {
  if (isWindows) {
    if (/[\r\n%]/.test(process.execPath + app + binDir)) throw new Error('Windows install paths may not contain percent signs or line breaks');
    // CMD reads batch source in its console code page. Expand the directory
    // at execution time so a Unicode user/install prefix stays in Win32 argv.
    const commandPath = (file) => { const r = relative(binDir, file); return isAbsolute(r) ? r : `%~dp0${r}`; };
    const node = commandPath(process.execPath), entry = commandPath(join(app, 'bin', 'teaa.js'));
    if (/[^\x00-\x7F]/.test(node + entry)) throw new Error('These custom Windows command paths cannot be represented safely in a batch shim. Keep the command directory beside the app, or use the Node MCP server entry directly.');
    return `@echo off\r\n"${node}" "${entry}" %*\r\n`;
  }
  return `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(app, 'bin', 'teaa.js'))} "$@"\n`;
}
function changeUserPath(bin, remove = false) {
  const script = `$ErrorActionPreference='Stop'; $p=[Environment]::GetEnvironmentVariable('Path','User'); $parts=@($p -split ';' | Where-Object { $_ }); $found=@($parts | Where-Object { $_.TrimEnd('\\') -ieq $env:TEAA_INSTALL_BIN.TrimEnd('\\') }).Count -gt 0; if($env:TEAA_INSTALL_REMOVE -eq '1') { if($found) { $parts=@($parts | Where-Object { $_.TrimEnd('\\') -ine $env:TEAA_INSTALL_BIN.TrimEnd('\\') }); [Environment]::SetEnvironmentVariable('Path',($parts -join ';'),'User') }; Write-Output 'removed' } elseif(-not $found) { $parts += $env:TEAA_INSTALL_BIN; [Environment]::SetEnvironmentVariable('Path',($parts -join ';'),'User'); Write-Output 'added' } else { Write-Output 'present' }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, TEAA_INSTALL_BIN: bin, TEAA_INSTALL_REMOVE: remove ? '1' : '0' }, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (r.error || r.status !== 0) throw new Error(`Could not update your PATH: ${r.error?.message || r.stderr}`);
  return r.stdout.trim() === 'added';
}
function contents(root) {
  const out = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isSymbolicLink()) throw new Error(`Installation contains a link: ${p}`);
    if (e.isDirectory()) out.push(...contents(p)); else { regular(p); out.push(p); }
  }
  return out;
}
function ownedPreviousInstall(prefix, shim) {
  const apps = join(prefix, 'app');
  if (!present(apps)) return null;
  plainAncestors(apps);
  const matches = [];
  for (const entry of readdirSync(apps, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(entry.name)) continue;
    const app = join(apps, entry.name), receipt = join(app, MARKER);
    if (!present(receipt)) continue;
    regular(receipt);
    const marker = JSON.parse(readFileSync(receipt, 'utf8'));
    if (marker.product !== PRODUCT || marker.app !== app || marker.shim !== shim || marker.shimSha256 !== digest(shim)) continue;
    verifyRelease(app);
    matches.push(marker);
  }
  if (matches.length > 1) throw new Error(`Ambiguous existing command ownership: ${shim}`);
  return matches[0] || null;
}
export function installRelease({ source, prefix = dataDir(), binDir, desktop = false, shortcuts = false, terminalMenus = false, addToPath = false, uninstall = false } = {}) {
  if (shortcuts || desktop || terminalMenus) throw new Error('This MCP-only release has no GUI shortcuts or terminal menus');
  source = resolve(source); prefix = resolve(prefix);
  binDir = resolve(binDir || (isWindows ? join(prefix, 'bin') : process.env.TEAA_BIN || join(homedir(), '.local', 'bin')));
  const manifest = readManifest(source);
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error(`This archive is for ${manifest.platform}/${manifest.arch}; this system is ${process.platform}/${process.arch}`);
  const app = join(prefix, 'app', manifest.version);
  const shim = join(binDir, isWindows ? 'teaa.cmd' : 'teaa');
  plainAncestors(prefix); plainAncestors(binDir);
  mkdirSync(prefix, { recursive: true, mode: 0o700 });
  const lock = join(prefix, '.install-lock');
  try { mkdirSync(lock, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') throw new Error(`Another install may be active. Reconcile ${lock} before retrying.`); throw e; }
  try {
    if (uninstall) {
      if (!present(app)) return { installed: false, message: 'This version is not installed. Settings are kept.' };
      plainAncestors(app);
      const markerPath = join(app, MARKER); regular(markerPath);
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
      if (marker.product !== PRODUCT || marker.app !== app || marker.shim !== shim) throw new Error('This folder is not this TEAA installation');
      verifyRelease(app);
      const allowed = new Set([...readManifest(app).files.map((f) => join(app, f.path)), markerPath, join(app, 'release-manifest.json')]);
      for (const p of contents(app)) if (!allowed.has(p)) throw new Error(`Uninstall preserved an unexpected file: ${p}`);
      if (present(shim) && (!lstatSync(shim).isFile() || lstatSync(shim).isSymbolicLink() || digest(shim) !== marker.shimSha256)) throw new Error(`Uninstall preserved a changed command: ${shim}`);
      if (marker.shortcuts) throw new Error('Use the original GUI release to remove its shortcuts first');
      if (marker.pathAdded) changeUserPath(binDir, true);
      if (existsSync(shim)) rmSync(shim);
      rmSync(app, { recursive: true });
      return { installed: false, message: `Removed TEAA Extended ${manifest.version}. Settings and Fleet state are kept.` };
    }
    verifyRelease(source, manifest);
    const command = shimText(app, binDir);
    let previous;
    if (present(shim)) {
      regular(shim);
      if (readFileSync(shim, 'utf8') !== command) {
        previous = ownedPreviousInstall(prefix, shim);
        if (!previous) throw new Error(`Refusing to replace an existing command: ${shim}`);
      }
    }
    if (present(app)) {
      plainAncestors(app);
      const marker = JSON.parse(readFileSync(join(app, MARKER), 'utf8'));
      if (marker.product !== PRODUCT || marker.app !== app || marker.shim !== shim) throw new Error(`Refusing to overwrite ${app}`);
      verifyRelease(app, manifest);
    } else {
      const parent = dirname(app); mkdirSync(parent, { recursive: true, mode: 0o700 });
      const stage = join(parent, `.${manifest.version}-${randomUUID()}`); mkdirSync(stage, { mode: 0o700 });
      try {
        for (const f of manifest.files) { const p = join(stage, f.path); mkdirSync(dirname(p), { recursive: true, mode: 0o700 }); copyFileSync(join(source, f.path), p); chmodSync(p, f.mode === 0o755 ? 0o755 : 0o600); }
        copyFileSync(join(source, 'release-manifest.json'), join(stage, 'release-manifest.json'));
        verifyRelease(stage, manifest); renameSync(stage, app);
      } catch (e) { e.message += ` (staging files, if any, retained at ${stage})`; throw e; }
    }
    mkdirSync(binDir, { recursive: true, mode: 0o700 }); writeFileSync(shim, command, { mode: 0o755 }); chmodSync(shim, 0o755);
    const markerPath = join(app, MARKER);
    const prior = existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, 'utf8')) : {};
    const marker = { product: PRODUCT, version: manifest.version, app, shim, shimSha256: digest(shim), shortcuts: prior.shortcuts || false, pathAdded: prior.pathAdded || previous?.pathAdded || false, ...(previous ? { previousApp: previous.app } : {}) };
    const save = () => writeFileSync(markerPath, JSON.stringify(marker, null, 2) + '\n', { mode: 0o600 }); save();
    if (addToPath && isWindows) { marker.pathAdded = changeUserPath(binDir) || marker.pathAdded; save(); }
    return { installed: true, app, shim, message: `Installed TEAA Extended ${manifest.version}. Run ${shim} setup, then ${shim} doctor.` };
  } finally { rmdirSync(lock); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = { source: resolve(dirname(fileURLToPath(import.meta.url)), '..'), prefix: process.env.TEAA_PREFIX || dataDir() };
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '--prefix' || a === '-prefix') { if (!args[i + 1]) throw new Error('Prefix needs a path'); opts.prefix = args[++i]; }
      else if (a === '--desktop' || a === '-desktop') throw new Error('This MCP-only release has no desktop shortcut');
      else if (a === '--no-shortcuts' || a === '-noshortcuts') opts.shortcuts = false;
      else if (a === '--no-terminal-menus' || a === '-noterminalmenus') opts.terminalMenus = false;
      else if (a === '--add-to-path' || a === '-addtopath') opts.addToPath = true;
      else if (a === '--uninstall' || a === '-uninstall') opts.uninstall = true;
      else throw new Error(`Unknown installer option: ${args[i]}`);
    }
    console.log(installRelease(opts).message);
  } catch (e) { console.error(`TEAA install: ${e.message}`); process.exitCode = 1; }
}
