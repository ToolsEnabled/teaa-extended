'use strict';

const crypto = require('node:crypto');
const { selectConfiguration, operationalSupplyMetadata } = require('./fleet-v5-selector');
const taskResults = require('./fleet-task-results');
const { decidingRows, projectRecovery, quiesceCancellation } = require('./fleet-v5-recovery');
const { projectOperationalObservation, workforceProjection } = require('./fleet-v5-measurements');
const contractReview = require('./fleet-v5-review');
const catalogLib = require('./fleet-v5-catalog');
const determinacyLib = require('./fleet-v5-determinacy');
const verification = require('./fleet-contract-verification');
const recordParts = require('./fleet-v5-record-parts');

const NAMESPACE = 'fleet.v5.contracts';
const KEY_PREFIX = 'submission-';
function error(code, message) { throw Object.assign(new Error(message), { code }); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function json(value) { return JSON.stringify(value); }
function assertObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) error('FLEET_V5_CONTRACT_INVALID', `${field} must be an object.`);
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function contractDigest(contract) { return hash(stable(contract)); }
function keyFor(idempotencyKey) { return KEY_PREFIX + hash(idempotencyKey); }
const MAX_INSPECT_WAIT_MS = 600000;
const INSPECT_POLL_MS = 250;
// A retained record can outgrow one Fleet memory value (reports, amendments).
// Its large subtrees then move to immutable content-addressed part entries and
// the record entry lists their paths; nothing is dropped or truncated.
const PART_KEY_PREFIX = 'part-';
const PART_BYTES = 24 * 1024;
const INLINE_BYTES = 1024;
function jsonBytes(value) { return Buffer.byteLength(json(value), 'utf8'); }
function textChunks(text) {
  const chunks = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + PART_BYTES);
    while (jsonBytes(text.slice(start, end)) > PART_BYTES) end = start + Math.floor((end - start) / 2);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
    chunks.push(text.slice(start, end)); start = end;
  }
  return chunks;
}
function packRecord(record) {
  const parts = new Map(), storageParts = [];
  const put = value => { const key = PART_KEY_PREFIX + hash(json(value)); parts.set(key, value); return key; };
  function visit(value, path) {
    if (jsonBytes(value) <= PART_BYTES) return value;
    if (typeof value === 'string') { storageParts.push({ path, text: textChunks(value).map(put) }); return null; }
    if (!value || typeof value !== 'object') return value;
    const copy = Array.isArray(value) ? [...value] : { ...value };
    for (const key of Object.keys(copy)) copy[key] = visit(copy[key], [...path, Array.isArray(copy) ? Number(key) : key]);
    const largest = Object.keys(copy).filter(key => copy[key] !== null && jsonBytes(copy[key]) > INLINE_BYTES)
      .sort((a, b) => jsonBytes(copy[b]) - jsonBytes(copy[a]));
    for (const key of largest) {
      if (path.length && jsonBytes(copy) <= PART_BYTES) break;
      storageParts.push({ path: [...path, Array.isArray(copy) ? Number(key) : key], part: put(copy[key]) }); copy[key] = null;
    }
    return copy;
  }
  return { main: { ...visit(record, []), storageParts }, parts };
}
function recordView(record) { return structuredClone(record); }
// Alpha.12 measures the retained contract body with JSON.stringify against one
// memory value. The review is part of the record and of the part store; it is
// not part of that body measurement. Callers read record.review.
function presentRecord(record) {
  if (record?.review && typeof record.review === 'object' && !Array.isArray(record.review)) {
    Object.defineProperty(record.review, 'toJSON', { configurable: true, enumerable: false, value: () => undefined });
  }
  return record;
}
function reviewForStorage(record) {
  if (record?.review && typeof record.review.toJSON === 'function') record.review = { ...record.review };
  return record;
}
function mergeById(...lists) {
  const rows = new Map();
  for (const list of lists) for (const row of list || []) {
    const previous = rows.get(row.id);
    if (previous && stable(previous) !== stable(row))
      error('FLEET_V5_REQUIREMENT_ID_CONFLICT', `Requirement ID ${row.id} already exists with different content; use a new ID so prior scope and checks remain retained.`);
    rows.set(row.id, row);
  }
  return [...rows.values()];
}
function normalizedRequirements(contract, workspaceRoot = null) {
  const base = taskResults.requirements(contract.requirements || {});
  const suppliedRaw = { scope: typeof contract.scope === 'string' ? contract.scope : contract.scope?.prompt };
  if (workspaceRoot) suppliedRaw.workspaceRoot = workspaceRoot;
  for (const field of ['inputs', 'outputs', 'checks']) if (contract[field] !== undefined) suppliedRaw[field] = contract[field];
  if (Array.isArray(suppliedRaw.checks)) suppliedRaw.checks = withoutCovers(suppliedRaw.checks);
  const supplied = taskResults.requirements(suppliedRaw);
  const criterion = typeof contract.definitionOfDone === 'string' && contract.definitionOfDone.trim()
    ? `\nDefinition of done: ${contract.definitionOfDone.trim()}` : '';
  const declaredScope = typeof base.scope === 'string' && base.scope !== supplied.scope
    ? `${supplied.scope}\nAdditional authorized requirements scope: ${base.scope}${criterion}` : `${supplied.scope}${criterion}`;
  return taskResults.requirements({ scope: declaredScope,
    inputs: mergeById(base.inputs, supplied.inputs),
    outputs: mergeById(base.outputs, supplied.outputs),
    checks: mergeById(base.checks, supplied.checks) });
}

// checks[].covers names the expectations a check proves. It is review data:
// Fleet's native check record and what Fleet runs stay exactly as before.
function withoutCovers(checks) {
  return checks.map(check => {
    if (!check || typeof check !== 'object' || Array.isArray(check) || !('covers' in check)) return check;
    const { covers: _covers, ...rest } = check;
    return rest;
  });
}
function validateReviewFields(contract) {
  for (const [field, required] of [['expectations', ['id', 'text']], ['variance', ['id', 'choice']]]) {
    if (contract[field] === undefined) continue;
    if (!Array.isArray(contract[field]) || contract[field].some(item => !item || typeof item !== 'object' || Array.isArray(item)
        || required.some(key => typeof item[key] !== 'string' || !item[key].trim())))
      error('FLEET_V5_CONTRACT_INVALID', `${field} must be a list of objects with nonempty ${required.join(' and ')}.`);
    const ids = contract[field].map(item => item.id);
    if (new Set(ids).size !== ids.length) error('FLEET_V5_CONTRACT_INVALID', `${field} repeats an id.`);
  }
  for (const check of Array.isArray(contract.checks) ? contract.checks : [])
    if (check && typeof check === 'object' && check.covers !== undefined
        && (!Array.isArray(check.covers) || check.covers.some(id => typeof id !== 'string' || !id)))
      error('FLEET_V5_CONTRACT_INVALID', 'checks[].covers must be a list of expectation IDs.');
  // determinacy is review data too: only its shape is checked here. Each
  // mutant is judged when it runs, and a bad one is reported there as invalid.
  const determinacy = contract.determinacy;
  if (determinacy !== undefined && (!determinacy || typeof determinacy !== 'object' || Array.isArray(determinacy)
      || Object.keys(determinacy).some(key => key !== 'mutants')
      || !(determinacy.mutants === 'worker' || (Array.isArray(determinacy.mutants)
        && determinacy.mutants.every(item => item && typeof item === 'object' && !Array.isArray(item))))))
    error('FLEET_V5_CONTRACT_INVALID', 'determinacy must be {mutants: "worker"} or {mutants: [{id, omits, why, files}]}.');
}
// A composed contract is compiled before anything else. An invalid
// composition, malformed snippet reviews, or a compiled check or rule id that
// collides with the lead's own is refused before any Fleet request.
function compiledComposition(contract) {
  if (contract.compose === undefined) return null;
  const refuse = message => error('FLEET_V5_COMPOSITION_INVALID', message);
  if (contract.reviews !== undefined && (!Array.isArray(contract.reviews) || contract.reviews.some(row => !row || typeof row !== 'object'
      || Array.isArray(row) || typeof row.bundleId !== 'string' || typeof row.sha256 !== 'string')))
    refuse('reviews must be a list of {bundleId, sha256, reviewer, at, decision?} snippet review records.');
  const compiled = catalogLib.compileContract({ catalog: contract.catalog, compose: contract.compose });
  if (compiled.status !== 'compiled')
    refuse(`The composition does not compile: ${compiled.problems.map(item => `${item.code}: ${item.message}`).join(' ')}`);
  const leadChecks = new Set([...(Array.isArray(contract.checks) ? contract.checks : []),
    ...(Array.isArray(contract.requirements?.checks) ? contract.requirements.checks : [])].map(check => check?.id));
  const checkClash = [...compiled.checks, ...compiled.tasks.flatMap(task => task.checks)].filter(check => leadChecks.has(check.id)).map(check => check.id);
  const ruleClash = Object.keys(compiled.rules).filter(id => contract.rules && typeof contract.rules === 'object' && Object.hasOwn(contract.rules, id));
  if (checkClash.length || ruleClash.length)
    refuse(`Compiled snippet ids collide with the contract's own: ${[...checkClash.map(id => `check ${id}`), ...ruleClash.map(id => `rule ${id}`)].join(', ')}. Rename the contract's check or rule.`);
  return compiled;
}
// What Fleet receives for a composed contract: the objective, a blank line and
// the compiled text; the lead's checks, rules and variance merged with the
// compiled ones.
function composedWork(contract, compiled) {
  if (!compiled) return { contract, rules: contract.rules };
  const variance = [...(Array.isArray(contract.variance) ? contract.variance : []),
    ...compiled.variance.map(item => ({ id: item.id, choice: item.choice.replace(/\.\s*$/, ''), allowed: item.allowed.join(', ') }))];
  const checks = [...(Array.isArray(contract.checks) ? contract.checks : []), ...compiled.checks];
  const rules = { ...(contract.rules || {}), ...compiled.rules };
  return { contract: { ...contract, objective: `${contract.objective}\n\n${compiled.text}`, ...(checks.length ? { checks } : {}),
    ...(variance.length ? { variance } : {}) }, rules: Object.keys(rules).length || contract.rules ? rules : undefined };
}
// A job written as task snippets is one native work item per task, in node
// order, so Fleet tracks and verifies each task on its own. Every item keeps
// the contract's scope and inputs and carries its task's completion checks;
// the contract's own checks and outputs go on the last item.
function taskWorkItems(contract, compiled, before, requirements) {
  const { checks: contractChecks, outputs, ...shared } = requirements;
  let texts;
  try { texts = contractReview.taskWorkTexts(contract, before, compiled); }
  catch { texts = compiled.tasks.map(task => task.text); }
  return compiled.tasks.map((task, index) => {
    const last = index === compiled.tasks.length - 1;
    const checks = [...withoutCovers(task.checks), ...(last ? contractChecks || [] : [])];
    return { text: texts[index], requirements: taskResults.requirements({ ...shared,
      ...(last && outputs ? { outputs } : {}), ...(checks.length ? { checks } : {}) }) };
  });
}
// resolves names open points (op-N), the units they are on (objective:2,
// done:1, ...) or, for a composed contract, requirement ids
// (root/part-N/...#bundle-id) of its composition.
function validateResolves(resolves, record) {
  if (resolves === undefined) return [];
  const composed = Boolean(record.composition);
  if (!Array.isArray(resolves) || resolves.some(id => typeof id !== 'string' || !id))
    error('FLEET_V5_RESOLVES_INVALID', composed ? 'resolves must be a list of open point IDs such as op-1, or requirement IDs of the composition.'
      : 'resolves must be a list of open point IDs such as op-1, or the units they are on.');
  const known = new Set([...(record.review?.before?.openPoints || []).flatMap(point => [point.id, point.unitId]),
    ...(record.composition?.checklist || []).filter(row => row.path !== 'root').map(row => row.requirementId)]);
  const unknown = resolves.filter(id => !known.has(id));
  if (unknown.length) error('FLEET_V5_RESOLVES_INVALID', composed ? `resolves names open points or requirement ids this contract does not have: ${unknown.join(', ')}.`
    : `resolves names open points this contract's review does not have: ${unknown.join(', ')}.`);
  return [...new Set(resolves)];
}
function reviewEvents(record) { return Array.isArray(record.review?.events) ? record.review.events : []; }
function withEvent(record, event, same) {
  if (!record.review) return record;
  if (reviewEvents(record).some(same)) return record;
  return { ...record, review: { ...record.review, events: [...reviewEvents(record), event] } };
}
function answerEvent(operation, at) {
  return { type: 'answer', askId: operation.askId, answerDigest: operation.answerDigest, taskRevision: operation.taskRevision,
    resolves: [...(operation.resolves || [])], at };
}
function amendmentEvent(amendment) {
  return { type: 'amendment', revision: amendment.revision, marker: amendment.marker, ruleKeys: Object.keys(amendment.patch?.rules || {}),
    fields: Object.keys(amendment.patch || {}), resolves: [...(amendment.resolves || [])], at: amendment.at };
}
// An answer that resolves an open point also links the ask it answers.
function recordAnswer(record, operation, at) {
  let next = withEvent(record, answerEvent(operation, at),
    event => event.type === 'answer' && event.askId === operation.askId && event.answerDigest === operation.answerDigest);
  if (!next.review || !(operation.resolves || []).length) return next;
  const events = reviewEvents(next);
  const hasAsk = events.some(event => event.type === 'ask' && event.askId === operation.askId);
  const linked = hasAsk ? events.map(event => event.type === 'ask' && event.askId === operation.askId
    ? { ...event, resolves: [...new Set([...(event.resolves || []), ...operation.resolves])] } : event)
    : [...events, { type: 'ask', askId: operation.askId, taskRevision: operation.taskRevision, resolves: [...operation.resolves], at }];
  return { ...next, review: { ...next.review, events: linked } };
}

