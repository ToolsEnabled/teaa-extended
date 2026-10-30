'use strict';

// Pi, Grok and AGY classification, context selection and CodeMode lookup.
// Production reads and edits go through pi-host-bridge and hostByteAuthority
// on byte-coordination-host. This module does not open a coordination
// database and does not mint a native or OS permission.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { METHOD } = require('../agent-engine/acp-adapter');
const {
  CONTRACT,
  LIMITS,
  NativeExecutionRefusal,
  createNativeExecution
} = require('../native-execution/contract');

const agyDescriptor = require('../../../config/agents/agy.json');
const grokDescriptor = require('../../../config/agents/grok.json');

const PERMISSIONS = Object.freeze(['none', 'edits', 'all']);
const PERMISSION_RANK = Object.freeze({ none: 0, edits: 1, all: 2 });
const PERMISSION_ACTIONS = Object.freeze({
  none: Object.freeze(['observe']),
  edits: Object.freeze(['observe', 'commit', 'delegate', 'cancel', 'recover']),
  all: Object.freeze(['observe', 'commit', 'delegate', 'cancel', 'recover', 'account-alternate'])
});
const UNMEDIATED_WRITERS = Object.freeze([
  'shell', 'subprocess', 'formatter', 'git', 'create', 'delete', 'rename', 'mcp-other', 'exterior'
]);
const WRITER_KIND = Object.freeze({
  shell: 'shell',
  subprocess: 'subprocess',
  formatter: 'formatter',
  git: 'git',
  create: 'create',
  delete: 'delete',
  rename: 'rename',
  'mcp-other': 'mcp',
  exterior: 'unmanaged'
});
const GROK_HOOK_DECISIONS = Object.freeze(['allow', 'deny', 'ask', 'defer']);
const AGY_PRETOOL_DECISIONS = Object.freeze(['allow', 'deny', 'ask', 'force_ask']);
const PRE_EFFECT_REFUSALS = new Set(['SESSION_CLOSED', 'SESSION_MISMATCH', 'GRANT_UNISSUED']);

class NativeHarnessRefusal extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'NativeHarnessRefusal';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function refuse(code, message, details) {
  throw new NativeHarnessRefusal(code, message, details);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function heldText() {
  const held = agyDescriptor && agyDescriptor.worker && agyDescriptor.worker.held;
  return typeof held === 'string' && held.trim() ? held : null;
}

function permissionRank(permission) {
  if (!Object.hasOwn(PERMISSION_RANK, permission)) {
    refuse('NATIVE_PERMISSION_INVALID', 'Permission must be none, edits or all.', { permission });
  }
  return PERMISSION_RANK[permission];
}

function actionsFor(permission) {
  permissionRank(permission);
  return PERMISSION_ACTIONS[permission];
}

function identityOf(session) {
  const binding = session.native.binding;
  return {
    principal: binding.principal,
    runtimeScopeId: binding.runtimeScopeId,
    scopeKind: binding.scopeKind
  };
}

function piCommandInstalled(env = process.env, statSync = fs.statSync) {
  const entries = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const directory of entries) {
    try {
      const stat = statSync(path.join(directory, process.platform === 'win32' ? 'pi.exe' : 'pi'));
      if (stat.isFile() && (stat.mode & 0o111)) return true;
    } catch (error) {
      if (error && error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }
  return false;
}

// Each oldText is matched against this one buffer. A later edit does not see
// text introduced by an earlier edit. Matching is exact UTF-8, not Pi's
// normalized-whitespace fallback.
function composeOriginalFileEdits(original, edits) {
  if (!Buffer.isBuffer(original)) refuse('ORIGINAL_EDIT_REJECTED', 'Original file bytes are required.');
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > LIMITS.maxEdits) {
    refuse('ORIGINAL_EDIT_REJECTED', `A multi-edit needs one to ${LIMITS.maxEdits} replacements.`);
  }
  const ranges = [];
  for (const edit of edits) {
    if (!edit || typeof edit.oldText !== 'string' || typeof edit.newText !== 'string' || edit.oldText.length === 0) {
      refuse('ORIGINAL_EDIT_REJECTED', 'Each edit needs a non-empty oldText and a string newText.');
    }
    const oldBytes = Buffer.from(edit.oldText, 'utf8');
    const hits = [];
    let from = 0;
    while (from <= original.length - oldBytes.length) {
      const at = original.indexOf(oldBytes, from);
      if (at < 0) break;
      hits.push(at);
      from = at + 1;
    }
    if (hits.length !== 1) {
      refuse('ORIGINAL_EDIT_REJECTED', hits.length === 0
        ? 'oldText was not in the original file.'
        : 'oldText matched more than once in the original file.', { matches: hits.length });
    }
    ranges.push({
      startByte: hits[0],
      endByte: hits[0] + oldBytes.length,
      replacement: Buffer.from(edit.newText, 'utf8')
    });
  }
  ranges.sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].startByte < ranges[index - 1].endByte) {
      refuse('ORIGINAL_EDIT_REJECTED', 'Edits overlap on the original file.');
    }
  }
  return ranges;
}

