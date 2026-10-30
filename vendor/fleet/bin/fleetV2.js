#!/usr/bin/env node
'use strict';

process.umask(0o077);
const path = require('node:path');
const setup = require('../src/lib/fleet-v2-setup');

const V2 = Object.freeze({ name: 'fleetV2', generation: 2, entry: __filename, metadata: require('../fleetV2.json'), defaultStateRoot: setup.defaultStateRoot });
function parse(argv, product = V2) {
  const result = { command: argv[0] || 'help', stateRoot: product.defaultStateRoot(), readRoots: [], writeRoots: [], readAll: false, workers: true };
  const seen = new Set();
  for (let i = 1; i < argv.length; i += 1) {
    const option = argv[i];
    if (option === '--coordination-only') { result.workers = false; continue; }
    if (option === '--read-all') { result.readAll = true; continue; }
    if (option === '--json') { result.json = true; continue; }
    if (option === '--attach') { result.attach = true; continue; }
    if (option === '--hub') { result.hub = true; continue; }
    if (option === '--admin') { result.admin = true; continue; }
    if (option === '--ledger-only') { result.ledgerOnly = true; continue; }
    const names = { '--state-root': 'stateRoot', '--workspace': 'workspace', '--read-root': 'readRoots', '--write-root': 'writeRoots', '--actor': 'actor', '--tree-key': 'treeKey', '--revision': 'revision',
      '--source-state-root': 'sourceStateRoot', '--lead-pid': 'leadPid', '--name': 'name', '--to': 'to', '--note': 'note', '--since': 'since', '--limit': 'limit', '--orchestrator': 'orchestrator', '--wait': 'wait' };
    const name = names[option];
    if (!name || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Unknown option or missing value: ${option}`);
    if (!['readRoots', 'writeRoots'].includes(name) && seen.has(name)) throw new Error(`Supply ${option} once.`);
    seen.add(name);
    const value = argv[++i];
    if (Array.isArray(result[name])) result[name].push(value); else result[name] = ['revision', 'leadPid', 'since', 'limit', 'wait'].includes(name) ? Number(value) : value;
  }
  return result;
}

function assertProduct(config, product) {
  if ((config.generation || 2) !== product.generation) throw Object.assign(new Error(`Use the matching Fleet generation for this state; ${product.name} did not change it.`), { code: "FLEET_GENERATION_MISMATCH" });
}

async function main(argv = process.argv.slice(2), product = V2) {
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) {
    process.stdout.write(product.name + ': setup | serve | status | scope | rebind' + (product.generation >= 4 ? ' | call' : '') + '\n'
      + 'setup [--workspace ABS] [--state-root ABS] [--coordination-only] [--actor CLIENT]\n'
      + (product.generation === 5 ? '  Fleet V5 ordinary lead serving requires workers enabled; --coordination-only supports explicit admin maintenance only.\n' : '')
      + 'serve --state-root ABS --actor PROVIDER [--tree-key KEY] [--hub | --attach] [--name ORCHESTRATOR]\n'
      + 'serve --state-root ABS --actor PROVIDER --ledger-only   (lead ledger maintenance; existing workers stay running)\n'
      + 'hub start|status|inbox|handoff|stop --state-root ABS --actor PROVIDER [--tree-key KEY] [--to NAME --note TEXT] [--since SEQ --limit N]\n'
      + (product.generation >= 4 ? 'hub inbox --state-root ABS --actor PROVIDER [--tree-key KEY] --since SEQ [--limit N] --wait SECONDS   (wait for entries after SEQ without moving cursors; timeout JSON exits 5)\n' : '')
      + (product.generation === 5 ? 'serve [--attach | --hub] --admin   (explicit native administration; ordinary V5 leads use contract tools only)\ncall --admin ...   (native administration on a V5 hub connection)\n' : '')
      + 'status --state-root ABS [--actor CLIENT]\n'
      + 'scope --state-root ABS --revision CURRENT (--read-root ABS ... | --read-all) [--write-root ABS ...]\n'
      + 'rebind --state-root ABS   (after an upgrade: bind same-generation state to this runtime; no cross-generation migration)\n'
      + (product.generation === 3 ? 'import-v2 --source-state-root ABS --state-root NEW_ABS   (offline, separate-root Linux import)\n' : '')
      + (product.generation === 5 ? 'import-v4 --source-state-root ABS --state-root NEW_ABS   (offline, separate-root Linux import; source retained)\n' : '')
      + (product.generation === 4 ? 'import-v3 --source-state-root ABS --state-root NEW_ABS   (offline, separate-root Linux import; source retained)\n' : '')
      + (product.generation >= 4 ? 'call --state-root ABS --actor PROVIDER [--tree-key KEY] [--name NAME] [--timeout SECONDS] TOOL [JSON_ARGS | -]\n'
        + 'call --state-root ABS --actor PROVIDER [--tree-key KEY] [--name NAME] [--timeout SECONDS] --batch   (stdin: [{"tool":"fleet.control","arguments":{"action":"read"}}])\n'
        + `Call attaches like serve --attach, initializes MCP, prints one structured JSON line per call, and closes. For scripts acting on one target, expectedRevision:"latest" reads fleet.control (scoped to nodeId when supplied) immediately before that call; reconcile state before editing. Example: node ${product.name}.js call --state-root ABS --actor local fleet.control \'{"action":"read","nodeId":"worker-id"}\'; then node ${product.name}.js call --state-root ABS --actor local fleet.control \'{"action":"task","nodeId":"worker-id","text":"Corrected scope","expectedRevision":"latest"}\'. Exit 0: success; 2: refusal JSON with code, message and nextAction (batch stops); 3: transport/deadline failure, outcome unknown, read state before any retry. No call is replayed. Timeout defaults to 60 seconds for the attachment and all calls.\n` : '')
      + 'New installations inherit the launching environment. Working directory defaults to the terminal starting directory; configure any sandbox outside Fleet. Explicit root flags and scope are retained for legacy scoped installations.\n'); return;
  }
  if (argv.length === 1 && argv[0] === '--version') { process.stdout.write(`${product.name} ${product.metadata.version}\n`); return; }
  if (argv[0] === 'call' && product.generation >= 4) return require('../src/lib/fleet-lead-call').run(argv.slice(1), product);
  if (argv[0] === 'hub') return hubCommand(argv.slice(1), product);
  const options = parse(argv, product);
  require('../src/lib/fleet-v5-surface').validateAdmin(product.generation, options.admin);
  if (options.admin && options.command !== 'serve') throw new Error('--admin applies only to a V5 lead serve connection or call.');
  if (product.generation === 5 && options.ledgerOnly && !options.admin) throw new Error('V5 ledger maintenance requires explicit --admin.');
  if (options.wait !== undefined) throw new Error('--wait applies only to Fleet V4/V5 hub inbox.');
  if (options.command === 'import-v2') {
    if (product.generation !== 3 || !options.sourceStateRoot || !argv.includes('--state-root')
        || argv.slice(1).some(item => item.startsWith('--') && !['--source-state-root', '--state-root'].includes(item)))
      throw new Error('Use fleetV3 import-v2 with only --source-state-root ABS and --state-root NEW_ABS.');
    process.stdout.write(JSON.stringify(require('../src/lib/fleet-v3-import').importV2(options)) + '\n'); return;
  }
  if (options.command === 'import-v3') {
    if (product.generation !== 4 || !options.sourceStateRoot || !argv.includes('--state-root')
        || argv.slice(1).some(item => item.startsWith('--') && !['--source-state-root', '--state-root'].includes(item)))
      throw new Error('Use fleetV4 import-v3 with only --source-state-root ABS and --state-root NEW_ABS.');
    process.stdout.write(JSON.stringify(require('../src/lib/fleet-v3-import').importV3(options)) + '\n'); return;
  }
  if (options.command === 'import-v4') {
    if (product.generation !== 5 || !options.sourceStateRoot || !argv.includes('--state-root')
        || argv.slice(1).some(item => item.startsWith('--') && !['--source-state-root', '--state-root'].includes(item)))
      throw new Error('Use fleetV5 import-v4 with only --source-state-root ABS and --state-root NEW_ABS.');
    process.stdout.write(JSON.stringify(require('../src/lib/fleet-v3-import').importV4(options)) + '\n'); return;
  }
  if (options.sourceStateRoot) throw new Error('--source-state-root applies only to fleetV3 import-v2, fleetV4 import-v3 or fleetV5 import-v4.');
  if (options.command !== 'setup') assertProduct(require('../src/lib/host-runtime').readHostConfig(options.stateRoot, { allowStandaloneRebind: options.command === 'rebind' }), product);
  if (options.ledgerOnly && (options.command !== 'serve' || options.attach || options.hub || options.treeKey || options.name))
    throw new Error('--ledger-only applies only to a direct serve connection, without a tree or hub selection.');
  if (options.command === 'scope') {
    if (options.actor || options.treeKey || options.workspace || !options.workers) throw new Error('Scope edits take only state root, revision and complete read/write roots.');
    process.stdout.write(JSON.stringify(setup.updateScope(options)) + '\n'); return;
  }
  if (options.command === 'rebind') {
    if (options.actor || options.treeKey || options.workspace || options.readRoots.length || options.writeRoots.length || options.readAll || !options.workers)
      throw new Error('Rebind takes only the state root; everything else stays as saved.');
    process.stdout.write(JSON.stringify(setup.rebind(options)) + '\n'); return;
  }
  if (options.revision !== undefined) throw new Error('Revision applies only to a scope update.');
  if ((options.attach || options.hub || options.name) && options.command !== 'serve') throw new Error('--hub, --attach and --name apply only to serve.');
  if (options.attach && options.hub) throw new Error('Choose --hub (attach, starting a hub if needed) or --attach (attach only).');
  if (['leadPid', 'to', 'note', 'since', 'limit', 'orchestrator'].some(name => options[name] !== undefined)) throw new Error('That option applies only to fleetV2 hub.');
  if (options.command === 'setup') {
    if (options.treeKey) throw new Error('Tree key applies only to serve.');
    process.stdout.write(JSON.stringify(setup.setup({ ...options, generation: product.generation })) + '\n'); return;
  }
  if (!['serve', 'status'].includes(options.command)) throw new Error('Use fleetV2 setup, serve, status, scope or rebind.');
  if (options.workspace || options.readRoots.length || options.writeRoots.length || options.readAll || !options.workers)
    throw new Error('Folder policy is established by setup, never by a serve invocation.');
  const runtime = require('../src/lib/host-runtime');
  const config = runtime.readHostConfig(options.stateRoot);
  assertProduct(config, product);
  if (config.profile !== 'fleetV2' || config.setupKind === 'plugin' || (!config.fleetV2Scope && config.fleetV2Security !== 'inherited-environment'))
    throw new Error('This state is not a standalone fleetV2 installation.');
  if (options.command === 'status') {
    process.stdout.write(JSON.stringify({ name: product.name, version: product.metadata.version, treeStorage: config.treeStorage || 'json',
      workers: config.workers, workspace: config.workspace, security: config.fleetV2Security || 'configured-folder-scope', ...(config.fleetV2Scope ? { folderScope: config.fleetV2Scope } : {}),
      coordination: 'tasks-rules-asks', entry: product.entry,
      server: setup.leadServer(config, options.actor),
      toolsEngineEnvironment: require('../src/lib/fleet-v2-browser-settings').toolsEngineMcpEnvironment(config) }) + '\n'); return;
  }
  if (!options.actor) throw new Error('Serve requires an explicit provider actor for task, rule and Ask ownership.');
  const registry = require('../src/lib/agents/registry').activeRegistry({ ...process.env, TOOLSENABLED_STATE_ROOT: path.join(config.stateRoot, 'capability') });
  if (options.actor !== 'local' && !registry.has(options.actor)) throw new Error('Actor must be a described provider or local.');
  if (product.generation === 5 && !config.workers && !options.admin && !options.ledgerOnly)
    throw Object.assign(new Error('Fleet V5 ordinary lead connections require workers enabled. Re-run Fleet V5 setup without --coordination-only, or use explicit --admin for native administration.'), { code: 'FLEET_V5_WORKERS_REQUIRED' });
  if (options.ledgerOnly) {
    if (process.env.TOOLSENABLED_HOST_NODE || process.env.TOOLSENABLED_HOST_TREE_SOCKET || process.env.TOOLSENABLED_HOST_SESSION)
      throw Object.assign(new Error('A linked worker cannot become a ledger-maintenance lead.'), { code: 'R_LEDGER_LEAD_REQUIRED' });
    // Read the sealed installation as usual; do not open its tree or change
    // its saved workers setting. This connection serves only the two ledger APIs.
    await runtime.serveHost({ ...config, workers: false }, { actor: options.actor, allowedToolNames: ['ledger.read', 'r_ledger.withdraw'] });
    return;
  }
  if (options.attach || options.hub) {
    await require('../src/lib/fleet-hub').runAttach({ config, actor: options.actor, treeKey: options.treeKey || null,
      autoStart: Boolean(options.hub), entry: product.entry, name: options.name || null, ...(options.admin ? { admin: true } : {}) });
    return;
  }
  const allowedToolNames = require('../src/lib/fleet-v5-surface').leadToolNames({ generation: product.generation, admin: options.admin,
    linkedWorker: Boolean(process.env.TOOLSENABLED_HOST_NODE || process.env.TOOLSENABLED_HOST_TREE_SOCKET || process.env.TOOLSENABLED_HOST_SESSION) });
  await runtime.serveHost(config, { actor: options.actor, treeKey: options.treeKey || null, ...(allowedToolNames ? { allowedToolNames } : {}) });
}

