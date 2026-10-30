'use strict';

// Account responses are small JSON envelopes, not the tunnel's binary body.
// One deadline covers dispatch and the entire native response stream. This
// helper never resends a request: a missing response is not proof of no effect.
const MAX_ACCOUNT_RESPONSE_BYTES = 128 * 1024;
const { parseStrictJsonBytes } = require('./online-fra-strict-json');
const ACCOUNT_REQUEST_UNCERTAIN = 'The request may have reached the service; check its status before repeating it.';
const ACCOUNT_REQUEST_NOT_ATTEMPTED = 'The request was not sent to the service.';
const ACCOUNT_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const ACCOUNT_ERROR_CONTROL = /[\x00-\x1f\x7f]/;

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try { return [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
  catch { return false; }
}

// Network JSON cannot contain accessors, but injected fetch implementations
// can. Never execute a hostile getter while translating an error for logs/UI.
function ownData(value, key) {
  if (!plainRecord(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}

function accountRequestGuidance(requestOutcome) {
  return requestOutcome === 'NOT_ATTEMPTED' ? ACCOUNT_REQUEST_NOT_ATTEMPTED : ACCOUNT_REQUEST_UNCERTAIN;
}

class AccountResponseError extends Error {
  constructor(code, message, requestOutcome) {
    super(message);
    this.name = 'AccountResponseError';
    this.code = code;
    this.requestOutcome = requestOutcome;
  }
}

function validAccountTimeout(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

function responseHeader(response, name) {
  try {
    if (response?.headers && typeof response.headers.get === 'function') return response.headers.get(name);
    const entries = response?.headers && typeof response.headers === 'object' ? Object.entries(response.headers) : [];
    const found = entries.find(([key]) => String(key).toLowerCase() === name);
    return found ? found[1] : null;
  } catch { return null; }
}

function exactJsonResponseMediaType(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) return false;
  const fields = value.split(';');
  const essence = fields[0].trim().toLowerCase();
  if (!/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/.test(essence)) return false;
  if (fields.length === 1) return true;
  if (fields.length !== 2) return false;
  return /^charset\s*=\s*(?:utf-8|"utf-8")$/i.test(fields[1].trim());
}

function closedAccountRequestOutcome(error) {
  let value;
  try { if (error instanceof AccountResponseError) value = error.requestOutcome; } catch { /* closed fallback */ }
  return value === 'NOT_ATTEMPTED' || value === 'UNCERTAIN' ? value : 'UNCERTAIN';
}

// Error bodies cross a service boundary and commonly reach logs or UI.  Keep
// the server's useful closed-set code and human message only when both have a
// bounded, non-control shape; otherwise use the caller's local wording.
function accountServiceError(body, fallbackCode, fallbackMessage) {
  if (typeof fallbackCode !== 'string' || !ACCOUNT_ERROR_CODE.test(fallbackCode)
      || typeof fallbackMessage !== 'string' || fallbackMessage.length < 1
      || fallbackMessage.length > 4096 || fallbackMessage !== fallbackMessage.trim()
      || ACCOUNT_ERROR_CONTROL.test(fallbackMessage)) {
    throw new TypeError('accountServiceError needs a safe fallback.');
  }
  const candidate = ownData(body, 'error');
  const envelope = plainRecord(candidate) ? candidate : null;
  const offeredCode = ownData(envelope, 'code');
  const offeredMessage = ownData(envelope, 'message');
  const code = typeof offeredCode === 'string' && ACCOUNT_ERROR_CODE.test(offeredCode)
    ? offeredCode : fallbackCode;
  const message = typeof offeredMessage === 'string'
    && offeredMessage.length >= 1 && offeredMessage.length <= 4096
    && offeredMessage === offeredMessage.trim() && !ACCOUNT_ERROR_CONTROL.test(offeredMessage)
    ? offeredMessage : fallbackMessage;
  return Object.freeze({ code, message });
}

async function fetchAccountJson(url, init, { fetchImpl, timeoutMs, statusOnly = [] } = {}) {
  let dispatched = false;
  const failure = (code, message) => new AccountResponseError(code, message,
    dispatched ? 'UNCERTAIN' : 'NOT_ATTEMPTED');
  if (typeof fetchImpl !== 'function' || !validAccountTimeout(timeoutMs)
      || !Array.isArray(statusOnly) || statusOnly.some(status => !Number.isInteger(status))) {
    throw failure('ACCOUNT_HTTP_OPTIONS_INVALID', 'The account HTTP response options are invalid.');
  }
  const controller = new AbortController();
  const signal = init && init.signal;
  const cancel = () => controller.abort(failure('ACCOUNT_HTTP_ABORTED',
    `The account request was cancelled. ${accountRequestGuidance(dispatched ? 'UNCERTAIN' : 'NOT_ATTEMPTED')}`));
  if (signal !== undefined && signal !== null) {
    if (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'
        || typeof signal.aborted !== 'boolean') {
      throw failure('ACCOUNT_HTTP_OPTIONS_INVALID', 'The account request signal is invalid.');
    }
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  }
  let reader = null;
  const cancelReader = () => {
    if (!reader) return;
    // A trusted injected stream may never settle its cancel promise. Invoke
    // cancellation but do not let that promise defeat the response deadline.
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* no raw diagnostics */ }
  };
  const cancelBody = response => {
    try { if (response.body) Promise.resolve(response.body.cancel()).catch(() => {}); } catch { /* best effort for injected code */ }
  };
  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => { cancelReader(); reject(controller.signal.reason); };
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(failure('ACCOUNT_HTTP_TIMEOUT',
    `The account response did not complete in time. ${ACCOUNT_REQUEST_UNCERTAIN}`)), timeoutMs);
  const complete = async () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    dispatched = true;
    // Following a redirect would silently repeat a credential-bearing request
    // at another URL. Account clients consume the original response only.
    const response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'manual' });
    if (controller.signal.aborted) {
      cancelBody(response);
      throw controller.signal.reason;
    }
    const status = response && response.status;
    if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
      throw failure('ACCOUNT_HTTP_RESPONSE_INVALID',
        `The account service returned an invalid HTTP response. ${ACCOUNT_REQUEST_UNCERTAIN}`);
    }
    if (statusOnly.includes(status)) {
      // Uniform 404 is complete in its status alone. Do not consult, parse or
      // wait for the body, but cancel it so the live connection is not leaked.
      cancelBody(response);
      return { status, body: null };
    }
    const contentType = responseHeader(response, 'content-type');
    const contentLength = responseHeader(response, 'content-length');
    if (!exactJsonResponseMediaType(contentType)) {
      cancelBody(response);
      return { status, body:null, bodyReadError:true };
    }
    if (contentLength !== null && contentLength !== undefined
        && (typeof contentLength !== 'string' || !/^(?:0|[1-9][0-9]{0,6})$/.test(contentLength)
          || Number(contentLength) > MAX_ACCOUNT_RESPONSE_BYTES)) {
      cancelBody(response);
      controller.abort(failure('ACCOUNT_HTTP_RESPONSE_TOO_LARGE',
        `The account response exceeds its size limit. ${ACCOUNT_REQUEST_UNCERTAIN}`));
      throw controller.signal.reason;
    }
    const stream = response.body;
    if (stream && typeof stream.getReader === 'function') {
      reader = stream.getReader();
      let bytes = 0;
      const chunks = [];
      try {
        for (;;) {
          const item = await reader.read();
          if (controller.signal.aborted) throw controller.signal.reason;
          if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > MAX_ACCOUNT_RESPONSE_BYTES) {
            controller.abort(failure('ACCOUNT_HTTP_RESPONSE_TOO_LARGE',
              `The account response exceeds its size limit. ${ACCOUNT_REQUEST_UNCERTAIN}`));
            throw controller.signal.reason;
          }
          chunks.push(Buffer.from(item.value));
        }
        try { return { status, body:parseStrictJsonBytes(Buffer.concat(chunks, bytes), {
          maxBytes:MAX_ACCOUNT_RESPONSE_BYTES, maxDepth:24, maxValues:10_000,
        }) }; }
        catch { return { status, body: null, bodyReadError: true }; }
      } finally {
        const active = reader;
        reader = null;
        try { active.releaseLock(); } catch { /* no raw diagnostics */ }
      }
    }
    // Compatibility only for trusted injected byte adapters. A pre-parsed
    // object is never accepted because it cannot prove duplicate-key or wire-
    // encoding semantics. Native production Fetch uses the bounded stream.
    try {
      if (typeof response?.arrayBuffer !== 'function' || typeof contentLength !== 'string') {
        return { status, body:null, bodyReadError:true };
      }
      const contentEncoding = responseHeader(response, 'content-encoding');
      if (contentEncoding !== null && contentEncoding !== undefined
          && (typeof contentEncoding !== 'string' || contentEncoding.trim().toLowerCase() !== 'identity')) {
        return { status, body:null, bodyReadError:true };
      }
      const raw = await response.arrayBuffer();
      if (typeof ArrayBuffer !== 'function' || !(raw instanceof ArrayBuffer)) {
        return { status, body:null, bodyReadError:true };
      }
      const bytes = Buffer.from(raw);
      if (bytes.byteLength !== Number(contentLength) || bytes.byteLength > MAX_ACCOUNT_RESPONSE_BYTES) {
        return { status, body:null, bodyReadError:true };
      }
      const body = parseStrictJsonBytes(bytes, {
        maxBytes:MAX_ACCOUNT_RESPONSE_BYTES, maxDepth:24, maxValues:10_000,
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      return { status, body };
    } catch {
      if (controller.signal.aborted) throw controller.signal.reason;
      return { status, body: null, bodyReadError: true };
    }
  };
  try {
    return await Promise.race([complete(), aborted]);
  } catch {
    if (controller.signal.aborted) throw controller.signal.reason;
    // Even a hostile injected exception cannot project a path, token, raw
    // network error or invented code into the account client's diagnostics.
    const error = failure('ACCOUNT_HTTP_UNAVAILABLE',
      `The account response could not be completed. ${ACCOUNT_REQUEST_UNCERTAIN}`);
    controller.abort(error);
    throw error;
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    if (signal) signal.removeEventListener('abort', cancel);
  }
}

module.exports = Object.freeze({ AccountResponseError, fetchAccountJson, validAccountTimeout, closedAccountRequestOutcome,
  accountServiceError,
  accountRequestGuidance, MAX_ACCOUNT_RESPONSE_BYTES, ACCOUNT_REQUEST_UNCERTAIN, ACCOUNT_REQUEST_NOT_ATTEMPTED });
