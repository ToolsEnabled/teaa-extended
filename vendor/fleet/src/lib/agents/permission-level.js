'use strict';

/* Legacy identity/argv decoders below are diagnostic utilities only.
 * Live lead permission uses explicit administrator settings, never names or
 * CLI flags. Workers default to level 4 within administrator and role caps. */

const fs = require('node:fs');
const path = require('node:path');

const LEVEL = Object.freeze({ READ_ONLY: 1, ASKS: 2, EDITS: 3, EVERYTHING: 4 });
const DEFAULT_LEVEL = LEVEL.ASKS;
const LEVEL_NAMES = Object.freeze({ 1: 'read only', 2: 'asks', 3: 'edits on its own', 4: 'everything' });
const INTERPRETERS = new Set(['node', 'nodejs', 'bun', 'deno', 'python', 'python3']);
// Programs that only start another program. Fleet looks through these to the
// agent that started it, and stops at anything else.
const WRAPPERS = new Set(['sh', 'bash', 'dash', 'zsh', 'env', 'npx', 'npm', 'pnpm', 'yarn', 'bunx', 'uvx', 'timeout', 'nice', 'setsid', 'stdbuf']);
// teaa.js is TEAA's MCP gateway; agent-kit.js remains recognized for existing
// installations. Looking through either gateway reads the lead's own command
// line. This lead diagnostic is independent of worker defaults.
const WRAPPER_SCRIPTS = new Set(['npx-cli.js', 'npm-cli.js', 'npx', 'npm', 'teaa.js', 'agent-kit.js']);
const MAX_ANCESTORS = 6;
const programName = value => {
  const name = path.basename(String(value));
  return process.platform === 'win32' ? name.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '') : name;
};

// Native self-restarts use <agent>/versions/<version> as the executable.
// Inspect only the selected program, never permission-looking prompt arguments.
const versionedProgram = value => {
  const file = String(value || '');
  const version = path.basename(file), dir = path.dirname(file);
  return version.trim() === version && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)
    && path.basename(dir) === 'versions' ? programName(path.dirname(dir)) : null;
};
// Launcher backups retain the command before their .before- suffix. Only
// resolved program files use this convention, never prompt arguments.
const renamedProgram = file => /^\.?([A-Za-z0-9][A-Za-z0-9_+-]*)\.before-.+$/.exec(path.basename(file))?.[1] || null;
const SCRIPT_RUNTIMES = new Set(['node', 'nodejs', 'bun', 'deno']);
// A descriptor can name a package-relative JS entry point (npm/npx installs).
// Match complete path components, not the generic basename cli.js.
const matchesPaths = (entries, file) => (entries || []).some(entry => {
  const suffix = entry.split('/').join(path.sep);
  return file === suffix || file.endsWith(path.sep + suffix);
});

const matchesEntryPoint = (agent, file) => matchesPaths(agent.entryPoints, file);

function isLevel(value) {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

/** The lower of the given levels; anything that is not a level is ignored. */
function narrowest(...levels) {
  const valid = levels.filter(isLevel);
  return valid.length ? Math.min(...valid) : DEFAULT_LEVEL;
}

/** Options and flags in an argument list: `--opt value`, `--opt=value`, `--flag`. */
function parseArgv(argv, aliases = {}, { booleanNegation = false, booleans = [] } = {}) {
  const options = new Map();
  const flags = new Set();
  const booleanNames = new Set(booleans);
  const canonical = word => (Object.hasOwn(aliases, word) ? aliases[word] : word);
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index];
    // Everything after the option terminator is positional input, even if it
    // spells a permission flag. Prompt text must never grant worker authority.
    if (word === '--') break;
    if (typeof word !== 'string' || !word.startsWith('-') || word === '-') continue;
    if (booleanNegation && word.startsWith('--no-')) {
      const positive = canonical(`--${word.slice(5)}`);
      if (booleanNames.has(positive)) {
        flags.delete(positive);
        options.set(positive, 'false');
        continue;
      }
    }
    const equals = word.indexOf('=');
    if (equals > 0) {
      const name = canonical(word.slice(0, equals)), value = word.slice(equals + 1);
      options.set(name, value);
      if (booleanNegation && booleanNames.has(name)) {
        flags.delete(name);
        if (value === 'true') flags.add(name);
      }
      continue;
    }
    const name = canonical(word);
    const next = argv[index + 1];
    if (booleanNegation && booleanNames.has(name) && ['true', 'false'].includes(next)) {
      flags.delete(name);
      if (next === 'true') flags.add(name);
      options.set(name, next);
      index += 1;
      continue;
    }
    flags.add(name);
    if (typeof next === 'string' && !next.startsWith('-')) options.set(name, next);
  }
  return { options, flags };
}

