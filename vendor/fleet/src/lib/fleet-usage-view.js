'use strict';
const { FIELDS, ISSUE_CODES, COVERAGE_ISSUES, count, normalize, issues } = require('./fleet-usage');
const terminal = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'stopped', 'uncertain']);
const formats = new Set(['canonical', 'anthropic', 'codex', 'acp']);
const sessionKey = row => JSON.stringify([row.nodeId, row.provider, row.sessionId, row.threadId]);
const turnKey = row => JSON.stringify([row.nodeId, row.sessionId, row.threadId, row.turnId]);
const fields = ['attemptId', 'nodeId', 'sessionId', 'threadId', 'turnId', 'provider', 'model', 'jobId', 'contractId', 'taskRevision'];
const metadata = row => Object.fromEntries(fields.filter(key => row[key] !== undefined).map(key => [key, row[key]]));
function createUsageView(document) {
  let prior = [], attempts = new Map(), turns = new Map(), counters = new Map(), costs = new Map(), legacyEvents = 0;
  let sessionGaps = new Map(), unallocated = new Map();
  function consume(row) {
    const session = sessionKey(row);
    if (row.type === 'started') {
      // Only a confirmed new provider conversation begins at zero. A resumed
      // thread needs a measured baseline; its first cumulative sample is not
      // charged as this run's work, nor is `last` mistaken for a whole turn.
      if (row.freshThread === true) counters.set(session, Object.fromEntries(FIELDS.map(key => [key, 0])));
      return;
    }
    if (row.type === 'closed') {
      // A retired session can deliver no further callbacks. Only attempts that exist now are covered by it.
      for (const attempt of attempts.values()) if (sessionKey(attempt) === session) attempt.sessionRetired = true;
      return;
    }
    if (!['turn_started', 'turn_accepted', 'usage', 'usage_gap', 'turn_completed', 'turn_failed'].includes(row.type)) return;
    if (row.type === 'usage' && row.usageScope === 'session-unallocated'
        || row.type === 'usage_gap' && !row.attemptId && !row.turnId) {
      sessionGaps.set(session, metadata(row)); counters.delete(session);
      if (row.type === 'usage' && row.usageSampleId && formats.has(row.usageFormat)) {
        const { jobId, contractId, taskRevision, attemptId, turnId, ...identity } = metadata(row);
        unallocated.set(JSON.stringify([session, row.usageSampleId]), { ...identity,
          tokens: normalize(row.usage, row.usageFormat) });
      }
      return;
    }
    let key = row.attemptId || turns.get(turnKey(row));
    if (!key && row.turnId) { key = 'legacy:' + turnKey(row); legacyEvents++; }
    if (!key) { legacyEvents++; return; }
    let attempt = attempts.get(key);
    if (!attempt) {
      attempt = { ...metadata(row), attemptId: key, at: row.at, status: 'in-progress', tokens: {}, fieldComplete: {},
        baseline: { ...(counters.get(session) || {}) }, issues: [], usageSamples: 0 };
      attempts.set(key, attempt);
    }
    Object.assign(attempt, metadata(row));
    if (row.turnId) turns.set(turnKey(row), key);
    if (row.type === 'usage_gap') {
      for (const code of COVERAGE_ISSUES) if (row.coverageIssues?.includes(code) && !attempt.issues.includes(code)) attempt.issues.push(code);
      // Only a host that reports the gap also reports later session callbacks as unallocated usage.
      if (row.coverageIssues?.includes('session-usage-not-turn-bounded')) attempt.gapSignalled = true;
      return;
    }
    if (row.type === 'turn_completed' || row.type === 'turn_failed') {
      attempt.status = terminal.has(row.status) ? row.status : 'unknown'; attempt.finishedAt = row.at;
      // Retained Claude results from older hosts predate the explicit gap
      // signal. They have the same unbounded callback seam, not better proof.
      if (row.provider === 'claude' && !attempt.issues.includes('session-usage-not-turn-bounded'))
        attempt.issues.push('session-usage-not-turn-bounded');
      // A send with no measurement may still have consumed tokens. Do not
      // allocate those tokens to the next task from an older baseline.
      if (!attempt.usageSamples) counters.delete(session);
    }
    if (row.type !== 'usage') return;
    const format = formats.has(row.usageFormat) ? row.usageFormat : row.provider === 'codex' ? 'codex' : row.provider === 'claude' ? 'anthropic' : null;
    const scope = row.usageScope || (format === 'codex' ? 'thread-snapshot' : format === 'anthropic' ? 'turn-snapshot' : null);
    if (scope === 'context-snapshot') {
      // ACP used/size describes context occupancy, not consumed tokens. Cost
      // is a cumulative provider report, retained separately by session.
      if (row.usage?.cost) {
        const { jobId, contractId, taskRevision, attemptId, turnId, ...identity } = metadata(row);
        costs.set(JSON.stringify([session, row.usage.cost.currency]), { ...identity, ...row.usage.cost, scope: 'session-reported-unallocated' });
      }
      return;
    }
    if (!format || !scope) { if (!attempt.issues.includes('usage-semantics-unknown')) attempt.issues.push('usage-semantics-unknown'); return; }
    const tokens = normalize(scope === 'thread-snapshot' ? row.usage?.total : row.usage?.last || row.usage, format);
    for (const issue of [...issues(tokens, format), ...(row.usageIssues || [])]) if (!attempt.issues.includes(issue)) attempt.issues.push(issue);
    attempt.usageSamples = row.usageSamples || 1;
    for (const field of FIELDS) {
      if (scope === 'thread-snapshot') {
        const base = attempt.baseline[field], value = tokens[field];
        if (count(base) && count(value) && value >= base) {
          attempt.tokens[field] = value - base; attempt.fieldComplete[field] = true;
        } else {
          delete attempt.tokens[field]; attempt.fieldComplete[field] = false;
          const issue = count(base) && count(value) && value < base ? 'cumulative-counter-reset' : count(value) ? 'cumulative-baseline-missing' : null;
          if (issue && !attempt.issues.includes(issue)) attempt.issues.push(issue);
        }
      } else {
        if (count(tokens[field])) attempt.tokens[field] = tokens[field]; else delete attempt.tokens[field];
        attempt.fieldComplete[field] = count(tokens[field]) && (!row.usageCoverage || row.usageCoverage[field] === row.usageSamples);
      }
    }
    if (scope === 'thread-snapshot') counters.set(session, tokens);
  }
  function update() {
    const entries = document.fleetMetrics?.entries || [];
    if (entries.length < prior.length || prior.length && entries[prior.length - 1] !== prior.at(-1)) {
      prior = []; attempts = new Map(); turns = new Map(); counters = new Map(); costs = new Map(); legacyEvents = 0;
      sessionGaps = new Map(); unallocated = new Map();
    }
    for (let n = prior.length; n < entries.length; n++) consume(entries[n]);
    prior = entries;
  }
  function summary(input = {}) {
    update();
    if (Object.hasOwn(input, 'contractId') && (typeof input.contractId !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.contractId)))
      throw Object.assign(new TypeError('contractId must be a bounded retained contract identifier.'), { code: 'FLEET_USAGE_CONTRACT_ID_INVALID' });
    const selected = [...attempts.values()].filter(row => (!input.nodeId || row.nodeId === input.nodeId)
      && (!input.id || row.jobId === input.id)
      && (input.contractId === undefined || row.contractId === input.contractId)
      && (input.expectedTaskRevision === undefined || row.taskRevision === input.expectedTaskRevision));
    const unattributedContractAttempts = [...attempts.values()].filter(row => row.contractId === undefined).length;
    const lostEvents = (document.fleetMetrics?.lostEvents || 0), skippedEvents = document.fleetMetrics?.skippedEvents || 0;
    const selectedSessions = new Set(selected.map(sessionKey));
    const scoped = input.id || input.contractId !== undefined || input.expectedTaskRevision !== undefined;
    const sessionUsageGaps = [...sessionGaps].filter(([key, row]) => (!input.nodeId || row.nodeId === input.nodeId)
      && (!scoped || selectedSessions.has(key))).length;
    const tokens = {};
    for (const field of FIELDS) {
      let known = 0, measured = 0, complete = 0, overflow = false;
      for (const row of selected) if (count(row.tokens[field])) {
        known += row.tokens[field]; measured++;
        if (!Number.isSafeInteger(known)) overflow = true;
        if (row.fieldComplete[field] && terminal.has(row.status) && !sessionGaps.has(sessionKey(row))
            && !row.issues.some(issue => ISSUE_CODES.includes(issue) || COVERAGE_ISSUES.includes(issue)
              && !(issue === 'session-usage-not-turn-bounded' && row.sessionRetired && row.gapSignalled))) complete++;
      }
      tokens[field] = { known: measured && !overflow ? known : null, measuredAttempts: measured,
        unknownAttempts: selected.length - complete,
        complete: selected.length > 0 && complete === selected.length && !(input.contractId !== undefined && unattributedContractAttempts)
          && !lostEvents && !skippedEvents && !legacyEvents && !sessionUsageGaps && !overflow };
    }
    const statuses = {};
    for (const row of selected) statuses[row.status] = (statuses[row.status] || 0) + 1;
    const offset = input.offset || 0, limit = input.limit || 100;
    const reports = new Map();
    if (!input.id && input.contractId === undefined && input.expectedTaskRevision === undefined) {
      for (const sample of unallocated.values()) {
        if (input.nodeId && sample.nodeId !== input.nodeId) continue;
        const key = sessionKey(sample), { tokens: values, ...identity } = sample;
        if (!reports.has(key)) reports.set(key, { ...identity, scope: 'session-unallocated', samples: [] });
        reports.get(key).samples.push(values);
      }
    }
    const reportedUsage = [...reports.values()].map(({ samples, ...identity }) => ({ ...identity, samples: samples.length,
      tokens: Object.fromEntries(FIELDS.map(field => {
        const measured = samples.filter(value => count(value[field]));
        const known = measured.reduce((total, value) => total + value[field], 0);
        return [field, { known: measured.length && count(known) ? known : null, measuredSamples: measured.length,
          unknownSamples: samples.length - measured.length, complete: false }];
      })) }));
    const result = { scope: input.contractId === undefined ? 'retained-worker-attempts' : 'retained-contract-attempts', attempts: selected.length, statuses, tokens,
      coverage: { lostEvents, skippedEvents, legacyEvents,
        nativeChildAttempts: selected.filter(row => row.issues.includes('native-child-usage-unobserved')).length,
        unattributedContractAttempts, sessionUsageGaps },
      lead: { observed: false, reason: 'The external lead provider does not send its usage through this worker host.' },
      wholeRun: { tokens: null, cost: null, complete: false },
      reportedCosts: input.id || input.contractId !== undefined || input.expectedTaskRevision !== undefined ? [] : [...costs.values()].filter(row => !input.nodeId || row.nodeId === input.nodeId),
      reportedUsage,
      costAllocation: 'Session reports can include earlier work and are not allocated to jobs or tasks.',
      pricing: 'No price, subscription quota, or unreported cost is inferred.' };
    if (input.view === 'full') {
      result.items = selected.slice(offset, offset + limit).map(({ baseline, gapSignalled, ...row }) => structuredClone(row));
      result.page = { offset, limit, total: selected.length, nextOffset: offset + limit < selected.length ? offset + limit : null };
    }
    return result;
  }
  return { summary };
}
module.exports = { createUsageView };
