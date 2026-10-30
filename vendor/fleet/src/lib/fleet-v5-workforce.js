'use strict';

function refusal(code, message) { throw Object.assign(new Error(message), { code }); }
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
function normalize(input, { contractId, objectiveRef, rootRole } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) refusal('FLEET_V5_WORKFORCE_INVALID', 'workforce must be an object.');
  const topology = input.topology;
  if (!['solo', 'adaptive'].includes(topology)) refusal('FLEET_V5_WORKFORCE_INVALID', 'workforce.topology must be solo or adaptive.');
  if (!Number.isSafeInteger(input.maxAgents) || input.maxAgents < 1) refusal('FLEET_V5_WORKFORCE_INVALID', 'workforce.maxAgents must be a positive safe integer.');
  const list = (value, field) => {
    if (!Array.isArray(value) || value.length === 0 || value.some(x => typeof x !== 'string' || !x.trim()) || new Set(value).size !== value.length)
      refusal('FLEET_V5_WORKFORCE_INVALID', `workforce.${field} must be a nonempty list of unique names.`);
    return [...value].sort();
  };
  const roles = list(input.allowedRoles, 'allowedRoles');
  const providers = list(input.providers, 'providers');
  const selectedRootRole = rootRole || input.rootRole || 'worker';
  if (typeof selectedRootRole !== 'string' || !selectedRootRole.trim())
    refusal('FLEET_V5_WORKFORCE_ROOT_ROLE_REFUSED', 'workforce.rootRole must be nonempty text.');
  const id = contractId || objectiveRef;
  if (typeof id !== 'string' || !ID.test(id)) refusal('FLEET_V5_WORKFORCE_INVALID', 'A stable contract identity is required for workforce admission.');
  if (topology === 'solo' && input.maxAgents !== 1) refusal('FLEET_V5_WORKFORCE_INVALID', 'Solo topology has exactly one member and requires maxAgents: 1.');
  const coordination = input.coordination === undefined ? { mode: topology === 'adaptive' ? 'delegated' : 'none' } : structuredClone(input.coordination);
  if (!coordination || typeof coordination !== 'object' || Array.isArray(coordination)) refusal('FLEET_V5_WORKFORCE_INVALID', 'workforce.coordination must be an object.');
  if (!['none', 'delegated'].includes(coordination.mode)
      || topology === 'adaptive' && coordination.mode !== 'delegated'
      || topology === 'solo' && coordination.mode !== 'none')
    refusal('FLEET_V5_WORKFORCE_INVALID', 'Supported coordination is none for solo or delegated for adaptive topology.');
  return Object.freeze({ contractId: id, objectiveRef: id, topology, rootRole: selectedRootRole, maxAgents: input.maxAgents,
    allowedRoles: Object.freeze(roles), providers: Object.freeze(providers), coordination });
}
function samePolicy(a, b) {
  return JSON.stringify({ ...a, allowedRoles: [...a.allowedRoles].sort(), providers: [...a.providers].sort() })
    === JSON.stringify({ ...b, allowedRoles: [...b.allowedRoles].sort(), providers: [...b.providers].sort() });
}
function memberCount(nodes, contractId) {
  return nodes.filter(node => node?.workforceMembership?.contractId === contractId).length;
}
function inherit({ request, caller, nodes, rootRequest = false }) {
  const parent = caller.kind === 'node' ? caller.node.workforceMembership : null;
  const supplied = request.workforce;
  if (!parent && !supplied) return null;
  if (parent && supplied) {
    const proposed = normalize(supplied, { contractId: parent.contractId });
    if (!samePolicy(parent, proposed)) refusal('FLEET_V5_WORKFORCE_INHERITANCE', 'A child cannot replace, drop, or loosen inherited contract workforce limits.');
  }
  if (!parent && !rootRequest) return null;
  const membership = parent || normalize(supplied, { contractId: request.objectiveRef });
  if (request.objectiveRef && !(parent && request.objectiveRefDerived === true) && request.objectiveRef !== membership.contractId)
    refusal('FLEET_V5_WORKFORCE_INHERITANCE', 'A child cannot change its inherited objectiveRef.');
  const role = request.role || 'worker';
  if (!membership.allowedRoles.includes(role)) refusal('FLEET_V5_WORKFORCE_ROLE_REFUSED', `Role "${role}" is outside the contract workforce allowlist.`);
  const provider = request.provider;
  if (provider && !membership.providers.includes(provider)) refusal('FLEET_V5_WORKFORCE_PROVIDER_REFUSED', `Provider "${provider}" is outside the contract workforce allowlist.`);
  const count = memberCount(nodes, membership.contractId);
  if (count >= membership.maxAgents) refusal('FLEET_V5_WORKFORCE_LIMIT', `Contract workforce already has ${count} of ${membership.maxAgents} retained members.`);
  return structuredClone(membership);
}
function resumeAdmission(nodes, node) {
  const membership = node?.workforceMembership;
  if (!membership) return;
  const count = memberCount(nodes, membership.contractId);
  if (count > membership.maxAgents) refusal('FLEET_V5_WORKFORCE_LIMIT', `Contract workforce has ${count} retained members, above its maximum of ${membership.maxAgents}; no member was resumed.`);
  const targetRole = node.pending?.role || node.role;
  const targetProvider = node.pending?.provider || node.provider;
  if (!membership.allowedRoles.includes(targetRole) || !membership.providers.includes(targetProvider)
      || node.objectiveRef !== membership.contractId)
    refusal('FLEET_V5_WORKFORCE_INTEGRITY', 'The retained worker no longer matches its contract workforce membership.');
}
function assertReusePolicy(node, request) {
  const membership = node?.workforceMembership;
  if (!membership) {
    if (request.workforce) refusal('FLEET_V5_WORKFORCE_INHERITANCE', 'A contract workforce cannot be attached to an unrelated reused worker.');
    return;
  }
  if (request.objectiveRef !== membership.contractId || !request.workforce) refusal('FLEET_V5_WORKFORCE_INHERITANCE', 'Reusing a contract member requires its original objectiveRef and complete workforce policy.');
  const proposed = normalize(request.workforce, { contractId: membership.contractId });
  if (!samePolicy(membership, proposed)) refusal('FLEET_V5_WORKFORCE_INHERITANCE', 'A reused contract member cannot drop or loosen its workforce policy.');
}
module.exports = Object.freeze({ normalize, inherit, memberCount, resumeAdmission, assertReusePolicy });
