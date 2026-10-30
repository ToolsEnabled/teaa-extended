'use strict';
// HOW THIS MACHINE PERFORMS A TUNNELLED REQUEST: against its own action bridge,
// exactly as the local UI would, with the same bearer.
//
// The action bridge (src/lib/mission-bridge/server.js) binds loopback and
// writes two owner-only files per boot: state/mission-bridge-runtime.json
// (where it is listening) and state/mission-bridge-token.json (the bearer).
// The local UI obtains that bearer through GET /v1/bootstrap with a proof read
// from a third owner-only file, because a BROWSER cannot read files. This is
// not a browser. It is a process running as the owner on the owner's machine,
// and the files ARE the authorization model: whoever can read them is the
// owner, by the bridge's own design ("the same per-boot ACL pattern as the
// bearer token file"). So it reads the bearer and uses it, and sends no
// Origin, which the bridge treats as a non-browser caller.
//
// READ PER CALL, NOT ONCE. Both files rotate every time the bridge restarts.
// A bearer cached at shell start would be refused after the first bridge
// restart with a 401 that points nowhere near its cause; reading two small
// files per request costs nothing and is always current.
//
// PATH ONLY. The caller hands a path+query; the origin is always this
// machine's own bridge. There is no parameter by which a tunnelled request
// can be sent anywhere else.

const fs = require('node:fs');
const path = require('node:path');
const { fetchBridgeResponse, BridgeResponseError, MAX_RESPONSE_BYTES } = require('./online-fra-bridge-response');
const { BROWSER_DISPATCH_GUARD } = require('./online-fra-browser-authority');
const { parseStrictJsonBytes } = require('./online-fra-strict-json');

class OnlineFraLocalBridgeError extends Error {
  constructor(code, message) { super(message || code); this.name = 'OnlineFraLocalBridgeError'; this.code = code; }
}
function fail(code, message) { throw new OnlineFraLocalBridgeError(code, message); }

const MAX_RECORD_BYTES = 16 * 1024;
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const FORWARDABLE_HEADERS = new Set(['accept', 'content-type', 'x-request-id']);

function sameObject(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function unchanged(left, right) {
  return sameObject(left, right) && left.size === right.size && left.mode === right.mode
    && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function validateRecordStat(stat, invalidCode, name) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    fail(invalidCode, `${name} is not a singly linked ordinary file.`);
  }
  if (typeof process.geteuid === 'function' && stat.uid !== BigInt(process.geteuid())) {
    fail(invalidCode, `${name} is not owned by this account.`);
  }
  if (process.platform !== 'win32' && ((stat.mode & 0o077n) !== 0n || (stat.mode & 0o400n) === 0n)) {
    fail(invalidCode, `${name} is not owner-readable and owner-only.`);
  }
  if (stat.size < 1n || stat.size > BigInt(MAX_RECORD_BYTES)) {
    fail(invalidCode, `${name} exceeds the bridge record limit.`);
  }
}

function validateParent(file, invalidCode, name) {
  const parent = fs.lstatSync(path.dirname(file), { bigint: true });
  if (!parent.isDirectory() || parent.isSymbolicLink()) fail(invalidCode, `${name} has an untrusted parent directory.`);
  if (typeof process.geteuid === 'function' && parent.uid !== BigInt(process.geteuid())) {
    fail(invalidCode, `${name} has a parent directory owned by another account.`);
  }
  if (process.platform !== 'win32' && (parent.mode & 0o022n) !== 0n) {
    fail(invalidCode, `${name} has a group- or world-writable parent directory.`);
  }
}

