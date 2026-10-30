'use strict';

// Contract determinacy for Fleet V5: do a contract's checks decide its
// requirements? The review lists one structural omission row per unit; here
// Fleet runs real omission mutants against the finished work. A mutant is the
// work rewritten so that it no longer meets the units it omits and still meets
// everything else. The untouched work runs first as the control. Each mutant
// then runs in its own throwaway copy, with only the checks that cover the
// units it omits: it is observed when one of them fails and survives when all
// pass. A surviving mutant shows a weak check: it passes whether or not its
// requirement holds, so the result space is larger than the checks claim.
//
// Copies live under the OS temp directory and are removed after each run;
// mutant paths are confined to the copy and the lead workspace is only read.
// A hung or unlaunchable check is not_run, never a pass. The result is
// feedback only: it never refuses a contract or changes its status.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCHEMA = 'ai.toolsenabled/fleet-v5-determinacy/v1';
const MUTANT_DIR = '.fleet/mutants';
const MAX_WORKER_MUTANTS = 200;
const MAX_MUTANT_BYTES = 4 * 1024 * 1024;
const MUTANT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => (Array.isArray(value) ? value : []);
const ids = value => (typeof value === 'string' && value ? [value] : list(value).filter(id => typeof id === 'string' && id));

// The review's coverage as unit id -> covering check ids (declared covers,
// composed check atoms and inferred coverage alike), in review order.
function coverageOf(review) {
  return new Map(list(review?.coverage).filter(row => isObject(row) && typeof row.unitId === 'string')
    .map(row => [row.unitId, ids(row.checks)]));
}
function checkedUnits(review) { return [...coverageOf(review).keys()]; }

// A mutant may name a unit by its review id, or an expectation or output by
// its own id, as checks[].covers does.
function unitResolver(review) {
  const units = list(review?.units).filter(unit => isObject(unit) && typeof unit.id === 'string');
  const known = new Set(units.map(unit => unit.id));
  return raw => known.has(raw) ? raw : known.has(`expectation:${raw}`) ? `expectation:${raw}`
    : known.has(`output:${raw}`) ? `output:${raw}` : null;
}

/**
 * workerSection(contract, review) -> the Determinacy section of the worker
 * assignment when contract.determinacy.mutants is "worker", otherwise null.
 */
function workerSection(contract, review) {
  if (contract?.determinacy?.mutants !== 'worker') return null;
  const units = new Map(list(review?.units).filter(isObject).map(unit => [unit.id, unit.text]));
  const checked = checkedUnits(review);
  const shorten = value => { const flat = String(value || '').replace(/\s+/g, ' ').trim(); return flat.length <= 160 ? flat : `${flat.slice(0, 159).trimEnd()}…`; };
  return ['Determinacy (Fleet runs omission mutants of your finished work against the checks):',
    `For each checked unit below, write one mutant as ${MUTANT_DIR}/<id>.json containing {"omits": ["<unit id>"], "why": "<what no longer holds>", "files": {"<relative path>": "<full new text of the file>"}}: the files rewritten so the work no longer meets that unit and still meets everything else. Do not apply mutants to the work; Fleet runs each one in a throwaway copy and reports any check that still passes.`,
    ...(checked.length ? checked.map(id => `- ${id}${units.get(id) ? `: ${shorten(units.get(id))}` : ''}`) : ['- (the review found no checked unit; write one mutant per requirement a check covers)'])].join('\n');
}

/**
 * readWorkerMutants(workspace) -> the mutants a worker wrote as
 * .fleet/mutants/<id>.json, in name order; an unreadable file is a mutant
 * with a problem, reported as invalid.
 */
function readWorkerMutants(workspace) {
  const dir = path.join(workspace, MUTANT_DIR);
  let names;
  try {
    if (!fs.lstatSync(dir).isDirectory()) return [];
    names = fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort();
  } catch { return []; }
  return names.slice(0, MAX_WORKER_MUTANTS).map(name => {
    const id = name.slice(0, -'.json'.length);
    try {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) return { id, problem: 'not-a-file' };
      if (stat.size > MAX_MUTANT_BYTES) return { id, problem: 'too-large' };
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return isObject(value) ? { ...value, id } : { id, problem: 'not-an-object' };
    } catch { return { id, problem: 'unreadable' }; }
  });
}

// A mutant path relative to the copy, or null when it would leave it.
function relativeInside(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel) || path.win32.isAbsolute(rel)) return null;
  const normal = path.normalize(rel);
  if (!normal || normal === '.' || normal.split(/[\\/]/).includes('..')) return null;
  return normal;
}

