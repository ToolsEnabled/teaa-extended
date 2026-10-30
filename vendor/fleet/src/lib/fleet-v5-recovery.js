'use strict';
// Projection and native lifecycle only: this module never resumes a turn,
// schedules work, changes requirements or infers a checked/accepted outcome.
const scrub = value => require('./audit').scrubText(String(value), 2000);
function refusal(code, message, quiescence) {
  return Object.assign(new Error(message), { code, ...(quiescence ? { quiescence } : {}) });
}
function ownsTask(record, job, task) {
  return job?.id === record.execution.jobId && (!job.nodeId || job.nodeId === record.execution.nodeId)
    && Number.isSafeInteger(task?.taskRevision) && task.taskRevision > 0
    && (!task.lane || task.lane === job.id)
    && job.items?.some(item => item.taskRevision === task.taskRevision) === true;
}
function workerRows(value) {
  if (Array.isArray(value)) return value;
  const page = value?.page;
  return Array.isArray(value?.items) && (!page || page.offset === 0 && page.returned === page.total) ? value.items : null;
}
function ownedSubtree(record, workers) {
  const rows = workerRows(workers);
  if (!rows?.some(row => row.nodeId === record.execution.nodeId)) return null;
  const ids = new Set([record.execution.nodeId]);
  let size;
  do {
    size = ids.size;
    for (const row of rows) if (ids.has(row.parentNodeId)) ids.add(row.nodeId);
  } while (ids.size !== size);
  return rows.filter(row => ids.has(row.nodeId));
}
function diagnosedStoppedSubtree(record, workers, nativeRead) {
  const inventory = ownedSubtree(record, workers);
  const diagnostics = ownedSubtree(record, nativeRead?.workers);
  if (!inventory || !diagnostics || inventory.length !== diagnostics.length) return null;
  const byId = new Map(diagnostics.map(row => [row.nodeId, row]));
  if (byId.size !== diagnostics.length || new Set(inventory.map(row => row.nodeId)).size !== inventory.length) return null;
  // Inventory establishes complete membership, not cleanup. Every member must
  // also have its full native diagnostic row; omission cannot mean no error.
  const stopped = row => row?.state === 'stopped' && row.turn === 'none' && !row.error;
  return inventory.every(row => stopped(row) && stopped(byId.get(row.nodeId))) ? diagnostics : null;
}
function confirmation(record, proof) {
  return proof?.status === 'confirmed' && proof.nodeId === record.execution.nodeId
    && proof.jobId === record.execution.jobId && proof.total > 0 && proof.quiescent === proof.total;
}
// Rows that decide a contract's outcome. A hold remains decisive until an
// amendment explicitly links that exact native item to appended resolution work.
// A held native item stops deciding only when a retained amendment explicitly
// links that exact held item to a later appended work item. Later work alone
// never acknowledges an earlier hold.
function decidingRows(rows, record = null) {
  const resolved = new Set();
  for (const amendment of record?.amendments || []) {
    if (!Number.isSafeInteger(amendment.workItemN) || !Array.isArray(amendment.resolvedWorkItems)
        || !Array.isArray(amendment.resolvedNativeItems)) continue;
    for (const n of amendment.resolvedWorkItems) {
      const row = rows.find(item => item.n === n);
      const evidence = amendment.resolvedNativeItems.find(item => item.n === n && item.status === 'held'
        && item.jobId === record?.execution?.jobId
        && (!Number.isSafeInteger(item.taskRevision) || item.taskRevision === row?.taskRevision));
      if (Number.isSafeInteger(n) && n > 0 && n < amendment.workItemN && evidence && row?.status === 'held') resolved.add(n);
    }
  }
  return rows.filter(row => row.status !== 'held' || !resolved.has(row.n));
}

