'use strict';

// FRA DEVICE (runs on each machine and on the Vultr gateway). Enrols this
// computer on the private FRA account with fra-core's own claim client.
//   node fra-device.cjs open   --state DIR --fra-core DIR --account URL [--origin URL] --name NAME
//        prints {"code": <short-lived claim code>} for the enrolling operator only
//   node fra-device.cjs wait   --state DIR --fra-core DIR --account URL [--origin URL] [--timeout-seconds N]
//        polls without deciding; prints the reserving account as JSON
//   node fra-device.cjs accept --state DIR --fra-core DIR --account URL [--origin URL] --expect-email EMAIL
//        prints {"state": "connected", "pairId": <this device's pair id>}
//   node fra-device.cjs decline --state DIR --fra-core DIR --account URL [--origin URL]
//        rejects/cancels the server claim and removes the matching local claim
//   node fra-device.cjs status --state DIR --fra-core DIR
//        prints {"enrolled": bool, "pairId": ...}
//   node fra-device.cjs use-fra --lead-config FILE --state DIR --fra-core DIR --account URL [--origin URL] --relay-pair ID
//   node fra-device.cjs use-ssh-only --lead-config FILE --state DIR --fra-core DIR
//   node fra-device.cjs forget --state DIR --fra-core DIR
//        removes a revoked local credential and any unfinished claim
//   node fra-device.cjs pending|abandon --state DIR --fra-core DIR
//        inspects or removes only an unfinished local claim
// The identity key and device credential stay in DIR/vault.json (0600; on
// Windows the per-user profile folder). Nothing secret is printed.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');

const DEVICE_CREDENTIAL_VAULT_KEY = 'custom.online_fra_device_credential_v1';
const MAX_VAULT_BYTES = 1024 * 1024;
const MAX_SECRET_BYTES = 256 * 1024;
const MAX_VAULT_KEYS = 64;
const MAX_LOCK_BYTES = 4096;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_CLAIM_BYTES = 4096;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_VALUES = 4096;
const DEFAULT_LOCK_WAIT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const VAULT_KEY = /^[a-z][a-z0-9._-]{0,127}$/;
const WAIT_WORD = new Int32Array(new SharedArrayBuffer(4));
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const CLOEXEC = fs.constants.O_CLOEXEC || 0;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function vaultFailure(code, message) {
  return Object.assign(new Error(message), { code });
}

function sameFile(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

function privateOwner(stat, kind) {
  if (!stat || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
    throw vaultFailure('FRA_VAULT_PATH_UNSAFE', `The FRA ${kind} is not an ordinary ${kind}.`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw vaultFailure('FRA_VAULT_PATH_UNSAFE', `The FRA ${kind} is not owned by this operating-system account.`);
  }
  if (process.platform !== 'win32') {
    const expected = kind === 'directory' ? 0o700 : 0o600;
    if ((stat.mode & 0o777) !== expected) {
      throw vaultFailure('FRA_VAULT_PATH_UNSAFE', `The FRA ${kind} permissions must be ${expected.toString(8)}.`);
    }
  }
  if (kind === 'file' && stat.nlink !== 1) {
    throw vaultFailure('FRA_VAULT_PATH_UNSAFE', 'The FRA vault file must have exactly one filesystem name.');
  }
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function ensurePrivateDirectory(input, { create = true } = {}) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) {
    throw vaultFailure('FRA_VAULT_PATH_UNSAFE', 'The FRA state directory must be an absolute path.');
  }
  const directory = path.resolve(input);
  const parsed = path.parse(directory);
  let cursor = parsed.root;
  const remainder = directory.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const component of remainder) {
    cursor = path.join(cursor, component);
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      try { fs.mkdirSync(cursor, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      stat = fs.lstatSync(cursor);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw vaultFailure('FRA_VAULT_PATH_UNSAFE', 'The FRA state path cannot contain links or non-directories.');
    }
  }
  const stat = fs.lstatSync(directory);
  privateOwner(stat, 'directory');
  const real = fs.realpathSync.native ? fs.realpathSync.native(directory) : fs.realpathSync(directory);
  if (canonicalPath(real) !== canonicalPath(directory)) {
    throw vaultFailure('FRA_VAULT_PATH_UNSAFE', 'The FRA state path must not traverse a filesystem link.');
  }
  if (process.platform === 'win32') {
    const profile = process.env.USERPROFILE;
    if (!profile || (canonicalPath(directory) !== canonicalPath(profile)
        && !canonicalPath(directory).startsWith(`${canonicalPath(profile)}${path.sep}`))) {
      throw vaultFailure('FRA_VAULT_PATH_UNSAFE', 'On Windows, FRA state must stay inside the current user profile.');
    }
  }
  return { directory, identity: stat };
}

function validateDirectory(directory, identity) {
  const current = fs.lstatSync(directory);
  privateOwner(current, 'directory');
  if (!sameFile(current, identity)) {
    throw vaultFailure('FRA_VAULT_PATH_UNSAFE', 'The FRA state directory changed while it was in use.');
  }
}

function validateFileStat(stat, maxBytes, { allowMultipleLinks = false } = {}) {
  if (!stat || !stat.isFile()) throw vaultFailure('FRA_VAULT_PATH_UNSAFE', 'The FRA state file is not an ordinary file.');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw vaultFailure('FRA_VAULT_PATH_UNSAFE', 'The FRA state file is not owned by this operating-system account.');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) {
    throw vaultFailure('FRA_VAULT_PATH_UNSAFE', 'The FRA state file permissions must be 600.');
  }
  if ((!allowMultipleLinks && stat.nlink !== 1) || stat.nlink < 1) {
    throw vaultFailure('FRA_VAULT_PATH_UNSAFE', 'The FRA state file has an unsafe hard-link count.');
  }
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) {
    throw vaultFailure('FRA_VAULT_TOO_LARGE', 'The FRA state file exceeds its size limit.');
  }
}

