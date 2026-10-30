'use strict';

// HUB LEAD BRIDGE (Vultr side). The forced command of one machine's SSH key.
//
// authorized_keys pins `--machine NAME`; the remote asks for one thing only,
// in SSH_ORIGINAL_COMMAND:  attach actor=<agent> [tag=<id>] [level=<1-4>]
// The bridge then runs the hub's own `fleetV2 serve --attach` proxy under the
// orchestrator name <machine>-<actor>[-<tag>], with stdio as the SSH stream.
// The remote can choose neither the name prefix, an arbitrary hub, nor any other
// command. Optional server-owned routes bind exact orchestrator names to hubs.
//
// LEVEL. The hub reads the proxy's lead level from this machine's /proc
// (fleet-hub.js orchestratorLead). Over SSH there is no agent CLI above the
// proxy, so the hub reads level 2 and refuses a narrower orchestrator.
//   FLEET_HUB_LEVEL_MODE=verify  (default) run the proxy as a plain child; the
//                                hub decides with no help, and refuses.
//   FLEET_HUB_LEVEL_MODE=mirror  run it under level-holder.cjs, a parent whose
//                                command line carries the level the REMOTE
//                                reported for its own lead (never above
//                                FLEET_HUB_MAX_LEVEL). This mirrors a remote
//                                fact; it is not verified on this machine.
//                                Enable only on the owner's answer.

const path = require('node:path');
const { spawn } = require('node:child_process');
const { readPrivateJsonFile, readPrivateTextFile, appendPrivateTextFile } = require('../remote/fra-device.cjs');
const { pairFromSelectedConfig, assertClaim, parseClaimText } = require('./gateway-compatibility.cjs');

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/; // fleet-hub.js NAME
const MACHINE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const TAG = /^[a-z0-9][a-z0-9-]{0,15}$/;
const ACTOR = /^[a-z][a-z0-9-]{0,31}$/;
const MODES = new Set(['verify', 'mirror']);
const ENV_KEYS = new Set(['FLEET_HUB_STATE_ROOT', 'FLEET_HUB_TREE_KEY', 'FLEET_HUB_RUNTIME',
  'FLEET_HUB_LEVEL_MODE', 'FLEET_HUB_MAX_LEVEL', 'FLEET_HUB_BRIDGE_LOG', 'FLEET_HUB_ROUTES_FILE']);

function refusal(code, message) { return Object.assign(new Error(message), { code }); }

/** KEY=VALUE lines; # comments; no shell expansion. */
function readEnvFile(file) {
  let text;
  try { text = readPrivateTextFile(file, 64 * 1024, 'BRIDGE_CONFIG_INVALID'); }
  catch { throw refusal('BRIDGE_CONFIG_INVALID', 'The private bridge configuration could not be read safely.'); }
  const values = Object.create(null);
  const lines = text.split('\n');
  if (lines.length > 64) throw refusal('BRIDGE_CONFIG_INVALID', 'The bridge configuration has too many lines.');
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index);
    const value = line.slice(index + 1);
    if (index <= 0 || !ENV_KEYS.has(key) || Object.hasOwn(values, key)
        || !value || /[\x00-\x1f\x7f]/.test(line) || line !== line.trim()) {
      throw refusal('BRIDGE_CONFIG_INVALID', 'The bridge configuration contains an unknown, duplicate or malformed setting.');
    }
    values[key] = value;
  }
  return values;
}

function absoluteConfigPath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)
      || path.normalize(value) !== value || value.split(path.sep).some(part => part === '.' || part === '..')) {
    throw refusal('BRIDGE_CONFIG_INVALID', `${label} must be a canonical absolute path.`);
  }
  return value;
}

function loadConfig(file) {
  const values = readEnvFile(file);
  const config = {
    stateRoot: values.FLEET_HUB_STATE_ROOT, treeKey: values.FLEET_HUB_TREE_KEY, runtime: values.FLEET_HUB_RUNTIME,
    mode: values.FLEET_HUB_LEVEL_MODE || 'verify', maxLevel: Number(values.FLEET_HUB_MAX_LEVEL || 4),
    log: values.FLEET_HUB_BRIDGE_LOG || null,
  };
  for (const key of ['stateRoot', 'runtime']) config[key] = absoluteConfigPath(config[key], key);
  if (!config.treeKey || !NAME.test(config.treeKey)) throw refusal('BRIDGE_CONFIG_INVALID', 'FLEET_HUB_TREE_KEY is missing or invalid.');
  if (!MODES.has(config.mode)) throw refusal('BRIDGE_CONFIG_INVALID', 'FLEET_HUB_LEVEL_MODE is verify or mirror.');
  if (![1, 2, 3, 4].includes(config.maxLevel)) throw refusal('BRIDGE_CONFIG_INVALID', 'FLEET_HUB_MAX_LEVEL is 1 to 4.');
  if (config.log) config.log = absoluteConfigPath(config.log, 'FLEET_HUB_BRIDGE_LOG');
  if (values.FLEET_HUB_ROUTES_FILE) config.routes = loadRoutes(values.FLEET_HUB_ROUTES_FILE);
  return config;
}

