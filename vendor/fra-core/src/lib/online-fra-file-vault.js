'use strict';

// A NODE-ONLY FILE VAULT ADAPTER for small standalone FRA hosts.
//
// The desktop product uses the operating-system credential vault. A headless
// host may instead opt into this adapter: one owner-only directory, one 0600
// JSON file, cross-process serialization, atomic first-use selection and
// atomic replacement. It protects against other operating-system accounts,
// filesystem link substitution, torn writes and concurrent lost updates. It
// is not disk encryption and must not be represented as such.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');

const DEVICE_CREDENTIAL_VAULT_KEY = 'custom.online_fra_device_credential_v1';
const MAX_VAULT_BYTES = 1024 * 1024;
const MAX_SECRET_BYTES = 256 * 1024;
const MAX_VAULT_KEYS = 64;
const MAX_LOCK_BYTES = 4096;
const DEFAULT_LOCK_WAIT_MS = 5000;
const DEFAULT_LOCK_STALE_MS = 30000;
const KEY = /^[a-z][a-z0-9._-]{0,127}$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const CLOEXEC = fs.constants.O_CLOEXEC || 0;
const WAIT_WORD = new Int32Array(new SharedArrayBuffer(4));
const UTF8 = new TextDecoder('utf-8', { fatal: true });

class OnlineFraFileVaultError extends Error {
  constructor(code, message) { super(message || code); this.name = 'OnlineFraFileVaultError'; this.code = code; }
}

function fail(code, message) { throw new OnlineFraFileVaultError(code, message); }
function sameFile(a, b) { return a && b && a.dev === b.dev && a.ino === b.ino; }
function canonical(value) { const resolved = path.resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; }

function validateDirectoryStat(stat) {
  if (!stat || !stat.isDirectory()) fail('FILE_VAULT_PATH_UNSAFE', 'The FRA vault directory is not an ordinary directory.');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    fail('FILE_VAULT_PATH_UNSAFE', 'The FRA vault directory is not owned by this operating-system account.');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700) {
    fail('FILE_VAULT_PATH_UNSAFE', 'The FRA vault directory permissions must be 700.');
  }
}

function validateFileStat(stat, maxBytes, { multipleLinks = false } = {}) {
  if (!stat || !stat.isFile()) fail('FILE_VAULT_PATH_UNSAFE', 'The FRA vault state is not an ordinary file.');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    fail('FILE_VAULT_PATH_UNSAFE', 'The FRA vault state is not owned by this operating-system account.');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) {
    fail('FILE_VAULT_PATH_UNSAFE', 'The FRA vault state permissions must be 600.');
  }
  if ((!multipleLinks && stat.nlink !== 1) || stat.nlink < 1) {
    fail('FILE_VAULT_PATH_UNSAFE', 'The FRA vault state has an unsafe hard-link count.');
  }
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) {
    fail('FILE_VAULT_TOO_LARGE', 'The FRA vault state exceeds its size limit.');
  }
}