function readBoundedFileRecord(file, maxBytes, { absent = false, allowMultipleLinks = false } = {}) {
  let before;
  try { before = fs.lstatSync(file); }
  catch (error) {
    if (absent && error.code === 'ENOENT') return null;
    throw error;
  }
  if (before.isSymbolicLink()) throw vaultFailure('FRA_VAULT_PATH_UNSAFE', 'The FRA state file cannot be a symbolic link.');
  validateFileStat(before, maxBytes, { allowMultipleLinks });
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | CLOEXEC);
    const held = fs.fstatSync(descriptor);
    validateFileStat(held, maxBytes, { allowMultipleLinks });
    if (!sameFile(before, held)) throw vaultFailure('FRA_VAULT_PATH_UNSAFE', 'The FRA state file changed while it was opened.');
    const chunks = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) throw vaultFailure('FRA_VAULT_TOO_LARGE', 'The FRA state file exceeds its size limit.');
      chunks.push(chunk.subarray(0, count));
    }
    const after = fs.fstatSync(descriptor);
    validateFileStat(after, maxBytes, { allowMultipleLinks });
    if (!sameFile(held, after) || after.size !== total) {
      throw vaultFailure('FRA_VAULT_PATH_UNSAFE', 'The FRA state file changed while it was read.');
    }
    return { bytes: Buffer.concat(chunks, total), identity: after };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readBoundedFile(file, maxBytes, options) {
  const record = readBoundedFileRecord(file, maxBytes, options);
  return record === null ? null : record.bytes;
}

function validKey(key) {
  if (typeof key !== 'string' || !VAULT_KEY.test(key)) {
    throw vaultFailure('FRA_VAULT_KEY_INVALID', 'The FRA vault key is invalid.');
  }
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
    throw vaultFailure('FRA_VAULT_SECRET_INVALID', 'The FRA vault value must be a bounded string.');
  }
}

function decodeUtf8(bytes, code = 'FRA_VAULT_INVALID') {
  try { return UTF8.decode(bytes); }
  catch { throw vaultFailure(code, 'The FRA state file is not valid UTF-8.'); }
}

