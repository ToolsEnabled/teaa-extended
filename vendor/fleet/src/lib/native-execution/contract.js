'use strict';

// Shared native execution contract. Callers pass the existing ByteAuthority.
// This module does not open its own coordination database and does not fence
// writers that never call it.

const crypto = require('node:crypto');
const path = require('node:path');
const { ByteCoordinationRefusal, intersects } = require('../region-holds/byte-authority');

const CONTRACT = 'v4-native-execution/1';
const MAX_EDITS = 32;
const MAX_RESOURCES = 32;
const MAX_ALTERNATE = 256;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ACTIONS = new Set(['observe', 'commit', 'delegate', 'account-alternate', 'cancel', 'recover']);
const ALTERNATE_KINDS = new Set(['shell', 'subprocess', 'formatter', 'git', 'create', 'delete', 'rename', 'mcp', 'unmanaged']);
const RETRYABLE = new Set(['EDIT_STALE', 'BYTE_READ_SET_STALE', 'BYTE_READ_REQUIRED', 'BYTE_AUTHORITY_BUSY', 'BYTE_RESOURCE_ABSENT']);
const CLEAN = new Set([
  'EDIT_OVERLAP', 'EDIT_STALE', 'EDIT_RANGE', 'EDIT_LIMIT', 'GRANT_NARROWER', 'GRANT_UNISSUED',
  'GRANT_EXPIRED', 'CANCELLED', 'SESSION_CLOSED', 'SESSION_MISMATCH', 'BYTE_READ_SET_STALE',
  'BYTE_READ_REQUIRED', 'BYTE_RESOURCE_ABSENT', 'BYTE_RANGE_INVALID', 'BYTE_PATCH_INVALID',
  'BYTE_AUTHORITY_BUSY', 'BYTE_CREATE_CONFLICT', 'ACCOUNT_LIMIT', 'BYTE_IDEMPOTENCY_CONFLICT',
  'MULTI_RESOURCE_NOT_ATOMIC'
]);

const COVERAGE = Object.freeze({
  schemaVersion: 1,
  contract: CONTRACT,
  byteAuthority: 'existing-ByteAuthority',
  osWideInterception: false,
  failOpenHooksAreMandatoryBoundary: false,
  postWriteNotificationIsMandatoryMediation: false,
  nativePermissionsChanged: false,
  multiResourceAtomic: false,
  compensatingRollback: false,
  bookkeepingGrantIsNativePermission: false,
  hmacProofIsNativePermission: false,
  writers: Object.freeze({
    'contract-observe': Object.freeze({ mediated: true, mechanism: 'ByteAuthority.observeRead' }),
    'contract-commit': Object.freeze({ mediated: true, mechanism: 'ByteAuthority.applyPatch' }),
    'internal-reread': Object.freeze({ mediated: false, createsAgentObservation: false, mechanism: 'authority.materialize' }),
    shell: Object.freeze({ mediated: false, intercepted: false, accounted: true }),
    subprocess: Object.freeze({ mediated: false, intercepted: false, accounted: true }),
    formatter: Object.freeze({ mediated: false, intercepted: false, accounted: true }),
    git: Object.freeze({ mediated: false, intercepted: false, accounted: true }),
    create: Object.freeze({ mediated: false, intercepted: false, accounted: true }),
    delete: Object.freeze({ mediated: false, intercepted: false, accounted: true }),
    rename: Object.freeze({ mediated: false, intercepted: false, accounted: true }),
    mcp: Object.freeze({ mediated: false, intercepted: false, accounted: true }),
    unmanaged: Object.freeze({ mediated: false, intercepted: false, accounted: true })
  })
});

const LIMITS = Object.freeze({ maxEdits: MAX_EDITS, maxResources: MAX_RESOURCES, maxAlternateRecords: MAX_ALTERNATE });

class NativeExecutionRefusal extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'NativeExecutionRefusal';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function refuse(code, message, details) {
  throw new NativeExecutionRefusal(code, message, details);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function identifier(value, field) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) refuse('ADAPTER_INVALID', `The ${field} is not a coordination identifier.`);
  return value;
}

