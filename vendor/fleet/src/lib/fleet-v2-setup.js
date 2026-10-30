'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

function refuse(code, message) { throw Object.assign(new Error(message), { code }); }
function physicalDirectory(value, label) {
  physicalEntry(value, label);
  if (!fs.statSync(value).isDirectory()) refuse('FLEET_V2_PATH_INVALID', `${label} must be a directory.`);
  return value;
}
function physicalEntry(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')
      || path.resolve(value) !== value) refuse('FLEET_V2_PATH_INVALID', `${label} must be an absolute normalized directory.`);
  const stat = fs.statSync(value);
  if ((!stat.isDirectory() && !stat.isFile() && !stat.isCharacterDevice()) || fs.realpathSync(value) !== value)
    refuse('FLEET_V2_PATH_INVALID', `${label} must name a physical file or directory, not an alias.`);
  return value;
}
function overlap(a, b) {
  const inside = (root, child) => { const relative = path.relative(root, child); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
  return inside(a, b) || inside(b, a);
}
function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function leadServer(config, actor = config.leadActor || 'codex') {
  const registry = require('./agents/registry');
  const loaded = registry.activeRegistry({ ...process.env, TOOLSENABLED_STATE_ROOT: path.join(config.stateRoot, 'capability') });
  if (!registry.actorNames(loaded).includes(actor))
    refuse('FLEET_V2_ACTOR_INVALID', 'Choose a described MCP client actor or local.');
  const entry = require('./product-identity').generationName(config.generation) + '.js';
  return { command: process.execPath, args: [path.join(require('./host-runtime').INSTALL_ROOT, 'bin', entry), 'serve', '--state-root', config.stateRoot, '--actor', actor] };
}

// This is a local operator entry point, never a model-facing MCP operation.
// Ask/bypass is deliberately absent: these roots describe filesystem authority.
function setup({ stateRoot, workspace = fs.realpathSync(process.cwd()), readRoots = [], writeRoots = [], readAll = false, workers = true, actor = 'codex', generation = 2 } = {}, { runtime = require('./host-runtime') } = {}) {
  process.umask(0o077);
  if (![2, 3, 4, 5].includes(generation)) refuse('FLEET_SETUP_INVALID', 'Choose a supported Fleet generation.');
  const inheritedEnvironment = Array.isArray(readRoots) && Array.isArray(writeRoots) && !readRoots.length && !writeRoots.length && readAll === false;
  runtime.requireHostEnvironment(process.env, { inheritedEnvironment });
  workspace = physicalDirectory(workspace, 'Workspace');
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot) || path.resolve(stateRoot) !== stateRoot
      || stateRoot === path.parse(stateRoot).root || stateRoot.includes('\0'))
    refuse('FLEET_V2_PATH_INVALID', 'State root must be an absolute normalized private directory.');
  if (typeof workers !== 'boolean') refuse('FLEET_V2_SETUP_INVALID', 'Workers must be a boolean.');
  if (overlap(stateRoot, runtime.INSTALL_ROOT) || !inheritedEnvironment && (overlap(stateRoot, workspace) || overlap(workspace, runtime.INSTALL_ROOT)))
    refuse('FLEET_V2_PATH_OVERLAP', 'Workspace, runtime and private state directories must be separate.');
  if (typeof readAll !== 'boolean' || !Array.isArray(readRoots) || !Array.isArray(writeRoots) || !inheritedEnvironment && !readAll && readRoots.length === 0)
    refuse('FLEET_V2_SCOPE_REQUIRED', 'Supply the parent folder policy explicitly; permission mode does not establish folder roots.');
  const scope = inheritedEnvironment ? null : require('./fleet-folder-scope').normalize({ readAll, readRoots, writeRoots, revision: 1, source: 'operator-selected-parent-policy' });
  scope?.readRoots.forEach(root => physicalEntry(root, 'Read root'));
  scope?.writeRoots.forEach(root => physicalEntry(root, 'Write root'));
  if (scope && !scope.readAll && !scope.readRoots.some(root => isWithin(root, workspace)))
    refuse('FLEET_V2_WORKSPACE_OUTSIDE_SCOPE', 'The starting workspace must be readable under the parent folder policy.');
  for (const root of scope?.writeRoots || []) if (!scope.readAll && !scope.readRoots.some(read => isWithin(read, root)))
    refuse('FLEET_V2_SCOPE_INVALID', 'A writable folder must also belong to the parent read scope.');
  // Fresh state only. Never convert an existing plugin/installation in place.
  if (fs.existsSync(stateRoot)) refuse('FLEET_V2_STATE_EXISTS', 'Choose a fresh state directory; existing state is retained unchanged.');
  let ancestor = path.dirname(stateRoot);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (fs.realpathSync(ancestor) !== ancestor) refuse('FLEET_V2_PATH_INVALID', 'State ancestors must not cross a directory alias.');
  leadServer({ stateRoot }, actor); // Validate before any state mutation.
  const transactional = require('./product-identity').transactionalGeneration(generation);
  const config = Object.freeze({ schemaVersion: 1, mode: 'host', profile: 'fleetV2', leadActor: actor,
    ...(transactional ? { generation, treeStorage: 'sqlite-v1' } : {}),
    workers, tier: 'unrestricted', workspace, stateRoot, installRoot: runtime.INSTALL_ROOT,
    nodePath: process.execPath, ...(inheritedEnvironment ? { fleetV2Security: 'inherited-environment' } : { fleetV2Scope: scope }) });
  if (process.platform === 'win32') require('./windows-state-security').check('create', stateRoot);
  else fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  // setupHost checks physical ancestry, private ownership, native worker support
  // and signs the normal machine record. It never registers a provider account.
  runtime.setupHost(config);
  const file = path.join(stateRoot, 'host-mode.json');
  const temp = path.join(stateRoot, `.host-mode-${crypto.randomBytes(12).toString('hex')}.tmp`);
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(config) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (process.platform === 'win32') require('./windows-state-security').check('publish', file, temp);
  else { fs.renameSync(temp, file); const dir = fs.openSync(stateRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
  runtime.readHostConfig(stateRoot);
  return { name: require('./product-identity').generationName(generation), setup: 'ready', stateRoot, workspace, workers, ...(config.treeStorage ? { treeStorage: config.treeStorage } : {}), security: inheritedEnvironment ? 'inherited-environment' : 'configured-folder-scope', ...(scope ? { folderScope: scope } : {}),
    server: leadServer(config, actor),
    toolsEngineEnvironment: require('./fleet-v2-browser-settings').toolsEngineMcpEnvironment(config),
    note: inheritedEnvironment ? 'Fleet inherits the launching environment. The terminal starting directory is the working directory, not a filesystem boundary. Configure any sandbox outside Fleet.' : 'This legacy installation retains its explicitly configured folder policy.' };
}

// A TEAA or Fleet upgrade installs the runtime under a new versioned folder,
// and the state its predecessor made then refuses to open (HOST_CONFIG_INVALID).
// Rebinding moves that same state root to this runtime. It is a local operator
// entry point like setup, never a model-facing operation, and it changes only
// the runtime and Node paths: workers, folder policy, workspace, actor, tasks,
// rules and memory stay as they are. It refuses, changing nothing, unless the
// state's sealed machine record names the same previous runtime and workspace
// as its host configuration, and no server still holds one of its trees.
function rebind({ stateRoot } = {}, { runtime = require('./host-runtime'), now = () => new Date().toISOString() } = {}) {
  process.umask(0o077);
  const previous = runtime.readHostConfig(stateRoot, { allowStandaloneRebind: true });
  if (previous.profile !== 'fleetV2' || previous.setupKind === 'plugin')
    refuse('FLEET_V2_PROFILE_REQUIRED', 'Rebinding belongs to a standalone fleetV2 installation.');
  runtime.requireHostEnvironment(process.env, { inheritedEnvironment: previous.fleetV2Security === 'inherited-environment' });
  const from = { installRoot: previous.installRoot, nodePath: previous.nodePath };
  const to = { installRoot: runtime.INSTALL_ROOT, nodePath: process.execPath };
  const answer = (status, extra = {}) => ({ name: require('./product-identity').generationName(previous.generation), rebind: status, stateRoot, from, to, workers: previous.workers,
    server: leadServer({ ...previous, ...to }, previous.leadActor), ...extra });
  if (from.installRoot === to.installRoot && from.nodePath === to.nodePath) return answer('not-needed');
  const machine = require('./setup/machine-record');
  const servicesRoot = path.join(stateRoot, 'services');
  const record = machine.readMachineRecord({ servicesRoot, adopt: false });
  const integrity = record && machine.verifyMachineRecordIntegrity(record, { servicesRoot });
  if (!record || !integrity.ok || integrity.state !== 'sealed' || record.installRoot !== from.installRoot
      || record.workspaceRoots.length !== 1 || record.workspaceRoots[0] !== previous.workspace)
    refuse('FLEET_V2_REBIND_UNRECORDED', `The previous runtime is not recorded consistently in ${stateRoot} (its sealed machine record must name ${from.installRoot} and the saved workspace). Nothing was changed.`);
  const live = require('./openshell-tree-store').listTrees(path.join(stateRoot, 'workers')).filter(tree => tree.live);
  if (live.length)
    refuse('FLEET_V2_REBIND_LIVE', `A Fleet server still holds ${live.map(tree => tree.treeKey).join(', ')} in this state. Stop it (${require('./product-identity').generationName(previous.generation)} hub stop, or close its lead) and run rebind again. Nothing was changed.`);
  const lock = require('./process-claim-lock').acquireLock(path.join(stateRoot, 'fleetV2-scope.lock'));
  try {
    const current = runtime.readHostConfig(stateRoot, { allowStandaloneRebind: true });
    if (current.installRoot !== from.installRoot || current.nodePath !== from.nodePath)
      refuse('FLEET_V2_REVISION_CONFLICT', 'The state was rebound meanwhile; run rebind again.');
    const config = Object.freeze({ ...current, ...to });
    // setupHost rewrites and reseals the machine record for this runtime.
    runtime.setupHost(config, { pluginRebindFrom: from.installRoot });
    writeHostMode(stateRoot, config);
    fs.appendFileSync(path.join(stateRoot, 'runtime-rebinds.jsonl'), JSON.stringify({ at: now(), from, to }) + '\n', { mode: 0o600 });
  } finally { lock.release(); }
  runtime.readHostConfig(stateRoot);
  return answer('rebound');
}

function writeHostMode(stateRoot, config) {
  const file = path.join(stateRoot, 'host-mode.json');
  const temp = path.join(stateRoot, `.host-mode-${crypto.randomBytes(12).toString('hex')}.tmp`);
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(config) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (process.platform === 'win32') require('./windows-state-security').check('publish', file, temp);
  else { fs.renameSync(temp, file); const dir = fs.openSync(stateRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
}

function defaultStateRoot() { return path.join(os.homedir(), '.fleetV2'); }

// User-owned terminal configuration update. Model control tools cannot call
// this writer. The live host observes the revision, quiesces descendants, and
// requires fresh sessions before executing under the new policy.
function updateScope({ stateRoot, readRoots, writeRoots, readAll = false, revision } = {}, { runtime = require('./host-runtime') } = {}) {
  process.umask(0o077);
  const initial = runtime.readHostConfig(stateRoot);
  if (initial.profile !== 'fleetV2' || initial.setupKind === 'plugin')
    refuse('FLEET_V2_PROFILE_REQUIRED', 'Folder updates belong to a standalone fleetV2 installation.');
  if (initial.fleetV2Security === 'inherited-environment')
    refuse('FLEET_V2_EXTERNAL_SANDBOX', 'This installation inherits its launching environment; configure folder restrictions in the external sandbox.');
  if (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER)
    refuse('FLEET_V2_REVISION_REQUIRED', 'Supply the current parent folder revision.');
  if (typeof readAll !== 'boolean' || !Array.isArray(readRoots) || !readAll && !readRoots.length || !Array.isArray(writeRoots))
    refuse('FLEET_V2_SCOPE_REQUIRED', 'Supply the complete next parent folder policy.');
  const next = require('./fleet-folder-scope').normalize({ readAll, readRoots, writeRoots, revision: revision + 1, source: 'operator-selected-parent-policy' });
  next.readRoots.forEach(root => physicalEntry(root, 'Read root'));
  next.writeRoots.forEach(root => physicalEntry(root, 'Write root'));
  if (!next.readAll && !next.readRoots.some(root => isWithin(root, initial.workspace)))
    refuse('FLEET_V2_WORKSPACE_OUTSIDE_SCOPE', 'The starting workspace must remain readable.');
  for (const root of next.writeRoots) if (!next.readAll && !next.readRoots.some(read => isWithin(read, root)))
    refuse('FLEET_V2_SCOPE_INVALID', 'A writable folder must also belong to the parent read scope.');
  const lock = require('./process-claim-lock').acquireLock(path.join(stateRoot, 'fleetV2-scope.lock'));
  try {
    const current = runtime.readHostConfig(stateRoot);
    if (current.fleetV2Scope?.revision !== revision)
      refuse('FLEET_V2_REVISION_CONFLICT', 'Parent folder policy changed; inspect its current revision before editing.');
    const file = path.join(stateRoot, 'host-mode.json');
    const temp = path.join(stateRoot, `.host-mode-${crypto.randomBytes(12).toString('hex')}.tmp`);
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ ...current, fleetV2Scope: next }) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    if (process.platform === 'win32') require('./windows-state-security').check('publish', file, temp);
    else { fs.renameSync(temp, file); const dir = fs.openSync(stateRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
    return { name: require('./product-identity').generationName(current.generation), status: 'recorded', folderScope: next,
      note: 'The running host must observe this revision and quiesce existing descendants before their next operation. Inspect fleet.control status for live adoption.' };
  } finally { lock.release(); }
}
module.exports = { setup, updateScope, rebind, defaultStateRoot, physicalDirectory, isWithin, leadServer, writeHostMode };