/** The level an agent's own command line starts it at, by its descriptor's rules. */
function levelFromArgv(descriptor, argv) {
  // Some CLI short options accept attached values. Only normalize described
  // value options; arbitrary prompt words never become options.
  const syntax = descriptor.permissions.argv || {};
  const words = argv.flatMap(word => (syntax.attachedValueOptions || []).some(option =>
    word.startsWith(option) && word.length > option.length && word[option.length] !== '=')
    ? [word.slice(0, 2), word.slice(2)] : [word]);
  const { options, flags } = parseArgv(words, descriptor.permissions.aliases, {
    booleanNegation: syntax.booleanNegation === true,
    booleans: descriptor.permissions.lead.flatMap(rule =>
      Object.entries(rule.when).filter(([, value]) => value === true).map(([name]) => name)),
  });
  // Explicit read-only config overrides can narrow inheritance. This is not
  // a general TOML/settings parser, and no config override grants authority.
  if (syntax.readOnlyConfig) {
    const config = syntax.readOnlyConfig;
    for (let index = 0; index < words.length && words[index] !== '--'; index += 1) {
      const word = words[index];
      const option = config.options.find(name => word === name || word.startsWith(name + '=')
        || /^-[A-Za-z]$/.test(name) && word.startsWith(name) && word.length > name.length);
      const value = option === word ? words[index + 1] : option ? word.slice(option.length).replace(/^=/, '') : null;
      const assignment = typeof value === 'string' && /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*([\s\S]*?)\s*$/.exec(value);
      if (assignment && assignment[1] === config.key) {
        // Recognize plain/raw strings and quoted TOML scalars with comments.
        // More complicated TOML (including multiline or unsupported escapes)
        // is conservatively read-only rather than guessed to permit edits.
        const raw = assignment[2];
        let scalar = null;
        const basic = /^("(?:[^"\\]|\\.)*")\s*(?:#[^\r\n]*)?$/.exec(raw);
        const literal = /^'([^']*)'\s*(?:#[^\r\n]*)?$/.exec(raw);
        if (basic) { try { scalar = JSON.parse(basic[1]); } catch { /* narrower fallback */ } }
        else if (literal) scalar = literal[1];
        else if (/^[A-Za-z0-9_.-]+$/.test(raw)) scalar = raw;
        if (scalar === null || scalar === config.value) return LEVEL.READ_ONLY;
      }
    }
  }
  for (const rule of descriptor.permissions.lead) {
    const matches = Object.entries(rule.when).every(([option, value]) => (value === true
      ? flags.has(option)
      : options.get(option) === value));
    if (matches) return rule.level;
  }
  return DEFAULT_LEVEL;
}