function normalizedRequirementPatch(patch, fallbackScope) {
  const nested = taskResults.requirements(patch.requirements || {});
  const topRaw = { scope: fallbackScope };
  for (const field of ['inputs', 'outputs', 'checks']) if (patch[field] !== undefined) topRaw[field] = patch[field];
  if (Array.isArray(topRaw.checks)) topRaw.checks = withoutCovers(topRaw.checks);
  const top = taskResults.requirements(topRaw);
  const nestedScope = nested.scope;
  return taskResults.requirements({
    ...(nestedScope ? { scope: nestedScope } : top.scope ? { scope: top.scope } : {}),
    inputs: mergeById(nested.inputs, top.inputs),
    outputs: mergeById(nested.outputs, top.outputs),
    checks: mergeById(nested.checks, top.checks)
  });
}

function normalizeScope(scope) {
  if (typeof scope === 'string' && scope.trim()) return { prompt: scope.trim(), folder: null };
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)
      || scope.mode !== 'folder' || scope.access !== 'read-write'
      || typeof scope.folder !== 'string' || !scope.folder.trim()
      || typeof scope.prompt !== 'string' || !scope.prompt.trim())
    error('FLEET_V5_SCOPE_INVALID', 'scope must be descriptive text or the native {mode:"folder",access:"read-write",folder,prompt} shape.');
  return { prompt: scope.prompt.trim(), folder: scope.folder };
}
function normalizedResourceLimits(value = {}) {
  assertObject(value, 'resourceLimits');
  const unsupported = Object.keys(value).filter(key => key !== 'maxAgents');
  if (unsupported.length) error('FLEET_V5_RESOURCE_LIMIT_UNSUPPORTED', `Fleet V5 cannot enforce these resource limit dimensions before execution: ${unsupported.join(', ')}.`);
  if (value.maxAgents !== undefined && (!Number.isSafeInteger(value.maxAgents) || value.maxAgents < 1))
    error('FLEET_V5_RESOURCE_LIMIT_INVALID', 'resourceLimits.maxAgents must be a positive whole number.');
  return structuredClone(value);
}
function validateRules(rules) {
  if (rules === undefined) return {};
  assertObject(rules, 'rules');
  for (const [id, text] of Object.entries(rules))
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || typeof text !== 'string' || !text.trim())
      error('FLEET_V5_RULES_INVALID', 'Rules must map bounded lowercase rule IDs to nonempty text.');
  return structuredClone(rules);
}
function baselineId(resolved, policy = {}) {
  if (policy.baselineConfiguration !== undefined) {
    const matches = (resolved?.candidates || []).filter(candidate => stable(candidate.configuration) === stable(policy.baselineConfiguration));
    if (matches.length !== 1)
      error('FLEET_V5_BASELINE_CONFIGURATION_INVALID', 'policy.baselineConfiguration must match exactly one current whole configuration.');
    if (policy.baselineCandidateId !== undefined && policy.baselineCandidateId !== matches[0].id)
      error('FLEET_V5_BASELINE_CONFIGURATION_CONFLICT', 'The configured baseline ID and whole configuration identify different choices.');
    return matches[0].id;
  }
  if (typeof policy.baselineCandidateId === 'string') return policy.baselineCandidateId;
  if (typeof resolved?.baselineCandidateId === 'string') return resolved.baselineCandidateId;
  if (typeof resolved?.baseline?.candidateId === 'string') return resolved.baseline.candidateId;
  const marked = (resolved?.candidates || []).filter(candidate => candidate.baseline === true || candidate.supply?.configuredBaseline === true);
  if (marked.length === 1) return marked[0].id;
  return marked.length === 0 && resolved?.candidates?.length === 1 ? resolved.candidates[0].id : null;
}
function currentControlRevision(result, expectedControlRevision, action) {
  if (!Number.isSafeInteger(result?.revision) || result.revision < 0)
    error('FLEET_V5_CONTROL_REVISION_UNKNOWN', `Fleet did not provide the current control revision for ${action}.`);
  if (expectedControlRevision !== undefined && result.revision !== expectedControlRevision)
    error('FLEET_V5_STALE_CONTROL_REVISION', `Fleet control changed before ${action}; no operation was started.`);
  return result.revision;
}
function workforceMemberView(record, workers) {
  if (!record.selection?.workforce) return { status: 'not-configured', members: [] };
  const rows = Array.isArray(workers) ? workers : Array.isArray(workers?.items) ? workers.items : null;
  const page = Array.isArray(workers) ? null : workers?.page;
  const pageComplete = !page || Number.isSafeInteger(page.offset) && page.offset === 0
    && Number.isSafeInteger(page.total) && Number.isSafeInteger(page.returned) && page.returned === page.total;
  if (!rows || !pageComplete) return { status: 'unknown', members: [], memberCount: null };
  const members = rows.filter(row => row?.workforceMembership?.contractId === record.contractId
    && typeof row.nodeId === 'string');
  if (!members.some(row => row.nodeId === record.execution?.nodeId))
    return { status: 'unknown', members: [], memberCount: null };
  const allowedStates = new Set(['starting', 'running', 'paused', 'stopped', 'completed', 'held', 'failed', 'removed']);
  const safe = members.map(row => ({ nodeId: row.nodeId, parentNodeId: row.parentNodeId || null,
    state: allowedStates.has(row.state) ? row.state : 'unknown',
    turn: ['idle', 'running', 'waiting', 'stopped'].includes(row.turn) ? row.turn : 'unknown',
    role: typeof row.role === 'string' ? row.role : null,
    provider: typeof row.provider === 'string' ? row.provider : null
  })).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  return { status: 'measured', memberCount: safe.length, maximumAgents: record.selection.workforce.maxAgents,
    minimumAgents: record.selection.minimumAgents ?? (record.selection.workforce.topology === 'solo' ? 1 : null), members: safe };
}
function cleanupLifecycleView(workers, nodeId) {
  const rows = Array.isArray(workers) ? workers : Array.isArray(workers?.items) ? workers.items : null;
  const page = Array.isArray(workers) ? null : workers?.page;
  const pageComplete = !page || Number.isSafeInteger(page.offset) && page.offset === 0
    && Number.isSafeInteger(page.total) && Number.isSafeInteger(page.returned) && page.returned === page.total;
  const node = pageComplete ? rows?.find(row => row?.nodeId === nodeId) : null;
  const state = typeof node?.state === 'string' ? node.state : null;
  const turn = typeof node?.turn === 'string' ? node.turn : null;
  const status = state === 'running' && turn === 'idle' ? 'retained-idle'
    : state === 'starting' || state === 'running' && ['running', 'waiting'].includes(turn) ? 'active' : 'unknown';
  return { status, source: 'Fleet worker snapshot', workerState: state, turn,
    remainingProcesses: null, remainingTokens: null };
}
function accountUsageView(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {
    outcome: value.outcome === 'observed' ? 'observed' : 'unavailable',
    usageKnown: value.usageKnown === true,
  };
  const window = row => row && typeof row === 'object' && Number.isFinite(row.usedPercent)
    && row.usedPercent >= 0 && row.usedPercent <= 100
    ? { usedPercent: row.usedPercent, resetsAt: typeof row.resetsAt === 'string' && Number.isFinite(Date.parse(row.resetsAt)) ? row.resetsAt : null }
    : null;
  if (value.windows && typeof value.windows === 'object' && !Array.isArray(value.windows)) {
    result.windows = {};
    for (const [name, row] of Object.entries(value.windows))
      if (/^(five_hour|seven_day(?:_.*)?)$/.test(name) && name !== 'seven_day_breakdown') result.windows[name] = window(row);
  }
  if (value.fiveHour !== undefined) result.fiveHour = window(value.fiveHour);
  if (value.sevenDay !== undefined) result.sevenDay = window(value.sevenDay);
  if (typeof value.hasExtraUsageEnabled === 'boolean' || value.hasExtraUsageEnabled === null)
    result.hasExtraUsageEnabled = value.hasExtraUsageEnabled;
  if (value.extraUsage && typeof value.extraUsage === 'object') {
    const balance = item => typeof item === 'number' && Number.isFinite(item) && item >= 0 ? item : null;
    result.extraUsage = {
      isEnabled: typeof value.extraUsage.isEnabled === 'boolean' ? value.extraUsage.isEnabled : null,
      monthlyLimit: balance(value.extraUsage.monthlyLimit), usedCredits: balance(value.extraUsage.usedCredits),
    };
  }
  if (value.credits && typeof value.credits === 'object') {
    const balance = value.credits.balance;
    result.credits = {
      hasCredits: typeof value.credits.hasCredits === 'boolean' ? value.credits.hasCredits : null,
      unlimited: typeof value.credits.unlimited === 'boolean' ? value.credits.unlimited : null,
      balance: typeof balance === 'number' && Number.isFinite(balance) && balance >= 0 ? balance : null,
    };
  } else if (value.credits === null) result.credits = null;
  if (typeof value.providerAllowed === 'boolean' || value.providerAllowed === null) result.providerAllowed = value.providerAllowed;
  if (typeof value.providerLimitReached === 'boolean' || value.providerLimitReached === null)
    result.providerLimitReached = value.providerLimitReached;
  return result;
}
function safeResumeReceipt(resume) {
  const result = {};
  for (const key of ['resumed', 'replay']) if (typeof resume?.[key] === 'boolean') result[key] = resume[key];
  for (const key of ['code', 'reason']) if (typeof resume?.[key] === 'string') result[key] = resume[key];
  if (resume?.attempt && typeof resume.attempt === 'object') {
    const attempt = {};
    for (const key of ['state', 'taskRevision', 'at', 'finishedAt', 'code', 'reason'])
      if (resume.attempt[key] !== undefined) attempt[key] = resume.attempt[key];
    result.attempt = attempt;
  }
  return result;
}
function safeContractText(value, maximum = 12000) {
  const redactor = require('./agent-engine/stream-redactor').createEnvironmentRedactor(process.env);
  const redacted = redactor.write(String(value ?? '')) + redactor.end();
  return require('./audit').scrubText(redacted, maximum);
}
function nonemptyText(value) { return typeof value === 'string' && value.trim() ? value : null; }
function configurationEffort(configuration) { return nonemptyText(configuration?.vendorEffort); }
function configurationCeiling(configuration) {
  for (const value of [configuration?.maxAgents, configuration?.workforce?.maxAgents, configuration?.agentCount])
    if (Number.isSafeInteger(value) && value >= 1) return value;
  return null;
}
function configurationAllowsTeam(configuration) {
  if (configuration?.workforce?.topology === 'adaptive') return true;
  if (Number.isSafeInteger(configuration?.agentCount) && configuration.agentCount > 1) return true;
  return Number.isSafeInteger(configuration?.maxAgents) && configuration.maxAgents > 1 && configuration?.workforce?.topology !== 'solo';
}
function providerAccount(defaults, provider, rows) {
  let account = defaults.get(provider) || null;
  const named = new Set();
  for (const row of rows) {
    const value = nonemptyText(row?.supply?.account) || nonemptyText(row?.configuration?.account);
    if (value) named.add(value);
  }
  if (named.size > 1) return null;
  if (named.size === 1) {
    const only = [...named][0];
    return account === null || account === only ? only : null;
  }
  return account;
}
function summarizeProviders(candidates, defaults) {
  const groups = new Map();
  for (const candidate of candidates) {
    const configuration = candidate.configuration;
    const provider = nonemptyText(configuration?.provider);
    if (!provider) continue;
    let group = groups.get(provider);
    if (!group) {
      group = { provider, rows: [], models: new Map(), team: false, maxAgents: null };
      groups.set(provider, group);
    }
    group.rows.push(candidate);
    if (configurationAllowsTeam(configuration)) group.team = true;
    const ceiling = configurationCeiling(configuration);
    if (ceiling !== null) group.maxAgents = group.maxAgents === null ? ceiling : Math.max(group.maxAgents, ceiling);
    const model = nonemptyText(configuration.model) || '';
    let efforts = group.models.get(model);
    if (!efforts) { efforts = new Set(); group.models.set(model, efforts); }
    const effort = configurationEffort(configuration);
    if (effort) efforts.add(effort);
  }
  return [...groups.keys()].sort((left, right) => left.localeCompare(right)).map(provider => {
    const group = groups.get(provider);
    return {
      provider, account: providerAccount(defaults, provider, group.rows), team: group.team, maxAgents: group.maxAgents,
      models: [...group.models.keys()].sort((left, right) => left.localeCompare(right)).map(model => ({
        model: model || null, efforts: [...group.models.get(model)].sort((left, right) => left.localeCompare(right))
      }))
    };
  });
}

