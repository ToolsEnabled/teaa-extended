'use strict';

const crypto = require('node:crypto');
const COST_DIMENSIONS = new Set(['quota', 'minutes', 'checks', 'failures', 'retries', 'rework', 'inputTokens', 'outputTokens', 'totalTokens', 'tokens', 'usd', 'milliUsd']);
const OBSERVATION_FIELDS = new Set(['candidateId', 'checked', 'outcome', 'totalCost', 'provenance', 'source', 'version', 'observedAt']);
const SUPPLY_FIELDS = new Set(['currentlyEligible', 'quotaAvailable', 'launchability', 'state', 'reason', 'source', 'version', 'computerId', 'runtimeRevision', 'available', 'health']);

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function plain(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function finiteNonnegative(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function finiteNumber(value) { return typeof value === 'number' && Number.isFinite(value); }
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function operationalSupplyMetadata(value) {
  if (value === undefined || value === null) return { fields: null, excludedFields: [] };
  if (!plain(value)) fail('FLEET_V5_SUPPLY_METADATA_INVALID', 'Supply metadata must be an object or null.');
  const fields = {}, excludedFields = [];
  for (const [key, entry] of Object.entries(value)) {
    if (!SUPPLY_FIELDS.has(key) || !(entry === null || ['string', 'number', 'boolean'].includes(typeof entry))) {
      excludedFields.push(key);
      continue;
    }
    if (typeof entry === 'string' && entry.length > 500) {
      excludedFields.push(key);
      continue;
    }
    fields[key] = entry;
  }
  return { fields, excludedFields };
}

// Observations count only checked outcomes. A worker's own completion report
// is not evidence of accepted success.
function summarize(candidate, rows) {
  const accepted = rows.filter(row => row.outcome === 'accepted').length;
  const costs = rows.map(row => row.totalCost).filter(plain);
  const dimensions = new Set(costs.flatMap(cost => Object.keys(cost)));
  const totalCost = {};
  let costKnown = costs.length === rows.length && rows.length > 0 && dimensions.size > 0;
  for (const dimension of dimensions) {
    const values = costs.map(cost => cost[dimension]);
    if (values.some(value => !finiteNonnegative(value))) costKnown = false;
    else totalCost[dimension] = values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  return { checkedTrials: rows.length, accepted, rate: rows.length ? accepted / rows.length : null,
    totalCost: costKnown ? totalCost : null, costKnown };
}

function satisfies(candidate, task, policy, eligible) {
  if (!candidate || typeof candidate.id !== 'string' || !plain(candidate.configuration)) return false;
  if (eligible && eligible(candidate, task) !== true) return false;
  const constraints = task.constraints || {};
  const config = candidate.configuration;
  if (task.productEffort !== undefined && config.productEffort !== task.productEffort) return false;
  if (task.userEffort !== undefined && config.userEffort !== task.userEffort) return false;
  if (task.vendorEffort !== undefined && config.vendorEffort !== task.vendorEffort) return false;
  if (task.provider !== undefined && config.provider !== task.provider) return false;
  if (task.model !== undefined && config.model !== task.model) return false;
  if (task.computerId !== undefined && config.computerId !== task.computerId) return false;
  if (Array.isArray(constraints.candidateIds) && !constraints.candidateIds.includes(candidate.id)) return false;
  const enforceableMaximum = Number.isSafeInteger(config.maxAgents) ? config.maxAgents
    : Number.isSafeInteger(config.workforce?.maxAgents) ? config.workforce.maxAgents
      : Number.isSafeInteger(config.agentCount) ? config.agentCount : null;
  const guaranteedMinimum = Number.isSafeInteger(config.minimumAgents) ? config.minimumAgents
    : Number.isSafeInteger(config.agentCount) ? config.agentCount : null;
  // A ceiling constraint is checked against the enforceable ceiling. Minimum
  // count and required roles use guaranteed initial members only; adaptive
  // allowed roles are future options, not selected workers.
  const maximumConstraint = Number.isSafeInteger(constraints.maxAgents) ? constraints.maxAgents
    : Number.isSafeInteger(task.resourceLimits?.maxAgents) ? task.resourceLimits.maxAgents : null;
  if (maximumConstraint !== null && (enforceableMaximum === null || enforceableMaximum > maximumConstraint)) return false;
  if (Number.isSafeInteger(constraints.minAgents)
      && (guaranteedMinimum === null || guaranteedMinimum < constraints.minAgents)) return false;
  if (Array.isArray(constraints.requiredRoles) && constraints.requiredRoles.some(role => !config.roles?.includes(role))) return false;
  if (Array.isArray(policy.allowedProviders) && !policy.allowedProviders.includes(config.provider)) return false;
  if (plain(constraints.minimumBenchmarkScores) && Object.entries(constraints.minimumBenchmarkScores).some(([benchmarkId, minimum]) => {
    const evidence = candidate.benchmarks?.find(row => row.benchmarkId === benchmarkId);
    return !finiteNumber(minimum) || !evidence || evidence.score < minimum;
  })) return false;
  return true;
}

/** Select a complete configuration without inventing evidence.
 *
 * Inputs: {task, policy, candidates, observations, eligible?}. `task` may
 * carry candidateIds/maxAgents/minAgents/requiredRoles constraints. maxAgents
 * checks the enforceable setup ceiling; minAgents and requiredRoles check only
 * guaranteed initial members in minimumAgents/agentCount and roles. Policy may
 * carry reliabilityTarget and baselineCandidateId. Candidates have
 * {id, configuration}; observations are verified checked outcomes with
 * {candidateId, checked:true, outcome, totalCost:{dimension:number}}.
 */
function selectConfiguration({ task, policy, candidates, observations = [], eligible } = {}) {
  if (!plain(task) || !plain(policy) || !Array.isArray(candidates) || !Array.isArray(observations))
    fail('FLEET_V5_SELECTION_INPUT_INVALID', 'Task, policy, candidates and observations are required.');
  if (candidates.some(candidate => !plain(candidate) || typeof candidate.id !== 'string' || !plain(candidate.configuration))
      || new Set(candidates.map(candidate => candidate.id)).size !== candidates.length)
    fail('FLEET_V5_SELECTION_CANDIDATE_INVALID', 'Candidates must have unique IDs and whole configuration objects.');
  if (observations.some(row => !plain(row)))
    fail('FLEET_V5_SELECTION_OBSERVATION_INVALID', 'Every outcome observation must be an object; none were silently skipped.');
  for (const row of observations) {
    const unsupported = Object.keys(row).filter(key => !OBSERVATION_FIELDS.has(key));
    if (unsupported.length) fail('FLEET_V5_SELECTION_OBSERVATION_FIELD_UNSUPPORTED', `Outcome evidence contains non-allowlisted fields: ${unsupported.join(', ')}.`);
    if (row.provenance !== undefined && (!plain(row.provenance)
        || Object.keys(row.provenance).some(key => !['source', 'version'].includes(key))
        || typeof row.provenance.source !== 'string' || typeof row.provenance.version !== 'string'))
      fail('FLEET_V5_SELECTION_OBSERVATION_PROVENANCE_INVALID', 'Outcome provenance may contain only source and version identifiers.');
    if (row.totalCost !== undefined && (!plain(row.totalCost)
        || Object.keys(row.totalCost).some(dimension => !COST_DIMENSIONS.has(dimension))))
      fail('FLEET_V5_SELECTION_COST_DIMENSION_UNSUPPORTED', 'Total-cost evidence uses a dimension outside the operational metric allowlist.');
  }
  if (policy.reliabilityTarget !== undefined
      && (typeof policy.reliabilityTarget !== 'number' || !Number.isFinite(policy.reliabilityTarget) || policy.reliabilityTarget < 0 || policy.reliabilityTarget > 1))
    fail('FLEET_V5_POLICY_INVALID', 'reliabilityTarget must be between zero and one.');
  if (policy.costWeights !== undefined && (!plain(policy.costWeights)
      || Object.values(policy.costWeights).some(weight => !finiteNonnegative(weight))))
    fail('FLEET_V5_POLICY_INVALID', 'costWeights must map declared cost dimensions to finite nonnegative weights.');
  if (plain(policy.costWeights)) {
    const unsupported = Object.keys(policy.costWeights).filter(dimension => !COST_DIMENSIONS.has(dimension));
    if (unsupported.length) fail('FLEET_V5_SELECTION_COST_DIMENSION_UNSUPPORTED', `Cost policy uses non-allowlisted operational metrics: ${unsupported.join(', ')}.`);
  }
  if (task.constraints?.minimumBenchmarkScores !== undefined && (!plain(task.constraints.minimumBenchmarkScores)
      || Object.values(task.constraints.minimumBenchmarkScores).some(minimum => !finiteNumber(minimum))))
    fail('FLEET_V5_SELECTION_CONSTRAINT_INVALID', 'minimumBenchmarkScores must map benchmark IDs to finite minimum scores.');
  if (task.constraints !== undefined) {
    const supported = new Set(['candidateIds', 'maxAgents', 'minAgents', 'requiredRoles', 'minimumBenchmarkScores']);
    const unsupported = Object.keys(task.constraints).filter(key => !supported.has(key));
    if (unsupported.length) fail('FLEET_V5_SELECTION_CONSTRAINT_UNSUPPORTED', `Selection cannot enforce these constraint fields: ${unsupported.join(', ')}.`);
    for (const field of ['maxAgents', 'minAgents']) if (task.constraints[field] !== undefined
        && (!Number.isSafeInteger(task.constraints[field]) || task.constraints[field] < 0))
      fail('FLEET_V5_SELECTION_CONSTRAINT_INVALID', `${field} must be a nonnegative whole number.`);
    for (const field of ['candidateIds', 'requiredRoles']) if (task.constraints[field] !== undefined
        && (!Array.isArray(task.constraints[field]) || task.constraints[field].some(value => typeof value !== 'string')))
      fail('FLEET_V5_SELECTION_CONSTRAINT_INVALID', `${field} must be an array of exact strings.`);
  }
  for (const candidate of candidates) {
    if (candidate.benchmarks !== undefined && (!Array.isArray(candidate.benchmarks)
        || candidate.benchmarks.some(row => !plain(row) || typeof row.benchmarkId !== 'string'
          || typeof row.score !== 'number' || !Number.isFinite(row.score) || !plain(row.provenance)
          || Object.keys(row.provenance).some(key => !['source', 'version'].includes(key))
          || typeof row.provenance.source !== 'string' || typeof row.provenance.version !== 'string')))
      fail('FLEET_V5_BENCHMARK_EVIDENCE_INVALID', `Candidate ${candidate.id} has benchmark scores without source/version provenance.`);
  }
  // Bucket checked observations once. Selection remains complete for the
  // resolver's whole current catalog without an arbitrary top-N or sample.
  const observationsByCandidate = new Map();
  const exclusionReasons = { unchecked: 0, outcomeNotAcceptedOrRejected: 0, unknownCandidate: 0, candidateIneligible: 0 };
  const candidateIds = new Set(candidates.map(candidate => candidate.id));
  for (const row of observations) {
    if (!candidateIds.has(row.candidateId)) { exclusionReasons.unknownCandidate++; continue; }
    if (row.checked !== true) { exclusionReasons.unchecked++; continue; }
    if (!['accepted', 'rejected'].includes(row.outcome)) { exclusionReasons.outcomeNotAcceptedOrRejected++; continue; }
    const rows = observationsByCandidate.get(row.candidateId) || [];
    rows.push(row);
    observationsByCandidate.set(row.candidateId, rows);
  }
  const eligibleCandidates = candidates.filter(candidate => satisfies(candidate, task, policy, eligible));
  if (!eligibleCandidates.length) fail('FLEET_V5_NO_ELIGIBLE_CONFIGURATION', 'No current candidate configuration satisfies the task constraints and eligibility check.');
  const eligibleIds = new Set(eligibleCandidates.map(candidate => candidate.id));
  for (const [candidateId, rows] of observationsByCandidate) if (!eligibleIds.has(candidateId)) exclusionReasons.candidateIneligible += rows.length;
  const effortValues = new Set(eligibleCandidates.map(candidate => JSON.stringify(candidate.configuration.productEffort ?? null)));
  const sameEffortPool = task.productEffort !== undefined || effortValues.size === 1;
  const summaries = eligibleCandidates.map(candidate => {
    const evidence = summarize(candidate, observationsByCandidate.get(candidate.id) || []);
    const requiredDimensions = Object.keys(policy.costWeights || {});
    if (requiredDimensions.some(dimension => !Object.hasOwn(evidence.totalCost || {}, dimension))) {
      evidence.costKnown = false;
      evidence.totalCost = null;
    }
    if (!sameEffortPool) { evidence.costKnown = false; evidence.totalCost = null; }
    return { candidate, evidence };
  });
  const target = policy.reliabilityTarget;
  const qualified = summaries.filter(row => target === undefined || (row.evidence.checkedTrials > 0 && row.evidence.rate >= target));
  const weights = plain(policy.costWeights) ? policy.costWeights : null;
  const comparable = qualified.filter(row => sameEffortPool && row.evidence.costKnown && weights
    && Object.keys(row.evidence.totalCost).length > 0
    && Object.keys(weights).length > 0
    && Object.keys(row.evidence.totalCost).every(dimension => finiteNonnegative(weights[dimension]))
    && Object.keys(weights).every(dimension => Object.hasOwn(row.evidence.totalCost, dimension)));
  let chosen, rationale, uncertainty;
  if (target !== undefined && comparable.length) {
    const dimensions = Object.keys(weights).sort();
    const score = row => dimensions.reduce((sum, key) => sum + row.evidence.totalCost[key] * weights[key], 0);
    chosen = [...comparable].sort((a, b) => score(a) - score(b) || a.candidate.id.localeCompare(b.candidate.id))[0];
    rationale = 'lowest-observed-total-cost-among-evidence-qualified';
    uncertainty = 'observed-checked-sample; explicit weighted declared dimensions; no independence or population-rate claim';
  } else {
    chosen = summaries.find(row => row.candidate.id === policy.baselineCandidateId);
    if (!chosen) fail('FLEET_V5_BASELINE_UNAVAILABLE', 'Evidence is insufficient for comparison and the declared baseline is not currently eligible.');
    rationale = 'declared-baseline-insufficient-comparable-evidence';
    uncertainty = summaries.some(row => row.evidence.checkedTrials === 0)
      ? 'cold-start-or-unknown-estimates-preserved' : 'insufficient-cost-or-reliability-evidence';
    if (target !== undefined && qualified.length && !comparable.length) uncertainty += '; cost-dimensions-not-explicitly-weighted-or-comparable';
  }
  const receipt = Object.freeze({ schema: 'ai.toolsenabled/fleet-v5-selection/v1', selectedCandidateId: chosen.candidate.id,
    configuration: structuredClone(chosen.candidate.configuration), rationale, reliabilityTarget: target ?? null,
    evidence: chosen.evidence, eligibleCandidateIds: eligibleCandidates.map(row => row.id),
    comparedCandidateEvidence: summaries.map(row => { const supply = operationalSupplyMetadata(row.candidate.supply);
      return { candidateId: row.candidate.id, ...row.evidence, supply: supply.fields, excludedSupplyFields: supply.excludedFields,
        benchmarkEvidence: structuredClone(row.candidate.benchmarks ?? []) }; }),
    observationCoverage: { received: observations.length,
      checkedOutcomesUsed: summaries.reduce((sum, row) => sum + row.evidence.checkedTrials, 0),
      excluded: observations.length - summaries.reduce((sum, row) => sum + row.evidence.checkedTrials, 0), excludedReasons: exclusionReasons },
    uncertainty: `${uncertainty}; benchmark-scores-retained-but-not-ranked-by-the-default-cost-selector${sameEffortPool ? '' : '; candidates-span-multiple-product-effort-settings'}`,
    productEffort: task.productEffort ?? chosen.candidate.configuration.productEffort ?? null,
    resourceLimits: structuredClone(task.resourceLimits || {}),
    effortPolicy: structuredClone(policy.effortPolicy ?? null),
    benchmarkPolicy: structuredClone(policy.benchmarkPolicy ?? null),
    evidenceDigest: digest(observations) });
  return Object.freeze({ selection: structuredClone(chosen.candidate.configuration), receipt });
}

module.exports = Object.freeze({ selectConfiguration, operationalSupplyMetadata });
