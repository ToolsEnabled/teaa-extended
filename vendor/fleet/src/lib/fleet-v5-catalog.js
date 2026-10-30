'use strict';

// The Fleet V5 snippet catalog and the contract compiler.
//
// A snippet is a TEBench bundle. An atom is one requirement and its semantics
// is its machine meaning; a template is structure with typed slots. A
// contract's compose is a list of refs {use, params, slots}; Fleet compiles it
// under the reserved implicit root template `contract` (one slot part-N per
// ref), so every requirement id is root/part-N/...#bundle-id as in TEBench.
//
// Semantics kinds: check {command, fieldPatterns} (a command decides the
// atom), constraint (a process rule no check observes), choice {allowed}
// (declared variance), context (fact), requirement (an outcome with no
// machine meaning yet), prompt (structure, or no meaning) and task. fieldPatterns
// are regex sources every bound parameter must match before its value reaches
// a shell command.
//
// A task snippet is an atom with role task: one piece of the job. Its
// semantics {kind: task, completion: {done, checks: [{id, description,
// command, timeoutSeconds?}], fieldPatterns}, intention: [{about, intent}]}
// carry its completion contract (how we know this piece is done) and the
// lead's intention for each decision the task leaves to the worker. A check's
// timeoutSeconds, an integer 1..3600, is kept through compile; absent, Fleet
// applies its default. compileContract returns one task per task node; Fleet
// sends each as its own work item.
//
// The built-ins are the contract snippet library's requirement/check pairs
// (te contract MCP, lib/snippets.js at 2bf205b): one atom per pair whose text is
// the requirement wording and whose semantics is the check.

const composition = require('./fleet-v5-composition');

const { canonical, sha256, bundleHash, object } = composition;
const ROOT_ID = 'contract';
const SEMANTIC_KINDS = ['check', 'constraint', 'choice', 'context', 'requirement', 'prompt', 'task'];
const TASK_ROLE = 'task';
const MACHINE_KINDS = new Set(['check', 'constraint', 'choice', 'context']);
const CHECK_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Library scripts stay free of single quotes because the shell wraps them in single quotes.
function nodeEval(source) {
  const flat = source.replace(/\s+/g, ' ').trim();
  if (flat.includes("'")) throw new Error('library script must not contain a single quote');
  return `node --input-type=module -e '${flat}'`;
}

const NO_SECRETS = nodeEval(`
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const skip = new Set([".git", "node_modules"]);
const pattern = /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}/;
const bad = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const path = join(dir, name);
    let info;
    try { info = lstatSync(path); } catch { continue; }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) walk(path);
    else if (info.isFile() && info.size < 1000000) {
      let text = "";
      try { text = readFileSync(path, "utf8"); } catch { continue; }
      if (pattern.test(text)) bad.push(path);
    }
  }
}
walk(".");
if (bad.length) { console.error(bad.join("\\n")); process.exit(1); }
`);

// The paths field is the allow list. Empty by default, so the check fails until it is set.
const SCOPE_ONLY = nodeEval(`
import { execFileSync } from "node:child_process";
const allow = "{{paths}}".split(",").filter(Boolean);
if (!allow.length) {
  console.error("scope-only: set the paths field to the paths this contract permits");
  process.exit(1);
}
let text;
try { text = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }); }
catch (error) { console.error(String(error.stderr || error.message)); process.exit(1); }
const names = text.split("\\n").filter(Boolean).map((line) => line.slice(3).trim());
const outside = names.filter((name) => !allow.some((prefix) => name === prefix || name.startsWith(prefix.endsWith("/") ? prefix : prefix + "/")));
if (outside.length) { console.error(outside.join("\\n")); process.exit(1); }
`);

const PATH = { type: 'string', pattern: '^[A-Za-z0-9_.][A-Za-z0-9_./-]*$' };
const PATHS = { type: 'string', default: '', pattern: '^([A-Za-z0-9_./-]+(,[A-Za-z0-9_./-]+)*)?$' };
const LINE = { type: 'string', pattern: '^[^\\n\\r]+$' };
const PHRASE = { type: 'string', pattern: '^[A-Za-z0-9 _.:/,=-]+$' };