function parseHookJson(stdout) {
  const text = String(stdout || '');
  const trimmed = text.trim();
  if (!trimmed) return { empty: true };
  if (!trimmed.startsWith('{')) return { empty: false, notJson: true };
  try {
    const value = JSON.parse(trimmed);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { malformed: true };
    return { json: value };
  } catch {
    return { malformed: true };
  }
}

function grokDecision(value) {
  const specific = value.hookSpecificOutput;
  if (specific && typeof specific === 'object' && !Array.isArray(specific) && typeof specific.permissionDecision === 'string') {
    return specific.permissionDecision;
  }
  return typeof value.decision === 'string' ? value.decision : null;
}

// Official Grok hook failures (timeouts, crashes, exit codes other than 0 and 2,
// malformed JSON at exit 0) do not block. A fail-open result is not a grant.
function classifyGrokHook({ event = 'PreToolUse', exitCode = 0, stdout = '', timedOut = false } = {}) {
  const base = {
    harness: 'grok',
    event,
    mandatoryBoundary: false,
    failOpen: true,
    authorizesMediation: false
  };
  if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    return { ...base, decision: 'recorded', blocksTool: false, toolProceeds: true };
  }
  if (timedOut) {
    return { ...base, decision: 'fail-open', blocksTool: false, toolProceeds: true, reason: 'timeout' };
  }
  if (!Number.isInteger(exitCode)) refuse('GROK_HOOK_INVALID', 'A Grok hook exit code must be an integer.');
  const parsed = parseHookJson(stdout);
  if (parsed.malformed) {
    if (exitCode === 2) return { ...base, decision: 'deny', blocksTool: true, toolProceeds: false, reason: 'exit-2' };
    return { ...base, decision: 'fail-open', blocksTool: false, toolProceeds: true, reason: 'malformed-json' };
  }
  const decision = parsed.json ? grokDecision(parsed.json) : null;
  const stops = Boolean(parsed.json && parsed.json.continue === false);
  if (stops) return { ...base, decision: 'stop', blocksTool: true, toolProceeds: false };
  if (decision === 'deny' || decision === 'block') {
    return { ...base, decision: 'deny', blocksTool: true, toolProceeds: false };
  }
  if (decision && !GROK_HOOK_DECISIONS.includes(decision) && decision !== 'block' && decision !== 'approve') {
    if (exitCode === 2) return { ...base, decision: 'deny', blocksTool: true, toolProceeds: false, reason: 'exit-2' };
    return { ...base, decision: 'fail-open', blocksTool: false, toolProceeds: true, reason: 'unrecognized-decision' };
  }
  if (exitCode === 2) return { ...base, decision: 'deny', blocksTool: true, toolProceeds: false, reason: 'exit-2' };
  if (decision === 'ask' || decision === 'defer') {
    return { ...base, decision, blocksTool: true, toolProceeds: false };
  }
  if (exitCode === 0) return { ...base, decision: decision || 'allow', blocksTool: false, toolProceeds: true };
  return { ...base, decision: 'fail-open', blocksTool: false, toolProceeds: true, reason: 'exit-code' };
}

