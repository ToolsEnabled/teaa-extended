'use strict';

// A CommonJS port of the TEBench 0.3.3 prompt compiler (benchmark/prompts.mjs
// and benchmark/composition.mjs, compiler 1.3.0), synchronous over node:crypto.
// A catalog holds bundles {id, version, kind: atom|template, role, text with
// {{param}} and {{slot:name}} markers, parameters, parameterSchema, slots,
// slotOrder, semantics, dependencies}. A composition is a tree of refs
// {use, params, variables, slots}. Compiling it yields the composed text, a
// source map of which node wrote which characters, one checklist row per node
// and the bundle digests. Every refusal is an Error thrown with the TEBench
// wording; fleet-v5-catalog.js turns them into problems. This port keeps the
// compiler's behaviour, including features Fleet does not use (withheld
// paths, omissions, appendices), so the digests are the ones TEBench computes.

const crypto = require('node:crypto');

const COMPILER_VERSION = '1.3.0';
const COMPOSITION_VERSION = 1;
const COMPOSITION_LIMITS = Object.freeze({ nodes: 4096, text: 2 * 1024 * 1024, paths: 8 * 1024 * 1024, occurrences: 4096 * 16 });
const MAX_EXPANSIONS = COMPOSITION_LIMITS.nodes;
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const own = (value, key) => Object.hasOwn(value, key);

