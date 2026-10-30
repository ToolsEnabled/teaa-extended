'use strict';
const ACTIONS = Object.freeze(['read', 'ask', 'progress', 'complete', 'hold']);
const FIELDS = new Set(['action', 'id', 'text', 'question', 'compact', 'view', 'approvalToken', 'result', 'expectedTaskRevision', 'waitSeconds']);
function workerSchema(schema) {
  return { ...schema, properties: Object.fromEntries(Object.entries(schema.properties).filter(([name]) => FIELDS.has(name)).map(([name, property]) =>
    [name, name === 'action' ? { ...property, enum: ACTIONS } : property])) };
}
function workerEntry(entry) {
  return Object.freeze({ ...entry,
    description: 'Read your durable assignment/asks (view: compact omits bodies and history), file a stable-id ask, or report progress/completion on your own current task. On ask/progress/complete/hold, omitted expectedTaskRevision uses the revision sent to your current turn; an old turn cannot report on a newer task. Supply it explicitly when needed after reading the assignment. Complete/hold can include result artifacts and check evidence; lead command checks run asynchronously after complete: verifying becomes completed with Fleet verification, or assigned for rework (held after 3 failures or continuation off). Acceptance of other evidence belongs to the lead. Waiting on something outside your control: record progress with waitSeconds and end your turn; Fleet sends no automatic turn before then. In a job, hold your current task with text giving the reason when you cannot finish it; the job moves on. A job is a rooted ruleset and task queue. Lifecycle, task/rule edits, ask answers and settings belong to the orchestrator.',
    inputSchema: workerSchema(entry.inputSchema), baseInputSchema: workerSchema(entry.baseInputSchema) });
}
function compactView(input = {}, defaultValue = true) {
  if (input.view !== undefined) return input.view === 'compact';
  return input.compact === undefined ? defaultValue : input.compact === true;
}
function pageEntries(entries, input = {}) {
  const offset = input.offset ?? 0, limit = input.limit;
  if (!Number.isSafeInteger(offset) || offset < 0 || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)))
    throw Object.assign(new Error('Use a nonnegative offset and a positive page size.'), { code: 'FLEET_CONTROL_PAGE_INVALID' });
  const selected = entries.slice(offset, limit === undefined ? undefined : offset + limit);
  return { selected, page: { offset, total: entries.length, returned: selected.length,
    nextOffset: offset + selected.length < entries.length ? offset + selected.length : null } };
}
// Compact reads omit retained bodies and history rather than slicing text or
// sampling records. Full reads remain available with the original shape.
function compactTask(task) {
  if (!task) return null;
  const { text, progress, requirements, submission, assessment, assessments, auto, verificationHistory, ...metadata } = task;
  const outcome = require('./fleet-task-results').outcome(task);
  // Automatic continuation state without its internal progress fingerprint.
  const continuation = auto ? { turns: auto.turns || 0, unchanged: auto.unchanged || 0, ...(auto.pending ? { pending: true } : {}), ...(auto.stopped ? { stopped: auto.stopped } : {}) } : null;
  return { ...metadata, ...(continuation ? { auto: continuation } : {}), ...(outcome ? { outcome } : {}) };
}
function compactWorker(worker) {
  return Object.fromEntries(['nodeId', 'displayName', 'parent', 'parentNodeId', 'provider', 'tier', 'model',
    'state', 'turn', 'error', 'sessionId', 'threadId', 'taskRevision', 'assignmentRevision'].filter(key =>
      Object.hasOwn(worker, key)).map(key => [key, worker[key]]));
}
function compactRecord(value, filter = {}) {
  const matches = (nodeId, task) => (!filter.nodeId || nodeId === filter.nodeId) && (!filter.status || task?.status === filter.status);
  const { selected, page } = pageEntries(Object.entries(value.tasks).filter(([id, task]) => matches(id, task)), filter);
  const selectedIds = new Set(selected.map(([id]) => id));
  const paged = filter.offset !== undefined || filter.limit !== undefined;
  return { v: value.v, revision: value.revision, updatedAt: value.updatedAt,
    tasks: Object.fromEntries(selected.map(([id, task]) => [id, compactTask(task)])),
    rules: Object.fromEntries(Object.entries(value.rules).map(([id, { text, ...metadata }]) => [id, metadata])),
    asks: Object.fromEntries(Object.entries(value.asks).filter(([, ask]) => matches(ask.nodeId, value.tasks[ask.nodeId]) && (!paged || selectedIds.has(ask.nodeId))).map(([id, ask]) => {
      const { question, answer, ...metadata } = ask;
      return [id, ask.status === 'open' ? ask : metadata];
    })),
    historyCounts: { tasks: value.taskHistory?.length || 0, rules: value.ruleHistory?.length || 0 },
    ...(paged ? { page } : {}),
    ...(value.lifecycle ? { lifecycle: value.lifecycle } : {}),
    ...(value.lastNoticeError && (!filter.nodeId || value.lastNoticeError.nodeId === filter.nodeId) ? { lastNoticeError: value.lastNoticeError } : {}) };
}
function fullRecord(value, filter = {}, nodes = []) {
  // The persisted concurrency index is internal bookkeeping, not assignment
  // context. Returning it would make even a single-worker read grow with the
  // whole tree again. Callers already have the control revision they need.
  const { writeRevisions, ...visible } = value;
  if (!filter.nodeId && !filter.status && filter.offset === undefined && filter.limit === undefined) return visible;
  const matches = (id, task) => (!filter.nodeId || id === filter.nodeId) && (!filter.status || task?.status === filter.status);
  const { selected, page } = pageEntries(Object.entries(value.tasks).filter(([id, task]) => matches(id, task)), filter);
  const selectedIds = new Set(selected.map(([id]) => id));
  const ancestors = new Set(selectedIds), byId = new Map(nodes.map(node => [node.nodeId, node]));
  for (const id of selectedIds) {
    const visited = new Set();
    for (let node = byId.get(id); node && !visited.has(node.nodeId); node = byId.get(node.parentNodeId)) {
      visited.add(node.nodeId); ancestors.add(node.nodeId);
    }
  }
  return { ...visible, tasks: Object.fromEntries(selected),
    asks: Object.fromEntries(Object.entries(value.asks).filter(([, ask]) => selectedIds.has(ask.nodeId))),
    ...(value.taskHistory ? { taskHistory: value.taskHistory.filter(task => selectedIds.has(task.nodeId)) } : {}),
    ...(value.lanes ? { lanes: Object.fromEntries(Object.entries(value.lanes).filter(([, lane]) => ancestors.has(lane.nodeId))) } : {}),
    ...(filter.offset !== undefined || filter.limit !== undefined ? { page } : {}) };
}
// Edits acknowledge the changed record, never every sibling's body/history.
// Explicit full receipts remain available for callers that need the old shape.
function mutationReceipt(value, input) {
  if (value?.v === 1 && value.tasks && value.rules && value.asks && Object.hasOwn(value, 'writeRevisions')) {
    const { writeRevisions, ...visible } = value; value = visible;
  }
  if (!value || input.action === 'read' || !compactView(input)) return value;
  if (value.v === 1 && value.tasks && value.rules && value.asks) {
    const receipt = { revision: value.revision, action: input.action };
    if (input.nodeId) {
      receipt.nodeId = input.nodeId;
      if (value.tasks[input.nodeId]) receipt.task = compactTask(value.tasks[input.nodeId]);
    }
    if (input.action === 'rule' && value.rules[input.id]) {
      const { text, ...metadata } = value.rules[input.id]; receipt.rule = { id: input.id, ...metadata };
    }
    if (['answer', 'archive-ask'].includes(input.action) && value.asks[input.id]) {
      const { question, answer, ...metadata } = value.asks[input.id]; receipt.ask = { id: input.id, ...metadata };
      if (input.action === 'answer' && input.resume === false) receipt.nextAction = { action: 'resume', nodeId: metadata.nodeId, expectedRevision: value.revision };
    }
    return receipt;
  }
  if (value.task) return { ...value, task: compactTask(value.task) };
  return value;
}
module.exports = { workerEntry, compactView, pageEntries, compactTask, compactRecord, fullRecord, compactWorker, mutationReceipt };
