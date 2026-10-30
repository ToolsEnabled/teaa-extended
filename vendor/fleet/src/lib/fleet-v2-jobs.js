'use strict';
// A job is a ruleset and a queue rooted at one agent. Legacy lane records
// remain the queue store; legacy tree ledger scopes name job roots.
const crypto = require('node:crypto');
const { standingRulesLines } = require('./standing-rules-brief');

function lineage(nodes, nodeId) {
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const chain = [];
  for (let node = byId.get(nodeId); node; node = byId.get(node.parentNodeId)) {
    if (chain.some(parent => parent.nodeId === node.nodeId)) throw new Error('Fleet job ancestry contains a cycle.');
    chain.push(node);
  }
  return chain.reverse();
}
function contextFor(document, node, { rootSessionId, rootAgentId, treeId } = {}) {
  const ancestors = lineage(document.nodes, node.nodeId);
  return { sessionId: node.sessionId, threadId: node.threadId,
    treeAnchors: [...new Set([document.treeKey, document.treeId, treeId, rootSessionId, rootAgentId,
      ...ancestors.flatMap(parent => [parent.nodeId, parent.threadId])].filter(Boolean))] };
}
function jobRules(document, nodeId) {
  const value = document.fleetControl || {};
  const lines = Object.entries(value.rules || {}).filter(([, rule]) => rule.active).map(([id, rule]) => `${id}: ${rule.text}`);
  const ancestors = new Set(lineage(document.nodes, nodeId).map(node => node.nodeId));
  for (const [id, lane] of Object.entries(value.lanes || {})) {
    if (!ancestors.has(lane.nodeId) || !['running', 'idle', 'paused'].includes(lane.state)) continue;
    lines.push(`Job ${id} rules (root ${lane.nodeId}):`);
    for (const [rule, record] of Object.entries(lane.rules || {})) if (record.active) lines.push(`${rule}: ${record.text}`);
  }
  return { revision: value.revision || 0, text: lines.join('\n') };
}
function rulesSnapshot({ document, node, rootSessionId, rootAgentId, treeId, getRules = null, collect, additionalRules = '' } = {}) {
  const selector = contextFor(document, node, {rootSessionId, rootAgentId, treeId});
  const listed = standingRulesLines({ selector, ...(collect ? {collect} : {}) });
  const job = getRules ? getRules(node.nodeId) : jobRules(document, node.nodeId);
  if (!job || !Number.isSafeInteger(job.revision) || typeof job.text !== 'string') throw new Error('Current job rules revision is unavailable.');
  const body = [
    ...(listed.total ? [require('./fleet-rule-model').isFleetRules()
      ? 'Fleet agent rules (variable layer; maintained by leads):'
      : 'STANDING RULES FROM THE PERSON (follow these; they outrank the task above)', ...listed.shown] : []),
    ...(job.text ? ['Job rules:', job.text] : []),
    ...(additionalRules ? [additionalRules] : [])
  ].join('\n');
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  return `Rules revision: ledger ${listed.revision ?? 'empty'}; control ${job.revision}; sha256 ${digest}\n${body}`;
}
module.exports = { lineage, contextFor, jobRules, rulesSnapshot };