// Ported from the verified daemon-title fix. Titles identify the provider;
// they do not reveal the session's permission flags.
const daemonTitleProgram = value => {
  const match = /^([A-Za-z][\w.-]*) bg-[a-z-]+$/.exec(String(value || ''));
  return match ? match[1] : null;
};
/** Which described agent a process's argv belongs to, or null. */
function agentOfArgv(registry, argv) {
  if (!Array.isArray(argv) || argv.length === 0) return null;
  const file = selectedProgram(argv).file;
  const { interpreted, runtime } = selectedProgram(argv);
  const program = programName(file), versioned = versionedProgram(file);
  return registry.agents.find(agent => program === agent.command || program === `${agent.command}.js`
    || versioned === agent.command
    || (interpreted && SCRIPT_RUNTIMES.has(runtime) && matchesEntryPoint(agent, file))) || null;
}

function selectedProgram(argv, runtime) {
  const title = daemonTitleProgram(argv[0]);
  const first = programName(runtime ?? title ?? argv[0]);
  let script = 1;
  // Node can relaunch a CLI with a heap limit before its entry point. Only
  // skip this numeric runtime option; searching arbitrary arguments could
  // mistake an eval string or another program's argument for an agent.
  if (first === 'node' || first === 'nodejs') {
    while (/^--max[-_]old[-_]space[-_]size=\d+$/.test(argv[script] || '')) script += 1;
    if (/^--max[-_]old[-_]space[-_]size$/.test(argv[script] || '') && /^\d+$/.test(argv[script + 1] || '')) script += 2;
  }
  const interpreted = INTERPRETERS.has(first) && argv.length > script && !String(argv[script]).startsWith('-');
  return { file: String(interpreted ? argv[script] : title ?? argv[0]), interpreted, runtime: first };
}

// Compare registered executable files too: a renamed copy retains its bytes.
// Streaming in 64 KiB chunks avoids loading an entire native CLI into memory.
function sameFile(left, right) {
  const a = fs.statSync(left), b = fs.statSync(right);
  if (!a.isFile() || !b.isFile()) return false;
  if (a.dev === b.dev && a.ino === b.ino) return true;
  if (a.size !== b.size) return false;
  const digest = file => {
    const hash = require('node:crypto').createHash('sha256');
    const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(64 * 1024);
    try { for (let n; (n = fs.readSync(fd, buffer, 0, buffer.length, null));) hash.update(buffer.subarray(0, n)); }
    finally { fs.closeSync(fd); }
    return hash.digest('hex');
  };
  return digest(left) === digest(right);
}
function processIdentity(registry, argv, pid, { executable, realpath = fs.realpathSync,
  commandPath = command => require('../runtime').commandPath(command),
  platform = process.platform, cwd = pid => `/proc/${pid}/cwd` } = {}) {
  let exe;
  try { exe = realpath(executable(pid)); } catch { /* argv remains observable */ }
  const identityFile = file => platform === 'win32' ? file.replace(/\\/g, path.sep).toLowerCase() : file;
  const selected = selectedProgram(argv, exe && programName(identityFile(exe)));
  const candidates = [];
  // Resolve a relative entry against the process cwd, not Fleet's cwd.
  if (selected.interpreted) {
    try {
      const paths = platform === 'win32' ? path.win32 : path;
      const base = paths.isAbsolute(selected.file) ? null : (platform === 'win32' ? null : cwd(pid));
      if (paths.isAbsolute(selected.file) || base) candidates.push({ file: realpath(base ? paths.join(base, selected.file) : selected.file), source: 'entry-realpath', script: true });
    } catch { /* unresolved script */ }
  } else if (exe) candidates.push({ file: exe, source: platform === 'win32' ? 'process-exe' : 'proc-exe', script: false });
  for (const candidate of candidates) {
    const file = identityFile(candidate.file);
    const agent = registry.agents.find(agent => candidate.script ? SCRIPT_RUNTIMES.has(selected.runtime) && matchesEntryPoint(agent, file)
      || versionedProgram(file) === agent.command
      : programName(file) === agent.command || versionedProgram(file) === agent.command
        || renamedProgram(file) === agent.command || matchesPaths(agent.binaryPaths, file));
    if (agent) return { agent, identifiedBy: candidate.source };
    for (const agent of registry.agents) {
      try {
        const registered = commandPath(agent.command);
        if (registered && sameFile(candidate.file, realpath(registered))) return { agent, identifiedBy: 'registered-file' };
      } catch { /* no usable registered file; try the next descriptor */ }
    }
  }
  const agent = agentOfArgv(registry, argv);
  return agent ? { agent, identifiedBy: 'argv' } : null;
}
function readExecutable(pid) { return fs.readlinkSync(`/proc/${pid}/exe`); }

