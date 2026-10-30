'use strict';

// Standalone Fleet's rules are the variable agent layer. The person's own
// instructions stay outside that layer; a quoted sentence is provenance only.
function isFleetRules(env = process.env) {
  return env.TOOLSENABLED_RUNTIME_MODE === 'host'
    && env.TOOLSENABLED_FLEET_PROFILE === 'fleetV2'
    && env.TOOLSENABLED_HOST_SETUP_KIND !== 'plugin';
}
function isLead(env = process.env) {
  const host = require('./tree-host-registry').treeSpawnHost();
  if (host) return host.fleetOrchestrator === true;
  // configureHost sets this from saved configuration. serveHost refuses a
  // linked worker in coordination-only mode before serving any tools.
  return isFleetRules(env) && env.TOOLSENABLED_HOST_WORKERS === '0'
    && !env.TOOLSENABLED_HOST_NODE && !env.TOOLSENABLED_HOST_TREE_SOCKET
    && !env.TOOLSENABLED_HOST_SESSION;
}
function assertLead(actor) {
  if (!isLead() || actor === 'owner' || typeof actor !== 'string' || !actor.trim()) {
    throw Object.assign(new Error('Fleet agent rules are filed and revised by the lead. Report the needed change through fleet.control.'), { code: 'FLEET_RULE_LEAD_REQUIRED' });
  }
}
module.exports = { isFleetRules, isLead, assertLead };