function ensureDirectory(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) fail('FILE_VAULT_PATH_UNSAFE', 'The FRA vault path must be absolute.');
  const directory = path.resolve(input);
  const parsed = path.parse(directory);
  let cursor = parsed.root;
  for (const component of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { fs.mkdirSync(cursor, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      stat = fs.lstatSync(cursor);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('FILE_VAULT_PATH_UNSAFE', 'The FRA vault path cannot contain filesystem links.');
  }
  const identity = fs.lstatSync(directory);
  validateDirectoryStat(identity);
  const real = fs.realpathSync.native ? fs.realpathSync.native(directory) : fs.realpathSync(directory);
  if (canonical(real) !== canonical(directory)) fail('FILE_VAULT_PATH_UNSAFE', 'The FRA vault path cannot traverse a filesystem link.');
  if (process.platform === 'win32') {
    const profile = process.env.USERPROFILE;
    if (!profile || (canonical(directory) !== canonical(profile)
        && !canonical(directory).startsWith(`${canonical(profile)}${path.sep}`))) {
      fail('FILE_VAULT_PATH_UNSAFE', 'On Windows, the file vault must stay inside the current user profile.');
    }
  }
  return { directory, identity };
}

function validateDirectory(directory, identity) {
  const current = fs.lstatSync(directory);
  validateDirectoryStat(current);
  if (!sameFile(current, identity)) fail('FILE_VAULT_PATH_UNSAFE', 'The FRA vault directory changed while it was in use.');
}

function readFile(file, maxBytes, { absent = false, multipleLinks = false } = {}) {
  let before;
  try { before = fs.lstatSync(file); }
  catch (error) { if (absent && error.code === 'ENOENT') return null; throw error; }
  if (before.isSymbolicLink()) fail('FILE_VAULT_PATH_UNSAFE', 'The FRA vault state cannot be a symbolic link.');
  validateFileStat(before, maxBytes, { multipleLinks });
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | CLOEXEC);
    const held = fs.fstatSync(descriptor);
    validateFileStat(held, maxBytes, { multipleLinks });
    if (!sameFile(before, held)) fail('FILE_VAULT_PATH_UNSAFE', 'The FRA vault state changed while it was opened.');
    const chunks = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) fail('FILE_VAULT_TOO_LARGE', 'The FRA vault state exceeds its size limit.');
      chunks.push(chunk.subarray(0, count));
    }
    const after = fs.fstatSync(descriptor);
    validateFileStat(after, maxBytes, { multipleLinks });
    if (!sameFile(held, after) || after.size !== total) fail('FILE_VAULT_PATH_UNSAFE', 'The FRA vault state changed while it was read.');
    return Buffer.concat(chunks, total);
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function validKey(key) {
  if (typeof key !== 'string' || !KEY.test(key)) fail('FILE_VAULT_KEY_INVALID', 'The FRA vault key is invalid.');
}

function validSecret(secret) {
  let scalar = typeof secret === 'string';
  for (let index = 0; scalar && index < secret.length; index += 1) {
    const unit = secret.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = secret.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) scalar = false;
      else index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) scalar = false;
  }
  if (!scalar || Buffer.byteLength(secret, 'utf8') > MAX_SECRET_BYTES) {
    fail('FILE_VAULT_SECRET_INVALID', 'The FRA vault value must be a bounded Unicode scalar string.');
  }
}

function decodeUtf8(bytes, code = 'FILE_VAULT_INVALID') {
  try { return UTF8.decode(bytes); }
  catch { fail(code, 'The FRA vault state is not valid UTF-8.'); }
}

function parseRecord(source) {
  let at = 0;
  const whitespace = () => { while (/[ \t\r\n]/.test(source[at] || '')) at += 1; };
  const string = () => {
    if (source[at] !== '"') fail('FILE_VAULT_INVALID', 'The FRA vault contains a non-string field.');
    const start = at++;
    for (;;) {
      if (at >= source.length) fail('FILE_VAULT_INVALID', 'The FRA vault contains an unfinished string.');
      if (source.charCodeAt(at) < 0x20) fail('FILE_VAULT_INVALID', 'The FRA vault contains a control character.');
      if (source[at] === '"') {
        at += 1;
        try { return JSON.parse(source.slice(start, at)); }
        catch { fail('FILE_VAULT_INVALID', 'The FRA vault contains an invalid string.'); }
      }
      if (source[at] === '\\') {
        at += 1;
        if (at >= source.length || !/["\\/bfnrtu]/.test(source[at])) fail('FILE_VAULT_INVALID', 'The FRA vault contains an invalid escape.');
        if (source[at] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(at + 1, at + 5))) fail('FILE_VAULT_INVALID', 'The FRA vault contains an invalid Unicode escape.');
          at += 4;
        }
      }
      at += 1;
    }
  };
  whitespace();
  if (source[at++] !== '{') fail('FILE_VAULT_INVALID', 'The FRA vault must be one object.');
  const result = Object.create(null);
  const seen = new Set();
  whitespace();
  if (source[at] === '}') at += 1;
  else for (;;) {
    const key = string();
    if (seen.has(key)) fail('FILE_VAULT_INVALID', 'The FRA vault contains a duplicate key.');
    seen.add(key);
    if (seen.size > MAX_VAULT_KEYS) fail('FILE_VAULT_INVALID', 'The FRA vault contains too many keys.');
    validKey(key);
    whitespace();
    if (source[at++] !== ':') fail('FILE_VAULT_INVALID', 'The FRA vault field is missing its separator.');
    whitespace();
    const value = string();
    validSecret(value);
    result[key] = value;
    whitespace();
    if (source[at] === '}') { at += 1; break; }
    if (source[at++] !== ',') fail('FILE_VAULT_INVALID', 'The FRA vault fields are not separated correctly.');
    whitespace();
  }
  whitespace();
  if (at !== source.length) fail('FILE_VAULT_INVALID', 'The FRA vault contains trailing data.');
  return result;
}