function readJson(file, unavailableCode, invalidCode) {
  const name = path.basename(file);
  let fd;
  try {
    validateParent(file, invalidCode, name);
    const before = fs.lstatSync(file, { bigint: true });
    validateRecordStat(before, invalidCode, name);
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd, { bigint: true });
    validateRecordStat(opened, invalidCode, name);
    if (!sameObject(before, opened)) fail(invalidCode, `${name} changed while it was opened.`);

    const expected = Number(opened.size);
    const bytes = Buffer.alloc(expected + 1);
    let read = 0;
    while (read < bytes.length) {
      const count = fs.readSync(fd, bytes, read, bytes.length - read, read);
      if (count === 0) break;
      read += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const landed = fs.lstatSync(file, { bigint: true });
    if (read !== expected || !unchanged(opened, after) || !sameObject(opened, landed)) {
      fail(invalidCode, `${name} changed while it was read.`);
    }
    let value;
    try { value = parseStrictJsonBytes(bytes.subarray(0, read), {
      maxBytes:MAX_RECORD_BYTES, maxDepth:12, maxValues:512,
    }); }
    catch { fail(invalidCode, `${name} is not valid JSON.`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(invalidCode, `${name} is not a JSON object.`);
    return value;
  } catch (error) {
    if (error instanceof OnlineFraLocalBridgeError) throw error;
    fail(unavailableCode, `${name} is not readable (${error.code || 'I/O error'}). Is the action bridge running on this machine?`);
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* the read result is already settled */ }
  }
}

function runtimeTarget(runtime) {
  if (typeof runtime.baseUrl !== 'string' || runtime.baseUrl.length > 256) {
    fail('LOCAL_BRIDGE_RUNTIME_INVALID', 'The bridge runtime record does not name a loopback base URL.');
  }
  let parsed;
  try { parsed = new URL(runtime.baseUrl); }
  catch { fail('LOCAL_BRIDGE_RUNTIME_INVALID', 'The bridge runtime record does not name a loopback base URL.'); }
  const literalLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  const port = Number(parsed.port);
  if (parsed.protocol !== 'http:' || !literalLoopback || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash || !parsed.port
      || !Number.isSafeInteger(port) || port < 1 || port > 65535
      || (runtime.baseUrl !== parsed.origin && runtime.baseUrl !== `${parsed.origin}/`)
      || (runtime.port !== undefined && runtime.port !== port)) {
    fail('LOCAL_BRIDGE_RUNTIME_INVALID', 'The bridge runtime record does not name a loopback base URL.');
  }
  return parsed.origin;
}

function requestBody(body, method) {
  if (body === undefined || body === null) return undefined;
  if (method === 'GET' || method === 'HEAD') fail('LOCAL_BRIDGE_BODY_INVALID', `${method} requests cannot carry a bridge body.`);
  let size;
  if (typeof body === 'string') size = Buffer.byteLength(body);
  else if (Buffer.isBuffer(body) || ArrayBuffer.isView(body)) size = body.byteLength;
  else if (body instanceof ArrayBuffer) size = body.byteLength;
  else fail('LOCAL_BRIDGE_BODY_INVALID', 'The local bridge body must be bounded bytes or text.');
  if (size > MAX_RESPONSE_BYTES) fail('LOCAL_BRIDGE_BODY_TOO_LARGE', 'The local bridge request body exceeds the tunnel limit.');
  return body;
}

function createLocalBridge({ runtimeFile, tokenFile, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  if (typeof runtimeFile !== 'string' || !path.isAbsolute(runtimeFile) ||
      typeof tokenFile !== 'string' || !path.isAbsolute(tokenFile)) {
    fail('LOCAL_BRIDGE_OPTIONS_INVALID', 'Inject absolute runtimeFile and tokenFile paths.');
  }
  if (typeof fetchImpl !== 'function') fail('LOCAL_BRIDGE_OPTIONS_INVALID', 'No fetch implementation; inject one.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    fail('LOCAL_BRIDGE_OPTIONS_INVALID', 'The local bridge timeout must be a positive bounded integer.');
  }

  function target() {
    const runtime = readJson(runtimeFile, 'LOCAL_BRIDGE_RUNTIME_UNAVAILABLE', 'LOCAL_BRIDGE_RUNTIME_INVALID');
    const baseUrl = runtimeTarget(runtime);
    const token = readJson(tokenFile, 'LOCAL_BRIDGE_TOKEN_UNAVAILABLE', 'LOCAL_BRIDGE_TOKEN_INVALID');
    let decoded;
    try { decoded = typeof token.token === 'string' ? Buffer.from(token.token, 'base64url') : null; }
    catch { decoded = null; }
    const valid = decoded && decoded.length === 32 && decoded.toString('base64url') === token.token;
    if (decoded) decoded.fill(0);
    if (!valid) fail('LOCAL_BRIDGE_TOKEN_INVALID', 'The bridge token record does not hold a canonical 32-byte bearer.');
    return { baseUrl, bearer: token.token };
  }

  async function fetch(pathname, init = {}) {
    if (typeof pathname !== 'string' || pathname.length > 2048 || Buffer.byteLength(pathname) > 2048
        || pathname[0] !== '/' || pathname.startsWith('//') || !/^[\x21-\x7e]+$/.test(pathname)
        || pathname.includes('\\') || pathname.includes('#')) {
      fail('LOCAL_BRIDGE_PATH_INVALID', 'A tunnelled request names a /path[?query] on this machine\'s own bridge, nothing else.');
    }
    const method = init.method === undefined ? 'GET' : init.method;
    if (typeof method !== 'string' || !ALLOWED_METHODS.has(method)) {
      fail('LOCAL_BRIDGE_METHOD_INVALID', 'The local bridge request method is not allowed.');
    }
    let supplied;
    try { supplied = new Headers(init.headers || {}); }
    catch { fail('LOCAL_BRIDGE_HEADERS_INVALID', 'The local bridge request headers are invalid.'); }
    const headers = {};
    for (const [name, value] of supplied.entries()) {
      if (FORWARDABLE_HEADERS.has(name) && value.length <= 8192) headers[name] = value;
    }
    const { baseUrl, bearer } = target();
    let url;
    try { url = new URL(pathname, `${baseUrl}/`); }
    catch { fail('LOCAL_BRIDGE_PATH_INVALID', 'The local bridge path is invalid.'); }
    if (url.origin !== baseUrl || `${url.pathname}${url.search}` !== pathname) {
      fail('LOCAL_BRIDGE_PATH_INVALID', 'The local bridge path is not canonical.');
    }
    headers.authorization = `Bearer ${bearer}`;
    if (init[BROWSER_DISPATCH_GUARD]) init[BROWSER_DISPATCH_GUARD]();
    try {
      return await fetchBridgeResponse(url.href, { method, headers,
        body: requestBody(init.body, method), signal: init.signal }, { fetchImpl, timeoutMs });
    } catch (error) {
      if (error instanceof BridgeResponseError) fail(error.code.replace('BRIDGE_HTTP_', 'LOCAL_BRIDGE_'), error.message);
      throw error;
    }
  }

  return Object.freeze({ fetch, target, runtimeFile, tokenFile });
}

module.exports = Object.freeze({ OnlineFraLocalBridgeError, createLocalBridge });
