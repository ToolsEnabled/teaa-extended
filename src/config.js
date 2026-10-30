// Per-user settings and explicit upstream discovery. Never guess how an unknown Fleet starts.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configDir, dataDir, defaultWorkFolder, expandHome, isWindows, which, requirePython311, resolveCommand, spawnResolvedSync } from './platform.js';
import { fileURLToPath } from 'node:url';

export const CONFIG_FILE = 'config.json';
const launchFolders = new WeakMap();
export function defaults() {
  return {
    fleet: { enabled: true, command: null, args: [], env: {} },
    engine: { enabled: true, command: null, args: [], env: {}, browser: false },
    knowledge: { enabled: true, command: null, args: [], env: {}, repo: null, sync: 'off', interior: 'refuse' },
    mcp: { folder: defaultWorkFolder(), actor: null },
  };
}
export function configPath(dir = configDir()) { return join(dir, CONFIG_FILE); }
const record = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
function merge(base, over) {
  if (!record(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (['__proto__', 'prototype', 'constructor'].includes(k)) throw new Error(`Unsupported settings key ${k}`);
    out[k] = record(v) ? merge(record(base?.[k]) ? base[k] : {}, v) : v;
  }
  return out;
}
const string = (x) => typeof x === 'string' && !x.includes('\0');
export function validateConfig(cfg) {
  const fail = (field, what) => { throw new Error(`Invalid TEAA setting ${field}: ${what}`); };
  if (!record(cfg)) fail('config', 'expected an object');
  for (const key of ['fleet', 'engine', 'knowledge']) {
    const s = cfg[key];
    if (!record(s)) fail(key, 'expected an object');
    if (typeof s.enabled !== 'boolean') fail(`${key}.enabled`, 'expected true or false');
    if (s.command !== null && (!string(s.command) || !s.command.trim())) fail(`${key}.command`, 'expected a program path or null');
    if (!Array.isArray(s.args) || s.args.some((arg) => !string(arg))) fail(`${key}.args`, 'expected an array of argument strings');
    if (!record(s.env) || Object.entries(s.env).some(([name, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !string(value))) fail(`${key}.env`, 'expected environment names with string values');
  }
  if (typeof cfg.engine.browser !== 'boolean') fail('engine.browser', 'expected true or false');
  if (cfg.knowledge.repo !== null && (!string(cfg.knowledge.repo) || !cfg.knowledge.repo.trim())) fail('knowledge.repo', 'expected a folder path or null');
  if (!['off', 'background'].includes(cfg.knowledge.sync)) fail('knowledge.sync', 'expected off or background');
  if (!['refuse', 'allow'].includes(cfg.knowledge.interior)) fail('knowledge.interior', 'expected refuse or allow');
  if (!record(cfg.mcp)) fail('mcp', 'expected an object');
  if (!string(cfg.mcp.folder) || !cfg.mcp.folder.trim()) fail('mcp.folder', 'expected a folder path');
  if (cfg.mcp.actor !== null) validateActor(cfg.mcp.actor);
  // Legacy lead/chat settings are retained as data only; no provider is selected or launched.
  return cfg;
}
export function loadConfig({ dir = configDir(), file } = {}) {
  const path = file || configPath(dir);
  let saved = {};
  if (existsSync(path)) {
    try { saved = JSON.parse(readFileSync(path, 'utf8')); } catch (err) { throw new Error(`Could not read ${path}: ${err.message}`); }
    if (!record(saved)) throw new Error(`Invalid TEAA settings in ${path}: expected an object`);
  }
  if (Object.hasOwn(saved, 'mcp') && !record(saved.mcp)) throw new Error('Invalid TEAA setting mcp: expected an object');
  // Earlier releases stored the MCP folder under lead. Preserve an explicit choice.
  const folder = Object.hasOwn(saved.mcp || {}, 'folder') ? saved.mcp.folder : '.';
  const cfg = validateConfig(merge(defaults(), { ...saved, mcp: saved.mcp === null ? null : { ...saved.mcp, folder } }));
  cfg.mcp.folder = resolve(expandHome(cfg.mcp.folder));
  launchFolders.set(cfg, { cwd: process.cwd(), inherited: folder === '.' });
  cfg._path = path;
  return cfg;
}
export function saveConfig(cfg, { dir = configDir(), file, pinFolders = false } = {}) {
  validateConfig(cfg);
  const path = file || cfg._path || configPath(dir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const { _path, ...plain } = cfg;
  const launch = launchFolders.get(cfg);
  if (!pinFolders && launch?.inherited && cfg.mcp.folder === launch.cwd) plain.mcp = { ...cfg.mcp, folder: '.' };
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(plain, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } finally { try { unlinkSync(tmp); } catch (err) { if (err.code !== 'ENOENT') throw err; } }
  return path;
}
export function fleetCandidates(env = process.env) {
  const home = homedir();
  const list = [];
  if (env.TEAA_FLEET_HOST) list.push(env.TEAA_FLEET_HOST);
  if (isWindows) {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    list.push(join(local, 'ToolsEnabled', 'Fleet', 'bin', 'toolsenabled-host.js'));
    list.push(join(local, 'Programs', 'ToolsEnabled', 'Fleet', 'bin', 'toolsenabled-host.js'));
  }
  list.push(join(home, '.local', 'share', 'toolsenabled-fleet-mcp', 'bin', 'toolsenabled-host.js'));
  list.push(join(home, '.local', 'toolsenabled-host', 'toolsenabled-installer', 'payload', 'engine', 'bin', 'toolsenabled-host.js'));
  return list;
}
function validEntry(entry) {
  return record(entry) && string(entry.command) && entry.command.length > 0 &&
    (entry.args === undefined || Array.isArray(entry.args) && entry.args.every(string)) &&
    (entry.env === undefined || record(entry.env) && Object.values(entry.env).every(string));
}
export function fleetServerEntry(hostScript, { stateRoot, actor, env = process.env } = {}) {
  const resolved = resolveCommand(hostScript, ['setup', '--print-server-json', ...(stateRoot ? ['--state-root', stateRoot] : [])], env);
  if (!resolved.file) throw new Error(`Fleet host not found: ${hostScript}`);
  const r = spawnResolvedSync(resolved, { encoding: 'utf8', timeout: 20_000, env, maxBuffer: 1024 * 1024 });
  if (r.status !== 0) throw new Error(`Fleet could not provide its server entry: ${r.error?.message || String(r.stderr || '').trim().slice(-1200) || `exit ${r.status}`}. Finish Fleet setup or choose a configured installation.`);
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { throw new Error('Fleet returned invalid server-entry JSON; no launch command was guessed.'); }
  const entries = parsed?.server ? [parsed.server] : parsed?.mcpServers ? Object.values(parsed.mcpServers) : [parsed];
  if (entries.length !== 1 || !validEntry(entries[0])) throw new Error('Fleet returned an ambiguous or invalid server entry');
  const entry = entries[0];
  return { command: entry.command, args: entry.args || [], env: entry.env || {} };
}
export function detectFleet(env = process.env) {
  const errors = [];
  for (const p of fleetCandidates(env)) {
    if (!p || !existsSync(p)) {
      if (p && p === env.TEAA_FLEET_HOST) throw new Error(`TEAA_FLEET_HOST does not exist: ${p}`);
      continue;
    }
    try { return { ...fleetServerEntry(p, { env }), found: p }; }
    catch (err) { if (p === env.TEAA_FLEET_HOST) throw err; errors.push(err.message); }
  }
  const onPath = which('toolsenabled-host', env);
  if (onPath) {
    try { return { ...fleetServerEntry(onPath, { env }), found: onPath }; }
    catch (err) { errors.push(err.message); }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return null;
}
export function detectEngine(env = process.env) {
  if (env.TEAA_TOOLSENGINE) {
    const d = resolveCommand(env.TEAA_TOOLSENGINE, [], env);
    if (!d.file) throw new Error(`TEAA_TOOLSENGINE not found: ${env.TEAA_TOOLSENGINE}`);
    return { command: d.file, args: d.args, found: env.TEAA_TOOLSENGINE };
  }
  const onPath = which('toolsengine', env);
  if (onPath) { const d = resolveCommand(onPath, [], env); return { command: d.file, args: d.args, found: onPath }; }
  // Native archive installations do not add toolsengine to PATH. Read their own receipt.
  const root = join(homedir(), 'ToolsEngine');
  let versions = [];
  try { versions = readdirSync(root).filter((v) => /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); } catch { /* not installed */ }
  for (const v of versions) {
    const receipt = join(root, v, 'installation.json');
    try {
      const r = JSON.parse(readFileSync(receipt, 'utf8'));
      if (r.name !== 'ToolsEngine' || r.state === 'installing' || !isAbsolute(r.entry) || !existsSync(r.entry) || !Array.isArray(r.serverArgs) || !r.serverArgs.every(string)) continue;
      const d = resolveCommand(r.node || process.execPath, [r.entry, ...r.serverArgs], env);
      if (d.file) return { command: d.file, args: d.args, found: r.entry };
    } catch { /* incomplete receipt is not an installed runtime */ }
  }
  return null;
}
function withoutOption(args, option) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === option) { i++; continue; }
    if (!args[i].startsWith(`${option}=`)) out.push(args[i]);
  }
  return out;
}
export function validateActor(actor) {
  if (typeof actor !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(actor)) throw new Error('Invalid Fleet actor name');
  return actor; // Fleet's own registry decides whether this name is supported.
}
function savedActor(args = []) {
  let actor;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--actor') actor = validateActor(args[++i]);
    else if (args[i].startsWith('--actor=')) actor = validateActor(args[i].slice(8));
  }
  return actor;
}
export function mcpFolder(cfg) { return cfg.mcp?.folder ?? defaultWorkFolder(); }
export function fleetActor(cfg, { actor, entry = cfg.fleet } = {}) {
  return validateActor(actor ?? cfg.mcp?.actor ?? savedActor(entry?.args) ?? 'local');
}
// The Fleet bundled in this TEAA release keeps its own state. When TEAA itself runs inside another
// Fleet's session, that Fleet's TOOLSENABLED_* variables (state root, settings, allowlist)
// are not passed on, so the bundled Fleet never reads another Fleet's state.
export const BUNDLED_FLEET_DIR = fileURLToPath(new URL('../vendor/fleet/', import.meta.url));
export function isBundledFleet(entry, bundledDir = BUNDLED_FLEET_DIR) {
  const fold = (p) => isWindows ? p.toLowerCase() : p;
  const root = fold(resolve(bundledDir));
  return (entry?.args || []).some((arg) => typeof arg === 'string' && isAbsolute(arg) && fold(resolve(arg)).startsWith(root + sep));
}
export const BUNDLED_FLEET_DROP = Object.freeze(['TOOLSENABLED_']);
export function fleetLaunch(cfg, { actor, folder = mcpFolder(cfg), bundledDir } = {}) {
  if (!cfg.fleet.enabled) return null;
  const s = cfg.fleet.command ? cfg.fleet : detectFleet();
  if (!s) return null;
  const selected = fleetActor(cfg, { actor, entry: s });
  return { command: s.command, args: [...withoutOption(s.args || [], '--actor'), '--actor', selected], env: { ...(s.env || {}), ...cfg.fleet.env }, cwd: folder,
    ...(isBundledFleet(s, bundledDir) ? { dropInherited: [...BUNDLED_FLEET_DROP] } : {}) };
}
// Setup's local signing-key audit needs Fleet's operator-only status tool. Keep
// that authority on this temporary child process; the saved ordinary lead
// connection remains the contract-only V5 surface.
export function fleetAuditLaunch(cfg, options = {}) {
  const launch = fleetLaunch(cfg, options);
  if (!launch || !isBundledFleet(cfg.fleet, options.bundledDir)) return launch;
  const serve = launch.args.indexOf('serve');
  if (serve < 0 || launch.args.includes('--admin')) return launch;
  const args = [...launch.args];
  args.splice(serve + 1, 0, '--admin');
  return { ...launch, args };
}
export const BUNDLED_KNOWLEDGE = fileURLToPath(new URL('../vendor/knowledge/knowledge.py', import.meta.url));
export function detectKnowledge(env = process.env) {
  if (env.TEAA_KNOWLEDGE) {
    const script = resolve(expandHome(env.TEAA_KNOWLEDGE));
    if (!existsSync(script)) throw new Error(`TEAA_KNOWLEDGE not found: ${script}`);
    const python = requirePython311(env);
    return { command: python, args: [script], found: script };
  }
  if (existsSync(BUNDLED_KNOWLEDGE)) {
    const python = requirePython311(env);
    return { command: python, args: [BUNDLED_KNOWLEDGE], found: BUNDLED_KNOWLEDGE };
  }
  return null;
}
export function knowledgeConfigPath(env = process.env) { return join(dataDir(env), 'knowledge-config.json'); }
export function knowledgeLaunch(cfg, { folder = mcpFolder(cfg) } = {}) {
  if (!cfg.knowledge.enabled) return null;
  const s = cfg.knowledge.command ? cfg.knowledge : detectKnowledge();
  if (!s) return null;
  let args = [...(s.args || [])];
  const script = args.find((arg) => arg.endsWith(`${sep}knowledge.py`) || arg.endsWith('/knowledge.py'));
  if (script && !args.includes('--config')) args = [script, '--config', knowledgeConfigPath(), '--owner-launch', ...args.filter((arg) => arg !== script)];
  return { command: s.command, args, env: { ...(s.env || {}), ...cfg.knowledge.env }, cwd: folder };
}
export function engineLaunch(cfg, { folder = mcpFolder(cfg) } = {}) {
  if (!cfg.engine.enabled) return null;
  const s = cfg.engine.command ? cfg.engine : detectEngine();
  if (!s) return null;
  let args = [...withoutOption(s.args || [], '--workspace'), '--workspace', folder];
  if (cfg.engine.browser === false) {
    for (const option of ['--profile-dir', '--browser-executable', '--browser-channel', '--cdp-endpoint']) args = withoutOption(args, option);
    args = args.filter((arg) => !['--browser-extension', '--firefox-desktop', '--firefox-hidden', '--no-browser-sandbox', '--headed', '--headless', '--no-browser'].includes(arg));
    args.push('--no-browser');
  }
  return { command: s.command, args, env: { ...(s.env || {}), ...cfg.engine.env }, cwd: folder };
}
// Bare stdio entry: hosts own the surrounding registration map and permissions.
export function serverEntry(cfg, { actor } = {}) {
  return { command: process.execPath, args: [fileURLToPath(new URL('../bin/teaa.js', import.meta.url)), 'mcp', '--actor', fleetActor(cfg, { actor })] };
}
export function ensureFolder(folder) { mkdirSync(folder, { recursive: true }); return folder; }