function scalarString(value) {
  if (typeof value !== 'string') return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

// JSON.parse silently accepts duplicate object keys and unpaired UTF-16
// surrogates. State files are authority, so parse the small JSON grammar
// directly and reject both, as well as pathological depth/value counts and
// numbers JavaScript cannot represent exactly.
function parseStrictJson(source, code = 'FRA_STATE_INVALID') {
  let at = 0;
  let values = 0;
  const fail = message => { throw vaultFailure(code, message); };
  const whitespace = () => { while (/[ \t\r\n]/.test(source[at] || '')) at += 1; };
  const string = () => {
    if (source[at] !== '"') fail('The FRA state contains a non-string key or value.');
    const start = at++;
    for (;;) {
      if (at >= source.length) fail('The FRA state contains an unfinished string.');
      const unit = source.charCodeAt(at);
      if (unit < 0x20) fail('The FRA state contains an unescaped control character.');
      if (source[at] === '"') {
        at += 1;
        let value;
        try { value = JSON.parse(source.slice(start, at)); }
        catch { fail('The FRA state contains an invalid string.'); }
        if (!scalarString(value)) fail('The FRA state contains an invalid Unicode scalar string.');
        return value;
      }
      if (source[at] === '\\') {
        at += 1;
        if (at >= source.length || !/["\\/bfnrtu]/.test(source[at])) fail('The FRA state contains an invalid escape.');
        if (source[at] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(at + 1, at + 5))) fail('The FRA state contains an invalid Unicode escape.');
          at += 4;
        }
      }
      at += 1;
    }
  };
  const value = depth => {
    values += 1;
    if (values > MAX_JSON_VALUES) fail('The FRA state contains too many values.');
    if (depth > MAX_JSON_DEPTH) fail('The FRA state is nested too deeply.');
    whitespace();
    if (source[at] === '"') return string();
    if (source[at] === '{') {
      at += 1;
      const result = Object.create(null);
      const seen = new Set();
      whitespace();
      if (source[at] === '}') { at += 1; return result; }
      for (;;) {
        const key = string();
        if (seen.has(key)) fail('The FRA state contains a duplicate object key.');
        if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('The FRA state contains a forbidden object key.');
        seen.add(key);
        whitespace();
        if (source[at++] !== ':') fail('The FRA state object is missing a separator.');
        result[key] = value(depth + 1);
        whitespace();
        if (source[at] === '}') { at += 1; return result; }
        if (source[at++] !== ',') fail('The FRA state object fields are not separated correctly.');
        whitespace();
      }
    }
    if (source[at] === '[') {
      at += 1;
      const result = [];
      whitespace();
      if (source[at] === ']') { at += 1; return result; }
      for (;;) {
        result.push(value(depth + 1));
        whitespace();
        if (source[at] === ']') { at += 1; return result; }
        if (source[at++] !== ',') fail('The FRA state array values are not separated correctly.');
        whitespace();
      }
    }
    for (const [token, parsed] of [['true', true], ['false', false], ['null', null]]) {
      if (source.startsWith(token, at)) { at += token.length; return parsed; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(at));
    if (!match) fail('The FRA state contains an invalid JSON value.');
    at += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) {
      fail('The FRA state contains a number that cannot be represented safely.');
    }
    return number;
  };
  whitespace();
  const parsed = value(0);
  whitespace();
  if (at !== source.length) fail('The FRA state contains trailing data.');
  return parsed;
}

// The vault format is intentionally only one JSON object of string values.
// Parsing that small grammar here lets us reject duplicate keys, which
// JSON.parse otherwise silently resolves by keeping an attacker's last value.
function parseFlatStringRecord(source) {
  let at = 0;
  const whitespace = () => { while (/[ \t\r\n]/.test(source[at] || '')) at += 1; };
  const string = () => {
    if (source[at] !== '"') throw vaultFailure('FRA_VAULT_INVALID', 'The FRA vault contains a non-string field.');
    const start = at++;
    for (;;) {
      if (at >= source.length) throw vaultFailure('FRA_VAULT_INVALID', 'The FRA vault contains an unfinished string.');
      const codePoint = source.charCodeAt(at);
      if (codePoint < 0x20) throw vaultFailure('FRA_VAULT_INVALID', 'The FRA vault contains a control character.');
      if (source[at] === '"') {
        at += 1;
        try { return JSON.parse(source.slice(start, at)); }
        catch { throw vaultFailure('FRA_VAULT_INVALID', 'The FRA vault contains an invalid string.'); }
      }
      if (source[at] === '\\') {
        at += 1;
        if (at >= source.length || !/["\\/bfnrtu]/.test(source[at])) {
          throw vaultFailure('FRA_VAULT_INVALID', 'The FRA vault contains an invalid escape.');
        }
        if (source[at] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(at + 1, at + 5))) {
            throw vaultFailure('FRA_VAULT_INVALID', 'The FRA vault contains an invalid Unicode escape.');
          }
          at += 4;
        }
      }
      at += 1;
    }
  };
  whitespace();
  if (source[at++] !== '{') throw vaultFailure('FRA_VAULT_INVALID', 'The FRA vault must be one object.');
  const result = Object.create(null);
  const seen = new Set();
  whitespace();
  if (source[at] === '}') at += 1;
  else for (;;) {
    const key = string();
    if (seen.has(key)) throw vaultFailure('FRA_VAULT_INVALID', 'The FRA vault contains a duplicate key.');
    seen.add(key);
    if (seen.size > MAX_VAULT_KEYS) throw vaultFailure('FRA_VAULT_INVALID', 'The FRA vault contains too many keys.');
    validKey(key);
    whitespace();
    if (source[at++] !== ':') throw vaultFailure('FRA_VAULT_INVALID', 'The FRA vault field is missing its separator.');
    whitespace();
    const value = string();
    validSecret(value);
    result[key] = value;
    whitespace();
    if (source[at] === '}') { at += 1; break; }
    if (source[at++] !== ',') throw vaultFailure('FRA_VAULT_INVALID', 'The FRA vault fields are not separated correctly.');
    whitespace();
  }
  whitespace();
  if (at !== source.length) throw vaultFailure('FRA_VAULT_INVALID', 'The FRA vault contains trailing data.');
  return result;
}

function decodeVault(bytes) {
  if (bytes === null) return Object.create(null);
  return parseFlatStringRecord(decodeUtf8(bytes));
}

function encodeVault(value) {
  const ordered = Object.create(null);
  const keys = Object.keys(value).sort();
  if (keys.length > MAX_VAULT_KEYS) throw vaultFailure('FRA_VAULT_INVALID', 'The FRA vault contains too many keys.');
  for (const key of keys) { validKey(key); validSecret(value[key]); ordered[key] = value[key]; }
  const bytes = Buffer.from(`${JSON.stringify(ordered)}\n`, 'utf8');
  if (bytes.length > MAX_VAULT_BYTES) throw vaultFailure('FRA_VAULT_TOO_LARGE', 'The FRA vault exceeds its size limit.');
  return bytes;
}

