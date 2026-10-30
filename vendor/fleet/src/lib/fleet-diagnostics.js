'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const recorded = new WeakMap();
function safeText(value) {
  const text = String(value ?? '');
  return require('./audit').scrubText(text, Math.max(1, text.length));
}
function diagnosticFor(error) { return error && typeof error === 'object' ? recorded.get(error) || null : null; }
function recordInternalError(error, { root, tool, action, nodeId } = {}) {
  const existing = diagnosticFor(error); if (existing) return existing;
  const seen = new Set();
  const describe = value => {
    if (!value || typeof value !== 'object') return { message: safeText(value) };
    if (seen.has(value)) return { message: '[cyclic cause]' };
    seen.add(value);
    return { name: safeText(value.name || 'Error'), message: safeText(value.message),
      ...(typeof value.code === 'string' ? { code: safeText(value.code) } : {}),
      ...(value.stack ? { stack: safeText(value.stack) } : {}),
      ...(value.cause ? { cause: describe(value.cause) } : {}) };
  };
  const folder = path.join(root || require('./runtime-state-root').stateRoot(), 'logs');
  const file = path.join(folder, 'fleet-errors.jsonl'), id = crypto.randomUUID();
  try {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify({ id, at: new Date().toISOString(), pid: process.pid,
      ...(tool ? { tool: safeText(tool) } : {}), ...(action ? { action: safeText(action) } : {}),
      ...(nodeId ? { nodeId: safeText(nodeId) } : {}), error: describe(error) }) + '\n', { mode: 0o600 });
    const result = { id, file, recorded: true };
    if (error && typeof error === 'object') recorded.set(error, result);
    return result;
  } catch (failure) {
    process.stderr.write(`[Fleet] diagnostic ${id} could not be retained (${failure.code || 'WRITE_FAILED'}).\n`);
    return { id, recorded: false };
  }
}
function linkDiagnostic(error, diagnostic) { if (error && diagnostic) recorded.set(error, diagnostic); }
module.exports = { safeText, recordInternalError, diagnosticFor, linkDiagnostic };
