'use strict';

// Role sheets select the existing registry, never a second implementation of
// a tool. null preserves the normal installed surface; [] grants no tools.
// Both are still narrowed by the session's permission tier and tool policy.
const TOOL_NAME = /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/;
const MAX_FUNCTIONS = 2048;
// New managed-slot controls are explicit opt-ins, including for old saved null
// policies. Updating shipped defaults must never grant them to a custom role.
const SLOT_CONFIGURATION_FUNCTIONS = Object.freeze(['agent.continue', 'agent.set_model', 'agent.set_effort', 'agent.set_speed', 'agent.set_provider', 'agent.set_role']);
const EXPLICIT_GRANT_SET = new Set(SLOT_CONFIGURATION_FUNCTIONS);
function invalid(message) {
  throw Object.assign(new Error(message), { code: 'ROLE_FUNCTIONS_INVALID' });
}
let catalog = null;
function functionCatalog() {
  return catalog || (catalog = Object.freeze(require('./tool-registry').TOOL_REGISTRY.map(entry => Object.freeze({
    id: entry.name, name: entry.name, summary: entry.description.slice(0, 260), effect: entry.effect,
    description: entry.description, inputSchema: entry.inputSchema,
    defaultEnabled: !EXPLICIT_GRANT_SET.has(entry.name),
  }))));
}
function normalizeFunctions(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_FUNCTIONS
      || value.some(id => typeof id !== 'string' || id.length > 160 || !TOOL_NAME.test(id))
      || new Set(value).size !== value.length) {
    invalid('Functions must be null (the normal installed surface), or unique exact tool names.');
  }
  // Removed functions remain inert across build changes. Never interpret a
  // missing identifier as a wildcard or make the whole saved role unreadable.
  return Object.freeze([...value].sort());
}
function defaultFunctionPolicy(roleId, { includeSlotConfiguration = true } = {}) {
  return Object.freeze({
    functions: roleId === 'coordinator-assistant'
      ? normalizeFunctions(functionCatalog().filter(entry => /-read$/.test(entry.effect)
        || ['agent.resume', 'agent_comms.send_local'].includes(entry.id)).map(entry => entry.id))
      : includeSlotConfiguration && ['controller', 'manager', 'builder'].includes(roleId)
        ? normalizeFunctions(functionCatalog().filter(entry => entry.id !== 'agent.set_role').map(entry => entry.id))
        : null,
    requiresDirectUserAuthorization: roleId === 'coordinator-assistant',
  });
}
function normalizeFunctionPolicy(input, inherited = {}) {
  const required = Object.hasOwn(input, 'requiresDirectUserAuthorization')
    ? input.requiresDirectUserAuthorization : (inherited.requiresDirectUserAuthorization ?? false);
  if (typeof required !== 'boolean') invalid('Direct-user authorization must be a boolean.');
  return Object.freeze({
    functions: normalizeFunctions(Object.hasOwn(input, 'functions') ? input.functions
      : (inherited.functions === undefined ? null : inherited.functions)),
    requiresDirectUserAuthorization: required,
  });
}
function narrowFunctionNames(names, policy) {
  const normalized = normalizeFunctionPolicy(policy || {});
  if (normalized.functions === null) return names.filter(name => !EXPLICIT_GRANT_SET.has(name));
  const selected = new Set(normalized.functions);
  return names.filter(name => selected.has(name));
}

