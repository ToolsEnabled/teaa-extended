'use strict';

// Private composition scope. This is deliberately independent of provider
// approvalPolicy and Fleet tool levels. No wire request can establish it.
const { AsyncLocalStorage } = require('node:async_hooks');
const fs = require('node:fs');
const path = require('node:path');
const context = new AsyncLocalStorage();
const fail = (code, message) => Object.assign(new Error(message), { code });
function normalize(scope) {
  if (!scope || !Array.isArray(scope.readRoots) || !Array.isArray(scope.writeRoots)
      || typeof scope.source !== 'string' || !scope.source || !Number.isSafeInteger(scope.revision) || scope.revision < 1)
    throw fail('FLEET_FOLDER_SCOPE_UNAVAILABLE', 'A qualified parent folder scope is required before launching a bypass worker.');
  const roots = values => Object.freeze([...new Set(values.map(value => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0'))
      throw fail('FLEET_FOLDER_SCOPE_INVALID', 'Folder boundaries require absolute physical paths.');
    const physical = fs.realpathSync(value);
    if (physical !== path.resolve(value)) throw fail('FLEET_FOLDER_SCOPE_INVALID', 'Folder boundaries cannot contain aliases.');
    return physical;
  }))].sort());
  if (scope.readAll !== undefined && typeof scope.readAll !== 'boolean') throw fail('FLEET_FOLDER_SCOPE_INVALID', 'readAll must be an explicit boolean.');
  return Object.freeze({ readRoots: roots(scope.readRoots), writeRoots: roots(scope.writeRoots),
    ...(scope.readAll === true ? { readAll: true } : {}),
    revision: scope.revision, source: scope.source });
}
function run(scope, operation) { return context.run(normalize(scope), operation); }
function current() { return context.getStore() || null; }
function unrestricted(scope) {
  // A single Windows drive root does not include other volumes or UNC shares.
  if (process.platform === 'win32') return false;
  return scope.readRoots.includes(path.parse(process.cwd()).root)
    && scope.writeRoots.includes(path.parse(process.cwd()).root);
}
module.exports = Object.freeze({ normalize, run, current, unrestricted });