function invariant(ok, message) { if (!ok) throw new Error(message); }
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function canonical(value) {
  if (value === null || typeof value !== 'object') {
    invariant(value !== undefined && (typeof value !== 'number' || Number.isFinite(value)), 'Only finite JSON values can be frozen.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function reviewContent(bundle) {
  const { review: _review, ...content } = bundle;
  return bundle.kind === 'template' ? { ...content, slotOrder: bundle.slotOrder || Object.keys(bundle.slots || {}) } : content;
}
function bundleHash(bundle) { return sha256(canonical(reviewContent(bundle))); }
const jsonCopy = value => JSON.parse(canonical(value));
const fields = (value, names, label) => invariant(object(value) && Object.keys(value).every(key => names.includes(key)), label + ' has unsupported fields.');

// A slot names one role, several, or '*' for anything.
const slotRoles = declared => (Array.isArray(declared) ? declared : [declared]);
const slotAccepts = (declared, role) => slotRoles(declared).some(item => item === '*' || item === role);
const slotRoleText = declared => slotRoles(declared).map(String).join(' or ');
const validSlotRoles = declared => {
  const accepted = slotRoles(declared);
  return accepted.length > 0 && accepted.every(item => typeof item === 'string' && item.length > 0) && new Set(accepted).size === accepted.length;
};

function catalogMap(catalog) {
  invariant(Array.isArray(catalog) && catalog.length && catalog.length <= 512, 'The catalog needs 1–512 bundles.');
  const byId = new Map();
  for (const bundle of catalog) {
    invariant(object(bundle) && ID.test(bundle.id), 'Each bundle needs a unique lowercase identifier.');
    invariant(!byId.has(bundle.id), `Duplicate bundle: ${bundle.id}.`);
    invariant(typeof bundle.version === 'string' && bundle.version.trim(), `Give ${bundle.id} a version.`);
    invariant(['atom', 'template'].includes(bundle.kind), `${bundle.id}: kind must be atom or template.`);
    invariant(typeof bundle.text === 'string' && bundle.text.trim() && bundle.text.length <= 100000, `${bundle.id} needs prompt wording, at most 100,000 characters.`);
    invariant(!bundle.parameters || object(bundle.parameters), `${bundle.id}: parameters must be an object.`);
    invariant(!bundle.dependencies || (Array.isArray(bundle.dependencies) && bundle.dependencies.every(id => ID.test(id)) && new Set(bundle.dependencies).size === bundle.dependencies.length), `${bundle.id}: dependencies must be distinct bundle identifiers.`);
    if (bundle.parameterSchema !== undefined) {
      invariant(object(bundle.parameterSchema), `${bundle.id}: parameterSchema must be an object.`);
      for (const [name, rule] of Object.entries(bundle.parameterSchema)) {
        invariant(/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(name) && object(rule) && ['string', 'number', 'integer', 'boolean'].includes(rule.type), `${bundle.id}: invalid parameter schema for ${name}.`);
        invariant(Object.keys(rule).every(key => ['type', 'required', 'enum', 'minimum', 'maximum'].includes(key)), `${bundle.id}: unsupported parameter constraint for ${name}.`);
        invariant(rule.required === undefined || typeof rule.required === 'boolean', `${bundle.id}: ${name} required must be boolean.`);
        invariant(rule.enum === undefined || (Array.isArray(rule.enum) && rule.enum.length && rule.enum.every(value => ['string', 'number', 'boolean'].includes(typeof value))), `${bundle.id}: ${name} needs a nonempty scalar enum.`);
        if (rule.enum) invariant(rule.enum.every(value => rule.type === 'integer' ? Number.isSafeInteger(value) : typeof value === rule.type && (rule.type !== 'number' || Number.isFinite(value))), `${bundle.id}: ${name} enum values must match the declared type.`);
        for (const key of ['minimum', 'maximum']) invariant(rule[key] === undefined || Number.isFinite(rule[key]), `${bundle.id}: invalid ${name} ${key}.`);
        invariant((rule.minimum === undefined && rule.maximum === undefined) || ['number', 'integer'].includes(rule.type), `${bundle.id}: numeric bounds require a numeric parameter.`);
        invariant(rule.minimum === undefined || rule.maximum === undefined || rule.minimum <= rule.maximum, `${bundle.id}: ${name} minimum exceeds maximum.`);
      }
    }
    invariant(!bundle.slots || object(bundle.slots), `${bundle.id}: slots must be an object.`);
    if (bundle.slotOrder) invariant(Array.isArray(bundle.slotOrder) && new Set(bundle.slotOrder).size === bundle.slotOrder.length && bundle.slotOrder.length === Object.keys(bundle.slots || {}).length && bundle.slotOrder.every(name => own(bundle.slots || {}, name)), `${bundle.id}: slot order must name each slot exactly once.`);
    invariant(bundle.kind !== 'atom' || !Object.keys(bundle.slots || {}).length, `${bundle.id}: atoms cannot declare slots.`);
    for (const [name, role] of Object.entries(bundle.slots || {})) {
      invariant(ID.test(name) && validSlotRoles(role), `${bundle.id}: invalid slot ${name}.`);
      invariant(bundle.text.includes(`{{slot:${name}}}`), `${bundle.id}: the prompt omits slot ${name}.`);
    }
    byId.set(bundle.id, bundle);
  }
  return byId;
}

// A review binds the complete dependency graph, not just the bundle's own text.
function catalogRoots(catalog) {
  catalog = structuredClone(catalog);
  const byId = catalogMap(catalog);
  const hashes = new Map(catalog.map(bundle => [bundle.id, bundleHash(bundle)]));
  const roots = new Map(), active = new Set();
  const visit = id => {
    if (roots.has(id)) return roots.get(id);
    invariant(byId.has(id), `Missing semantic dependency: ${id}.`);
    invariant(!active.has(id), `Cyclic semantic dependency: ${id}.`);
    active.add(id);
    const dependencies = [];
    for (const dependency of [...(byId.get(id).dependencies || [])].sort())
      dependencies.push({ id: dependency, rootSha256: visit(dependency).rootSha256 });
    active.delete(id);
    const hash = hashes.get(id);
    const value = { hash, rootSha256: sha256(canonical({ format: 'benchmark-bundle-root', version: 1, id, hash, dependencies })), dependencies };
    roots.set(id, value);
    return value;
  };
  for (const id of byId.keys()) visit(id);
  return roots;
}

function substitute(value, params, label) {
  if (typeof value === 'string') {
    const exact = /^\{\{([a-z][a-zA-Z0-9_-]*)\}\}$/.exec(value);
    if (exact) {
      invariant(own(params, exact[1]), `${label}: missing parameter ${exact[1]}.`);
      return params[exact[1]];
    }
    return value.replace(/\{\{([a-z][a-zA-Z0-9_-]*)\}\}/g, (_, name) => {
      invariant(own(params, name), `${label}: missing parameter ${name}.`);
      return String(params[name]);
    });
  }
  if (Array.isArray(value)) return value.map(item => substitute(item, params, label));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, params, label)]));
  return value;
}