// Fleet contract roles are task specializations, separate from the declared
// organisation role above. This is a selection inside its admitted ceiling.
// 2026-10-26 native usage: IMPLEMENTER used fleet.control and host read/patch;
// TESTER/VERIFIER used fleet.control. Other specialties have no samples yet.
// Manual operations are invariants for tests, not a whitelist for selection.
const FLEET_WORKER_FUNCTIONS = Object.freeze([
  'fleet.control', 'host.read_file', 'host.write_file', 'host.patch_file',
  'task.claim', 'task.start', 'task.heartbeat', 'task.checkpoint', 'task.complete', 'task.fail',
]);
// Only these exact Fleet names may be subtracted. In particular task.*, host.*,
// capability discovery and future/extension tools retain their admitted access.
const FLEET_DELEGATION_FUNCTIONS = Object.freeze([
  'agent.spawn', 'agent.wait', 'agent.resume', 'agent.stop', 'agent.restart', 'agent.remove',
  'agent.continue', 'agent.set_model', 'agent.set_effort', 'agent.set_speed',
  'agent.set_provider', 'agent.set_role', 'agent_comms.local_roster', 'agent_comms.send_local',
]);
const FLEET_WORKER_OMISSIONS = Object.freeze([
  ...FLEET_DELEGATION_FUNCTIONS,
  'system.status', 'system.ask', 'system.notify', 'system.doctor', 'settings.read',
  'openshell.status', 'openshell.denials', 'openshell.propose',
  'audit.tail', 'audit.verify', 'audit.status',
  // ledger.read, t_ledger.progress and t_ledger.complete stay: agent.continue
  // enrolls only a worker that already holds them (CONTINUATION_LEDGER_SURFACE_REQUIRED).
  'r_ledger.file', 'r_ledger.withdraw', 't_ledger.file', 'a_ledger.file',
  'search.index', 'search.query', 'search.status', 'memory.set', 'memory.get', 'memory.search',
]);
const FLEET_DELEGATING_ROLES = new Set(['MANAGER', 'COORDINATOR', 'PLANNER',
  'manager', 'planner', 'builder', 'shadow-manager', 'coordinator-assistant']);
function normalizeWorkerTools(value) {
  if (value === undefined || value === 'all') return value;
  const names = normalizeFunctions(value);
  if (names === null || names.some(name => !functionCatalog().some(entry => entry.id === name))) {
    invalid('Worker tools must be "all" or a list of registered exact tool names.');
  }
  return names;
}
function fleetWorkerSurface(surface, { contractRole, role, tools, coordinationMode } = {}) {
  const selected = normalizeWorkerTools(tools);
  if (!surface || selected === 'all'
      || FLEET_DELEGATING_ROLES.has(contractRole) || FLEET_DELEGATING_ROLES.has(role)) return surface;
  const omitted = new Set(FLEET_WORKER_OMISSIONS);
  // Delegated coordination is a ceiling the root may use. Keep only delegation
  // names the admitted surface already has; do not grant any other omission.
  if (coordinationMode === 'delegated') {
    for (const name of FLEET_DELEGATION_FUNCTIONS) omitted.delete(name);
  }
  for (const name of selected || []) omitted.delete(name);
  // Subtract only named overhead from the already admitted ceiling. Do not
  // enumerate the registry: extensions and narrow setup allowlists must survive.
  const names = surface.names.filter(name => !omitted.has(name));
  // A setup/role may admit only normally omitted tools. Preserve that useful
  // surface rather than turn valid admission into an empty-surface refusal.
  return names.length ? { ...surface, names } : surface;
}

// Only the trusted application can establish turn provenance. Tool arguments,
// model output and headless callers cannot claim a direct request.
let host = null;
function installRoleFunctionHost(value) {
  if (!value || typeof value.isDirectUserTurn !== 'function') {
    invalid('A role-function host must verify direct-user turn provenance.');
  }
  host = value;
}
function assertDirectUserAction(entry, policy, principal) {
  const normalized = normalizeFunctionPolicy(policy || {});
  const savedProfileAllows = require('./action-permission-profiles').assertAction(entry, principal);
  if (savedProfileAllows) return;
  if (!normalized.requiresDirectUserAuthorization || /-read$/.test(entry.effect)) return;
  if (!principal?.sessionId || host?.isDirectUserTurn(principal.sessionId) !== true) {
    throw Object.assign(new Error('This role may act only during a turn directly requested by the person. Agent messages, schedules and screen content are not authorization.'), {
      code: 'ROLE_DIRECT_USER_REQUEST_REQUIRED',
    });
  }
}
module.exports = {
  MAX_FUNCTIONS, SLOT_CONFIGURATION_FUNCTIONS, functionCatalog, normalizeFunctions, defaultFunctionPolicy,
  FLEET_WORKER_FUNCTIONS, FLEET_DELEGATION_FUNCTIONS, FLEET_WORKER_OMISSIONS, normalizeWorkerTools, fleetWorkerSurface,
  normalizeFunctionPolicy, narrowFunctionNames, installRoleFunctionHost, assertDirectUserAction,
};
