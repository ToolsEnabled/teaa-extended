'use strict';

// A caller can opt into target-scoped optimistic concurrency using a control
// revision it already read. Whole-tree checks keep their original semantics.
const { produce } = require('./fleet-state-draft');
const own = (value, key) => value && Object.hasOwn(value, key) ? value[key] : undefined;
const changed = (before = {}, after = {}, visit) => {
  if (before === after) return;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
    if (own(before, key) !== own(after, key)) visit(key, own(before, key), own(after, key));
};
function validate(value, revision) {
  if (value === undefined) return;
  const count = n => Number.isSafeInteger(n) && n >= 0 && n <= revision;
  if (!value || value.v !== 1 || value.through !== revision || !count(value.since) || !count(value.global)
      || value.global < value.since || !['nodes', 'jobs'].every(key => value[key] && typeof value[key] === 'object'
        && !Array.isArray(value[key]) && Object.values(value[key]).every(n => count(n) && n >= value.since)))
    throw Object.assign(new Error('The retained write revisions are invalid; state was preserved.'), { code: 'FLEET_CONTROL_STORE_INVALID' });
}
function retain(before, after, nodes) {
  const touchedNodes = new Set(), touchedJobs = new Set();
  const touch = id => { if (typeof id === 'string') touchedNodes.add(id); };
  changed(before.tasks, after.tasks, id => touch(id));
  changed(before.asks, after.asks, (_id, a, b) => { touch(a?.nodeId); touch(b?.nodeId); });
  changed(before.lanes, after.lanes, (id, a, b) => { touchedJobs.add(id); touch(a?.nodeId); touch(b?.nodeId); });
  if (before.taskHistory !== after.taskHistory) {
    const a = before.taskHistory || [], b = after.taskHistory || [];
    for (let n = 0; n < Math.max(a.length, b.length); n++) if (a[n] !== b[n]) { touch(a[n]?.nodeId); touch(b[n]?.nodeId); }
  }
  if (before.archivedAssessment !== after.archivedAssessment) touch(after.archivedAssessment?.nodeId);
  if (before.lifecycle !== after.lifecycle) {
    touch(after.lifecycle?.nodeId);
    // A subtree stop affects every descendant, even if their control records
    // have not otherwise changed. Keep this proof across host reconstruction.
    if (after.lifecycle?.action === 'stop-subtree') {
      const descendants = new Set([after.lifecycle.nodeId]);
      for (let added = true; added;) {
        added = false;
        for (const node of nodes) if (descendants.has(node.parentNodeId) && !descendants.has(node.nodeId)) {
          descendants.add(node.nodeId); added = true;
        }
      }
      for (const id of descendants) touch(id);
    }
  }
  const scoped = new Set(['v', 'revision', 'updatedAt', 'tasks', 'asks', 'lanes', 'taskHistory', 'lifecycle', 'writeRevisions', 'archivedAssessment']);
  // Shared rules/settings and future unknown control fields invalidate all
  // targets. New fields cannot silently escape concurrency protection.
  const global = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .some(key => !scoped.has(key) && before[key] !== after[key]);
  const previous = before.writeRevisions || { v: 1, since: before.revision, through: before.revision, global: before.revision, nodes: {}, jobs: {} };
  const revisions = produce(previous, draft => {
    draft.through = after.revision;
    if (global) draft.global = after.revision;
    for (const id of touchedNodes) draft.nodes[id] = after.revision;
    for (const id of touchedJobs) draft.jobs[id] = after.revision;
  });
  return produce(after, draft => { draft.writeRevisions = revisions; });
}
const nodeActions = new Set(['task', 'progress', 'complete', 'hold', 'pause', 'stop', 'resume', 'remove', 'assess']);
const jobActions = new Set(['lane', 'lane-add', 'lane-rule', 'lane-resume', 'lane-close', 'lane-schedule']);
function supported(action) { return nodeActions.has(action) || jobActions.has(action) || action === 'answer' || action === 'archive-ask'; }
function unchanged(value, nodes, input, action) {
  const revision = input.expectedRevision, saved = value.writeRevisions;
  if (!saved || saved.through !== value.revision || revision < saved.since || revision < saved.global) return false;
  const targets = new Set();
  if (nodeActions.has(action)) targets.add(input.nodeId);
  if (jobActions.has(action)) {
    if (!input.id || (own(saved.jobs, input.id) || 0) > revision) return false;
    const job = own(value.lanes, input.id);
    if (job?.nodeId) targets.add(job.nodeId);
    if (action === 'lane') targets.add(input.nodeId);
  }
  if (action === 'answer' || action === 'archive-ask') targets.add(own(value.asks, input.id)?.nodeId);
  if (!targets.size || targets.has(undefined)) return false;
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  for (const target of targets) {
    if (!byId.has(target)) return false;
    const visited = new Set();
    // Ancestor jobs/rules and lifecycle can affect a descendant's next turn.
    for (let node = byId.get(target); node; node = byId.get(node.parentNodeId)) {
      if (visited.has(node.nodeId)) return false;
      visited.add(node.nodeId);
      if ((own(saved.nodes, node.nodeId) || 0) > revision) return false;
    }
  }
  return true;
}
module.exports = { validate, retain, supported, unchanged };