function validateComposition(ir) {
  fields(ir, ['format', 'version', 'rootPath', 'nodes', 'appendices', 'omissions'], 'Composition');
  invariant(ir.format === 'benchmark-composition-ir' && ir.version === COMPOSITION_VERSION && ir.rootPath === 'root', 'Unknown composition representation.');
  invariant(Array.isArray(ir.nodes) && ir.nodes.length > 0 && ir.nodes.length <= COMPOSITION_LIMITS.nodes, 'Composition exceeds its node budget.');
  const nodes = new Map();
  let pathSize = 0, literalSize = 0;
  invariant(Array.isArray(ir.appendices) && ir.appendices.length <= 64 && new Set(ir.appendices.map(row => row.id)).size === ir.appendices.length, 'Composition appendices must have distinct bounded identities.');
  for (const appendix of ir.appendices) {
    fields(appendix, ['id', 'text', 'source', 'sha256'], 'Composition appendix');
    invariant(ID.test(appendix.id) && typeof appendix.text === 'string' && /^[a-z0-9_-]+\.mjs$/.test(appendix.source)
      && (appendix.sha256 === null || HASH.test(appendix.sha256)), 'An appendix needs its exact text and source binding.');
    literalSize += appendix.text.length;
  }
  invariant(literalSize <= COMPOSITION_LIMITS.text, 'Composition appendices exceed the text budget.');
  for (const node of ir.nodes) {
    fields(node, ['path', 'parentPath', 'slot', 'kind', 'role', 'bundle', 'parameters', 'semantic', 'ports', 'fragments', 'disclosed', 'requirement', 'omissions'], 'Composition node');
    invariant(typeof node.path === 'string' && !nodes.has(node.path), 'Composition paths must be unique.');
    pathSize += node.path.length;
    invariant(pathSize <= COMPOSITION_LIMITS.paths, 'Composition exceeds its path budget.');
    invariant(node.path === 'root' ? node.parentPath === null && node.slot === null
      : typeof node.parentPath === 'string' && ID.test(node.slot) && node.path === node.parentPath + '/' + node.slot, 'A composition path differs from its parent and slot.');
    invariant(['atom', 'template'].includes(node.kind) && typeof node.role === 'string' && node.role, 'Composition nodes need their declared kind and role.');
    fields(node.bundle, ['id', 'version', 'sha256', 'rootSha256'], 'Composition bundle binding');
    invariant(ID.test(node.bundle.id) && typeof node.bundle.version === 'string' && node.bundle.version.trim() && HASH.test(node.bundle.sha256) && HASH.test(node.bundle.rootSha256), 'Composition bundle bindings are incomplete.');
    invariant(object(node.parameters) && Object.values(node.parameters).every(value => ['string', 'number', 'boolean'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value))), 'Composition parameters must be finite scalars.');
    invariant(object(node.semantic) && !['path', 'children', 'childOrder'].some(key => own(node.semantic, key)), 'Local semantics cannot overwrite structural fields.');
    invariant(Array.isArray(node.ports) && new Set(node.ports.map(port => port.name)).size === node.ports.length && (node.kind !== 'atom' || node.ports.length === 0), 'Composition ports are invalid.');
    for (const port of node.ports) {
      fields(port, ['name', 'role', 'path'], 'Composition port');
      invariant(ID.test(port.name) && validSlotRoles(port.role) && port.path === node.path + '/' + port.name, 'A composition port has an invalid name, role or target.');
    }
    invariant(typeof node.disclosed === 'boolean' && (node.disclosed || node.kind === 'atom') && typeof node.requirement === 'string', 'Only atoms can be withheld; every node needs its requirement.');
    invariant(Array.isArray(node.fragments) && node.fragments.length > 0, 'Composition prose needs typed fragments.');
    const used = new Set();
    for (const fragment of node.fragments) {
      invariant(object(fragment) && ['text', 'slot'].includes(fragment.kind), 'Unknown composition prose fragment.');
      if (fragment.kind === 'text') {
        fields(fragment, ['kind', 'value'], 'Text fragment');
        invariant(typeof fragment.value === 'string', 'A text fragment must be a string.');
        literalSize += fragment.value.length;
        invariant(literalSize <= COMPOSITION_LIMITS.text, 'Composition literals exceed the text budget.');
      } else {
        fields(fragment, ['kind', 'name'], 'Slot fragment');
        invariant(node.ports.some(port => port.name === fragment.name), 'A prose slot has no declared port.');
        used.add(fragment.name);
      }
    }
    invariant(node.ports.every(port => used.has(port.name)), 'Composition prose omits a declared port.');
    nodes.set(node.path, node);
  }
  invariant(nodes.has('root'), 'Composition omitted its root.');
  const stack = [{ path: 'root', depth: 0 }], visited = new Set(), order = [];
  let depth = 0;
  while (stack.length) {
    const next = stack.pop(), node = nodes.get(next.path);
    invariant(node && !visited.has(next.path), 'Composition has a cycle, shared child or missing target.');
    visited.add(next.path); order.push(next.path); depth = Math.max(depth, next.depth);
    for (const port of [...node.ports].reverse()) {
      const child = nodes.get(port.path);
      invariant(child && child.parentPath === node.path && child.slot === port.name && slotAccepts(port.role, child.role), 'Composition child ownership or role differs from its port.');
      stack.push({ path: port.path, depth: next.depth + 1 });
    }
  }
  invariant(canonical(order) === canonical(ir.nodes.map(node => node.path)), 'Composition nodes must be reachable exactly once in declared preorder.');
  const validateOmissions = (omissions, prefix = 'root') => {
    fields(omissions, ['version', 'sourceSha256', 'ranges'], 'Prompt omissions');
    invariant(omissions.version === 1 && HASH.test(omissions.sourceSha256), 'Prompt omissions need the original prompt fingerprint.');
    invariant(Array.isArray(omissions.ranges) && omissions.ranges.length > 0 && omissions.ranges.length <= 128, 'Select 1–128 prompt sections to omit.');
    let size = 0;
    for (const range of omissions.ranges) {
      fields(range, ['start', 'end', 'text', 'path', 'label'], 'Omitted section');
      invariant(Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.end > range.start
        && typeof range.text === 'string' && range.text.length === range.end - range.start && typeof range.path === 'string' && /^root(?:\/|$)/.test(range.path) && nodes.has(prefix + range.path.slice(4))
        && typeof range.label === 'string' && range.label.trim() && range.label.length <= 120, 'An omitted section needs its exact text, occurrence, label, and character range.');
      size += range.text.length;
    }
    invariant(size <= COMPOSITION_LIMITS.text * 4, 'Selected omission text exceeds the retained-text budget.');
  };
  if (ir.omissions !== undefined) validateOmissions(ir.omissions);
  for (const node of ir.nodes) if (node.omissions !== undefined) {
    invariant(Array.isArray(node.omissions) && node.omissions.length > 0 && node.omissions.length <= 16, 'A reusable variant supports up to 16 successive omission layers.');
    for (const omissions of node.omissions) validateOmissions(omissions, node.path);
  }
  canonical(ir);
  return { nodes, depth };
}