function createNativeExecution({ authority, now = () => Date.now(), trace } = {}) {
  if (!authority || ['observeRead', 'applyPatch', 'applyWrite', 'observeAbsence', 'recoverPending', 'closeLaunch', 'materialize', 'describeScope', 'recallIdempotency'].some(name => typeof authority[name] !== 'function')) {
    refuse('ADAPTER_INVALID', 'Pass the existing ByteAuthority instance. This contract does not construct another byte engine.');
  }
  if (typeof now !== 'function') refuse('ADAPTER_INVALID', 'The contract clock must be a function.');
  const secret = crypto.randomBytes(32);
  const sessions = new Map();
  const attempts = new Map();

  function note(event) {
    if (Array.isArray(trace)) trace.push(event);
  }

  function clock() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) refuse('ADAPTER_INVALID', 'The contract clock is unavailable.');
    return value;
  }

  function grantBody(grant) {
    return JSON.stringify({
      schemaVersion: 1,
      grantId: grant.grantId,
      parentGrantId: grant.parentGrantId,
      sessionId: grant.sessionId,
      principal: grant.principal,
      actions: grant.actions,
      resources: grant.resources,
      expiresAtMs: grant.expiresAtMs,
      permissionSource: grant.permissionSource,
      nativePermission: false,
      osPermission: false
    });
  }

  function sign(body) {
    return crypto.createHmac('sha256', secret).update(body).digest();
  }

  // GATE: grant proof. Adapters cannot invent permission by omitting this check.
  function proofsMatch(expected, proof) {
    if (typeof proof !== 'string' || !SHA256.test(proof)) return false;
    return crypto.timingSafeEqual(expected, Buffer.from(proof, 'hex'));
  }

  function verifyProof(grant) {
    if (!grant || typeof grant !== 'object' || !proofsMatch(sign(grantBody(grant)), grant.proof)) {
      refuse('GRANT_UNISSUED', 'The grant was not issued by this execution contract.');
    }
  }

  function normalizeResource(entry) {
    if (typeof entry === 'string') return Object.freeze({ path: path.resolve(entry), directory: false });
    if (!entry || typeof entry.path !== 'string' || !path.isAbsolute(entry.path) || entry.path.includes('\0') || typeof entry.directory !== 'boolean') {
      refuse('ADAPTER_INVALID', 'A grant resource needs an absolute path and a directory flag.');
    }
    return Object.freeze({ path: path.resolve(entry.path), directory: entry.directory });
  }

  function resourceSort(left, right) {
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    return Number(left.directory) - Number(right.directory);
  }

  function covers(entry, resource) {
    if (resource.path === entry.path) return entry.directory || !resource.directory;
    return entry.directory && resource.path.startsWith(entry.path + path.sep);
  }

  function issue(fields) {
    if (fields.permissionSource !== 'in-process-bookkeeping' && fields.permissionSource !== 'transport-file-scope') {
      refuse('ADAPTER_INVALID', 'A grant must name its bookkeeping or transport source. This proof is not native or OS permission.');
    }
    const grant = {
      schemaVersion: 1,
      grantId: 'grant-' + crypto.randomUUID(),
      parentGrantId: fields.parentGrantId,
      sessionId: fields.sessionId,
      principal: fields.principal,
      actions: Object.freeze([...new Set(fields.actions)].sort()),
      resources: Object.freeze(fields.resources.map(normalizeResource).sort(resourceSort)),
      expiresAtMs: fields.expiresAtMs ?? null,
      permissionSource: fields.permissionSource,
      nativePermission: false,
      osPermission: false
    };
    grant.proof = sign(grantBody(grant)).toString('hex');
    return Object.freeze(grant);
  }

  function checkActions(actions) {
    if (!Array.isArray(actions) || actions.length === 0 || actions.some(action => !ACTIONS.has(action))) {
      refuse('ADAPTER_INVALID', 'Name at least one supported grant action.');
    }
    return actions;
  }

  function admit(grant, { action, resource } = {}) {
    verifyProof(grant);
    if (!ACTIONS.has(action)) refuse('ADAPTER_INVALID', 'The admission action is not part of this contract.');
    if (grant.expiresAtMs != null && clock() >= grant.expiresAtMs) refuse('GRANT_EXPIRED', 'The grant has expired.');
    if (!grant.actions.includes(action)) refuse('GRANT_NARROWER', 'The grant does not include that action.');
    if (resource !== undefined) {
      const target = path.resolve(resource);
      const allowed = grant.resources.some(entry => entry.directory
        ? target === entry.path || target.startsWith(entry.path + path.sep)
        : target === entry.path);
      if (!allowed) refuse('GRANT_NARROWER', 'The grant does not include that resource.');
    }
    note('admit:' + action);
    return Object.freeze({ admitted: true, grantId: grant.grantId, action });
  }

  function delegate(grant, input = {}) {
    verifyProof(grant);
    if (!grant.actions.includes('delegate')) refuse('GRANT_NARROWER', 'The grant cannot delegate.');
    const actions = checkActions(input.actions);
    if (actions.some(action => !grant.actions.includes(action))) refuse('GRANT_NARROWER', 'A delegation cannot add an action.');
    if (!Array.isArray(input.resources) || input.resources.length === 0) refuse('ADAPTER_INVALID', 'A delegation must name its resources.');
    const resources = input.resources.map(normalizeResource);
    if (resources.some(resource => !grant.resources.some(entry => covers(entry, resource)))) {
      refuse('GRANT_NARROWER', 'A delegation cannot add a resource.');
    }
    const sessionId = identifier(input.sessionId, 'sessionId');
    const principal = identifier(input.principal, 'principal');
    if (input.expiresAtMs != null && (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs < 0)) {
      refuse('ADAPTER_INVALID', 'expiresAtMs must be a non-negative integer.');
    }
    const expiresAtMs = input.expiresAtMs === undefined ? grant.expiresAtMs : input.expiresAtMs;
    if (grant.expiresAtMs != null && (expiresAtMs == null || expiresAtMs > grant.expiresAtMs)) {
      refuse('GRANT_NARROWER', 'A delegation cannot extend the parent expiry.');
    }
    return issue({ parentGrantId: grant.grantId, sessionId, principal, actions, resources, expiresAtMs, permissionSource: grant.permissionSource });
  }

  function callerAuthorization(input) {
    if (['authorization', 'nativePermission', 'osPermission', 'permissionSource'].some(name => input[name] !== undefined)) {
      refuse('ADAPTER_INVALID', 'A caller cannot select native, OS, or transport authorization.');
    }
  }

  function bindingFor(principal, scopeId, input) {
    return Object.freeze({
      principal,
      runtimeScopeId: scopeId,
      scopeKind: 'standalone-mcp',
      canonicalLaunchId: input.launchId == null ? null : identifier(input.launchId, 'launchId'),
      laneId: input.laneId == null ? null : identifier(input.laneId, 'laneId'),
      runId: input.runId == null ? null : identifier(input.runId, 'runId'),
      rosterRef: null
    });
  }

  function storeSession(session) {
    sessions.set(session.sessionId, session);
    return session;
  }

  function openSession(input = {}) {
    callerAuthorization(input);
    const principal = identifier(input.principal, 'principal');
    const actions = checkActions(input.actions);
    if (!Array.isArray(input.resources) || input.resources.length === 0) refuse('ADAPTER_INVALID', 'A session must name its resources.');
    if (input.expiresAtMs != null && (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs < 0)) {
      refuse('ADAPTER_INVALID', 'expiresAtMs must be a non-negative integer.');
    }
    const sessionId = 'session-' + crypto.randomUUID();
    const scopeId = input.scopeId == null ? 'scope-' + crypto.randomUUID() : identifier(input.scopeId, 'scopeId');
    const session = {
      schemaVersion: 1,
      sessionId,
      parentSessionId: null,
      nestedCallId: null,
      scopeId,
      permissionSource: 'in-process-bookkeeping',
      grant: issue({
        parentGrantId: null,
        sessionId,
        principal,
        actions,
        resources: input.resources,
        expiresAtMs: input.expiresAtMs ?? null,
        permissionSource: 'in-process-bookkeeping'
      }),
      binding: bindingFor(principal, scopeId, input),
      cancelled: false,
      closed: false,
      alternate: []
    };
    note('session-open');
    return storeSession(session);
  }

  function openTransportSession(input = {}) {
    if (['principal', 'authorization', 'nativePermission', 'osPermission', 'permissionSource', 'scopeId', 'actions', 'launchId', 'laneId', 'runId'].some(name => input[name] !== undefined)) {
      refuse('ADAPTER_INVALID', 'Transport identity comes from the registered file-tool context. Caller-selected actions are not native permission.');
    }
    if (!Array.isArray(input.resources) || input.resources.length === 0) refuse('ADAPTER_INVALID', 'A transport session names bookkeeping resources. That list is not an OS permission.');
    let binding;
    try { binding = require('../file-tool-capabilities').requireFileToolContext(input.fileToolContext); }
    catch { refuse('TRANSPORT_SCOPE_REQUIRED', 'A registered transport file-tool context is required. A caller-built object is not native permission.'); }
    const sessionId = 'session-' + crypto.randomUUID();
    const session = {
      schemaVersion: 1,
      sessionId,
      parentSessionId: null,
      nestedCallId: null,
      scopeId: binding.runtimeScopeId,
      permissionSource: 'transport-file-scope',
      grant: issue({
        parentGrantId: null,
        sessionId,
        principal: binding.principal,
        actions: ['observe', 'commit', 'cancel', 'recover'],
        resources: input.resources,
        expiresAtMs: null,
        permissionSource: 'transport-file-scope'
      }),
      binding,
      cancelled: false,
      closed: false,
      alternate: []
    };
    note('session-transport');
    return storeSession(session);
  }

  function live(session) {
    const stored = session && sessions.get(session.sessionId);
    if (!stored || stored !== session) refuse('SESSION_MISMATCH', 'The session is not open in this contract.');
    verifyProof(stored.grant);
    if (stored.grant.sessionId !== stored.sessionId) refuse('GRANT_UNISSUED', 'The grant is not bound to this session.');
    if (stored.closed) refuse('SESSION_CLOSED', 'The session is closed.');
    return stored;
  }

  function forkSession(parent, input = {}) {
    const stored = live(parent);
    const principal = identifier(input.principal, 'principal');
    const sessionId = 'session-' + crypto.randomUUID();
    const scopeId = 'scope-' + crypto.randomUUID();
    const grant = delegate(stored.grant, { ...input, principal, sessionId });
    const child = {
      schemaVersion: 1,
      sessionId,
      parentSessionId: stored.sessionId,
      nestedCallId: null,
      scopeId,
      permissionSource: stored.grant.permissionSource,
      grant,
      binding: bindingFor(principal, scopeId, input),
      cancelled: false,
      closed: false,
      alternate: []
    };
    note('session-fork');
    return storeSession(child);
  }

  function nest(parent, input = {}) {
    const stored = live(parent);
    const principal = identifier(input.principal, 'principal');
    const sessionId = 'session-' + crypto.randomUUID();
    const nestedCallId = 'nest-' + crypto.randomUUID();
    const grant = delegate(stored.grant, { ...input, principal, sessionId });
    const child = {
      schemaVersion: 1,
      sessionId,
      parentSessionId: stored.sessionId,
      nestedCallId,
      scopeId: stored.scopeId,
      permissionSource: stored.grant.permissionSource,
      grant,
      binding: stored.binding,
      cancelled: false,
      closed: false,
      alternate: []
    };
    note('session-nest');
    return storeSession(child);
  }

  function resumeSession(sessionId) {
    const stored = sessions.get(sessionId);
    if (!stored) refuse('RESUME_UNSUPPORTED', 'This process has no such session. Reconnect with the durable scope id; an unseen session is not confirmed.');
    note('resume');
    return stored;
  }

  async function reconnect(input = {}) {
    callerAuthorization(input);
    const scopeId = identifier(input.scopeId, 'scopeId');
    const principal = identifier(input.principal, 'principal');
    const actions = checkActions(input.actions);
    if (!Array.isArray(input.resources) || input.resources.length === 0) refuse('ADAPTER_INVALID', 'A reconnect must name its bookkeeping resources.');
    if (input.expiresAtMs != null && (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs < 0)) {
      refuse('ADAPTER_INVALID', 'expiresAtMs must be a non-negative integer.');
    }
    const binding = bindingFor(principal, scopeId, input);
    const described = await authority.describeScope({ binding });
    if (!described || described.exists !== true) {
      refuse('RESUME_UNSUPPORTED', 'No durable authority scope matches that identity. This contract will not invent a session or confirm an unseen commit.');
    }
    if (described.closed) refuse('SESSION_CLOSED', 'The durable scope is closed.');
    const sessionId = 'session-' + crypto.randomUUID();
    const session = {
      schemaVersion: 1,
      sessionId,
      parentSessionId: null,
      nestedCallId: null,
      scopeId,
      permissionSource: 'in-process-bookkeeping',
      grant: issue({
        parentGrantId: null,
        sessionId,
        principal,
        actions,
        resources: input.resources,
        expiresAtMs: input.expiresAtMs ?? null,
        permissionSource: 'in-process-bookkeeping'
      }),
      binding,
      cancelled: false,
      closed: false,
      alternate: []
    };
    note('reconnect');
    return storeSession(session);
  }

  async function closeSession(session) {
    const stored = live(session);
    stored.closed = true;
    // A nested call shares its parent's byte scope. Closing the call drops
    // the nested grant holder only; it must not retire the parent's receipts.
    if (stored.nestedCallId) {
      note('session-close-nested');
      return Object.freeze({ closed: true, scopeClosed: false, sessionId: stored.sessionId });
    }
    admit(stored.grant, { action: 'commit' });
    note('session-close');
    const closed = await authority.closeLaunch({ binding: stored.binding, reason: 'native-execution-close' });
    return Object.freeze({ ...closed, scopeClosed: true });
  }

  function cancel(session) {
    const stored = live(session);
    if (!stored.grant.actions.includes('cancel') && !stored.grant.actions.includes('commit')) {
      refuse('GRANT_NARROWER', 'The grant cannot cancel this session.');
    }
    stored.cancelled = true;
    note('cancel');
    return Object.freeze({ cancelled: true, sessionId: stored.sessionId });
  }

  async function snapshot(resource) {
    const value = await authority.materialize(path.resolve(resource));
    if (value && value.present === false && (value.bytes === undefined || value.bytes === null)) return { present: false, bytes: null };
    if (!value || !Buffer.isBuffer(value.bytes)) refuse('ADAPTER_INVALID', 'The byte authority did not return a Buffer for the current file.');
    return { present: true, bytes: Buffer.from(value.bytes) };
  }

  async function prove(resource, expected) {
    try {
      const current = await snapshot(resource);
      return Boolean(current.present && expected && current.bytes.equals(expected));
    } catch {
      return false;
    }
  }

  async function observe(session, input = {}) {
    const stored = live(session);
    const resource = path.resolve(input.resource || '');
    admit(stored.grant, { action: 'observe', resource });
    if (input.startByte !== undefined && (!Number.isSafeInteger(input.startByte) || input.startByte < 0)) refuse('ADAPTER_INVALID', 'startByte must be a non-negative integer.');
    if (input.endByte !== undefined && (!Number.isSafeInteger(input.endByte) || input.endByte < 0)) refuse('ADAPTER_INVALID', 'endByte must be a non-negative integer.');
    note('observe');
    const observed = await authority.observeRead({
      binding: stored.binding,
      resource,
      startByte: input.startByte,
      endByte: input.endByte,
      assertCurrent: () => { if (stored.closed) refuse('SESSION_CLOSED', 'The session is closed.'); }
    });
    const receipt = observed.receipt;
    return Object.freeze({
      schemaVersion: 1,
      resource,
      receiptRef: receipt.receiptRef,
      startByte: receipt.startByte,
      endByte: receipt.endByte,
      totalBytes: receipt.totalBytes,
      contentSha256: receipt.contentSha256,
      fileSha256: receipt.fileSha256,
      truncated: receipt.endByte - receipt.startByte < receipt.totalBytes,
      content: observed.bytes,
      invalidations: observed.invalidations
    });
  }

  // A native tool has already rendered its result. Record that window only.
  // A later or different snapshot is not an observation of what was delivered.
  async function observeDelivered(session, input = {}) {
    const stored = live(session);
    const resource = path.resolve(input.resource || '');
    admit(stored.grant, { action: 'observe', resource });
    if (!Number.isSafeInteger(input.startByte) || input.startByte < 0
        || !Number.isSafeInteger(input.endByte) || input.endByte < input.startByte) {
      refuse('ADAPTER_INVALID', 'A delivered observation needs a byte window.');
    }
    if (!Buffer.isBuffer(input.delivered) || input.delivered.length !== input.endByte - input.startByte) {
      refuse('ADAPTER_INVALID', 'delivered must be the exact bytes of that window.');
    }
    callerAuthorization(input);
    note('observe-delivered');
    const delivered = Buffer.from(input.delivered);
    const observed = await authority.observeRead({
      binding: stored.binding,
      resource,
      startByte: input.startByte,
      endByte: input.endByte,
      assertCurrent: () => { if (stored.closed) refuse('SESSION_CLOSED', 'The session is closed.'); },
      // Validation and receipt insertion share the authority's lifetime lock.
      // Never import a pre-lock snapshot over an intervening publication.
      validateRead: ({ bytes }) => {
        if (!bytes.equals(delivered)) {
          note('observe-delivered-mismatch');
          refuse('DELIVERED_MISMATCH', 'The delivered bytes are not the current file window. The current snapshot was not recorded.');
        }
      }
    });
    if (!observed.bytes.equals(delivered)) {
      refuse('DELIVERED_MISMATCH', 'The authority returned bytes other than the delivered window.');
    }
    const receipt = observed.receipt;
    return Object.freeze({
      schemaVersion: 1,
      resource,
      receiptRef: receipt.receiptRef,
      startByte: receipt.startByte,
      endByte: receipt.endByte,
      totalBytes: receipt.totalBytes,
      contentSha256: receipt.contentSha256,
      fileSha256: receipt.fileSha256,
      truncated: receipt.endByte - receipt.startByte < receipt.totalBytes,
      content: Buffer.from(delivered),
      observationRefreshed: false,
      invalidations: observed.invalidations
    });
  }

  async function internalReread(session, input = {}) {
    const stored = live(session);
    const resource = path.resolve(input.resource || '');
    admit(stored.grant, { action: 'observe', resource });
    note('internal-reread');
    const current = await snapshot(resource);
    if (!current.present) refuse('BYTE_RESOURCE_ABSENT', 'The file is absent.');
    return Object.freeze({
      schemaVersion: 1,
      resource,
      sha256: sha256(current.bytes),
      byteLength: current.bytes.length,
      observationRefreshed: false
    });
  }

  function outcome(kind, fields) {
    return Object.freeze({
      schemaVersion: 1,
      contract: CONTRACT,
      outcome: kind,
      reason: fields.reason,
      retryable: fields.retryable === true,
      publicationCommitted: fields.publicationCommitted,
      observationRefreshed: false,
      effects: Object.freeze(fields.effects || []),
      uncertainty: fields.uncertainty || null,
      repeated: fields.repeated === true
    });
  }

  function effect(resource, before, after) {
    const beforeSha256 = sha256(before);
    const afterSha256 = sha256(after);
    return Object.freeze({ resource, beforeSha256, afterSha256, changed: beforeSha256 !== afterSha256 });
  }

  function finish(session, idempotencyKey, value, fingerprint) {
    note('outcome:' + value.outcome + ':' + value.reason);
    if (typeof idempotencyKey === 'string' && fingerprint && (value.outcome === 'confirmed' || value.outcome === 'unknown')) {
      attempts.set(session.sessionId + '\0' + idempotencyKey, { fingerprint, value });
    }
    return value;
  }

  function editFingerprint(edits) {
    const canonical = edits.map(edit => ({
      resource: path.resolve(edit.resource),
      startByte: edit.startByte,
      endByte: edit.endByte,
      replacementSha256: sha256(edit.replacement),
      baseSha256: edit.baseSha256 || null
    })).sort((left, right) => left.resource < right.resource ? -1 : left.resource > right.resource ? 1 : left.startByte - right.startByte || left.endByte - right.endByte);
    return sha256(Buffer.from(JSON.stringify(canonical)));
  }

  function plan(edits) {
    if (!Array.isArray(edits) || edits.length === 0) refuse('ADAPTER_INVALID', 'A commit needs at least one edit.');
    if (edits.length > MAX_EDITS) refuse('EDIT_LIMIT', `A commit accepts at most ${MAX_EDITS} edits.`);
    const groups = new Map();
    for (const edit of edits) {
      if (!edit || typeof edit.resource !== 'string' || !path.isAbsolute(edit.resource) || edit.resource.includes('\0')) {
        refuse('ADAPTER_INVALID', 'Each edit needs an absolute resource path.');
      }
      if (!Number.isSafeInteger(edit.startByte) || !Number.isSafeInteger(edit.endByte) || edit.startByte < 0 || edit.endByte < edit.startByte) {
        refuse('ADAPTER_INVALID', 'Each edit needs a byte range inside the original file.');
      }
      if (!Buffer.isBuffer(edit.replacement)) refuse('ADAPTER_INVALID', 'Each replacement must be a Buffer.');
      if (edit.baseSha256 !== undefined && (typeof edit.baseSha256 !== 'string' || !SHA256.test(edit.baseSha256))) {
        refuse('ADAPTER_INVALID', 'baseSha256 must be a sha256 hex digest.');
      }
      const resource = path.resolve(edit.resource);
      if (!groups.has(resource)) groups.set(resource, []);
      groups.get(resource).push(edit);
    }
    if (groups.size > MAX_RESOURCES) refuse('EDIT_LIMIT', `A commit accepts at most ${MAX_RESOURCES} resources.`);
    return groups;
  }

  function mergeOriginal(before, edits) {
    const bases = [...new Set(edits.map(edit => edit.baseSha256).filter(value => value !== undefined))];
    if (bases.length > 1) refuse('EDIT_STALE', 'Edits on one file name different base hashes.');
    if (bases.length === 1 && bases[0] !== sha256(before)) refuse('EDIT_STALE', 'The file no longer matches the observed base.');
    const sorted = [...edits].sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte);
    for (const edit of sorted) {
      if (edit.endByte > before.length) refuse('EDIT_RANGE', 'The edit is outside the current file.');
    }
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (intersects(previous.startByte, previous.endByte, current.startByte, current.endByte)) {
        refuse('EDIT_OVERLAP', 'Overlapping edits on the original file are refused.');
      }
    }
    const parts = [];
    let cursor = 0;
    for (const edit of sorted) {
      parts.push(before.subarray(cursor, edit.startByte));
      parts.push(edit.replacement);
      cursor = edit.endByte;
    }
    parts.push(before.subarray(cursor));
    return { after: Buffer.concat(parts), spans: sorted.map(edit => ({
      startByte: edit.startByte, endByte: edit.endByte, replacement: edit.replacement
    })) };
  }

  function uncertain(error, resources) {
    return outcome('unknown', {
      reason: typeof error.code === 'string' ? error.code : 'unproved',
      retryable: false,
      publicationCommitted: 'unknown',
      effects: [],
      uncertainty: Object.freeze({
        code: 'PUBLICATION_UNCERTAIN',
        resources: Object.freeze(resources),
        retry: 'forbidden',
        preserveTargets: true,
        cause: typeof error.code === 'string' ? error.code : 'UNPROVED'
      })
    });
  }

  function conflictOutcome(kind) {
    if (kind === 'unknown') {
      return outcome('unknown', {
        reason: 'IDEMPOTENCY_UNRESOLVED', retryable: false, publicationCommitted: 'unknown',
        uncertainty: Object.freeze({ code: 'IDEMPOTENCY_UNRESOLVED', resources: Object.freeze([]), retry: 'forbidden', preserveTargets: true })
      });
    }
    return outcome('no', { reason: 'IDEMPOTENCY_CONFLICT', retryable: false, publicationCommitted: false });
  }

  async function commit(session, input = {}) {
    const stored = live(session);
    if (input.op === 'delete' || input.op === 'rename') {
      if (input.resource !== undefined) admit(stored.grant, { action: 'commit', resource: input.resource });
      note('unsupported:' + input.op);
      return finish(stored, null, outcome('no', {
        reason: 'unsupported-not-mediated', retryable: false, publicationCommitted: false
      }));
    }
    if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0 || input.idempotencyKey.length > 200)) {
      refuse('ADAPTER_INVALID', 'idempotencyKey must be a short string.');
    }
    let fingerprint = null;
    let mutationAdmitted = false;
    let prepared = new Map();
    const published = [];
    try {
      const groups = plan(input.edits);
      fingerprint = editFingerprint(input.edits);
      if (typeof input.idempotencyKey === 'string') {
        const prior = attempts.get(stored.sessionId + '\0' + input.idempotencyKey);
        // Unknown attempts stay unknown and cannot publish again. A confirmed
        // cache entry is only history: durable state and the current after-image
        // below must prove any replay. Different input also uses durable status.
        if (prior && prior.fingerprint === fingerprint && prior.value.outcome === 'unknown') {
          note('replay:' + prior.value.outcome);
          return Object.freeze({ ...prior.value, repeated: true });
        }
      }
      if (groups.size > 1) {
        return finish(stored, null, outcome('no', {
          reason: 'MULTI_RESOURCE_NOT_ATOMIC', retryable: false, publicationCommitted: false
        }));
      }
      if (typeof input.idempotencyKey === 'string') {
        const recalled = await authority.recallIdempotency({ binding: stored.binding, idempotencyKey: input.idempotencyKey });
        if (recalled && recalled.found) {
          const same = recalled.inputSha256 === fingerprint;
          if (!same) return conflictOutcome(recalled.status === 'PREPARED' || recalled.status === 'UNKNOWN' ? 'unknown' : 'confirmed');
          if (recalled.status === 'COMMITTED') {
            const current = await snapshot(recalled.resource);
            if (current.present && sha256(current.bytes) === recalled.afterSha256) {
              return finish(stored, input.idempotencyKey, outcome('confirmed', {
                reason: 'committed', retryable: false, publicationCommitted: true, repeated: true,
                effects: [Object.freeze({ resource: recalled.resource, beforeSha256: recalled.beforeSha256, afterSha256: recalled.afterSha256, changed: recalled.beforeSha256 !== recalled.afterSha256 })]
              }), fingerprint);
            }
            return finish(stored, input.idempotencyKey, uncertain({ code: 'BYTE_PUBLICATION_UNCONFIRMED' }, [recalled.resource]), fingerprint);
          }
          if (recalled.status === 'PREPARED' || recalled.status === 'UNKNOWN') {
            return finish(stored, input.idempotencyKey, Object.freeze({ ...uncertain({ code: 'BYTE_IDEMPOTENCY_UNRESOLVED' }, [recalled.resource]), repeated: true }), fingerprint);
          }
          return conflictOutcome('confirmed');
        }
        if (attempts.has(stored.sessionId + '\0' + input.idempotencyKey)) {
          // Losing durable proof must never turn a cached attempt into a new
          // publication, even if its prior process-local result was confirmed.
          return finish(stored, input.idempotencyKey,
            uncertain({ code: 'BYTE_IDEMPOTENCY_UNRESOLVED' }, [...groups.keys()]), fingerprint);
        }
      }
      if (stored.cancelled) {
        return finish(stored, input.idempotencyKey, outcome('no', {
          reason: 'cancelled', retryable: false, publicationCommitted: false
        }), fingerprint);
      }
      for (const resource of groups.keys()) admit(stored.grant, { action: 'commit', resource });
      for (const [resource, edits] of groups) {
        const current = await snapshot(resource);
        if (!current.present) refuse('BYTE_RESOURCE_ABSENT', 'The file is absent.');
        const merged = mergeOriginal(current.bytes, edits);
        prepared.set(resource, { resource, before: current.bytes, after: merged.after, spans: merged.spans });
      }
      for (const resource of [...prepared.keys()].sort()) {
        if (stored.cancelled) refuse('CANCELLED', 'The session was cancelled.');
        const item = prepared.get(resource);
        note('publish-attempt');
        const applied = await authority.applyPatch({
          binding: stored.binding,
          resource,
          idempotencyKey: input.idempotencyKey,
          inputSha256: fingerprint || undefined,
          // The authority invokes this private guard after acquiring its
          // lifetime lock. Cancellation before that admission is publication-
          // free. Once admitted, cancellation cannot undo an in-flight effect.
          assertCurrent: () => {
            if (!mutationAdmitted && stored.cancelled) refuse('CANCELLED', 'The session was cancelled before authority admission.');
            mutationAdmitted = true;
          },
          derivePatch: ({ bytes }) => {
            if (!bytes.equals(item.before)) refuse('EDIT_STALE', 'The file changed after planning.');
            if (item.spans.length === 1) {
              const span = item.spans[0];
              return { startByte: span.startByte, endByte: span.endByte, replacement: span.replacement };
            }
            return { spans: item.spans.map(span => ({ startByte: span.startByte, endByte: span.endByte, replacement: span.replacement })) };
          }
        });
        published.push({ ...item, receiptRef: applied.receipt ? applied.receipt.receiptRef : null });
        const verified = await prove(resource, item.after);
        if (verified !== true) refuse('VERIFY_MISMATCH', 'The published file did not match the merged bytes.');
      }
      return finish(stored, input.idempotencyKey, outcome('confirmed', {
        reason: 'committed',
        retryable: false,
        publicationCommitted: true,
        effects: published.map(item => effect(item.resource, item.before, item.after))
      }), fingerprint);
    } catch (error) {
      if (error instanceof NativeExecutionRefusal && error.code === 'ADAPTER_INVALID') throw error;
      if (published.length === 0 && !(mutationAdmitted && error.code === 'CANCELLED')
          && (error instanceof NativeExecutionRefusal || error instanceof ByteCoordinationRefusal) && CLEAN.has(error.code)) {
        return finish(stored, input.idempotencyKey, outcome('no', {
          reason: error.code,
          retryable: RETRYABLE.has(error.code),
          publicationCommitted: false,
          effects: [...prepared.values()].map(item => effect(item.resource, item.before, item.before))
        }), fingerprint);
      }
      note('unproved');
      return finish(stored, input.idempotencyKey, uncertain(error, [...prepared.keys()]), fingerprint);
    }
  }

  async function retry(session, previous, input = {}) {
    live(session);
    if (!previous || previous.contract !== CONTRACT) refuse('RETRY_REFUSED', 'Retry needs a result from this contract.');
    if (previous.outcome === 'unknown') refuse('RETRY_REFUSED', 'A mutation with an unknown outcome must not be repeated.');
    if (previous.outcome === 'confirmed') refuse('RETRY_REFUSED', 'A confirmed commit is not retried.');
    if (previous.retryable !== true) refuse('RETRY_REFUSED', 'This refusal is not retryable.');
    note('retry');
    return commit(session, input);
  }

  function accountAlternate(session, input = {}) {
    const stored = live(session);
    if (!ALTERNATE_KINDS.has(input.kind)) refuse('ADAPTER_INVALID', 'The alternate writer kind is not one this contract accounts for.');
    const resource = path.resolve(input.resource || '');
    admit(stored.grant, { action: 'account-alternate', resource });
    if (stored.alternate.length >= MAX_ALTERNATE) refuse('ACCOUNT_LIMIT', `At most ${MAX_ALTERNATE} alternate-writer records are kept for a session.`);
    const record = Object.freeze({
      kind: input.kind,
      resource,
      mediated: false,
      intercepted: false,
      effect: 'not-a-fence'
    });
    stored.alternate.push(record);
    note('account:' + input.kind);
    return record;
  }

  async function recover(session, input = {}) {
    const stored = live(session);
    if (!Array.isArray(input.resources) || input.resources.length === 0 || input.resources.length > MAX_RESOURCES) {
      refuse('ADAPTER_INVALID', 'Recovery names the resources to inspect, up to the resource limit.');
    }
    const resources = input.resources.map(resource => path.resolve(resource));
    for (const resource of resources) admit(stored.grant, { action: 'recover', resource });
    note('recover');
    try {
      const recovered = await authority.recoverPending({ resources });
      const rows = Array.isArray(recovered && recovered.recovered) ? recovered.recovered : [];
      return Object.freeze({
        schemaVersion: 1,
        outcome: 'confirmed',
        observationRefreshed: false,
        recovered: Object.freeze(rows.map(item => Object.freeze({
          operationId: item.operationId,
          outcome: item.outcome
        })))
      });
    } catch (error) {
      if (error instanceof ByteCoordinationRefusal && (error.code === 'BYTE_RECOVERY_UNRESOLVED' || error.code === 'BYTE_PUBLICATION_UNCONFIRMED')) {
        return Object.freeze({
          schemaVersion: 1,
          outcome: 'unknown',
          reason: error.code,
          observationRefreshed: false,
          uncertainty: Object.freeze({ code: error.code, resources: Object.freeze(resources), retry: 'forbidden', preserveTargets: true })
        });
      }
      throw error;
    }
  }

  return Object.freeze({
    contract: CONTRACT,
    limits: LIMITS,
    coverage: () => COVERAGE,
    openSession,
    openTransportSession,
    forkSession,
    nest,
    resumeSession,
    reconnect,
    closeSession,
    delegate,
    admit,
    observe,
    observeDelivered,
    internalReread,
    commit,
    accountAlternate,
    cancel,
    retry,
    recover
  });
}

module.exports = Object.freeze({
  CONTRACT,
  LIMITS,
  COVERAGE,
  NativeExecutionRefusal,
  createNativeExecution
});