// Requirement/check pairs: requirement {text, fields}; check {command, fields} or none.
const PAIRS = [
  { id: 'tests-pass', version: '1', labels: ['Behavior'], text: '`{{runner}}` exits 0.',
    fields: { runner: { type: 'string', default: 'node --test', pattern: LINE.pattern } },
    check: { command: '{{runner}}', fields: { runner: { type: 'string', default: 'node --test', pattern: LINE.pattern } } } },
  { id: 'no-secrets', version: '1', labels: ['Safety'], text: 'The workspace contains no private key and no AWS access-key id.',
    check: { command: NO_SECRETS } },
  { id: 'scope-only', version: '1', labels: ['Safety'], text: 'Only these paths change: {{paths}}.',
    fields: { paths: { type: 'string', pattern: PATHS.pattern } }, check: { command: SCOPE_ONLY, fields: { paths: PATHS } } },
  { id: 'committed', version: '1', labels: ['Delivery'], text: 'The result is committed: git status lists no changes.',
    check: { command: 'git rev-parse --is-inside-work-tree >/dev/null && test -z "$(git status --porcelain)"' } },
  { id: 'file-exists', version: '1', labels: ['Behavior'], text: 'The file {{path}} exists.', fields: { path: PATH },
    check: { command: 'test -f "{{path}}"', fields: { path: PATH } } },
  { id: 'output-contains', version: '1', labels: ['Behavior'], text: 'Running `{{command}}` succeeds and prints output containing "{{text}}".',
    fields: { command: LINE, text: PHRASE },
    check: { command: 'out=$({{command}}) && printf "%s" "$out" | grep -F -q -- "{{text}}"', fields: { command: LINE, text: PHRASE } } },
  { id: 'no-dependencies', version: '1', labels: ['Delivery'], text: 'package.json declares no dependencies and no devDependencies.',
    check: { command: 'node -e "const p=require(\'./package.json\');process.exit(Object.keys({...p.dependencies,...p.devDependencies}).length?1:0)"' } },
  { id: 'devices-intact', version: '1', labels: ['Safety'],
    text: '/dev/null, /dev/zero, /dev/urandom and /dev/full stay character devices owned by root:root with mode 666. (A root `cp -a FILE /dev/null` silently changes them.)',
    check: { command: 'for d in /dev/null /dev/zero /dev/urandom /dev/full; do test -c "$d" && test "$(stat -c %U:%G:%a "$d")" = root:root:666 || exit 1; done' } },
  { id: 'returns', version: '1', labels: ['Behavior'], text: '{{fn}} returns {{result}} for {{input}}.',
    fields: { fn: { type: 'string' }, result: { type: 'string' }, input: { type: 'string' } } },
  { id: 'throws', version: '1', labels: ['Behavior'], text: '{{fn}} throws {{error}} for {{input}}.',
    fields: { fn: { type: 'string' }, error: { type: 'string' }, input: { type: 'string' } } },
];

// One atom per pair: parameters are the field defaults, parameterSchema the
// field types (required when there is no default), semantics the check.
function atomOf(pair) {
  const fields = { ...(pair.check?.fields || {}), ...(pair.fields || {}) };
  const parameters = {}, parameterSchema = {}, fieldPatterns = {};
  for (const [name, rule] of Object.entries(fields)) {
    if (rule.default !== undefined) parameters[name] = rule.default;
    parameterSchema[name] = { type: rule.type, ...(rule.default === undefined ? { required: true } : {}),
      ...(rule.enum ? { enum: rule.enum } : {}), ...(rule.minimum !== undefined ? { minimum: rule.minimum } : {}),
      ...(rule.maximum !== undefined ? { maximum: rule.maximum } : {}) };
    if (rule.pattern !== undefined) fieldPatterns[name] = rule.pattern;
  }
  return { id: pair.id, version: pair.version, kind: 'atom', role: 'node', labels: [...pair.labels], text: pair.text,
    ...(Object.keys(parameters).length ? { parameters } : {}), ...(Object.keys(parameterSchema).length ? { parameterSchema } : {}),
    semantics: pair.check ? { kind: 'check', command: pair.check.command, ...(Object.keys(fieldPatterns).length ? { fieldPatterns } : {}) }
      : { kind: 'requirement' } };
}
const BUILTIN_CATALOG = Object.freeze(PAIRS.map(atomOf));
const BUILTIN_IDS = new Map(BUILTIN_CATALOG.map(bundle => [bundle.id, bundleHash(bundle)]));

