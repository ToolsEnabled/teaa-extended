'use strict';

// The FRA stream is only a transport.  This module binds an attach to the
// exact Fleet package and live Hub selected by the server-owned bridge route.
// A client first reads selectedPair(), then returns that entire value in its
// open request.  The gateway checks it again immediately before spawning and
// the bridge checks it once more against the route it actually uses.  There is
// intentionally no legacy/no-claim path: nobody uses this unreleased product,
// so retaining a downgrade would turn the handshake into decoration.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { TextDecoder } = require('node:util');
const { parseStrictJson } = require('../remote/fra-device.cjs');
const adapterDocument = require('../remote/compatibility.json');

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const CLOEXEC = fs.constants.O_CLOEXEC || 0;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const MAX_RELEASE_BYTES = 256 * 1024;
const MAX_PACKAGE_FILES = 4096;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const CLAIM_KEYS = Object.freeze([
  'adapterId', 'adapterSchema', 'generation', 'fleetVersion',
  'fleetIdentitySha256', 'hubVersion', 'capabilities'
]);
const SELECTOR_KEYS = new Set(['actor', 'tag', 'level']);
const CAPABILITY = /^[a-z][a-z0-9-]{0,63}-v[1-9][0-9]{0,5}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]{0,95})?$/;
const HEX256 = /^[0-9a-f]{64}$/;

function plainRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  if (!plainRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

function mismatch(field) {
  return Object.assign(new Error(
    `HUB_FLEET_PAIR_MISMATCH: ${field}; install the exact FRA Hub/Fleet pair selected by this gateway before attaching.`
  ), { code: 'HUB_FLEET_PAIR_MISMATCH' });
}

function validateAdapter(input) {
  if (!exactKeys(input, ['adapterId', 'adapterSchema', 'hubVersion', 'capabilities'])
      || input.adapterId !== 'fra-hub'
      || !Number.isSafeInteger(input.adapterSchema) || input.adapterSchema < 1
      || typeof input.hubVersion !== 'string' || input.hubVersion.length > 128 || !VERSION.test(input.hubVersion)
      || !Array.isArray(input.capabilities) || input.capabilities.length < 1 || input.capabilities.length > 16
      || input.capabilities.some(value => typeof value !== 'string' || !CAPABILITY.test(value))
      || new Set(input.capabilities).size !== input.capabilities.length) {
    throw mismatch('gateway adapter identity invalid');
  }
  return Object.freeze({ ...input, capabilities: Object.freeze([...input.capabilities]) });
}

const adapter = validateAdapter(adapterDocument);

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function validateOwnedImmutable(stat, kind, maxBytes) {
  if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) {
    throw mismatch(`server Fleet ${kind} is not ordinary`);
  }
  if (typeof process.getuid === 'function') {
    const uid = BigInt(process.getuid());
    if (stat.uid !== uid && stat.uid !== 0n) throw mismatch(`server Fleet ${kind} owner`);
  }
  if (process.platform !== 'win32' && (stat.mode & 0o022n) !== 0n) {
    throw mismatch(`server Fleet ${kind} is group/world writable`);
  }
  if (kind === 'file') {
    if (stat.nlink !== 1n) throw mismatch('server Fleet file has multiple names');
    if (stat.size < 0n || stat.size > BigInt(maxBytes)) throw mismatch('server Fleet file size');
  }
}

function physicalDirectory(directory) {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved, { bigint: true });
  if (stat.isSymbolicLink()) throw mismatch('server Fleet runtime path is a link');
  validateOwnedImmutable(stat, 'directory', 0);
  const real = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  if (path.resolve(real) !== resolved) throw mismatch('server Fleet runtime path traverses a link');
  return resolved;
}

