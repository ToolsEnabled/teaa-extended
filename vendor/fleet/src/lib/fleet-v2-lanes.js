'use strict';

// LANES. A lane stacks an ordered workload on one tree worker: its own rules,
// which reach that worker and every worker below it, and a list of tasks the
// worker takes top to bottom. The worker's durable task (fleetControl.tasks)
// is always the lane's active item, so read, progress, complete, asks and
// resume work unchanged. The host asks for the next turn at each idle turn
// boundary. Only an explicit completion/hold advances an active task. Failed
// or uncertain turns pause the job with the active task and recovery context
// intact. Missing progress alerts the lead without imposing a turn limit.
// A lane never spawns, resumes or grants anything by itself.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const results = require('./fleet-task-results');

const OPEN = new Set(['running', 'idle', 'paused']);
const schedules = require('./fleet-job-schedule');

function refuse(code, message) { throw Object.assign(new Error(message), { code }); }
function laneText(value, label, maximum = Infinity) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum)
    refuse('FLEET_LANE_INPUT_INVALID', `${label} must be nonempty text${Number.isFinite(maximum) ? ` of at most ${maximum} characters` : ''}.`);
  return value;
}
function rulesInput(rules, { required = false } = {}) {
  if (rules === undefined && !required) return {};
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) refuse('FLEET_LANE_INPUT_INVALID', 'Give rules as an object of rule id to rule text.');
  const entries = Object.entries(rules);
  if (required && !entries.length) refuse('FLEET_LANE_INPUT_INVALID', 'Give at least one job rule.');
  for (const [id, text] of entries) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) refuse('FLEET_LANE_INPUT_INVALID', 'Rule ids use lowercase letters, digits, - and _.');
    laneText(text, `Rule ${id}`);
  }
  return Object.fromEntries(entries);
}

// The lane rooted at this worker that is still open, if any.
function laneAt(value, nodeId) {
  for (const [id, lane] of Object.entries(value.lanes || {})) if (lane.nodeId === nodeId && OPEN.has(lane.state)) return [id, lane];
  return null;
}
// This worker and its ancestors, nearest first.
function lineage(nodes, nodeId) {
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const chain = [];
  for (let id = nodeId; id && byId.has(id) && !chain.includes(id); id = byId.get(id).parentNodeId) chain.push(id);
  return chain.length ? chain : [nodeId];
}
function subtree(nodes, nodeId) {
  return nodes.filter(node => lineage(nodes, node.nodeId).includes(nodeId));
}
function counts(lane) {
  const result = { total: lane.archivedItems?.total || 0, queued: 0, active: 0, done: lane.archivedItems?.done || 0, held: lane.archivedItems?.held || 0 };
  result.total += lane.items.length;
  for (const item of lane.items) result[item.status] += 1;
  return result;
}
function fingerprint(task, item) {
  return crypto.createHash('sha256').update(JSON.stringify({ progress: task?.progress || null, status: task?.status || null, item: item.status })).digest('hex');
}