function decodeVault(bytes) { return bytes === null ? Object.create(null) : parseRecord(decodeUtf8(bytes)); }
function encodeVault(value) {
  const ordered = Object.create(null);
  const keys = Object.keys(value).sort();
  if (keys.length > MAX_VAULT_KEYS) fail('FILE_VAULT_INVALID', 'The FRA vault contains too many keys.');
  for (const key of keys) { validKey(key); validSecret(value[key]); ordered[key] = value[key]; }
  const bytes = Buffer.from(`${JSON.stringify(ordered)}\n`, 'utf8');
  if (bytes.length > MAX_VAULT_BYTES) fail('FILE_VAULT_TOO_LARGE', 'The FRA vault exceeds its size limit.');
  return bytes;
}

function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  let descriptor;
  try { descriptor = fs.openSync(directory, fs.constants.O_RDONLY | CLOEXEC); fs.fsyncSync(descriptor); }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function atomicWrite(file, bytes, directory, directoryIdentity) {
  validateDirectory(directory, directoryIdentity);
  const temporary = path.join(directory, `.fra-vault-${process.pid}-${crypto.randomBytes(16).toString('hex')}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW | CLOEXEC, 0o600);
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    syncDirectory(directory);
    validateFileStat(fs.lstatSync(file), MAX_VAULT_BYTES);
    validateDirectory(directory, directoryIdentity);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function reapStaleLock(lock, staleMs, directory, directoryIdentity) {
  const claim = path.join(directory, `.fra-vault-reap-${process.pid}-${crypto.randomBytes(16).toString('hex')}.tmp`);
  try {
    fs.linkSync(lock, claim);
    const held = fs.lstatSync(claim);
    const current = fs.lstatSync(lock);
    if (!sameFile(held, current)) return false;
    const text = decodeUtf8(readFile(claim, MAX_LOCK_BYTES, { multipleLinks: true }), 'FILE_VAULT_LOCK_INVALID');
    let record;
    try { record = JSON.parse(text); } catch { return false; }
    if (!record || Object.keys(record).sort().join(',') !== 'createdAtMs,nonce,pid'
        || text !== `${JSON.stringify(record)}\n`
        || !Number.isSafeInteger(record.createdAtMs) || record.createdAtMs < 1
        || typeof record.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(record.nonce)
        || !Number.isSafeInteger(record.pid) || record.pid < 1
        || Date.now() - record.createdAtMs < staleMs || processAlive(record.pid)) return false;
    validateDirectory(directory, directoryIdentity);
    if (!sameFile(held, fs.lstatSync(lock))) return false;
    fs.unlinkSync(lock);
    syncDirectory(directory);
    return true;
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'EPERM', 'EACCES', 'EMLINK', 'ENOTSUP'].includes(error.code)) return false;
    throw error;
  } finally {
    try { fs.unlinkSync(claim); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function acquireLock(lock, options, directory, directoryIdentity) {
  const deadline = Date.now() + options.lockWaitMs;
  for (;;) {
    validateDirectory(directory, directoryIdentity);
    let descriptor;
    try {
      descriptor = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW | CLOEXEC, 0o600);
      if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, Buffer.from(`${JSON.stringify({ pid: process.pid, createdAtMs: Date.now(), nonce: crypto.randomBytes(16).toString('hex') })}\n`));
      fs.fsyncSync(descriptor);
      const identity = fs.fstatSync(descriptor);
      syncDirectory(directory);
      return { descriptor, identity };
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* preserve original */ }
        try { fs.unlinkSync(lock); } catch { /* preserve original */ }
      }
      if (error.code !== 'EEXIST') throw error;
      if (reapStaleLock(lock, options.lockStaleMs, directory, directoryIdentity)) continue;
      if (Date.now() >= deadline) fail('FILE_VAULT_LOCK_BUSY', 'The FRA vault is busy in another local process.');
      Atomics.wait(WAIT_WORD, 0, 0, Math.min(10, Math.max(1, deadline - Date.now())));
    }
  }
}

function releaseLock(lock, held, directory, directoryIdentity) {
  let failure = null;
  try { fs.closeSync(held.descriptor); } catch (error) { failure = error; }
  try {
    const current = fs.lstatSync(lock);
    if (!sameFile(current, held.identity)) fail('FILE_VAULT_LOCK_LOST', 'The FRA vault lock changed during the operation.');
    fs.unlinkSync(lock);
    syncDirectory(directory);
    validateDirectory(directory, directoryIdentity);
  } catch (error) { failure ||= error; }
  if (failure) throw failure;
}

function createFileVault(file, { lockWaitMs = DEFAULT_LOCK_WAIT_MS, lockStaleMs = DEFAULT_LOCK_STALE_MS } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.basename(file) !== 'vault.json') {
    fail('FILE_VAULT_PATH_UNSAFE', 'The FRA file vault must be an absolute path ending in vault.json.');
  }
  if (!Number.isSafeInteger(lockWaitMs) || lockWaitMs < 1 || lockWaitMs > 60000
      || !Number.isSafeInteger(lockStaleMs) || lockStaleMs < 1 || lockStaleMs > 3600000) {
    fail('FILE_VAULT_OPTIONS_INVALID', 'The FRA vault lock deadlines are invalid.');
  }
  const resolved = path.resolve(file);
  const { directory, identity: directoryIdentity } = ensureDirectory(path.dirname(resolved));
  const lock = path.join(directory, '.vault.lock');
  const options = { lockWaitMs, lockStaleMs };
  const transaction = operation => {
    const held = acquireLock(lock, options, directory, directoryIdentity);
    let result;
    let failure = null;
    try { result = operation(); } catch (error) { failure = error; }
    try { releaseLock(lock, held, directory, directoryIdentity); } catch (error) { failure ||= error; }
    if (failure) throw failure;
    return result;
  };
  const read = () => decodeVault(readFile(resolved, MAX_VAULT_BYTES, { absent: true }));
  const write = value => atomicWrite(resolved, encodeVault(value), directory, directoryIdentity);
  return Object.freeze({
    getSecret(key) {
      validKey(key);
      return transaction(() => {
        const value = read();
        if (!Object.hasOwn(value, key)) throw Object.assign(new Error('not configured'), { code: 'SECRET_NOT_CONFIGURED' });
        return value[key];
      });
    },
    setSecret(key, secret) {
      validKey(key); validSecret(secret);
      return transaction(() => { const value = read(); value[key] = secret; write(value); });
    },
    getOrCreateSecret(key, candidate) {
      validKey(key); validSecret(candidate);
      return transaction(() => {
        const value = read();
        if (Object.hasOwn(value, key)) return value[key];
        value[key] = candidate;
        write(value);
        return candidate;
      });
    },
    clearDeviceCredential() {
      return transaction(() => {
        const value = read();
        if (!Object.hasOwn(value, DEVICE_CREDENTIAL_VAULT_KEY)) return { key: DEVICE_CREDENTIAL_VAULT_KEY, status: 'absent' };
        delete value[DEVICE_CREDENTIAL_VAULT_KEY];
        write(value);
        return { key: DEVICE_CREDENTIAL_VAULT_KEY, status: 'cleared' };
      });
    }
  });
}

module.exports = Object.freeze({ createFileVault, OnlineFraFileVaultError, DEVICE_CREDENTIAL_VAULT_KEY });