// Audit only recognized permission syntax, never prompt text or other argv
// values (which can contain credentials). Values come from descriptor rules.
function permissionFlags(agent, argv) {
  const syntax = agent.permissions.argv || {};
  const { flags, options } = parseArgv(argv.slice(1), agent.permissions.aliases, {
    booleanNegation: syntax.booleanNegation === true,
    booleans: agent.permissions.lead.flatMap(rule => Object.entries(rule.when).filter(([, v]) => v === true).map(([k]) => k)),
  });
  return [...new Set(agent.permissions.lead.flatMap(rule => Object.entries(rule.when)
    .filter(([k, v]) => v === true ? flags.has(k) : options.get(k) === v)
    .map(([k, v]) => v === true ? k : `${k} ${v}`)))];
}
function identifiedLead(agent, argv, pid, identifiedBy) {
  const lead = { agentId: agent.id, pid, level: daemonTitleProgram(argv[0]) ? DEFAULT_LEVEL : levelFromArgv(agent, argv.slice(1)) };
  // Preserve the public enumerable {agentId,pid,level} contract.
  Object.defineProperties(lead, { identifiedBy: { value: identifiedBy }, program: { value: agent.command },
    flags: { value: Object.freeze(permissionFlags(agent, argv)) } });
  return Object.freeze(lead);
}

function readCmdline(pid) {
  const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  return raw.split('\0').filter((word, index, all) => index < all.length - 1 || word !== '');
}

function readParent(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return Number(fields[1]);
}

function isWrapper(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return false;
  const first = programName(argv[0]);
  if (process.platform === 'win32' && ['cmd', 'powershell', 'pwsh'].includes(first)) return true;
  if (WRAPPERS.has(first)) return true;
  return INTERPRETERS.has(first) && argv.length > 1 && WRAPPER_SCRIPTS.has(path.basename(String(argv[1])));
}

/* The lead agent that started this process: the parent, looking through
   launch wrappers (sh -c, env, npx, ...), whose program is a described agent,
   and the level its own flags start it at. Null when whatever started Fleet is
   not an agent (another MCP client, a test runner, a platform without /proc). */
/* A DETACHED FLEET HUB HAS NO AGENT ANCESTOR once its starter exits, so it
   records the lead it was started under once, at startup, after checking that
   lead really was its ancestor (src/lib/fleet-hub.js). The record only replaces
   the default ancestor walk; it can name no level the lead did not start with,
   TOOLSENABLED_LEVEL_CAP still lowers it, and explicit lookups are unchanged. */
