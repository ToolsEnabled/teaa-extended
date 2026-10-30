'use strict';

// Official Pi operations preserve matching and result generation. Delivered
// windows and original changed spans use the registered host native entry.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const UNKNOWN_CODES = new Set([
  'BYTE_PUBLICATION_UNCONFIRMED',
  'BYTE_IDEMPOTENCY_UNRESOLVED',
  'BYTE_RECOVERY_UNRESOLVED',
  'BYTE_PUBLICATION_COMMITTED_SCOPE_REVOKED'
]);

class HostEditError extends Error {
  constructor(code, message, outcome, publicationCommitted, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'HostEditError';
    this.code = code;
    this.outcome = outcome;
    this.publicationCommitted = publicationCommitted;
  }
}

function fail(code, message, outcome = 'no', publicationCommitted = false, cause) {
  throw new HostEditError(code, message, outcome, publicationCommitted, cause);
}

function hostControl() {
  return require('./host-control');
}

function fileContexts() {
  return require('../file-tool-context');
}

function piPackageFile() {
  // An explicitly selected official package must not silently fall back.
  const explicit = process.env.FLEET_PI_PACKAGE;
  if (typeof explicit === 'string' && explicit.length > 0)
    return path.isAbsolute(explicit) && fs.existsSync(explicit) ? explicit : null;
  // Extensions execute inside the official Pi CLI. Resolve from that native
  // entry so an exported Fleet package needs no development validation tree.
  if (process.argv[1]) {
    try {
      const nativeEntry = fs.realpathSync(path.resolve(process.argv[1]));
      // Pi exposes an ESM-only package export; require.resolve cannot use it.
      // Its native bin may be bundled, so find the owning package metadata.
      for (let directory = path.dirname(nativeEntry);;) {
        const manifestFile = path.join(directory, 'package.json');
        if (fs.existsSync(manifestFile)) {
          const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
          if (manifest.name === '@earendil-works/pi-coding-agent' && typeof manifest.main === 'string') {
            const entry = path.resolve(directory, manifest.main);
            if (entry.startsWith(directory + path.sep) && fs.existsSync(entry)) return entry;
          }
        }
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    } catch { /* SDK tests or other hosts can use an explicit package path. */ }
  }
  const validation = path.join(__dirname, '../../../validation/pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  return fs.existsSync(validation) ? validation : null;
}

let officialPromise;
function officialPi() {
  if (!officialPromise) {
    const file = piPackageFile();
    if (!file) {
      officialPromise = Promise.reject(new HostEditError(
        'PI_PACKAGE_ABSENT',
        'Official @earendil-works/pi-coding-agent 1.4.0 could not be resolved from the native Pi CLI or FLEET_PI_PACKAGE.',
        'no',
        false
      ));
    } else {
      officialPromise = import(pathToFileURL(file).href);
    }
  }
  return officialPromise;
}

function truncateModule() {
  const file = piPackageFile();
  if (!file) fail('PI_PACKAGE_ABSENT', 'Official Pi could not be resolved from the native Pi CLI or FLEET_PI_PACKAGE.');
  return import(pathToFileURL(path.join(path.dirname(file), 'core/tools/truncate.js')).href);
}

function openHostClient({ harness, workspace } = {}) {
  if (harness !== 'pi' && harness !== 'grok' && harness !== 'agy') {
    fail('NATIVE_HARNESS_UNKNOWN', 'Harness must be pi, grok or agy.');
  }
  const stateRoot = process.env.TOOLSENABLED_STATE_ROOT;
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)) {
    fail('TOOLSENABLED_STATE_ROOT_REQUIRED', 'TOOLSENABLED_STATE_ROOT must already be an absolute path. This adapter does not open another store.');
  }
  const contexts = fileContexts();
  const context = contexts.createFileToolContext({ scopeKind: 'standalone-mcp' });
  const root = typeof workspace === 'string' && workspace.length > 0 ? path.resolve(workspace) : process.cwd();
  const host = hostControl().hostCoordination.openNativeSession(context, [{ path: root, directory: true }]);
  const binding = contexts.requireFileToolContext(context);
  return {
    harness,
    workspace: typeof workspace === 'string' && workspace.length > 0 ? path.resolve(workspace) : process.cwd(),
    context,
    authority: host.authority,
    execution: host.execution,
    session: host.session,
    close: () => contexts.retireFileToolContext(context, 'native-client-closed'),
    binding,
    runtimeScopeId: binding.runtimeScopeId
  };
}

