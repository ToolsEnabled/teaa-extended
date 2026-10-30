'use strict';

// One retained control record per tree. Root lifecycle authority is independent
// of the worker messaging graph. All edits are revision checked and serialized.
const clone = value => JSON.parse(JSON.stringify(value));
const results = require('./fleet-task-results');
const { isDeepStrictEqual } = require('node:util');
function refuse(code, message) { throw Object.assign(new Error(require('./fleet-recovery').message(code, message, { tool: 'fleet.control' })), { code }); }
function text(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim() || (maximum !== undefined && value.length > maximum))
    refuse('FLEET_CONTROL_TEXT_INVALID', `${label} must be nonempty text${maximum === undefined ? '' : ` of at most ${maximum} characters`}.`);
  return value;
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value))
    refuse('FLEET_CONTROL_ID_INVALID', 'Use a bounded tree record id.');
  return value;
}
function createFleetControl({ document, persist, history, rootSessionId, command, stopSubtree, settings, slotStatus, resources, observability, accounts, diagnosticRoot, requireTaskRevision = false, scopedRevisions = false, onAsk = () => {}, onLane = () => {}, wake = () => {}, assignmentContinuation = true, assignmentBackoffMs = 30000, attribution = () => null, inspect = () => document.nodes.map(({ nodeId, state, sessionId }) => ({ nodeId, state, sessionId })), now = () => new Date().toISOString() }) {  if (!document.fleetControl) document.fleetControl = { v: 1, revision: 0, tasks: {}, rules: {}, asks: {} };
  const valid = value => value && typeof value === 'object' && !Array.isArray(value);
  const state = () => {
    const value = document.fleetControl;
    if (value.v !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        !['tasks', 'rules', 'asks'].every(key => valid(value[key])))
      refuse('FLEET_CONTROL_STORE_INVALID', 'The retained control record is invalid; it was preserved.');
    return value;
  };
  state();
  const writeRevisions = require('./fleet-control-revisions');
  if (scopedRevisions) writeRevisions.validate(state().writeRevisions, state().revision);
  let queue = Promise.resolve();
  function serial(operation, project = value => value) {
    const result = queue.then(async () => {
      const value = project(await operation());
      return value === undefined ? undefined : clone(value);
    });
    queue = result.catch(() => {});
    return result;
  }
  // verify(next) may refuse the edit before anything is saved.
  function commit(edit, verify, historyUpdates) {
    const before = document.fleetControl;
    let next = require('./fleet-state-draft').produce(state(), draft => {
      edit(draft);
      if (verify) verify(draft);
      draft.revision += 1;
      draft.updatedAt = now();
    });
    if (scopedRevisions) next = writeRevisions.retain(before, next, document.nodes);
    document.fleetControl = next;
    try { persist(document, { historyUpdates }); } catch (error) { document.fleetControl = before; throw error; }
    return document.fleetControl;
  }
  function assignment(nodeId) {
    const value = state();
    const task = value.tasks[nodeId];
    if (!task || task.status === 'removed') return null;
    return { revision: value.revision, completed: task.status === 'completed' || task.status === 'held', taskRevision: task.taskRevision || 1, ...(task.keepConversation ? { keepConversation: true } : {}), ...(task.lane ? { lane: task.lane } : {}), text: render(value, nodeId, task),
      status: task.status, ...(task.verification ? { verification: clone(task.verification) } : {}),
      ...(task.submission ? { submission: clone(task.submission) } : {}), ...(task.assessment ? { assessment: clone(task.assessment) } : {}) };
  }
  function rulesFor(nodeId) {
    const value = state();
    return { revision: value.revision, text: [
      ...Object.entries(value.rules).filter(([, rule]) => rule.active).map(([id, rule]) => `${id}: ${rule.text}`),
      ...lanes.rulesBlock(value, nodeId),
      ...(Object.keys(value.policies || {}).length ? ['Orchestration policy rules:', JSON.stringify(value.policies)] : [])
    ].join('\n') };
  }
  function render(value, nodeId, task, { includeRules = true } = {}) {
    const rules = Object.entries(value.rules).filter(([, rule]) => rule.active).map(([id, rule]) => `${id}: ${rule.text}`);
    const laneRules = lanes.rulesBlock(value, nodeId);
    const asks = Object.entries(value.asks).filter(([, ask]) => ask.nodeId === nodeId && ask.status === 'answered' && (ask.taskRevision || 1) === (task.taskRevision || 1))
      .map(([id, ask]) => `${id}: ${ask.question}\nAnswer: ${ask.answer}`);
    // Measured live 2026-10-26: a worker passed the control revision as its
    // expectedTaskRevision and was refused. Name both numbers for what they are.
    const rendered = [`Durable task ${nodeId}:${task.taskRevision || 1}; taskRevision ${task.taskRevision || 1} (expectedTaskRevision defaults to your turn); control revision ${value.revision}`, task.text,
      ...(!task.lane && (!assignmentContinuation || task.autoContinue === false)
        ? ['Automatic continuation is disabled for this assignment. Wait inside this turn for expected outside events. waitSeconds records a deadline but cannot schedule another turn while continuation is disabled.'] : []),
      ...(task.requirements ? [results.render(task.requirements)] : []),
      ...(task.verification ? [task.verification.status === 'failed'
        ? `Fleet command verification failed (attempt ${task.verification.attempt}, failed verifications ${task.verification.failures}). Rework required: fix every failed check, run the lead commands yourself, then complete again.\n`
          + task.verification.checks.filter(check => check.status === 'failed').map(check => `${check.id}: exit ${check.exitCode}, timedOut=${check.timedOut}\n${check.outputTail}`).join('\n\n')
        : `Fleet command verification: ${task.verification.status} (attempt ${task.verification.attempt}).`] : []),
      ...(task.lane && value.lanes?.[task.lane]?.lastFailure?.taskRevision === task.taskRevision
        ? ['Retained failed/uncertain turn (inspect existing artifacts before repeating work):', JSON.stringify(value.lanes[task.lane].lastFailure)] : []),      ...(includeRules && laneRules.length ? [laneRules.join('\n')] : []),
      ...(includeRules && rules.length ? ['Standing rules:', ...rules] : []), ...(asks.length ? ['Answered asks:', ...asks] : [])].join('\n\n');
    return rendered;
  }
  const lanes = require('./fleet-v2-lanes').createLanes({ historyPage: input => history?.historyPage(document, input), state: () => state(), commit, nodes: () => document.nodes, now, stamp: (by, fields) => stamp(by, fields),
    measure: (value, nodeId, text) => render(value, nodeId, { ...(value.tasks[nodeId] || { taskRevision: 1 }), text, status: 'assigned' }) });
  // Delivery cannot undo a task transition, but a lost notice must be visible.
  // Keep the latest failure in the authoritative record, including when the
  // notice itself could not be serialized. Queue retention behind this edit.
  function noticeFailed(event, stage, cause) {
    const failure = { code: 'FLEET_NOTICE_FAILED', stage, nodeId: event.nodeId,
      ...(event.laneId ? { laneId: event.laneId } : {}), status: event.status,
      message: String(cause?.message || cause).slice(0, 500), at: now() };
    serial(() => commit(value => { value.lastNoticeError = failure; })).catch(error => {
      process.emitWarning(`Fleet could not retain a notice failure: ${String(error.message || error).slice(0, 500)}`,
        { code: 'FLEET_NOTICE_RECORD_FAILED' });
    });
  }
  function announce(events, { verification = false } = {}) {
    for (const event of events || []) {
      let notice;
      try {
        // A draft proxy cannot enter another immutable state edit (the host
        // inbox). Materialize verification from committed state, never a draft.
        notice = clone({ ...event, ...(verification ? { verification: state().tasks[event.nodeId].verification } : {}) });
      } catch (error) { noticeFailed(event, 'build', error); continue; }
      try { Promise.resolve(onLane(notice)).catch(error => noticeFailed(event, 'delivery', error)); }
      catch (error) { noticeFailed(event, 'delivery', error); }
    }
  }
  function nudge(nodeId) {
    if (nodeId) { try { Promise.resolve(wake(nodeId)).catch(() => {}); } catch { /* the next turn boundary or watch tick picks it up */ } }
  }
  function assertRoot(sessionId) {
    if (sessionId !== rootSessionId) refuse('FLEET_CONTROL_ROOT_REQUIRED', 'Only this tree orchestrator may edit assignments, rules, answers and settings or control lifecycle.');
  }
  // Who made an edit when several orchestrators share one tree (a Fleet hub).
  // Without a hub the getter answers null and no field is written.
  const stamp = (by, fields) => (typeof by === 'string' && by ? fields : {});
  // ASSIGNMENT CONTINUATION. Measured 2026-10-26 on the owner's hubs: every V3
  // and V4-builder worker session ran exactly one turn, because only lanes and
  // agent.continue ever sent a next turn. A plain assignment stopped at each
  // turn end until a lead noticed and resumed it, for hours when the lead
  // client was not running. So an open plain assignment now gets its next turn
  // at the idle turn boundary, the way a lane task does, unless the lead set
  // autoContinue false. A known idle boundary can recover after hub restart;
  // manager-stopped or paused workers stay stopped. Continuation never
  // answers or bypasses an open ask, and stops after a failed turn or after
  // AUTO_UNCHANGED_LIMIT automatic turns that record no new progress; the task
  // stays assigned and the lead is told. A lead-started turn resets the count.
  const AUTO_UNCHANGED_LIMIT = 3;
  // WAITING IS NOT A LOOP. Measured 2026-10-26 (bench long-haiku/on): a worker
  // that armed its own file watcher and ended its turn got three automatic
  // turns within ten seconds, each recording a fresh timestamped note (so the
  // unchanged guard never fired), then asked the lead to stop the loop. Short
  // automatic turns that end unfinished now space the next one out (30 s,
  // doubling to 15 min); a turn of 2 minutes or more is real work and resets
  // the spacing, as does a lead-started turn. A worker can also say how long
  // it is waiting: progress with waitSeconds replaces exponential spacing and
  // resets the short-turn streak. Tiny waits use the initial spacing (at most
  // 30 seconds) as a floor from progress time, so they cannot create a hot
  // polling loop. assignmentBackoffMs=0 disables pacing for fixture callers.
  const AUTO_SHORT_TURN_MS = 120000;
  const AUTO_BACKOFF_MAX_MS = 15 * 60000;
  const AUTO_WAIT_MAX_SECONDS = 30 * 24 * 60 * 60;
  const autoWaitFloorMs = Math.min(Math.max(0, assignmentBackoffMs), 30000);
  const autoDelayMs = auto => (auto?.shortStreak > 0 && assignmentBackoffMs > 0)
    ? Math.min(assignmentBackoffMs * 2 ** (auto.shortStreak - 1), AUTO_BACKOFF_MAX_MS) : 0;
  const autoMark = task => require('node:crypto').createHash('sha256')
    .update(JSON.stringify({ progress: task?.progress || null, status: task?.status || null })).digest('hex');
  function plainTask(value, nodeId) {
    const task = value.tasks[nodeId];
    return task && !task.lane && !lanes.laneAt(value, nodeId) ? task : null;
  }
  function openAskFor(value, nodeId, task) {
    return Object.values(value.asks).some(ask => ask.nodeId === nodeId && ask.status === 'open' && (ask.taskRevision || 1) === (task.taskRevision || 1));
  }
  function autoNotice(nodeId, status, reason) { return { laneId: null, nodeId, n: null, status, reason }; }
  // The control revision of the assignment a worker last read in full. With
  // node.assignmentRevision (the revision its current turn was sent with) it
  // tells whether a live correction has reached the worker.
  const seenAssignment = new Map();
  function assignmentTurn({ nodeId, phase, status, ...details }) {
    const value = state();
    const task = plainTask(value, nodeId);
    if (!task) return null;
    if (task.status !== 'assigned') {
      // The worker finished during an automatic turn: that attempt is over.
      if (phase !== 'next' && task.auto?.pending) commit(edit => { edit.tasks[nodeId].auto = { ...edit.tasks[nodeId].auto, pending: false }; });
      return null;
    }
    if (details.taskRevision !== undefined && details.taskRevision !== (task.taskRevision || 1)) return null;
    if (phase === 'unsent') {
      // The automatic turn was prepared but never sent (rules became unreadable).
      if (task.auto?.pending) commit(edit => {
        const current = edit.tasks[nodeId], auto = current.auto;
        if (auto.followup) current.followupPending = true;
        current.auto = { ...auto, pending: false, turns: Math.max(0, (auto.turns || 0) - (auto.followup ? 0 : 1)) };
      });
      return null;
    }
    if (phase === 'ended' || phase === 'failed') {
      if (phase === 'ended' && status === 'interrupted') {
        if (task.auto?.pending) commit(edit => { edit.tasks[nodeId].auto = { ...edit.tasks[nodeId].auto, pending: false }; });
        return null;
      }
      if (phase === 'failed' || status !== 'completed') {
        const message = details.reason;
        const safetyRefusal = details.providerReason === 'safety-refusal' && details.code === 'MODEL_API_SAFETY_REFUSAL';
        const stoppedReason = safetyRefusal ? 'provider-safety-refusal' : 'turn-failed';
        const reason = safetyRefusal
          ? `Automatic continuation stopped because the model API explicitly refused this request for safety reasons. No provider fallback or retry was selected. The task stays assigned; inspect the retained work and resume only through an explicit owner-directed action.`
          : `Automatic continuation stopped: the provider turn ended with status ${phase === 'failed' ? (status || 'submission-uncertain') : status}${details.code ? ` (${details.code})` : ''}. Cause: ${message} The task stays assigned; inspect the retained work, then resume the worker.`;
        commit(edit => { edit.tasks[nodeId].auto = { ...(edit.tasks[nodeId].auto || { turns: 0 }), pending: false, unchanged: 0, mark: autoMark(edit.tasks[nodeId]), stopped: { reason: stoppedReason, status: status || 'submission-uncertain', message, ...(details.code ? { code: details.code } : {}), at: now() } }; });
        announce([autoNotice(nodeId, 'paused', reason)]);
        return null;
      }
      const events = [];
      commit(edit => {
        const current = edit.tasks[nodeId];
        const auto = { turns: 0, unchanged: 0, ...(current.auto || {}) };
        const mark = autoMark(current);
        const changed = mark !== auto.mark;
        // The host says which turn ended: one it sent automatically, a turn
        // the lead started (spawn, resume, answer), or a delivered message.
        // Older hosts without the field fall back to the pending hint.
        const source = details.source || (auto.pending ? 'automatic' : 'directed');
        if (source === 'automatic') {
          auto.unchanged = changed ? 0 : (auto.unchanged || 0) + 1;
          const ranMs = auto.sentAt ? Date.parse(now()) - Date.parse(auto.sentAt) : Infinity;
          auto.shortStreak = !current.waitUntil && ranMs < AUTO_SHORT_TURN_MS ? (auto.shortStreak || 0) + 1 : 0;
        } else if (source === 'directed' || changed) { auto.unchanged = 0; auto.stopped = null; if (source === 'directed') auto.shortStreak = 0; }
        if (source === 'directed') delete current.followupPending;
        auto.mark = mark; auto.pending = false; auto.endedAt = now(); delete auto.followup;
        if (!auto.stopped && auto.unchanged >= AUTO_UNCHANGED_LIMIT) {
          auto.stopped = { reason: 'no-progress', at: now() };
          events.push(autoNotice(nodeId, 'waiting', `Automatic continuation stopped after ${auto.unchanged} automatic turns without new recorded progress. The task stays assigned; give direction (task edit or answer) or resume the worker`));
        }
        current.auto = auto;
      });
      announce(events);
      return null;
    }
    // phase "next": an idle, sendable worker with no lane.
    // A lead's explicit follow-up is a directed turn, even when automatic
    // continuation is off. The host still admits it only for a running idle worker.
    const followup = task.followupPending === true;
    if ((!assignmentContinuation || task.autoContinue === false || task.auto?.stopped) && !followup || openAskFor(value, nodeId, task)) return null;
    // Not yet: the worker said it is waiting, or recent short turns asked for room.
    // The host's watch tick asks again; nothing is recorded meanwhile.
    const nowMs = Date.parse(now());
    if (phase === 'recoverable') return !task.auto?.pending ? { ready: true } : null;
    if (task.waitUntil && nowMs < Date.parse(task.waitUntil)) return null;
    // A retained explicit wait also wins over a pre-fix streak after restart.
    if (!task.waitUntil && task.auto?.endedAt && nowMs - Date.parse(task.auto.endedAt) < autoDelayMs(task.auto)) return null;
    if (phase === 'recover') {
      const node = document.nodes.find(node => node.nodeId === nodeId);
      return node?.assignmentRecovery?.taskRevision === (task.taskRevision || 1)
        && !task.auto?.pending ? { ready: true } : null;
    }
    const correction = task.amendedRevision > (document.nodes.find(node => node.nodeId === nodeId)?.assignmentRevision || 0);
    const next = commit(edit => {
      const current = edit.tasks[nodeId];
      const auto = { turns: 0, unchanged: 0, ...(current.auto || {}) };
      if (auto.mark === undefined) auto.mark = autoMark(current);
      if (followup) auto.followup = true; else { auto.turns += 1; delete auto.followup; }
      if (current.waitUntil) auto.shortStreak = 0;
      auto.pending = true; auto.sentAt = now();
      delete current.followupPending;
      current.auto = auto;
      delete current.waitUntil;
    });
    const current = next.tasks[nodeId];
    const brief = render(next, nodeId, current, { includeRules: false });
    const lead = `Fleet sent this automatically: your assignment is not finished (automatic turn ${current.auto.turns}). Continue it from your saved work. `
      + 'Record concrete progress with fleet.control action progress, finish with complete, or use hold with the reason if it cannot be finished. '
      + 'For an expected file, job, timer or other outside event, wait inside this turn (including waiting for any shell job or monitor), or call progress with a numeric waitSeconds from 1 to 2592000 (30 days), then end the turn. For example: {action: "progress", expectedTaskRevision: 1, text: "Waiting for the export", waitSeconds: 900}; use your actual taskRevision. Fleet sends the next eligible automatic turn at that deadline, with a 30-second minimum wait and no short-turn backoff. A watcher alone does not postpone continuation. If a wait call is refused, correct its numeric input or wait inside this turn; a scheduling refusal is not a reason to hold the task. '
      + 'Do not end a waiting turn without waitSeconds or spend automatic turns checking once each. The automatic-turn count is not a deadline for an outside event. Use an Ask only when a lead decision or intervention is needed; an expected event still within its promised time needs waiting. Measure elapsed time from this assignment or your recorded checks, not a copied file or directory modification time. '
      + `Fleet stops sending these turns after ${AUTO_UNCHANGED_LIMIT} automatic turns without new recorded progress and tells the lead.`;
    const context = `Fleet sent ${followup ? 'a lead follow-up' : correction ? 'a lead correction' : 'an automatic turn'} at ${current.auto.sentAt}`
      + `${task.waitUntil ? `; waitUntil ${task.waitUntil} has passed` : ''}.`;
    return { laneId: null, n: null, fresh: false, attempt: current.auto.turns, ...(followup ? { source: 'directed' } : {}),
      text: `${context}\n\n${followup ? 'The lead assigned this follow-up. Continue in this conversation from your retained work.' : lead}\n\n${brief}`, taskRevision: current.taskRevision || 1, revision: next.revision, brief };
  }
  function replaceTask(nodeId, taskText, newTask, by, taskRequirements, options = {}) {
    text(taskText, 'Task');
    if (options.autoContinue !== undefined && typeof options.autoContinue !== 'boolean') refuse('FLEET_CONTROL_INPUT_INVALID', 'autoContinue must be true or false.');
    if (options.keepConversation !== undefined && typeof options.keepConversation !== 'boolean') refuse('FLEET_CONTROL_INPUT_INVALID', 'keepConversation must be true or false on action task.');
    const conversation = options.keepConversation === true ? { keepConversation: true } : {};
    const optOut = options.autoContinue === false ? { autoContinue: false } : {};
    const required = results.requirements(taskRequirements);
    const node = document.nodes.find(node => node.nodeId === nodeId);
    if (!node) refuse('FLEET_CONTROL_NODE_UNKNOWN', 'This task needs an existing tree worker.');
    const lane = lanes.laneAt(state(), nodeId);
    const live = node.state === 'running' || node.state === 'starting';
    // A correction to the current open assignment no longer interrupts the
    // worker: its next turn (automatic or lead-started) renders the new text.
    // Reopening terminal plain work with keepConversation is an explicit
    // follow-up; other replacements and opted-out assignments need a pause.
    const priorTask = state().tasks[nodeId];
    if (priorTask?.status === 'verifying' && options.keepConversation === true && !newTask)
      refuse('FLEET_TASK_VERIFYING', 'Fleet is verifying the retained completion; wait for its checks before assigning a conversation follow-up.');
    const reopen = !lane && options.keepConversation === true && ['completed', 'held'].includes(priorTask?.status);
    const amendable = !lane && !newTask && priorTask && priorTask.status === 'assigned' && priorTask.autoContinue !== false && assignmentContinuation;
    if (live && !amendable && !reopen) refuse('FLEET_TASK_PAUSE_REQUIRED', 'Pause this worker before editing its assignment.');
    if (lane) refuse('FLEET_LANE_ACTIVE', `This worker runs lane ${lane[0]}; append tasks with lane-add, or close the lane with lane-close before replacing its task.`);
    if (live && !reopen) {
      const next = commit(value => {
        const previous = value.tasks[nodeId];
        value.taskHistory ||= []; value.taskHistory.push({ nodeId, ...previous, retiredAt: now() });
        const keptRequirements = required === undefined ? previous.requirements : required;
        const { auto, ...rest } = previous;
        value.tasks[nodeId] = { ...rest, text: taskText, editedAt: now(), amendedWhileRunning: true, amendedRevision: value.revision + 1, ...stamp(by, { editedBy: by }), ...conversation, ...optOut,
          ...(keptRequirements ? { requirements: keptRequirements } : {}), ...(auto?.pending ? { auto: { turns: auto.turns || 0, unchanged: 0, mark: auto.mark, pending: true } } : {}) };
        if (required === undefined && !keptRequirements) delete value.tasks[nodeId].requirements;
      });
      nudge(nodeId);
      return next;
    }
    const next = commit(value => {
      const previous = value.tasks[nodeId];
      const taskRevision = previous ? (previous.taskRevision || 1) + (newTask || ['completed', 'held', 'removed'].includes(previous.status) ? 1 : 0) : 1;
      if (previous) { value.taskHistory ||= []; value.taskHistory.push({ nodeId, ...previous, retiredAt: now() }); }
      if (taskRevision !== (previous?.taskRevision || 1)) for (const ask of Object.values(value.asks))
        if (ask.nodeId === nodeId && ask.status === 'open') { ask.status = 'superseded'; ask.supersededAt = now(); }
      const keptRequirements = required === undefined && taskRevision === previous?.taskRevision ? previous.requirements : required;
      // A correction of the same assignment keeps an earlier opt-out unless
      // the lead turns automatic turns back on explicitly.
      const keptOptOut = options.autoContinue === undefined && taskRevision === previous?.taskRevision && previous?.autoContinue === false ? { autoContinue: false } : optOut;
      value.tasks[nodeId] = { text: taskText, taskRevision, status: 'assigned', editedAt: now(), ...stamp(by, { editedBy: by }), ...conversation, ...(live && reopen ? { followupPending: true } : {}), ...keptOptOut, ...(keptRequirements ? { requirements: keptRequirements } : {}) };
    });
    if (live && reopen) nudge(nodeId);
    return next;
  }
  function resumeError(cause, nodeId) {
    if (require('./error-taxonomy').adaptToolError(cause).code !== 'INTERNAL_ERROR') return cause;
    const diagnostics = require('./fleet-diagnostics');
    const diagnostic = diagnostics.recordInternalError(cause, { root: diagnosticRoot, tool: 'fleet.control', action: 'resume', nodeId });
    const error = Object.assign(new Error('Resume could not be confirmed. Read fleet.control state and the retained diagnostic before retrying.', { cause }), { code: 'FLEET_RESUME_FAILED' });
    diagnostics.linkDiagnostic(error, diagnostic);
    return error;
  }  function checkTaskRevision(input, task, required = false) {
    if (input.expectedTaskRevision === undefined && !required) return;
    if (!task || !Number.isSafeInteger(input.expectedTaskRevision) || input.expectedTaskRevision !== (task.taskRevision || 1))
      refuse('FLEET_TASK_STALE_REVISION', 'This report does not match the assigned taskRevision.');
  }
  function checkWriteRevision(input, action) {
    const revision = input.expectedRevision, current = state();
    const targetScoped = scopedRevisions && (input.revisionScope === 'target'
      || input.revisionScope === undefined && ['task', 'pause', 'stop', 'resume', 'answer', 'assess'].includes(action));
    if (!Number.isSafeInteger(revision) || revision < 0 || revision > current.revision
        || revision !== current.revision && !(targetScoped && writeRevisions.unchanged(current, document.nodes, input, action)))
      refuse('FLEET_CONTROL_STALE_REVISION', targetScoped
        ? 'This target or its shared context changed; read its current state before editing.'
        : 'Read the latest control revision before changing it.');
  }  // Port the existing alpha5 answer+resume operation with a retained attempt.
  // A replay never starts another process, including after a later lead pause
  // or a crash between dispatch and its receipt. Explicit action resume is the
  // recovery route after the lead inspects an unconfirmed or failed attempt.
  async function resumeAnswered(id, by) {
    const ask = state().asks[id];
    const skip = (code, reason, extra = {}) => ({ resumed: false, nodeId: ask.nodeId, code, reason: require('./fleet-recovery').message(code, reason, { tool: 'fleet.control' }), ...extra });
    if (ask.status !== 'answered') return skip('FLEET_ASK_NOT_ANSWERED', `The ask is ${ask.status}; its answer no longer reaches the worker.`);
    const task = state().tasks[ask.nodeId];
    if (!task || (ask.taskRevision || 1) !== (task.taskRevision || 1)) return skip('FLEET_ASK_SUPERSEDED', 'This answer belongs to an earlier task.');
    if (task.status === 'verifying') return skip('FLEET_TASK_VERIFYING', 'Fleet is verifying the retained completion; the answer is saved without starting another turn.');
    if (ask.resumeAttempt) return skip('FLEET_ANSWER_RESUME_RECORDED', 'This answer already has a resume attempt. Inspect the worker; use action resume explicitly if more work is needed.',
      { replay: true, attempt: clone(ask.resumeAttempt), nextAction: { action: 'read', nodeId: ask.nodeId } });
    if (['completed', 'held', 'removed'].includes(task.status)) return skip('FLEET_TASK_COMPLETED', `The task is ${task.status}; assign its next task explicitly.`);
    const node = document.nodes.find(node => node.nodeId === ask.nodeId);
    if (!node) return skip('FLEET_CONTROL_NODE_UNKNOWN', 'The worker that asked is no longer in this tree.');
    if (['running', 'starting'].includes(node.state)) return skip('FLEET_WORKER_ACTIVE', 'The worker is already running; it can read the retained answer.');
    commit(value => { value.asks[id].resumeAttempt = { state: 'pending', taskRevision: task.taskRevision || 1, at: now() }; });
    let result;
    try {
      result = await command({ action: 'resume-node', nodeId: ask.nodeId, parentSessionId: rootSessionId });
      if (!result || result.ok === false || result.resumed === false || (result.ok !== true && result.resumed !== true))
        refuse(result?.code || 'FLEET_RESUME_UNCONFIRMED', result?.reason || 'The host did not confirm that the worker resumed. Inspect its state before another lifecycle action.');
    } catch (cause) {
      const error = resumeError(cause, ask.nodeId);
      const code = error.code || 'FLEET_RESUME_FAILED', reason = require('./fleet-recovery').message(code, error.message || error, { tool: 'fleet.control' });
      const diagnostic = require('./fleet-diagnostics').diagnosticFor(error);
      commit(value => { value.asks[id].resumeAttempt = { ...value.asks[id].resumeAttempt, state: 'failed', code, reason, ...(diagnostic ? { diagnostic } : {}), finishedAt: now() }; });
      return skip(code, reason, { ...(diagnostic ? { diagnostic } : {}), nextAction: { action: 'read', nodeId: ask.nodeId } });
    }
    commit(value => {
      value.asks[id].resumeAttempt = { ...value.asks[id].resumeAttempt, state: 'succeeded', finishedAt: now() };
      value.lifecycle = { nodeId: ask.nodeId, action: 'resume', at: now(), ...stamp(by, { by }) };
    });
    return { resumed: true, nodeId: ask.nodeId, result };
  }
  // Work can be saved successfully while its worker/job is deliberately at
  // rest. Describe the next existing control action without dispatching it.
  function workWait(input, result) {
    const action = input.action.replace(/^job(?=-|$)/, 'lane');
    const jobEdit = ['lane', 'lane-add', 'lane-rule', 'lane-resume', 'lane-schedule'].includes(action);
    const askEdit = ['answer', 'archive-ask'].includes(action);
    if (action !== 'task' && action !== 'pause' && !jobEdit && !askEdit && !(action === 'resume' && input.text !== undefined)) return {};
    const value = state(), ask = askEdit ? value.asks[input.id] : null;
    const lane = jobEdit ? value.lanes?.[input.id] : null;
    const nodeId = input.nodeId || ask?.nodeId || lane?.nodeId;
    const node = document.nodes.find(node => node.nodeId === nodeId), task = value.tasks[nodeId];
    if (action === 'pause' && task?.status !== 'assigned') return {};
    const wait = (waitsFor, nextAction) => ({ waitsFor,
      nextAction: nextAction.action === 'read' ? nextAction : { ...nextAction, expectedRevision: value.revision } });
    if (lane?.state === 'paused') return wait('job-resume', { action: 'job-resume', id: input.id });
    if (task?.status === 'verifying') return wait('verification', { action: 'read', nodeId });
    if (askEdit && ['completed', 'held'].includes(task?.status))
      return wait('task', { action: 'task', nodeId, keepConversation: true });
    if (result?.resume?.nextAction?.action === 'read' || ask?.resumeAttempt?.state === 'failed' || ask?.resumeAttempt?.state === 'pending')
      return wait('inspection', { action: 'read', nodeId });
    const open = Object.entries(value.asks).find(([, question]) => question.nodeId === nodeId && question.status === 'open'
      && (question.taskRevision || 1) === (task?.taskRevision || 1));
    if (open) return wait('answer', { action: 'answer', id: open[0] });
    if (node && !['running', 'starting'].includes(node.state)) return wait('resume', { action: 'resume', nodeId });
    if (!jobEdit && node?.turn === 'idle' && !task?.followupPending && (!assignmentContinuation || task?.autoContinue === false))
      return wait('resume', { action: 'pause', nodeId });
    return {};
  }
  function request(input = {}, sessionId) {
    const by = attribution();
    // Capture the revision sent to this turn before queuing the write. Reading
    // the current assignment here could relabel a late report as successor work.
    if (sessionId !== rootSessionId && ['ask', 'progress', 'complete', 'hold'].includes(input.action) && input.expectedTaskRevision === undefined) {
      const node = document.nodes.find(node => node.sessionId === sessionId);
      input = { ...input, expectedTaskRevision: node?.taskRevision };
    }
    return serial(async () => {
      const action = ({ job: 'lane', 'job-add': 'lane-add', 'job-rule': 'lane-rule', 'job-resume': 'lane-resume', 'job-close': 'lane-close', 'job-read': 'lane-read', 'job-schedule': 'lane-schedule' })[input.action] || input.action;
      if (input.revisionScope !== undefined) {
        assertRoot(sessionId);
        if (!['global', 'target'].includes(input.revisionScope) || input.revisionScope === 'target' && (!scopedRevisions || !writeRevisions.supported(action)))
          refuse('FLEET_CONTROL_REVISION_SCOPE_INVALID', 'Target-scoped revisions apply to V3 worker, Ask and job edits; use global revisions for shared edits and subtree actions.');
      }      for (const [field, actions] of Object.entries({ requirements: ['task', 'resume'], result: ['complete', 'hold'], assessment: ['assess'], workItems: ['lane', 'lane-add', 'lane-schedule'], schedule: ['lane-schedule'], waitSeconds: ['progress'], keepConversation: ['task'], contractId: ['usage-read'] }))
        if (input[field] !== undefined && !actions.includes(action)) refuse('FLEET_RESULT_INPUT_INVALID', `${field} does not apply to action ${action}.`);
      if (input.requirements !== undefined && action === 'resume' && input.text === undefined) refuse('FLEET_RESULT_INPUT_INVALID', 'Resume requirements accompany a new task text.');
      if (Object.hasOwn(input, 'resume') && (typeof input.resume !== 'boolean' || action !== 'answer'))
        refuse('FLEET_CONTROL_RESUME_INVALID', 'resume is a boolean option on action answer; otherwise use action resume.');
      if (action === 'history-read') {
        assertRoot(sessionId);
        if (!history) refuse('FLEET_HISTORY_UNAVAILABLE', 'Durable history requires SQLite tree storage.');
        return history.historyPage(document, input);
      }
      if (action === 'usage-read') {
        assertRoot(sessionId);
        if (Object.hasOwn(input, 'contractId') && (typeof input.contractId !== 'string'
            || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.contractId)))
          refuse('FLEET_USAGE_CONTRACT_ID_INVALID', 'contractId must be a bounded retained contract identifier.');
        return observability?.summary(input) || { enabled: false, wholeRun: { tokens: null, cost: null, complete: false } };
      }
      if (action === 'metrics-read') { assertRoot(sessionId); return observability?.history(input) || { enabled: false, entries: [], total: 0 }; }
      if (action === 'permission-profiles-read') { assertRoot(sessionId); return { revision: state().revision, profiles: permissionProfiles(), scope: 'workers-only', directUserProvenance: false }; }
      if (action === 'resources-read') {
        assertRoot(sessionId);
        return { revision: state().revision, policy: require('./fleet-v2-resources').validatePolicy(state().resources || { mode: 'off' }), runtime: resources?.snapshot() || null };
      }
      if (action === 'account-read') {
        assertRoot(sessionId);
        if (input.expectedRevision !== undefined && input.expectedRevision !== state().revision) refuse('FLEET_CONTROL_STALE_REVISION', 'Read the latest control revision before continuing account pages.');
        if (input.account && !accounts) refuse('FLEET_ACCOUNT_SERVICE_UNAVAILABLE', 'Configure the account service before requesting a current catalog.');
        const catalog = input.provider === 'codex' && input.account ? await accounts.catalog({ provider: input.provider, account: input.account }) : null;
        const inheritedAccount = node => {
          const binding = node.inheritedBinding;
          if (!binding || node.accountRoute || binding.authentication !== 'inherited-environment') return null;
          if (typeof binding.provider !== 'string' || typeof binding.configDir !== 'string' || !require('node:path').isAbsolute(binding.configDir)) return null;
          return { provider: binding.provider, configDir: binding.configDir, authentication: 'inherited-environment' };
        };
        const { selected: boundWorkers, page } = require('./fleet-v2-control-surface').pageEntries(document.nodes.filter(node => (node.accountRoute || inheritedAccount(node)) && (!input.nodeId || node.nodeId === input.nodeId)), input);
        return { page, ...(catalog ? { catalog } : {}), revision: state().revision, scope: 'future-provider-launches', defaults: clone(state().accountDefaults || {}),
          boundWorkers: boundWorkers.map(node => node.accountRoute ? ({ nodeId: node.nodeId, ...clone(node.accountRoute), ...(node.accountWithheldEnv ? { withheldEnv: clone(node.accountWithheldEnv) } : {}), state: node.state, threadId: node.threadId || null, ...(node.accountUsage ? { usage: clone(node.accountUsage) } : {}), ...(node.accountAdmission ? { admission: clone(node.accountAdmission) } : {}), ...(node.accountWorkEvidence ? { completion: clone(node.accountWorkEvidence) } : {}) })
            : ({ nodeId: node.nodeId, ...inheritedAccount(node), state: node.state, threadId: node.threadId || null })) };
      }
      if (action === 'settings-read') {
        assertRoot(sessionId);
        const { inventory, LEGACY_RULE_SETTINGS } = require('./fleet-v2-settings');
        const catalogue = inventory.entries.filter(row => !LEGACY_RULE_SETTINGS.has(row.id)).map(({ id, disposition, reason, original }) => ({ id, disposition, reason, control: original.control, default: original.default, ...(original.options ? { options: original.options } : {}) }));
        const oldIds = new Set(inventory.entries.map(row => row.id));
        for (const row of require('./settings-registry').loadRegistry().entries) if (!oldIds.has(row.id) && !LEGACY_RULE_SETTINGS.has(row.id))
          catalogue.push({ id: row.id, disposition: 'runtime-setting', reason: row.enforcedBy, control: row.control, default: row.default, ...(row.options ? { options: row.options } : {}) });
        return { revision: state().revision, policies: clone(state().policies || {}), accountRoutes: { control: 'account-select', read: 'account-read', providers: ['claude', 'codex', 'grok', 'gemini'], scope: 'future-launches', defaults: clone(state().accountDefaults || {}) }, catalogue, ...(slotStatus ? { slotLimits: slotStatus() } : {}) };
      }
      if (action === 'read') {
        const value = state();
        const { compactTask, compactRecord, fullRecord, compactWorker, compactView } = require('./fleet-v2-control-surface');
        const compact = compactView(input, sessionId === rootSessionId);
        if (input.expectedRevision !== undefined && input.expectedRevision !== value.revision)
          refuse('FLEET_CONTROL_STALE_REVISION', 'The control record changed while reading; restart the paged read on the current revision.');
        if (sessionId === rootSessionId) {
          const result = compact ? compactRecord(value, input) : fullRecord(value, input, document.nodes);
          const scoped = input.nodeId || input.status || input.offset !== undefined || input.limit !== undefined;
          return { ...result, ...(history ? { historyCounts: { tasks: (value.taskHistory?.length || 0) + history.historyCount('tasks'), rules: (value.ruleHistory?.length || 0) + history.historyCount('rules') }, history: { action: 'history-read', kinds: ['tasks', 'rules', 'items', 'reports', 'metrics', 'skips', 'failures', 'inbox'] } } : {}), workers: inspect().filter(worker => !scoped || Object.hasOwn(result.tasks, worker.nodeId)).map(worker => compact ? compactWorker(worker) : worker),
            pendingAsks: Object.entries(result.asks).filter(([, ask]) => ask.status === 'open').map(([id, ask]) => ({ id, ...ask })) };
        }
        const node = document.nodes.find(node => node.sessionId === sessionId && node.state === 'running');
        if (!node) refuse('FLEET_CONTROL_SESSION_INVALID', 'The worker session is no longer active.');
        const task = value.tasks[node.nodeId];
        if (!compact && task) seenAssignment.set(node.nodeId, value.revision);
        return { revision: value.revision, assignment: compact
          ? task ? { ...compactTask(task), revision: value.revision, completed: ['completed', 'held'].includes(task.status), taskRevision: task.taskRevision || 1 } : null
          : assignment(node.nodeId), asks: Object.fromEntries(Object.entries(compact ? compactRecord(value, { nodeId: node.nodeId }).asks : value.asks).filter(([, ask]) => ask.nodeId === node.nodeId)) };
      }
      if (action === 'lane-read') {
        assertRoot(sessionId);
        if (input.expectedRevision !== undefined && input.expectedRevision !== state().revision)
          refuse('FLEET_CONTROL_STALE_REVISION', 'The control record changed while reading; restart the paged read on the current revision.');
        return lanes.read(input, inspect());
      }
      if (action === 'progress' || action === 'complete' || action === 'hold') {
        const node = sessionId === rootSessionId
          ? document.nodes.find(node => node.nodeId === input.nodeId)
          : document.nodes.find(node => node.sessionId === sessionId && node.state === 'running');
        if (!node || !state().tasks[node.nodeId]) refuse('FLEET_CONTROL_SESSION_INVALID', 'Progress belongs to a retained assigned worker.');
        const currentTask = state().tasks[node.nodeId];
        checkTaskRevision(input, currentTask, input.result !== undefined || sessionId !== rootSessionId && requireTaskRevision);
        text(input.text, { complete: 'Completion', hold: 'Hold reason', progress: 'Progress' }[action]);
        if (input.waitSeconds !== undefined && (!Number.isInteger(input.waitSeconds) || input.waitSeconds < 1 || input.waitSeconds > AUTO_WAIT_MAX_SECONDS))
          refuse('FLEET_CONTROL_INPUT_INVALID', `waitSeconds must be a whole number from 1 to ${AUTO_WAIT_MAX_SECONDS}.`);
        if (sessionId === rootSessionId) checkWriteRevision(input, action);        const result = action === 'progress' ? null : results.result(input.result);
        if (sessionId !== rootSessionId && action !== 'progress' && currentTask.status === 'assigned' && currentTask.amendedRevision
            && Math.max(node.assignmentRevision || 0, seenAssignment.get(node.nodeId) || 0) < currentTask.amendedRevision)
          refuse('FLEET_TASK_AMENDED', 'The lead corrected this assignment after your current turn began. Read it with fleet.control action read (view full), finish the corrected task, then report.');
        if (currentTask.status === 'verifying') {
          if (action === 'complete' && currentTask.submission.text === input.text && isDeepStrictEqual(currentTask.submission.result, result))
            return { revision: state().revision, task: currentTask, replay: true };
          refuse('FLEET_TASK_VERIFYING', 'Fleet is verifying the retained completion; wait for its checks before reporting again.');
        }
        if (['completed', 'held', 'removed'].includes(currentTask.status)) {
          if (currentTask.submission && (action === 'complete' && currentTask.status === 'completed' || action === 'hold' && currentTask.status === 'held')
              && currentTask.submission.text === input.text && isDeepStrictEqual(currentTask.submission.result, result))
            return { revision: state().revision, task: currentTask, replay: true };
          refuse('FLEET_TASK_REPORTED', 'This task already has a terminal outcome. Its report is retained; the lead assigns further work explicitly.');
        }
        const verify = action === 'complete' && currentTask.requirements?.checks?.some(check => check.command);
        let event = null;
        const next = commit(value => {
          const task = value.tasks[node.nodeId]; task.progress = input.text; task.progressAt = now(); if (action === 'complete') task.status = 'completed';
          // Only the latest progress owns the wait. A later report without
          // waitSeconds withdraws it and uses ordinary short-turn pacing.
          if (input.waitSeconds !== undefined) task.waitUntil = new Date(Date.parse(task.progressAt) + Math.max(input.waitSeconds * 1000, autoWaitFloorMs)).toISOString();
          else delete task.waitUntil;
          if (action !== 'progress') task.submission = { text: input.text, result, source: sessionId === rootSessionId ? 'lead' : 'worker', at: task.progressAt, taskRevision: task.taskRevision || 1 };
          if (verify) {
            task.status = 'verifying';
            task.verification = { id: require('node:crypto').randomUUID(), status: 'verifying', attempt: (task.verification?.attempt || 0) + 1,
              failures: task.verification?.failures || 0, startedAt: now(), checks: [] };
            event = autoNotice(node.nodeId, 'verifying', 'Fleet is running the lead check commands.');
          } else event = lanes.report(value, node.nodeId, action, input.text, task.progressAt);
          // Outside a lane, hold is the worker's terminal "cannot finish" result.
          if (action === 'hold' && !event) {
            task.status = 'held';
            event = autoNotice(node.nodeId, 'held', input.text);
          }
        });
        announce(event ? [event] : [], { verification: !!verify });
        if (verify) nudge(node.nodeId);
        return { revision: next.revision, task: next.tasks[node.nodeId], ...(event?.laneId ? { lane: { id: event.laneId, n: event.n, status: event.status } } : {}) };
      }
      if (action === 'ask') {
        const node = document.nodes.find(node => node.sessionId === sessionId && node.state === 'running');
        if (!node) refuse('FLEET_CONTROL_WORKER_REQUIRED', 'Only an active worker may file an ask.');
        checkTaskRevision(input, state().tasks[node.nodeId], requireTaskRevision);
        identifier(input.id); text(input.question, 'Question');
        const existing = Object.hasOwn(state().asks, input.id) ? state().asks[input.id] : null;
        if (existing) {
          if (existing.nodeId !== node.nodeId || existing.question !== input.question || (existing.taskRevision || 1) !== (state().tasks[node.nodeId]?.taskRevision || 1)) refuse('FLEET_ASK_REPLAY_CONFLICT', 'This ask id already names another question.');
          return { revision: state().revision, id: input.id, ...clone(existing), replay: true };
        }
        const next = commit(value => { value.asks[input.id] = { nodeId: node.nodeId, taskRevision: value.tasks[node.nodeId]?.taskRevision || 1, question: input.question, status: 'open', filedAt: now() }; });
        let notification = 'recorded';
        try { await onAsk({ id: input.id, nodeId: node.nodeId }); } catch { notification = 'pending-discovery'; }
        return { revision: next.revision, id: input.id, ...next.asks[input.id], notification };
      }
      assertRoot(sessionId);
      checkWriteRevision(input, action);
      if (action === 'account-select') {
        if (input.nodeId) refuse('FLEET_ACCOUNT_SCOPE_INVALID', 'Account selection sets this hub default for future launches; omit nodeId.');
        if (!['claude', 'codex', 'grok', 'gemini'].includes(input.provider)) refuse('FLEET_ACCOUNT_PROVIDER_UNSUPPORTED', 'Select a Claude/Codex account or a configured provider API-key route.');
        let selected = null;
        if (input.active !== false) {
          if (!accounts) refuse('FLEET_ACCOUNT_SERVICE_UNAVAILABLE', 'Configure the existing account-home service on this Fleet host before selecting an account.');
          const route = { provider: input.provider, account: input.account, ...(input.provider === 'codex' && input.model !== undefined ? { admission: 'ordinary-work', model: input.model } : {}) };
          const validated = await accounts.validate(route);
          if (input.provider === 'codex' && validated?.authentication !== 'api-key' && (typeof input.model !== 'string' || !input.model.trim())) refuse('FLEET_ACCOUNT_MODEL_MISMATCH', 'Choose an explicit model from this account’s current authenticated catalog.');
          selected = { ...(validated || route), verifiedAt: now(), ...stamp(by, { selectedBy: by }) };
        }
        const current = state().accountDefaults?.[input.provider];
        if ((!selected && !current) || (selected && current && ['provider', 'account', 'admission', 'model', 'authentication'].every(key => selected[key] === current[key]))) return { revision: state().revision, action, replay: true, scope: 'future-provider-launches', defaults: clone(state().accountDefaults || {}) };
        const next = commit(value => {
          value.accountDefaults ||= {};
          if (selected) value.accountDefaults[input.provider] = selected;
          else delete value.accountDefaults[input.provider];
        });
        return { revision: next.revision, scope: 'future-provider-launches', defaults: clone(next.accountDefaults) };
      }      if (action === 'assess') {
        identifier(input.nodeId);
        if (!Number.isSafeInteger(input.expectedTaskRevision) || input.expectedTaskRevision < 1) refuse('FLEET_TASK_STALE_REVISION', 'Name the exact expectedTaskRevision being assessed.');
        let archivedTask = null;
        const target = value => {
          const live = value.tasks[input.nodeId];
          if ((live?.taskRevision || 1) === input.expectedTaskRevision && (live?.submission || ['completed', 'held'].includes(live?.status))) return live;
          return (value.taskHistory || []).findLast(task => task.nodeId === input.nodeId && (task.taskRevision || 1) === input.expectedTaskRevision && (task.submission || ['completed', 'held'].includes(task.status))) || archivedTask?.row;
        };
        if (!target(state())) archivedTask = history?.archivedTask(input.nodeId, input.expectedTaskRevision);
        if (!target(state())) refuse('FLEET_RESULT_UNKNOWN', 'No terminal result exists for that worker and task revision.');
        const assessment = results.assessment(input.assessment);
        const previous = target(state()).assessment;
        if (previous && (previous.by || null) === (by || null) && isDeepStrictEqual({ decision: previous.decision, note: previous.note, evidence: previous.evidence }, assessment))
          return { revision: state().revision, nodeId: input.nodeId, taskRevision: input.expectedTaskRevision, outcome: results.outcome(target(state())), replay: true };
        const historyUpdates = [];
        let assessed;
        const apply = task => {
          if (task.assessment) { task.assessments ||= []; task.assessments.push(task.assessment); }
          task.assessment = { ...assessment, source: 'lead', at: now(), taskRevision: input.expectedTaskRevision, ...stamp(by, { by }) };
        };
        const next = commit(value => {
          const task = archivedTask ? require('./fleet-state-draft').produce(archivedTask.row, apply) : target(value);
          if (!archivedTask) apply(task);
          else historyUpdates.push({ ...archivedTask, row: task });
          assessed = task;
          if (task.lane && value.lanes?.[task.lane]) {
            const lane = value.lanes[task.lane];
            const item = lane.items.find(item => item.n === task.laneItem && item.taskRevision === input.expectedTaskRevision);
            if (item) { item.assessment = task.assessment; if (task.assessments) item.assessments = task.assessments; }
            else {
              const cold = history?.archivedItem(task.lane, task.laneItem);
              if (cold) {
                const changed = require('./fleet-state-draft').produce(cold.row, draft => { draft.assessment = clone(task.assessment); if (task.assessments) draft.assessments = clone(task.assessments); });
                historyUpdates.push({ ...cold, row: changed });
                const before = require('./fleet-history-retention').outcomeCounts([cold.row]);
                const after = require('./fleet-history-retention').outcomeCounts([changed]);
                for (const key of Object.keys(after)) lane.archivedItems.outcomes[key] += after[key] - before[key];
              }
            }
          }
          // Cold-only edits still invalidate this node's target revision.
          if (archivedTask) value.archivedAssessment = { nodeId: input.nodeId, taskRevision: input.expectedTaskRevision, at: now() };
        }, undefined, historyUpdates);
        return { revision: next.revision, nodeId: input.nodeId, taskRevision: input.expectedTaskRevision, outcome: results.outcome(assessed) };
      }
      if (['lane', 'lane-add', 'lane-rule', 'lane-resume', 'lane-close', 'lane-schedule'].includes(action)) {
        identifier(input.id);
        const result = { lane: lanes.create, 'lane-add': lanes.add, 'lane-schedule': lanes.schedule, 'lane-rule': lanes.rule, 'lane-resume': lanes.resume, 'lane-close': lanes.close }[action](input, by);
        if (result.replay) return { revision: state().revision, replay: true, lane: result.lane };
        announce(result.events); nudge(result.wake);
        return { revision: result.next.revision, lane: lanes.read({ ...input, id: input.id }, inspect()) };
      }
      if (action === 'permission-profiles') {
        if (document.nodes.some(node => ['running', 'starting'].includes(node.state))) refuse('FLEET_SETTINGS_PAUSE_REQUIRED', 'Pause workers before changing their action permission profiles.');
        const profiles = require('./action-permission-profiles').normalize(input.profiles);
        return commit(value => { value.permissionProfiles = profiles; });
      }
      if (action === 'resources') {
        const policy = require('./fleet-v2-resources').validatePolicy(input.policy);
        return commit(value => { value.resources = policy; });
      }
      if (action === 'resource-advice') {
        if (!resources) refuse('FLEET_RESOURCE_GATE_UNAVAILABLE', 'This host has no native resource gate.');
        const result = resources.advise({ id: input.id, provider: input.provider, decision: input.decision, launches: input.launches, expiresAtMs: input.expiresAtMs, reason: input.reason });
        const next = commit(value => { value.resourceAdvice = { id: input.id, provider: input.provider, decision: input.decision, at: now() }; });
        return { revision: next.revision, result };
      }
      if (action === 'stop-subtree') {
        identifier(input.nodeId);
        if (typeof stopSubtree !== 'function') refuse('FLEET_SUBTREE_STOP_UNAVAILABLE', 'This host has no subtree stop implementation.');
        const result = await stopSubtree({ nodeId: input.nodeId, parentSessionId: rootSessionId });
        const next = commit(value => { value.lifecycle = { nodeId: input.nodeId, action, at: now(), ok: result.ok, ...stamp(by, { by }) }; });
        return { revision: next.revision, result };
      }
      if (['pause', 'stop', 'resume', 'remove'].includes(action)) {
        identifier(input.nodeId);
        if (action === 'resume' && input.text !== undefined) replaceTask(input.nodeId, input.text, true, by, input.requirements);
        // Lifecycle is awaited: a pause receipt means the owned session is quiet.
        if (action === 'resume') announce(lanes.prepare(input.nodeId));
        if (action === 'resume' && ['completed', 'held'].includes(state().tasks[input.nodeId]?.status))
          refuse('FLEET_TASK_COMPLETED', 'Assign the next durable task before resuming this completed assignment.');
        let result;
        try { result = await command({ action: `${action}-node`, nodeId: input.nodeId, parentSessionId: rootSessionId }); }
        catch (cause) {
          throw action === 'resume' ? resumeError(cause, input.nodeId) : cause;
        }
        if (result?.ok === false || result?.[{ pause: 'paused', stop: 'stopped', resume: 'resumed', remove: 'removed' }[action]] === false)
          refuse(result.code || 'FLEET_LIFECYCLE_FAILED', result.reason || `The host did not confirm ${action}; inspect the worker before retrying.`);
        const next = commit(value => {
          value.lifecycle = { nodeId: input.nodeId, action, at: now(), ...stamp(by, { by }) };
          if (action === 'remove' && value.tasks[input.nodeId]) value.tasks[input.nodeId].status = 'removed';
          const lane = action === 'remove' && lanes.laneAt(value, input.nodeId);
          if (lane) { lane[1].state = 'removed'; lane[1].reason = 'the lane worker was removed'; }
        });
        return { revision: next.revision, result };
      }
      if (action === 'task') {
        identifier(input.nodeId);
        return replaceTask(input.nodeId, input.text, input.newTask === true, by, input.requirements, { autoContinue: input.autoContinue, keepConversation: input.keepConversation });
      }
      if (action === 'rule') {
        identifier(input.id); text(input.text, 'Rule');
        return commit(value => { if (Object.hasOwn(value.rules, input.id)) { value.ruleHistory ||= []; value.ruleHistory.push({ id: input.id, ...value.rules[input.id], retiredAt: now() }); } value.rules[input.id] = { text: input.text, active: input.active !== false, editedAt: now(), ...stamp(by, { editedBy: by }) }; });
      }
      if (action === 'archive-ask') {
        identifier(input.id);
        const ask = Object.hasOwn(state().asks, input.id) ? state().asks[input.id] : null;
        if (!ask) refuse('FLEET_ASK_UNKNOWN', 'There is no retained ask with that id.');
        const node = document.nodes.find(node => node.nodeId === ask.nodeId);
        const currentTask = state().tasks[ask.nodeId];
        if ((ask.taskRevision || 1) === (currentTask?.taskRevision || 1) && node && ['running', 'starting'].includes(node.state)) await command({ action: 'pause-node', nodeId: node.nodeId, parentSessionId: rootSessionId });
        return commit(value => { value.asks[input.id].status = 'archived'; value.asks[input.id].archivedAt = now(); Object.assign(value.asks[input.id], stamp(by, { archivedBy: by })); });
      }
      if (action === 'answer') {
        identifier(input.id); text(input.answer, 'Answer');
        const ask = Object.hasOwn(state().asks, input.id) ? state().asks[input.id] : null;
        if (!ask) refuse('FLEET_ASK_UNKNOWN', 'There is no retained ask with that id.');
        if (Object.hasOwn(ask, 'answer')) {
          if (ask.answer !== input.answer) refuse('FLEET_ASK_ALREADY_ANSWERED', 'The ask already has a different answer.');
          const resume = input.resume !== false ? await resumeAnswered(input.id, by) : null;
          return { revision: state().revision, id: input.id, replay: true, ...clone(state().asks[input.id]), ...(resume ? { resume } : {}) };
        }
        const currentTask = state().tasks[ask.nodeId];
        if (ask.status === 'superseded' || (ask.taskRevision || 1) !== (currentTask?.taskRevision || 1)) refuse('FLEET_ASK_SUPERSEDED', 'This question belongs to an earlier task; it cannot interrupt the current assignment.');
        const node = document.nodes.find(node => node.nodeId === ask.nodeId);
        if (currentTask?.status !== 'verifying' && node && ['running', 'starting'].includes(node.state)) await command({ action: 'pause-node', nodeId: node.nodeId, parentSessionId: rootSessionId });
        commit(value => {
          Object.assign(value.asks[input.id], { answer: input.answer, status: 'answered', answeredAt: now(), ...stamp(by, { answeredBy: by }) });
          if (value.tasks[ask.nodeId]?.lane && value.tasks[ask.nodeId].status === 'assigned') delete value.tasks[ask.nodeId].waitUntil;
        });
        const resume = input.resume !== false ? await resumeAnswered(input.id, by) : null;
        return { revision: state().revision, id: input.id, ...clone(state().asks[input.id]), ...(resume ? { resume } : {
          nextAction: { action: 'resume', nodeId: ask.nodeId, expectedRevision: state().revision } }) };
      }
      if (action === 'settings' || action === 'import-settings') {
        if (!settings) refuse('FLEET_SETTINGS_UNAVAILABLE', 'This host has no settings writer.');
        // Only these two settings affect admission of new nodes, never an
        // existing worker's assignment, session or permission boundary. Check
        // the raw map so mixed imports cannot smuggle other settings through.
        const ids = input.changes && typeof input.changes === 'object' && !Array.isArray(input.changes) ? Object.keys(input.changes) : [];
        const liveResize = ids.length > 0 && ids.every(id => id === 'fleet.tree_width' || id === 'fleet.tree_depth');
        if (!liveResize && document.nodes.some(node => ['running', 'starting'].includes(node.state)))
          refuse('FLEET_SETTINGS_PAUSE_REQUIRED', 'Pause workers before changing shared orchestration settings.');
        const result = settings(input.changes, { import: action === 'import-settings' });
        const next = commit(value => { value.settingsChangedAt = now(); Object.assign(value, stamp(by, { settingsChangedBy: by })); if (result.resources) value.resources = result.resources; if (result.permissionProfiles) value.permissionProfiles = result.permissionProfiles; value.policies = { ...(value.policies || {}), ...(result.policies || {}) }; });
        return { revision: next.revision, result: { ...result, ...(liveResize && slotStatus ? { slotLimits: slotStatus() } : {}) } };
      }
      refuse('FLEET_CONTROL_ACTION_INVALID', 'Unknown Fleet control action.');
    }, result => {
      const receipt = require('./fleet-v2-control-surface').mutationReceipt(result, input);
      const waiting = sessionId === rootSessionId ? workWait(input, result) : {};
      return waiting.waitsFor ? { ...receipt, ...waiting } : receipt;
    })
      .catch(error => { throw require('./fleet-recovery').error(error, { tool: 'fleet.control', action: input.action }); });
  }
  // Host turn boundary. phase "ended" scores the turn that just ended;
  // phase "next" (an idle worker the host may send to) returns the next lane
  // turn's text, or null. A refusal pauses the lane and says why.
  function laneTurn({ nodeId, phase, status, ...details }) {
    if (phase === 'failed' || phase === 'ended' && !['completed', 'interrupted'].includes(status)) {
      // Provider prose can contain credentials. Redact exact environment
      // secrets and known credential patterns before bounding retained text.
      const redactor = require('./agent-engine/stream-redactor').createEnvironmentRedactor(process.env);
      const reason = redactor.write(String(details.reason || `The provider turn ended with status ${status || 'submission-uncertain'}.`)) + redactor.end();
      details.reason = require('./audit').scrubText(reason, 2000);
      if (details.code) details.code = require('./audit').scrubText(details.code, 160);
    }
    if (state().tasks[nodeId]?.status === 'verifying') return null;
    const lane = lanes.laneAt(state(), nodeId);
    if (lane && ['recover', 'recoverable'].includes(phase)) {
      const task = state().tasks[nodeId], item = lane[1].items.find(entry => entry.status === 'active');
      if (lane[1].state !== 'running' || task?.status !== 'assigned' || task.lane !== lane[0]
          || task.laneItem !== item?.n || task.taskRevision !== item?.taskRevision || openAskFor(state(), nodeId, task)) return null;
      // Only a known idle scheduled wait is eligible for restart. The host
      // additionally proves the completed turn boundary before retaining it.
      if (phase === 'recoverable') return Number.isFinite(Date.parse(task.waitUntil)) ? { ready: true } : null;
      const node = document.nodes.find(node => node.nodeId === nodeId);
      return node?.assignmentRecovery?.taskRevision === task.taskRevision
        && (!task.waitUntil || Date.parse(now()) >= Date.parse(task.waitUntil)) ? { ready: true } : null;
    }
    if (phase === 'unsent' && lane) return null;
    if (!lanes.laneAt(state(), nodeId)) {
      try { return assignmentTurn({ nodeId, phase, status, ...details }); } catch (error) {
        return phase === 'next' ? { error: { code: error.code || 'FLEET_ASSIGNMENT_CONTINUATION_ERROR', message: String(error.message || error) } } : null;
      }
    }
    try {
      if (phase === 'ended') { announce(lanes.turnEnded(nodeId, status, details)); return null; }
      if (phase === 'failed') { announce(lanes.failed(nodeId, status || 'submission-uncertain', details)); return null; }
      const { turn, events } = lanes.nextTurn(nodeId, null);
      announce(events);
      if (!turn) return null;
      // The host's lifecycle delivery owns rule refreshes. Repeating a lane
      // task must not smuggle unchanged rules back into every user message.
      const current = render(state(), nodeId, state().tasks[nodeId], { includeRules: false });
      const lead = turn.fresh ? `Fleet sent this automatically: your next lane task (lane ${turn.laneId}, task ${turn.n}).`
        : `Lane ${turn.laneId} task ${turn.n} is not finished (automatic turn ${turn.attempt}). Continue it: record progress with fleet.control action progress, finish with complete, or hold with the reason. Your task remains assigned until you explicitly complete or hold it; use an Ask for a blocking dependency.`;
      const context = turn.fresh ? `Fleet assigned this lane task at ${now()}.`
        : `Fleet sent an automatic lane turn at ${now()}${turn.waitUntil ? `; waitUntil ${turn.waitUntil} has passed` : ''}.`;
      return { ...turn, text: `${context}\n\n${lead}\n\n${current}`, taskRevision: state().tasks[nodeId].taskRevision, revision: state().revision, brief: current };
    } catch (error) {
      const found = lanes.laneAt(state(), nodeId);
      if (found && found[1].state === 'running') {
        const reason = `${error.code || 'FLEET_LANE_ERROR'}: ${String(error.message).slice(0, 300)}`;
        try { commit(value => { value.lanes[found[0]].state = 'paused'; value.lanes[found[0]].reason = reason; }); } catch { /* host must quiesce even if this pause cannot be saved */ }
        announce([{ laneId: found[0], nodeId, n: null, status: 'paused', reason }]);
      }
      return { error: { code: error.code || 'FLEET_LANE_ERROR', message: String(error.message || error) } };
    }
  }
  function ensureTask(nodeId, brief, options = {}) {
    identifier(nodeId); text(brief, 'Task');
    const requirements = results.requirements(options.requirements);
    return serial(() => {
      if (options.newTask === true) return replaceTask(nodeId, brief, true, attribution(), requirements);
      if (!state().tasks[nodeId]) commit(value => { value.tasks[nodeId] = { text: brief, taskRevision: 1, status: 'assigned', editedAt: now(), ...(requirements ? { requirements } : {}) }; });
    });
  }
  function scheduleTick() {
    return serial(() => {
      const wakes = lanes.scheduleTick();
      for (const nodeId of wakes) nudge(nodeId);
      return { queued: wakes.length };
    });
  }

  // Private host callbacks, never exposed through fleet.control. The retained
  // verification id fences late results after a lead replaces the assignment.
  function pendingVerification(nodeId) {
    const task = state().tasks[nodeId];
    if (task?.status !== 'verifying') return null;
    // Job task.text has a display header on the contract's opening line. Use
    // the canonical item text so its target resolves exactly as a plain task.
    const item = task.lane && state().lanes?.[task.lane]?.items.find(item => item.n === task.laneItem && item.taskRevision === task.taskRevision);
    return clone({ id: task.verification.id, text: item?.text || task.text,
      workspaceRoot: task.requirements.workspaceRoot || null,
      taskRevision: task.taskRevision || 1, checks: task.requirements.checks.filter(check => check.command) });
  }
  function finishVerification(nodeId, id, checks) {
    return serial(() => {
      const task = state().tasks[nodeId];
      if (task?.status !== 'verifying' || task.verification.id !== id) return false;
      const expected = task.requirements.checks.filter(check => check.command);
      if (checks.length !== expected.length || checks.some((check, n) => check.id !== expected[n].id))
        refuse('FLEET_VERIFICATION_RESULTS_INVALID', 'Host results must cover every lead command in order.');
      const passed = checks.every(check => check.status === 'passed');
      const failures = task.verification.failures + (passed ? 0 : 1);
      const held = !passed && (failures >= 3 || task.autoContinue === false || !assignmentContinuation);
      const reason = passed ? 'All lead check commands passed; verified by Fleet.'
        : `${held ? 'Held for the lead' : 'Rework required'} after command verification ${failures} failed: ` + checks.filter(check => check.status !== 'passed').map(check => `${check.id} (exit ${check.exitCode}${check.timedOut ? ', timeout' : ''}):\n${check.outputTail}`).join('\n');
      let event;
      const next = commit(value => {
        const current = value.tasks[nodeId];
        const previous = current.verification;
        current.verificationHistory ||= [];
        current.verification = { ...previous, status: passed ? 'passed' : 'failed', source: 'Fleet', ...(passed ? { verifiedBy: 'Fleet' } : {}), failures, checks, finishedAt: now() };
        current.verificationHistory.push(clone(current.verification));
        current.status = passed ? 'completed' : held ? 'held' : 'assigned';
        // Rework is fresh directed evidence, not another no-progress attempt.
        delete current.auto; delete current.waitUntil;
        if (passed || held) event = lanes.report(value, nodeId, held ? 'hold' : 'complete', held ? reason : current.submission.text, now());
        event = { ...(event || autoNotice(nodeId, current.status, reason)), reason };
      });
      announce([event], { verification: true }); nudge(nodeId);
      return next.tasks[nodeId];
    });
  }
  function permissionProfiles() { return require('./action-permission-profiles').normalize(state().permissionProfiles || { v: 1, activeProfileId: 'default', profiles: [{ id: 'default', name: 'Default', parentId: null, actions: { agentResume: 'automatic' } }] }); }
  return Object.freeze({ request, assignment, rulesFor, ensureTask, assertRoot, permissionProfiles, laneTurn, scheduleTick, pendingVerification, finishVerification });
}
module.exports = { createFleetControl };