function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  let descriptor;
  try { descriptor = fs.openSync(directory, fs.constants.O_RDONLY | CLOEXEC); fs.fsyncSync(descriptor); }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function atomicWrite(file, bytes, directory, directoryIdentity, prefix = '.fra-state') {
  validateDirectory(directory, directoryIdentity);
  const temp = path.join(directory, `${prefix}-${process.pid}-${crypto.randomBytes(16).toString('hex')}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW | CLOEXEC, 0o600);
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temp, file);
    syncDirectory(directory);
    const written = fs.lstatSync(file);
    privateOwner(written, 'file');
    validateDirectory(directory, directoryIdentity);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function atomicCreate(file, bytes, directory, directoryIdentity, prefix = '.fra-state-create') {
  validateDirectory(directory, directoryIdentity);
  const temp = path.join(directory, `${prefix}-${process.pid}-${crypto.randomBytes(16).toString('hex')}.tmp`);
  let descriptor;
  let linked = false;
  try {
    descriptor = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW | CLOEXEC, 0o600);
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    validateDirectory(directory, directoryIdentity);
    try { fs.linkSync(temp, file); }
    catch (error) {
      if (error.code === 'EEXIST') throw vaultFailure('FRA_STATE_EXISTS', 'The FRA state file already exists.');
      throw error;
    }
    linked = true;
    fs.unlinkSync(temp);
    linked = false;
    syncDirectory(directory);
    const written = fs.lstatSync(file);
    privateOwner(written, 'file');
    validateDirectory(directory, directoryIdentity);
    return written;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (!linked) {
      try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

function privateFileContext(input, { createDirectory = false } = {}) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) {
    throw vaultFailure('FRA_STATE_PATH_UNSAFE', 'The FRA state file path must be absolute.');
  }
  const file = path.resolve(input);
  if (canonicalPath(file) !== canonicalPath(path.normalize(input)) || path.basename(file) === '') {
    throw vaultFailure('FRA_STATE_PATH_UNSAFE', 'The FRA state file path must be canonical.');
  }
  const { directory, identity } = ensurePrivateDirectory(path.dirname(file), { create: createDirectory });
  return { file, directory, directoryIdentity: identity };
}

function decodePrivateJson(record, code = 'FRA_STATE_INVALID') {
  return parseStrictJson(decodeUtf8(record.bytes, code), code);
}

function readPrivateJsonRecord(file, maxBytes = MAX_CONFIG_BYTES, { absent = false } = {}) {
  const context = privateFileContext(file);
  const record = readBoundedFileRecord(context.file, maxBytes, { absent });
  validateDirectory(context.directory, context.directoryIdentity);
  if (record === null) return { ...context, value: null, identity: null };
  return { ...context, value: decodePrivateJson(record), identity: record.identity };
}

function readPrivateJsonFile(file, maxBytes = MAX_CONFIG_BYTES) {
  return readPrivateJsonRecord(file, maxBytes).value;
}

function readPrivateTextFile(file, maxBytes = MAX_CONFIG_BYTES, code = 'FRA_STATE_INVALID') {
  const context = privateFileContext(file);
  const record = readBoundedFileRecord(context.file, maxBytes);
  validateDirectory(context.directory, context.directoryIdentity);
  return decodeUtf8(record.bytes, code);
}

function validatePrivateFilePath(file, maxBytes = MAX_CONFIG_BYTES) {
  const context = privateFileContext(file);
  readBoundedFileRecord(context.file, maxBytes);
  validateDirectory(context.directory, context.directoryIdentity);
  return context.file;
}

function appendPrivateTextFile(file, text, maxBytes = 16 * 1024 * 1024) {
  if (typeof text !== 'string' || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw vaultFailure('FRA_STATE_INVALID', 'The FRA log append is invalid.');
  }
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > maxBytes) throw vaultFailure('FRA_STATE_TOO_LARGE', 'The FRA log entry exceeds its size limit.');
  const context = privateFileContext(file);
  validateDirectory(context.directory, context.directoryIdentity);
  let before = null;
  try {
    before = fs.lstatSync(context.file);
    if (before.isSymbolicLink()) throw vaultFailure('FRA_STATE_PATH_UNSAFE', 'The FRA log cannot be a symbolic link.');
    validateFileStat(before, maxBytes);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let descriptor;
  try {
    descriptor = fs.openSync(context.file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW | CLOEXEC, 0o600);
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
    const held = fs.fstatSync(descriptor);
    validateFileStat(held, maxBytes);
    if (before && !sameFile(before, held)) throw vaultFailure('FRA_STATE_PATH_UNSAFE', 'The FRA log changed while it was opened.');
    if (held.size + bytes.length > maxBytes) throw vaultFailure('FRA_STATE_TOO_LARGE', 'The FRA log reached its size limit.');
    fs.writeSync(descriptor, bytes);
    const after = fs.fstatSync(descriptor);
    validateFileStat(after, maxBytes);
    if (!sameFile(held, after) || after.size > maxBytes) throw vaultFailure('FRA_STATE_PATH_UNSAFE', 'The FRA log changed during append.');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  validateDirectory(context.directory, context.directoryIdentity);
}

function encodePrivateJson(value, maxBytes = MAX_CONFIG_BYTES) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (bytes.length > maxBytes) throw vaultFailure('FRA_STATE_TOO_LARGE', 'The FRA state exceeds its size limit.');
  return bytes;
}

function stateLockPath(context, purpose) {
  const label = crypto.createHash('sha256').update(`${purpose}\0${context.file}`).digest('hex').slice(0, 24);
  return path.join(context.directory, `.fra-${label}.lock`);
}

async function withPrivateFileLock(context, purpose, operation, options = {}) {
  const lockOptions = {
    lockWaitMs: options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS,
    lockStaleMs: options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS
  };
  if (!Number.isSafeInteger(lockOptions.lockWaitMs) || lockOptions.lockWaitMs < 1 || lockOptions.lockWaitMs > 60_000
      || !Number.isSafeInteger(lockOptions.lockStaleMs) || lockOptions.lockStaleMs < 1 || lockOptions.lockStaleMs > 3_600_000) {
    throw vaultFailure('FRA_STATE_OPTIONS_INVALID', 'The FRA state lock deadlines are invalid.');
  }
  const lock = stateLockPath(context, purpose);
  const held = acquireLock(lock, lockOptions, context.directory, context.directoryIdentity);
  let result;
  let failure = null;
  try { result = await operation(); } catch (error) { failure = error; }
  try { releaseLock(lock, held, context.directory, context.directoryIdentity); }
  catch (error) { failure ||= error; }
  if (failure) throw failure;
  return result;
}

function replacePrivateJson(context, value, maxBytes = MAX_CONFIG_BYTES) {
  // Existing authority files must be safe before replacement. A missing file
  // is not silently created by a routing update.
  readBoundedFile(context.file, maxBytes);
  atomicWrite(context.file, encodePrivateJson(value, maxBytes), context.directory, context.directoryIdentity);
}

function createPrivateJson(context, value, maxBytes = MAX_CONFIG_BYTES) {
  return atomicCreate(context.file, encodePrivateJson(value, maxBytes), context.directory, context.directoryIdentity);
}

function unlinkPrivateFile(context, expectedIdentity, maxBytes = MAX_CONFIG_BYTES) {
  validateDirectory(context.directory, context.directoryIdentity);
  const current = fs.lstatSync(context.file);
  if (current.isSymbolicLink()) throw vaultFailure('FRA_STATE_PATH_UNSAFE', 'The FRA state file cannot be a symbolic link.');
  validateFileStat(current, maxBytes);
  if (!sameFile(current, expectedIdentity)) throw vaultFailure('FRA_STATE_PATH_UNSAFE', 'The FRA state file changed before removal.');
  fs.unlinkSync(context.file);
  syncDirectory(context.directory);
  validateDirectory(context.directory, context.directoryIdentity);
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function staleLockCanBeReaped(lock, staleMs, directory, directoryIdentity) {
  const claim = path.join(directory, `.vault-reap-${process.pid}-${crypto.randomBytes(16).toString('hex')}.tmp`);
  try {
    fs.linkSync(lock, claim);
    const held = fs.lstatSync(claim);
    const current = fs.lstatSync(lock);
    if (!sameFile(held, current)) return false;
    const bytes = readBoundedFile(claim, MAX_LOCK_BYTES, { allowMultipleLinks: true });
    const text = decodeUtf8(bytes, 'FRA_VAULT_LOCK_INVALID');
    let record;
    try { record = JSON.parse(text); } catch { return false; }
    if (!record || Object.keys(record).sort().join(',') !== 'createdAtMs,nonce,pid'
        || text !== `${JSON.stringify(record)}\n`
        || !Number.isSafeInteger(record.createdAtMs) || record.createdAtMs < 1
        || typeof record.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(record.nonce)
        || !Number.isSafeInteger(record.pid) || record.pid < 1
        || Date.now() - record.createdAtMs < staleMs || processAlive(record.pid)) return false;
    validateDirectory(directory, directoryIdentity);
    const beforeUnlink = fs.lstatSync(lock);
    if (!sameFile(held, beforeUnlink)) return false;
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
      const record = Buffer.from(`${JSON.stringify({ pid: process.pid, createdAtMs: Date.now(), nonce: crypto.randomBytes(16).toString('hex') })}\n`);
      fs.writeFileSync(descriptor, record);
      fs.fsyncSync(descriptor);
      const identity = fs.fstatSync(descriptor);
      syncDirectory(directory);
      return { descriptor, identity };
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* retain the original failure */ }
        try { fs.unlinkSync(lock); } catch { /* retain the original failure */ }
      }
      if (error.code !== 'EEXIST') throw error;
      if (staleLockCanBeReaped(lock, options.lockStaleMs, directory, directoryIdentity)) continue;
      if (Date.now() >= deadline) throw vaultFailure('FRA_VAULT_LOCK_BUSY', 'The FRA vault is busy in another local process.');
      Atomics.wait(WAIT_WORD, 0, 0, Math.min(10, Math.max(1, deadline - Date.now())));
    }
  }
}

function releaseLock(lock, held, directory, directoryIdentity) {
  let releaseError = null;
  try { fs.closeSync(held.descriptor); } catch (error) { releaseError = error; }
  try {
    const current = fs.lstatSync(lock);
    if (!sameFile(current, held.identity)) throw vaultFailure('FRA_VAULT_LOCK_LOST', 'The FRA vault lock changed during the operation.');
    fs.unlinkSync(lock);
    syncDirectory(directory);
    validateDirectory(directory, directoryIdentity);
  } catch (error) { releaseError ||= error; }
  if (releaseError) throw releaseError;
}

function option(argv, name, fallback) {
  const token = `--${name}`;
  const positions = argv.flatMap((value, index) => value === token ? [index] : []);
  if (positions.length > 1) throw vaultFailure('FRA_ARGUMENT_INVALID', `${token} may be supplied only once.`);
  if (!positions.length) return fallback;
  const value = argv[positions[0] + 1];
  if (value === undefined || value.startsWith('--')) throw vaultFailure('FRA_ARGUMENT_INVALID', `${token} needs a value.`);
  return value;
}

function booleanFlag(argv, name) {
  const token = `--${name}`;
  const count = argv.filter(value => value === token).length;
  if (count > 1) throw vaultFailure('FRA_ARGUMENT_INVALID', `${token} may be supplied only once.`);
  return count === 1;
}

const CLI_ARGUMENTS = Object.freeze({
  'use-fra': Object.freeze({ values: ['lead-config', 'state', 'fra-core', 'account', 'origin', 'relay-pair'], flags: ['allow-insecure-loopback'] }),
  'use-ssh-only': Object.freeze({ values: ['lead-config', 'state', 'fra-core'], flags: [] }),
  status: Object.freeze({ values: ['state', 'fra-core'], flags: [] }),
  open: Object.freeze({ values: ['state', 'fra-core', 'account', 'origin', 'name'], flags: ['allow-insecure-loopback'] }),
  accept: Object.freeze({ values: ['state', 'fra-core', 'account', 'origin', 'expect-email'], flags: ['allow-insecure-loopback'] }),
  decline: Object.freeze({ values: ['state', 'fra-core', 'account', 'origin'], flags: ['allow-insecure-loopback'] }),
  wait: Object.freeze({ values: ['state', 'fra-core', 'account', 'origin', 'timeout-seconds'], flags: ['allow-insecure-loopback'] }),
  forget: Object.freeze({ values: ['state', 'fra-core'], flags: [] }),
  pending: Object.freeze({ values: ['state', 'fra-core'], flags: [] }),
  abandon: Object.freeze({ values: ['state', 'fra-core'], flags: [] })
});

function validateCliArguments(argv) {
  if (!Array.isArray(argv) || typeof argv[0] !== 'string' || !CLI_ARGUMENTS[argv[0]]) {
    throw vaultFailure('FRA_ARGUMENT_INVALID', 'unknown FRA device verb');
  }
  const spec = CLI_ARGUMENTS[argv[0]];
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== 'string' || !/^--[a-z][a-z0-9-]*$/.test(token)) {
      throw vaultFailure('FRA_ARGUMENT_INVALID', 'The FRA device command contains an unexpected positional argument.');
    }
    const name = token.slice(2);
    if (seen.has(name)) throw vaultFailure('FRA_ARGUMENT_INVALID', `${token} may be supplied only once.`);
    seen.add(name);
    if (spec.flags.includes(name)) continue;
    if (!spec.values.includes(name)) throw vaultFailure('FRA_ARGUMENT_INVALID', `${token} is not valid for ${argv[0]}.`);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) throw vaultFailure('FRA_ARGUMENT_INVALID', `${token} needs a value.`);
  }
}

function jsonRecord(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }

function validateSecureOrigin(value, allowInsecureLoopback, label) {
  let endpoint;
  try { endpoint = new URL(value); } catch { endpoint = null; }
  const loopback = endpoint && ['127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (!endpoint || (endpoint.protocol !== 'https:'
      && !(allowInsecureLoopback && loopback && endpoint.protocol === 'http:'))
      || endpoint.username || endpoint.password || endpoint.pathname !== '/'
      || endpoint.search || endpoint.hash || endpoint.origin !== value) {
    throw vaultFailure('FRA_ROUTE_INVALID', `${label} must be one exact HTTPS origin; HTTP is limited to explicitly enabled literal loopback.`);
  }
  return value;
}

function fileVault(dir, { lockWaitMs = DEFAULT_LOCK_WAIT_MS, lockStaleMs = DEFAULT_LOCK_STALE_MS } = {}) {
  if (!Number.isSafeInteger(lockWaitMs) || lockWaitMs < 1 || lockWaitMs > 60_000
      || !Number.isSafeInteger(lockStaleMs) || lockStaleMs < 1 || lockStaleMs > 3_600_000) {
    throw vaultFailure('FRA_VAULT_OPTIONS_INVALID', 'The FRA vault lock deadlines are invalid.');
  }
  const { directory, identity: directoryIdentity } = ensurePrivateDirectory(dir);
  const file = path.join(directory, 'vault.json');
  const lock = path.join(directory, '.vault.lock');
  const options = { lockWaitMs, lockStaleMs };
  const transaction = operation => {
    const held = acquireLock(lock, options, directory, directoryIdentity);
    let value;
    let failure = null;
    try { value = operation(); } catch (error) { failure = error; }
    try { releaseLock(lock, held, directory, directoryIdentity); }
    catch (error) { failure ||= error; }
    if (failure) throw failure;
    return value;
  };
  const read = () => decodeVault(readBoundedFile(file, MAX_VAULT_BYTES, { absent: true }));
  const write = value => atomicWrite(file, encodeVault(value), directory, directoryIdentity);
  return {
    getSecret(key) {
      validKey(key);
      return transaction(() => {
        const value = read();
        if (!Object.hasOwn(value, key)) throw Object.assign(new Error('absent'), { code: 'SECRET_NOT_CONFIGURED' });
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
        if (!Object.hasOwn(value, DEVICE_CREDENTIAL_VAULT_KEY)) {
          return { key: DEVICE_CREDENTIAL_VAULT_KEY, status: 'absent' };
        }
        delete value[DEVICE_CREDENTIAL_VAULT_KEY];
        write(value);
        return { key: DEVICE_CREDENTIAL_VAULT_KEY, status: 'cleared' };
      });
    },
  };
}

async function main(argv) {
  validateCliArguments(argv);
  const verb = argv[0];
  const out = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  // Before fra-core is loaded: switching back to SSH must work without it.
  if (verb === 'use-fra' || verb === 'use-ssh-only') {
    // Point this machine's launcher config at the FRA route (SSH kept as the
    // fallback), or back to SSH only. Only these keys are touched.
    const file = option(argv, 'lead-config');
    if (!file) throw vaultFailure('FRA_ARGUMENT_INVALID', 'need --lead-config');
    const context = privateFileContext(file);
    const updated = await withPrivateFileLock(context, 'lead-config', async () => {
      const record = readBoundedFileRecord(context.file, MAX_CONFIG_BYTES);
      const config = decodePrivateJson(record);
      if (!jsonRecord(config)) throw vaultFailure('FRA_CONFIG_INVALID', 'The lead config must be one JSON object.');
      if (verb === 'use-ssh-only') {
        delete config.fra;
        config.transports = ['ssh'];
      } else {
        const state = option(argv, 'state');
        const fraCore = option(argv, 'fra-core');
        const accountUrl = option(argv, 'account');
        const relayPairId = option(argv, 'relay-pair');
        const allowInsecureLoopback = booleanFlag(argv, 'allow-insecure-loopback');
        if (!state || !fraCore || !accountUrl || !relayPairId) {
          throw vaultFailure('FRA_ARGUMENT_INVALID', 'use-fra needs --state, --fra-core, --account and --relay-pair.');
        }
        if (!path.isAbsolute(fraCore)) throw vaultFailure('FRA_ROUTE_INVALID', 'The FRA core path must be absolute.');
        fileVault(state); // validate/create the private state directory before recording it
        const { isPairId } = require(path.join(fraCore, 'src', 'lib', 'online-fra-wire-shapes.js'));
        if (!isPairId(relayPairId)) throw vaultFailure('FRA_ROUTE_INVALID', 'The FRA relay pair id is invalid.');
        validateSecureOrigin(accountUrl, allowInsecureLoopback, 'The FRA account URL');
        const origin = validateSecureOrigin(option(argv, 'origin', accountUrl), allowInsecureLoopback, 'The FRA asserted Origin');
        config.fra = { accountUrl, origin, relayPairId, fraCore: path.resolve(fraCore), state: path.resolve(state),
          ...(allowInsecureLoopback ? { allowInsecureLoopback: true } : {}) };
        config.transports = ['fra', 'ssh'];
      }
      replacePrivateJson(context, config, MAX_CONFIG_BYTES);
      return config.transports;
    });
    out({ transports: updated });
    return;
  }
  const state = option(argv, 'state');
  const fraCore = option(argv, 'fra-core');
  if (!state || !fraCore) throw vaultFailure('FRA_ARGUMENT_INVALID', 'need --state and --fra-core');
  if (!path.isAbsolute(fraCore)) throw vaultFailure('FRA_ROUTE_INVALID', 'The FRA core path must be absolute.');
  const lib = name => require(path.join(fraCore, 'src', 'lib', name));
  const vault = fileVault(state);
  const claimFile = path.join(state, 'claim.json');
  const claimContext = privateFileContext(claimFile);
  const clearPendingClaim = expectedIdentity => withPrivateFileLock(claimContext, 'claim', async () => {
    const pending = readBoundedFileRecord(claimContext.file, MAX_CLAIM_BYTES, { absent: true });
    if (pending === null) return false;
    decodePrivateJson(pending, 'FRA_CLAIM_INVALID');
    // A long poll may finish after another process has replaced the claim.
    // Never let the old poll erase that newer authority record.
    if (expectedIdentity && !sameFile(pending.identity, expectedIdentity)) return false;
    unlinkPrivateFile(claimContext, pending.identity, MAX_CLAIM_BYTES);
    return true;
  });
  if (verb === 'pending') {
    const pending = readBoundedFileRecord(claimContext.file, MAX_CLAIM_BYTES, { absent: true });
    if (pending !== null) decodePrivateJson(pending, 'FRA_CLAIM_INVALID');
    out({ pending: pending !== null });
    return;
  }
  if (verb === 'abandon') {
    await clearPendingClaim();
    out({ pending: false });
    return;
  }
  if (verb === 'forget') {
    // Server-side revocation is the authority boundary. Once the enrolment
    // controller has confirmed it, retain neither the dead credential nor a
    // claim token which could later be mistaken for a current enrolment.
    vault.clearDeviceCredential();
    await clearPendingClaim();
    out({ enrolled: false });
    return;
  }
  const { createDeviceClaimClient, connectionState } = lib('online-fra-device-claim.js');
  const { isPollToken, isEmailText } = lib('online-fra-wire-shapes.js');
  const credential = () => connectionState(vault);
  if (verb === 'status') {
    const current = credential();
    out(current.connected ? { enrolled: true, pairId: current.pairId } : { enrolled: false });
    return;
  }
  const account = option(argv, 'account');
  if (!account) throw vaultFailure('FRA_ARGUMENT_INVALID', 'need --account');
  const allowInsecureLoopback = booleanFlag(argv, 'allow-insecure-loopback');
  validateSecureOrigin(account, allowInsecureLoopback, 'The FRA account URL');
  const origin = validateSecureOrigin(option(argv, 'origin', account), allowInsecureLoopback, 'The FRA asserted Origin');
  const claim = () => createDeviceClaimClient({ baseUrl: account, vault, origin, allowInsecureLoopback });
  if (verb === 'open') {
    const opened = await withPrivateFileLock(claimContext, 'claim', async () => {
      const existing = readBoundedFileRecord(claimContext.file, MAX_CLAIM_BYTES, { absent: true });
      if (existing !== null) {
        decodePrivateJson(existing, 'FRA_CLAIM_INVALID');
        throw vaultFailure('FRA_CLAIM_ALREADY_OPEN', 'This machine already has an unfinished device claim.');
      }
      const created = await claim().openClaim({ name: option(argv, 'name') });
      createPrivateJson(claimContext, { pollToken: created.pollToken }, MAX_CLAIM_BYTES);
      return created;
    });
    out({ code: opened.code });
  } else if (verb === 'accept') {
    const expectedEmail = option(argv, 'expect-email');
    if (!isEmailText(expectedEmail)) {
      throw vaultFailure('FRA_ARGUMENT_INVALID', 'accept needs the exact account email shown by the reservation.');
    }
    const after = await withPrivateFileLock(claimContext, 'claim', async () => {
      const record = readBoundedFileRecord(claimContext.file, MAX_CLAIM_BYTES);
      const saved = decodePrivateJson(record, 'FRA_CLAIM_INVALID');
      if (!jsonRecord(saved) || Object.keys(saved).length !== 1 || !isPollToken(saved.pollToken)) {
        throw vaultFailure('FRA_CLAIM_INVALID', 'The saved FRA claim is incomplete or malformed.');
      }
      const client = claim();
      const before = await client.pollOnce({ pollToken: saved.pollToken });
      if (before.state !== 'reserved') throw Object.assign(new Error(`claim is ${before.state}, not reserved`), { code: 'CLAIM_NOT_RESERVED' });
      if (!before.account || before.account.email !== expectedEmail) {
        throw vaultFailure('FRA_CLAIM_ACCOUNT_MISMATCH', 'The claim was reserved by a different account; it was not accepted.');
      }
      await client.decideClaim({ pollToken: saved.pollToken, accept: true });
      const connected = await client.pollOnce({ pollToken: saved.pollToken });
      if (connected.state !== 'connected') throw vaultFailure('FRA_CLAIM_RESPONSE_INVALID', 'The accepted claim did not produce a durable connection.');
      unlinkPrivateFile(claimContext, record.identity, MAX_CLAIM_BYTES);
      return connected;
    });
    out({ state: after.state, pairId: credential().pairId });
  } else if (verb === 'decline') {
    const after = await withPrivateFileLock(claimContext, 'claim', async () => {
      const record = readBoundedFileRecord(claimContext.file, MAX_CLAIM_BYTES);
      const saved = decodePrivateJson(record, 'FRA_CLAIM_INVALID');
      if (!jsonRecord(saved) || Object.keys(saved).length !== 1 || !isPollToken(saved.pollToken)) {
        throw vaultFailure('FRA_CLAIM_INVALID', 'The saved FRA claim is incomplete or malformed.');
      }
      let decided;
      try {
        decided = await claim().decideClaim({ pollToken: saved.pollToken, accept: false });
      } catch (error) {
        if (!error || error.code !== 'DEVICE_CLAIM_GONE') throw error;
        unlinkPrivateFile(claimContext, record.identity, MAX_CLAIM_BYTES);
        return { state: 'gone' };
      }
      if (!decided || decided.state !== 'rejected') {
        throw vaultFailure('FRA_CLAIM_RESPONSE_INVALID', 'The claim cancellation did not return a terminal refusal.');
      }
      unlinkPrivateFile(claimContext, record.identity, MAX_CLAIM_BYTES);
      return decided;
    });
    out({ state: after.state });
  } else if (verb === 'wait') {
    /* READ-ONLY. A reserved poll never decides; only accept/decline does. */
    const timeoutText = option(argv, 'timeout-seconds', '600');
    if (!/^[1-9][0-9]{0,3}$/.test(timeoutText)
        || Number(timeoutText) > 3600) {
      throw vaultFailure('FRA_ARGUMENT_INVALID', '--timeout-seconds must be a whole number from 1 to 3600.');
    }
    const deadline = Date.now() + Number(timeoutText) * 1000;
    const client = claim();
    for (;;) {
      const record = readBoundedFileRecord(claimContext.file, MAX_CLAIM_BYTES, { absent: true });
      if (record === null) {
        throw vaultFailure('FRA_CLAIM_NOT_OPEN', 'This machine has no open device claim. Run open first.');
      }
      const saved = decodePrivateJson(record, 'FRA_CLAIM_INVALID');
      if (!jsonRecord(saved) || Object.keys(saved).length !== 1 || !isPollToken(saved.pollToken)) {
        throw vaultFailure('FRA_CLAIM_INVALID', 'The saved FRA claim is incomplete or malformed.');
      }
      let polled;
      try {
        polled = await client.pollOnce({ pollToken: saved.pollToken });
      } catch (error) {
        if (!error || error.code !== 'DEVICE_CLAIM_GONE') throw error;
        if (!await clearPendingClaim(record.identity)) {
          throw vaultFailure('FRA_CLAIM_CHANGED', 'The local claim changed while the previous claim was being checked. Nothing was removed.');
        }
        out({ state: 'gone' });
        return;
      }
      if (polled.state === 'reserved') {
        out({ state: 'reserved', email: polled.account.email });
        return;
      }
      if (polled.state !== 'pending') {
        throw vaultFailure('FRA_CLAIM_RESPONSE_INVALID', 'The claim changed state without being accepted here.');
      }
      const waitMs = Math.min(polled.intervalSeconds * 1000, deadline - Date.now());
      if (waitMs <= 0) {
        out({ state: 'pending' });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  } else throw new Error(`unknown verb ${verb}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`fra-device: ${error.code || ''} ${error.message}\n`);
    process.exit(1);
  });
}
/** fra-core needs Node >= 22.19 (fra-core API.md; global WebSocket). */
function nodeSupportsFra(version) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 19);
}
module.exports = { fileVault, nodeSupportsFra, readPrivateJsonFile, readPrivateTextFile, validatePrivateFilePath,
  appendPrivateTextFile, parseStrictJson, validateSecureOrigin, validateCliArguments };
