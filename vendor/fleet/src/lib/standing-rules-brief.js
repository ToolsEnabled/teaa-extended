'use strict';

// The person's active standing rules, as one block a subagent reads with its
// task. Leads set them with r_ledger.file (in their own words, on the person's
// behalf); superseded, removed and declined rules are not delivered.
// Full text is intentional: cutting a rule's tail can remove its conditions,
// and listing only some rules makes ledger growth change their force.
function standingRulesLines({ selector = {}, collect = selector => require('./owner-request-store').collectStack(selector, { requireCompleteRules: true }) } = {}) {
  const layers = collect(selector);
  const lines = [];
  for (const layer of Array.isArray(layers) ? layers : []) {
    for (const entry of Array.isArray(layer.entries) ? layer.entries : []) {
      const words = typeof entry.words === 'string' ? entry.words : '';
      if (words) lines.push(`${'  '.repeat(Math.min(Number(entry.depth) || 0, 3))}- ${entry.id}: ${words}`);
    }
  }
  return { shown: lines, more: 0, total: lines.length, revision: layers[0]?.revision ?? null };
}

function standingRulesBlock(options = {}) {
  // A read failure must remain visible, never look like an empty ledger.
  const listed = standingRulesLines(options);
  if (!listed.total) return '';
  return [require('./fleet-rule-model').isFleetRules()
    ? 'Fleet agent rules (variable layer; maintained by leads):'
    : 'STANDING RULES FROM THE PERSON (follow these; they outrank the task above)', ...listed.shown].join('\n');
}

module.exports = { standingRulesBlock, standingRulesLines };