// Installed AGY hooks document the decision vocabulary. They do not document
// what a timeout, crash or malformed PreToolUse reply does. Unknown stays
// unknown and never becomes an allow. This classifier does not run a worker.
function classifyAgyHook({ event = 'PreToolUse', stdout = '', exitCode = 0, timedOut = false } = {}) {
  const base = {
    harness: 'agy',
    event,
    mediatesBytes: false,
    mandatoryBoundary: false,
    authorizesMediation: false,
    workerHeld: Boolean(heldText()),
    failureMode: 'unknown'
  };
  if (event === 'PostToolUse') {
    return { ...base, decision: 'recorded', blocksTool: false, failureMode: 'not-a-precondition' };
  }
  if (timedOut || !Number.isInteger(exitCode) || exitCode !== 0) {
    return { ...base, decision: 'unknown', blocksTool: null, code: 'AGY_HOOK_OUTCOME_UNKNOWN' };
  }
  const parsed = parseHookJson(stdout);
  if (!parsed.json) return { ...base, decision: 'unknown', blocksTool: null, code: 'AGY_HOOK_OUTCOME_UNKNOWN' };
  if (event === 'Stop') {
    const continueStop = parsed.json.decision === 'continue';
    return { ...base, decision: continueStop ? 'continue' : 'stop-allowed', blocksTool: false, blocksStop: continueStop, failureMode: 'documented-decision' };
  }
  if (event !== 'PreToolUse') return { ...base, decision: 'ignored', blocksTool: false };
  if (!AGY_PRETOOL_DECISIONS.includes(parsed.json.decision)) {
    return { ...base, decision: 'unknown', blocksTool: null, code: 'AGY_HOOK_OUTCOME_UNKNOWN' };
  }
  return {
    ...base,
    decision: parsed.json.decision,
    blocksTool: parsed.json.decision !== 'allow',
    failureMode: 'documented-decision'
  };
}

function agyHookContract() {
  return Object.freeze({
    decisions: AGY_PRETOOL_DECISIONS,
    preToolUseFailureMode: 'unknown',
    postToolUseIsNotAPrecondition: true,
    mandatoryBoundary: false,
    workerHeld: Boolean(heldText())
  });
}

function refuseHeldAgyWorker(session) {
  if (!session || session.harness !== 'agy') return null;
  const reason = heldText();
  if (reason) {
    return {
      outcome: 'no',
      supported: false,
      held: true,
      bypassed: false,
      mediatesBytes: false,
      published: false,
      publicationCommitted: false,
      reason: 'AGY_WORKER_HELD',
      heldReason: reason,
      contract: CONTRACT,
      identity: identityOf(session),
      hookContract: agyHookContract()
    };
  }
  return {
    outcome: 'no',
    supported: false,
    held: false,
    bypassed: false,
    mediatesBytes: false,
    published: false,
    publicationCommitted: false,
    reason: 'AGY_MEDIATION_UNSUPPORTED',
    heldReason: 'AGY hook failure behaviour is not specified, so this adapter does not publish.',
    contract: CONTRACT,
    identity: identityOf(session),
    hookContract: agyHookContract()
  };
}

function accountWriter(kind) {
  if (!Object.hasOwn(WRITER_KIND, kind)) refuse('NATIVE_WRITER_UNKNOWN', 'The writer kind is not in the accounted set.', { kind });
  return Object.freeze({
    kind,
    coreKind: WRITER_KIND[kind],
    mediated: false,
    intercepted: false,
    mandatoryBoundary: false,
    published: false,
    reason: 'Calling this adapter does not intercept that writer. The execution contract only sees calls made through it.'
  });
}

function selectNativeContext({ requestedTokens, catalogWindows, catalogDefault } = {}) {
  if (!Number.isSafeInteger(requestedTokens) || requestedTokens < 1) {
    refuse('GROK_CONTEXT_INVALID', 'The requested context size must be a positive integer.');
  }
  if (!Array.isArray(catalogWindows) || catalogWindows.length === 0
      || catalogWindows.some(value => !Number.isSafeInteger(value) || value < 1)) {
    refuse('GROK_CONTEXT_INVALID', 'Catalog context windows must be a non-empty list of positive integers.');
  }
  const windows = [...catalogWindows];
  const smaller = Math.min(...windows);
  if (catalogDefault !== undefined && !windows.includes(catalogDefault)) {
    refuse('GROK_CONTEXT_INVALID', 'The catalog default must be one of the catalog windows.');
  }
  // REQUIRED: this adapter has no Grok context setter. A recommendation is not
  // the configured window, and a larger catalog default is left as configured.
  const exact = windows.includes(requestedTokens);
  const configuredTokens = catalogDefault === undefined ? null : catalogDefault;
  return {
    status: exact ? 'exact' : 'unsupported-exact',
    requestedTokens,
    recommendedTokens: exact ? requestedTokens : smaller,
    configuredTokens,
    selectedTokens: configuredTokens,
    contextSetter: false,
    applied: false,
    invented: false,
    rejectedWindows: exact ? [] : windows.filter(value => value !== smaller)
  };
}