function projectRecovery(record, { job, nativeRead, currentTask, rows, workers }) {
  const nodeId = record.execution.nodeId;
  const ownsCurrentTask = ownsTask(record, job, currentTask);
  // The workforce inventory omits native diagnostic fields; retain those from
  // the scoped full control read while using the later inventory's state.
  const nativeRoot = nativeRead?.workers?.find(row => row.nodeId === nodeId);
  const inventoryRoot = workerRows(workers)?.find(row => row.nodeId === nodeId);
  const root = nativeRoot || inventoryRoot ? { ...nativeRoot, ...inventoryRoot } : null;
  const asks = Object.entries(nativeRead?.asks || {}).filter(([, ask]) => ownsCurrentTask && ask.nodeId === nodeId && ask.status === 'open'
    && (ask.taskRevision || 1) === (currentTask?.taskRevision || 1));
  record.blockingAsks = asks.map(([id, ask]) => ({ id, nodeId, taskRevision: ask.taskRevision || 1,
    question: ask.question, status: 'open', ...(ask.filedAt ? { filedAt: ask.filedAt } : {}) }));
  const failure = job.lastFailure && (!job.lastFailure.taskRevision || job.lastFailure.taskRevision === currentTask?.taskRevision)
    ? { source: 'native-job', message: job.lastFailure.reason, code: job.lastFailure.code, at: job.lastFailure.at }
    : ownsCurrentTask && root?.error ? { source: 'native-worker', message: root.error.message, code: root.error.code } : null;
  if (failure?.message) record.failure = { ...failure, message: scrub(failure.message) };
  else delete record.failure;

  if (record.operation.kind === 'cancel' && job.state === 'closed') {
    let proof = record.operation.quiescence;
    const subtree = diagnosedStoppedSubtree(record, workers, nativeRead);
    // A lost receipt needs complete stopped native diagnostics for the owned
    // subtree. Paused/idle labels or stripped inventory alone prove no cleanup.
    if (!confirmation(record, proof) && ownsTask(record, job, currentTask) && subtree) {
      proof = { status: 'confirmed', source: 'native-inventory', nodeId, jobId: job.id,
        taskRevision: currentTask.taskRevision, total: subtree.length, quiescent: subtree.length };
    }
    if (confirmation(record, proof)) {
      record.status = 'cancelled';
      record.operation = { ...record.operation, status: record.operation.status === 'confirmed' ? 'confirmed' : 'reconciled', quiescence: proof };
      record.execution = { ...record.execution, quiescence: proof };
    } else {
      record.status = record.operation.status === 'pending' ? 'cancelling' : 'unknown';
      record.operation = { ...record.operation, status: record.operation.status === 'pending' ? 'pending' : 'unknown' };
      record.execution = { ...record.execution, quiescence: proof || { status: 'unknown' } };
    }
    delete record.recovery;
    return;
  }
  const terminal = rows.length > 0 && rows.every(row => ['done', 'held'].includes(row.status));
  if (!['cancelled', 'closed'].includes(record.status)) {
    if (ownsCurrentTask && currentTask.status === 'held' || terminal && decidingRows(rows, record).some(row => row.status === 'held')) record.status = 'held';
    else if (ownsCurrentTask && job.state !== 'paused' && currentTask.status !== 'verifying' && !terminal && root?.state === 'stopped') {
      record.status = 'recovery_required';
      record.reportedOutcome.status = 'recovery_required';
      record.execution.status = 'stopped';
      record.recovery = { status: 'required', outcome: 'unknown', automaticReplay: false,
        nodeId, taskRevision: currentTask?.taskRevision ?? null,
        cause: record.failure || { source: 'native-worker-state', code: 'FLEET_V5_EXECUTION_STOPPED',
          message: scrub(root.statusNote || 'Native worker stopped with unfinished contract work; the interrupted outcome is unconfirmed.') } };
    }
  }
  if (record.status !== 'recovery_required') delete record.recovery;
}

async function quiesceCancellation({ control, record, reason, expectedRevision }) {
  const nodeId = record.execution.nodeId;
  const inspect = async () => {
    const [job, read] = await Promise.all([
      control.request({ action: 'job-read', id: record.execution.jobId, view: 'full' }),
      control.request({ action: 'read', nodeId, view: 'full' })
    ]);
    const task = read.tasks?.[nodeId];
    if (!ownsTask(record, job, task)) throw refusal('FLEET_V5_CANCEL_OWNERSHIP_UNKNOWN',
      'The current native task no longer belongs to this contract; no execution stop was dispatched.');
    return { job, read, task };
  };
  const before = await inspect();
  if (before.read.revision !== expectedRevision) throw refusal('FLEET_CONTROL_STALE_REVISION', 'The native control revision changed before cancellation.');
  const closed = await control.request({ action: 'job-close', id: record.execution.jobId, reason, expectedRevision });
  // Re-read ownership as well as revision between the two native mutations.
  // The stop still uses native revision fencing; no stale stop is retried.
  const after = await inspect();
  const stopped = await control.request({ action: 'stop-subtree', nodeId, expectedRevision: after.read.revision });
  const result = stopped?.result;
  const root = result?.receipts?.find(row => row.nodeId === nodeId);
  if (result?.ok !== true || result.nodeId !== nodeId || result.action !== 'stop-subtree'
      || !Number.isSafeInteger(result.total) || result.total < 1 || result.quiescent !== result.total
      || result.failed !== 0 || result.fenced === true || root?.quiescent !== true) {
    throw refusal('FLEET_V5_CANCEL_QUIESCENCE_UNCONFIRMED', 'Native execution quiescence was not positively confirmed.',
      { status: 'unknown', source: 'native-stop-subtree' });
  }
  return { revision: stopped.revision, closed, stopped, quiescence: { status: 'confirmed', source: 'native-stop-subtree',
    nodeId, jobId: record.execution.jobId, taskRevision: after.task.taskRevision,
    total: result.total, quiescent: result.quiescent, controlRevision: stopped.revision } };
}
module.exports = { decidingRows, projectRecovery, quiesceCancellation };