function coordinationStorePath() {
  const root = process.env.TOOLSENABLED_STATE_ROOT;
  if (typeof root !== 'string' || !path.isAbsolute(root)) return null;
  return path.join(root, 'state', 'byte-coordination-host', 'data.sqlite');
}

function countReadReceipts(scopeId) {
  const file = coordinationStorePath();
  if (!file || !fs.existsSync(file)) return 0;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE scope_id = ? AND json_extract(receipt_json, '$.op') = 'read'").get(scopeId);
    return row ? row.n : 0;
  } finally {
    db.close();
  }
}

function operationRows(scopeId) {
  const file = coordinationStorePath();
  if (!file || !fs.existsSync(file)) return [];
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT id, status, operation_json FROM operations').all().map(row => {
      const operation = JSON.parse(row.operation_json);
      if (scopeId && operation.binding && operation.binding.runtimeScopeId !== scopeId) return null;
      return { id: row.id, status: row.status, operation };
    }).filter(Boolean);
  } finally {
    db.close();
  }
}

function mapFailure(error) {
  if (error instanceof HostEditError) return error;
  const code = error && typeof error.code === 'string' ? error.code : 'EDIT_FAILED';
  if (code === 'BYTE_PUBLICATION_COMMITTED_SCOPE_REVOKED') {
    return new HostEditError(code, error.message, 'unknown', true, error);
  }
  if (UNKNOWN_CODES.has(code)) {
    return new HostEditError(code, error.message, 'unknown', 'unknown', error);
  }
  return new HostEditError(code, error && error.message ? error.message : 'The edit was not published.', 'no', false, error);
}

function heldAgy(client) {
  if (!client || client.harness !== 'agy') return false;
  const descriptor = require('../../../config/agents/agy.json');
  const held = descriptor && descriptor.worker && descriptor.worker.held;
  fail('AGY_WORKER_HELD', typeof held === 'string' && held.trim() ? held : 'AGY workers are held. Nothing was read or published.');
}

function denyHook(hook) {
  if (!hook) return;
  const classified = require('./native-harness-adapters').classifyGrokHook(hook);
  if (classified && classified.blocksTool) {
    fail('GROK_HOOK_DENIED', 'The Grok hook denied the tool before any read or publication. A fail-open hook is not a grant.');
  }
}

function splitKeep(buffer) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a) {
      lines.push(buffer.subarray(start, index + 1));
      start = index + 1;
    }
  }
  if (start < buffer.length || lines.length === 0) lines.push(buffer.subarray(start));
  return lines;
}

function myersEdits(left, right, equal) {
  const width = left.length;
  const height = right.length;
  const max = width + height;
  const offset = max;
  const v = new Int32Array((2 * max) + 1);
  const trace = [];
  v[offset + 1] = 0;
  for (let depth = 0; depth <= max; depth += 1) {
    for (let k = -depth; k <= depth; k += 2) {
      let x;
      if (k === -depth || (k !== depth && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < width && y < height && equal(left[x], right[y])) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= width && y >= height) {
        trace.push(v.slice());
        return backtrack(trace, width, height, depth, offset);
      }
    }
    trace.push(v.slice());
  }
  fail('EDIT_DIFF_FAILED', 'The official before and after bytes could not be diffed.');
}

