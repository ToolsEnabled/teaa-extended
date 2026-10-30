'use strict';

// Authority-bearing JSON uses this byte parser/encoder instead of JSON.parse
// and JSON.stringify directly. It rejects malformed UTF-8, duplicate or
// prototype-mutating keys, lone surrogates, unsafe integers, accessors,
// non-plain values, cycles, and unbounded depth/value counts.
const { TextDecoder } = require('node:util');
const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_NUMBER_TOKEN_LENGTH = 128;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/* JSON decimals and exponents can round to integers in binary floating point.
 * Classify the source token exactly before an authority layer trusts the
 * parsed value as an integer. */
function exactIntegerStatus(token) {
  const parts = /^-?([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(token);
  if (!parts) return { integer:false, safe:false };
  const digits = `${parts[1]}${parts[2] || ''}`;
  const coefficient = BigInt(digits);
  if (coefficient === 0n) return { integer:true, safe:true };
  const exponent = Number(parts[3] || 0);
  if (!Number.isSafeInteger(exponent)) return { integer:false, safe:false };
  const shift = exponent - (parts[2] || '').length;
  if (shift >= 0) {
    if (shift > 16) return { integer:true, safe:false };
    const integer = coefficient * (10n ** BigInt(shift));
    return { integer:true, safe:integer <= MAX_SAFE_BIGINT };
  }
  const places = -shift;
  if (places > digits.length) return { integer:false, safe:false };
  const divisor = 10n ** BigInt(places);
  if (coefficient % divisor !== 0n) return { integer:false, safe:false };
  return { integer:true, safe:(coefficient / divisor) <= MAX_SAFE_BIGINT };
}

function isScalarString(value, { min = 0, max = 4096, trim = false, control = false } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max
      || (trim && value !== value.trim()) || (control && /[\x00-\x1f\x7f]/.test(value))) return false;
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

function parseStrictJsonBytes(bytes, { maxBytes = 128 * 1024, maxDepth = 16, maxValues = 4096 } = {}) {
  if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(maxBytes) || maxBytes < 1
      || bytes.byteLength > maxBytes || !Number.isSafeInteger(maxDepth) || maxDepth < 1
      || !Number.isSafeInteger(maxValues) || maxValues < 1) throw new Error('invalid JSON input');
  let source;
  try { source = FATAL_UTF8.decode(bytes); } catch { throw new Error('invalid JSON input'); }
  if (source.charCodeAt(0) === 0xfeff) throw new Error('invalid JSON input');
  let at = 0;
  let values = 0;
  const invalid = () => { throw new Error('invalid JSON input'); };
  const whitespace = () => { while (/[ \t\r\n]/.test(source[at] || '')) at += 1; };
  const string = () => {
    if (source[at] !== '"') invalid();
    const start = at++;
    for (;;) {
      if (at >= source.length || source.charCodeAt(at) < 0x20) invalid();
      if (source[at] === '"') {
        at += 1;
        let parsed;
        try { parsed = JSON.parse(source.slice(start, at)); }
        catch (error) { if (error instanceof SyntaxError) invalid(); throw error; }
        if (!isScalarString(parsed, { max:Math.max(source.length, 1) })) invalid();
        return parsed;
      }
      if (source[at] === '\\') {
        at += 1;
        if (at >= source.length || !/["\\/bfnrtu]/.test(source[at])) invalid();
        if (source[at] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(at + 1, at + 5))) invalid();
          at += 4;
        }
      }
      at += 1;
    }
  };
  const value = depth => {
    values += 1;
    if (values > maxValues || depth > maxDepth) invalid();
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
        if (seen.has(key) || FORBIDDEN_KEYS.has(key)) invalid();
        seen.add(key);
        whitespace();
        if (source[at++] !== ':') invalid();
        result[key] = value(depth + 1);
        whitespace();
        if (source[at] === '}') { at += 1; return result; }
        if (source[at++] !== ',') invalid();
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
        if (source[at++] !== ',') invalid();
        whitespace();
      }
    }
    for (const [token, parsed] of [['true', true], ['false', false], ['null', null]]) {
      if (source.startsWith(token, at)) { at += token.length; return parsed; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(at));
    if (!match || match[0].length > MAX_NUMBER_TOKEN_LENGTH) invalid();
    at += match[0].length;
    const parsed = Number(match[0]);
    const exact = exactIntegerStatus(match[0]);
    if (!Number.isFinite(parsed)
        || (exact.integer && !exact.safe)
        || (!exact.integer && Number.isInteger(parsed))) invalid();
    return parsed;
  };
  whitespace();
  const parsed = value(0);
  whitespace();
  if (at !== source.length) invalid();
  return parsed;
}

function parseStrictJsonString(source, options = {}) {
  const maximum = options.maxBytes === undefined ? 128 * 1024 : options.maxBytes;
  if (!Number.isSafeInteger(maximum) || maximum < 1
      || !isScalarString(source, { max:maximum })) throw new Error('invalid JSON input');
  return parseStrictJsonBytes(Buffer.from(source, 'utf8'), options);
}

function clonePlainJson(value, { maxBytes = 128 * 1024, maxDepth = 16, maxValues = 4096 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxDepth) || maxDepth < 1
      || !Number.isSafeInteger(maxValues) || maxValues < 1) throw new Error('invalid JSON value');
  let values = 0;
  const stack = new WeakSet();
  const copy = (current, depth) => {
    values += 1;
    if (values > maxValues || depth > maxDepth) throw new Error('invalid JSON value');
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || (Number.isInteger(current) && !Number.isSafeInteger(current))) {
        throw new Error('invalid JSON value');
      }
      return current;
    }
    if (typeof current === 'string') {
      if (!isScalarString(current, { max:maxBytes })) throw new Error('invalid JSON value');
      return current;
    }
    if (!current || typeof current !== 'object' || stack.has(current)) throw new Error('invalid JSON value');
    stack.add(current);
    try {
      if (Array.isArray(current)) {
        if (!Number.isSafeInteger(current.length) || Reflect.ownKeys(current).length !== current.length + 1) {
          throw new Error('invalid JSON value');
        }
        const result = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
            throw new Error('invalid JSON value');
          }
          result.push(copy(descriptor.value, depth + 1));
        }
        return result;
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(current))) throw new Error('invalid JSON value');
      const result = {};
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key)
            || !isScalarString(key, { max:256, control:true })) throw new Error('invalid JSON value');
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw new Error('invalid JSON value');
        }
        result[key] = copy(descriptor.value, depth + 1);
      }
      return result;
    } finally { stack.delete(current); }
  };
  const cloned = copy(value, 0);
  const bytes = Buffer.from(JSON.stringify(cloned), 'utf8');
  if (bytes.byteLength > maxBytes) throw new Error('invalid JSON value');
  return Object.freeze({ value:cloned, bytes });
}

function encodePlainJson(value, options) { return clonePlainJson(value, options).bytes; }

module.exports = Object.freeze({ clonePlainJson, encodePlainJson, isScalarString,
  parseStrictJsonBytes, parseStrictJsonString });
