'use strict';
const os = require('os');
function validOverrides(value) {
  if (!Array.isArray(value)) return false;
  const seen = new Set();
  return value.every(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['kind', 'id', 'enabled'].includes(key))
      || !['agent', 'lane', 'host'].includes(row.kind) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(row.id) || typeof row.enabled !== 'boolean') return false;
    const key = `${row.kind}:${row.id}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
function statusEnabled(global, overrides, identity) {
  if (typeof global !== 'boolean' || !validOverrides(overrides)) return false;
  for (const kind of ['agent', 'lane', 'host']) {
    const row = overrides.find(row => row.kind === kind && row.id === identity[kind]);
    if (row) return row.enabled;
  }
  return global;
}
const TOKEN_KEYS = new Set(['input_tokens', 'output_tokens', 'total_tokens', 'cached_input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'cacheWriteInputTokens', 'cachedReadTokens', 'cachedWriteTokens', 'thoughtTokens', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'used', 'size']);
function usageNumbers(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    if (TOKEN_KEYS.has(key) && Number.isSafeInteger(value) && value >= 0) result[key] = value;
    else if (['total', 'last'].includes(key) && value && typeof value === 'object') {
      const nested = usageNumbers(value); if (Object.keys(nested).length) result[key] = nested;
    }
  }
  if (raw.cost && typeof raw.cost.amount === 'number' && Number.isFinite(raw.cost.amount) && raw.cost.amount >= 0
      && typeof raw.cost.currency === 'string' && /^[A-Z]{3}$/.test(raw.cost.currency)) result.cost = { amount: raw.cost.amount, currency: raw.cost.currency };
  return result;
}
function createObservability({ document, persist, history: archive, read = id => require('./settings').loadSettings({ ids: [id] }).values[id],
  laneId, hostId = os.hostname(), now = () => new Date().toISOString(), machine = os } = {}) {
  let previousCpu = null, lostEvents = 0, skippedEvents = 0;
  const usageView = require('./fleet-usage-view').createUsageView(document);
  const enabled = () => { try { return read('metrics.local_history') === true; } catch { return false; } };
  function record(event) {
    if (!['started', 'closed', 'usage', 'usage_gap', 'turn_started', 'turn_accepted', 'turn_completed', 'turn_failed'].includes(event.type)) return;
    if (!enabled()) { skippedEvents++; return; }
    const row = { type: event.type, at: now() };
    for (const key of ['nodeId', 'sessionId', 'threadId', 'turnId', 'provider', 'attemptId', 'jobId'])
      if (typeof event[key] === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(event[key])) row[key] = event[key];
    // null is a new native attempt explicitly outside a managed contract;
    // absence is historical or otherwise unknown attribution.
    if (event.contractId === null || typeof event.contractId === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(event.contractId)) row.contractId = event.contractId;
    if (typeof event.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$/.test(event.model)) row.model = event.model;
    if (Number.isSafeInteger(event.taskRevision) && event.taskRevision > 0) row.taskRevision = event.taskRevision;
    if (typeof event.freshThread === 'boolean') row.freshThread = event.freshThread;
    if (event.type === 'usage_gap') {
      row.coverageIssues = require('./fleet-usage').COVERAGE_ISSUES.filter(code => Array.isArray(event.coverageIssues) && event.coverageIssues.includes(code));
      if (!row.coverageIssues.length) return;
    }
    if (event.type === 'usage') {
      row.usage = usageNumbers(event.usage);
      if (['canonical', 'anthropic', 'codex', 'acp'].includes(event.usageFormat)) row.usageFormat = event.usageFormat;
      if (['turn-snapshot', 'thread-snapshot', 'context-snapshot', 'session-unallocated'].includes(event.usageScope)) row.usageScope = event.usageScope;
      if (typeof event.usageSampleId === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(event.usageSampleId)) row.usageSampleId = event.usageSampleId;
      if (Number.isSafeInteger(event.usageSamples) && event.usageSamples > 0) row.usageSamples = event.usageSamples;
      if (event.usageCoverage) row.usageCoverage = Object.fromEntries(require('./fleet-usage').FIELDS.filter(key => Number.isSafeInteger(event.usageCoverage[key]) && event.usageCoverage[key] >= 0).map(key => [key, event.usageCoverage[key]]));
      if (Array.isArray(event.usageIssues)) row.usageIssues = require('./fleet-usage').ISSUE_CODES.filter(code => event.usageIssues.includes(code));
    }
    if (['completed', 'failed', 'interrupted', 'cancelled', 'stopped', 'uncertain'].includes(event.status)) row.status = event.status;
    const before = document.fleetMetrics;
    const entries = Array.isArray(before?.entries) ? before.entries : [];
    // Numeric metadata is separate from the retained provider/session traces.
    document.fleetMetrics = require('./fleet-state-draft').produce({ v: 2, revision: (before?.revision || entries.length) + 1, lostEvents: (before?.lostEvents || 0) + lostEvents, skippedEvents: (before?.skippedEvents || 0) + skippedEvents, entries }, draft => { draft.entries.push(row); });
    try { persist(document); lostEvents = 0; skippedEvents = 0; } catch (error) { document.fleetMetrics = before; lostEvents++; throw error; }
  }
  function history({ offset = 0, limit = 100, expectedHistoryRevision } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw Object.assign(new Error('Use a nonnegative offset and a limit from 1 to 1000.'), { code: 'FLEET_METRICS_PAGE_INVALID' });
    if (!enabled()) return { enabled: false, entries: [], total: 0, retained: true };
    if (archive) { const result = archive.historyPage(document, { kind: 'metrics', offset, limit, expectedHistoryRevision }); return { enabled: true, ...result, total: result.page.total }; }
    const entries = document.fleetMetrics?.entries || [];
    return { enabled: true, total: entries.length, entries: structuredClone(entries.slice(offset, offset + limit)) };
  }
  function summary(input = {}) {
    if (Object.hasOwn(input, 'contractId') && (typeof input.contractId !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.contractId)))
      throw Object.assign(new TypeError('contractId must be a bounded retained contract identifier.'), { code: 'FLEET_USAGE_CONTRACT_ID_INVALID' });
    const { offset = 0, limit = 100, expectedMetricsRevision } = input;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw Object.assign(new Error('Use a nonnegative offset and a limit from 1 to 1000.'), { code: 'FLEET_METRICS_PAGE_INVALID' });
    const revision = document.fleetMetrics?.revision || document.fleetMetrics?.entries?.length || 0;
    if (expectedMetricsRevision !== undefined && expectedMetricsRevision !== revision)
      throw Object.assign(new Error('Usage changed; read a new metrics revision before continuing pages.'), { code: 'FLEET_METRICS_STALE_REVISION' });
    if (!enabled()) return { enabled: false, revision, retained: true, wholeRun: { tokens: null, cost: null, complete: false } };
    const result = usageView.summary(input);
    result.coverage.lostEvents += lostEvents; result.coverage.skippedEvents += skippedEvents;
    if (lostEvents || skippedEvents) for (const field of Object.values(result.tokens)) field.complete = false;
    const archivedEvents = archive ? archive.historyCount('metrics') : 0;
    return { enabled: true, revision, ...result, ...(archive ? {
      metricsEvents: (document.fleetMetrics?.entries?.length || 0) + archivedEvents,
      archivedEvents, history: { action: 'history-read', kind: 'metrics' },
      scope: input.contractId === undefined ? 'recent-worker-attempts'
        : archivedEvents > 0 ? 'recent-contract-attempts' : 'retained-contract-attempts',
    } : {}) };
  }
  function introduction(node) {
    let global, overrides;
    try { global = read('agent.status_injection'); overrides = read('agent.status_injection_overrides'); } catch { return ''; }
    if (!statusEnabled(global, overrides, { agent: node.nodeId, lane: laneId, host: hostId })) return '';
    const cpu = machine.cpus().reduce((out, row) => {
      out.idle += row.times.idle; out.total += Object.values(row.times).reduce((sum, value) => sum + value, 0); return out;
    }, { idle: 0, total: 0 });
    const delta = previousCpu && cpu.total - previousCpu.total;
    const percentage = delta > 0 ? Math.max(0, Math.min(100, 100 * (1 - (cpu.idle - previousCpu.idle) / delta))) : null;
    previousCpu = cpu;
    return ['Machine status (opted in; unknown measurements are not inferred):',
      `CPU: ${percentage === null ? 'unknown (first sample)' : percentage.toFixed(1) + '%'}. Memory free/total: ${machine.freemem()}/${machine.totalmem()} bytes.`,
      'State health: unknown. Audit health: unknown. Owner-request capture backlog: unknown. Usage/quota availability: unknown.'].join('\n');
  }
  return Object.freeze({ record, history, summary, introduction });
}
module.exports = { createObservability, statusEnabled, validOverrides, usageNumbers };
