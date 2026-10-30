'use strict';
// Cold rows share the tree's SQLite transaction. No evidence is deleted.
// Hysteresis amortizes list reindexing: retain LIMIT..2*LIMIT recent entries.
const { produce } = require('./fleet-state-draft');
const LIMITS = Object.freeze({ inbox: 500, items: 100, tasks: 500, reports: 500, metrics: 1000, skips: 100, rules: 100, failures: 100 });
const outcomeCounts = items => {
  const out = { reported: 0, unassessed: 0, accepted: 0, rework: 0, rejected: 0 };
  for (const item of items) {
    if (item.submission) out.reported++;
    if (item.assessment) out[item.assessment.decision]++;
    else if (['done', 'held'].includes(item.status)) out.unassessed++;
  }
  return out;
};
function streams(document) {
  const rows = [];
  const add = (kind, scope, at) => { let value = document; for (const key of at) value = value?.[key]; if (Array.isArray(value)) rows.push({ kind, scope, at, entries: value }); };
  add('tasks', '', ['fleetControl', 'taskHistory']);
  add('rules', '', ['fleetControl', 'ruleHistory']);
  add('inbox', '', ['inbox']);
  add('reports', '', ['workerReports']); add('metrics', '', ['fleetMetrics', 'entries']);
  for (const id of Object.keys(document.fleetControl?.lanes || {})) {
    const at = ['fleetControl', 'lanes', id];
    add('items', id, [...at, 'items']); add('rules', id, [...at, 'ruleHistory']);
    add('failures', id, [...at, 'failureHistory']); add('skips', id, [...at, 'schedule', 'skips']);
  }
  return rows;
}
function plan(document) {
  const moves = [];
  for (const stream of streams(document)) {
    const limit = LIMITS[stream.kind];
    if (stream.entries.length <= limit * 2) continue;
    let n = stream.entries.length - limit;
    // Never evict active/queued work or leap over it: item ordering stays stable.
    if (stream.kind === 'inbox') {
      const unread = stream.entries.findIndex(item => !item.deliveredAt);
      if (unread >= 0) n = Math.min(n, unread);
    }
    if (stream.kind === 'items') {
      const unfinished = stream.entries.findIndex(item => !['done', 'held'].includes(item.status));
      if (unfinished >= 0) n = Math.min(n, unfinished);
    }
    if (n) moves.push({ ...stream, entries: stream.entries.slice(0, n), keep: stream.entries.slice(n) });
  }
  if (!moves.length) return { document, moves };
  // The outer document is mutable host state; produce only immutable branches.
  const next = { ...document };
  for (const key of ['fleetControl', 'fleetMetrics']) if (moves.some(move => move.at[0] === key)) {
    next[key] = produce(document[key], draft => {
      for (const move of moves.filter(move => move.at[0] === key)) {
        let parent = draft; for (const part of move.at.slice(1, -1)) parent = parent[part];
        parent[move.at.at(-1)] = move.keep;
        if (move.kind === 'items') {
          const saved = parent.archivedItems ||= { total: 0, done: 0, held: 0, outcomes: {} };
          saved.total += move.entries.length;
          for (const item of move.entries) saved[item.status]++;
          for (const [name, count] of Object.entries(outcomeCounts(move.entries))) saved.outcomes[name] = (saved.outcomes[name] || 0) + count;
        }
      }
    });
  }
  if (moves.some(move => move.kind === 'inbox')) next.inbox = produce(moves.find(move => move.kind === 'inbox').keep, () => {});
  if (moves.some(move => move.at[0] === 'workerReports')) next.workerReports = produce(moves.find(move => move.kind === 'reports').keep, () => {});
  return { document: next, moves };
}
module.exports = { LIMITS, streams, plan, outcomeCounts };