function piCodeModePackage() {
  const override = process.env.FLEET_PI_CODEMODE;
  const candidates = typeof override === 'string' && override.length > 0
    ? [override]
    : [path.join(__dirname, '../../../validation/pi/node_modules/@earendil-works/pi-codemode/package.json')];
  for (const file of candidates) {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (!pkg || pkg.name !== '@earendil-works/pi-codemode' || typeof pkg.version !== 'string') continue;
    return {
      version: pkg.version,
      packageJson: file,
      modulePath: path.join(path.dirname(file), 'dist', 'index.js')
    };
  }
  return null;
}

function reuseCodeMode(engine) {
  if (engine !== 'pi' && engine !== 'codex') {
    refuse('CODEMODE_ENGINE_REFUSED', 'Only an existing Pi or Codex CodeMode may be reused. This module does not create one.', { engine });
  }
  if (engine === 'codex') {
    return {
      available: false,
      engine,
      mandatory: false,
      constructedHere: false,
      reason: 'This checkout has no Codex CodeMode package. Pi CodeMode is not a substitute.'
    };
  }
  const found = piCodeModePackage();
  if (!found) {
    return {
      available: false,
      engine,
      mandatory: false,
      constructedHere: false,
      reason: 'The installed @earendil-works/pi-codemode package was not found. This module does not create one.'
    };
  }
  return {
    available: true,
    engine,
    mandatory: false,
    constructedHere: false,
    packageName: '@earendil-works/pi-codemode',
    version: found.version,
    exportName: 'CodemodeSandbox',
    modulePath: found.modulePath,
    reason: 'Reuses Pi CodemodeSandbox. This module does not construct another engine.'
  };
}

function coverageMatrix({ piInstalled = piCommandInstalled() } = {}) {
  const held = heldText();
  return {
    schema: 'fleet-v4-native-harness/1',
    contract: CONTRACT,
    authority: 'hostByteAuthority',
    byteStore: 'byte-coordination-host',
    byteAuthority: 'existing-ByteAuthority',
    duplicateAuthority: false,
    codeMode: {
      policy: 'reuse-existing-pi-or-codex-only',
      mandatory: false,
      pi: reuseCodeMode('pi'),
      codex: reuseCodeMode('codex')
    },
    columns: ['direct', 'fleetWorker'],
    pi: {
      commandInstalled: Boolean(piInstalled),
      package: '@earendil-works/pi-coding-agent',
      packageVersion: '1.4.0',
      extension: 'src/lib/providers/pi-fleet-extension.mjs',
      direct: {
        supported: true,
        interface: 'sdk',
        edit: 'official-schema-mediated',
        write: 'unmediated',
        bash: 'unmediated',
        reason: 'Official Pi read and edit operations observe delivered ranges and publish disjoint spans through hostByteAuthority on byte-coordination-host. write and bash stay native and unmediated.'
      },
      fleetWorker: {
        integration: 'pi-rpc',
        protocol: 'official-rpc',
        supportedCommands: ['get_state', 'prompt', 'clear_queue', 'abort', 'set_thinking_level'],
        toolExecution: 'official-runtime-through-native-extension',
        driver: 'src/lib/providers/pi-rpc-worker.js',
        lifecycleEvidence: 'recording-transport',
        liveProviderTurn: false,
        minimumNativeLevel: 4,
        genericFork: 'PI_FORK_UNSUPPORTED',
        validationClient: 'validation/pi/rpc-client.js',
        validationIsolationFlagsAreNotTheProductPath: true,
        liveProvider: false,
        shell: accountWriter('shell')
      }
    },
    grok: {
      driver: grokDescriptor.worker && grokDescriptor.worker.driver,
      acpPermissionMethod: METHOD.sessionRequestPermission,
      acpPermissionMediatesBytes: false,
      hooks: { failOpen: true, mandatoryBoundary: false },
      context: { setter: false, recommendationField: 'recommendedTokens', configurationField: 'selectedTokens' },
      direct: {
        nativeTools: 'unmediated',
        nativeToolRemoval: false,
        registration: 'src/lib/providers/grok-native-registration.js directRegistration',
        executable: 'grok mcp add',
        fleetTools: 'existing-host-mcp',
        mediatesBytes: false
      },
      fleetWorker: {
        mediatedWhenFleetIsTheWriter: true,
        hookIsNotAGrant: true,
        autoObserve: false,
        executable: 'src/lib/agent-engine/acp-process.js startAcpSession',
        fleetTools: 'existing-worker-host-mcp',
        nativeTools: 'unmediated',
        liveProviderTurn: false
      }
    },
    agy: {
      role: 'native-lead',
      supported: false, // This adapter does not mediate AGY's native edit hook.
      held: Boolean(held), // Worker hold only; it does not restrict the lead.
      reason: held,
      nativeLead: { supported: true, actor: 'agy', transport: 'existing-Fleet-MCP', worker: false },
      hookContract: agyHookContract(),
      qualificationOwner: 'integration-sol',
      requiredRole: 'native-lead-only',
      direct: { mcpClientDocumented: true, role: 'lead', worker: false, qualification: 'owned-by-integration-sol' },
      fleetWorker: { applicable: false, worker: false, held: Boolean(held), mediatesBytes: false }
    },
    unmediatedWriters: UNMEDIATED_WRITERS.map(accountWriter)
  };
}