function backtrack(trace, width, height, depth, offset) {
  let x = width;
  let y = height;
  const edits = [];
  for (let d = depth; d > 0; d -= 1) {
    const current = trace[d];
    const previous = trace[d - 1];
    const k = x - y;
    const prevK = (k === -d || (k !== d && previous[offset + k - 1] < previous[offset + k + 1])) ? k + 1 : k - 1;
    const prevX = previous[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      edits.push({ kind: 'equal' });
    }
    if (x === prevX) {
      y -= 1;
      edits.push({ kind: 'insert' });
    } else {
      x -= 1;
      edits.push({ kind: 'delete' });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    edits.push({ kind: 'equal' });
  }
  while (x > 0) {
    x -= 1;
    edits.push({ kind: 'delete' });
  }
  while (y > 0) {
    y -= 1;
    edits.push({ kind: 'insert' });
  }
  edits.reverse();
  return edits;
}

function regionsFromEdits(edits) {
  const regions = [];
  let beforeAt = 0;
  let afterAt = 0;
  let open = null;
  const flush = () => {
    if (!open) return;
    regions.push(open);
    open = null;
  };
  for (const edit of edits) {
    if (edit.kind === 'equal') {
      flush();
      beforeAt += 1;
      afterAt += 1;
      continue;
    }
    if (!open) open = { beforeStart: beforeAt, beforeEnd: beforeAt, afterStart: afterAt, afterEnd: afterAt };
    if (edit.kind === 'delete') {
      beforeAt += 1;
      open.beforeEnd = beforeAt;
    } else {
      afterAt += 1;
      open.afterEnd = afterAt;
    }
  }
  flush();
  return regions;
}

function changedRegions(left, right, equal) {
  if (left.length === right.length && left.every((item, index) => equal(item, right[index]))) return [];
  return regionsFromEdits(myersEdits(left, right, equal));
}

function lineStarts(lines) {
  const starts = [0];
  for (const line of lines) starts.push(starts[starts.length - 1] + line.length);
  return starts;
}

function changedSpans(before, after) {
  if (before.equals(after)) return [];
  const beforeLines = splitKeep(before);
  const afterLines = splitKeep(after);
  const beforeAt = lineStarts(beforeLines);
  const afterAt = lineStarts(afterLines);
  const spans = [];
  for (const region of changedRegions(beforeLines, afterLines, (left, right) => left.equals(right))) {
    const origin = beforeAt[region.beforeStart];
    const left = before.subarray(origin, beforeAt[region.beforeEnd]);
    const right = after.subarray(afterAt[region.afterStart], afterAt[region.afterEnd]);
    for (const piece of changedRegions([...left], [...right], (one, other) => one === other)) {
      const replacement = Buffer.from(right.subarray(piece.afterStart, piece.afterEnd));
      if (piece.beforeEnd === piece.beforeStart && replacement.length === 0) continue;
      spans.push({
        startByte: origin + piece.beforeStart,
        endByte: origin + piece.beforeEnd,
        replacement
      });
    }
  }
  return spans;
}

// Retain keyed operation sessions for uncertain/idempotent replays. Their byte
// scope remains the registered client's scope; cancellation is operation-local.
// The registered context, rather than an individual edit, owns scope retirement.
const cancellableOperations = new WeakMap();

function editExecution(client, filePath, idempotencyKey, signal) {
  const keyed = typeof idempotencyKey === 'string';
  let retained = cancellableOperations.get(client);
  const existing = keyed && retained?.get(idempotencyKey);
  if (existing) return existing;
  if (!signal) return { execution: client.execution, session: client.session };
  // The per-edit entry cannot widen the existing client's resource grant.
  client.execution.admit(client.session.grant, { action: 'commit', resource: filePath });
  const operation = hostControl().hostCoordination.openNativeSession(client.context, [
    { path: path.resolve(filePath), directory: false }
  ]);
  if (keyed) {
    if (!retained) cancellableOperations.set(client, retained = new Map());
    retained.set(idempotencyKey, operation);
  }
  return operation;
}

async function commitDisjointEdit(client, { path: filePath, before, after, idempotencyKey } = {}, signal) {
  heldAgy(client);
  if (!Buffer.isBuffer(before) || !Buffer.isBuffer(after)) fail('EDIT_BYTES_REQUIRED', 'The official edit needs the bytes it read and the bytes it asked to write.');
  const spans = changedSpans(before, after);
  if (spans.length === 0) return { spans, published: false, unchanged: true };
  let cancel;
  try {
    const operation = editExecution(client, filePath, idempotencyKey, signal);
    cancel = () => operation.execution.cancel(operation.session);
    signal?.addEventListener('abort', cancel, { once: true });
    // No asynchronous gap between registering and checking an earlier abort.
    if (signal?.aborted) cancel();
    const result = await operation.execution.commit(operation.session, {
      edits: spans.map(span => ({ ...span, resource: filePath,
        baseSha256: require('node:crypto').createHash('sha256').update(before).digest('hex') })),
      idempotencyKey
    });
    if (result.outcome !== 'confirmed') {
      fail(result.reason, `Native publication ${result.outcome}: ${result.reason}`, result.outcome, result.publicationCommitted);
    }
    releaseConfirmed(client, idempotencyKey);
    return { ...result, spans, published: true, unchanged: false };
  } catch (error) {
    throw mapFailure(error);
  } finally {
    if (cancel) signal?.removeEventListener('abort', cancel);
  }
}

// A confirmed keyed edit has durable proof for any replay (the authority's
// idempotency record), so its retained per-edit session is not needed. Keep
// unknown and cancelled outcomes, whose replay depends on the retained session.
function releaseConfirmed(client, idempotencyKey) {
  if (typeof idempotencyKey === 'string') cancellableOperations.get(client)?.delete(idempotencyKey);
}

function materializeBytes(filePath) {
  const snapshot = hostControl().hostCoordination.materialize(filePath);
  if (!snapshot || snapshot.present === false || !Buffer.isBuffer(snapshot.bytes)) {
    fail('BYTE_RESOURCE_ABSENT', 'The file is absent.');
  }
  return Buffer.from(snapshot.bytes);
}

async function deliveredRange(buffer, { offset, limit } = {}) {
  const text = buffer.toString('utf8');
  const lines = text.split('\n');
  const startLine = offset ? Math.max(0, offset - 1) : 0;
  if (startLine >= lines.length) {
    fail('READ_OFFSET', `Offset ${offset} is beyond end of file (${lines.length} lines total).`);
  }
  const selected = limit === undefined
    ? lines.slice(startLine).join('\n')
    : lines.slice(startLine, Math.min(startLine + limit, lines.length)).join('\n');
  const { truncateHead } = await truncateModule();
  const truncation = truncateHead(selected);
  if (truncation.firstLineExceedsLimit) return { observe: false };
  const delivered = truncation.content;
  const startByte = startLine === 0 ? 0 : Buffer.byteLength(`${lines.slice(0, startLine).join('\n')}\n`, 'utf8');
  const endByte = startByte + Buffer.byteLength(delivered, 'utf8');
  if (buffer.subarray(startByte, endByte).toString('utf8') !== delivered) {
    fail('READ_RANGE_MISMATCH', 'The delivered text is not a byte range of the file that was read.');
  }
  return { observe: true, startByte, endByte };
}

async function readVisible(client, params = {}, signal, options = {}) {
  heldAgy(client);
  const coding = await officialPi();
  let captured = null;
  let image = false;
  const tool = coding.createReadToolDefinition(client.workspace, {
    operations: {
      detectImageMimeType: async filePath => {
        materializeBytes(filePath);
        const official = piPackageFile();
        const mime = await import(pathToFileURL(path.join(path.dirname(official), 'utils/mime.js')).href);
        const type = await mime.detectSupportedImageMimeTypeFromFile(filePath);
        image = Boolean(type);
        return type;
      },
      readFile: async (filePath) => {
        const bytes = materializeBytes(filePath);
        captured = { filePath, bytes };
        return bytes;
      },
      access: async (filePath) => {
        await fs.promises.access(filePath, fs.constants.R_OK);
      }
    }
  });
  const result = await tool.execute(options.toolCallId || 'read', params, signal, options.onUpdate, options.context);
  if (!captured || image) return result;
  const range = await deliveredRange(captured.bytes, params);
  if (!range.observe) return result;
  try {
    await client.execution.observeDelivered(client.session, {
      resource: captured.filePath,
      startByte: range.startByte,
      endByte: range.endByte,
      delivered: Buffer.from(captured.bytes.subarray(range.startByte, range.endByte))
    });
  } catch (error) {
    throw mapFailure(error);
  }
  return result;
}

async function editOfficial(client, params = {}, signal, options = {}) {
  heldAgy(client);
  denyHook(options.hook);
  const coding = await officialPi();
  let readBuffer = null;
  let readPath = null;
  let publication = null;
  const tool = coding.createEditToolDefinition(client.workspace, {
    operations: {
      readFile: async (filePath) => {
        readBuffer = materializeBytes(filePath);
        readPath = filePath;
        return readBuffer;
      },
      writeFile: async (filePath, content) => {
        if (!readBuffer || filePath !== readPath) {
          fail('EDIT_READ_MISSING', 'The official edit asked to write a file it had not just read.');
        }
        publication = commitDisjointEdit(client, {
          path: filePath,
          before: readBuffer,
          after: Buffer.from(content, 'utf8'),
          idempotencyKey: options.idempotencyKey || options.toolCallId
        }, signal);
        await publication;
      },
      access: async (filePath) => {
        await fs.promises.access(filePath, fs.constants.R_OK);
      }
    }
  });
  try {
    return await tool.execute(options.toolCallId || 'edit', params, signal, options.onUpdate, options.context);
  } catch (error) {
    if (signal?.aborted && publication) {
      // Pi may reject its tool promise while writeFile is still in flight.
      // Settle that exact publication; never retry or compensate on abort.
      try { await publication; }
      catch (failure) { throw mapFailure(failure); }
      fail('PI_CANCELLED_AFTER_COMMIT', error.message, 'confirmed', true, error);
    }
    throw error;
  }
}

module.exports = {
  retainedOperationCountForTests: client => cancellableOperations.get(client)?.size || 0,
  HostEditError,
  openHostClient,
  readVisible,
  editOfficial,
  commitDisjointEdit,
  changedSpans,
  countReadReceipts,
  operationRows,
  coordinationStorePath,
  piPackageFile
};