// The reserved implicit root: one slot per ref, joined by newlines.
function implicitRoot(n) {
  const names = Array.from({ length: n }, (_, i) => `part-${i + 1}`);
  return { id: ROOT_ID, version: '1', kind: 'template', role: 'node', text: names.map(name => `{{slot:${name}}}`).join('\n'),
    slots: Object.fromEntries(names.map(name => [name, '*'])), slotOrder: names, semantics: { kind: 'prompt' } };
}

const problem = (code, message, ref) => ({ code, message, ...(ref === undefined ? {} : { ref }) });

/** validateCatalog(catalog) -> {problems}: a problem exactly when the TEBench catalog check refuses it. */
function validateCatalog(catalog) {
  try { composition.catalogMap(catalog); return { problems: [] }; }
  catch (cause) { return { problems: [problem('catalog-invalid', cause.message)] }; }
}

// Lead bundles merged over the built-ins: an identical copy is fine, the same id
// with different content is a conflict, and the root id is reserved.
function mergedCatalog(lead) {
  const problems = [];
  if (lead !== undefined && !Array.isArray(lead)) return { problems: [problem('catalog-invalid', 'catalog must be a list of bundles.')] };
  const own = [], builtinFromLead = new Set();
  for (const bundle of lead || []) {
    const id = object(bundle) ? bundle.id : undefined;
    if (id === ROOT_ID) { problems.push(problem('catalog-reserved', `The bundle id ${ROOT_ID} is reserved for the implicit root.`, id)); continue; }
    if (BUILTIN_IDS.has(id)) {
      if (bundleHash(bundle) !== BUILTIN_IDS.get(id))
        problems.push(problem('catalog-conflict', `A different built-in snippet already uses id ${id}. Rename yours.`, id));
      builtinFromLead.add(id);
      continue;
    }
    own.push(bundle);
  }
  const catalog = [...BUILTIN_CATALOG, ...own];
  problems.push(...validateCatalog(catalog).problems);
  return { catalog, problems, sources: new Map(catalog.map(bundle => [bundle.id, BUILTIN_IDS.has(bundle.id) ? 'builtin' : 'catalog'])) };
}

// fieldPatterns: every bound parameter a pattern names must match it.
function patternProblems(node, patterns) {
  const where = node.requirementId;
  if (patterns !== undefined && !object(patterns)) return [problem('semantics-invalid', `${where}: fieldPatterns must map parameter names to patterns.`, where)];
  const out = [];
  for (const [name, source] of Object.entries(patterns || {})) {
    let pattern;
    try { pattern = new RegExp(source); } catch { out.push(problem('semantics-invalid', `${where}: the ${name} field pattern is not a regular expression.`, where)); continue; }
    if (Object.hasOwn(node.parameters, name) && !pattern.test(String(node.parameters[name])))
      out.push(problem('field-pattern', `${where}: ${name} has characters this field does not allow before it reaches a shell command.`, where));
  }
  return out;
}

const nonempty = value => typeof value === 'string' && value.trim() !== '';
// A completion check's timeoutSeconds, when given, is what Fleet accepts for any check.
const MAX_CHECK_TIMEOUT = 3600;
const validTimeout = value => Number.isInteger(value) && value >= 1 && value <= MAX_CHECK_TIMEOUT;

// A task: role task; completion {done?, checks?, fieldPatterns?} and intention [{about, intent}] are optional.
function taskProblems(node, bundle) {
  const where = node.requirementId;
  const semantic = node.semantic;
  const bad = message => problem('semantics-invalid', `${where}: ${message}`, where);
  const out = [];
  if (node.role !== TASK_ROLE) out.push(bad(`a task snippet needs role ${TASK_ROLE}.`));
  const completion = semantic.completion;
  if (completion !== undefined && !object(completion)) out.push(bad('completion must be {done, checks, fieldPatterns}.'));
  else if (completion !== undefined) {
    if (completion.done !== undefined && !nonempty(completion.done)) out.push(bad('completion.done must be nonempty text.'));
    const checks = completion.checks;
    if (checks !== undefined && !(Array.isArray(checks) && checks.every(check => object(check) && typeof check.id === 'string'
        && CHECK_ID.test(check.id) && nonempty(check.description) && nonempty(check.command))))
      out.push(bad('completion.checks must be a list of {id, description, command} with lowercase ids.'));
    else if (checks && new Set(checks.map(check => check.id)).size !== checks.length) out.push(bad('completion.checks repeats an id.'));
    else for (const check of checks || []) if (check.timeoutSeconds !== undefined && !validTimeout(check.timeoutSeconds))
      out.push(bad(`completion check ${check.id}: timeoutSeconds must be an integer from 1 to ${MAX_CHECK_TIMEOUT}.`));
    out.push(...patternProblems(node, bundle.semantics?.completion?.fieldPatterns));
  }
  if (semantic.intention !== undefined && !(Array.isArray(semantic.intention)
      && semantic.intention.every(row => object(row) && nonempty(row.about) && nonempty(row.intent))))
    out.push(bad('intention must be a list of {about, intent}.'));
  return out;
}