function noPublication(reason, extra = {}) {
  return {
    outcome: 'no',
    reason,
    retryable: false,
    publicationCommitted: false,
    published: false,
    observationRefreshed: false,
    contract: CONTRACT,
    ...extra
  };
}

function unknownPublication(extra = {}) {
  return {
    outcome: 'unknown',
    reason: 'unproved',
    retryable: false,
    publicationCommitted: 'unknown',
    published: 'unknown',
    observationRefreshed: false,
    uncertainty: Object.freeze({
      code: 'PUBLICATION_UNCERTAIN',
      retry: 'forbidden',
      preserveTargets: true
    }),
    repeated: false,
    contract: CONTRACT,
    ...extra
  };
}

async function locateOriginal(session, resource, edits) {
  let snapshot;
  try {
    snapshot = await session.authority.materialize(path.resolve(resource));
  } catch {
    return { refusal: unknownPublication({ identity: identityOf(session) }) };
  }
  if (!snapshot || snapshot.present === false || !Buffer.isBuffer(snapshot.bytes)) {
    return { refusal: noPublication('BYTE_RESOURCE_ABSENT', { retryable: true, identity: identityOf(session) }) };
  }
  let ranges;
  try {
    ranges = composeOriginalFileEdits(snapshot.bytes, edits);
  } catch (error) {
    if (error instanceof NativeHarnessRefusal) {
      return { refusal: noPublication(error.code, { identity: identityOf(session) }) };
    }
    throw error;
  }
  const baseSha256 = sha256(snapshot.bytes);
  const resolved = path.resolve(resource);
  return {
    edits: ranges.map(range => ({
      resource: resolved,
      startByte: range.startByte,
      endByte: range.endByte,
      replacement: range.replacement,
      baseSha256
    }))
  };
}

async function verificationOf(session, resource, result) {
  if (!result || result.outcome !== 'confirmed') return null;
  const check = await session.execution.internalReread(session.native, { resource });
  const after = Array.isArray(result.effects) ? result.effects.map(effect => effect.afterSha256) : [];
  return {
    kind: 'internal-reread',
    agentObservation: false,
    observationRefreshed: check.observationRefreshed === true,
    matches: after.includes(check.sha256),
    exposesBytes: Object.hasOwn(check, 'bytes') || Object.hasOwn(check, 'content')
  };
}

async function decorate(session, resource, result, hook) {
  const published = result && result.publicationCommitted === true;
  return {
    ...result,
    published: published ? true : result.publicationCommitted,
    hook: hook || null,
    hookGuarantee: hook ? 'fail-open-not-a-grant' : null,
    verification: await verificationOf(session, resource, result),
    identity: identityOf(session)
  };
}