// Rendered into every assignment in the lane's subtree.
function rulesBlock(value, nodes, nodeId) {
  const lines = [];
  for (const id of lineage(nodes, nodeId)) {
    const found = laneAt(value, id);
    if (!found) continue;
    const rules = Object.entries(found[1].rules).filter(([, rule]) => rule.active).map(([rule, { text }]) => `${rule}: ${text}`);
    if (rules.length) lines.push(`Lane ${found[0]} rules:`, ...rules);
  }
  return lines;
}
function validateWorkspaces(tasks, node) {
  for (const task of tasks) {
    const requested = task.requirements?.workspaceRoot;
    if (requested === undefined) continue;
    let real;
    try { real = fs.realpathSync(requested); } catch { refuse('FLEET_LANE_WORKSPACE_REFUSED', 'The requested task workspace is unavailable.'); }
    const scope = node?.folderScope;
    const under = roots => Array.isArray(roots) && roots.some(root => {
      const relative = path.relative(root, real);
      return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
    if (real !== path.resolve(requested) || !under(scope?.readRoots) || !under(scope?.writeRoots))
      refuse('FLEET_LANE_WORKSPACE_REFUSED', 'A task workspace must be a canonical directory inside both current native read and write roots.');
  }
}
function instructions(value, nodeId) {
  const found = laneAt(value, nodeId);
  const task = value.tasks[nodeId];
  if (!found || task?.lane !== found[0]) return [];
  return [`You work lane ${found[0]} top to bottom, one task at a time. When this task is done, report it with fleet.control action complete and text (your report). `
    + 'If you cannot finish it, use fleet.control action hold with text giving the reason; the lane records it and gives you the next task. '
    + 'Do not start a later lane task yourself: Fleet sends it as your next turn.'];
}

function header(id, lane, item) { return `Lane ${id}, task ${item.n} of ${counts(lane).total}: ${item.text}`; }

// measure(value, nodeId, taskText) renders that worker's assignment with the
// given task text without clipping any rule or answer.
function createLanes({ historyPage, state, commit, nodes, now, stamp, measure }) {
  const record = (id, lane, item, status, reason = null) => ({ laneId: id, nodeId: lane.nodeId, n: item.n, status, reason });
  // Validate rendering before committing each queued task and its job rules.
  const fits = id => value => { const lane = value.lanes[id]; for (const item of lane.items) if (['queued', 'active'].includes(item.status)) measure(value, lane.nodeId, header(id, lane, item)); };
  // Make the next queued item this worker's durable task. Same identity rules
  // as fleet.control task with a new task: history kept, open asks superseded.
  function activate(value, id, lane, at, by) {
    const item = lane.items.find(entry => entry.status === 'queued');
    if (!item) {
      if (lane.state === 'running') { lane.state = 'idle'; lane.reason = 'all tasks finished'; }
      return null;
    }
    const previous = value.tasks[lane.nodeId];
    const taskRevision = (previous?.taskRevision || 0) + 1;
    if (previous) { value.taskHistory ||= []; value.taskHistory.push({ nodeId: lane.nodeId, ...previous, retiredAt: at }); }
    for (const ask of Object.values(value.asks))
      if (ask.nodeId === lane.nodeId && ask.status === 'open') { ask.status = 'superseded'; ask.supersededAt = at; }
    value.tasks[lane.nodeId] = { text: header(id, lane, item), taskRevision, status: 'assigned',
      ...(item.requirements ? { requirements: item.requirements } : {}),
      editedAt: at, lane: id, laneItem: item.n, ...stamp(by, { editedBy: by }) };
    Object.assign(item, { status: 'active', taskRevision, startedAt: at, turns: 0, noProgress: 0 });
    item.mark = fingerprint(value.tasks[lane.nodeId], item);
    lane.state = 'running'; lane.reason = null;
    return item;
  }
  function finish(value, lane, item, status, reason, at) {
    Object.assign(item, { status, finishedAt: at, ...(status === 'held' ? { reason } : { report: reason }) });
    const task = value.tasks[lane.nodeId];
    if (task?.laneItem === item.n && task.taskRevision === item.taskRevision) {
      task.status = status === 'held' ? 'held' : 'completed';
      if (task.submission) item.submission = task.submission;
    }
  }
  function activeOf(value, nodeId) {
    const found = laneAt(value, nodeId);
    if (!found) return null;
    const [id, lane] = found;
    const item = lane.items.find(entry => entry.status === 'active');
    return { id, lane, item, task: value.tasks[nodeId] };
  }
  function current(value, nodeId) {
    const found = activeOf(value, nodeId);
    return found?.item && found.task?.lane === found.id && found.task.laneItem === found.item.n && found.task.taskRevision === found.item.taskRevision ? found : null;
  }
  function openAsk(value, nodeId, item) {
    return Object.values(value.asks).some(ask => ask.nodeId === nodeId && ask.status === 'open' && (ask.taskRevision || 1) === item.taskRevision);
  }
  function summary(id, lane, workers, input = {}) {
    const { compactView, pageEntries } = require('./fleet-v2-control-surface');
    const compact = compactView(input);
    const worker = workers.find(entry => entry.nodeId === lane.nodeId);
    const historical = historyPage && (input.offset !== undefined || input.limit !== undefined) ? historyPage({ ...input, kind: 'items', id }) : null;
    const page = historical ? { selected: historical.entries, page: historical.page } : pageEntries(lane.items, input);
    if (!historical && lane.archivedItems?.total) { page.page.offset += lane.archivedItems.total; page.page.total += lane.archivedItems.total; }
    const outcomes = { reported: 0, unassessed: 0, accepted: 0, rework: 0, rejected: 0 };
    for (const [key, count] of Object.entries(lane.archivedItems?.outcomes || {})) outcomes[key] += count;
    for (const item of lane.items) {
      if (item.submission) outcomes.reported++;
      if (item.assessment) outcomes[item.assessment.decision]++;
      else if (['done', 'held'].includes(item.status)) outcomes.unassessed++;
    }
    return { id, ...(historical ? { historyRevision: historical.historyRevision } : {}), nodeId: lane.nodeId, state: lane.state, reason: lane.reason || null, counts: counts(lane),
      ...(lane.schedule ? { schedule: schedules.summary(lane.schedule, compact) } : {}),
      outcomes, ...(lane.archivedItems ? { archivedItems: lane.archivedItems.total, history: { action: 'history-read', kind: 'items', id } } : {}), ...(lane.attention ? { attention: lane.attention } : {}),
      ...(lane.lastFailure ? { lastFailure: compact ? { status: lane.lastFailure.status, at: lane.lastFailure.at, n: lane.lastFailure.n, taskRevision: lane.lastFailure.taskRevision, ...(lane.lastFailure.code ? { code: lane.lastFailure.code } : {}) } : lane.lastFailure } : {}),
      ...(!compact && lane.failureHistory ? { failureHistory: lane.failureHistory } : {}),      current: lane.items.find(item => item.status === 'active')?.n || null,
      worker: worker ? { state: worker.state, turn: worker.turn || null } : null,
      rules: Object.fromEntries(Object.entries(lane.rules).map(([rule, { text, active }]) => [rule, { ...(compact ? {} : { text }), active }])),
      ...(!compact || input.offset !== undefined || input.limit !== undefined ? {
        items: page.selected.map(item => {
          const { n, text, status, report, reason, turns, startedAt, finishedAt, addedAt, taskRevision, requirements, submission, assessment, assessments, noProgress, failures, lastFailure } = item;
          const outcome = results.outcome(item);
          return { n, ...(taskRevision ? { taskRevision } : {}), ...(compact ? {} : { text, ...(report ? { report } : {}), ...(requirements ? { requirements } : {}), ...(submission ? { submission } : {}), ...(assessment ? { assessment } : {}), ...(assessments ? { assessments } : {}), ...(lastFailure ? { lastFailure } : {}) }),
            status, ...(noProgress ? { noProgress } : {}), ...(failures ? { failures } : {}), ...(outcome ? { outcome } : {}), ...(reason ? { reason } : {}), turns: turns || 0, addedAt, ...(startedAt ? { startedAt } : {}), ...(finishedAt ? { finishedAt } : {}) };        }),
        page: page.page } : {}),
      createdAt: lane.createdAt, ...(lane.createdBy ? { createdBy: lane.createdBy } : {}) };
  }

  // Root edits. Each returns { next, events, wake } for fleet-v2-control.
  function create(input, by) {
    laneText(input.id, 'Lane id', 64);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.id)) refuse('FLEET_LANE_INPUT_INVALID', 'Lane ids use lowercase letters, digits, - and _.');
    if (typeof input.nodeId !== 'string') refuse('FLEET_LANE_INPUT_INVALID', 'Name the tree worker (nodeId) that runs the lane.');
    const tasks = results.workItems(input);
    const rules = rulesInput(input.rules);
    const value = state();
    const node = nodes().find(entry => entry.nodeId === input.nodeId);
    if (!node) refuse('FLEET_CONTROL_NODE_UNKNOWN', 'A lane needs an existing tree worker; start it with agent.spawn first.');
    validateWorkspaces(tasks, node);
    if (Object.hasOwn(value.lanes || {}, input.id)) refuse('FLEET_LANE_EXISTS', `Lane ${input.id} already exists; append with lane-add.`);
    if (laneAt(value, input.nodeId)) refuse('FLEET_LANE_NODE_BUSY', `This worker already runs lane ${laneAt(value, input.nodeId)[0]}; append to it with lane-add.`);
    if (node.continuation && ['ready', 'running', 'waiting'].includes(node.continuation.state))
      refuse('FLEET_LANE_CONTINUATION_ACTIVE', 'This worker is enrolled in agent.continue; disable that run before giving it a lane.');
    const idle = !['running', 'starting'].includes(node.state);
    const at = now();
    let item = null;
    const next = commit(edit => {
      edit.lanes ||= {};
      const lane = edit.lanes[input.id] = { nodeId: input.nodeId, state: 'running', reason: null,
        rules: Object.fromEntries(Object.entries(rules).map(([rule, text]) => [rule, { text, active: true, editedAt: at }])),
        templateTasks: tasks,
        items: tasks.map((task, index) => ({ n: index + 1, ...task, status: 'queued', addedAt: at })), createdAt: at, ...stamp(by, { createdBy: by }) };
      // A stopped or paused worker gets its first task now, so resume sends it.
      // A running worker gets it at its next idle turn boundary.
      if (idle) item = activate(edit, input.id, lane, at, by);
    }, fits(input.id));
    return { next, events: item ? [record(input.id, next.lanes[input.id], item, 'started')] : [], wake: input.nodeId };
  }
  function add(input, by) {
    const value = state();
    const lane = Object.hasOwn(value.lanes || {}, input.id) ? value.lanes[input.id] : null;
    if (!lane) refuse('FLEET_LANE_UNKNOWN', 'There is no lane with that id.');
    if (!OPEN.has(lane.state)) refuse('FLEET_LANE_CLOSED', `Lane ${input.id} is ${lane.state}; create a new lane instead.`);
    const tasks = results.workItems(input);
    const node = nodes().find(entry => entry.nodeId === lane.nodeId);
    validateWorkspaces(tasks, node);
    const idle = !node || !['running', 'starting'].includes(node.state);
    const at = now();
    const next = commit(edit => {
      const target = edit.lanes[input.id];
      for (const task of tasks) target.items.push({ n: (target.items.at(-1)?.n || target.archivedItems?.total || 0) + 1, ...task, status: 'queued', addedAt: at });
      // Explicit new work (including a contract amendment) ends the old wait.
      const active = current(edit, target.nodeId);
      if (active) delete active.task.waitUntil;
      if (target.state === 'idle') { target.state = 'running'; target.reason = null; }
      if (idle && target.state === 'running' && !target.items.some(item => item.status === 'active')) activate(edit, input.id, target, at, by);
    }, fits(input.id));
    return { next, events: [], wake: lane.nodeId };
  }
  function schedule(input, by) {
    const value = state();
    const lane = Object.hasOwn(value.lanes || {}, input.id) ? value.lanes[input.id] : null;
    if (!lane) refuse('FLEET_LANE_UNKNOWN', 'There is no job with that id.');
    if (!OPEN.has(lane.state)) refuse('FLEET_LANE_CLOSED', `Job ${input.id} is ${lane.state}; create a new job instead.`);
    const at = now();
    let legacyItems = lane.items;
    // First-time scheduling of pre-template jobs keeps the original contract:
    // snapshot all existing task definitions, including already archived items.
    if (input.tasks === undefined && input.workItems === undefined && !lane.schedule?.templateTasks && !lane.templateTasks && lane.archivedItems?.total && historyPage) {
      legacyItems = [];
      for (let offset = 0;;) {
        const page = historyPage({ kind: 'items', id: input.id, offset, limit: 1000 });
        legacyItems.push(...page.entries);
        if (page.page.nextOffset === null) break;
        offset = page.page.nextOffset;
      }
    }
    const template = input.tasks !== undefined || input.workItems !== undefined ? results.workItems(input)
      : lane.schedule?.templateTasks || lane.templateTasks || legacyItems.map(({ text, requirements }) => ({ text, ...(requirements ? { requirements } : {}) }));
    const configured = schedules.configure(input.schedule, lane.schedule, template, at);
    const next = commit(edit => {
      edit.lanes[input.id].schedule = { ...configured, ...stamp(by, { editedBy: by }) };
    });
    return { next, events: [], wake: null };
  }
  // Called by the hub watch, even when all workers are busy or stopped. The
  // template append and next-due advance share one durable control commit.
  function scheduleTick() {
    const at = now();
    const due = Object.entries(state().lanes || {}).filter(([, lane]) => schedules.due(lane.schedule, at));
    if (!due.length) return [];
    const wakes = [];
    commit(edit => {
      for (const [id] of due) {
        const lane = edit.lanes[id];
        const node = nodes().find(entry => entry.nodeId === lane.nodeId);
        const reason = !OPEN.has(lane.state) ? `job ${lane.state}` : lane.state === 'paused' ? 'job paused'
          : !node || node.state === 'removed' ? 'worker removed'
          : lane.items.some(item => ['active', 'queued'].includes(item.status)) ? 'previous run still active' : null;
        if (!schedules.advance(lane.schedule, at, reason)) continue;
        for (const task of lane.schedule.templateTasks)
          lane.items.push({ n: (lane.items.at(-1)?.n || lane.archivedItems?.total || 0) + 1, ...task, status: 'queued', addedAt: at });
        lane.state = 'running'; lane.reason = null;
        wakes.push(lane.nodeId);
      }
    }, value => { for (const [id] of due) fits(id)(value); });
    return wakes;
  }
  function rule(input, by) {
    const value = state();
    const lane = Object.hasOwn(value.lanes || {}, input.id) ? value.lanes[input.id] : null;
    if (!lane) refuse('FLEET_LANE_UNKNOWN', 'There is no lane with that id.');
    const rules = rulesInput(input.rules, { required: true });
    const waiting = current(value, lane.nodeId)?.task.waitUntil;
    const at = now();
    const next = commit(edit => {
      const target = edit.lanes[input.id];
      for (const [id, text] of Object.entries(rules)) {
        if (target.rules[id]) { target.ruleHistory ||= []; target.ruleHistory.push({ id, ...target.rules[id], retiredAt: at }); }
        target.rules[id] = { text, active: input.active !== false, editedAt: at, ...stamp(by, { editedBy: by }) };
      }
      const active = current(edit, target.nodeId);
      if (active) delete active.task.waitUntil;
    }, fits(input.id));
    return { next, events: [], wake: waiting ? lane.nodeId : null };
  }
  function resume(input, by) {
    const value = state();
    const lane = Object.hasOwn(value.lanes || {}, input.id) ? value.lanes[input.id] : null;
    if (!lane) refuse('FLEET_LANE_UNKNOWN', 'There is no lane with that id.');
    if (lane.state !== 'paused') refuse('FLEET_LANE_NOT_PAUSED', `Lane ${input.id} is ${lane.state}, not paused.`);
    const next = commit(edit => {
      const target = edit.lanes[input.id];
      target.state = 'running'; target.reason = null; target.resumedAt = now();
      if (target.attention?.kind === 'failure') delete target.attention;
      Object.assign(target, stamp(by, { resumedBy: by }));
    });
    return { next, events: [], wake: lane.nodeId };
  }
  function close(input, by) {
    const value = state();
    const lane = Object.hasOwn(value.lanes || {}, input.id) ? value.lanes[input.id] : null;
    if (!lane) refuse('FLEET_LANE_UNKNOWN', 'There is no lane with that id.');
    if (!OPEN.has(lane.state)) return { next: null, replay: true, lane: summary(input.id, lane, [], input) };
    const at = now();
    const events = [];
    const next = commit(edit => {
      const target = edit.lanes[input.id];
      for (const item of target.items) if (item.status === 'active') { finish(edit, target, item, 'held', 'The lead closed the lane before this task finished.', at); events.push(record(input.id, target, item, 'held', item.reason)); }
      if (target.schedule) { target.schedule.enabled = false; target.schedule.nextDueAt = null; }
      target.state = 'closed'; target.reason = 'closed by the lead'; target.closedAt = at; Object.assign(target, stamp(by, { closedBy: by }));
    });
    return { next, events, wake: null };
  }
  function read(input, workers) {
    const value = state();
    if (input.id === undefined) return { revision: value.revision, lanes: Object.entries(value.lanes || {}).map(([id, lane]) => summary(id, lane, workers, input)) };
    const lane = Object.hasOwn(value.lanes || {}, input.id) ? value.lanes[input.id] : null;
    if (!lane) refuse('FLEET_LANE_UNKNOWN', 'There is no lane with that id.');
    return { revision: value.revision, ...summary(input.id, lane, workers, input) };
  }

  // Worker reports, inside the progress/complete/hold commit.
  function report(edit, nodeId, action, text, at) {
    const found = current(edit, nodeId);
    if (!found) {
      // A plain assignment (no lane) records its own hold; an open lane whose
      // current item is not this task is inconsistent and still refuses.
      if (action === 'hold' && laneAt(edit, nodeId)) refuse('FLEET_LANE_REQUIRED', 'Only the current task of a lane can be held.');
      return null;
    }
    if (action === 'progress') return null;
    finish(edit, found.lane, found.item, action === 'hold' ? 'held' : 'done', text, at);
    if (found.lane.attention?.n === found.item.n) delete found.lane.attention;
    return record(found.id, found.lane, found.item, action === 'hold' ? 'held' : 'done', action === 'hold' ? text : null);
  }

  // A failed/uncertain provider turn is not a terminal task result. Retain the
  // current work and pause instead of consuming the next queued item.
  function failed(nodeId, status, details = {}) {
    const found = laneAt(state(), nodeId);
    if (!found || found[1].state !== 'running') return [];
    const task = state().tasks[nodeId];
    if (details.taskRevision !== undefined && details.taskRevision !== task?.taskRevision) return [];
    const at = now(), id = found[0];
    const failure = { status, at, n: task?.lane === id ? task.laneItem : null,
      taskRevision: task?.taskRevision || null, ...(details.turnId ? { turnId: details.turnId } : {}),
      ...(details.code ? { code: details.code } : {}),
      reason: details.reason || `The provider turn ended with status ${status}; check retained work before resuming.` };
    const reason = `Provider turn ${status}${failure.code ? ` (${failure.code})` : ''}; unfinished work is retained. Cause: ${failure.reason} Inspect the failure, then job-resume; resume the worker too if it is stopped.`;
    commit(edit => {
      const lane = edit.lanes[id];
      if (lane.lastFailure) { lane.failureHistory ||= []; lane.failureHistory.push(lane.lastFailure); }
      lane.lastFailure = failure;
      lane.state = 'paused'; lane.reason = reason;
      lane.attention = { kind: 'failure', n: failure.n, at };
      const item = lane.items.find(entry => entry.status === 'active');
      if (item) { item.lastFailure = failure; item.failures = (item.failures || 0) + 1; }
    });
    return [{ laneId: id, nodeId, n: null, status: 'paused', reason }];
  }
  // Host turn boundary. Synchronous: one commit, no awaiting other work.
  function turnEnded(nodeId, status, details = {}) {
    if (status !== 'completed' && status !== 'interrupted') return failed(nodeId, status, details);
    const found = current(state(), nodeId);
    if (!found || found.lane.state !== 'running' || status === 'interrupted') return [];
    if (details.taskRevision !== undefined && details.taskRevision !== found.task.taskRevision) return [];
    if (openAsk(state(), nodeId, found.item)) return [];
    const events = [];
    commit(edit => {
      const { id, lane, item, task } = current(edit, nodeId);
      const mark = fingerprint(task, item);
      if (mark !== item.mark) {
        item.mark = mark; item.noProgress = 0;
        if (lane.attention?.kind === 'no-progress') delete lane.attention;
        return;
      }
      item.noProgress = (item.noProgress || 0) + 1;
      if (item.noProgress === 1) {
        lane.attention = { kind: 'no-progress', n: item.n, at: now() };
        events.push(record(id, lane, item, 'attention', 'The turn ended without new durable progress. The assignment remains active; inspect its evidence or give more specific direction.'));
      }
    });
    return events;
  }
  // Host asks for the next turn of an idle, sendable worker.
  function nextTurn(nodeId, by) {
    const found = laneAt(state(), nodeId);
    if (!found || found[1].state !== 'running') return { turn: null, events: [] };
    const active = current(state(), nodeId);
    if (active && openAsk(state(), nodeId, active.item)) return { turn: null, events: [] };
    const at = now();
    const waitUntil = active?.task.waitUntil;
    if (waitUntil && Date.parse(at) < Date.parse(waitUntil)) return { turn: null, events: [] };
    const events = [];
    let turn = null;
    commit(edit => {
      const lane = edit.lanes[found[0]];
      let item = lane.items.find(entry => entry.status === 'active');
      // An inconsistent assignment must not consume work or dispatch a successor.
      if (item && !current(edit, nodeId)) {
        lane.state = 'paused'; lane.reason = 'The active job item and worker assignment disagree; reconcile them before job-resume.';
        events.push({ laneId: found[0], nodeId, n: null, status: 'paused', reason: lane.reason });
        return;
      }
      const fresh = !item;
      if (fresh) item = activate(edit, found[0], lane, at, by);
      if (!item) {
        const tally = counts(lane);
        events.push({ laneId: found[0], nodeId, n: null, status: 'finished', reason: `${tally.done} done, ${tally.held} held of ${tally.total}` });
        return;
      }
      item.turns = (item.turns || 0) + 1;
      delete edit.tasks[nodeId].waitUntil;
      if (fresh) events.push(record(found[0], lane, item, 'started'));
      turn = { laneId: found[0], n: item.n, fresh, attempt: item.turns, ...(waitUntil ? { waitUntil } : {}) };
    });
    return { turn, events };
  }
  // Before a lead resumes a stopped or paused lane worker: give it the next
  // queued task if it has none, so the resume sends lane work.
  function prepare(nodeId) {
    const found = laneAt(state(), nodeId);
    if (!found || found[1].state !== 'running' || found[1].items.some(item => item.status === 'active') || !found[1].items.some(item => item.status === 'queued')) return [];
    let item = null;
    const next = commit(edit => { item = activate(edit, found[0], edit.lanes[found[0]], now(), null); });
    return item ? [record(found[0], next.lanes[found[0]], item, 'started')] : [];
  }
  return Object.freeze({ create, add, schedule, scheduleTick, rule, resume, close, read, report, turnEnded, failed, nextTurn, prepare, rulesBlock: (value, nodeId) => rulesBlock(value, nodes(), nodeId), instructions, laneAt });
}
module.exports = { createLanes };