const INVALID = {
  'bad-id': 'The mutant id must be 1-128 letters, digits, dots, dashes or underscores.',
  'duplicate-id': 'Another mutant uses this id.',
  unreadable: 'The mutant file is not readable JSON.', 'not-an-object': 'The mutant file is not a JSON object.',
  'not-a-file': 'The mutant entry is not a regular file.', 'too-large': 'The mutant file is too large.',
  'no-omits': 'The mutant omits no unit.',
  'unknown-unit': 'The mutant omits a unit this contract\'s review does not have.',
  'no-files': 'The mutant changes no file, so it is the original and always survives.',
  'file-not-text': 'Every mutant file must be given as its full text.',
  'escapes-copy': 'A mutant path leaves the workspace copy.',
  'no-change': 'The mutant files equal the work, so nothing is omitted.'
};
function invalid(row, reason, detail) {
  return { ...row, result: 'invalid', reason, message: `${INVALID[reason]}${detail ? ` ${detail}` : ''}`, checks: [] };
}

// Lexical validation, before any copy is made.
function validate(mutant, n, seen, resolveUnit) {
  const id = typeof mutant?.id === 'string' && mutant.id ? mutant.id : `mutant-${n + 1}`;
  const row = { id, omits: ids(mutant?.omits), why: typeof mutant?.why === 'string' ? mutant.why : '' };
  if (mutant?.problem) return invalid(row, mutant.problem);
  if (!MUTANT_ID.test(id)) return invalid(row, 'bad-id');
  if (seen.has(id)) return invalid(row, 'duplicate-id');
  seen.add(id);
  if (!row.omits.length) return invalid(row, 'no-omits');
  const unknown = row.omits.filter(raw => !resolveUnit(raw));
  if (unknown.length) return invalid(row, 'unknown-unit', unknown.join(', '));
  row.omits = [...new Set(row.omits.map(resolveUnit))];
  const files = mutant?.files;
  if (!isObject(files) || !Object.keys(files).length) return invalid(row, 'no-files');
  if (Object.values(files).some(text => typeof text !== 'string')) return invalid(row, 'file-not-text');
  const escaping = Object.keys(files).filter(rel => !relativeInside(rel));
  if (escaping.length) return invalid(row, 'escapes-copy', escaping.join(', '));
  return { row, files };
}

// A throwaway copy of the workspace under the OS temp directory. Symlinks are
// copied as they are; writes below check that they stay in the copy.
function makeCopy(workspace, tmpdir) {
  const parent = fs.mkdtempSync(path.join(tmpdir, 'fleet-v5-mutant-'));
  const root = path.join(parent, 'work');
  try { fs.cpSync(workspace, root, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true }); }
  catch (cause) { fs.rmSync(parent, { recursive: true, force: true }); throw cause; }
  return { parent, root };
}

// Write the mutant's files into the copy: 'escapes-copy' when a path reaches
// outside through a symlink, 'no-change' when every file already has that text.
function writeMutant(root, files) {
  const real = fs.realpathSync(root);
  let changed = 0;
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(root, relativeInside(rel));
    let ancestor = path.dirname(target);
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    const where = fs.realpathSync(ancestor);
    if (where !== real && !where.startsWith(real + path.sep)) return 'escapes-copy';
    let current = null;
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile()) return 'escapes-copy';
      current = fs.readFileSync(target, 'utf8');
    } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    if (current === text) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    changed++;
  }
  return changed ? null : 'no-change';
}

// A check that timed out, was killed or could not start is not_run.
function checkStatus(result) {
  if (!result || result.timedOut || result.error || result.exitCode === null || result.exitCode === undefined) return 'not_run';
  return result.status === 'passed' && result.exitCode === 0 ? 'passed' : 'failed';
}

async function runIn(workspace, files, checks, { runChecks, tmpdir, env }) {
  let copy;
  try { copy = makeCopy(workspace, tmpdir); }
  catch { return { error: 'copy-failed' }; }
  try {
    if (files) {
      const problem = writeMutant(copy.root, files);
      if (problem) return { problem };
    }
    const results = await runChecks(checks, { cwd: copy.root, env });
    const rows = checks.map((check, index) => ({ id: check.id, status: checkStatus(results?.[index]) }));
    return { checks: rows };
  } finally { fs.rmSync(copy.parent, { recursive: true, force: true }); }
}

function notRun(reason, extra = {}) {
  return { schema: SCHEMA, status: 'not-run', reason, control: null, rows: [], survivors: [], underdetermined: [],
    undeterminable: [], unexercised: [], ...extra };
}

