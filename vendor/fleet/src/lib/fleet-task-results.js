'use strict';

// Worker evidence remains a claim. Fleet separately verifies lead-owned commands;
// explicit lead assessment still records acceptance of the wider contract.
const { assertValid } = require('./schema-validator');
const string = { type: 'string', minLength: 1 };
const id = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9][a-z0-9_-]*$' };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const array = items => ({ type: 'array', items });
const referenceSchema = object({ id, reference: string, description: string }, ['id', 'reference']);
const requirementsSchema = object({ scope: string, workspaceRoot: string,
  inputs: array(referenceSchema), outputs: array(object({ id, description: string, path: string }, ['id', 'description'])),
  checks: array(object({ id, description: string, command: { ...string, description: 'Lead-only shell command, run by the host in the assignment workspace after complete.' },
    timeoutSeconds: { type: 'integer', minimum: 1, maximum: 3600, default: 600 } }, ['id', 'description'])) });
const resultSchema = object({ artifacts: array(referenceSchema),
  checks: array(object({ id, status: { type: 'string', enum: ['passed', 'failed', 'not_run', 'unknown'] }, evidence: string }, ['id', 'status'])),
  remaining: string, blockers: string });
const assessmentSchema = object({ decision: { type: 'string', enum: ['accepted', 'rework', 'rejected'] },
  note: string, evidence: { ...array(referenceSchema), minItems: 1 } }, ['decision', 'note', 'evidence']);
const workItemSchema = object({ text: string, requirements: requirementsSchema }, ['text']);
function refuse(code, message) { throw Object.assign(new Error(message), { code }); }
function normalize(schema, value, label) {
  try { assertValid(schema, value); } catch (error) { refuse('FLEET_RESULT_INPUT_INVALID', `${label}: ${error.message}`); }
  function inspect(item) {
    if (typeof item === 'string' && !item.trim()) refuse('FLEET_RESULT_INPUT_INVALID', `${label} contains empty text.`);
    if (Array.isArray(item)) {
      const ids = item.filter(row => row && typeof row === 'object' && row.id !== undefined).map(row => row.id);
      if (new Set(ids).size !== ids.length) refuse('FLEET_RESULT_INPUT_INVALID', `${label} repeats an id in one list.`);
      item.forEach(inspect);
    } else if (item && typeof item === 'object') Object.values(item).forEach(inspect);
  }
  inspect(value);
  return JSON.parse(JSON.stringify(value));
}
function requirements(value) {
  if (value === undefined) return undefined;
  const next = normalize(requirementsSchema, value, 'Requirements');
  if (next.workspaceRoot !== undefined && (!require('node:path').isAbsolute(next.workspaceRoot) || next.workspaceRoot.includes('\0')))
    refuse('FLEET_RESULT_INPUT_INVALID', 'Requirements workspaceRoot must be an absolute local path without NUL bytes.');
  for (const check of next.checks || []) {
    if (check.timeoutSeconds !== undefined && !check.command) refuse('FLEET_RESULT_INPUT_INVALID', `Check ${check.id}: timeoutSeconds needs a command.`);
    if (check.command && check.timeoutSeconds === undefined) check.timeoutSeconds = 600;
  }
  return next;
}
function result(value) {
  if (value === undefined) return {};
  const next = normalize(resultSchema, value, 'Result');
  for (const check of next.checks || []) if (['passed', 'failed'].includes(check.status) && !check.evidence)
    refuse('FLEET_RESULT_EVIDENCE_REQUIRED', `Check ${check.id} needs evidence for its reported ${check.status} status.`);
  return next;
}
const assessment = value => normalize(assessmentSchema, value, 'Assessment');
function workItems(input) {
  if ((input.tasks !== undefined) === (input.workItems !== undefined)) refuse('FLEET_LANE_INPUT_INVALID', 'Supply either tasks (texts) or workItems (text and optional requirements).');
  if (input.workItems !== undefined) return normalize({ ...array(workItemSchema), minItems: 1 }, input.workItems, 'Job work items').map(item => ({ ...item, ...(item.requirements ? { requirements: requirements(item.requirements) } : {}) }));
  try { return normalize({ ...array(string), minItems: 1 }, input.tasks, 'Job tasks').map(text => ({ text })); }
  catch (error) { refuse('FLEET_LANE_INPUT_INVALID', error.message); }
}
function outcome(task) {
  if (!task.requirements && !task.submission && !task.assessment) return undefined;
  const submission = task.submission, result = submission?.result || {};
  const artifacts = result.artifacts || [], checks = result.checks || [];
  const counts = { passed: 0, failed: 0, not_run: 0, unknown: 0 };
  for (const check of checks) counts[check.status]++;
  const artifactIds = new Set(artifacts.map(item => item.id)), checkIds = new Set(checks.map(item => item.id));
  return { reported: Boolean(submission), ...(submission ? { source: submission.source } : {}), assessment: task.assessment?.decision || 'unassessed',
    artifacts: artifacts.length, checks: counts,
    missingOutputs: (task.requirements?.outputs || []).filter(item => !artifactIds.has(item.id)).length,
    missingChecks: (task.requirements?.checks || []).filter(item => !checkIds.has(item.id)).length,
    assessments: (task.assessments?.length || 0) + (task.assessment ? 1 : 0) };
}
function render(requirement) {
  return requirement ? ['Task requirements (references are inputs, not new authority):', JSON.stringify(requirement)].join('\n') : '';
}
module.exports = { requirementsSchema, resultSchema, assessmentSchema, workItemSchema, requirements, result, assessment, workItems, outcome, render };