function compositionSemantics(ir) {
  validateComposition(ir);
  const lowered = new Map();
  for (const node of [...ir.nodes].reverse()) {
    lowered.set(node.path, { ...jsonCopy(node.semantic), path: node.path, childOrder: node.ports.map(port => port.name),
      children: Object.fromEntries(node.ports.map(port => [port.name, lowered.get(port.path)])) });
  }
  return lowered.get(ir.rootPath);
}

function renderComposition(ir, { onOmissionSource = () => {} } = {}) {
  const { depth } = validateComposition(ir), lowered = new Map();
  const removedBefore = (at, ranges) => ranges.reduce((sum, range) => sum + Math.max(0, Math.min(at, range.end) - range.start), 0);
  const omit = (text, omissions, path) => {
    onOmissionSource(text, omissions, path);
    const ranges = [];
    for (const range of [...omissions.ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
      invariant(range.end <= text.length && text.slice(range.start, range.end) === range.text, 'An omitted section no longer matches the original prompt. Select it again.');
      const previous = ranges.at(-1);
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
      else ranges.push({ start: range.start, end: range.end });
    }
    let cursor = 0, result = '';
    for (const range of ranges) { result += text.slice(cursor, range.start); cursor = range.end; }
    return { text: result + text.slice(cursor), ranges };
  };
  for (const node of [...ir.nodes].reverse()) {
    let text = '', originalLength = 0;
    const placements = [];
    for (const fragment of node.fragments) {
      if (fragment.kind === 'text') { text += fragment.value; originalLength += fragment.value.length; }
      else {
        const path = node.path + '/' + fragment.name;
        placements.push({ path, offset: text.length }); text += lowered.get(path).text;
        originalLength += lowered.get(path).originalLength;
      }
      invariant(text.length <= COMPOSITION_LIMITS.text, 'The composed prompt exceeds its text budget.');
    }
    const projections = [];
    for (const omissions of node.omissions || []) {
      const result = omit(text, omissions, node.path); text = result.text; projections.push(result.ranges);
    }
    lowered.set(node.path, { text: node.disclosed ? text : '', originalLength: node.disclosed ? originalLength : 0, placements, projections });
  }
  let text = lowered.get(ir.rootPath).text;
  const outer = ir.omissions ? omit(text, ir.omissions, 'root') : { text, ranges: [] };
  text = outer.text;
  const project = (at, transforms) => {
    for (const transform of transforms) { at += transform.offset; at -= removedBefore(at, transform.ranges); }
    return at;
  };
  const sourceMap = [], occurrences = [{ path: ir.rootPath, transforms: [{ offset: 0, ranges: outer.ranges }] }], nodes = new Map(ir.nodes.map(node => [node.path, node]));
  while (occurrences.length) {
    invariant(sourceMap.length < COMPOSITION_LIMITS.occurrences, 'Repeated slots exceed the source-map budget.');
    const { path, transforms } = occurrences.pop(), node = nodes.get(path), rendered = lowered.get(path);
    const start = project(0, transforms), end = project(rendered.text.length, transforms), omittedCharacters = rendered.originalLength - (end - start);
    sourceMap.push({ path, start, end, requirementId: path + '#' + node.bundle.id, bundleId: node.bundle.id, ...(omittedCharacters > 0 ? { omittedCharacters } : {}) });
    invariant(sourceMap.length + occurrences.length + rendered.placements.length <= COMPOSITION_LIMITS.occurrences, 'Repeated slots exceed the source-map budget.');
    for (const placement of [...rendered.placements].reverse()) occurrences.push({ path: placement.path, transforms: [
      { offset: placement.offset, ranges: rendered.projections[0] || [] },
      ...rendered.projections.slice(1).map(ranges => ({ offset: 0, ranges })), ...transforms,
    ] });
  }
  for (const appendix of ir.appendices) {
    const start = text.length;
    text += appendix.text;
    invariant(text.length <= COMPOSITION_LIMITS.text, 'The composed prompt exceeds its text budget.');
    sourceMap.push({ path: 'runtime', requirementId: 'runtime#' + appendix.id, bundleId: null, start, end: text.length });
  }
  return { text, sourceMap, sourceMapUnit: 'UTF-16 code units', nodeCount: ir.nodes.length, depth };
}

function compositionRequirements(ir) {
  validateComposition(ir);
  const ranges = ir.omissions || ir.nodes.some(node => node.omissions) ? renderComposition(ir).sourceMap : [];
  const disclosure = node => {
    const occurrences = ranges.filter(range => range.path === node.path);
    const omittedCharacters = occurrences.reduce((sum, range) => sum + (range.omittedCharacters || 0), 0);
    if (!omittedCharacters) return { disclosed: node.disclosed };
    const disclosed = node.disclosed && occurrences.some(range => range.end > range.start);
    return { disclosed, disclosure: disclosed ? 'partial' : 'withheld', omittedCharacters };
  };
  return [...ir.nodes.map(node => ({ path: node.path, bundleId: node.bundle.id, version: node.bundle.version, ...disclosure(node),
    requirementId: node.path + '#' + node.bundle.id, sha256: node.bundle.sha256, rootSha256: node.bundle.rootSha256, role: node.role, requirement: node.requirement })),
  ...ir.appendices.map(row => ({ requirementId: 'runtime#' + row.id, path: 'runtime', bundleId: null, source: row.source,
    sha256: row.sha256, role: 'execution-contract', disclosed: true, requirement: row.text }))];
}

/**
 * compilePrompt(catalog, root, options) -> {text, sourceMap, composition,
 * semantic, checklist, bundles, promptSha256, compilerVersion, ...}. Throws an
 * Error with the TEBench message when the catalog or composition is refused.
 * Review gating (requireReview) is kept; Fleet passes none.
 */
function compilePrompt(catalog, root, { requireReview = false, variables = {}, reviews: records = [], withheldPaths = [], omissions, rootRole = 'node' } = {}) {
  invariant(object(variables), 'Task variables must be an object.');
  invariant(Array.isArray(withheldPaths) && new Set(withheldPaths).size === withheldPaths.length, 'Withheld atom paths must be a distinct list.');
  const withheld = new Set(withheldPaths);
  const byId = catalogMap(catalog);
  invariant(Array.isArray(records) && records.every(record => object(record) && ID.test(record.bundleId)), 'Review records must name bundle identifiers.');
  const roots = catalogRoots(catalog);
  const reviewed = (bundle, binding) => {
    const record = records.filter(row => row.bundleId === bundle.id).at(-1) || bundle.review;
    const approved = typeof record?.reviewer === 'string' && !!record.reviewer.trim() && Number.isFinite(Date.parse(record.at)) && record.sha256 === binding.hash
      && record.decision !== 'rejected' && (record.rootSha256 === binding.rootSha256 || (!binding.dependencies.length && !record.rootSha256));
    return { ...binding, approved, ...(record ? { review: record } : {}) };
  };
  const reviews = new Map(catalog.map(bundle => [bundle.id, reviewed(bundle, roots.get(bundle.id))]));
  const nodes = [], used = new Set(), active = new Set();
  const stack = [{ ref: root, path: 'root', role: rootRole, parent: null, key: null, exit: false }];
  while (stack.length) {
    const frame = stack.pop();
    if (frame.exit) {
      const node = frame.node;
      let cursor = 0;
      const fragments = [];
      const append = value => {
        if (fragments.at(-1)?.kind === 'text') fragments.at(-1).value += value;
        else fragments.push({ kind: 'text', value });
      };
      for (const match of node.bundle.text.matchAll(/\{\{(slot:)?([a-z][a-zA-Z0-9_-]*)\}\}/g)) {
        const [, slot, name] = match;
        append(node.bundle.text.slice(cursor, match.index));
        if (slot) {
          invariant(own(node.children, name), node.path + ': unknown slot ' + name + '.');
          fragments.push({ kind: 'slot', name });
        } else {
          invariant(own(node.params, name), node.path + ': missing parameter ' + name + '.');
          append(String(node.params[name]));
        }
        cursor = match.index + match[0].length;
      }
      append(node.bundle.text.slice(cursor));
      node.fragments = fragments;
      const semantics = substitute(node.bundle.semantics || { kind: 'prompt' }, node.params, node.path);
      invariant(object(semantics), node.path + ': local semantics must be an object.');
      node.semantic = Object.fromEntries(Object.entries(semantics).filter(([key]) => !['path', 'children', 'childOrder'].includes(key)));
      active.delete(frame.ref);
      continue;
    }
    const { ref, path, role } = frame;
    invariant(object(ref) && typeof ref.use === 'string', `${path}: choose a bundle.`);
    invariant(!active.has(ref), `${path}: cyclic prompt structure.`);
    invariant(nodes.length < MAX_EXPANSIONS, `This composition exceeds the ${MAX_EXPANSIONS}-node resource budget.`);
    const bundle = byId.get(ref.use);
    invariant(bundle, `${path}: missing bundle ${ref.use}.`);
    invariant(!withheld.has(path) || bundle.kind === 'atom', `${path}: withholding applies to atomic requirements, not a whole template or execution constitution.`);
    invariant(slotAccepts(role, bundle.role || 'node'), `${path}: ${bundle.id} has role ${bundle.role || 'node'}, and this place accepts ${slotRoleText(role)}.`);
    invariant(!requireReview || reviews.get(bundle.id).approved, `${bundle.id} needs review of its current wording, semantics, code and tests.`);
    const dependencies = [...(bundle.dependencies || [])];
    while (dependencies.length) {
      const id = dependencies.pop();
      invariant(!requireReview || reviews.get(id).approved, `${id} needs review as a dependency of ${bundle.id}.`);
      if (!used.has(id)) { used.add(id); dependencies.push(...(byId.get(id).dependencies || [])); }
    }
    invariant(ref.params === undefined || object(ref.params), `${path}: parameters must be an object.`);
    invariant(ref.variables === undefined || object(ref.variables), `${path}: local variables must be an object.`);
    const localVariables = { ...(frame.variables || variables), ...(ref.variables || {}) };
    const params = { ...(bundle.parameters || {}), ...localVariables, ...(ref.params || {}) };
    invariant(Object.values(params).every(value => ['string', 'number', 'boolean'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value))), `${path}: parameters must be finite scalar values.`);
    if (bundle.parameterSchema) {
      invariant(Object.keys(ref.params || {}).every(name => own(bundle.parameterSchema, name)), `${path}: an undeclared parameter was supplied.`);
      for (const [name, rule] of Object.entries(bundle.parameterSchema)) {
        const value = params[name];
        invariant(value !== undefined || rule.required === false, `${path}: missing parameter ${name}.`);
        if (value === undefined) continue;
        invariant(rule.type === 'integer' ? Number.isSafeInteger(value) : typeof value === rule.type, `${path}: ${name} must be ${rule.type}.`);
        invariant(rule.minimum === undefined || value >= rule.minimum, `${path}: ${name} is below its minimum.`);
        invariant(rule.maximum === undefined || value <= rule.maximum, `${path}: ${name} is above its maximum.`);
        invariant(rule.enum === undefined || rule.enum.some(allowed => canonical(value) === canonical(allowed)), `${path}: ${name} is outside its allowed values.`);
      }
    }
    const slots = bundle.slots || {};
    invariant(!ref.slots || object(ref.slots), `${path}: slots must be an object.`);
    invariant(Object.keys(ref.slots || {}).every(key => own(slots, key)), `${path}: an undeclared slot was supplied.`);
    const layers = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
    const nodeOmissions = [...layers(bundle.promptOmissions), ...layers(ref.promptOmissions)];
    const node = { path, parentPath: frame.parent?.path || null, slot: frame.key, bundle, params, children: {}, omissions: nodeOmissions };
    if (frame.parent) frame.parent.children[frame.key] = node;
    nodes.push(node); used.add(bundle.id); active.add(ref);
    stack.push({ ...frame, node, exit: true });
    for (const name of [...(bundle.slotOrder || Object.keys(slots))].reverse()) {
      const childRole = slots[name];
      invariant(own(ref.slots || {}, name), `${path}: fill the ${name} slot.`);
      stack.push({ ref: ref.slots[name], path: `${path}/${name}`, role: childRole, parent: node, key: name, exit: false, variables: localVariables });
    }
  }
  for (const path of withheld) invariant(nodes.some(node => node.path === path), 'Unknown withheld atom path: ' + path + '.');
  const composition = JSON.parse(canonical({ format: 'benchmark-composition-ir', version: 1, rootPath: 'root', appendices: [], nodes: nodes.map(node => ({
    path: node.path, parentPath: node.parentPath, slot: node.slot, kind: node.bundle.kind, role: node.bundle.role || 'node',
    bundle: { id: node.bundle.id, version: node.bundle.version, sha256: reviews.get(node.bundle.id).hash, rootSha256: roots.get(node.bundle.id).rootSha256 },
    parameters: { ...node.params }, semantic: node.semantic,
    ports: (node.bundle.slotOrder || Object.keys(node.bundle.slots || {})).map(name => ({ name, role: node.bundle.slots[name], path: node.path + '/' + name })),
    fragments: node.fragments, disclosed: !withheld.has(node.path),
    ...(node.omissions.length ? { omissions: node.omissions } : {}),
    requirement: String(substitute(node.bundle.requirement || node.bundle.text.replace(/\{\{slot:[^}]+\}\}/g, '[child requirements]'), node.params, node.path)),
  })) }));
  const bindings = [];
  let rendered = renderComposition(composition, { onOmissionSource: (text, omission, path) => bindings.push({ text, omission, path }) });
  for (const binding of bindings) invariant(binding.omission.sourceSha256 === sha256(binding.text), `${binding.path}: the source of this reusable variant changed. Reopen Variance and select its omissions again.`);
  if (omissions !== undefined) {
    invariant(object(omissions) && omissions.sourceSha256 === sha256(rendered.text), 'The original prompt changed after its omissions were selected. Reopen Variance and select the sections again.');
    composition.omissions = JSON.parse(canonical(omissions));
    rendered = renderComposition(composition);
  }
  return { ...rendered, composition, semantic: compositionSemantics(composition), checklist: compositionRequirements(composition),
    bundles: [...used].sort().map(id => ({ id, ...reviews.get(id) })),
    promptSha256: sha256(rendered.text), compilerVersion: COMPILER_VERSION };
}

module.exports = Object.freeze({ COMPILER_VERSION, COMPOSITION_VERSION, COMPOSITION_LIMITS, ID, invariant, object, canonical, sha256,
  reviewContent, bundleHash, catalogMap, catalogRoots, substitute, slotAccepts, validSlotRoles, validateComposition,
  compositionSemantics, renderComposition, compositionRequirements, compilePrompt });