function loadRoutes(file) {
  absoluteConfigPath(file, 'FLEET_HUB_ROUTES_FILE');
  let doc;
  try { doc = readPrivateJsonFile(file, 256 * 1024); }
  catch { throw refusal('BRIDGE_CONFIG_INVALID', 'The server-owned route file could not be read.'); }
  if (!doc || doc.version !== 1 || !doc.orchestrators || typeof doc.orchestrators !== 'object'
      || Array.isArray(doc.orchestrators) || Object.keys(doc).some(k => !['version', 'orchestrators'].includes(k))) {
    throw refusal('BRIDGE_CONFIG_INVALID', 'Invalid server-owned route document.');
  }
  const routes = Object.create(null);
  if (Object.keys(doc.orchestrators).length > 128) throw refusal('BRIDGE_CONFIG_INVALID', 'The server-owned route file has too many routes.');
  for (const [name, route] of Object.entries(doc.orchestrators)) {
    if (!NAME.test(name) || !route || typeof route !== 'object' || Array.isArray(route)
        || Object.keys(route).length !== 3 || Object.keys(route).some(k => !['runtime', 'stateRoot', 'treeKey'].includes(k))
        || typeof route.treeKey !== 'string' || !NAME.test(route.treeKey)
        || ['runtime', 'stateRoot'].some(k => {
          try { absoluteConfigPath(route[k], k); return false; } catch { return true; }
        })) {
      throw refusal('BRIDGE_CONFIG_INVALID', 'Invalid server-owned orchestrator route.');
    }
    routes[name] = Object.freeze({ runtime: route.runtime, stateRoot: route.stateRoot, treeKey: route.treeKey });
  }
  return Object.freeze(routes);
}

function selectRoute(config, machine, requestText) {
  const name = orchestratorName(machine, parseRequest(requestText));
  if (!config.routes || !Object.hasOwn(config.routes, name)) return config;
  // Only the three target coordinates can change; mirror/verify, the level cap,
  // enrolled machine identity, actor checks and transport are unchanged.
  return { ...config, ...config.routes[name] };
}

/** The one request a remote may make. Anything else is refused by name. */
function parseRequest(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words[0] !== 'attach') throw refusal('BRIDGE_COMMAND_REFUSED', 'This key only runs: attach actor=<agent> [tag=<id>] [level=<1-4>].');
  const request = {};
  for (const word of words.slice(1)) {
    const match = /^(actor|tag|level)=(.+)$/.exec(word);
    if (!match || Object.hasOwn(request, match[1])) throw refusal('BRIDGE_COMMAND_REFUSED', `Unexpected argument: ${word.slice(0, 40)}`);
    request[match[1]] = match[2];
  }
  if (!request.actor || !ACTOR.test(request.actor)) throw refusal('BRIDGE_ACTOR_INVALID', 'Name the remote lead\'s agent in actor=.');
  if (request.tag !== undefined && !TAG.test(request.tag)) throw refusal('BRIDGE_TAG_INVALID', 'tag is 1-16 lowercase letters, digits or dashes.');
  if (request.level !== undefined) {
    if (!/^[1-4]$/.test(request.level)) throw refusal('BRIDGE_LEVEL_INVALID', 'level is 1 to 4.');
    request.level = Number(request.level);
  }
  return request;
}

function orchestratorName(machine, request) {
  if (!MACHINE.test(machine)) throw refusal('BRIDGE_MACHINE_INVALID', 'The key\'s --machine is invalid.');
  const name = [machine, request.actor, request.tag].filter(Boolean).join('-');
  if (!NAME.test(name)) throw refusal('BRIDGE_NAME_INVALID', `Orchestrator name ${name.slice(0, 80)} is not a valid hub name.`);
  return name;
}

/* The argv words that start this agent at exactly `level`, read from the
   agent's own Fleet descriptor (the rules permission-level.js reads back).
   Level 2 is Fleet's default and needs no words. Null when the descriptor
   has no rule for that level. */