function semanticProblems(node, bundle) {
  const semantic = node.semantic;
  const where = node.requirementId;
  if (node.kind !== 'atom') return [];
  if (!SEMANTIC_KINDS.includes(semantic.kind))
    return [problem('semantics-invalid', `${where}: semantics kind must be one of ${SEMANTIC_KINDS.join(', ')}.`, where)];
  const out = [];
  if (semantic.kind === 'check') {
    if (typeof semantic.command !== 'string' || !semantic.command.trim()) out.push(problem('semantics-invalid', `${where}: a check needs a command.`, where));
    out.push(...patternProblems(node, bundle.semantics?.fieldPatterns));
  }
  if (semantic.kind === 'task') out.push(...taskProblems(node, bundle));
  if (semantic.kind === 'choice' && !(Array.isArray(semantic.allowed) && semantic.allowed.length
      && semantic.allowed.every(value => ['string', 'number', 'boolean'].includes(typeof value))
      && new Set(semantic.allowed.map(String)).size === semantic.allowed.length))
    out.push(problem('semantics-invalid', `${where}: a choice needs a nonempty list of distinct allowed values.`, where));
  if (!node.requirement.trim()) out.push(problem('semantics-invalid', `${where}: the requirement text is empty.`, where));
  return out;
}

function invalid(problems) {
  return { status: 'invalid', problems, text: '', sourceMap: [], checklist: [], nodes: [], promptSha256: null, compositionSha256: null,
    bundles: [], checks: [], rules: {}, variance: [], tasks: [] };
}

/**
 * compileContract({catalog, compose}) -> {status: compiled|invalid, problems,
 * text, sourceMap, checklist, nodes, promptSha256, compositionSha256, bundles,
 * checks, rules, variance, tasks}. tasks holds one {requirementId, bundleId,
 * text, done, checks, intentions} per task node in node order. Never throws: a refused composition is status
 * invalid with {code, message} problems.
 */