async function commitLocated(session, resource, locatedEdits, key, hook) {
  let result;
  try {
    result = await session.execution.commit(session.native, {
      edits: locatedEdits,
      idempotencyKey: key
    });
  } catch (error) {
    if (error instanceof NativeExecutionRefusal && error.code === 'ADAPTER_INVALID') throw error;
    if (error instanceof NativeExecutionRefusal && PRE_EFFECT_REFUSALS.has(error.code)) {
      return noPublication(error.code, { hook, identity: identityOf(session) });
    }
    const unknown = unknownPublication({ hook, identity: identityOf(session) });
    if (typeof key === 'string') session.unknownResults.set(key, unknown);
    return unknown;
  }
  if (typeof key === 'string' && result && (result.outcome === 'confirmed' || result.outcome === 'unknown')) {
    session.attemptEdits.set(key, locatedEdits);
  }
  return decorate(session, resource, result, hook);
}

async function publishEdits(session, resource, edits, options = {}) {
  const key = options.idempotencyKey;
  const hook = session.harness === 'grok' && options.hook ? classifyGrokHook(options.hook) : null;
  if (hook && hook.blocksTool) {
    return noPublication('GROK_HOOK_DENIED', { hook, identity: identityOf(session) });
  }
  if (typeof key === 'string' && session.unknownResults.has(key)) {
    return { ...session.unknownResults.get(key), repeated: true };
  }
  if (typeof key === 'string' && session.attemptEdits.has(key)) {
    return commitLocated(session, resource, session.attemptEdits.get(key), key, hook);
  }
  const located = await locateOriginal(session, resource, edits);
  if (located.refusal) return { ...located.refusal, hook };
  return commitLocated(session, resource, located.edits, key, hook);
}

function createHarnessSession({ authority, execution, native, harness, permission, resources, principal, piInstalled } = {}) {
  if (!authority || typeof authority.observeRead !== 'function' || typeof authority.applyPatch !== 'function' || typeof authority.materialize !== 'function') {
    refuse('NATIVE_AUTHORITY_REQUIRED', 'The session needs the existing ByteAuthority, including materialize.');
  }
  if (!['pi', 'grok', 'agy'].includes(harness)) refuse('NATIVE_HARNESS_UNKNOWN', 'Harness must be pi, grok or agy.', { harness });
  if (native && !execution) refuse('GRANT_UNISSUED', 'A caller-built session is not a grant from this execution.');
  permissionRank(permission);
  const exec = execution || createNativeExecution({ authority });
  const sessionNative = native || exec.openSession({
    principal: principal || 'worker-native',
    actions: actionsFor(permission),
    resources
  });
  const session = {
    authority,
    execution: exec,
    native: sessionNative,
    harness,
    permission,
    piInstalled: piInstalled === undefined ? piCommandInstalled() : Boolean(piInstalled),
    attemptEdits: new Map(),
    unknownResults: new Map()
  };
  return Object.freeze({
    identity: () => identityOf(session),
    harness: () => session.harness,
    binding: () => session.native.binding,
    observeFile: (resource, range = {}) => observeFile(session, resource, range),
    applyPiEdits: (resource, edits, options = {}) => applyPiEdits(session, resource, edits, options),
    mediateFleetWrite: (resource, edits, options = {}) => mediateFleetWrite(session, resource, edits, options),
    verifyInternal: (resource) => verifyInternal(session, resource),
    classifyHook: (input) => (harness === 'agy' ? classifyAgyHook(input) : classifyGrokHook(input)),
    noteAcpPermission: (params = {}) => noteAcpPermission(session, params),
    accountWriter: (kind) => accountWriter(kind),
    recordAlternate: (kind, resource) => recordAlternate(session, kind, resource),
    unmediated: (op, resource) => unmediated(session, op, resource),
    close: () => exec.closeSession(sessionNative),
    cancel: () => exec.cancel(sessionNative),
    fork: (options = {}) => openChild(session, 'fork', options),
    nest: (options = {}) => openChild(session, 'nest', options),
    resume: () => resume(session),
    recover: (resourcesToRecover) => recover(session, resourcesToRecover),
    retry: (previous, resource, edits, options = {}) => retryEdit(session, previous, resource, edits, options),
    coverage: () => coverageMatrix({ piInstalled: session.piInstalled })
  });
}

async function observeFile(session, resource, range) {
  const held = refuseHeldAgyWorker(session);
  if (held) return held;
  const observed = await session.execution.observe(session.native, {
    resource,
    startByte: range.startByte,
    endByte: range.endByte
  });
  return {
    outcome: 'confirmed',
    agentObservation: true,
    bytes: observed.content,
    text: Buffer.isBuffer(observed.content) ? observed.content.toString('utf8') : '',
    truncated: observed.truncated === true,
    totalBytes: observed.totalBytes,
    receiptRef: observed.receiptRef,
    fileSha256: observed.fileSha256,
    identity: identityOf(session)
  };
}