function readRegularFile(file, maxBytes, { absent = false } = {}) {
  const resolved = path.resolve(file);
  let before;
  try { before = fs.lstatSync(resolved, { bigint: true }); }
  catch (error) {
    if (absent && error.code === 'ENOENT') return null;
    throw error;
  }
  if (before.isSymbolicLink()) throw mismatch('server Fleet file is a link');
  validateOwnedImmutable(before, 'file', maxBytes);
  const real = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  if (path.resolve(real) !== resolved) throw mismatch('server Fleet file path traverses a link');
  let descriptor;
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | NOFOLLOW | CLOEXEC);
    const held = fs.fstatSync(descriptor, { bigint: true });
    validateOwnedImmutable(held, 'file', maxBytes);
    if (!sameFile(before, held)) throw mismatch('server Fleet file changed while opening');
    const size = Number(held.size);
    const bytes = Buffer.allocUnsafe(size);
    let at = 0;
    while (at < size) {
      const count = fs.readSync(descriptor, bytes, at, size - at, at);
      if (!count) throw mismatch('server Fleet file ended while reading');
      at += count;
    }
    const extra = Buffer.allocUnsafe(1);
    if (fs.readSync(descriptor, extra, 0, 1, at) !== 0) throw mismatch('server Fleet file grew while reading');
    const after = fs.fstatSync(descriptor, { bigint: true });
    validateOwnedImmutable(after, 'file', maxBytes);
    if (!sameFile(held, after) || held.size !== after.size || held.mtimeNs !== after.mtimeNs
        || held.ctimeNs !== after.ctimeNs) {
      throw mismatch('server Fleet file changed while reading');
    }
    return Object.freeze({ file: resolved, bytes, stat: after });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function decodeStrict(bytes) {
  let source;
  try { source = UTF8.decode(bytes); }
  catch { throw mismatch('server Fleet release identity is not UTF-8'); }
  try { return parseStrictJson(source, 'HUB_FLEET_PAIR_MISMATCH'); }
  catch (error) {
    if (error.code === 'HUB_FLEET_PAIR_MISMATCH') throw mismatch('server Fleet release identity is invalid');
    throw error;
  }
}

function relativeReleasePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024
      || value.includes('\\') || value.startsWith('/') || path.posix.normalize(value) !== value
      || value.split('/').some(part => !part || part === '.' || part === '..')) return false;
  return true;
}

function packageFiles(packageRoot, ignored) {
  const result = [];
  const visit = (directory, prefix = '') => {
    const stat = fs.lstatSync(directory, { bigint: true });
    if (stat.isSymbolicLink()) throw mismatch('server Fleet package contains a link');
    validateOwnedImmutable(stat, 'directory', 0);
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    if (entries.length > MAX_PACKAGE_FILES) throw mismatch('server Fleet package has too many entries');
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) {
        if (!ignored.has(path.resolve(absolute))) result.push(relative);
        if (result.length > MAX_PACKAGE_FILES) throw mismatch('server Fleet package has too many files');
      } else throw mismatch('server Fleet package contains a non-file');
    }
  };
  visit(packageRoot);
  return result.sort();
}

function validateWindowsPackageSecurity(packageRoot) {
  if (process.platform !== 'win32') return;
  const checker = path.join(__dirname, 'windows-package-identity.ps1');
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (typeof systemRoot !== 'string' || !path.isAbsolute(systemRoot)) {
    throw mismatch('server Fleet Windows security helper is unavailable');
  }
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', checker], {
      input: JSON.stringify({ path: packageRoot }), encoding: 'utf8', windowsHide: true,
      timeout: 30000, maxBuffer: 1024 * 1024
    }).trim();
    if (output !== '{"ok":true}') throw mismatch('server Fleet Windows ownership or ACL is unsupported');
  } catch {
    throw mismatch('server Fleet Windows ownership or ACL is unsupported');
  }
}

function releaseIdentity(runtime) {
  const runtimeRoot = physicalDirectory(runtime);
  const candidates = [path.join(runtimeRoot, 'release.json'), path.join(runtimeRoot, '..', 'release.json')];
  const records = candidates.map(file => readRegularFile(file, MAX_RELEASE_BYTES, { absent: true }));
  const present = records.filter(Boolean);
  if (!present.length) throw mismatch('server Fleet release identity unavailable');
  if (present.length === 2 && !present[0].bytes.equals(present[1].bytes)) {
    throw mismatch('server Fleet release identity is ambiguous');
  }
  // A package-level manifest is authoritative when both identical copies are
  // present; this keeps all listed paths rooted at the package, not runtime/.
  const record = records[1] || records[0];
  const packageRoot = physicalDirectory(path.dirname(record.file));
  validateWindowsPackageSecurity(packageRoot);
  const release = decodeStrict(record.bytes);
  const match = plainRecord(release) && typeof release.name === 'string'
    ? /^fleetV([2345])$/.exec(release.name) : null;
  const generation = match ? Number(match[1]) : null;
  if (!generation || typeof release.version !== 'string' || release.version.length > 128
      || !VERSION.test(release.version) || !Array.isArray(release.files)
      || release.files.length < 1 || release.files.length > MAX_PACKAGE_FILES) {
    throw mismatch('server Fleet release identity is invalid');
  }
  const declared = new Map();
  let total = 0;
  for (const item of release.files) {
    if (!exactKeys(item, ['path', 'size', 'sha256']) || !relativeReleasePath(item.path)
        || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_PACKAGE_BYTES
        || typeof item.sha256 !== 'string' || !HEX256.test(item.sha256)
        || declared.has(item.path)) throw mismatch('server Fleet release file list is invalid');
    total += item.size;
    if (!Number.isSafeInteger(total) || total > MAX_PACKAGE_BYTES) throw mismatch('server Fleet package exceeds its bound');
    declared.set(item.path, item);
  }
  const ignored = new Set(present.map(item => path.resolve(item.file)));
  const actual = packageFiles(packageRoot, ignored);
  const expected = [...declared.keys()].sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw mismatch('server Fleet package file set differs from its release identity');
  }
  for (const [relative, item] of declared) {
    const file = readRegularFile(path.join(packageRoot, ...relative.split('/')), item.size);
    if (file.bytes.length !== item.size
        || crypto.createHash('sha256').update(file.bytes).digest('hex') !== item.sha256) {
      throw mismatch('server Fleet package content differs from its release identity');
    }
  }
  if (path.resolve(packageRoot, 'runtime') !== runtimeRoot && packageRoot !== runtimeRoot) {
    throw mismatch('server Fleet release identity belongs to another runtime');
  }
  return Object.freeze({ runtimeRoot, packageRoot, generation, fleetVersion: release.version,
    fleetIdentitySha256: crypto.createHash('sha256').update(record.bytes).digest('hex') });
}

