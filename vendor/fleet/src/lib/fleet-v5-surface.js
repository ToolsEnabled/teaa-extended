'use strict';

// Request-local presentation. It does not narrow the execution host used by
// contracts or the native tool list inherited by interior workers.
const CONTRACT_TOOLS = Object.freeze([
  'fleet.contract.options', 'fleet.contract.review', 'fleet.contract.library', 'fleet.contract.submit', 'fleet.contract.inspect',
  'fleet.contract.answer', 'fleet.contract.amend', 'fleet.contract.cancel', 'fleet.contract.determinacy'
]);
function leadToolNames({ generation, admin = false, linkedWorker = false } = {}) {
  return generation === 5 && !admin && !linkedWorker ? [...CONTRACT_TOOLS] : undefined;
}
function validateAdmin(generation, admin) {
  if (admin && generation !== 5) throw Object.assign(new Error('--admin applies only to Fleet V5 lead connections.'), { code: 'FLEET_ADMIN_INVALID' });
}
module.exports = { CONTRACT_TOOLS, leadToolNames, validateAdmin };