/* `fleetV2 hub ...`: a detached root that owns the workers, so orchestrators
   can attach, hand off and close without stopping the fleet. */
async function hubCommand(argv, product = V2) {
  const options = parse(argv, product);
  if (options.admin) throw new Error('--admin applies only to a V5 lead serve connection or call.');
  if (options.wait !== undefined && (product.generation < 4 || options.command !== 'inbox'
      || !Number.isFinite(options.wait) || options.wait < 0 || options.wait * 1000 > 2147468647
      || !Number.isSafeInteger(options.since) || options.since < 0))
    throw new Error('Use --wait SECONDS with Fleet V4/V5 hub inbox and --since SEQ; seconds must be nonnegative within the timer range, and SEQ a nonnegative integer.');
  if (options.sourceStateRoot) throw new Error('--source-state-root applies only to fleetV3 import-v2, fleetV4 import-v3 or fleetV5 import-v4.');
  const sub = options.command;
  const runtime = require('../src/lib/host-runtime');
  // The new runtime must be able to quiesce its same-generation predecessor
  // before rebind. Stop is maintenance only; start/attach/status stay bound.
  const config = runtime.readHostConfig(options.stateRoot, { allowStandaloneRebind: sub === 'stop' });
  assertProduct(config, product);
  if (config.profile !== 'fleetV2' || config.setupKind === 'plugin' || !config.workers)
    throw new Error('A Fleet hub needs a standalone fleetV2 installation with workers.');
  if (!options.actor) throw new Error('A hub names its provider actor (--actor).');
  const hub = require('../src/lib/fleet-hub');
  const folder = hub.treeFolderOf(config.stateRoot, options.treeKey || options.actor);
  const print = value => process.stdout.write(JSON.stringify(value) + '\n');
  if (sub === 'run') {
    return hub.runHub({ config, actor: options.actor, treeKey: options.treeKey || null,
      leadPid: Number.isSafeInteger(options.leadPid) ? options.leadPid : null, entry: product.entry });
  }
  if (sub === 'start') {
    const result = await hub.startHub({ config, actor: options.actor, treeKey: options.treeKey || null, entry: product.entry });
    const { token, ...visible } = result.hub || {};
    return print({ started: result.started, hub: visible });
  }
  if (sub === 'status') return print(await hub.adminRequest(folder, 'status'));
  if (sub === 'inbox') {
    const result = await hub.adminRequest(folder, 'inbox', { since: options.since, limit: options.limit, orchestrator: options.orchestrator, waitSeconds: options.wait });
    print(result);
    if (result.timedOut) process.exitCode = 5;
    return;
  }
  if (sub === 'handoff') return print(await hub.adminRequest(folder, 'handoff', { to: options.to, note: options.note }));
  if (sub === 'stop') {
    const before = hub.readHub(folder);
    const result = await hub.adminRequest(folder, 'stop');
    if (before) await hub.waitUntilStopped(folder, before);
    return print({ ...result, stopped: true });
  }
  throw new Error('Use fleetV2 hub start, run, status, inbox, handoff or stop.');
}
if (require.main === module) main().catch(error => { process.stderr.write(`${error.code || 'FLEET_V2_ERROR'}: ${error.message}\n`); process.exitCode = 1; });
module.exports = { main, parse };