let pinnedLead;
function pinLead(lead) {
  if (pinnedLead !== undefined) throw Object.assign(new Error('The lead of this process was already recorded.'), { code: 'LEAD_ALREADY_PINNED' });
  if (lead !== null && !(lead && typeof lead.agentId === 'string' && Number.isSafeInteger(lead.pid) && isLevel(lead.level)))
    throw Object.assign(new Error('A recorded lead needs its agent, process and level.'), { code: 'LEAD_PIN_INVALID' });
  pinnedLead = lead === null ? null : Object.freeze(Object.defineProperties({ agentId: lead.agentId, pid: lead.pid, level: lead.level }, {
    identifiedBy: { value: lead.identifiedBy }, program: { value: lead.program }, flags: { value: lead.flags } }));
  return pinnedLead;
}
function findLead(options = {}) {
  if (pinnedLead !== undefined && options.startPid === undefined && options.read === undefined && options.parent === undefined && options.executable === undefined) return pinnedLead;
  return walkLead(options);
}
function walkLead({ registry, startPid = process.ppid, read = readCmdline, parent = readParent,
  executable = readExecutable, realpath = fs.realpathSync, commandPath, platform = process.platform,
  observe = require('../windows-process-observation').readWindowsProcesses } = {}) {
  if (platform === 'win32' && read === readCmdline && parent === readParent) {
    let rows;
    try { rows = observe({ startPid: startPid === process.ppid ? process.pid : startPid }); } catch { return null; }
    read = pid => rows.get(pid)?.argv;
    parent = pid => rows.get(pid)?.ppid;
    executable = pid => rows.get(pid)?.executable;
  }
  let pid = startPid;
  for (let step = 0; step < MAX_ANCESTORS && Number.isInteger(pid) && pid > 1; step += 1) {
    let argv;
    try { argv = read(pid); } catch { return null; }
    if (!Array.isArray(argv) || !argv.length) return null;
    const identity = processIdentity(registry, argv, pid, { executable, realpath, commandPath, platform });
    if (identity) return identifiedLead(identity.agent, argv, pid, identity.identifiedBy);
    if (!isWrapper(argv)) return null;
    try { pid = parent(pid); } catch { return null; }
  }
  return null;
}

// Lead permissions come only from explicit administrator settings. Identity
// helpers above remain available for diagnostics; no permission path calls them.
function leadLevel({ env = process.env } = {}) {
  return Object.freeze({ agentId: null, detected: LEVEL.EVERYTHING,
    level: narrowest(LEVEL.EVERYTHING, Number(env.TOOLSENABLED_LEVEL_CAP)) });
}
function leadPermissionContext({ env = process.env } = {}) {
  const result = leadLevel({ env });
  return Object.freeze({ ...result, source: 'administrator-settings',
    verifiedParent: false, permissionPolicyVerified: false,
    reason: 'explicit-administrator-settings', fallback: false,
    identifiedBy: 'not-inferred', program: null, flags: [],
    cap: isLevel(Number(env.TOOLSENABLED_LEVEL_CAP)) ? Number(env.TOOLSENABLED_LEVEL_CAP) : null });
}

/** Administrator worker ceiling; independent of detected lead permissions. */
function workerLevel({ env = process.env } = {}) {
  const setting = env.TOOLSENABLED_WORKER_LEVEL;
  const level = setting === undefined || setting === '' ? LEVEL.EVERYTHING : Number(setting);
  if (!isLevel(level)) throw Object.assign(new Error('TOOLSENABLED_WORKER_LEVEL must be 1, 2, 3 or 4; the worker was not started.'),
    { code: 'AGENT_WORKER_LEVEL_INVALID' });
  return narrowest(LEVEL.EVERYTHING, level, Number(env.TOOLSENABLED_LEVEL_CAP));
}

/** How to start this agent as a worker at a level, from its descriptor. */
/* The exact options that start a lead at level 4, read from its own
   descriptor, for refusal text only: the lead Fleet found, or every described
   agent when it found none (another MCP client, a test runner). Fleet changes
   no option; the person restarts their own lead if they choose to. */
function noPromptsHint({ registry, lead } = {}) {
  if (!registry) return 'start your lead with its no-prompts setting';
  if (lead === undefined) lead = null;
  const options = agent => agent.permissions.lead.filter(rule => rule.level === 4)
    .map(rule => Object.entries(rule.when).map(([name, value]) => value === true ? name : `${name} ${value}`).join(' '));
  const agents = lead && registry.get(lead) ? [registry.get(lead)] : registry.agents;
  const named = agents.map(agent => [agent.name, options(agent)]).filter(([, rows]) => rows.length)
    .map(([name, rows]) => `${name}: ${rows.join(' or ')}`);
  return named.length ? `start your lead with its no-prompts setting (${named.join('; ')})` : 'start your lead with its no-prompts setting';
}

