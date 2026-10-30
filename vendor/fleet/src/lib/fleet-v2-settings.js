'use strict';
// The inventory is copied from the pinned 1.0.50 register, including exclusions.
const inventory = require('../../config/fleet-v2-settings-import.json');
const LEGACY_RULE_SETTINGS = Object.freeze(new Set(['rules.filing_from', 'rules.capture_spoken', 'rules.ask_when_unsure', 'rules.agent_filed_needs_approval', 'rules.agent_proposals']));
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function prepare(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length || Object.keys(changes).length > 100)
    fail('FLEET_SETTINGS_INVALID', 'Supply one to one hundred setting id/value pairs.');
  const registry = require('./settings-registry').loadRegistry();
  const stored = [], policies = {}, ignored = [];
  for (const [id, value] of Object.entries(changes)) {
    if (LEGACY_RULE_SETTINGS.has(id)) { ignored.push({ id, reason: 'Fleet agent rules are lead-managed; legacy filing and approval choices have no effect. Use fleet.control action rule for lead-managed rules.' }); continue; }
    const row = inventory.entries.find(row => row.id === id);
    if (row?.disposition === 'assignment-policy') {
      const reason = require('./settings-values').validateSettingValue(row.original, value);
      if (reason) fail('FLEET_SETTINGS_INVALID', reason);
      policies[id] = value;
      continue;
    }
    const entry = registry.byId.get(id);
    if (!entry || row?.disposition === 'excluded') fail('FLEET_SETTING_EXCLUDED', row?.reason || `Unknown setting ${id}.`);
    if (entry.control === 'readback' || ['capability.tier', 'capability.workspace_roots'].includes(id))
      fail('FLEET_SETTING_AUTHORITY_REFUSED', 'Settings cannot change the parent folder scope or the installation permission boundary.');
    if (id === 'agent.status_injection_overrides' && !require('./fleet-v2-observability').validOverrides(value)) fail('FLEET_SETTINGS_INVALID', 'Use unique exact agent, lane or host status overrides with boolean enabled values.');
    const reason = require('./settings').validationFailure(entry, value);
    if (reason) fail('FLEET_SETTINGS_INVALID', reason);
    stored.push([id, value]);
  }
  return { stored, policies, ignored };
}
function prepareImport(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).length > 512)
    fail('FLEET_SETTINGS_INVALID', 'Import a bounded map of old setting ids and values, excluding credentials.');
  const included = {}, skipped = [];
  let resources, permissionProfiles;
  const known = new Set(require('./settings-registry').loadRegistry().byId.keys());
  for (const [id, value] of Object.entries(changes)) {
    if (LEGACY_RULE_SETTINGS.has(id)) { skipped.push({ id, reason: 'Fleet agent rules are lead-managed; legacy filing and approval choices have no effect. Use fleet.control action rule for lead-managed rules.' }); continue; }
    if (id === 'mc.action-permissions.v1') { permissionProfiles = require('./action-permission-profiles').normalize(value); continue; }
    if (id === 'mc.resources.v1') {
      let policy;
      try { policy = typeof value === 'string' ? JSON.parse(value) : value; } catch { fail('FLEET_RESOURCE_POLICY_INVALID', 'The imported resource policy is not valid JSON.'); }
      resources = require('./fleet-v2-resources').validatePolicy(policy); continue;
    }
    const row = inventory.entries.find(row => row.id === id);
    if (row?.disposition === 'excluded' || !row && !known.has(id)) { skipped.push({ id, reason: require('./fleet-recovery').message('FLEET_SETTING_EXCLUDED', row?.reason || 'No FleetV2 setting with this id.', { tool: 'fleet.control' }) }); continue; }
    included[id] = value;
  }
  if (Object.keys(included).length) prepare(included);
  return { included, skipped, ...(resources ? { resources } : {}), ...(permissionProfiles ? { permissionProfiles } : {}) };
}
function importSettings(changes) {
  const { included, skipped, resources, permissionProfiles } = prepareImport(changes);
  return { ...(Object.keys(included).length ? set(included) : { policies: {} }), skipped, ...(resources ? { resources } : {}), ...(permissionProfiles ? { permissionProfiles } : {}) };
}
function set(changes) {
  const { stored, policies, ignored } = prepare(changes);
  return { ...(stored.length ? require('./openshell-settings-page').set(stored) : {}), policies, ignored };
}
module.exports = { prepare, prepareImport, set, importSettings, inventory, LEGACY_RULE_SETTINGS };
