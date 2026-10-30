'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { normalize } = require('./fleet-folder-scope');
const fail = message => Object.assign(new Error(message), { code: 'FLEET_PARENT_SCOPE_UNAVAILABLE' });
function readScope(stateRoot) {
  const file = path.join(stateRoot, 'host-mode.json');
  // Inspect Windows ACLs before opening the snapshot: the native security
  // helper can take seconds, and a held reader blocks Windows replacement.
  // The opened identity must still match the entry whose ACLs were inspected.
  const checked = process.platform === 'win32'
    ? require('./windows-state-security').assertEntry(file, false) : null;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384 || process.platform !== 'win32' &&
      ((stat.mode & 0o077) || stat.uid !== process.getuid())) throw fail('The parent policy record must be a bounded private file.');
    if (checked) {
      if (checked.dev !== stat.dev || checked.ino !== stat.ino) throw fail('The parent policy record changed during validation.');
    }
    const config = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (config.profile !== 'fleetV2' || config.setupKind === 'plugin') throw fail('The parent policy is no longer an explicit FleetV2 standalone record.');
    return normalize(config.fleetV2Scope);
  } finally { fs.closeSync(fd); }
}
function createScopeRefresh({ initialScope, read, update, intervalMs = 500, onError = () => {} }) {
  let current = normalize(initialScope), chain = Promise.resolve(), closed = false, timer, faultReported = false;
  function refresh() {
    const result = chain.then(async () => {
      if (closed) return;
      const next = await read();
      if (next.revision < current.revision) throw fail('The parent policy revision moved backwards.');
      if (next.revision === current.revision) {
        if (JSON.stringify(next) !== JSON.stringify(current)) throw fail('Parent policy changed without a new revision.');
        return;
      }
      await update(next);
      current = next;
    });
    chain = result.catch(() => {});
    return result;
  }
  if (intervalMs > 0) { timer = setInterval(() => refresh().then(() => { faultReported = false; }, error => { if (!faultReported) { faultReported = true; Promise.resolve(onError(error)).catch(() => {}); } }), intervalMs); timer.unref?.(); }
  return { refresh, close: async () => { closed = true; clearInterval(timer); await chain; } };
}
module.exports = { readScope, createScopeRefresh };
