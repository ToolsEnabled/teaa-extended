'use strict';

// Contract review for Fleet V5: what a contract leaves open before the work,
// and what the worker decided there and what that ambiguity cost after it.
//
// The model follows LEAN-Bench and TEBench. A contract is a composition of
// units. A requirement is an outcome the result must have; a constraint is how
// the agent must act; a choice is a decision the text leaves to the worker;
// context is fact. Checks cover requirements. Every requirement no check
// covers, and every choice not declared as variance, is a free dimension: it
// doubles the outcomes that pass every check, so bits = free dimensions (a
// binary upper bound; independence is not claimed). Constraints are agent
// action no check observes: they are listed, not counted as results.
//
// A composed contract (compose, fleet-v5-catalog.js) is read exactly: each
// atom is a unit with basis composed and id = its TEBench requirement id. A
// check atom is covered by its own semantics; an atom without machine
// semantics is an open point; constraint atoms are declared trust-only rules
// and choice atoms declared variance. The prose around it keeps the inferred
// reading. One TEBench variance row per atom (omit it alone) sits between the
// control and the omit-together row.
//
// A task snippet (semantics kind task) is read one sentence at a time. Its
// first sentence is its statement: the task unit, covered by its own
// completion checks (basis completion); a task without one is an open point
// (no-completion). Each later sentence is a unit of the task: an outcome (an
// end state, a result due by a time or held to a measured bound) is a
// requirement, open (no-check) unless a check of the job covers it, the task's
// own first; a step is a trust-only constraint of the task. A choice inside a
// task's text, an instruction that leaves alternatives to the worker ("a table
// or a list"), is addressed by an intention of the same task whose about text
// names it; otherwise it is an open point (no-intention) on that task.
// Intentions count as declared choices. A sentence of a task, its statement
// included, that asserts the opposite state of a check is a state conflict on
// its unit, as the same sentence in prose is. Every unit, open point and trust-only
// entry of a task carries task: its requirement id.
//
// Everything here is deterministic and pure: no clock, network or model call.
// The review is feedback only. Fleet never refuses a contract because of it.

const crypto = require('node:crypto');
const catalogLib = require('./fleet-v5-catalog');
const determinacyLib = require('./fleet-v5-determinacy');

const REVIEW_SCHEMA = 'ai.toolsenabled/fleet-v5-review/v1';
const AFTER_SCHEMA = 'ai.toolsenabled/fleet-v5-review-after/v1';
const WORK_POINT_LIMIT = 40;
const WORK_TEXT_LIMIT = 6000;
const POINT_TEXT_LIMIT = 220;
const HEADLINE_MIN_SENTENCES = 4;

// Wording rules: each says what is wrong with the term and what to write instead.
const WORDING_RULES = [
  { code: 'wording-vague', hint: 'name the observable result a check can see', terms: [
    'fast', 'quick', 'quickly', 'slow', 'slowly', 'efficient', 'efficiently', 'robust', 'user[- ]friendly', 'easy', 'easily',
    'clean', 'cleanly', 'nice', 'nicely', 'good', 'proper', 'properly', 'appropriate', 'appropriately', 'reasonable', 'reasonably',
    'sensible', 'sensibly', 'intuitive', 'elegant', 'flexible', 'scalable', 'maintainable', 'readable', 'secure', 'securely',
    'gracefully', 'production[- ]ready', 'best practices?', 'state of the art'] },
  { code: 'wording-unmeasurable', hint: 'say what is measured and the value that passes', terms: [
    'faster', 'slower', 'smaller', 'larger', 'bigger', 'cheaper', 'better', 'improve[sd]?', 'optimi[sz]e[sd]?', 'enhance[sd]?',
    'real[- ]time', 'responsive', 'performant', 'high[- ]performance', 'asap', 'as soon as possible'] },
  { code: 'wording-open-ended', hint: 'list every item, or state the rule that selects them', terms: [
    'etc', 'and so on', 'and more', 'such as', 'including but not limited to', 'various', 'several', 'some',
    'as needed', 'if needed', 'if necessary', 'when appropriate', 'where possible', 'if possible', 'as much as possible'] },
  { code: 'wording-optional', hint: 'a requirement is binding. A choice the worker may make belongs in variance', terms: [
    'should', 'ought to', 'try to', 'attempt to', 'ideally', 'preferably', 'hopefully', 'may', 'might', 'could', 'optionally', 'or similar'] }
].map(rule => ({ ...rule, patterns: rule.terms.map(term => ({ term, regex: new RegExp(`\\b${term}\\b`, 'i') })) }));

const TIMING = /\b(?:deadlines?|latency|time[- ]limits?)\b|\bwithin\s+\d+(?:\.\d+)?\s*(?:milliseconds?|seconds?|minutes?|millis?|secs?|mins?|ms|sec|min|s|m)\b/i;
const SLEEP = /\bsleep\b/;

// Sentence classification. A sentence is a directive when it starts with an
// imperative verb (also after a leading clause such as "Within two hours,"),
// carries a deontic modal, "never"/"always"/"do not", a normative passive
// ("is decoded"), or is a numbered list item. Anything else is context.
const IMPERATIVES = new Set(('add apply ask avoid back build check choose clean confirm consider copy create delete do document '
  + 'don\'t ensure exclude fix free get give handle implement include keep leave let list log make mark measure move name '
  + 'never always order pick post prefer produce prove publish put read record refactor register remove rename replace report '
  + 'restart resume retain return reuse run say scan send set split start stop test tidy treat try update upload use verify '
  + 'wait watch work write').split(' '));
const PROCESS_VERBS = new Set(('ask post run use scan check watch wait order split start stop upload copy record report log prove '
  + 'register restart read measure try').split(' '));