/** Refuse a worker below its agent's described minimum level; never widen. */
function assertWorkerLevel(descriptor, level, { registry, lead } = {}) {
  const minimum = descriptor.permissions.workerMinimum;
  if (minimum && level < minimum.level) {
    throw Object.assign(new Error(`${minimum.reason} This worker inherited level ${level} (${LEVEL_NAMES[level]}) and ${descriptor.name} workers need level ${minimum.level} (${LEVEL_NAMES[minimum.level]}), so it was not started; Fleet preserves administrator and role ceilings. Choose another agent for this worker, or review TOOLSENABLED_WORKER_LEVEL, TOOLSENABLED_LEVEL_CAP and role limits.`),
      { code: 'AGENT_WORKER_LEVEL_UNAVAILABLE' });
  }
}

function workerSettings(descriptor, level) {
  if (!isLevel(level)) throw Object.assign(new Error('A worker level must be 1 to 4.'), { code: 'AGENT_LEVEL_INVALID' });
  return descriptor.permissions.worker[level];
}

// Roles name categories, not vendor tool names. Inheritance can only add removals.
const NATIVE_TOOL_CATEGORIES = Object.freeze(['shell', 'web', 'subagents']);
function nativeToolRemovals(...lists) {
  for (const list of lists) {
    if (list !== undefined && (!Array.isArray(list) || list.some(value => !NATIVE_TOOL_CATEGORIES.includes(value)))) {
      throw Object.assign(new Error('removeNativeTools must contain only shell, web or subagents.'), { code: 'AGENT_NATIVE_TOOLS_INVALID' });
    }
  }
  return Object.freeze(NATIVE_TOOL_CATEGORIES.filter(category => lists.some(list => list?.includes(category))));
}

function nativeRemovalSettings(descriptor, removals = []) {
  // Native delegation is never a role choice: only Fleet may grow the tree.
  const categories = nativeToolRemovals(removals, ['subagents']);
  const args = [], overrides = {}, rejectKinds = [], settings = [];
  let env = {};
  for (const category of categories) {
    const removal = descriptor.permissions.remove?.[category];
    if (!removal || removal.unavailable) throw Object.assign(new Error(`${descriptor.name} cannot remove native ${category} tools, so this worker was not started.${removal?.unavailable ? ` ${removal.unavailable}` : ''}`),
      { code: 'AGENT_NATIVE_TOOLS_UNAVAILABLE' });
    args.push(...(removal.args || []));
    for (const [key, value] of Object.entries(removal.overrides || {})) {
      if (Object.hasOwn(overrides, key) && overrides[key] !== value) {
        throw Object.assign(new Error(`${descriptor.name} has conflicting native ${category} removals, so this worker was not started.`),
          { code: 'AGENT_NATIVE_TOOLS_UNAVAILABLE' });
      }
      overrides[key] = value;
    }
    rejectKinds.push(...(removal.rejectKinds || []));
    env = require('./native-removal-environment').mergeRemovalEnvironment(env, removal.env || {});
    if (removal.settings) settings.push(removal.settings);
  }
  return Object.freeze({ args: Object.freeze(args), overrides: Object.freeze(overrides),
    ...(descriptor.permissions.workerAgent ? { workerAgent: descriptor.permissions.workerAgent } : {}),
    env: Object.freeze(env), settings: Object.freeze(settings), rejectKinds: Object.freeze([...new Set(rejectKinds)]) });
}

module.exports = Object.freeze({
  pinLead,
  LEVEL, LEVEL_NAMES, DEFAULT_LEVEL, isLevel, narrowest,
  NATIVE_TOOL_CATEGORIES, nativeToolRemovals, nativeRemovalSettings,
  parseArgv, levelFromArgv, agentOfArgv, findLead, leadLevel, leadPermissionContext, workerLevel, workerSettings, assertWorkerLevel, noPromptsHint
});