/**
 * Production adapter over Fleet's existing control plane.
 *
 * Exports: createFleetV5Contracts({store, control, capabilities, selector?, reviewer?, now?})
 * -> {options, review, library, submit, inspect, determinacy, answer, amend, cancel}.
 *
 * Contract: {objective, scope, rules?, inputs?, definitionOfDone?, checks?,
 * productEffort?, userEffort?, provider?, model?, resourceLimits?, policy?,
 * expectations?, variance?, determinacy?, compose?, catalog?, reviews?}. compose is compiled
 * by fleet-v5-catalog.js: Fleet receives the objective, a blank line and the
 * compiled text, the merged checks and rules, and the record keeps
 * composition {promptSha256, compositionSha256, checklist, bundles}; catalog
 * and reviews accompany compose and are refused without it, as before.
 * Persisted schema `ai.toolsenabled/fleet-v5-contract/v1`:
 * {contractId,idempotencyKey,inputDigest,revision,status,contract,
 * selection,selectionReceipt,execution,reportedOutcome,checkedOutcome,
 * operation,review,createdAt,updatedAt}. `execution` references the existing Fleet
 * job. `review` holds {before, events, after?, determinacy?} from fleet-v5-review
 * and fleet-v5-determinacy; it is
 * feedback only and never refuses or changes a submission beyond the assignment text. Status `unknown` is terminal for automatic replay and requires inspection.
 */