function compileContract({ catalog, compose } = {}) {
  if (!Array.isArray(compose) || !compose.length)
    return invalid([problem('compose-invalid', 'compose must be a nonempty list of snippet refs {use, params, slots}.')]);
  const merged = mergedCatalog(catalog);
  if (merged.problems.length) return invalid(merged.problems);
  let compiled;
  try {
    compiled = composition.compilePrompt([...merged.catalog, implicitRoot(compose.length)],
      { use: ROOT_ID, slots: Object.fromEntries(compose.map((ref, i) => [`part-${i + 1}`, ref])) });
  } catch (cause) { return invalid([problem('composition-invalid', cause.message)]); }
  const byId = new Map(merged.catalog.map(bundle => [bundle.id, bundle]));
  const nodes = compiled.composition.nodes.filter(node => node.path !== 'root').map(node => ({
    path: node.path, requirementId: `${node.path}#${node.bundle.id}`, bundleId: node.bundle.id, kind: node.kind, role: node.role,
    parameters: node.parameters, semantic: node.semantic, requirement: node.requirement, source: merged.sources.get(node.bundle.id) }));
  const problems = nodes.flatMap(node => semanticProblems(node, byId.get(node.bundleId)));
  if (problems.length) return invalid(problems);

  // Atoms onto contract fields; a bundle used more than once is numbered in node order.
  const atoms = nodes.filter(node => node.kind === 'atom');
  const uses = new Map(), seen = new Map();
  for (const node of atoms) uses.set(`${node.semantic.kind}:${node.bundleId}`, (uses.get(`${node.semantic.kind}:${node.bundleId}`) || 0) + 1);
  const idOf = node => {
    const key = `${node.semantic.kind}:${node.bundleId}`;
    if (uses.get(key) === 1) return node.bundleId;
    seen.set(key, (seen.get(key) || 0) + 1);
    return `${node.bundleId}-${seen.get(key)}`;
  };
  const checks = [], rules = {}, variance = [];
  for (const node of atoms) {
    const kind = node.semantic.kind;
    if (!['check', 'constraint', 'choice'].includes(kind)) continue;
    const id = idOf(node);
    if (!CHECK_ID.test(id)) problems.push(problem('id-invalid', `${node.requirementId}: the derived id ${id} is longer than 64 characters.`, node.requirementId));
    if (kind === 'check') checks.push({ id, description: node.requirement, command: String(node.semantic.command), covers: [node.requirementId] });
    else if (kind === 'constraint') rules[id] = node.requirement;
    else variance.push({ id, choice: node.requirement, allowed: node.semantic.allowed.map(String), covers: [node.requirementId] });
  }
  // Tasks: completion check ids are bundle-id-check-id (bundle-id-N-check-id when the bundle is used more than once).
  const taskNodes = atoms.filter(node => node.semantic.kind === 'task');
  const taskUses = new Map(), taskSeen = new Map();
  for (const node of taskNodes) taskUses.set(node.bundleId, (taskUses.get(node.bundleId) || 0) + 1);
  const tasks = taskNodes.map(node => {
    taskSeen.set(node.bundleId, (taskSeen.get(node.bundleId) || 0) + 1);
    const prefix = taskUses.get(node.bundleId) === 1 ? node.bundleId : `${node.bundleId}-${taskSeen.get(node.bundleId)}`;
    const completion = node.semantic.completion || {};
    return { requirementId: node.requirementId, bundleId: node.bundleId, text: node.requirement,
      done: typeof completion.done === 'string' ? completion.done : null,
      checks: (completion.checks || []).map(check => ({ id: `${prefix}-${check.id}`, description: check.description,
        command: String(check.command), ...(check.timeoutSeconds === undefined ? {} : { timeoutSeconds: check.timeoutSeconds }),
        covers: [node.requirementId] })),
      intentions: (node.semantic.intention || []).map((row, k) => ({ id: `${node.bundleId}-intent-${k + 1}`, about: row.about, intent: row.intent })) };
  });
  const compiledIds = new Set(checks.map(check => check.id));
  for (const check of tasks.flatMap(task => task.checks.map(row => ({ ...row, task }))))
    if (!CHECK_ID.test(check.id)) problems.push(problem('id-invalid', `${check.task.requirementId}: the derived check id ${check.id} is longer than 64 characters.`, check.task.requirementId));
    else if (compiledIds.has(check.id)) problems.push(problem('id-invalid', `${check.task.requirementId}: the derived check id ${check.id} is used twice.`, check.task.requirementId));
    else compiledIds.add(check.id);
  if (problems.length) return invalid(problems);
  const hashes = new Map(compiled.bundles.map(row => [row.id, row.hash]));
  return { status: 'compiled', problems: [], text: compiled.text, sourceMap: compiled.sourceMap, checklist: compiled.checklist, nodes,
    promptSha256: compiled.promptSha256, compositionSha256: sha256(canonical(compiled.composition)),
    bundles: compiled.bundles.filter(row => row.id !== ROOT_ID).map(row => ({ id: row.id, version: byId.get(row.id).version,
      sha256: hashes.get(row.id), source: merged.sources.get(row.id) })),
    checks, rules, variance, tasks };
}

/** Every bundle a contract can use: the built-ins and the lead's own (lead copies of built-ins are the built-in). */
function catalogBundles(catalog) {
  const merged = mergedCatalog(catalog);
  if (!merged.catalog) return [];
  return merged.catalog.map(bundle => ({ bundle, sha256: bundleHash(bundle), source: merged.sources.get(bundle.id) }));
}

const isMachineSemantic = kind => MACHINE_KINDS.has(kind);

module.exports = Object.freeze({ ROOT_ID, SEMANTIC_KINDS, TASK_ROLE, BUILTIN_CATALOG, bundleHash, canonical, validateCatalog, compileContract,
  catalogBundles, implicitRoot, isMachineSemantic });