/**
 * runDeterminacy({workspace, review, checks, mutants, runChecks, tmpdir?, env?})
 * -> {schema, status, reason?, control, rows, survivors, underdetermined,
 * undeterminable, unexercised}. status is determinate when every mutant run is
 * observed, underdetermined when one survives, and not-run (with a reason)
 * when nothing could be judged. checks are Fleet verification checks; only
 * those with a command run, with Fleet's own runner and timeouts.
 */
async function runDeterminacy({ workspace, review, checks, mutants, runChecks, tmpdir = os.tmpdir(), env = { ...process.env } }) {
  if (typeof workspace !== 'string' || !workspace) return notRun('no-workspace');
  try { if (!fs.statSync(workspace).isDirectory()) return notRun('no-workspace'); }
  catch { return notRun('no-workspace'); }
  const runnable = list(checks).filter(check => isObject(check) && typeof check.command === 'string' && check.command);
  const checked = checkedUnits(review);
  const options = { runChecks, tmpdir, env };
  if (!runnable.length) return notRun('no-checks', { unexercised: checked });

  const control = await runIn(workspace, null, runnable, options);
  if (control.error) return notRun(control.error, { unexercised: checked });
  const controlView = { allPassed: control.checks.every(check => check.status === 'passed'), checks: control.checks };
  if (!controlView.allPassed) return notRun('control-failed', { control: controlView, unexercised: checked });

  const coverage = coverageOf(review);
  const resolveUnit = unitResolver(review);
  const byId = new Map(runnable.map(check => [String(check.id), check]));
  const seen = new Set();
  const rows = [];
  const exercised = new Set();
  const undeterminable = new Set();
  for (const [n, mutant] of list(mutants).entries()) {
    const valid = validate(mutant, n, seen, resolveUnit);
    if (!valid.row) { rows.push(valid); continue; }
    const { row, files } = valid;
    const covering = [...new Set(row.omits.flatMap(id => coverage.get(id) || []))].filter(id => byId.has(id));
    const uncovered = row.omits.filter(id => !(coverage.get(id) || []).some(check => byId.has(check)));
    for (const id of uncovered) undeterminable.add(id);
    if (uncovered.length) row.uncovered = uncovered;
    if (!covering.length) {
      for (const id of row.omits) exercised.add(id);
      rows.push({ ...row, result: 'undeterminable', reason: 'no-covering-check', message: 'No check with a command covers the omitted units.', checks: [] });
      continue;
    }
    const run = await runIn(workspace, files, runnable.filter(check => covering.includes(String(check.id))), options);
    if (run.problem) { rows.push(invalid(row, run.problem)); continue; }
    for (const id of row.omits) exercised.add(id);
    if (run.error) { rows.push({ ...row, result: 'not-run', reason: run.error, checks: [] }); continue; }
    const result = run.checks.some(check => check.status === 'failed') ? 'observed'
      : run.checks.every(check => check.status === 'passed') ? 'survived' : 'not-run';
    rows.push({ ...row, result, ...(result === 'not-run' ? { reason: 'check-not-run' } : {}), checks: run.checks });
  }
  const survivors = rows.filter(row => row.result === 'survived');
  const underdetermined = [...new Set(survivors.flatMap(row => row.omits))];
  const ran = rows.filter(row => ['observed', 'survived'].includes(row.result));
  const status = survivors.length ? 'underdetermined' : rows.some(row => row.result === 'not-run') ? 'not-run'
    : ran.length ? 'determinate' : 'not-run';
  const reason = status !== 'not-run' ? null : rows.some(row => row.result === 'not-run') ? 'check-not-run'
    : list(mutants).length ? 'no-runnable-mutant' : 'no-mutants';
  return { schema: SCHEMA, status, ...(reason ? { reason } : {}), control: controlView, rows,
    survivors: survivors.map(row => row.id), underdetermined, undeterminable: [...undeterminable],
    unexercised: checked.filter(id => !exercised.has(id)) };
}

/**
 * weakCheckEvents(result, at) -> one weak-check review event per surviving
 * mutant and covering check that passed: resolves names the omitted units.
 */
function weakCheckEvents(result, at) {
  return list(result?.rows).filter(row => row.result === 'survived').flatMap(row => row.checks
    .filter(check => check.status === 'passed')
    .map(check => ({ type: 'weak-check', mutantId: row.id, checkId: check.id, resolves: [...row.omits], at })));
}

module.exports = Object.freeze({ SCHEMA, MUTANT_DIR, runDeterminacy, notRun, readWorkerMutants, workerSection, weakCheckEvents, checkedUnits });