const LEADING_CLAUSE = /^(?:within|before|after|once|at|then|when|if|until|for|in|on|while|as|during|from|by|whenever|first|finally|next|now)\b/i;
const MODAL = /\b(?:must|shall|should|needs? to|has to|have to|ought to|(?:is|are) required to|required to|may not|must not|cannot be skipped)\b/i;
const ABSOLUTE = /\b(?:never|always|do not|don't|does not need|no longer)\b/i;
const PARTICIPLES = 'written kept done sent run made taken given shown put read held left built known found brought chosen drawn';
const PASSIVE = new RegExp(`\\b(?:is|are|be|gets?)\\s+(?:\\w+ly\\s+)?(?:\\w{3,}ed|${PARTICIPLES.split(' ').join('|')})\\b`, 'i');
const CHOICE = /\b(?:you may(?! not)|may (?:use|choose|pick|be (?:either|any))|either\b[^.]*\bor\b|whichever|your choice|at your discretion|up to you|you can choose|or similar|for example|e\.g\.|(?<!\bonly\b.*)\bmay be \w+(?:ed|en)\b|\bthis choice\b)/i;
const PROCESS = /\b(?:before|after|then|first|until|once|while|through|via|using|by hand|directly|in place|at the same time|step by step|ask|post|script|agents?|by (?:pid|unit name))\b/i;
// "All checks pass": up to two words may name the checks before "checks". A
// possessive owner follows the quantifier ("Every task's completion checks")
// or an article ("All of the lead's checks"). The clause must end at "pass":
// words after it in the same clause ("the checks pass through ...") state an
// outcome of their own.
const CHECKS_OWNER = "[\\w-]+['\\u2019]s\\s+";
const ALL_CHECKS = new RegExp('^(?:all|every|each)\\s+'
  + `(?:${CHECKS_OWNER}(?:\\w+\\s+)?`
  + `|(?:of\\s+)?(?:the\\s+${CHECKS_OWNER}(?:\\w+\\s+)?|(?:the\\s+)?(?:\\w+\\s+){0,2}))`
  + 'checks?\\s+pass(?:es|ed)?\\s*(?:[.;:!]|$)', 'i');
const PROHIBITION = /^(?:[A-Z][a-z]+:\s+)?(?:do not|don't|never)\s+[a-z]/i;
const PROCESS_HEADING = /^(?:the\s+)?(?:method|methods|approach|process|procedure|steps|workflow|how to work|how)\b[^:]*:\s*$/i;
// The same heading written inline before its first directive ("Method: Work on ...").
const PROCESS_LABEL = /^(?:the\s+)?(?:method|methods|approach|process|procedure|steps|workflow)\s*:\s+(?=\S)/i;
const END_STATE = /\b(?:must|shall|has to|have to|needs? to)\s+(?:stay|remain|be|end)\s+(?!\w+ed\b)(?!done\b)\w+/i;
// A result due by a time ("finish the import within two days") is an outcome, also among steps.
const DEADLINE = /\b(?:within|in|by the end of)\s+(?:the\s+)?(?:first\s+|next\s+)?(?:\w+\s+)?(?:minutes?|hours?|days?|weeks?)\b/i;
// So is a result held to a measured bound ("keep the rate above 16 MB/s").
const BOUND = /\b(?:above|below|over|under|at (?:most|least)|(?:no )?(?:more|less|fewer) than|exceeds?|up to)\s+~?\d|[<>≤≥]=?\s*\d/i;
const NUMBERED = /^\s*(?:\(\d+\)|\d+[.)])\s+/;
const LIST_MARK = /^\s*(?:[-*•]|\(\d+\)|\d+[.)]|\([a-z]\)|[a-z][.)])\s+/i;
const STOPWORDS = new Set(('the a an and or of to in on at by for with from as is are be been was were it its this that these those '
  + 'than then there their them they we you your our not no any all each every per into onto over under up down out off only '
  + 'also just about most least more less very so such which who whom whose what when where how if else while until after '
  + 'before during has have had do does did can could would should will shall may might must one two three new old same other '
  + 'still yet both either neither own via').split(' '));

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}
const text = value => (typeof value === 'string' ? value : '');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => (Array.isArray(value) ? value : []);

// Distinct wording hits in one text: [{code, term, hint}]. A vague adjective
// followed by a determiner is a verb ("slow the queue"): an action, not a
// quality, so it is not a hit.
const VERB_OBJECT = /^\s+(?:the|a|an|its|their|his|her|our|your|my|this|that|these|those|any|every|each|it|them)\b/i;
function wordingHits(value) {
  const hits = [];
  const body = text(value);
  for (const rule of WORDING_RULES) for (const { regex } of rule.patterns) {
    const match = [...body.matchAll(new RegExp(regex.source, 'gi'))]
      .find(found => rule.code !== 'wording-vague' || !VERB_OBJECT.test(body.slice(found.index + found[0].length)));
    if (match && !hits.some(hit => hit.code === rule.code && hit.term === match[0].toLowerCase()))
      hits.push({ code: rule.code, term: match[0].toLowerCase(), hint: rule.hint });
  }
  return hits;
}