function createFleetV5Contracts({ store, control, capabilities, selector = selectConfiguration, listWorkers,
  authorizeWorkspace, reviewer = contractReview.reviewContract,
  now = () => new Date().toISOString() } = {}) {
  if (!store || typeof store.getMemory !== 'function' || typeof store.setMemory !== 'function')
    throw new TypeError('Fleet V5 contracts require the transactional Fleet StateStore.');
  if (!control || typeof control.request !== 'function') throw new TypeError('Fleet V5 contracts require the existing Fleet control request adapter.');
  if (!capabilities || typeof capabilities.candidates !== 'function' || typeof capabilities.apply !== 'function')
    throw new TypeError('Fleet V5 contracts require the current capability resolver candidates/apply seam.');
  if (authorizeWorkspace === undefined) authorizeWorkspace = capabilities.authorizeWorkspace;

  function unpack(value) {
    if (!Array.isArray(value?.storageParts)) return value;
    const { storageParts, ...record } = value;
    const part = key => {
      const row = store.getMemory({ namespace: NAMESPACE, key });
      if (!row) error('FLEET_V5_CONTRACT_PART_MISSING', 'A retained Fleet V5 contract part is missing; the record is not complete.');
      return row.value;
    };
    for (const entry of [...storageParts].sort((a, b) => a.path.length - b.path.length)) {
      const parent = entry.path.slice(0, -1).reduce((target, step) => target[step], record);
      parent[entry.path.at(-1)] = entry.text ? entry.text.map(part).join('') : part(entry.part);
    }
    return record;
  }
  // A missing same-namespace part refuses the read. Those parts are the
  // alpha.12 layout (packRecord). They sit beside the contract-layer head,
  // which keeps review.before and any other field that does not fit in
  // fleet-v5-record-parts.js.
  function assertStorageParts(value) {
    if (!Array.isArray(value?.storageParts)) return;
    for (const entry of value.storageParts) {
      for (const partKey of entry.text || [entry.part]) {
        if (!store.getMemory({ namespace: NAMESPACE, key: partKey }))
          error('FLEET_V5_CONTRACT_PART_MISSING', 'A retained Fleet V5 contract part is missing; the record is not complete.');
      }
    }
  }
  function withoutStorageParts(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.storageParts)) return value;
    const { storageParts: _storageParts, ...logical } = value;
    return logical;
  }
  // A record is stored as a head under its key and parts (its review, and
  // its largest other fields when needed) apart, each value under Fleet's
  // 32 KB limit (fleet-v5-record-parts.js); read joins them again. A part
  // replaced while it was read is read again from the new head. An oversized
  // record also keeps content-addressed parts in the contract namespace so a
  // missing one still refuses with FLEET_V5_CONTRACT_PART_MISSING.
  function read(key) {
    for (let attempt = 1; ; attempt++) {
      const row = store.getMemory({ namespace: NAMESPACE, key });
      if (!row) return row;
      if (Array.isArray(row.value?.storageParts) && !row.value?.parts) return { ...row, value: unpack(row.value) };
      assertStorageParts(row.value);
      if (!row.value?.parts) return { ...row, value: withoutStorageParts(row.value) };
      try {
        const joined = recordParts.join(row.value, key, pieceKey => store.getMemory({ namespace: recordParts.PART_NAMESPACE, key: pieceKey })?.value);
        return { ...row, value: withoutStorageParts(joined) };
      } catch (cause) {
        if (cause?.code !== 'FLEET_V5_RECORD_PART_RELEASED' || attempt >= 3) throw cause;
      }
    }
  }
  function save(record, expectedRevision) {
    reviewForStorage(record);
    const key = keyFor(record.idempotencyKey);
    const previous = store.getMemory({ namespace: NAMESPACE, key });
    const revision = (expectedRevision ?? previous?.revision ?? 0) + 1;
    const { head, writes, release } = recordParts.split(record, key, { previous: previous?.value || null, revision });
    const { review: _review, ...contractBody } = record;
    const packed = packRecord(contractBody);
    const keptParts = new Set();
    for (const piece of writes) store.setMemory({ namespace: recordParts.PART_NAMESPACE, key: piece.key, value: piece.value,
      note: 'Part of a private Fleet V5 durable contract record.', tags: ['fleet-v5', 'contract-part'] });
    for (const [partKey, partValue] of packed.parts) {
      try {
        store.setMemory({ namespace: NAMESPACE, key: partKey, value: partValue,
          note: 'Part of a private Fleet V5 durable contract record.', tags: ['fleet-v5', 'contract-part'] });
        keptParts.add(partKey);
      } catch (cause) {
        if (cause?.code !== 'MEMORY_VALUE_TOO_LARGE') throw cause;
      }
    }
    const storageParts = packed.main.storageParts.filter(entry => (entry.text || [entry.part]).every(partKey => keptParts.has(partKey)));
    const storedHead = storageParts.length ? { ...head, storageParts } : head;
    let saved;
    try {
      saved = store.setMemory({ namespace: NAMESPACE, key, value: storedHead,
        note: 'Private Fleet V5 durable contract and selection receipt.', tags: ['fleet-v5', 'contract'], expectedRevision });
    } catch (cause) {
      // The store checks the whole value for credentials before its size.
      if (cause?.code !== 'MEMORY_VALUE_TOO_LARGE') throw cause;
      saved = store.setMemory({ namespace: NAMESPACE, key, value: packed.main,
        note: 'Private Fleet V5 durable contract and selection receipt.', tags: ['fleet-v5', 'contract'], expectedRevision });
    }
    if (!saved.replayed) for (const pieceKey of release) store.setMemory({ namespace: recordParts.PART_NAMESPACE, key: pieceKey,
      value: recordParts.RELEASED, note: 'Released part of a private Fleet V5 durable contract record.', tags: ['fleet-v5', 'contract-part'] });
    return JSON.parse(JSON.stringify(record));
  }
  function assertBaseline(resolved, policy) {
    const configured = baselineId(resolved, policy);
    if (policy.baselineCandidateId === undefined && configured) return { ...policy, baselineCandidateId: configured };
    if (!configured && policy.baselineCandidateId === undefined)
      error('FLEET_V5_BASELINE_UNCONFIGURED', 'The current computer resolver has no configured baseline; inspect fleet.contract.options or configure one before submitting.');
    return policy;
  }
  async function knownProviderAccounts() {
    const accounts = new Map();
    let read;
    try { read = await control.request({ action: 'account-read', limit: 100 }); }
    catch { return accounts; }
    const defaults = read?.defaults;
    if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) return accounts;
    for (const [key, route] of Object.entries(defaults)) {
      if (!route || typeof route !== 'object' || Array.isArray(route) || route.authentication === 'api-key') continue;
      const provider = nonemptyText(route.provider) || nonemptyText(key);
      const account = nonemptyText(route.account);
      if (provider && account) accounts.set(provider, account);
    }
    return accounts;
  }
  async function options({ request = {} } = {}) {
    assertObject(request, 'request');
    const supported = new Set(['provider', 'model', 'computerId', 'productEffort', 'userEffort', 'vendorEffort',
      'role', 'roles', 'workforce', 'resourceLimits', 'coordination', 'detail']);
    const unsupported = Object.keys(request).filter(key => !supported.has(key));
    if (unsupported.length) error('FLEET_V5_OPTIONS_REQUEST_UNSUPPORTED', `Configuration discovery does not accept these filters: ${unsupported.join(', ')}.`);
    if (request.detail !== undefined && typeof request.detail !== 'boolean')
      error('FLEET_V5_OPTIONS_REQUEST_INVALID', 'detail must be a boolean when supplied.');
    for (const field of ['computerId', 'provider', 'model', 'productEffort', 'userEffort', 'vendorEffort', 'role'])
      if (request[field] !== undefined && (typeof request[field] !== 'string' || !request[field].trim()))
        error('FLEET_V5_OPTIONS_REQUEST_INVALID', `${field} must be nonempty text when supplied.`);
    if (request.productEffort !== undefined && request.userEffort !== undefined
        && request.productEffort !== request.userEffort)
      error('FLEET_V5_EFFORT_CONFLICT', 'productEffort and its userEffort alias must agree.');
    if (request.roles !== undefined && (!Array.isArray(request.roles) || request.roles.length !== 1
        || request.roles.some(role => typeof role !== 'string' || !role.trim())))
      error('FLEET_V5_SETUP_UNSUPPORTED', 'roles may name only the guaranteed root role; use workforce.allowedRoles for descendant choices.');
    if (request.workforce !== undefined) {
      assertObject(request.workforce, 'workforce');
      const rootRole = request.role ?? request.workforce.rootRole ?? request.roles?.[0] ?? 'worker';
      if (request.role !== undefined && request.workforce.rootRole !== undefined && request.role !== request.workforce.rootRole)
        error('FLEET_V5_WORKFORCE_ROOT_ROLE_REFUSED', 'role and workforce.rootRole disagree.');
      if (request.roles !== undefined && request.roles[0] !== rootRole)
        error('FLEET_V5_SETUP_UNSUPPORTED', 'roles must identify the workforce root role.');
      if (request.resourceLimits?.maxAgents !== undefined && request.resourceLimits.maxAgents !== request.workforce.maxAgents)
        error('FLEET_V5_WORKFORCE_INVALID', 'resourceLimits.maxAgents and workforce.maxAgents must agree.');
      if (request.coordination !== undefined && request.workforce.coordination !== undefined
          && stable(request.coordination) !== stable(request.workforce.coordination))
        error('FLEET_V5_WORKFORCE_INVALID', 'coordination and workforce.coordination must agree.');
      require('./fleet-v5-workforce').normalize({ ...request.workforce, rootRole }, { contractId: 'v5-options-preview' });
    }
    if (request.resourceLimits !== undefined) normalizedResourceLimits(request.resourceLimits);
    if (request.coordination !== undefined) assertObject(request.coordination, 'coordination');
    const discovery = { ...request };
    delete discovery.detail;
    const resolved = await capabilities.candidates({ contract: structuredClone(discovery) });
    if (!resolved || !Array.isArray(resolved.candidates))
      error('FLEET_V5_CAPABILITY_RESOLUTION_UNKNOWN', 'The current capability resolver did not provide configuration options.');
    if (resolved.candidates.some(candidate => !candidate || typeof candidate.id !== 'string' || !candidate.configuration
        || typeof candidate.configuration !== 'object' || Array.isArray(candidate.configuration))
        || new Set(resolved.candidates.map(candidate => candidate.id)).size !== resolved.candidates.length)
      error('FLEET_V5_CAPABILITY_RESOLUTION_INVALID', 'The current capability resolver returned malformed or duplicate configuration choices.');
    const configuredBaselineId = baselineId(resolved);
    const [accounts, configurations] = await Promise.all([
      knownProviderAccounts(),
      Promise.all(resolved.candidates.map(async candidate => {
        const eligibility = resolved.eligible ? await resolved.eligible(candidate, discovery) : candidate.supply?.currentlyEligible;
        const supply = operationalSupplyMetadata(candidate.supply);
        return { configuration: structuredClone(candidate.configuration), supply: supply.fields, excludedSupplyFields: supply.excludedFields,
          currentlyEligible: typeof eligibility === 'boolean' ? eligibility : null,
          configuredBaseline: candidate.id === configuredBaselineId };
      }))
    ]);
    const answer = { schema: 'ai.toolsenabled/fleet-v5-options/v1',
      baselineConfiguration: structuredClone(resolved.candidates.find(candidate => candidate.id === configuredBaselineId)?.configuration ?? null),
      baselineConfigured: configuredBaselineId !== null,
      providers: summarizeProviders(resolved.candidates, accounts) };
    if (request.detail === true || request.detail === undefined && Object.keys(discovery).length > 0) answer.configurations = configurations;
    return answer;
  }
  // The before view of a contract exactly as the lead supplied it. A reviewer
  // failure is reported as an unavailable review, never as a refusal.
  async function beforeView(contract) {
    try {
      const view = await reviewer(structuredClone(contract));
      if (!view || typeof view !== 'object' || Array.isArray(view)) throw new Error('The reviewer returned no review.');
      return structuredClone(view);
    } catch (cause) {
      return { schema: contractReview.REVIEW_SCHEMA, status: 'unavailable', code: cause?.code || 'FLEET_V5_REVIEW_UNAVAILABLE' };
    }
  }
  function assignmentText(contract, view) {
    try { return contractReview.workText(contract, view); } catch { return contract.objective; }
  }
  // Every retained contract record, in store order.
  function records() {
    return store.memoryKeys({ namespace: NAMESPACE }).map(key => read(key)?.value)
      .filter(value => value && typeof value === 'object' && typeof value.contractId === 'string');
  }
  // The snippet library: built-ins and lead bundles from every retained
  // contract, with the jobs that used each exact bundle and the ambiguity
  // events attributed to it; events on prose count as uncomposed.
  function libraryStats() {
    const bundles = new Map();
    const add = (bundle, sha256, source) => {
      const key = `${bundle.id}@${sha256}`;
      if (!bundles.has(key)) bundles.set(key, { bundle, sha256, source, jobs: 0, events: 0 });
      return bundles.get(key);
    };
    for (const row of catalogLib.catalogBundles()) add(row.bundle, row.sha256, row.source);
    const uncomposed = { jobs: 0, units: 0, events: 0 };
    for (const record of records()) {
      if (Array.isArray(record.contract?.catalog) && record.contract?.compose !== undefined)
        for (const row of catalogLib.catalogBundles(record.contract.catalog)) add(row.bundle, row.sha256, row.source);
      for (const used of record.composition?.bundles || []) {
        const entry = bundles.get(`${used.id}@${used.sha256}`);
        if (entry) entry.jobs += 1;
      }
      const composedIds = new Set((record.composition?.checklist || []).map(row => row.requirementId));
      const inferred = (record.review?.before?.units || []).filter(unit => !composedIds.has(unit.id)).length;
      if (inferred) { uncomposed.jobs += 1; uncomposed.units += inferred; }
      for (const row of contractReview.attributeEvents(record.review?.before, record.review?.events, record.composition)) {
        for (const bundle of row.bundles) { const entry = bundles.get(`${bundle.bundleId}@${bundle.sha256}`); if (entry) entry.events += 1; }
        if (row.uncomposed) uncomposed.events += 1;
      }
    }
    return { bundles, uncomposed };
  }
  async function library({ search, label } = {}) {
    for (const [field, value] of [['search', search], ['label', label]])
      if (value !== undefined && typeof value !== 'string') error('FLEET_V5_LIBRARY_INVALID', `${field} must be text when supplied.`);
    const query = String(search || '').trim().toLowerCase();
    const category = String(label || '').trim().toLowerCase();
    const stats = libraryStats();
    const rows = [...stats.bundles.values()].filter(({ bundle }) => {
      const labels = Array.isArray(bundle.labels) ? bundle.labels.filter(item => typeof item === 'string') : [];
      if (category && !labels.some(item => item.trim().toLowerCase() === category)) return false;
      return !query || [bundle.id, bundle.text, ...labels].some(value => typeof value === 'string' && value.toLowerCase().includes(query));
    }).sort((a, b) => a.bundle.id.localeCompare(b.bundle.id) || (a.source === b.source ? 0 : a.source === 'builtin' ? -1 : 1)
      || a.sha256.localeCompare(b.sha256));
    return { format: 'fleet-v5-contract-library', version: 1,
      bundles: rows.map(({ bundle, sha256, source, jobs, events }) => ({ id: bundle.id, version: bundle.version, sha256,
        kind: bundle.kind, role: bundle.role || 'node', labels: Array.isArray(bundle.labels) ? [...bundle.labels] : [], text: bundle.text,
        parameters: structuredClone(bundle.parameters || {}), parameterSchema: structuredClone(bundle.parameterSchema || {}),
        semantics: structuredClone(bundle.semantics || { kind: 'prompt' }), source, jobs, events })),
      uncomposed: { ...stats.uncomposed } };
  }
  async function review({ contract } = {}) {
    assertObject(contract, 'contract');
    const view = await beforeView(contract);
    if (contract.compose === undefined) return view;
    const compiled = catalogLib.compileContract({ catalog: contract.catalog, compose: contract.compose });
    const stats = compiled.status === 'compiled' ? libraryStats() : null;
    return { ...view, library: compiled.bundles.map(bundle => {
      const entry = stats.bundles.get(`${bundle.id}@${bundle.sha256}`);
      return { id: bundle.id, version: bundle.version, sha256: bundle.sha256, jobs: entry?.jobs || 0, events: entry?.events || 0 };
    }) };
  }
  async function submit({ contract, idempotencyKey } = {}) {
    assertObject(contract, 'contract');
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(idempotencyKey))
      error('FLEET_V5_IDEMPOTENCY_KEY_INVALID', 'A stable idempotencyKey is required.');
    if (typeof contract.objective !== 'string' || !contract.objective.trim())
      error('FLEET_V5_CONTRACT_INVALID', 'objective and authorized scope are required.');
    const scope = normalizeScope(contract.scope);
    const authorizedWorkspace = scope.folder === null ? null
      : typeof authorizeWorkspace === 'function' ? await authorizeWorkspace(scope.folder) : null;
    if (scope.folder !== null && (!authorizedWorkspace || authorizedWorkspace !== scope.folder))
      error('FLEET_V5_WORKSPACE_REFUSED', 'The requested workspace is not the exact current native workspace authorized by Fleet.');
    for (const field of ['computerId', 'provider', 'model', 'productEffort', 'userEffort', 'vendorEffort'])
      if (contract[field] !== undefined && (typeof contract[field] !== 'string' || !contract[field].trim())) error('FLEET_V5_CONTRACT_INVALID', `${field} must be nonempty text when supplied.`);
    if (contract.productEffort !== undefined && contract.userEffort !== undefined
        && contract.productEffort !== contract.userEffort)
      error('FLEET_V5_EFFORT_CONFLICT', 'productEffort and its userEffort alias must agree.');
    const supportedFields = new Set(['objective', 'scope', 'rules', 'inputs', 'outputs', 'checks', 'definitionOfDone', 'requirements',
      'computerId', 'workforce', 'role', 'roles', 'coordination',
      'provider', 'model', 'productEffort', 'userEffort', 'vendorEffort', 'resourceLimits', 'constraints', 'policy', 'expectedControlRevision',
      'expectations', 'variance', 'determinacy', 'compose', ...(contract.compose !== undefined ? ['catalog', 'reviews'] : [])]);
    const unsupportedFields = Object.keys(contract).filter(key => !supportedFields.has(key));
    if (unsupportedFields.length) error('FLEET_V5_CONTRACT_FIELD_UNSUPPORTED', `Fleet V5 does not accept these contract fields: ${unsupportedFields.join(', ')}.`);
    if (contract.expectedControlRevision !== undefined && (!Number.isSafeInteger(contract.expectedControlRevision) || contract.expectedControlRevision < 0))
      error('FLEET_V5_CONTRACT_INVALID', 'expectedControlRevision must be a nonnegative whole Fleet revision when supplied.');
    validateReviewFields(contract);
    const rules = validateRules(contract.rules);
    const compiled = compiledComposition(contract);
    const work = composedWork(contract, compiled);
    const requirements = normalizedRequirements(work.contract, authorizedWorkspace);
    if (!(requirements.outputs || []).length && !(requirements.checks || []).length && !contract.definitionOfDone && !compiled)
      error('FLEET_V5_CONTRACT_INVALID', 'Supply at least one definition-of-done output or check before any worker can be prepared.');
    const resourceLimits = normalizedResourceLimits(contract.resourceLimits || {});
    if (contract.workforce !== undefined) {
      const rootRole = contract.role ?? contract.workforce.rootRole ?? contract.roles?.[0] ?? 'worker';
      require('./fleet-v5-workforce').normalize({ ...contract.workforce, rootRole }, { contractId: `fc_${hash(idempotencyKey).slice(0, 32)}` });
      if (contract.resourceLimits?.maxAgents !== undefined && contract.resourceLimits.maxAgents !== contract.workforce.maxAgents)
        error('FLEET_V5_WORKFORCE_INVALID', 'resourceLimits.maxAgents and workforce.maxAgents must agree.');
    }
    if (contract.constraints !== undefined) assertObject(contract.constraints, 'constraints');
    if (contract.policy !== undefined) assertObject(contract.policy, 'policy');
    const normalizedContract = { ...structuredClone(contract), scope: structuredClone(contract.scope), rules, requirements, resourceLimits };
    const { expectedControlRevision: _controlPrecondition, ...taskContract } = normalizedContract;
    const inputDigest = contractDigest(taskContract);
    const key = keyFor(idempotencyKey);
    const previous = read(key);
    if (previous) {
      const saved = previous.value;
      if (saved.inputDigest !== inputDigest) error('FLEET_V5_IDEMPOTENCY_CONFLICT', 'The idempotency key is already bound to a different contract.');
      const savedReview = saved.review?.before ? { review: structuredClone(saved.review.before) } : {};
      if (saved.status === 'preparing') return { disposition: 'unknown', contract: recordView(saved), reason: 'previous-prepare-outcome-unknown', ...savedReview };
      return { disposition: 'replay', contract: recordView(saved), ...savedReview };
    }
    const before = await beforeView(contract);
    const initialControl = await control.request({ action: 'read', view: 'compact' });
    currentControlRevision(initialControl, contract.expectedControlRevision, 'submission');
    const resolved = await capabilities.candidates({ contract: normalizedContract });
    if (!resolved || !Array.isArray(resolved.candidates) || !Array.isArray(resolved.observations))
      error('FLEET_V5_CAPABILITY_RESOLUTION_UNKNOWN', 'The current capability resolver did not provide candidates and observations.');
    const policy = assertBaseline(resolved, contract.policy || {});
    const constraints = { ...(contract.constraints || {}), ...(resourceLimits.maxAgents === undefined ? {} : {
      maxAgents: Math.min(contract.constraints?.maxAgents ?? resourceLimits.maxAgents, resourceLimits.maxAgents) }) };
    const picked = selector({ task: { objective: contract.objective, scope: scope.prompt, productEffort: contract.productEffort,
      userEffort: contract.userEffort, provider: contract.provider, model: contract.model, computerId: contract.computerId,
      vendorEffort: contract.vendorEffort,
      resourceLimits, constraints },
      policy, candidates: resolved.candidates, observations: resolved.observations,
      eligible: resolved.eligible });
    const enforceableMaximum = Number.isSafeInteger(picked.selection.maxAgents) ? picked.selection.maxAgents
      : Number.isSafeInteger(picked.selection.workforce?.maxAgents) ? picked.selection.workforce.maxAgents
        : Number.isSafeInteger(picked.selection.agentCount) ? picked.selection.agentCount : null;
    if (resourceLimits.maxAgents !== undefined && (enforceableMaximum === null
        || enforceableMaximum > resourceLimits.maxAgents))
      error('FLEET_V5_RESOURCE_LIMIT_UNSATISFIED', 'The selected complete setup exceeds resourceLimits.maxAgents; no worker was prepared.');
    const contractId = `fc_${hash(idempotencyKey).slice(0, 32)}`;
    let record = { schema: 'ai.toolsenabled/fleet-v5-contract/v1', contractId, idempotencyKey, inputDigest,
      revision: 1, intentRevision: 1, status: 'preparing', contract: normalizedContract, amendments: [], selection: picked.selection,
      selectionReceipt: picked.receipt, execution: { jobId: contractId, nodeId: null, status: 'preparing' }, reportedOutcome: { status: 'unknown' },
      checkedOutcome: { status: 'unknown' }, operation: { kind: 'submit', status: 'pending' },
      review: { before, events: [] }, ...(compiled ? { composition: { promptSha256: compiled.promptSha256,
        compositionSha256: compiled.compositionSha256, checklist: compiled.checklist, bundles: compiled.bundles,
        ...(compiled.tasks.length ? { tasks: compiled.tasks.map((task, index) => ({ requirementId: task.requirementId,
          bundleId: task.bundleId, item: index + 1, checks: task.checks.map(check => check.id) })) } : {}) } } : {}),
      createdAt: now(), updatedAt: now() };
    try { save(record, 0); }
    catch (cause) {
      const raced = read(key)?.value;
      if (raced?.inputDigest === inputDigest)
        return { disposition: raced.status === 'preparing' ? 'unknown' : 'replay', contract: recordView(raced), reason: 'concurrent-idempotent-submission',
          ...(raced.review?.before ? { review: structuredClone(raced.review.before) } : {}) };
      throw cause;
    }
    let storeRevision = 1;
    let mutationMayHaveOccurred = false;
    try {
      mutationMayHaveOccurred = true;
      const applied = await capabilities.apply({ configuration: picked.selection, contract: normalizedContract,
        candidateId: picked.receipt.selectedCandidateId, contractId });
      if (applied?.eligible === false) error('FLEET_V5_PREPARATION_REFUSED', 'The current capability resolver refused this configuration before preparation.');
      if (!applied || applied.eligible !== true || !applied.configuration || applied.prepared !== true || typeof applied.nodeId !== 'string' || !applied.nodeId)
        error('FLEET_V5_PREPARATION_UNKNOWN', 'The resolver did not return a positively confirmed prepared worker identity and complete configuration.');
      record = { ...record, revision: record.revision + 1, status: 'prepared', selection: applied.configuration,
        execution: { ...record.execution, nodeId: applied.nodeId, status: 'prepared' }, updatedAt: now() };
      save(record, storeRevision); storeRevision += 1;
      if (stable(applied.configuration) !== stable(picked.selection))
        error('FLEET_V5_CONFIGURATION_CHANGED', 'The capability resolver applied a configuration different from the selected candidate.');
      const currentControl = await control.request({ action: 'read', view: 'compact' });
      const execution = await control.request({ action: 'job', id: contractId, nodeId: applied.nodeId,
        workItems: compiled?.tasks.length ? taskWorkItems(contract, compiled, before, requirements)
          : [{ text: assignmentText(work.contract, before), requirements: { ...requirements,
          ...(requirements.inputs ? { inputs: requirements.inputs } : {}), ...(requirements.outputs ? { outputs: requirements.outputs } : {}),
          ...(requirements.checks ? { checks: requirements.checks } : {}) } }],
        expectedRevision: currentControl.revision, ...(work.rules ? { rules: work.rules } : {}) });
      record = { ...record, revision: record.revision + 1, status: 'assigned',
        execution: { ...record.execution, jobId: contractId, controlRevision: execution?.revision ?? null, status: 'assigned' }, updatedAt: now() };
      save(record, storeRevision); storeRevision += 1;
      if (!Number.isSafeInteger(execution?.revision) || execution.revision < 0)
        error('FLEET_V5_JOB_REVISION_UNKNOWN', 'Fleet created the durable job but did not return its revision; inspect before any resume retry.');
      const resumed = await control.request({ action: 'resume', nodeId: applied.nodeId, expectedRevision: execution.revision });
      // fleet-v2-control returns a control revision plus the native host
      // lifecycle receipt under `result`; accept only that positive shape.
      if (resumed?.result?.resumed !== true || !Number.isSafeInteger(resumed.revision) || resumed.revision < 0)
        error('FLEET_V5_RESUME_UNKNOWN', 'Fleet did not confirm worker resume with a current revision; inspect the retained job before retrying.');
      record = { ...record, revision: record.revision + 1, intentRevision: record.revision + 1, status: 'submitted',
        execution: { ...record.execution, controlRevision: resumed?.revision ?? execution?.revision ?? null, status: 'submitted' },
        operation: { kind: 'submit', status: 'confirmed' }, updatedAt: now() };
      save(record, storeRevision); storeRevision += 1;
      return { disposition: 'submitted', contract: recordView(record), execution: { job: execution, resume: resumed }, review: structuredClone(before) };
    } catch (cause) {
      const definiteNoEffect = ['FLEET_V5_CONFIGURATION_CHANGED', 'FLEET_V5_PREPARATION_REFUSED'].includes(cause.code);
      record = { ...record, revision: record.revision + 1, status: definiteNoEffect ? 'failed' : mutationMayHaveOccurred ? 'unknown' : 'failed',
        execution: definiteNoEffect ? { ...record.execution, status: cause.code === 'FLEET_V5_PREPARATION_REFUSED' ? 'unprepared' : 'prepared' } : record.execution,
        operation: { kind: 'submit', status: definiteNoEffect ? 'refused' : mutationMayHaveOccurred ? 'unknown' : 'refused', code: cause.code || 'FLEET_V5_EXTERNAL_OUTCOME_UNKNOWN' }, updatedAt: now() };
      try { save(record, storeRevision); } catch { /* the latest committed stage remains available for inspection */ }
      return { disposition: record.status === 'unknown' ? 'unknown' : 'refused', contract: recordView(record), reason: cause.code || 'external-outcome-unknown',
        review: structuredClone(before) };
    }
  }

  async function ruleAmendmentHistory(job, amendment) {
    const expected = Object.entries(amendment.rules || {});
    const current = job?.rules && typeof job.rules === 'object' ? job.rules : null;
    if (!current || !expected.length) return null;
    const currentMatches = new Set(expected.filter(([id, text]) => current[id]?.text === text && current[id]?.active !== false).map(([id]) => id));
    if (currentMatches.size === expected.length) return { currentMatches, historyMatches: new Set(), historyRevision: null, currentRules: current };

    // A later job-rule edit archives the rule value it replaced. Read every
    // page at one retained history revision; current values alone cannot
    // explain a superseded rule, and a newer control revision is not proof.
    const entries = [];
    let offset = 0, historyRevision = null, total = null;
    do {
      const page = await control.request({ action: 'history-read', kind: 'rules', id: job.id, offset, limit: 1000,
        ...(historyRevision === null ? {} : { expectedHistoryRevision: historyRevision }) });
      if (page?.kind !== 'rules' || page.id !== job.id || !Number.isSafeInteger(page.historyRevision)
          || !page.page || page.page.offset !== offset || !Number.isSafeInteger(page.page.total)
          || !Number.isSafeInteger(page.page.returned) || !Array.isArray(page.entries)
          || page.page.returned !== page.entries.length || page.entries.length > 1000
          || (historyRevision !== null && page.historyRevision !== historyRevision)
          || (total !== null && page.page.total !== total)) return null;
      if (historyRevision === null) { historyRevision = page.historyRevision; total = page.page.total; }
      entries.push(...page.entries);
      const next = page.page.nextOffset;
      if (next === null) {
        if (offset + page.entries.length !== total) return null;
        break;
      }
      if (!Number.isSafeInteger(next) || next !== offset + page.entries.length || next <= offset) return null;
      offset = next;
    } while (true);

    const intentAt = Date.parse(amendment.at);
    if (!Number.isFinite(intentAt)) return null;
    const historyMatches = new Set();
    for (const [id, text] of expected) {
      if (currentMatches.has(id)) continue;
      const live = current[id];
      if (!live || typeof live.text !== 'string') return null;
      const found = entries.some(entry => entry?.id === id && entry.text === text && entry.active !== false
        && Number.isFinite(Date.parse(entry.editedAt)) && Date.parse(entry.editedAt) > intentAt
        && Number.isFinite(Date.parse(entry.retiredAt)) && Date.parse(entry.retiredAt) >= Date.parse(entry.editedAt));
      if (!found) return null;
      historyMatches.add(id);
    }
    // Rule state may change while the history pages are read. Re-read the
    // native job and proceed only if its identity and rule projection stayed
    // identical to the snapshot used above.
    const confirmed = await control.request({ action: 'job-read', id: job.id, view: 'full' });
    if (confirmed?.id !== job.id || confirmed.nodeId !== job.nodeId
        || stable(confirmed.rules || {}) !== stable(current)) return null;
    return { currentMatches, historyMatches, historyRevision, currentRules: confirmed.rules || {} };
  }

  async function inspectOnce({ contractId, idempotencyKey } = {}) {
    if (typeof contractId !== 'string' && typeof idempotencyKey !== 'string') error('FLEET_V5_CONTRACT_SELECTOR_INVALID', 'contractId or idempotencyKey is required.');
    let stored;
    if (idempotencyKey) stored = read(keyFor(idempotencyKey));
    else {
      // Bounded key-only recovery scan: records are individually retained by
      // Fleet memory. There is intentionally no count claim or implicit cap.
      const keys = store.memoryKeys({ namespace: NAMESPACE });
      for (const key of keys) { if (key.startsWith(PART_KEY_PREFIX)) continue; const row = read(key); if (row?.value?.contractId === contractId) { stored = row; break; } }
    }
    if (!stored || (contractId && stored.value.contractId !== contractId)) error('FLEET_V5_CONTRACT_NOT_FOUND', 'The retained Fleet V5 contract was not found.');
    const record = recordView(stored.value);
    if (!record.execution?.jobId) return presentRecord(record);
    try {
      const [job, nativeRead] = await Promise.all([
        control.request({ action: 'job-read', id: record.execution.jobId, view: 'full' }),
        record.execution.nodeId ? control.request({ action: 'read', nodeId: record.execution.nodeId, view: 'full' }) : Promise.resolve(null)
      ]);
      if (job?.id !== record.execution.jobId) error('FLEET_V5_NATIVE_JOB_MISMATCH', 'Fleet returned a different job during contract inspection.');
      const items = Array.isArray(job.items) ? job.items : [];
      const currentTask = nativeRead?.tasks?.[record.execution.nodeId] || null;
      const taskHistory = (nativeRead?.taskHistory || []).filter(task => task.nodeId === record.execution.nodeId);
      const taskByRevision = new Map(taskHistory.map(task => [task.taskRevision, task]));
      if (currentTask) taskByRevision.set(currentTask.taskRevision, currentTask);
      const ownedRevisions = new Set(items.filter(item => Number.isSafeInteger(item.taskRevision)).map(item => item.taskRevision));
      const nativeAsks = nativeRead?.asks && typeof nativeRead.asks === 'object' ? Object.entries(nativeRead.asks) : null;
      record.asks = nativeAsks ? nativeAsks.filter(([id, ask]) => ask?.nodeId === record.execution.nodeId
        && ownedRevisions.has(ask.taskRevision || 1)).map(([id, ask]) => ({ id, taskRevision: ask.taskRevision || 1,
        question: safeContractText(ask.question), status: ask.status, filedAt: ask.filedAt || null,
        ...(ask.answer !== undefined ? { answer: safeContractText(ask.answer), answerDigest: hash(ask.answer) } : {}),
        ...(ask.answeredAt ? { answeredAt: ask.answeredAt } : {}),
        ...(ask.resumeAttempt ? { resumeAttempt: structuredClone(ask.resumeAttempt) } : {}) }))
        : record.asks || [];
      if (!nativeAsks) record.askCoverage = 'unknown';
      else record.askCoverage = 'measured';
      const rows = items.map(item => {
        const task = Number.isSafeInteger(item.taskRevision) ? taskByRevision.get(item.taskRevision) || null : null;
        const verification = task && task.taskRevision === item.taskRevision ? task.verification || null : null;
        const expectedChecks = (item.requirements?.checks || []).filter(check => typeof check.command === 'string').map(check => check.id);
        const nativeChecks = Array.isArray(verification?.checks) ? verification.checks : [];
        const exactChecks = Boolean(verification && task?.taskRevision === item.taskRevision
          && verification.source === 'Fleet' && expectedChecks.length > 0
          && nativeChecks.length === expectedChecks.length
          && nativeChecks.every((check, index) => check.id === expectedChecks[index]));
        return { n: item.n, taskRevision: item.taskRevision ?? null, status: item.status,
          reported: Boolean(item.submission || item.outcome?.reported), workerReport: item.report || item.submission?.text || null,
          artifacts: structuredClone(item.submission?.result?.artifacts || []),
          result: structuredClone(item.submission?.result ?? null), requirements: structuredClone(item.requirements ?? null),
          assessment: item.assessment?.decision || item.outcome?.assessment || 'unassessed',
          verification: verification ? { status: exactChecks ? verification.status : 'unknown', source: verification.source || null,
            taskRevision: task.taskRevision, verificationTaskRevision: task.taskRevision,
            expectedCheckIds: expectedChecks,
            checks: nativeChecks.map(check => ({ id: check.id, status: check.status,
              ...(Number.isSafeInteger(check.exitCode) ? { exitCode: check.exitCode } : {}),
              ...(check.signal !== undefined ? { signal: check.signal } : {}),
              ...(typeof check.timedOut === 'boolean' ? { timedOut: check.timedOut } : {}),
              ...(typeof check.durationMs === 'number' ? { durationMs: check.durationMs } : {}),
              ...(typeof check.outputTail === 'string' ? { outputTail: check.outputTail } : {}) })) }
            : { status: currentTask?.status === 'verifying' && currentTask.taskRevision === item.taskRevision ? 'verifying' : 'unknown',
              source: null, taskRevision: task?.taskRevision ?? null, verificationTaskRevision: null,
              expectedCheckIds: expectedChecks, checks: [] } };
      });
      const terminal = rows.length > 0 && rows.every(item => ['done', 'held'].includes(item.status));
      const held = decidingRows(rows, record).some(item => item.status === 'held');
      record.reportedOutcome = { status: terminal ? held ? 'held' : 'reported' : currentTask?.status === 'verifying' ? 'verifying'
        : job.state === 'paused' ? 'paused' : 'in_progress', items: rows };
      const deciding = decidingRows(rows, record);
      const assessments = deciding.map(item => item.assessment);
      const fleetVerified = deciding.length > 0 && deciding.every(item => item.verification.status === 'passed'
        && item.verification.source === 'Fleet' && item.verification.checks.length > 0
        && item.verification.taskRevision === item.taskRevision
        && item.verification.verificationTaskRevision === item.taskRevision
        && item.verification.expectedCheckIds.length === item.verification.checks.length
        && item.verification.checks.every(check => check.status === 'passed' && check.exitCode === 0
          && check.timedOut !== true && (check.signal === undefined || check.signal === null)));
      record.checkedOutcome = { status: assessments.length && terminal && assessments.every(value => value === 'accepted') ? 'accepted'
        : assessments.some(value => ['rework', 'rejected'].includes(value)) ? 'review-required'
          : terminal && !held && fleetVerified ? 'verified' : 'unknown', assessments,
      fleetVerification: fleetVerified ? { status: 'passed', source: 'Fleet', checks: deciding.flatMap(item => item.verification.checks) }
        : { status: deciding.some(item => item.verification.status === 'failed') ? 'failed'
          : deciding.some(item => item.verification.status === 'verifying') ? 'verifying' : 'unknown' } };
      const amendment = record.operation.kind === 'amend' ? record.operation.amendment : null;
      if (['pending', 'unknown'].includes(record.operation.status)) {
        if (record.operation.kind === 'submit') {
          const started = job.worker?.state === 'running' || items.some(item => item.turns > 0 || item.submission);
          if (started) {
            record.operation = { kind: 'submit', status: 'reconciled' };
            record.intentRevision = record.revision + 1;
          }
        } else if (record.operation.kind === 'cancel' && job.state === 'closed' && record.operation.quiescence?.status === 'confirmed') {
          record.operation = { ...record.operation, status: 'reconciled' };
        } else if (record.operation.kind === 'answer') {
          const answered = record.asks.find(ask => ask.id === record.operation.askId);
          if (answered?.status === 'answered' && answered.answerDigest === record.operation.answerDigest)
            record.operation = { ...record.operation, status: 'reconciled', resumeAttempt: answered.resumeAttempt || null };
        } else if (amendment && !amendment.changesWork && Object.keys(amendment.rules || {}).length) {
          try {
            const evidence = await ruleAmendmentHistory(job, amendment);
            if (evidence) {
              amendment.reconciliationEvidence = { source: evidence.historyMatches.size ? 'native-rule-history' : 'native-current-rules',
                historyRevision: evidence.historyRevision,
                currentRuleKeys: [...evidence.currentMatches].sort(), historyRuleKeys: [...evidence.historyMatches].sort() };
              amendment.nextContract = { ...amendment.nextContract, rules: { ...(amendment.nextContract.rules || {}) } };
              // Reflect later supported native rule updates in the contract's
              // current projection; never restore superseded amendment text.
              for (const id of evidence.historyMatches) {
                const rule = evidence.currentRules[id];
                if (rule.active === false) delete amendment.nextContract.rules[id];
                else amendment.nextContract.rules[id] = rule.text;
              }
              record.operation = { kind: 'amend', status: 'reconciled', amendment };
              record.intentRevision = record.revision + 1;
            }
          } catch { /* absent, stale, or incomplete native history leaves the operation unknown */ }
        } else if (amendment?.changesWork && items.some(item => item.text?.includes(amendment.marker))
            && (!Object.keys(amendment.rules || {}).length || Object.entries(amendment.rules).every(([id, text]) => job.rules?.[id]?.text === text))) {
          record.operation = { kind: 'amend', status: 'reconciled', amendment };
          record.intentRevision = record.revision + 1;
        }
      }
      if (record.operation.kind === 'amend' && record.operation.status === 'reconciled' && amendment?.nextContract) {
        record.contract = structuredClone(amendment.nextContract);
        if (!(record.amendments || []).some(entry => entry.marker === amendment.marker)) {
          const workItemN = amendment.changesWork
            ? items.find(item => typeof item.text === 'string' && item.text.includes(amendment.marker))?.n : undefined;
          record.amendments = [...(record.amendments || []), { revision: amendment.revision, marker: amendment.marker,
            patch: amendment.patch, appendedWork: amendment.changesWork,
            ...(amendment.reconciliationEvidence ? { reconciliationEvidence: structuredClone(amendment.reconciliationEvidence) } : {}),
            ...(Number.isSafeInteger(workItemN) ? { workItemN } : {}),
            ...(Array.isArray(amendment.resolvedWorkItems) ? { resolvedWorkItems: amendment.resolvedWorkItems,
              resolvedNativeItems: amendment.resolvedNativeItems } : {}), at: amendment.at }];
        }
      }
      if (record.operation.kind === 'cancel' && record.operation.status !== 'unknown' && job.state === 'closed') record.status = 'cancelled';
      else if (job.state === 'closed') record.status = 'closed';
      else if (currentTask?.status === 'verifying') record.status = 'verifying';
      else if (job.state === 'paused' && currentTask?.verification?.status === 'failed') record.status = 'paused';
      else if (currentTask?.verification?.status === 'failed' && ['held', 'assigned'].includes(currentTask.status)) record.status = 'rework';
      else if (job.state === 'paused') record.status = 'paused';
      else if (terminal) record.status = held ? 'held' : 'completed';
      else if (job.state === 'assigned' || job.state === 'running' || job.state === 'idle') record.status = 'in_progress';
      record.execution = { ...record.execution, status: job.state, controlRevision: job.revision ?? record.execution.controlRevision };
      let workers = null;
      try {
        workers = typeof listWorkers === 'function' ? await listWorkers() : null;
        record.workforceMembers = workforceMemberView(record, workers);
        delete record.workforceMembersError;
        const inspectedWorker = Array.isArray(workers)
          ? workers.find(worker => worker?.nodeId === record.execution.nodeId) : null;
        const providerOutcome = inspectedWorker?.lastTurn?.providerOutcome;
        if (providerOutcome?.provider === 'model-api' && providerOutcome?.source === 'completion'
            && providerOutcome?.reason === 'safety-refusal' && providerOutcome?.code === 'MODEL_API_SAFETY_REFUSAL') {
          record.providerOutcome = { status: 'refused', provider: 'model-api', source: 'completion',
            reason: 'safety-refusal', code: 'MODEL_API_SAFETY_REFUSAL' };
        } else delete record.providerOutcome;
      } catch (cause) {
        record.workforceMembers = record.selection?.workforce
          ? { status: 'unknown', members: [], memberCount: null }
          : { status: 'not-configured', members: [] };
        record.workforceMembersError = { code: cause.code || 'FLEET_V5_WORKFORCE_INSPECT_UNKNOWN' };
      }
      projectRecovery(record, { job, nativeRead, currentTask, rows, workers });
      try {
        const accountRead = await control.request({ action: 'account-read', nodeId: record.execution.nodeId, limit: 100 });
        const bound = (accountRead?.boundWorkers || []).find(row => row.nodeId === record.execution.nodeId);
        const provider = workers?.find?.(worker => worker.nodeId === record.execution.nodeId)?.provider;
        const usage = accountUsageView(bound?.usage);
        const withheldEnv = Array.isArray(bound?.withheldEnv)
          ? bound.withheldEnv.filter(name => ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY',
            'XAI_API_KEY', 'GROK_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'].includes(name))
          : undefined;
        record.accountBinding = bound ? { status: 'measured', source: 'Fleet account-read',
          provider: bound.provider, ...(typeof bound.authentication === 'string' ? { authentication: bound.authentication } : {}),
          ...(typeof bound.configDir === 'string' ? { configDir: bound.configDir } : {}),
          ...(typeof bound.keySource === 'string' ? { keySource: bound.keySource } : {}),
          ...(withheldEnv ? { withheldEnv } : {}),
          ...(typeof bound.account === 'string' ? { account: bound.account } : {}), ...(bound.model ? { model: bound.model } : {}),
          state: bound.state, threadId: bound.threadId || null,
          ...(usage ? { usage } : {}),
          ...(bound.admission ? { admission: structuredClone(bound.admission) } : {}),
          ...(bound.completion ? { completion: structuredClone(bound.completion) } : {}) }
          : ['claude', 'codex'].includes(provider) ? { status: 'unknown', source: 'Fleet account-read', reason: 'native-worker-binding-not-present' }
            : { status: 'not-applicable', source: 'Fleet account-read' };
        delete record.accountBindingError;
      } catch (cause) {
        record.accountBinding = { status: 'unknown', source: 'Fleet account-read' };
        record.accountBindingError = { code: cause.code || 'FLEET_V5_ACCOUNT_BINDING_UNKNOWN' };
      }
      // Worker lifecycle is observable, but current Fleet reads do not prove
      // process/token cleanup. Keep those counts unknown even when idle.
      record.cleanup = cleanupLifecycleView(workers, record.execution.nodeId);
      try {
        const usageQuery = { action: 'usage-read', contractId: record.contractId, view: 'full' };
        const usage = await control.request(usageQuery);
        const selected = record.selection || {};
        const nativeTask = items.length === 1 && Number.isSafeInteger(items[0].taskRevision)
          ? taskByRevision.get(items[0].taskRevision) || null : null;
        const verification = nativeTask?.taskRevision === items[0]?.taskRevision ? nativeTask?.verification || null : null;
        const policyVersion = `policy-sha256:${hash(stable({ policy: record.contract.policy || {},
          constraints: record.contract.constraints || {}, resourceLimits: record.contract.resourceLimits || {} }))}`;
        record.operationalObservation = projectOperationalObservation({
          configuration: selected,
          runtimeRevision: selected.runtimeRevision,
          policyVersion,
          usage,
          usageQuery,
          job,
          workers,
          contractId: record.contractId,
          verification,
          taskRevision: nativeTask?.taskRevision,
          verificationTaskRevision: verification ? nativeTask?.taskRevision : undefined
        });
        delete record.operationalObservationError;
      } catch (cause) {
        record.operationalObservation = { schema: 'ai.toolsenabled/fleet-v5-operational-observation/v1', status: 'unknown',
          workforce: workforceProjection({ configuration: record.selection, contractId: record.contractId, job, workers }) };
        record.operationalObservationError = { code: cause.code || 'FLEET_V5_MEASUREMENT_UNKNOWN' };
      }
      // Explicit credit provenance is scoped to this contract's bound worker.
      // Account balance snapshots are not an inferred per-turn charge.
      const binding = record.accountBinding;
      const spend = binding?.completion?.creditSpend || binding?.admission?.creditSpend;
      if (binding?.status === 'measured' && binding.provider === 'codex' && typeof binding.account === 'string' && spend
          && spend.account === binding.account && typeof spend.workspaceId === 'string' && spend.workspaceId
          && spend.workspaceId === binding.admission?.workspaceId) {
        const balanceAtAdmission = Number.isFinite(spend.balanceAtAdmission) && spend.balanceAtAdmission >= 0 ? spend.balanceAtAdmission : null;
        const measured = Number.isFinite(spend.balanceAtCompletion) && spend.balanceAtCompletion >= 0;
        const creditSpend = { account: binding.account, workspaceId: spend.workspaceId,
          ...(typeof binding.model === 'string' ? { model: binding.model } : {}),
          ...(typeof spend.email === 'string' ? { email: spend.email } : {}),
          ...(typeof spend.creditAuthority === 'string' && spend.creditAuthority.trim() ? { creditAuthority: spend.creditAuthority } : {}),
          balanceAtAdmission,
          balanceAtCompletion: measured ? spend.balanceAtCompletion : null,
          completionStatus: measured ? 'observed' : 'unavailable',
          accounting: 'shared-account-balance-snapshots; no per-turn charge inferred' };
        for (const key of ['grantedAt', 'admissionObservedAt', 'completionObservedAt'])
          if (typeof spend[key] === 'string' && Number.isFinite(Date.parse(spend[key]))) creditSpend[key] = spend[key];
        record.operationalObservation = { ...record.operationalObservation, usage: { ...record.operationalObservation.usage, creditSpend } };
      }
      if (record.review) record.review = recordReviewEvents(record, rows).review;
      delete record.inspectError;
      if (stable(record) !== stable(stored.value)) {
        record.revision = stored.value.revision + 1; record.updatedAt = now();
        save(record, stored.revision);
      }
    } catch (cause) { record.inspectError = { status: 'unknown', code: cause.code || 'FLEET_V5_INSPECT_UNAVAILABLE' }; }
    return presentRecord(record);
  }

  // Optional wait for change: `changed` reports only whether the retained
  // revision moved past the baseline; waitMs is a polling bound, never a verdict.
  async function inspect(args = {}) {
    const { sinceRevision, waitMs } = args;
    if (sinceRevision === undefined && waitMs === undefined) return inspectOnce(args);
    if (sinceRevision !== undefined && !(Number.isSafeInteger(sinceRevision) && sinceRevision >= 0))
      error('FLEET_V5_INSPECT_WAIT_INVALID', 'sinceRevision must be a non-negative integer.');
    if (waitMs !== undefined && !(Number.isSafeInteger(waitMs) && waitMs >= 0 && waitMs <= MAX_INSPECT_WAIT_MS))
      error('FLEET_V5_INSPECT_WAIT_INVALID', `waitMs must be an integer from 0 through ${MAX_INSPECT_WAIT_MS}.`);
    const selector = { contractId: args.contractId, idempotencyKey: args.idempotencyKey };
    const deadline = Date.now() + (waitMs || 0);
    let record = await inspectOnce(selector);
    const baseline = sinceRevision ?? record.revision;
    while (!(record.revision > baseline) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.min(INSPECT_POLL_MS, Math.max(1, deadline - Date.now()))));
      record = await inspectOnce(selector);
    }
    return { ...record, changed: record.revision > baseline };
  }

  // Asks (once per ask id), reconciled answers and amendments, failed Fleet
  // checks (once per task revision and check id) and rework assessments (once
  // per task revision) are the ambiguity a contract actually cost. A finished
  // contract also gets the after view.
  function recordReviewEvents(record, rows) {
    let next = record;
    for (const ask of record.asks || [])
      next = withEvent(next, { type: 'ask', askId: ask.id, taskRevision: ask.taskRevision, resolves: [], at: ask.filedAt || now() },
        event => event.type === 'ask' && event.askId === ask.id);
    const operation = next.operation;
    if (operation?.kind === 'answer' && operation.status === 'reconciled')
      next = recordAnswer(next, operation, operation.answeredAt || now());
    if (operation?.kind === 'amend' && operation.status === 'reconciled' && operation.amendment)
      next = withEvent(next, amendmentEvent(operation.amendment), event => event.type === 'amendment' && event.marker === operation.amendment.marker);
    for (const item of rows) {
      if (!Number.isSafeInteger(item.taskRevision)) continue;
      for (const check of item.verification?.checks || []) if (check.status === 'failed')
        next = withEvent(next, { type: 'check-failure', checkId: check.id, taskRevision: item.taskRevision, resolves: [], at: now() },
          event => event.type === 'check-failure' && event.checkId === check.id && event.taskRevision === item.taskRevision);
      if (item.assessment === 'rework')
        next = withEvent(next, { type: 'rework', taskRevision: item.taskRevision, resolves: [], at: now() },
          event => event.type === 'rework' && event.taskRevision === item.taskRevision);
    }
    if (['completed', 'held', 'closed', 'cancelled'].includes(record.status)) {
      const report = rows.map(item => item.workerReport).filter(value => typeof value === 'string' && value).join('\n\n');
      next = { ...next, review: { ...next.review, after: contractReview.afterView(next.review.before, next.review.events, report, record.composition,
        next.review.determinacy, rows) } };
    }
    return next;
  }

  async function amend({ contractId, expectedRevision, expectedControlRevision, patch, resolves, resolvesWorkItems } = {}) {
    assertObject(patch, 'patch');
    const current = await findById(contractId);
    const resolved = validateResolves(resolves, current.value);
    const intentRevision = Number.isSafeInteger(current.value.intentRevision) ? current.value.intentRevision : current.value.revision;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < intentRevision || expectedRevision > current.value.revision)
      error('FLEET_V5_STALE_REVISION', 'The contract changed before amendment.');
    if (!current.value.execution?.jobId || ['cancelled', 'closed', 'unknown', 'failed', 'preparing'].includes(current.value.status)
        || ['pending', 'unknown'].includes(current.value.operation?.status))
      error('FLEET_V5_AMEND_UNAVAILABLE', 'This contract has no amendable native job state; inspect or create a new contract.');
    if (expectedControlRevision !== undefined && (!Number.isSafeInteger(expectedControlRevision) || expectedControlRevision < 0))
      error('FLEET_V5_CONTROL_REVISION_INVALID', 'expectedControlRevision must be a nonnegative whole Fleet revision when supplied.');
    const patchKeys = ['objective', 'scope', 'rules', 'requirements', 'inputs', 'outputs', 'checks', 'definitionOfDone'];
    if (!patchKeys.some(key => patch[key] !== undefined)) error('FLEET_V5_PATCH_INVALID', 'Amendment must change objective, scope, rules, inputs, outputs, checks or requirements.');
    for (const key of ['objective', 'definitionOfDone']) if (patch[key] !== undefined && (typeof patch[key] !== 'string' || !patch[key].trim()))
      error('FLEET_V5_PATCH_INVALID', `${key} must be nonempty text.`);
    const amendedScope = patch.scope === undefined ? null : normalizeScope(patch.scope);
    const newRules = validateRules(patch.rules);
    const previousRequirements = current.value.contract.requirements || normalizedRequirements(current.value.contract);
    const amendedWorkspace = amendedScope?.folder ?? previousRequirements.workspaceRoot ?? null;
    if (amendedScope?.folder && amendedScope.folder !== previousRequirements.workspaceRoot)
      error('FLEET_V5_AMEND_WORKSPACE_UNSUPPORTED', 'A prepared native worker cannot change workspaces during amendment; submit a new contract for a different authorized workspace.');
    if (amendedWorkspace && amendedScope?.folder
        && (typeof authorizeWorkspace !== 'function' || await authorizeWorkspace(amendedWorkspace) !== amendedWorkspace))
      error('FLEET_V5_WORKSPACE_REFUSED', 'The amended workspace is not the exact current native workspace authorized by Fleet.');
    const currentScope = normalizeScope(current.value.contract.scope);
    const patchRequirements = normalizedRequirementPatch(patch, currentScope.prompt);
    const previousScope = previousRequirements.scope || currentScope.prompt;
    const requestedScope = amendedScope?.prompt
      || (patchRequirements.scope !== currentScope.prompt ? patchRequirements.scope : null);
    const scopeChanged = Boolean(requestedScope && requestedScope !== currentScope.prompt);
    const nextScope = scopeChanged ? `${previousScope}\nAmended authorized scope: ${requestedScope}` : previousScope;
    const nextCriterion = patch.definitionOfDone ? `\nDefinition of done: ${patch.definitionOfDone}` : '';
    const mergedRequirements = taskResults.requirements({ scope: nextScope,
      ...(amendedWorkspace || previousRequirements.workspaceRoot ? { workspaceRoot: amendedWorkspace || previousRequirements.workspaceRoot } : {}),
      inputs: mergeById(previousRequirements.inputs, patchRequirements.inputs),
      outputs: mergeById(previousRequirements.outputs, patchRequirements.outputs),
      checks: mergeById(previousRequirements.checks, patchRequirements.checks) });
    if (nextCriterion) mergedRequirements.scope += nextCriterion;
    const rules = { ...(current.value.contract.rules || {}), ...newRules };
    const requirementsChanged = stable(mergedRequirements) !== stable(previousRequirements);
    const changesWork = (patch.objective !== undefined && patch.objective !== current.value.contract.objective)
      || scopeChanged || requirementsChanged;
    const rulesChanged = Object.entries(newRules).some(([id, text]) => current.value.contract.rules?.[id] !== text);
    if (!changesWork && !rulesChanged) error('FLEET_V5_PATCH_INVALID', 'The amendment contains no effective contract change; empty or identical edits are not recorded.');
    if (resolvesWorkItems !== undefined && (!Array.isArray(resolvesWorkItems) || resolvesWorkItems.length > 32
        || resolvesWorkItems.some(n => !Number.isSafeInteger(n) || n < 1) || new Set(resolvesWorkItems).size !== resolvesWorkItems.length))
      error('FLEET_V5_WORK_ITEM_RESOLUTION_INVALID', 'resolvesWorkItems must contain up to 32 unique positive native work item numbers.');
    if (resolvesWorkItems?.length && !changesWork)
      error('FLEET_V5_WORK_ITEM_RESOLUTION_INVALID', 'A held work item can be resolved only by an amendment that appends follow-up work.');
    const resolvedNativeItems = [];
    const resolutionRead = resolvesWorkItems?.length
      ? await control.request({ action: 'read', view: 'compact' }) : null;
    const resolutionRevision = resolutionRead
      ? currentControlRevision(resolutionRead, expectedControlRevision, 'held work resolution') : null;
    for (const n of resolvesWorkItems || []) {
      const observed = await control.request({ action: 'job-read', id: current.value.execution.jobId, view: 'full', offset: n - 1, limit: 1 });
      const item = observed?.id === current.value.execution.jobId && observed?.nodeId === current.value.execution.nodeId
        ? observed.items?.find(entry => entry.n === n) : null;
      if (observed?.revision !== resolutionRevision || item?.status !== 'held')
        error('FLEET_V5_WORK_ITEM_RESOLUTION_INVALID', `Native work item ${n} is not a retained held item of this contract's job.`);
      resolvedNativeItems.push({ jobId: current.value.execution.jobId, n, status: 'held',
        ...(Number.isSafeInteger(item.taskRevision) ? { taskRevision: item.taskRevision } : {}) });
    }
    const updatedContract = { ...current.value.contract, ...(patch.objective ? { objective: patch.objective } : {}),
      scope: amendedScope ? structuredClone(patch.scope) : current.value.contract.scope,
      ...(patch.definitionOfDone ? { definitionOfDone: patch.definitionOfDone } : {}), rules, requirements: mergedRequirements };
    const initialRead = await control.request({ action: 'read', view: 'compact' });
    const initialRevision = currentControlRevision(initialRead, expectedControlRevision, 'amendment');
    if (resolutionRevision !== null && resolutionRevision !== initialRevision)
      error('FLEET_V5_STALE_REVISION', 'Native work changed while held-item resolution was being verified.');
    // Native reads are asynchronous. Progress-only inspect calls may advance
    // the public contract revision while this amendment is being prepared;
    // reload and rebase the intent only when its semantic fence is unchanged.
    const latest = await findById(contractId);
    const latestIntentRevision = Number.isSafeInteger(latest.value.intentRevision) ? latest.value.intentRevision : latest.value.revision;
    if (latestIntentRevision !== intentRevision || latest.value.revision < expectedRevision
        || ['cancelled', 'closed', 'unknown', 'failed', 'preparing'].includes(latest.value.status)
        || ['pending', 'unknown'].includes(latest.value.operation?.status))
      error('FLEET_V5_STALE_REVISION', 'The contract changed before amendment intent could be saved.');
    const amendmentRevision = latest.value.revision + 1;
    const marker = `[fleet-v5-amendment:${contractId}:${amendmentRevision}]`;
    const workText = changesWork ? `${marker} Follow-up to existing objective (${latest.value.contract.objective}): ${patch.objective || 'Review existing work under the amended scope and retained requirements.'}` : null;
    const amendment = { revision: amendmentRevision, marker, workText, rules: newRules, changesWork,
      ...(resolvesWorkItems !== undefined ? { resolvedWorkItems: [...resolvesWorkItems], resolvedNativeItems } : {}),
      patch: structuredClone(patch), nextContract: updatedContract, at: now(), ...(resolves !== undefined ? { resolves: resolved } : {}) };
    const pending = { ...latest.value, revision: amendmentRevision, intentRevision: amendmentRevision, status: 'amending',
      operation: { kind: 'amend', status: 'pending', amendment }, updatedAt: now() };
    save(pending, latest.revision);
    const storeRevision = pending.revision;
    try {
      let ruleResult = null, workResult = null, controlRevision = null;
      if (rulesChanged) {
        controlRevision = initialRevision;
        ruleResult = await control.request({ action: 'job-rule', id: current.value.execution.jobId, rules: newRules, expectedRevision: controlRevision });
      }
      if (changesWork) {
        if (rulesChanged) {
          const read = await control.request({ action: 'read', view: 'compact' });
          controlRevision = currentControlRevision(read, undefined, 'amendment work item');
        } else controlRevision = initialRevision;
        workResult = await control.request({ action: 'job-add', id: current.value.execution.jobId,
          workItems: [{ text: workText, requirements: mergedRequirements }], expectedRevision: controlRevision });
      }
      const workItemN = changesWork && Array.isArray(workResult?.lane?.items)
        ? workResult.lane.items.find(item => typeof item.text === 'string' && item.text.includes(marker))?.n : undefined;
      const done = { ...pending, revision: pending.revision + 1, status: 'amended', contract: updatedContract,
        amendments: [...(latest.value.amendments || []), { revision: amendmentRevision, marker, patch: structuredClone(patch),
          appendedWork: changesWork,
          ...(Number.isSafeInteger(workItemN) ? { workItemN } : {}),
          ...(Array.isArray(amendment.resolvedWorkItems) ? { resolvedWorkItems: amendment.resolvedWorkItems,
            resolvedNativeItems: amendment.resolvedNativeItems } : {}), at: amendment.at }],
        operation: { kind: 'amend', status: 'confirmed', amendment },
        execution: { ...pending.execution, controlRevision: workResult?.revision ?? ruleResult?.revision ?? controlRevision ?? pending.execution.controlRevision }, updatedAt: now() };
      const recorded = withEvent(done, amendmentEvent(amendment), event => event.type === 'amendment' && event.marker === marker);
      save(recorded, storeRevision); return { disposition: 'amended', contract: recordView(recorded), execution: { rules: ruleResult, work: workResult } };
    } catch (cause) {
      const unknown = { ...pending, revision: pending.revision + 1, status: 'unknown', operation: { kind: 'amend', status: 'unknown', amendment, code: cause.code || 'FLEET_V5_EXTERNAL_OUTCOME_UNKNOWN' }, updatedAt: now() };
      try { save(unknown, storeRevision); } catch { /* retain pending amendment as unknown */ }
      return { disposition: 'unknown', contract: recordView(unknown) };
    }
  }

  async function answer({ contractId, expectedRevision, askId, answer: answerText, resolves } = {}) {
    if (typeof askId !== 'string' || !askId.trim() || typeof answerText !== 'string' || !answerText.trim())
      error('FLEET_V5_ANSWER_INVALID', 'askId and a nonempty answer are required.');
    const current = await findById(contractId);
    const resolved = validateResolves(resolves, current.value);
    if (current.value.revision !== expectedRevision) error('FLEET_V5_STALE_REVISION', 'The contract changed before answering the Ask.');
    const prior = current.value.operation;
    if (prior?.kind === 'answer' && prior.askId === askId && prior.answerDigest === hash(answerText)) {
      if (prior.status === 'confirmed' || prior.status === 'reconciled')
        return { disposition: 'replay', contract: recordView(current.value), answer: { id: askId, resume: prior.resume || null } };
    }
    if (['pending', 'unknown'].includes(prior?.status))
      error('FLEET_V5_OPERATION_UNKNOWN', 'Inspect this contract to reconcile its uncertain native operation before starting another mutation.');
    if (!current.value.execution?.jobId || !current.value.execution?.nodeId)
      error('FLEET_V5_ANSWER_UNAVAILABLE', 'This contract has no retained native worker Ask scope.');
    const [job, nativeRead] = await Promise.all([
      control.request({ action: 'job-read', id: current.value.execution.jobId, view: 'full' }),
      control.request({ action: 'read', nodeId: current.value.execution.nodeId, view: 'full' })
    ]);
    if (job?.id !== current.value.execution.jobId || job.nodeId !== current.value.execution.nodeId)
      error('FLEET_V5_NATIVE_JOB_MISMATCH', 'Fleet returned a different job while validating the Ask.');
    const revisions = new Set((job.items || []).filter(item => Number.isSafeInteger(item.taskRevision)).map(item => item.taskRevision));
    const ask = nativeRead?.asks?.[askId];
    if (!ask || ask.nodeId !== current.value.execution.nodeId
        || !revisions.has(ask.taskRevision || 1))
      error('FLEET_V5_ASK_NOT_OWNED', 'This Ask does not belong to this contract’s retained job tasks.');
    if (ask.status === 'superseded' || ask.status === 'archived')
      error('FLEET_V5_ASK_UNAVAILABLE', 'This Ask is no longer answerable in Fleet.');
    if (ask.answer !== undefined && hash(ask.answer) !== hash(answerText))
      error('FLEET_V5_ASK_ANSWER_CONFLICT', 'Fleet already retains a different answer for this Ask.');
    const read = await control.request({ action: 'read', nodeId: current.value.execution.nodeId, view: 'compact' });
    const controlRevision = currentControlRevision(read, undefined, 'Ask answer');
    const intent = { ...current.value, revision: expectedRevision + 1, intentRevision: expectedRevision + 1, status: 'answering',
      operation: { kind: 'answer', status: 'pending', askId, answerDigest: hash(answerText), taskRevision: ask.taskRevision || 1,
        ...(resolves !== undefined ? { resolves: resolved } : {}) }, updatedAt: now() };
    save(intent, current.revision);
    try {
      const result = await control.request({ action: 'answer', id: askId, answer: answerText, resume: true,
        expectedRevision: controlRevision, revisionScope: 'target' });
      if (result?.id !== askId || result.status !== 'answered' || result.answer !== answerText
          || !result.resume || typeof result.resume.resumed !== 'boolean')
        error('FLEET_V5_ANSWER_RECEIPT_UNKNOWN', 'Fleet did not return a retained answer and resume receipt; inspect before retrying.');
      const resumeReceipt = safeResumeReceipt(result.resume);
      const answered = { ...intent, revision: intent.revision + 1, status: 'answered',
        operation: { ...intent.operation, status: 'confirmed', resume: resumeReceipt, answeredAt: result.answeredAt || now() }, updatedAt: now() };
      const done = recordAnswer(answered, answered.operation, answered.operation.answeredAt);
      save(done, intent.revision);
      return { disposition: 'answered', contract: recordView(done), answer: { id: askId, taskRevision: ask.taskRevision || 1,
        status: 'answered', resume: resumeReceipt } };
    } catch (cause) {
      const unknown = { ...intent, revision: intent.revision + 1, status: 'unknown',
        operation: { ...intent.operation, status: 'unknown', code: cause.code || 'FLEET_V5_EXTERNAL_OUTCOME_UNKNOWN' }, updatedAt: now() };
      try { save(unknown, intent.revision); } catch { /* retain the durable answer intent for inspection */ }
      return { disposition: 'unknown', contract: recordView(unknown), reason: cause.code || 'external-outcome-unknown' };
    }
  }

  async function cancel({ contractId, expectedRevision, expectedControlRevision, reason = 'Contract cancelled.' } = {}) {
    const current = await findById(contractId);
    if (current.value.revision !== expectedRevision) error('FLEET_V5_STALE_REVISION', 'The contract changed before cancellation.');
    if (expectedControlRevision !== undefined && (!Number.isSafeInteger(expectedControlRevision) || expectedControlRevision < 0))
      error('FLEET_V5_CONTROL_REVISION_INVALID', 'expectedControlRevision must be a nonnegative whole Fleet revision when supplied.');
    if (!current.value.execution?.jobId || ['cancelled', 'closed', 'unknown', 'failed', 'preparing'].includes(current.value.status)
        || ['pending', 'unknown'].includes(current.value.operation?.status))
      error('FLEET_V5_CANCEL_UNAVAILABLE', 'This contract has no safely cancellable native job state; inspect it before retrying.');
    const read = await control.request({ action: 'read', view: 'compact' });
    const controlRevision = currentControlRevision(read, expectedControlRevision, 'cancellation');
    const intent = { ...current.value, revision: expectedRevision + 1, intentRevision: expectedRevision + 1, status: 'cancelling', operation: { kind: 'cancel', status: 'pending' }, updatedAt: now() };
    save(intent, expectedRevision);
    try {
      const result = await quiesceCancellation({ control, record: intent, reason, expectedRevision: controlRevision });
      const done = { ...intent, revision: intent.revision + 1, status: 'cancelled', operation: { kind: 'cancel', status: 'confirmed', quiescence: result.quiescence }, execution: { ...intent.execution, status: 'closed', controlRevision: result?.revision ?? intent.execution.controlRevision, quiescence: result.quiescence }, updatedAt: now() };
      save(done, intent.revision); return { disposition: 'cancelled', contract: recordView(done), execution: result };
    } catch (cause) {
      const unknown = { ...intent, revision: intent.revision + 1, status: 'unknown', operation: { kind: 'cancel', status: 'unknown', code: cause.code || 'FLEET_V5_EXTERNAL_OUTCOME_UNKNOWN', quiescence: cause.quiescence || { status: 'unknown' } }, updatedAt: now() };
      try { save(unknown, intent.revision); } catch { /* retain intent as unknown */ }
      return { disposition: 'unknown', contract: recordView(unknown) };
    }
  }

  // Omission mutants of a finished contract's work, run in throwaway copies of
  // its authorized workspace with Fleet's own check runner. The result is kept
  // as review.determinacy; each surviving mutant is a weak-check event. It is
  // feedback only and never changes the contract's status.
  async function determinacy({ contractId } = {}) {
    await inspect({ contractId });
    const record = (await findById(contractId)).value;
    const scope = record.contract?.scope;
    const workspace = scope && typeof scope === 'object' && scope.mode === 'folder' && typeof scope.folder === 'string' ? scope.folder : null;
    const setting = record.contract?.determinacy?.mutants;
    let result;
    if (!workspace) result = determinacyLib.notRun('no-workspace');
    else if (typeof authorizeWorkspace !== 'function' || await authorizeWorkspace(workspace) !== workspace) result = determinacyLib.notRun('workspace-unauthorized');
    else if (!['completed', 'held', 'closed', 'cancelled'].includes(record.status)) result = determinacyLib.notRun('not-finished');
    else result = await determinacyLib.runDeterminacy({ workspace, review: record.review?.before,
      checks: record.contract.requirements.checks, runChecks: verification.runChecks,
      mutants: setting === 'worker' ? determinacyLib.readWorkerMutants(workspace) : Array.isArray(setting) ? setting : [] });
    const at = now();
    result = { ...result, at };
    for (let attempt = 0; ; attempt++) {
      const stored = await findById(contractId);
      let next = { ...stored.value, review: { events: [], ...(stored.value.review || {}), determinacy: structuredClone(result) } };
      for (const event of determinacyLib.weakCheckEvents(result, at))
        next = withEvent(next, event, row => row.type === 'weak-check' && row.mutantId === event.mutantId && row.checkId === event.checkId
          && stable(row.resolves) === stable(event.resolves));
      next = { ...next, revision: stored.value.revision + 1, updatedAt: now() };
      try { save(next, stored.revision); break; }
      catch (cause) { if (attempt >= 2) throw cause; }
    }
    await inspect({ contractId });
    return structuredClone(result);
  }

  async function findById(contractId) {
    if (typeof contractId !== 'string' || !contractId) error('FLEET_V5_CONTRACT_SELECTOR_INVALID', 'contractId is required.');
    for (const key of store.memoryKeys({ namespace: NAMESPACE })) {
      if (key.startsWith(PART_KEY_PREFIX)) continue;
      const row = read(key);
      if (row?.value?.contractId === contractId) return row;
    }
    error('FLEET_V5_CONTRACT_NOT_FOUND', 'The retained Fleet V5 contract was not found.');
  }
  return Object.freeze({ options, review, library, submit, inspect, determinacy, answer, amend, cancel });
}

module.exports = Object.freeze({ createFleetV5Contracts, NAMESPACE });