async function applyPiEdits(session, resource, edits, options) {
  // GATE: a held AGY worker returns before any commit.
  const held = refuseHeldAgyWorker(session);
  if (held) return held;
  if (session.harness !== 'pi') {
    return noPublication('NATIVE_HARNESS_MISMATCH', {
      supported: false,
      bypassed: false,
      identity: identityOf(session)
    });
  }
  return publishEdits(session, resource, edits, options);
}

async function mediateFleetWrite(session, resource, edits, options) {
  // GATE: a held AGY worker returns before any commit.
  const held = refuseHeldAgyWorker(session);
  if (held) return held;
  if (session.harness !== 'grok') {
    return noPublication('NATIVE_HARNESS_MISMATCH', {
      supported: false,
      identity: identityOf(session)
    });
  }
  return publishEdits(session, resource, edits, options);
}

async function verifyInternal(session, resource) {
  const held = refuseHeldAgyWorker(session);
  if (held) return held;
  const check = await session.execution.internalReread(session.native, { resource });
  return {
    kind: 'internal-reread',
    agentObservation: false,
    observationRefreshed: check.observationRefreshed === true,
    sha256: check.sha256,
    byteLength: check.byteLength,
    exposesBytes: Object.hasOwn(check, 'bytes') || Object.hasOwn(check, 'content')
  };
}

function noteAcpPermission(session, params) {
  return {
    method: METHOD.sessionRequestPermission,
    mediatesBytes: false,
    mandatoryBoundary: false,
    published: false,
    sawToolCall: Boolean(params && params.toolCall),
    identity: identityOf(session)
  };
}

function openChild(session, mode, options) {
  const permission = options.permission || session.permission;
  permissionRank(permission);
  if (options.harness && options.harness !== session.harness) {
    refuse('NATIVE_HARNESS_MISMATCH', 'A nested call keeps the parent harness.');
  }
  const opener = mode === 'fork' ? session.execution.forkSession : session.execution.nest;
  const native = opener(session.native, {
    principal: session.native.binding.principal,
    actions: actionsFor(permission),
    resources: session.native.grant.resources.map(entry => ({ path: entry.path, directory: entry.directory }))
  });
  return createHarnessSession({
    authority: session.authority,
    execution: session.execution,
    native,
    harness: session.harness,
    permission,
    piInstalled: session.piInstalled
  });
}

function resume(session) {
  const native = session.execution.resumeSession(session.native.sessionId);
  return createHarnessSession({
    authority: session.authority,
    execution: session.execution,
    native,
    harness: session.harness,
    permission: session.permission,
    piInstalled: session.piInstalled
  });
}

function recordAlternate(session, kind, resource) {
  const described = accountWriter(kind);
  const record = session.execution.accountAlternate(session.native, {
    kind: described.coreKind,
    resource
  });
  return {
    ...record,
    requestedKind: kind,
    published: false,
    mandatoryBoundary: false
  };
}

async function unmediated(session, op, resource) {
  const held = refuseHeldAgyWorker(session);
  if (held) return held;
  const result = await session.execution.commit(session.native, { op, resource });
  return { ...result, published: false, identity: identityOf(session) };
}

async function recover(session, resources) {
  const held = refuseHeldAgyWorker(session);
  if (held) return held;
  const result = await session.execution.recover(session.native, { resources });
  return { ...result, agentObservation: false };
}

async function retryEdit(session, previous, resource, edits, options) {
  const held = refuseHeldAgyWorker(session);
  if (held) return held;
  const located = await locateOriginal(session, resource, edits);
  if (located.refusal) return located.refusal;
  const result = await session.execution.retry(session.native, previous, {
    edits: located.edits,
    idempotencyKey: options.idempotencyKey
  });
  return decorate(session, resource, result, null);
}

module.exports = Object.freeze({
  NativeHarnessRefusal,
  composeOriginalFileEdits,
  classifyGrokHook,
  classifyAgyHook,
  selectNativeContext,
  reuseCodeMode,
  piCodeModePackage,
  coverageMatrix,
  accountWriter,
  piCommandInstalled,
  createHarnessSession,
  agyHookContract,
  UNMEDIATED_WRITERS,
  PERMISSIONS
});
