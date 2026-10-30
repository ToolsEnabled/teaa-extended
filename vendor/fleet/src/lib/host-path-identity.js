'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Windows realpathSync can preserve the caller's letter case. Resolve links
// with the native implementation when available, then compare Windows names
// without case. Linux identities retain their existing case-sensitive rules.
function resolvedPath(file, { platform = process.platform, realpath = fs.realpathSync, allowMissing = false } = {}) {
  if (typeof file !== 'string' || !file || file.includes('\0')) return null;
  const resolve = platform === 'win32' && typeof realpath.native === 'function' ? realpath.native : realpath;
  let resolved;
  try { resolved = resolve(file); }
  catch (error) {
    if (!allowMissing || error.code !== 'ENOENT') throw error;
    // Setup also compares the names of state/workspace directories it has
    // not created yet. Runtime admission below always requires real paths.
    resolved = path.resolve(file);
  }
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left, right, { platform = process.platform, resolve = true, ...options } = {}) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (platform !== 'win32') return left === right;
  if (!resolve) return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  return resolvedPath(left, { ...options, platform, allowMissing: true }) === resolvedPath(right, { ...options, platform, allowMissing: true });
}

function sameRealPath(left, right, options = {}) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  try {
    const resolved = resolvedPath(left, options);
    return resolved !== null && resolved === resolvedPath(right, options);
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

module.exports = { resolvedPath, samePath, sameRealPath };