// Split text into sentences: lines first, then sentence ends followed by a
// capital, digit, bracket or quote. Headers ending in ':' stay as their own unit.
// A heading line that names a method ("Method:", "Steps:") makes the rest of
// its paragraph process: each sentence there carries process: true.
function sentences(value) {
  const out = [];
  let process = false;
  for (const line of text(value).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) { process = false; continue; }
    const numbered = NUMBERED.test(trimmed);
    const listed = LIST_MARK.test(trimmed);
    if (!listed && /:\s*$/.test(trimmed) && trimmed.length < 80) process = PROCESS_HEADING.test(trimmed);
    const body = trimmed.replace(LIST_MARK, '');
    for (const part of body.split(/(?<=[.!?])\s+(?=[A-Z0-9("“'])/)) {
      const sentence = part.trim();
      if (sentence) out.push({ text: sentence, numbered, ...(process ? { process } : {}) });
    }
  }
  return out;
}

function firstWord(value) { return (value.toLowerCase().match(/^[("“']*([a-z][a-z']*)/) || [])[1] || ''; }
function imperativeVerb(sentence) {
  const word = firstWord(sentence);
  if (IMPERATIVES.has(word)) return word;
  if (word === 'then' || word === 'also' || word === 'now' || word === 'finally') {
    const next = firstWord(sentence.replace(/^[("“']*[a-z']+\s*,?\s*/i, ''));
    if (IMPERATIVES.has(next)) return next;
  }
  if (LEADING_CLAUSE.test(sentence.replace(/^[("“']+/, ''))) {
    for (const clause of sentence.split(/,\s+/).slice(1)) {
      const next = firstWord(clause);
      if (IMPERATIVES.has(next)) return next;
    }
  }
  return null;
}

// The share of a sentence that is quoted text.
function quotedShare(sentence) {
  const quoted = [...sentence.matchAll(/"[^"]{3,}"|“[^”]{3,}”/g)].reduce((sum, [match]) => sum + match.length, 0);
  return sentence.length ? quoted / sentence.length : 0;
}

// Kind of one plain-text sentence: choice, constraint, requirement or context.
function classify(sentence, { numbered = false, outcome = false, process = false } = {}) {
  const label = PROCESS_LABEL.exec(sentence);
  if (label) return classify(sentence.slice(label[0].length), { numbered, outcome, process: true });
  const kind = classifyPlain(sentence, { numbered, outcome });
  // In a method section a directive says how to work, unless it names the
  // state the work must end in ("X must stay usable"), a result due by a time
  // or a result held to a measured bound.
  return process && kind === 'requirement' && !END_STATE.test(sentence) && !DEADLINE.test(sentence) && !BOUND.test(sentence) ? 'constraint' : kind;
}
function classifyPlain(sentence, { numbered, outcome }) {
  if (/:\s*$/.test(sentence) && sentence.length < 80) return 'context';
  // Reported speech: a sentence that is mostly quotation records what someone
  // said; the requirements drawn from it are stated elsewhere.
  if (quotedShare(sentence) > 0.5) return 'context';
  if (CHOICE.test(sentence)) return 'choice';
  const verb = imperativeVerb(sentence);
  const directive = outcome || numbered || Boolean(verb) || MODAL.test(sentence) || ABSOLUTE.test(sentence) || PASSIVE.test(sentence);
  if (!directive) return 'context';
  if (outcome) return 'requirement';
  // A prohibition ("Do not edit X", "Never drop a row") restricts how the
  // agent acts: a constraint, unless a check observes it.
  if (PROHIBITION.test(sentence)) return 'constraint';
  // A leading imperative decides: an outcome verb ("get", "write") makes a
  // requirement even when a leading time phrase ("within an hour,") precedes it.
  if (verb) return PROCESS_VERBS.has(verb) ? 'constraint' : 'requirement';
  return PROCESS.test(sentence) ? 'constraint' : 'requirement';
}

function stem(word) {
  return word.replace(/(?:ing|ed|es|s)$/, '') || word;
}
// Byte quantities by value, so "5 GB" and "5,000,000,000 B" are one word.
const BYTE_UNITS = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15, kib: 2 ** 10, mib: 2 ** 20, gib: 2 ** 30, tib: 2 ** 40 };
const QUANTITY = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb|pb|kib|mib|gib|tib)\b/gi;
function quantities(value) {
  return [...text(value).matchAll(QUANTITY)].map(([, number, unit]) => `${Math.round(Number(number.replace(/,/g, '')) * BYTE_UNITS[unit.toLowerCase()])}bytes`);
}
function tokens(value) {
  const words = text(value).replace(QUANTITY, ' ').toLowerCase().split(/[^a-z0-9]+/).filter(word => word && !STOPWORDS.has(word)
    && (word.length >= 3 || /^[a-z]\d+$/.test(word) || word === 'md'));
  return new Set([...words.map(stem), ...quantities(value)]);
}
// A check without declared covers is inferred to cover a unit when at least two
// content words are shared and they make up at least half of the check's words.
// A requirement (an outcome, not a process rule) is also covered when three or
// more words are shared and they make up half of the shorter of the two texts:
// a long check description often observes several short requirements.
function inferredCover(unitTokens, checkTokens, outcome = false) {
  if (!checkTokens.size || !unitTokens.size) return false;
  let shared = 0;
  for (const token of checkTokens) if (unitTokens.has(token)) shared++;
  return (shared >= 2 && shared / checkTokens.size >= 0.5)
    || (outcome && shared >= 3 && shared / Math.min(unitTokens.size, checkTokens.size) >= 0.5);
}

// State assertions: a clause that says its subject is in one state of a pair
// (absent or present, running or stopped, empty or not). A negation just
// before the state word flips it. A clause without its own subject ("and is
// not empty") inherits the subject of the clause before it.
const STATE_WORDS = [
  { axis: 'exists', on: ['exists?', 'present'], off: ['absent', 'missing', 'gone', 'deleted', 'removed'] },
  { axis: 'running', on: ['running', 'runs', 'started', 'active'], off: ['stopped', 'halted', 'inactive'] },
  { axis: 'empty', on: ['empty'], off: ['non-?empty'] },
  { axis: 'enabled', on: ['enabled'], off: ['disabled'] },
  { axis: 'mounted', on: ['mounted'], off: ['unmounted'] }
].flatMap(({ axis, on, off }) => [...on.map(word => ({ axis, word, value: true })), ...off.map(word => ({ axis, word, value: false }))]);
const STATE = new RegExp(`\\b(${STATE_WORDS.map(item => item.word).join('|')})\\b`, 'i');
const STATE_VALUE = word => STATE_WORDS.find(item => new RegExp(`^(?:${item.word})$`, 'i').test(word));
const NEGATION = /(?:\b(?:not|no longer|never|neither|nor)|n't)\s+(?:\w+\s+)?$/i;
const SUBJECT_SKIP = new Set('is are was were be been being does do did has have had still now already always again later also then'.split(' '));
function stateClaims(value) {
  const claims = [];
  let subject = null;
  for (const clause of text(value).split(/\s*(?:[;,:]|\band\b|\bbut\b|\bwhile\b|\bthen\b)\s*/i)) {
    const match = STATE.exec(clause);
    if (!match) continue;
    const state = STATE_VALUE(match[1]);
    const before = clause.slice(0, match.index);
    const value = NEGATION.test(before) ? !state.value : state.value;
    const words = before.toLowerCase().replace(/\b\w*n't\b|\b(?:not|no longer|never)\b/g, ' ').split(/[^a-z0-9_.\-/]+/).filter(Boolean);
    while (words.length && SUBJECT_SKIP.has(words.at(-1))) words.pop();
    const run = [];
    while (words.length && !STOPWORDS.has(words.at(-1)) && !SUBJECT_SKIP.has(words.at(-1))) run.unshift(words.pop());
    if (run.length) subject = run;
    if (subject) claims.push({ axis: state.axis, value, subject: subject.join(' '), key: subject.map(stem) });
  }
  return claims;
}
const sameSubject = (a, b) => a.at(-1) === b.at(-1) && (a.every(word => b.includes(word)) || b.every(word => a.includes(word)));
// One {axis, value, subject} per subject and state a text asserts with a
// single value; a text that names both states describes a change.
function settledClaims(value) {
  const rows = new Map();
  for (const claim of stateClaims(value)) {
    const key = `${claim.key.join(' ')}\u0000${claim.axis}`;
    const row = rows.get(key);
    if (!row) rows.set(key, { ...claim, mixed: false });
    else if (row.value !== claim.value) row.mixed = true;
  }
  return [...rows.values()].filter(row => !row.mixed);
}
// A task is judged sentence by sentence, as prose is: its unit on its statement,
// each later sentence on its own unit, with the kind the sentence has in prose.
const CONFLICT_KINDS = ['requirement', 'context'];
const CONFLICT_SOURCES = ['objective', 'done', 'expectation', 'task'];
const STATE_LABEL = { exists: ['absent', 'present'], running: ['stopped', 'running'], empty: ['not empty', 'empty'], enabled: ['disabled', 'enabled'], mounted: ['unmounted', 'mounted'] };
function stateConflicts(units, checks) {
  const found = [];
  const checkClaims = checks.map(check => ({ ref: String(check.id ?? ''), claims: settledClaims(check.description) }));
  for (const unit of units) {
    if (!unit.task && (unit.composed || !CONFLICT_SOURCES.includes(unit.source))) continue;
    if (!CONFLICT_KINDS.includes(unit.kind) && !CONFLICT_KINDS.includes(unit.proseKind)) continue;
    for (const claim of settledClaims(unit.task ? unit.statement : unit.text)) for (const check of checkClaims) {
      const other = check.claims.find(row => row.axis === claim.axis && row.value !== claim.value && sameSubject(row.key, claim.key));
      if (other && !found.some(row => row.unitId === unit.id && row.ref === check.ref))
        found.push({ code: 'state-conflict', ref: check.ref, unitId: unit.id, subject: claim.subject,
          message: `${unit.id} says ${claim.subject} is ${STATE_LABEL[claim.axis][Number(claim.value)]}, but check ${check.ref} says it is ${STATE_LABEL[claim.axis][Number(other.value)]}. Recheck which state the work must end in.` });
    }
  }
  return found;
}

// Every word of a text, short words included ("x-ready"), in stem form.
const idWords = value => text(value).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem);
// A check whose id has at least two words, all of them in the unit, names
// the unit's subject and state: it covers the unit.
function idCover(unitWords, checkId) {
  const id = idWords(checkId);
  return id.length >= 2 && id.every(word => unitWords.has(word));
}

// File names a text mentions, as lower-case base names ("notes/PLAN.md" -> plan.md).
function fileNames(value) {
  const names = new Set();
  for (const raw of text(value).split(/[\s,;"'`()[\]{}<>|=]+/)) {
    const name = raw.replace(/[.:!?]+$/, '');
    if (/^[\w./~-]*[a-z][\w-]*\.[a-z][a-z0-9]{0,7}$/i.test(name)) names.add(name.split('/').pop().toLowerCase());
  }
  return names;
}
const baseName = value => text(value).replace(/\/+$/, '').split('/').pop().toLowerCase();
// A check covers an output when it names the output's path or file name,
// when its id is the output's id or names the output's folder, or when its
// description names the output's file type ("bundle" for x.bundle).
function outputCover(unit, check, checkFiles) {
  const where = `${text(check.description)}\n${text(check.command)}`.toLowerCase();
  const path = text(unit.path).replace(/\/+$/, '').toLowerCase();
  const name = baseName(unit.path);
  const id = idWords(check.id);
  const type = (/\.([a-z]{3,})$/.exec(name) || [])[1];
  return Boolean(path && where.includes(path)) || (name.includes('.') && checkFiles.has(name))
    || String(check.id ?? '') === unit.ref || Boolean(name && !name.includes('.') && id.includes(stem(name)))
    || Boolean(type && idWords(check.description).includes(stem(type)));
}

// Requirement labels: a sentence that starts with a label ("C2:", "R3 ")
// states a numbered expectation. A check covers the labels its description
// names, singly or as a range ("C1-C5", "C1..C5"), and the labels any text
// lists in parentheses after its id ("acceptance (C1-C5)").
const LABEL_AT_START = /^([A-Z]{1,2})(\d{1,3})(?::|\s)/;
const LABEL_RANGE = /\b([A-Z]{1,2})(\d{1,3})(?:\s*(?:-|–|\.\.|to)\s*(?:\1)?(\d{1,3}))?\b/g;
function labelsIn(value) {
  const found = new Set();
  for (const [, prefix, from, to] of text(value).matchAll(LABEL_RANGE)) {
    const first = Number(from), last = to === undefined ? first : Number(to);
    if (last < first || last - first > 50) continue;
    for (let n = first; n <= last; n++) found.add(`${prefix}${n}`);
  }
  return found;
}
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function checkLabels(check, prose) {
  const labels = labelsIn(check.description);
  const id = String(check.id ?? '');
  if (id) for (const [, inside] of prose.matchAll(new RegExp(`\\b${escapeRegex(id)}\\s*\\(([^)]*)\\)`, 'gi')))
    for (const label of labelsIn(inside)) labels.add(label);
  return labels;
}
const unitLabel = value => { const match = LABEL_AT_START.exec(text(value)); return match ? `${match[1]}${Number(match[2])}` : null; };

function shorten(value, limit = POINT_TEXT_LIMIT) {
  const flat = text(value).replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

// The unit kind of a composed atom, from its semantics kind.
const COMPOSED_KIND = { check: 'requirement', requirement: 'requirement', prompt: 'requirement', task: 'requirement', constraint: 'constraint', choice: 'choice', context: 'context' };

// Alternatives inside an instruction: "a table or a list". A negated sentence
// ("do not delete or rename") forbids both and leaves nothing open. Only an
// instruction leaves them to the worker: alternatives in a statement ("X or Y
// does the work"), in a condition ("only when X or Y") or after "only" (a
// restriction) are not a choice.
const ALTERNATIVE = /\b([a-z][a-z0-9-]*)\s+or\s+(?:(?:an?|the)\s+)?([a-z][a-z0-9-]*)/i;
const NEGATED = /\b(?:not|never|no|nor|neither|without)\b|n't\b/i;
const CONDITION = /\b(?:if|when|whenever|unless|whether|only|until)\b/i;

// The choices inside a task's text: [{text, names}], names being the content
// words an intention's about text must share with it to address it.
function taskChoices(value) {
  const out = [];
  for (const sentence of sentences(value)) {
    if (CHOICE.test(sentence.text)) { out.push({ text: sentence.text, names: tokens(sentence.text) }); continue; }
    if (NEGATED.test(sentence.text) || !imperativeVerb(sentence.text)) continue;
    const alternative = ALTERNATIVE.exec(sentence.text);
    if (alternative && !CONDITION.test(sentence.text.slice(0, alternative.index)))
      out.push({ text: sentence.text, names: tokens(`${alternative[1]} ${alternative[2]}`) });
  }
  return out;
}
// The sentences of a task, one by one: its text's sentences, each clause of
// a semicolon list on its own ("X is empty; Y still runs; Z").
function taskSentences(value) {
  return sentences(value).flatMap(sentence => sentence.text.split(/(?<=;)\s+(?=\S)/)
    .map(part => ({ ...sentence, text: part.trim() })).filter(part => part.text));
}
const addresses = (intention, choice) => [...tokens(intention.about)].some(token => choice.names.has(token));

// A rule leads with what it is: a choice when its first sentence leaves a
// decision open or it calls itself a choice; otherwise a process constraint,
// even when a later sentence grants a permission inside it.
function ruleKind(value) {
  const first = sentences(value)[0]?.text || '';
  return CHOICE.test(first) || /\bthis choice\b/i.test(value) ? 'choice' : 'constraint';
}

function unitsOf(contract, compiled) {
  const units = [];
  // The first sentence of a longer objective is its headline: it sums up what
  // the sentences after it specify, so it is context.
  const objective = sentences(contract.objective).map(sentence => ({ ...sentence, kind: classify(sentence.text, sentence) }));
  if (objective.length >= HEADLINE_MIN_SENTENCES && objective.slice(1).filter(item => item.kind !== 'context').length >= 2) objective[0].kind = 'context';
  objective.forEach((sentence, n) => units.push({ id: `objective:${n + 1}`, source: 'objective', declared: false,
    kind: sentence.kind, text: sentence.text }));
  // "All checks pass" (or "All four checks pass: ...") restates the checks: it
  // is context, covered by every check.
  sentences(contract.definitionOfDone).forEach((sentence, n) => {
    const allChecks = ALL_CHECKS.test(sentence.text);
    units.push({ id: `done:${n + 1}`, source: 'done', declared: false, kind: allChecks ? 'context' : classify(sentence.text, { outcome: true }),
      text: sentence.text, ...(allChecks ? { allChecks: true } : {}) });
  });
  const tasks = new Map(list(compiled?.tasks).map(task => [task.requirementId, task]));
  for (const node of compiled?.status === 'compiled' ? compiled.nodes.filter(item => item.kind === 'atom') : []) {
    const task = tasks.get(node.requirementId);
    if (!task) {
      units.push({ id: node.requirementId, ref: node.requirementId, source: 'composed', declared: true, composed: true,
        kind: COMPOSED_KIND[node.semantic.kind], semantics: node.semantic.kind, bundleId: node.bundleId, text: node.requirement });
      continue;
    }
    // A task's first sentence is its statement, covered by its completion
    // contract. Each later sentence is its own unit of the task, read as prose
    // reads it: an outcome is a requirement a check must cover, a step is a
    // constraint, a choice is answered by the task's intentions.
    const [statement, ...rest] = taskSentences(node.requirement);
    const choices = taskChoices(node.requirement);
    units.push({ id: node.requirementId, ref: node.requirementId, source: 'composed', declared: true, composed: true,
      kind: COMPOSED_KIND[node.semantic.kind], semantics: node.semantic.kind, bundleId: node.bundleId, text: node.requirement,
      task, taskId: node.requirementId, statement: statement?.text || node.requirement, choices,
      proseKind: statement ? classify(statement.text, statement) : undefined });
    rest.forEach((sentence, n) => {
      const choice = choices.some(row => row.text.includes(sentence.text));
      units.push({ id: `${node.requirementId}:${n + 2}`, source: 'task', declared: false, bundleId: node.bundleId,
        kind: choice ? 'choice' : classify(sentence.text, { ...sentence, process: true }), proseKind: classify(sentence.text, sentence),
        text: sentence.text, taskId: node.requirementId,
        ...(choice ? { taskChoice: true } : {}) });
    });
  }
  for (const item of list(contract.expectations)) if (isObject(item))
    units.push({ id: `expectation:${item.id}`, ref: String(item.id), source: 'expectation', declared: true, kind: 'requirement', text: text(item.text) });
  for (const item of list(contract.outputs)) if (isObject(item))
    units.push({ id: `output:${item.id}`, ref: String(item.id), source: 'output', declared: true, kind: 'requirement',
      path: text(item.path), description: text(item.description), text: [text(item.description), text(item.path)].filter(Boolean).join(' ') });
  if (isObject(contract.rules)) for (const [key, value] of Object.entries(contract.rules))
    units.push({ id: `rule:${key}`, ref: key, source: 'rule', declared: false, kind: ruleKind(text(value)), text: text(value) });
  for (const item of list(contract.variance)) if (isObject(item))
    units.push({ id: `variance:${item.id}`, ref: String(item.id), source: 'variance', declared: true, kind: 'choice',
      text: [text(item.choice), text(item.allowed)].filter(Boolean).join(': ') });
  return units;
}

function duplicates(ids) {
  const seen = new Set(), repeated = new Set();
  for (const id of ids) { if (seen.has(id)) repeated.add(id); seen.add(id); }
  return [...repeated];
}

function suggestionFor(unit, why, hits) {
  const wording = hits.length ? ` Replace ${hits.map(hit => `"${hit.term}"`).join(', ')}: ${hits[0].hint}.` : '';
  if (why === 'no-check' && unit.source === 'task') return `Add a completion check to task ${unit.bundleId} that observes this, or state it as the task's intention if the result is yours to decide.${wording}`;
  if (why === 'no-check') return unit.source === 'expectation' || unit.source === 'output'
    ? `Add a check whose covers name ${unit.ref}, or say how the result will be judged.${wording}`
    : `State this as an expectation with a check that covers it, or move it to context if it is only a fact.${wording}`;
  if (why === 'no-semantics') return `Snippet ${unit.bundleId} has no machine meaning: give it check semantics, or name ${unit.id} in the covers of a check.${wording}`;
  if (why === 'no-completion') return `Task ${unit.bundleId} has no completion contract: give it completion checks that show this piece is done.${wording}`;
  if (why === 'no-intention') return `Add an intention to task ${unit.bundleId} whose about names this choice, saying what you want and why; or state the one answer you want.`;
  if (why === 'undeclared-choice') return 'Declare this as variance (id, choice, allowed) if any answer is acceptable; otherwise state the one answer you want.';
  return `Name the observable result instead.${wording}`;
}

/**
 * reviewContract(contract) -> review (schema REVIEW_SCHEMA). Accepts drafts:
 * nothing in the contract is required and nothing is refused.
 */
// Snippet review status: built-ins are reviewed with Fleet; otherwise the
// latest record naming the bundle decides, bound to its digest.
function snippetReview(bundle, records) {
  if (bundle.source === 'builtin') return 'builtin';
  const record = records.filter(row => row.bundleId === bundle.id).at(-1);
  if (!record) return 'unreviewed';
  if (record.sha256 !== bundle.sha256) return 'stale';
  return record.decision === 'rejected' ? 'rejected' : 'approved';
}

function reviewContract(input) {
  const contract = isObject(input) ? input : {};
  const compiled = contract.compose === undefined ? null : catalogLib.compileContract({ catalog: contract.catalog, compose: contract.compose });
  const composed = compiled?.status === 'compiled' ? compiled : null;
  const units = unitsOf(contract, composed);
  const leadChecks = list(contract.checks).filter(isObject);
  const checks = [...leadChecks, ...(composed ? composed.checks.map(check => ({ ...check, semantic: true })) : []),
    ...(composed ? composed.tasks.flatMap(task => task.checks.map(check => ({ ...check, completion: true }))) : [])];
  const structure = [];
  const coverage = [];
  const covered = new Map();
  const expectationIds = new Set(units.filter(unit => unit.source === 'expectation').map(unit => unit.ref));
  const outputIds = new Set(units.filter(unit => unit.source === 'output').map(unit => unit.ref));
  const unitIds = new Set(units.map(unit => unit.id));

  for (const id of duplicates(list(contract.expectations).filter(isObject).map(item => String(item.id))))
    structure.push({ code: 'duplicate-id', ref: id, message: `Two expectations use id ${id}.` });
  for (const id of duplicates(checks.map(check => String(check.id))))
    structure.push({ code: 'duplicate-id', ref: id, message: `Two checks use id ${id}.` });

  const cover = (unitId, checkId, basis) => {
    if (!covered.has(unitId)) covered.set(unitId, new Map());
    const row = covered.get(unitId);
    if (!row.has(checkId) || basis === 'declared') row.set(checkId, basis);
  };
  const BASIS_ORDER = ['declared', 'semantic', 'completion', 'inferred'];
  const unitTokens = new Map(units.map(unit => [unit.id, tokens(unit.source === 'output' ? unit.description : unit.text)]));
  const unitWords = new Map(units.map(unit => [unit.id, new Set(idWords(unit.text))]));
  const unitFiles = new Map(units.map(unit => [unit.id, fileNames(unit.text)]));
  const prose = [text(contract.objective), text(contract.definitionOfDone)].join('\n');
  for (const check of checks) {
    const ref = String(check.id ?? '');
    const declaredCovers = Array.isArray(check.covers);
    let covers = 0;
    if (declaredCovers) {
      for (const raw of check.covers.filter(id => typeof id === 'string' && id)) {
        const unitId = unitIds.has(raw) ? raw : expectationIds.has(raw) ? `expectation:${raw}` : outputIds.has(raw) ? `output:${raw}` : null;
        if (!unitId) { structure.push({ code: 'covers-unknown', ref, message: `Check ${ref} covers ${raw}, which is not an expectation or output.` }); continue; }
        cover(unitId, ref, check.semantic ? 'semantic' : check.completion ? 'completion' : 'declared'); covers++;
      }
    }
    // A completion check is a check of the whole job: besides its own task, it
    // covers the prose and the task sentences it observes, as a lead check does.
    if (!declaredCovers || check.completion) {
      const checkTokens = tokens(check.description);
      const checkFiles = fileNames(`${text(check.description)}\n${text(check.command)}`);
      const labels = checkLabels(check, prose);
      for (const unit of units) {
        // A rule is the lead's declared process rule: only declared covers observe it.
        if (!(unit.allChecks || ['requirement', 'constraint'].includes(unit.kind)) || unit.composed || unit.source === 'rule') continue;
        if (unit.allChecks || inferredCover(unitTokens.get(unit.id), checkTokens, unit.kind === 'requirement' || PROHIBITION.test(unit.text)) || idCover(unitWords.get(unit.id), ref)
          || (unit.source === 'output' ? outputCover(unit, check, checkFiles) : [...unitFiles.get(unit.id)].some(name => checkFiles.has(name)))
          || labels.has(unitLabel(unit.text))) { cover(unit.id, ref, 'inferred'); covers++; }
      }
    }
    if (!covers) structure.push({ code: 'check-uncovered', ref, message: `Check ${ref} covers no requirement.` });
    if (TIMING.test(`${text(check.description)}\n${text(check.command)}`) || SLEEP.test(text(check.command)))
      structure.push({ code: 'timing-check', ref, message: `Check ${ref} judges timing. Checks verify results, not speed.` });
  }

  // A constraint a check observes is a requirement: the check judges it.
  for (const unit of units) if (unit.kind === 'constraint' && !unit.composed && covered.has(unit.id)) unit.kind = 'requirement';

  // A requirement and a check that assert opposite states of one subject.
  structure.push(...stateConflicts(units, checks));

  const openPoints = [];
  const trustOnly = [];
  const wording = [];
  const counts = { requirements: 0, checked: 0, open: 0, undeclaredChoices: 0, declaredChoices: 0, constraints: 0, unobservedConstraints: 0, context: 0 };
  const open = (unit, why, hits, extra = {}) => openPoints.push({ id: `op-${openPoints.length + 1}`, unitId: unit.id, text: unit.text, why,
    suggestion: suggestionFor(unit, why, hits), ...(unit.taskId ? { task: unit.taskId } : {}), ...extra });
  const ownChecks = new Map((composed ? composed.tasks : []).map(task => [task.requirementId, new Set(task.checks.map(check => check.id))]));
  for (const unit of units) {
    const rows = covered.get(unit.id);
    const own = ownChecks.get(unit.taskId);
    if (rows) coverage.push({ unitId: unit.id, checks: own ? [...rows.keys()].sort((a, b) => Number(own.has(b)) - Number(own.has(a))) : [...rows.keys()],
      basis: BASIS_ORDER.find(basis => [...rows.values()].includes(basis)) });
    if (unit.kind === 'context') { counts.context++; continue; }
    // A choice sentence inside a task is read with its task, against its intentions.
    if (unit.taskChoice) continue;
    // A task's own wording is its statement's; each later sentence is read as its own unit.
    const choices = unit.task ? unit.choices : [];
    const hits = unit.source === 'variance' || (unit.composed && catalogLib.isMachineSemantic(unit.semantics)) ? []
      : wordingHits(unit.task ? (choices.some(choice => choice.text.includes(unit.statement)) ? '' : unit.statement) : unit.text);
    for (const hit of hits) wording.push({ unitId: unit.id, code: hit.code, term: hit.term, hint: hit.hint });
    if (unit.kind === 'requirement') {
      counts.requirements++;
      if (unit.source === 'expectation' && !unit.text.trim())
        structure.push({ code: 'requirement-empty', ref: unit.ref, message: `${unit.ref} has no text.` });
      if (rows) { counts.checked++; if (hits.length) open(unit.task ? { ...unit, text: unit.statement } : unit, 'vague-wording', hits); }
      else {
        counts.open++;
        if (unit.task) open(unit, 'no-completion', hits);
        else if (unit.composed) { open(unit, 'no-semantics', hits); continue; }
        else {
          if (unit.source === 'expectation') structure.push({ code: 'requirement-unchecked', ref: unit.ref, message: `No check covers ${unit.ref}.` });
          open(unit, 'no-check', hits);
        }
      }
      if (unit.task) {
        counts.declaredChoices += unit.task.intentions.length;
        for (const choice of choices) if (!unit.task.intentions.some(intention => addresses(intention, choice))) {
          counts.undeclaredChoices++;
          open({ ...unit, text: choice.text }, 'no-intention', [], { task: unit.id });
        }
      }
    } else if (unit.kind === 'choice') {
      if (unit.declared) counts.declaredChoices++;
      else { counts.undeclaredChoices++; open(unit, 'undeclared-choice', hits); }
    } else {
      counts.constraints++;
      if (!rows) { counts.unobservedConstraints++; trustOnly.push({ unitId: unit.id, text: unit.text, ...(unit.composed ? { declared: true } : {}),
        ...(unit.taskId ? { task: unit.taskId } : {}) }); }
      if (hits.some(hit => hit.code !== 'wording-optional')) open(unit, 'vague-wording', hits);
    }
  }
  if (compiled && !composed) structure.push({ code: 'composition-invalid', ref: 'compose',
    message: `The composition does not compile: ${compiled.problems.map(item => `${item.code}: ${item.message}`).join(' ')}` });
  const records = list(contract.reviews).filter(row => isObject(row) && typeof row.bundleId === 'string'
    && typeof row.reviewer === 'string' && row.reviewer.trim() && Number.isFinite(Date.parse(row.at)));
  const snippets = (composed ? composed.bundles : []).map(bundle => ({ id: bundle.id, version: bundle.version, sha256: bundle.sha256,
    source: bundle.source, review: snippetReview(bundle, records) }));
  for (const snippet of snippets) if (['stale', 'rejected', 'unreviewed'].includes(snippet.review))
    structure.push({ code: `snippet-${snippet.review}`, ref: snippet.id, message: snippet.review === 'stale'
      ? `Snippet ${snippet.id} changed since its last review; review the current digest.`
      : snippet.review === 'rejected' ? `Snippet ${snippet.id} was rejected in review at this digest.` : `Snippet ${snippet.id} has no review record.` });
  if (!text(contract.definitionOfDone).trim() && !list(contract.outputs).length && !checks.length && !list(contract.expectations).length && !composed)
    structure.push({ code: 'done-undefined', ref: 'definitionOfDone', message: 'The contract has no definition of done, outputs, checks or expectations; nothing says when the work is finished.' });

  // How much of the text is composed, and the TEBench variance rows.
  const atoms = composed ? composed.nodes.filter(node => node.kind === 'atom') : [];
  const semanticAtoms = atoms.filter(node => catalogLib.isMachineSemantic(node.semantic.kind)).length;
  const uncomposed = [text(contract.objective), text(contract.definitionOfDone),
    ...(isObject(contract.rules) ? Object.values(contract.rules).map(text) : []),
    ...list(contract.expectations).filter(isObject).map(item => text(item.text)),
    ...list(contract.variance).filter(isObject).flatMap(item => [text(item.choice), text(item.allowed)])].reduce((sum, value) => sum + value.length, 0);
  const composedCharacters = composed ? composed.text.length : 0;
  const totalCharacters = composedCharacters + uncomposed;
  const composition = { status: composed ? 'compiled' : compiled ? 'invalid' : 'none', nodes: composed ? composed.nodes.length : 0,
    atoms: atoms.length, semanticAtoms, withoutSemantics: atoms.length - semanticAtoms, composedCharacters, totalCharacters,
    composedShare: totalCharacters ? Number((composedCharacters / totalCharacters).toFixed(4)) : 0,
    ...(compiled && !composed ? { problems: compiled.problems } : {}) };
  const atomIds = atoms.map(node => node.requirementId);
  const varianceRows = [{ id: 'control', omits: [] }, ...atomIds.map(id => {
    const observedBy = [...(covered.get(id)?.keys() || [])];
    return { id: `omit-${id}`, omits: [id], observedBy, structural: observedBy.length ? 'observed' : 'unobserved' };
  }), ...(atomIds.length ? [{ id: 'omit-together', omits: atomIds }] : [])];
  const observedRows = varianceRows.filter(row => row.structural === 'observed').length;
  const declaredChoiceSpace = [...atoms.filter(node => node.semantic.kind === 'choice').map(node => node.semantic.allowed.length),
    ...list(contract.variance).filter(isObject).map(() => 1)].reduce((product, n) => product * n, 1);

  const freeDimensions = counts.open + counts.undeclaredChoices;
  const unitTask = new Map(units.filter(unit => unit.taskId).map(unit => [unit.id, unit.taskId]));
  return {
    schema: REVIEW_SCHEMA,
    contractDigest: hash(stable(contract)),
    units: units.map(({ id, kind, source, declared, composed: isComposed, bundleId, taskId, text: unitText }) => ({ id, kind, source, declared,
      basis: isComposed ? 'composed' : declared ? 'declared' : 'inferred', ...(bundleId ? { bundleId } : {}), ...(taskId ? { task: taskId } : {}), text: unitText })),
    coverage, openPoints, trustOnly, wording, structure, composition, varianceRows, snippets,
    ...(composed?.tasks.length ? { tasks: composed.tasks.map(task => ({ requirementId: task.requirementId, bundleId: task.bundleId,
      completionChecks: task.checks.length, intentions: task.intentions.length,
      // A task's open points are those on its units: the task and its sentences.
      open: openPoints.filter(point => unitTask.get(point.unitId) === task.requirementId).length })) } : {}),
    space: {
      expectations: { declared: units.filter(unit => unit.source === 'expectation').length,
        inferred: units.filter(unit => unit.kind === 'requirement' && !unit.declared).length },
      requirements: counts.requirements, checked: counts.checked, open: counts.open,
      undeclaredChoices: counts.undeclaredChoices, declaredChoices: counts.declaredChoices,
      constraints: counts.constraints, unobservedConstraints: counts.unobservedConstraints, context: counts.context,
      declaredChoiceSpace, structural: { rows: atomIds.length, observed: observedRows, unobserved: atomIds.length - observedRows },
      freeDimensions, bits: freeDimensions, determinacy: 'not-tested'
    }
  };
}

function usableReview(review) {
  return isObject(review) && review.schema === REVIEW_SCHEMA && review.status !== 'unavailable' && Array.isArray(review.openPoints);
}

/**
 * workText(contract, review) -> the worker assignment text: the objective, then
 * declared expectations and choices, the request for omission mutants when
 * determinacy.mutants is "worker", then the open points with the request for
 * a Decisions section. A contract with nothing to add is returned unchanged.
 */
function workText(contract, review) {
  const objective = text(contract?.objective);
  const mutants = determinacyLib.workerSection(contract, usableReview(review) ? review : null);
  if (!usableReview(review)) return mutants ? `${objective}\n\n${mutants}` : objective;
  const sections = [];
  const expectations = list(contract.expectations).filter(isObject);
  if (expectations.length) sections.push(['Expectations (each is an outcome the result must have):',
    ...expectations.map(item => `- ${item.id}: ${shorten(item.text, 600)}`)].join('\n'));
  const variance = list(contract.variance).filter(isObject);
  if (variance.length) sections.push(['Declared choices (any allowed answer is accepted; say which you chose):',
    ...variance.map(item => `- ${item.id}: ${shorten(item.choice, 300)}${item.allowed ? `. Allowed: ${shorten(item.allowed, 300)}` : ''}`)].join('\n'));
  if (mutants) sections.push(mutants);
  const points = pointsSection(review.openPoints);
  if (points) sections.push(points);
  return sections.length ? `${objective}\n\n${sections.join('\n\n')}` : objective;
}

// The open points section of a work item: at most WORK_POINT_LIMIT lines
// within the text budget, then the request for a Decisions section.
function pointsSection(points) {
  if (!points.length) return null;
  const head = 'Open points (the contract leaves these to you; decide each one and say what you decided):';
  const tail = 'End your report with a Decisions section: a line "Decisions", then one line per open point in the form "op-N: decision".';
  let budget = WORK_TEXT_LIMIT - head.length - tail.length - 120;
  const lines = [];
  for (const point of points) {
    if (lines.length >= WORK_POINT_LIMIT) break;
    const line = `- ${point.id} (${point.why}): ${shorten(point.text)}`;
    if (line.length + 1 > budget) break;
    budget -= line.length + 1; lines.push(line);
  }
  const left = points.length - lines.length;
  if (left > 0) lines.push(`- and ${left} more open points not listed here; decide them the same way.`);
  return [head, ...lines, tail].join('\n');
}

// The composed text outside every task: the compiled text with each task's
// span removed, blank lines dropped.
function composedOutsideTasks(compiled) {
  const ids = new Set(list(compiled?.tasks).map(task => task.requirementId));
  const spans = list(compiled?.sourceMap).filter(row => ids.has(row.requirementId)).sort((a, b) => a.start - b.start);
  let rest = '', cursor = 0;
  for (const span of spans) { if (span.start >= cursor) rest += text(compiled.text).slice(cursor, span.start); cursor = Math.max(cursor, span.end); }
  rest += text(compiled?.text).slice(cursor);
  return rest.split(/\r?\n/).map(line => line.trim()).filter(Boolean).join('\n');
}

/**
 * taskWorkTexts(contract, review, compiled) -> one work item text per
 * compiled task, in node order. The first item carries the objective, the
 * list of all tasks and the declared expectations and choices; every item
 * states its task, "Done when: <done>", its intentions and the open points on
 * that task; the last also carries the composed text that is not a task, the
 * request for omission mutants and the contract's other open points.
 */
function taskWorkTexts(contract, review, compiled) {
  const tasks = list(compiled?.tasks);
  const usable = usableReview(review) ? review : null;
  const points = usable ? usable.openPoints : [];
  const ids = new Set(tasks.map(task => task.requirementId));
  const taskOf = point => point.task || (ids.has(point.unitId) ? point.unitId : null);
  const expectations = list(contract?.expectations).filter(isObject);
  const variance = list(contract?.variance).filter(isObject);
  const mutants = determinacyLib.workerSection(contract, usable);
  const rest = composedOutsideTasks(compiled);
  return tasks.map((task, index) => {
    const first = index === 0, last = index === tasks.length - 1;
    const sections = [];
    if (first) {
      sections.push(text(contract?.objective));
      sections.push([`This job has ${tasks.length} task${tasks.length === 1 ? '' : 's'}. Fleet sends each as its own work item, in this order:`,
        ...tasks.map((row, n) => `${n + 1}. ${shorten(row.text, 300)}`)].join('\n'));
      if (expectations.length) sections.push(['Expectations (each is an outcome the result must have):',
        ...expectations.map(item => `- ${item.id}: ${shorten(item.text, 600)}`)].join('\n'));
      if (variance.length) sections.push(['Declared choices (any allowed answer is accepted; say which you chose):',
        ...variance.map(item => `- ${item.id}: ${shorten(item.choice, 300)}${item.allowed ? `. Allowed: ${shorten(item.allowed, 300)}` : ''}`)].join('\n'));
    }
    const own = [`Task ${index + 1} of ${tasks.length}: ${task.text}`];
    if (task.done) own.push(`Done when: ${task.done}`);
    if (task.checks.length) own.push(`Fleet verifies this task with: ${task.checks.map(check => `${check.id} (${shorten(check.description, 160)})`).join('; ')}.`);
    if (task.intentions.length) own.push(['Intentions (decisions this task leaves to you: what the lead wants and why):',
      ...task.intentions.map(row => `- ${shorten(row.about, 200)}: ${shorten(row.intent, 600)}`)].join('\n'));
    sections.push(own.join('\n'));
    if (last && rest) sections.push(`Also part of this job:\n${rest}`);
    if (last && mutants) sections.push(mutants);
    const section = pointsSection(points.filter(point => last ? taskOf(point) === task.requirementId || !taskOf(point) : taskOf(point) === task.requirementId));
    if (section) sections.push(section);
    return sections.filter(Boolean).join('\n\n');
  });
}

/**
 * parseDecisions(reportText, review) -> one {openPointId, reported, text} per
 * open point, from "op-N: decision" lines (after the last Decisions heading
 * when the report has one).
 */
function parseDecisions(reportText, review) {
  const points = usableReview(review) ? review.openPoints : [];
  const lines = text(reportText).split(/\r?\n/);
  let start = 0;
  lines.forEach((line, index) => { if (/^\s*(?:#+\s*)?(?:\*\*)?decisions(?:\*\*)?\s*:?\s*$/i.test(line)) start = index + 1; });
  const found = new Map();
  for (const line of lines.slice(start)) {
    const match = /^\s*(?:[-*]\s*)?(op-\d+)\s*:\s*(.*?)\s*$/i.exec(line);
    if (match && match[2] && !found.has(match[1].toLowerCase())) found.set(match[1].toLowerCase(), match[2]);
  }
  return points.map(point => found.has(point.id)
    ? { openPointId: point.id, reported: true, text: found.get(point.id) }
    : { openPointId: point.id, reported: false, text: null });
}

function eventLabel(event) {
  if (event.type === 'ask') return `ask ${event.askId}`;
  if (event.type === 'answer') return `answer to ${event.askId}`;
  if (event.type === 'amendment') return `amendment${event.ruleKeys?.length ? ` adding rules ${event.ruleKeys.join(', ')}` : ''}${event.fields?.filter(field => field !== 'rules').length ? ` changing ${event.fields.filter(field => field !== 'rules').join(', ')}` : ''}`;
  if (event.type === 'check-failure') return `failed check ${event.checkId} at task revision ${event.taskRevision}`;
  if (event.type === 'rework') return `rework at task revision ${event.taskRevision}`;
  return event.type;
}

/**
 * attributeEvents(review, events, composition) -> one {bundles, uncomposed}
 * per event. An event resolves open point ids, the unit ids they are on, or
 * requirement ids (an open point on a task sentence counts as its task); a
 * requirement id of the composition (record.composition.checklist) counts
 * against the bundle of that node, and an open point on any other unit counts
 * as uncomposed prose. `bundles` holds {bundleId, sha256}, once per bundle.
 */
function attributeEvents(review, events, composition) {
  const nodes = new Map(list(composition?.checklist).filter(row => isObject(row) && row.path !== 'root')
    .map(row => [row.requirementId, { bundleId: row.bundleId, sha256: row.sha256 }]));
  const open = usableReview(review) ? review.openPoints : [];
  const points = new Map(open.map(point => [point.id, point.task || point.unitId]));
  const pointUnits = new Map(open.map(point => [point.unitId, point.task || point.unitId]));
  return list(events).filter(isObject).map(event => {
    const bundles = new Map();
    let uncomposed = false;
    for (const id of list(event.resolves)) {
      const unitId = points.get(id) ?? pointUnits.get(id) ?? id;
      if (nodes.has(unitId)) bundles.set(`${nodes.get(unitId).bundleId}@${nodes.get(unitId).sha256}`, nodes.get(unitId));
      else if (points.has(id) || pointUnits.has(id)) uncomposed = true;
    }
    return { event, bundles: [...bundles.values()], uncomposed };
  });
}

/**
 * afterView(review, events, reportText, composition?, determinacy?, items?) -> the after view: the
 * decision on each open point, the cost of ambiguity in events (also by
 * snippet bundle and on uncomposed prose), the omissions (events linked to no
 * open point) and what to write differently next time. Counts events only.
 * determinacy is the latest omission-mutant run (fleet-v5-determinacy.js):
 * its status is shown, and each weak-check event (a check that passed with
 * its requirement omitted) is counted and named for next time. For a job
 * written as task snippets, tasks lists each task {requirementId, bundleId,
 * item, status, verification} from its work item (items: the inspected rows).
 */
function afterView(review, events, reportText, composition, determinacy, items) {
  const rows = list(events).filter(isObject);
  const points = usableReview(review) ? review.openPoints : [];
  const linked = event => list(event.resolves).length > 0;
  const count = type => rows.filter(event => event.type === type).length;
  const attributed = attributeEvents(review, rows, composition);
  const byBundle = new Map();
  for (const row of attributed) for (const bundle of row.bundles) {
    const key = `${bundle.bundleId}@${bundle.sha256}`;
    byBundle.set(key, { bundleId: bundle.bundleId, sha256: bundle.sha256, events: (byBundle.get(key)?.events || 0) + 1 });
  }
  const cost = { events: rows.length, asks: count('ask'), answers: count('answer'), amendments: count('amendment'),
    reworks: count('rework'), checkFailures: count('check-failure'), weakChecks: count('weak-check'),
    byOpenPoint: points.map(point => ({ openPointId: point.id, unitId: point.unitId,
      events: rows.filter(event => list(event.resolves).includes(point.id) || list(event.resolves).includes(point.unitId)).length }))
      .filter(row => row.events > 0),
    byBundle: [...byBundle.values()].sort((a, b) => a.bundleId.localeCompare(b.bundleId) || a.sha256.localeCompare(b.sha256)),
    uncomposed: attributed.filter(row => row.uncomposed).length,
    unlinked: rows.filter(event => !linked(event)).length };
  const omissions = rows.filter(event => !linked(event)).map(event => structuredClone(event));
  const nextTime = [];
  for (const row of [...cost.byOpenPoint].sort((a, b) => b.events - a.events)) {
    const point = points.find(item => item.id === row.openPointId);
    const advice = { 'undeclared-choice': 'declare it as variance or state the answer', 'no-intention': 'state your intention for this choice in the task',
      'no-completion': 'give the task a completion contract' }[point.why] || 'state the outcome and add a check that covers it';
    nextTime.push(`${row.openPointId} (${point.unitId}) cost ${row.events} event${row.events === 1 ? '' : 's'}: ${advice}. "${shorten(point.text, 160)}"`);
  }
  for (const event of rows.filter(row => row.type === 'weak-check'))
    nextTime.push(`Check ${event.checkId} still passed with ${list(event.resolves).join(', ')} omitted (mutant ${event.mutantId}): make it observe that requirement, or the result stays open.`);
  for (const event of omissions) nextTime.push(`The contract never said what the ${eventLabel(event)} settled; write it into the first contract${event.type === 'amendment' && event.ruleKeys?.length ? ` (rules ${event.ruleKeys.join(', ')})` : ''}.`);
  const tasks = list(composition?.tasks).filter(isObject).map(task => {
    const item = list(items).find(row => isObject(row) && row.n === task.item);
    return { requirementId: task.requirementId, bundleId: task.bundleId, item: task.item,
      status: typeof item?.status === 'string' ? item.status : 'unknown',
      verification: typeof item?.verification?.status === 'string' ? item.verification.status : 'unknown' };
  });
  return { schema: AFTER_SCHEMA, decisions: parseDecisions(reportText, review), cost, omissions, nextTime,
    ...(Array.isArray(composition?.tasks) ? { tasks } : {}),
    determinacy: isObject(determinacy) && typeof determinacy.status === 'string' ? determinacy.status : 'not-tested' };
}

module.exports = Object.freeze({ REVIEW_SCHEMA, AFTER_SCHEMA, reviewContract, workText, taskWorkTexts, parseDecisions, afterView, attributeEvents, wordingHits, sentences, classify });
