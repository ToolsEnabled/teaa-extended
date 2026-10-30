'use strict';

// THE RULES LEDGER, AS THE PERSON AND A LEAD NEED TO SEE IT.
//
// On an earlier Fleet V2 install ledger.read answered exists:false for every
// kind, and nothing said why: an empty answer read like a working ledger with
// nothing in it. This reports whether the ledger exists, how many rules are
// active, superseded or waiting, and whether agents may set rules -- and lists
// anything missing in `problems`, in plain words. It never throws; a part that
// could not be read says so instead of reading as empty.
function health({ rootPath, loadSettings = () => require('./settings').loadSettings() } = {}) {
  const options = rootPath ? { rootPath } : {};
  const problems = [];
  let ledger;
  try {
    const all = require('./owner-request-store').readAll({ ...options, kinds: ['R'], includeProposed: true, includeRemoved: true });
    const count = status => all.records.filter(record => record.status === status).length;
    const active = all.records.filter(record => ['open', 'in-progress', 'partial', 'blocked-external'].includes(record.status)).length;
    ledger = { exists: all.exists, file: all.path, activeRules: active, supersededRules: count('superseded'), awaitingApproval: count('proposed'), removedRules: count('removed') };
    if (require('./fleet-rule-model').isFleetRules()) {
      const { awaitingApproval, ...current } = ledger;
      ledger = { ...current, retainedProposals: awaitingApproval };
    }
    if (!all.exists) problems.push(`No rules ledger exists yet at ${all.path}: no standing rule has been set in this install. Leads set rules with r_ledger.file.`);
  } catch (error) {
    ledger = { exists: null, activeRules: null, error: error.code || 'LEDGER_UNREADABLE' };
    problems.push(`The rules ledger could not be read (${ledger.error}); whether any rule stands is unknown.`);
  }
  let filing;
  try {
    const decision = require('./r-ledger-agent-gate').agentFilingMode({ settings: loadSettings() });
    filing = { agentsMayFile: decision.mode === 'auto', filingFrom: decision.filingFrom, source: decision.provenance?.source || 'default', why: decision.why, ...(decision.note ? { note: decision.note } : {}) };
    if (require('./fleet-rule-model').isFleetRules()) filing = { leadsMayFile: true, filingFrom: 'Leads', source: 'program', needsApproval: false, why: null };
    if (!filing.agentsMayFile && !filing.leadsMayFile) problems.push(`Agents may not set standing rules here: ${decision.why}`);
  } catch (error) {
    // The gate itself answers on when settings are unreadable; report it.
    filing = { agentsMayFile: true, note: `settings could not be read (${error.code || 'unreadable'}); agents may still set rules.` };
    if (require('./fleet-rule-model').isFleetRules()) filing = { leadsMayFile: true, filingFrom: 'Leads', source: 'program', needsApproval: false, why: null, note: 'Legacy settings could not be read; lead-managed rule filing is unchanged.' };
  }
  return { ledger, filing, problems };
}

module.exports = Object.freeze({ health });