function pairFromSelectedConfig(config) {
  try {
    const identity = releaseIdentity(config.runtime);
    const moduleFile = path.join(identity.runtimeRoot, 'src', 'lib', 'fleet-hub.js');
    readRegularFile(moduleFile, 4 * 1024 * 1024);
    const fleet = require(moduleFile);
    const hub = fleet.readHub(fleet.treeFolderOf(config.stateRoot, config.treeKey));
    if (!plainRecord(hub) || typeof hub.entry !== 'string' || !path.isAbsolute(hub.entry)
        || /[\0\r\n]/.test(hub.entry)) throw mismatch('selected Hub is absent');
    const entry = readRegularFile(hub.entry, 16 * 1024 * 1024);
    if (path.resolve(path.dirname(entry.file), '..') !== identity.runtimeRoot) {
      throw mismatch('selected Hub uses another runtime');
    }
    return Object.freeze({
      adapterId: adapter.adapterId,
      adapterSchema: adapter.adapterSchema,
      generation: identity.generation,
      fleetVersion: identity.fleetVersion,
      fleetIdentitySha256: identity.fleetIdentitySha256,
      hubVersion: adapter.hubVersion,
      capabilities: Object.freeze([...adapter.capabilities])
    });
  } catch (error) {
    if (error && error.code === 'HUB_FLEET_PAIR_MISMATCH') throw error;
    throw mismatch('server Fleet release identity or selected Hub is unreadable');
  }
}

function selectedPair(configFile, machine, request, attachText) {
  const bridge = require('./hub-lead-bridge.cjs');
  const selected = bridge.selectRoute(bridge.loadConfig(configFile), machine, attachText(request));
  return pairFromSelectedConfig(selected);
}

function assertClaim(actual, claim) {
  if (!exactKeys(claim, CLAIM_KEYS)) throw mismatch('complete compatibility claim required');
  for (const key of CLAIM_KEYS) {
    if (key === 'capabilities') continue;
    if (actual[key] !== claim[key]) throw mismatch(key);
  }
  if (!Array.isArray(claim.capabilities) || claim.capabilities.length !== actual.capabilities.length
      || claim.capabilities.some((value, index) => value !== actual.capabilities[index])) {
    throw mismatch('adapter capabilities');
  }
  return actual;
}

function parseClaimText(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 4096) {
    throw mismatch('bridge compatibility claim invalid');
  }
  let claim;
  try { claim = parseStrictJson(text, 'HUB_FLEET_PAIR_MISMATCH'); }
  catch { throw mismatch('bridge compatibility claim invalid'); }
  if (!exactKeys(claim, CLAIM_KEYS)) throw mismatch('bridge compatibility claim invalid');
  return claim;
}

function selectors(url) {
  if (!url || typeof url.search !== 'string' || Buffer.byteLength(url.search, 'utf8') > 1024) {
    throw Object.assign(new Error('Compatibility selectors are invalid.'), { code: 'STREAM_REQUEST_INVALID' });
  }
  const request = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (!SELECTOR_KEYS.has(key) || Object.hasOwn(request, key)) {
      throw Object.assign(new Error('Compatibility requires actor and optional tag and level only.'), { code: 'STREAM_REQUEST_INVALID' });
    }
    if (key === 'level') {
      if (!/^[1-4]$/.test(value)) throw Object.assign(new Error('Compatibility level is invalid.'), { code: 'STREAM_REQUEST_INVALID' });
      request.level = Number(value);
    } else request[key] = value;
  }
  return request;
}

module.exports = { adapter, selectors, selectedPair, pairFromSelectedConfig, assertClaim,
  parseClaimText, releaseIdentity, mismatch };