function levelWords(descriptor, level) {
  if (level === 2) return [];
  const rule = descriptor.permissions.lead.find(item => item.level === level);
  if (!rule) return null;
  return Object.entries(rule.when).flatMap(([option, value]) => (value === true ? [option] : [option, value]));
}

/** What to spawn, as data, so tests can call it with values. */
function plan({ machine, requestText, config, hub, registry, nodePath }) {
  const request = parseRequest(requestText);
  const name = orchestratorName(machine, request);
  if (request.actor !== 'local' && !registry.has(request.actor)) throw refusal('BRIDGE_ACTOR_INVALID', `${request.actor} is not an agent this hub describes.`);
  const proxy = [nodePath, hub.entry, 'serve', '--state-root', config.stateRoot, '--actor', request.actor,
    '--tree-key', config.treeKey, '--attach', '--name', name];
  if (config.mode === 'verify') return { name, request, mode: 'verify', level: null, command: proxy[0], args: proxy.slice(1), argv0: undefined };
  if (request.level === undefined) throw refusal('BRIDGE_LEVEL_MISSING', 'Mirror mode needs the remote lead\'s level (level=); the remote launcher could not read it.');
  const level = Math.min(request.level, config.maxLevel);
  const descriptor = registry.get(request.actor);
  const words = descriptor && levelWords(descriptor, level);
  if (!words) throw refusal('BRIDGE_LEVEL_UNDESCRIBED', `${request.actor} has no described command line for level ${level}.`);
  return { name, request, mode: 'mirror', level, command: nodePath,
    args: [path.join(__dirname, 'level-holder.cjs'), ...words], argv0: descriptor.command, proxy };
}

function log(config, row) {
  if (!config.log) return;
  try { appendPrivateTextFile(config.log, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`); } catch { /* logging never blocks */ }
}

function main(argv, env) {
  const machineIndex = argv.indexOf('--machine');
  const configIndex = argv.indexOf('--config');
  const machine = machineIndex >= 0 ? argv[machineIndex + 1] : '';
  const configFile = configIndex >= 0 ? argv[configIndex + 1] : path.join(__dirname, '..', 'etc', 'bridge.env');
  let config = null;
  try {
    config = selectRoute(loadConfig(configFile), machine, env.SSH_ORIGINAL_COMMAND);
    if (env.FLEET_HUB_COMPATIBILITY_CLAIM !== undefined) {
      assertClaim(pairFromSelectedConfig(config), parseClaimText(env.FLEET_HUB_COMPATIBILITY_CLAIM));
    }
    const fleetHub = require(path.join(config.runtime, 'src', 'lib', 'fleet-hub.js'));
    const hub = fleetHub.readHub(fleetHub.treeFolderOf(config.stateRoot, config.treeKey));
    if (!hub) throw refusal('HUB_NOT_RUNNING', 'No Fleet hub is running for the configured tree.');
    const registry = require(path.join(config.runtime, 'src', 'lib', 'agents', 'registry.js'))
      .activeRegistry({ ...env, TOOLSENABLED_STATE_ROOT: path.join(config.stateRoot, 'capability') });
    const step = plan({ machine, requestText: env.SSH_ORIGINAL_COMMAND, config, hub, registry, nodePath: process.execPath });
    const source = String(env.SSH_CONNECTION || '').split(' ')[0] || null;
    log(config, { machine, name: step.name, actor: step.request.actor, mode: step.mode, level: step.level, reported: step.request.level ?? null, source });
    process.stderr.write(`[hub-lead-bridge] ${machine}: attaching as ${step.name} (${step.mode}${step.level ? `, level ${step.level} as reported by the remote` : ''}).\n`);
    const child = spawn(step.command, step.args, { stdio: 'inherit', ...(step.argv0 ? { argv0: step.argv0 } : {}),
      env: { ...env, ...(step.proxy ? { FLEET_HUB_LEAD_PROXY: JSON.stringify(step.proxy) } : {}) } });
    for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(signal, () => child.kill(signal));
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  } catch (error) {
    if (config) log(config, { machine, refused: error.code || 'BRIDGE_ERROR' });
    process.stderr.write(`[hub-lead-bridge] refused (${error.code || 'BRIDGE_ERROR'}): ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (require.main === module) main(process.argv.slice(2), process.env);
module.exports = { parseRequest, orchestratorName, levelWords, plan, loadConfig, readEnvFile, loadRoutes, selectRoute };
