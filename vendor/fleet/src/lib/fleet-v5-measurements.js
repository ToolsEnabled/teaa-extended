'use strict';

const crypto = require('node:crypto');
const { FIELDS } = require('./fleet-usage');

const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const record = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const finiteNonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const word = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(value);
const version = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,119}$/.test(value);
const modelId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$/.test(value);
const currency = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value);
const quotaUnits = new Set(['tokens', 'requests', 'credits', 'messages', 'minutes', 'seconds', 'bytes', 'percent']);
const estimateSources = new Set(['api-pricing-estimate', 'external-pricing-table', 'local-estimator']);
const issueCodes = new Set(['token-total-conflict', 'cache-subset-conflict', 'reasoning-subset-conflict',
  'native-child-usage-unobserved', 'cumulative-counter-reset', 'cumulative-baseline-missing', 'usage-semantics-unknown']);

function fail(code, message) { throw Object.assign(new TypeError(message), { code }); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function configurationProjection(raw) {
  if (!record(raw)) fail('FLEET_V5_MEASUREMENT_CONFIGURATION_INVALID', 'A selected configuration object is required.');
  const result = {};
  if (own(raw, 'provider')) {
    if (!word(raw.provider)) fail('FLEET_V5_MEASUREMENT_CONFIGURATION_INVALID', 'The selected provider is not a safe provider token.');
    result.provider = raw.provider;
  }
  if (own(raw, 'model')) {
    if (raw.model !== '' && !modelId(raw.model)) fail('FLEET_V5_MEASUREMENT_CONFIGURATION_INVALID', 'The selected model is not a safe model identifier.');
    result.model = raw.model;
  }
  if (own(raw, 'tier')) {
    if (!modelId(raw.tier)) fail('FLEET_V5_MEASUREMENT_CONFIGURATION_INVALID', 'The selected tier is not a safe identifier.');
    result.tier = raw.tier;
  }
  if (own(raw, 'runtimeRevision')) {
    if (!version(raw.runtimeRevision)) fail('FLEET_V5_MEASUREMENT_CONFIGURATION_INVALID', 'The selected runtime revision is not a safe version token.');
    result.runtimeRevision = raw.runtimeRevision;
  }
  if (own(raw, 'agentCount')) {
    if (!count(raw.agentCount)) fail('FLEET_V5_MEASUREMENT_CONFIGURATION_INVALID', 'agentCount must be a nonnegative safe integer.');
    result.agentCount = raw.agentCount;
  }
  if (own(raw, 'roles')) {
    if (!Array.isArray(raw.roles) || raw.roles.some(role => !word(role)))
      fail('FLEET_V5_MEASUREMENT_CONFIGURATION_INVALID', 'roles must contain safe role tokens.');
    result.roles = [...raw.roles];
  }
  if (own(raw, 'minimumAgents')) {
    if (!count(raw.minimumAgents)) fail('FLEET_V5_MEASUREMENT_CONFIGURATION_INVALID', 'minimumAgents must be a nonnegative safe integer.');
    result.minimumAgents = raw.minimumAgents;
  }
  if (own(raw, 'coordination')) {
    const coordination = raw.coordination;
    if (word(coordination)) result.coordination = coordination;
    else if (record(coordination) && Object.keys(coordination).every(key => key === 'mode') && word(coordination.mode)) result.coordination = { mode: coordination.mode };
    else fail('FLEET_V5_MEASUREMENT_CONFIGURATION_INVALID', 'coordination must be a safe mode token or a mode object.');
  }
  if (own(raw, 'workforce')) {
    const workforce = raw.workforce;
    if (!record(workforce) || !['solo', 'adaptive'].includes(workforce.topology)
        || !count(workforce.maxAgents) || workforce.maxAgents < 1
        || !Array.isArray(workforce.allowedRoles) || workforce.allowedRoles.some(role => !word(role))
        || !Array.isArray(workforce.providers) || workforce.providers.some(provider => !word(provider))
        || !record(workforce.coordination) || Object.keys(workforce.coordination).some(key => key !== 'mode')
        || !word(workforce.coordination.mode)
        || own(workforce, 'rootRole') && !word(workforce.rootRole)
        || Object.keys(workforce).some(key => !['topology', 'rootRole', 'maxAgents', 'allowedRoles', 'providers', 'coordination'].includes(key)))
      fail('FLEET_V5_MEASUREMENT_CONFIGURATION_INVALID', 'workforce must use the supported topology, budget, roles, providers, and coordination mode.');
    result.workforce = { topology: workforce.topology, maxAgents: workforce.maxAgents,
      ...(own(workforce, 'rootRole') ? { rootRole: workforce.rootRole } : {}),
      allowedRoles: [...workforce.allowedRoles], providers: [...workforce.providers],
      coordination: { mode: workforce.coordination.mode } };
  }
  for (const key of ['productEffort', 'vendorEffort']) {
    if (!own(raw, key)) continue;
    const value = raw[key];
    if (!(value === null || typeof value === 'boolean' || finiteNonnegative(value) || word(value)))
      fail('FLEET_V5_MEASUREMENT_CONFIGURATION_INVALID', `${key} must be a safe scalar.`);
    result[key] = value;
  }
  return result;
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function addSafe(left, right) {
  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : null;
}
function jobDuration(job) {
  const items = Array.isArray(job?.items) ? job.items : [];
  const expected = count(job?.counts?.total) ? job.counts.total : null;
  let subtotal = 0, measured = 0, first = null, last = null;
  for (const item of items) {
    const start = timestamp(item?.startedAt), finish = timestamp(item?.finishedAt);
    if (start !== null && finish !== null && finish >= start) {
      subtotal = addSafe(subtotal, finish - start);
      if (subtotal === null) { measured = null; break; }
      measured++;
      first = first === null ? start : Math.min(first, start);
      last = last === null ? finish : Math.max(last, finish);
    }
  }
  const page = job?.page;
  const pageComplete = !page || (count(page.offset) && count(page.total) && count(page.returned)
    && page.offset === 0 && page.returned === page.total);
  const itemsComplete = pageComplete && expected !== null && items.length === expected && measured === items.length;
  return {
    measuredItemDurationMsSubtotal: measured === null || measured === 0 ? null : subtotal,
    measuredItems: measured,
    expectedItems: expected,
    complete: itemsComplete,
    ...(first !== null && last !== null ? { observedWallClockMs: last - first } : {}),
  };
}

function topology(job, workers) {
  const workerItems = Array.isArray(workers) ? workers : Array.isArray(workers?.items) ? workers.items : null;
  const workerPage = Array.isArray(workers) ? null : workers?.page;
  const workerPageComplete = !workerPage || (count(workerPage.offset) && count(workerPage.total)
    && count(workerPage.returned) && workerPage.offset === 0 && workerPage.returned === workerPage.total);
  if (!workerItems || !workerPageComplete || typeof job?.nodeId !== 'string')
    return { workerCount: null, maximumDepth: null, complete: false };
  const byId = new Map(workerItems.filter(row => record(row) && typeof row.nodeId === 'string').map(row => [row.nodeId, row]));
  if (!byId.has(job.nodeId)) return { workerCount: null, maximumDepth: null, complete: false };
  let maximumDepth = 0, complete = true;
  const included = [];
  for (const worker of byId.values()) {
    let current = worker, depth = 0;
    const seen = new Set();
    while (current && current.nodeId !== job.nodeId && current.parentNodeId) {
      if (seen.has(current.nodeId)) { complete = false; current = null; break; }
      seen.add(current.nodeId);
      current = byId.get(current.parentNodeId);
      depth++;
    }
    if (current?.nodeId === job.nodeId) { included.push(worker); maximumDepth = Math.max(maximumDepth, depth); }
    else if (worker.nodeId === job.nodeId) included.push(worker);
    else if (!current && worker.parentNodeId) complete = false;
  }
  return { workerCount: included.length, maximumDepth, complete };
}

function workforceProjection({ configuration, contractId, job, workers } = {}) {
  const policy = configuration?.workforce;
  if (!policy) return { status: 'not-configured', memberCount: null, minimumAgents: null,
    maximumAgents: null, roleCounts: {}, stateCounts: {}, complete: false };
  const workerItems = Array.isArray(workers) ? workers : Array.isArray(workers?.items) ? workers.items : null;
  const workerPage = Array.isArray(workers) ? null : workers?.page;
  const workerPageComplete = !workerPage || (count(workerPage.offset) && count(workerPage.total)
    && count(workerPage.returned) && workerPage.offset === 0 && workerPage.returned === workerPage.total);
  const pageComplete = Boolean(workerItems && workerPageComplete);
  const members = workerItems ? workerItems.filter(row => row?.workforceMembership?.contractId === contractId
    && typeof row.nodeId === 'string') : [];
  const rootPresent = members.some(row => row.nodeId === job?.nodeId);
  const complete = pageComplete && rootPresent;
  const minimumAgents = Number.isSafeInteger(configuration.minimumAgents) ? configuration.minimumAgents
    : policy.topology === 'solo' && Number.isSafeInteger(configuration.agentCount) ? configuration.agentCount : null;
  const maximumAgents = Number.isSafeInteger(configuration.maxAgents) ? configuration.maxAgents
    : Number.isSafeInteger(policy.maxAgents) ? policy.maxAgents : null;
  if (!complete) return { status: 'unknown', memberCount: null, minimumAgents, maximumAgents,
    roleCounts: {}, stateCounts: {}, complete: false };
  const countBy = (field, allow) => {
    const counts = new Map();
    for (const member of members) {
      const value = member[field];
      const key = typeof value === 'string' && allow(value) ? value : 'unknown';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
  };
  const memberCount = members.length;
  return { status: 'measured', memberCount, minimumAgents, maximumAgents,
    minimumSatisfied: minimumAgents === null ? null : memberCount >= minimumAgents,
    withinLimit: maximumAgents === null ? null : memberCount <= maximumAgents,
    roleCounts: countBy('role', word),
    stateCounts: countBy('state', value => ['starting', 'running', 'paused', 'stopped', 'completed', 'held', 'failed', 'removed'].includes(value)),
    complete: true };
}

function retryObservations(job) {
  const items = Array.isArray(job?.items) ? job.items : [];
  const expected = count(job?.counts?.total) ? job.counts.total : null;
  const page = job?.page;
  const pageComplete = !page || (count(page.offset) && count(page.total) && count(page.returned)
    && page.offset === 0 && page.returned === page.total);
  const fullNativeRead = typeof job?.id === 'string' && typeof job?.nodeId === 'string'
    && pageComplete && page?.returned === items.length && expected === items.length;
  let workerTurns = 0, additionalTurnsAfterInitial = 0, providerTurnFailures = 0;
  let turnsKnown = 0, failuresKnown = 0;
  for (const item of items) {
    if (count(item?.turns)) {
      workerTurns = addSafe(workerTurns, item.turns);
      additionalTurnsAfterInitial = addSafe(additionalTurnsAfterInitial, Math.max(0, item.turns - 1));
      turnsKnown++;
    }
    if (count(item?.failures)) {
      providerTurnFailures = addSafe(providerTurnFailures, item.failures);
      failuresKnown++;
    } else if (!own(item, 'failures') && fullNativeRead && count(item?.turns)
        && Number.isSafeInteger(item?.taskRevision) && item.taskRevision > 0
        && Number.isSafeInteger(item?.n) && item.n > 0
        && ['queued', 'active', 'done', 'held'].includes(item.status)) {
      // Native job-read omits failures when its retained count is zero.
      // Only a complete native item record establishes that omission as zero.
      failuresKnown++;
    }
  }
  return {
    workerTurns: turnsKnown === items.length && workerTurns !== null ? workerTurns : null,
    additionalTurnsAfterInitial: turnsKnown === items.length && additionalTurnsAfterInitial !== null ? additionalTurnsAfterInitial : null,
    providerTurnFailures: failuresKnown === items.length && providerTurnFailures !== null ? providerTurnFailures : null,
    observedItems: items.length,
    expectedItems: expected,
    complete: pageComplete && expected !== null && items.length === expected && turnsKnown === items.length && failuresKnown === items.length,
  };
}

function jobOutcome(job) {
  const allowedStatuses = ['queued', 'active', 'done', 'held'];
  const itemStatuses = Object.fromEntries(allowedStatuses.map(status => [status, 0]));
  let reportedItems = 0;
  for (const item of Array.isArray(job?.items) ? job.items : []) {
    if (own(itemStatuses, item?.status)) itemStatuses[item.status]++;
    if (item?.outcome?.reported === true) reportedItems++;
  }
  const assessmentCounts = {};
  for (const key of ['accepted', 'rework', 'rejected', 'unassessed'])
    if (count(job?.outcomes?.[key])) assessmentCounts[key] = job.outcomes[key];
  const observedItems = Array.isArray(job?.items) ? job.items.length : 0;
  const expectedItems = count(job?.counts?.total) ? job.counts.total : null;
  const page = job?.page;
  const pageComplete = !page || (count(page.offset) && count(page.total) && count(page.returned)
    && page.offset === 0 && page.returned === page.total);
  return { jobState: ['running', 'idle', 'paused', 'closed', 'removed'].includes(job?.state) ? job.state : 'unknown',
    itemStatuses, reportedItems, itemAssessmentCounts: assessmentCounts, observedItems, expectedItems,
    complete: pageComplete && expectedItems !== null && observedItems === expectedItems, contractAcceptance: 'unknown' };
}

function verificationProjection(verification, evaluatorVersion, taskRevision, verificationTaskRevision) {
  const isNative = record(verification) && (verification.verifiedBy === 'Fleet' || verification.source === 'Fleet')
    && ['verifying', 'passed', 'failed'].includes(verification.status) && Array.isArray(verification.checks);
  if (!isNative) return { status: 'unknown', revisionBinding: 'unbound', evaluator: null, plannedChecks: null,
    executedChecks: null, passedChecks: null, failedChecks: null, notRunChecks: null, unknownChecks: null };
  const revisionBinding = Number.isSafeInteger(taskRevision) && taskRevision > 0
    && Number.isSafeInteger(verificationTaskRevision) && verificationTaskRevision > 0
    ? taskRevision === verificationTaskRevision ? 'matched' : 'mismatch' : 'unbound';
  const counts = { passed: 0, failed: 0, not_run: 0, unknown: 0 };
  let executed = 0;
  for (const check of verification.checks) {
    const status = ['passed', 'failed', 'not_run', 'unknown'].includes(check?.status) ? check.status : 'unknown';
    counts[status]++;
    if (Number.isSafeInteger(check?.exitCode)) executed++;
  }
  return { status: revisionBinding === 'matched' ? verification.status : 'unknown',
    ...(revisionBinding !== 'matched' ? { observedStatus: verification.status } : {}), revisionBinding,
    evaluator: { source: 'Fleet', version: version(evaluatorVersion) ? evaluatorVersion : null },
    plannedChecks: verification.checks.length, executedChecks: executed, passedChecks: counts.passed,
    failedChecks: counts.failed, notRunChecks: counts.not_run, unknownChecks: counts.unknown };
}

function quotaProjection(quota) {
  const sub = quota?.subscription;
  const provenance = sub && ['provider-subscription', 'vendor-subscription'].includes(sub.source) && version(sub.version);
  const unit = quotaUnits.has(sub?.unit) ? sub.unit : null;
  const used = finiteNonnegative(sub?.used) ? sub.used : null;
  const limit = finiteNonnegative(sub?.limit) ? sub.limit : null;
  if (!provenance || !unit || used === null || limit === null)
    return { subscription: { status: 'unknown', used: null, limit: null, unit: null, provenance: null } };
  return { subscription: { status: 'measured', used, limit, unit,
    provenance: { source: sub.source, version: sub.version } } };
}

function estimateProjection(estimate) {
  if (!estimate || !estimateSources.has(estimate.source) || !version(estimate.version)
      || !finiteNonnegative(estimate.amount) || !currency(estimate.currency))
    return { status: 'unknown', amount: null, currency: null, provenance: null };
  return { status: 'estimate', amount: estimate.amount, currency: estimate.currency,
    provenance: { source: estimate.source, version: estimate.version } };
}

function usageProjection(usage, usageQuery, job, contractId) {
  if (contractId !== undefined && (typeof contractId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(contractId)))
    fail('FLEET_V5_MEASUREMENT_CONTRACT_ID_INVALID', 'contractId is an internal binding selector and must be a bounded retained identifier.');
  const items = Array.isArray(usage?.items) ? usage.items : null;
  const matchingJobQuery = usageQuery?.action === 'usage-read' && typeof usageQuery.id === 'string'
    && typeof job?.id === 'string' && usageQuery.id === job.id
    && (!items || items.every(item => item?.jobId === job.id));
  const page = usage?.page;
  const completeContractPage = record(page) && page.offset === 0 && count(page.total)
    && page.total === items?.length && page.nextOffset === null;
  const matchingContractRows = items !== null && items.every(item => item?.contractId === contractId
    && (usageQuery?.id === undefined || item?.jobId === usageQuery.id)
    && (usageQuery?.nodeId === undefined || item?.nodeId === usageQuery.nodeId)
    && (usageQuery?.expectedTaskRevision === undefined || item?.taskRevision === usageQuery.expectedTaskRevision));
  const hasNarrowingSelector = usageQuery?.id !== undefined || usageQuery?.nodeId !== undefined
    || usageQuery?.expectedTaskRevision !== undefined;
  const matchingContractQuery = contractId !== undefined && usageQuery?.action === 'usage-read'
    && usageQuery.contractId === contractId && matchingContractRows
    && ['retained-contract-attempts', 'recent-contract-attempts', 'recent-worker-attempts'].includes(usage?.scope);
  const mismatchedContractQuery = contractId !== undefined && usageQuery?.contractId !== undefined
    && usageQuery.contractId !== contractId;
  const attributable = !mismatchedContractQuery && (matchingContractQuery || matchingJobQuery);
  const fullContractQuery = matchingContractQuery && !hasNarrowingSelector && completeContractPage
    && usage?.scope === 'retained-contract-attempts' && (usage?.archivedEvents ?? 0) === 0;
  const attribution = fullContractQuery ? 'contract-scoped' : matchingContractQuery ? 'contract-scoped-subset'
    : attributable ? 'job-scoped' : 'unknown';
  const contractScopeComplete = contractId === undefined || fullContractQuery
    && usage?.coverage?.unattributedContractAttempts === 0;
  const tokenFields = {};
  for (const field of FIELDS) {
    const raw = usage?.tokens?.[field];
    const known = count(raw?.known);
    const measuredAttempts = count(raw?.measuredAttempts) ? raw.measuredAttempts : null;
    const unknownAttempts = count(raw?.unknownAttempts) ? raw.unknownAttempts : null;
    const globalCoverage = usage?.coverage;
    const coverageClean = globalCoverage && count(globalCoverage.lostEvents) && globalCoverage.lostEvents === 0
      && count(globalCoverage.skippedEvents) && globalCoverage.skippedEvents === 0
      && count(globalCoverage.nativeChildAttempts) && globalCoverage.nativeChildAttempts === 0
      && count(globalCoverage.legacyEvents) && globalCoverage.legacyEvents === 0
      && (contractId === undefined || count(globalCoverage.unattributedContractAttempts)
        && globalCoverage.unattributedContractAttempts === 0);
    tokenFields[field] = {
      subtotal: attributable && known ? raw.known : null,
      measuredAttempts: attributable ? measuredAttempts : null,
      unknownAttempts: attributable ? unknownAttempts : null,
      complete: attributable && contractScopeComplete && raw?.complete === true && coverageClean,
    };
  }
  const coverage = {};
  for (const field of ['lostEvents', 'skippedEvents', 'legacyEvents', 'nativeChildAttempts', 'unattributedContractAttempts'])
    coverage[field] = count(usage?.coverage?.[field]) ? usage.coverage[field] : null;
  coverage.archivedEvents = count(usage?.archivedEvents) ? usage.archivedEvents : 0;
  const issues = new Set();
  for (const item of items || []) for (const code of item?.issues || []) if (issueCodes.has(code)) issues.add(code);
  const reportedActualCosts = (contractId === undefined && Array.isArray(usage?.reportedCosts) ? usage.reportedCosts : [])
    .filter(row => finiteNonnegative(row?.amount) && currency(row?.currency))
    .map(row => ({ amount: row.amount, currency: row.currency,
      allocation: row.scope === 'session-reported-unallocated' ? 'session-unallocated' : 'unknown',
      provenance: 'provider-reported' }));
  const complete = attributable && contractScopeComplete && FIELDS.every(field => tokenFields[field].complete);
  return { attribution, complete, attempts: attributable && count(usage?.attempts) ? usage.attempts : null,
    tokenAccounting: 'native-provider-reported', tokens: tokenFields, coverage,
    issues: [...issues].sort(), reportedActualCosts };
}

/** Strict content-free projection for grouping operational observations.
 * usageQuery must be the actual native usage-read request. Bind job reads to
 * job.id or managed-team reads to the explicit internal contractId. Local join
 * identities are consumed for attribution and omitted from the returned record.
 */
function projectOperationalObservation({ configuration, runtimeRevision, policyVersion, usage, usageQuery,
  job, workers, contractId, verification, taskRevision, verificationTaskRevision, quota, apiEquivalentEstimate, evaluatorVersion } = {}) {

  const safeConfiguration = configurationProjection(configuration);
  if (!version(runtimeRevision) || !version(policyVersion))
    fail('FLEET_V5_MEASUREMENT_VERSION_INVALID', 'runtimeRevision and policyVersion must be safe version tokens.');
  if (safeConfiguration.runtimeRevision && safeConfiguration.runtimeRevision !== runtimeRevision)
    fail('FLEET_V5_MEASUREMENT_VERSION_INVALID', 'The selected configuration runtimeRevision must match the observation runtimeRevision.');
  const groupingFingerprint = crypto.createHash('sha256').update(stable({ configuration: safeConfiguration,
    runtimeRevision, policyVersion })).digest('hex');
  return Object.freeze({ schema: 'ai.toolsenabled/fleet-v5-operational-observation/v1',
    configuration: safeConfiguration, runtimeRevision, policyVersion, groupingFingerprint,
    usage: usageProjection(usage, usageQuery, job, contractId),
    workerTopology: topology(job, workers), retryObservations: retryObservations(job),
    durations: jobDuration(job), outcomes: jobOutcome(job),
    workforce: workforceProjection({ configuration: safeConfiguration, contractId, job, workers }),
    checkedVerification: verificationProjection(verification, evaluatorVersion, taskRevision, verificationTaskRevision),
    subscriptionQuota: quotaProjection(quota), apiEquivalentEstimate: estimateProjection(apiEquivalentEstimate) });
}

module.exports = Object.freeze({ projectOperationalObservation, workforceProjection });
