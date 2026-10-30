'use strict';

// Host mode is a deliberate entrypoint. None of these functions infer it from
// a missing OpenShell marker, and no OpenShell admission check is weakened.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { samePath, sameRealPath, resolvedPath } = require('./host-path-identity');

const INSTALL_ROOT = path.resolve(__dirname, '../..');
const HOST_WARNING = 'Host mode runs with your own permissions and network. ToolsEnabled does not provide a sandbox, network confinement or credential custody for your CLIs.';
const WORKER_WARNING = 'Host workers are experimental and run as your user. They default to level 4 (bypassed), lowered by administrator settings, caps and role limits. Fleet tools follow that level; an optional tier can narrow them further. New permission requests are declined in headless workers.';

// Agent CLIs that can start as subagents, from the agent descriptors.
const SUBAGENT_PROVIDERS = require('./agents/registry').workerAgentIds(require('./agents/registry').activeRegistry());

function refuse(code, message) { throw Object.assign(new Error(`${code}: ${message}`), { code }); }

function createHostShutdown(workers, { closeStateStore = () => require('./state-store').closeStateStore(),
  exit = code => process.exit(code), reportError = error => process.stderr.write(`${error.code || 'HOST_WORKER_CLOSE_FAILED'}\n`) } = {}) {
  let shutdown;
  return () => {
    if (!shutdown) shutdown = (async () => {
      let failure = null;
      try { await workers.close(); } catch (error) { failure = error; }
      try { closeStateStore(); } catch { /* preserve the host's existing best-effort store close */ }
      if (failure) { reportError(failure); exit(1); return { closed: false, code: failure.code || 'HOST_WORKER_CLOSE_FAILED' }; }
      exit(0);
      return { closed: true };
    })();
    return shutdown;
  };
}

function requireHostEnvironment(env = process.env, { inheritedEnvironment = false } = {}) {
  if (!inheritedEnvironment && (env.OPENSHELL_SANDBOX === '1' || (env.TOOLSENABLED_RUNTIME_MODE && env.TOOLSENABLED_RUNTIME_MODE !== 'host'))) {
    refuse('HOST_MODE_CONFLICT', 'Use the existing OpenShell entry for an OpenShell installation; host mode must be selected explicitly.');
  }
  if (!['linux', 'win32'].includes(process.platform) || process.arch !== 'x64') {
    refuse('HOST_PLATFORM_UNSUPPORTED', 'This host edition supports Linux and native Windows x86_64. macOS is not built yet.');
  }
}

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || path.resolve(value) !== value || value === path.parse(value).root) {
    refuse('HOST_CONFIG_INVALID', `${label} must be a normalized absolute path below the filesystem root.`);
  }
  return value;
}

function privateEntry(file, directory) {
  if (process.platform === 'win32') return require('./windows-state-security').assertEntry(file, directory);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
      || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      || (!directory && stat.nlink !== 1)) {
    refuse('HOST_STATE_UNSAFE', `State must be owned by you, private and free of links: ${file}`);
  }
  return stat;
}

const warnedState = new Set();
function checkPrivateTree(root, { singleUseGuest = process.env.TOOLSENABLED_SINGLE_USE_GUEST === '1', warn = message => process.stderr.write(`[Fleet] ${message}\n`) } = {}) {
  if (singleUseGuest) return { skipped: true };
  // State admission concerns this directory, not a shared /logs parent or
  // unrelated descendant files. Credential/link-file checks remain separate.
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) refuse('HOST_CONFIG_INVALID', `State is not a directory: ${root}`);
  let warning = null;
  if (process.platform === 'win32') {
    try { require('./windows-state-security').assertEntry(root, true); }
    catch { warning = `HOST_STATE_UNSAFE: state directory ACL may permit writes by anyone other than its owner: ${root}; continuing.`; }
  } else if ((stat.mode & 0o022) !== 0 || stat.uid !== process.getuid()) {
    warning = `HOST_STATE_UNSAFE: state directory is writable by group/others or belongs to another owner: ${root}; continuing.`;
  }
  if (warning && !warnedState.has(warning)) { warnedState.add(warning); warn(warning); }
  return { skipped: false, warning };
}

function readHostConfig(stateRoot, { allowPluginRebind = false, allowStandaloneRebind = false, setupKind = null } = {}) {
  const setupRequired = setupKind === 'plugin'
    ? 'Run /tefleet setup in Claude Code to configure this plugin.'
    : 'Run the host installer setup to configure this installation.';
  absolute(stateRoot, 'State root');
  try { checkPrivateTree(stateRoot); }
  catch (error) {
    if (error.code === 'ENOENT') refuse('HOST_SETUP_REQUIRED', setupRequired);
    throw error;
  }
  const file = path.join(stateRoot, 'host-mode.json');
  let stat;
  try { stat = fs.statSync(file); if (!stat.isFile()) refuse('HOST_CONFIG_INVALID', 'Host configuration is not a file.'); }
  catch (error) {
    if (error.code === 'ENOENT') refuse('HOST_SETUP_REQUIRED', setupRequired);
    throw error;
  }
  if (stat.size > 16384) refuse('HOST_CONFIG_INVALID', 'Host configuration is too large.');
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { refuse('HOST_CONFIG_INVALID', 'Host configuration is unreadable.'); }
  return validateHostConfig(config, stateRoot, { allowPluginRebind, allowStandaloneRebind });
}

function validateHostConfig(config, stateRoot, { allowPluginRebind = false, allowStandaloneRebind = false } = {}) {
  if (!config || config.schemaVersion !== 1 || config.mode !== 'host' || typeof config.workers !== 'boolean'
      || !samePath(config.stateRoot, stateRoot) || !['unrestricted', 'standard', 'guided'].includes(config.tier || 'unrestricted')
      || ![undefined, 'plugin'].includes(config.setupKind)) {
    refuse('HOST_CONFIG_INVALID', 'Host configuration does not name an explicit supported host installation.');
  }
  if (config.profile !== undefined && (config.profile !== 'fleetV2' || config.setupKind === 'plugin'))
    refuse('HOST_CONFIG_INVALID', 'FleetV2 is a standalone installation profile.');
  const transactional = require('./product-identity').transactionalGeneration(config.generation);
  if (![undefined, 2, 3, 4, 5].includes(config.generation) || transactional && (config.profile !== 'fleetV2' || config.treeStorage !== 'sqlite-v1')
      || !transactional && config.treeStorage !== undefined)
    refuse('HOST_CONFIG_INVALID', 'Fleet V3, V4 and V5 require an explicit standalone generation and transactional tree format.');
  if (config.fleetV2Security !== undefined && (config.profile !== 'fleetV2' || config.setupKind === 'plugin' || config.fleetV2Security !== 'inherited-environment' || config.fleetV2Scope !== undefined))
    refuse('HOST_CONFIG_INVALID', 'The inherited-environment marker belongs only to explicit standalone FleetV2 without a declared scope.');
  if (config.profile === 'fleetV2' && config.fleetV2Security !== 'inherited-environment') {
    const normalized = require('./fleet-folder-scope').normalize(config.fleetV2Scope);
    if (JSON.stringify(normalized) !== JSON.stringify(config.fleetV2Scope))
      refuse('HOST_CONFIG_INVALID', 'The FleetV2 parent folder policy must be normalized and explicit.');
  }
  for (const key of ['workspace', 'stateRoot', 'installRoot', 'nodePath']) absolute(config[key], key);
  if (config.providers !== undefined && !validProviderList(config.providers, config)) {
    refuse('HOST_CONFIG_INVALID', 'The saved subagent providers are invalid. Run /tefleet setup again in this project.');
  }
  if (config.models !== undefined && !validModelList(config.models, config)) {
    refuse('HOST_CONFIG_INVALID', 'The saved subagent models are invalid. Run /tefleet setup again in this project.');
  }
  if (config.setupKind === 'plugin'
      && (!samePath(config.installRoot, INSTALL_ROOT) || !samePath(config.nodePath, process.execPath))
      && !allowPluginRebind) {
    refuse('HOST_PLUGIN_REBIND_REQUIRED', 'Fleet plugin changed. Run /tefleet setup again in this project.');
  }
  // fleetV2 rebind (src/lib/fleet-v2-setup.js) reads a standalone state that
  // an earlier runtime made, which may since have been removed.
  const standalone = config.profile === 'fleetV2' && config.setupKind !== 'plugin';
  const sameRuntime = () => sameRealPath(config.installRoot, INSTALL_ROOT) && sameRealPath(config.nodePath, process.execPath);
  if ((!allowPluginRebind || config.setupKind !== 'plugin') && !(allowStandaloneRebind && standalone) && !sameRuntime()) {
    refuse('HOST_CONFIG_INVALID', standalone
      ? `Host configuration belongs to a different runtime or Node executable (${config.installRoot}). To move this state to this runtime, run: ${require('./product-identity').generationName(config.generation)} rebind --state-root ${stateRoot}`
      : 'Host configuration belongs to a different runtime or Node executable.');
  }
  return Object.freeze({ ...config, tier: config.tier || 'unrestricted' });
}

function savedModelTiers(stateRoot) {
  return stateRoot ? require('./openshell-model-connections').connectionTiers({ stateRoot: path.join(stateRoot, 'capability') }) : {};
}

// Explicit provider limits include saved models without widening an old list.
function validProviderList(list, { setupKind = 'plugin', workers = true, stateRoot } = {}) {
  const supported = new Set([...SUBAGENT_PROVIDERS, ...Object.values(savedModelTiers(stateRoot)).map(row => row.provider)]);
  return setupKind === 'plugin' && workers === true && Array.isArray(list) && list.length > 0
    && new Set(list).size === list.length && list.every(name => supported.has(name));
}

// ...and to some of those providers' models: "<agent>" (its own default) or "<agent>/<model id>" from its own list.
function validModelList(list, { setupKind = 'plugin', workers = true, providers, stateRoot } = {}) {
  const tiers = { ...require('./fleet-worker-tiers'), ...savedModelTiers(stateRoot) };
  return setupKind === 'plugin' && workers === true && Array.isArray(list) && list.length > 0
    && new Set(list).size === list.length
    && list.every(name => typeof name === 'string' && Object.hasOwn(tiers, name)
      && (tiers[name].adapter === 'model-api' || SUBAGENT_PROVIDERS.includes(tiers[name].provider))
      && (!providers || providers.includes(tiers[name].provider)));
}

function privateDirectory(file) {
  if (process.platform === 'win32') require('./windows-state-security').check('create', file);
  else fs.mkdirSync(file, { recursive: true, mode: 0o700 });
  checkPrivateTree(file);
}

// The plugin setup this process serves, so its subagent limits can be read live.
let servedPluginStateRoot = null;
// Providers and models the saved plugin setup allows now, or null when unreadable.
function currentPluginLimits() {
  if (!servedPluginStateRoot) return null;
  try {
    const saved = readHostConfig(servedPluginStateRoot, { setupKind: 'plugin' });
    return Object.freeze({ workers: saved.workers, providers: saved.providers || null, models: saved.models || null });
  } catch { return null; }
}

function configureHost(config, { env = process.env, actor } = {}) {
  const singleUseGuest = env.TOOLSENABLED_SINGLE_USE_GUEST === '1';
  requireHostEnvironment(env, { inheritedEnvironment: config.profile === 'fleetV2' && config.setupKind !== 'plugin' && config.fleetV2Security === 'inherited-environment' });
  process.umask(0o077);
  const levelCap = env.TOOLSENABLED_LEVEL_CAP;
  const workerLevel = env.TOOLSENABLED_WORKER_LEVEL;
  const fleetV2 = config.setupKind !== 'plugin' && config.profile === 'fleetV2';
  const assignmentContinuation = fleetV2 ? env.TOOLSENABLED_ASSIGNMENT_CONTINUATION : undefined;
  // Explicit standalone V3 account-service source configuration, not an
  // identity hint or credential. Its loader still validates path/semantics;
  // no other account-service variables bypass the profile reset below.
  const transactional = require('./product-identity').transactionalGeneration(config.generation);
  const accountServiceRoot = fleetV2 && transactional ? env.TOOLSENABLED_ACCOUNT_SERVICE_ROOT : undefined;
  const inheritedOpenShell = fleetV2 && config.fleetV2Security === 'inherited-environment'
    ? Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith('TOOLSENABLED_OPENSHELL_'))) : {};
  const workerNames = ['TREE_SOCKET', 'NODE', 'SESSION', 'LINK_TOKEN_FILE', 'ROLE', 'DIRECT_ONLY']
    .map(name => `TOOLSENABLED_HOST_${name}`);
  const workerEnvironment = config.workers ? Object.fromEntries(workerNames
    .filter(name => typeof env[name] === 'string' && env[name] !== '').map(name => [name, env[name]])) : {};
  const baseAllowlist = require('./host-surface').hostAllowlist({ workers: config.workers, fleetV2 });
  let allowed = baseAllowlist;
  if (workerEnvironment.TOOLSENABLED_HOST_NODE) {
    const inherited = new Set(String(env.TOOLSENABLED_TOOL_ALLOWLIST || '').split(',').filter(Boolean));
    allowed = baseAllowlist.filter(name => inherited.has(name) && name !== 'r_ledger.withdraw');
    if (!allowed.length) refuse('HOST_WORKER_PROFILE_INVALID', 'A host worker needs a nonempty tool list from its parent.');
  }
  // A provider can inherit another MCP server's profile. Every runtime state
  // override and identity hint is re-established from this installation.
  for (const name of Object.keys(env)) if (name.startsWith('TOOLSENABLED_')) delete env[name];
  Object.assign(env, inheritedOpenShell);
  if (assignmentContinuation !== undefined) env.TOOLSENABLED_ASSIGNMENT_CONTINUATION = assignmentContinuation;
  if (typeof accountServiceRoot === 'string' && accountServiceRoot !== '') env.TOOLSENABLED_ACCOUNT_SERVICE_ROOT = accountServiceRoot;
  if (fleetV2) env.TOOLSENABLED_FLEET_PROFILE = 'fleetV2';
  if (fleetV2 && transactional) env.TOOLSENABLED_FLEET_GENERATION = String(config.generation);
  if (fleetV2 && config.fleetV2Security === 'inherited-environment') env.TOOLSENABLED_FLEET_SECURITY = 'inherited-environment';
  if (levelCap !== undefined) env.TOOLSENABLED_LEVEL_CAP = levelCap;
  if (workerLevel !== undefined) env.TOOLSENABLED_WORKER_LEVEL = workerLevel;
  env.TOOLSENABLED_RUNTIME_MODE = 'host';
  if (singleUseGuest) env.TOOLSENABLED_SINGLE_USE_GUEST = '1';
  env.TOOLSENABLED_HOST_WORKERS = config.workers ? '1' : '0';
  if (config.setupKind === 'plugin') { env.TOOLSENABLED_HOST_SETUP_KIND = 'plugin'; servedPluginStateRoot = config.stateRoot; }
  if (config.workers && config.providers) env.TOOLSENABLED_OPENSHELL_PROVIDERS = config.providers.join(',');
  if (config.workers && config.models) env.TOOLSENABLED_OPENSHELL_MODELS = config.models.join(',');
  env.TOOLSENABLED_STATE_ROOT = path.join(config.stateRoot, 'capability');
  env.TOOLSENABLED_TOOL_ALLOWLIST = allowed.join(',');
  Object.assign(env, workerEnvironment);
  if (actor) env.TOOLSENABLED_AGENT_ACTOR = actor;
  // The existing local-profile layout keeps service settings and engine state
  // in one private host container; no ambient XDG/profile setting can split it.
  const servicesRoot = path.join(config.stateRoot, 'services');
  if (fleetV2) {
    Object.assign(env, require('./fleet-v2-browser-settings').toolsEngineMcpEnvironment(config));
    env.TOOLSENABLED_SETTINGS_PATH = env.TOOLSENABLED_SETTINGS;
  }
  privateDirectory(servicesRoot);
  privateDirectory(env.TOOLSENABLED_STATE_ROOT);
  const marker = path.join(config.stateRoot, '.toolsenabled-local-profile.json');
  const content = `${JSON.stringify({ schemaVersion: 1, services: 'services' })}\n`;
  try { fs.writeFileSync(marker, content, { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    privateEntry(marker, false);
    let existing;
    try { existing = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { refuse('HOST_CONFIG_INVALID', 'Local profile marker is unreadable.'); }
    if (JSON.stringify(existing) !== JSON.stringify(JSON.parse(content))) refuse('HOST_CONFIG_INVALID', 'Local profile marker is inconsistent.');
  }
  // Audit is an option the person turns on (audit.enabled); until then its
  // tools are not offered to Claude or to subagents.
  if (config.setupKind === 'plugin' && !require('./runtime-policy').runtimePolicy().auditEnabled) {
    env.TOOLSENABLED_TOOL_ALLOWLIST = allowed.filter(name => !name.startsWith('audit.')).join(',');
  }
  require('./host-status').configureHostStatus(config);
  return servicesRoot;
}

function setupHost(config, { pluginRebindFrom = null, passEnv } = {}) {
  const ambient = config.profile === 'fleetV2' && config.setupKind !== 'plugin' && config.fleetV2Security === 'inherited-environment';
  requireHostEnvironment(process.env, { inheritedEnvironment: config.profile === 'fleetV2' && config.setupKind !== 'plugin' && config.fleetV2Security === 'inherited-environment' });
  const accountHome = fs.realpathSync(os.userInfo().homedir);
  const refuseDotWorkspace = candidate => {
    const relative = path.relative(accountHome, candidate);
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative) && relative.split(path.sep)[0].startsWith('.')) {
      refuse('HOST_WORKSPACE_PROFILE_DOT_REFUSED', 'Choose a project workspace outside the top-level dot folders of your account home.');
    }
  };
  if (!ambient) refuseDotWorkspace(config.workspace);
  if (config.workers) require('./host-worker-prerequisite').requireHostWorkerNative();
  const servicesRoot = configureHost(config);
  const machineRecord = require('./setup/machine-record');
  const workspace = require('./setup/workspace');
  // Global host mode uses the account home as its workspace; Fleet's file
  // tools then never reach the home's hidden entries.
  const choice = workspace.checkWorkspaceCandidate(config.workspace, { installRoot: INSTALL_ROOT, tier: config.tier, allowHome: true });
  if (!ambient && !choice.ok) refuse(choice.code, choice.message);
  let ancestor = config.workspace;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const candidate = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, config.workspace));
  if (!ambient) refuseDotWorkspace(candidate);
  if (!samePath(candidate, path.resolve(config.workspace), { resolve: false })
    || fs.existsSync(config.workspace) && fs.lstatSync(config.workspace).isSymbolicLink()) {
    refuse('HOST_WORKSPACE_SYMLINK_REFUSED', 'Choose a workspace folder that is not a symbolic-link alias.');
  }
  const resolvedChoice = workspace.checkWorkspaceCandidate(candidate,
    { installRoot: fs.realpathSync(INSTALL_ROOT), tier: config.tier, homedir: () => accountHome, allowHome: true });
  if (!ambient && !resolvedChoice.ok) refuse(resolvedChoice.code, resolvedChoice.message);
  const relative = path.relative(accountHome, candidate);
  if (config.setupKind === 'plugin'
      && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
    refuse('HOST_WORKSPACE_OUTSIDE_HOME', 'Choose a workspace inside your account home so the mediated file tools can use it.');
  }
  const previous = machineRecord.readMachineRecord({ servicesRoot, adopt: false });
  if (previous && !samePath(previous.installRoot, INSTALL_ROOT) && !samePath(previous.installRoot, pluginRebindFrom)) {
    refuse('HOST_CONFIG_INVALID', 'The machine record belongs to another runtime.');
  }
  fs.mkdirSync(config.workspace, { recursive: true, mode: 0o700 });
  const record = machineRecord.buildMachineRecord({ ...previous, ...(passEnv === undefined ? {} : { passEnv }), tier: config.tier, installRoot: INSTALL_ROOT,
    servicesRoot, nodePath: process.execPath, workspaceRoots: [config.workspace] });
  machineRecord.writeMachineRecord(record, { servicesRoot });
  return record;
}

function detectedProviderClis(env = process.env) {
  const folders = String(env.PATH || '').split(path.delimiter).filter(folder => path.isAbsolute(folder));
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  return SUBAGENT_PROVIDERS.filter(name => folders.some(folder => extensions.some(extension => {
    try {
      const candidate = path.join(folder, name + extension);
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch { return false; }
  })));
}

function setupPluginHost({ stateRoot, workspace, tier = 'unrestricted', workers = false, providers: chosen = null, models = null, passEnv } = {}) {
  requireHostEnvironment();
  process.umask(0o077);
  absolute(stateRoot, 'State root');
  absolute(workspace, 'Workspace');
  if (!['guided', 'standard', 'unrestricted'].includes(tier) || typeof workers !== 'boolean') {
    refuse('HOST_PLUGIN_SETUP_INVALID', 'Choose a supported optional Fleet tool cap; workers must be true or false.');
  }
  if (chosen !== null && !validProviderList(chosen, { workers, stateRoot })) {
    refuse('HOST_PLUGIN_SETUP_INVALID', 'Subagent providers need subagents turned on and must name supported agent CLIs or saved model connections.');
  }
  if (models !== null && !validModelList(models, { workers, stateRoot, providers: chosen || undefined })) {
    refuse('HOST_PLUGIN_SETUP_INVALID', 'Subagent models need subagents turned on and must be tiers of the allowed agents or saved connections.');
  }
  // Desktop sessions often start in the home folder. Say what to do instead.
  let home = null;
  try { home = fs.realpathSync(os.userInfo().homedir); } catch { /* checked again by setupHost */ }
  if (home && (samePath(workspace, home) || samePath(path.resolve(workspace), home))) {
    refuse('HOST_PLUGIN_SETUP_INVALID', 'Fleet needs a project folder, not your home folder. Open a project folder in Claude Code and set up Fleet there.');
  }
  const overlaps = (left, right) => {
    if (process.platform === 'win32') { left = resolvedPath(left, { allowMissing: true }); right = resolvedPath(right, { allowMissing: true }); }
    return left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep);
  };
  if (overlaps(stateRoot, workspace) || overlaps(stateRoot, INSTALL_ROOT) || overlaps(workspace, INSTALL_ROOT)) {
    refuse('HOST_PLUGIN_SETUP_INVALID', 'Choose a project folder that does not contain or sit inside Fleet\'s state folder or the plugin\'s own folder.');
  }
  // The core coordination tools need no model or CLI. A worker tree needs
  // an available agent or saved model and native process custody for its
  // owned tool servers, including when every worker is a direct model.
  const providers = [...detectedProviderClis(), ...Object.values(savedModelTiers(stateRoot)).map(row => row.provider)];
  if (workers) {
    require('./fleet-runtime-socket').runtimeSocketPath(path.join(stateRoot, 'workers',
      require('./openshell-tree-store').TREE_FOLDER, 'host-owner-32', 'ffffffffffff.sock'), { create: false });
    if (!providers.length) refuse('HOST_PROVIDER_UNAVAILABLE', 'Workers need a supported agent CLI on PATH or a saved model connection. Set up without workers first to add a model connection.');
    const missing = (chosen || []).filter(name => !providers.includes(name));
    if (missing.length) refuse('HOST_PROVIDER_UNAVAILABLE', `${missing.join(', ')} is unavailable. Workers need an installed agent CLI or a saved model connection.`);
    require('./host-worker-prerequisite').requireHostWorkerNative();
  }
  privateDirectory(stateRoot);
  checkPrivateTree(stateRoot);
  const configFile = path.join(stateRoot, 'host-mode.json');
  let previousConfig = null;
  try { fs.lstatSync(configFile); previousConfig = readHostConfig(stateRoot, { allowPluginRebind: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previousConfig && previousConfig.setupKind !== 'plugin') {
    refuse('HOST_PLUGIN_SETUP_CONFLICT', 'This state belongs to a separate host installation. Choose a new private state folder.');
  }
  if (previousConfig) {
    const machine = require('./setup/machine-record');
    const servicesRoot = path.join(stateRoot, 'services');
    const record = machine.readMachineRecord({ servicesRoot, adopt: false });
    const integrity = record && machine.verifyMachineRecordIntegrity(record, { servicesRoot });
    const matches = (installRoot, nodePath, savedTier, savedWorkspace) =>
      samePath(record.installRoot, installRoot) && samePath(record.nodePath, nodePath) && record.tier === savedTier
      && record.workspaceRoots.length === 1 && samePath(record.workspaceRoots[0], savedWorkspace);
    if (integrity?.ok && integrity.state === 'sealed'
        && !samePath(workspace, previousConfig.workspace)
        && !matches(previousConfig.installRoot, previousConfig.nodePath, previousConfig.tier, previousConfig.workspace)
        && matches(INSTALL_ROOT, process.execPath, tier, previousConfig.workspace)) {
      refuse('HOST_PLUGIN_SETUP_CONFLICT', `Run /tefleet setup again for ${previousConfig.workspace}, then change it.`);
    }
    if (!integrity?.ok || integrity.state !== 'sealed'
        || !(matches(previousConfig.installRoot, previousConfig.nodePath, previousConfig.tier, previousConfig.workspace)
          || matches(INSTALL_ROOT, process.execPath, tier, workspace))) {
      const recordedWorkspace = record?.workspaceRoots?.length === 1 ? record.workspaceRoots[0] : null;
      const finish = integrity?.ok && integrity.state === 'sealed' && recordedWorkspace
        && samePath(record.installRoot, INSTALL_ROOT) && samePath(record.nodePath, process.execPath)
        && record.tier === tier && !samePath(recordedWorkspace, workspace);
      refuse('HOST_PLUGIN_SETUP_CONFLICT', finish
        ? `Run /tefleet setup again for ${recordedWorkspace}, then change it.`
        : 'The saved plugin setup and its sealed permission record disagree. Retain the state for inspection.');
    }
  }
  const config = Object.freeze({ schemaVersion: 1, mode: 'host', setupKind: 'plugin', workers,
    ...(chosen ? { providers: Object.freeze([...chosen]) } : {}),
    ...(workers && models ? { models: Object.freeze([...models]) } : {}),
    tier, workspace, stateRoot, installRoot: INSTALL_ROOT, nodePath: process.execPath });
  setupHost(config, { pluginRebindFrom: previousConfig?.installRoot || null, passEnv });
  const temporary = path.join(stateRoot, `.host-mode-${require('node:crypto').randomBytes(12).toString('hex')}.tmp`);
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(config) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  if (previousConfig) privateEntry(configFile, false);
  if (process.platform === 'win32') {
    privateEntry(temporary, false);
    require('./windows-state-security').check('publish', configFile, temporary);
  } else fs.renameSync(temporary, configFile);
  for (const name of fs.readdirSync(stateRoot)) {
    if (!/^\.host-mode-[0-9a-f]{24}\.tmp$/.test(name)) continue;
    const stale = path.join(stateRoot, name);
    privateEntry(stale, false);
    fs.unlinkSync(stale);
  }
  if (process.platform !== 'win32') {
    const directory = fs.openSync(stateRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
  return Object.freeze({ setup: 'ready', tier, workspace, workers, providers: chosen ? [...chosen] : providers,
    ...(workers && models ? { models: [...models] } : {}),
    pluginRebound: Boolean(previousConfig && !samePath(previousConfig.installRoot, INSTALL_ROOT)) });
}

async function serveHost(config, { actor, treeKey = null, allowNamedTree = false, enableRoleControl = false, allowedToolNames, transport = null, controlAttribution } = {}) {
  // transport: a detached Fleet hub (src/lib/fleet-hub.js) serves MCP over its
  // private socket instead of stdin; it has no stdin, so stdin end is not a
  // close signal there. Without it this function is unchanged.
  requireHostEnvironment(process.env, { inheritedEnvironment: config.profile === 'fleetV2' && config.setupKind !== 'plugin' && config.fleetV2Security === 'inherited-environment' });
  const linkedInvocation = Boolean(process.env.TOOLSENABLED_HOST_NODE || process.env.TOOLSENABLED_HOST_TREE_SOCKET || process.env.TOOLSENABLED_HOST_SESSION);
  if (config.profile === 'fleetV2' && !config.workers && linkedInvocation)
    refuse('HOST_WORKER_PROFILE_INVALID', 'A linked worker cannot become a coordination-only root when workers are disabled.');
  if (treeKey && !config.workers) refuse('HOST_WORKERS_DISABLED', 'An existing tree selection requires the saved host worker opt-in.');
  if (config.workers) require('./host-worker-prerequisite').requireHostWorkerNative();
  if (enableRoleControl && (!config.workers || process.env.TOOLSENABLED_HOST_NODE
      || process.env.TOOLSENABLED_HOST_TREE_SOCKET || process.env.TOOLSENABLED_HOST_SESSION)) {
    refuse('HOST_ROLE_CONTROL_ROOT_REQUIRED', 'The explicit role-control option belongs only to the owner root startup, never a worker-linked invocation.');
  }
  const security = require('./windows-state-security');
  const record = security.withPhase(() => {
    configureHost(config, { actor });
    const machineRecord = require('./setup/machine-record');
    return machineRecord.readMachineRecord({ servicesRoot: path.join(config.stateRoot, 'services'), adopt: false });
  }, { stateRoot: config.stateRoot });
  if (!record || !samePath(record.installRoot, INSTALL_ROOT) || record.tier !== config.tier
      || record.workspaceRoots.length !== 1 || !samePath(record.workspaceRoots[0], config.workspace)) {
    refuse('HOST_CONFIG_INVALID', config.setupKind === 'plugin'
      ? 'Run node bin/toolsenabled-host.js setup --plugin from the installed package folder with the options in its setup guide to establish the matching permission record.'
      : 'Run the host installer setup to establish the matching machine record first.');
  }
  process.stderr.write(`[toolsenabled] ${HOST_WARNING}\n`);
  if (!actor) process.stderr.write('[toolsenabled] HOST_ACTOR_UNBOUND: no --actor was supplied; ledger mutations require an explicit provider actor at startup.\n');
  const options = { agentActor: actor || null, toolSummary: require(config.profile === 'fleetV2' && config.setupKind !== 'plugin' ? './fleet-v2-descriptions' : './host-descriptions'),
    ...(allowedToolNames === undefined ? {} : { allowedToolNames: Object.freeze([...allowedToolNames]) }),
    setupKind: config.setupKind,
    permissionSession: require('./permission-tier-policy').effectiveSessionFromRecord(
      require('./agents/permission-level').leadLevel().level, record),
    workspaceRoots: config.fleetV2Security === 'inherited-environment' ? [fs.realpathSync(process.cwd())] : record.workspaceRoots,
    ...(config.profile === 'fleetV2' && config.setupKind !== 'plugin' && config.fleetV2Security === 'inherited-environment' ? { resolveAmbientAccess: async () => {
      const live = readHostConfig(config.stateRoot);
      return live.profile === 'fleetV2' && live.setupKind !== 'plugin' && live.fleetV2Security === 'inherited-environment';
    } } : config.profile === 'fleetV2' && config.setupKind !== 'plugin' ? { resolveFolderScope: async () => {
      const live = readHostConfig(config.stateRoot);
      if (live.profile !== 'fleetV2' || live.setupKind === 'plugin') refuse('HOST_CONFIG_INVALID', 'The standalone parent folder policy is no longer available.');
      return require('./fleet-folder-scope').normalize(live.fleetV2Scope);
    } } : {}) };
  let workers;
  let shutdown;
  if (config.workers) {
    process.stderr.write(`[toolsenabled] ${WORKER_WARNING}\n`);
    workers = await security.withPhase(() => require('./host-agent-mode').startHostAgentMode({ config, actor, treeKey, allowNamedTree, enableRoleControl, ...(controlAttribution ? { controlAttribution } : {}) }), { stateRoot: config.stateRoot });
    try { await workers.ready; } catch (error) { await workers.close(); throw error; }
    Object.assign(options, workers.context);
    shutdown = createHostShutdown(workers);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { void shutdown(); });
    if (!transport) process.stdin.once('end', () => workers.close().catch(error => process.stderr.write(`${error.code || 'HOST_WORKER_CLOSE_FAILED'}\n`)));
  }
  // Root startup establishes lead authority; a linked worker never inherits it.
  if (!linkedInvocation && actor) options.ledgerLead = Object.freeze({ actor, role: 'lead', id: actor,
    sessionId: options.agentSessionId || `ledger-lead-${require('node:crypto').randomUUID()}` });
  if (transport) {
    try { return await transport(options, workers, shutdown ? { shutdown } : undefined); }
    catch (error) { if (workers) await workers.close(); throw error; }
  }
  try { require('../mcp-server').start(options); }
  catch (error) { if (workers) await workers.close(); throw error; }
}

module.exports = { HOST_WARNING, WORKER_WARNING, INSTALL_ROOT, requireHostEnvironment, readHostConfig, validateHostConfig, currentPluginLimits,
  configureHost, setupHost, setupPluginHost, serveHost, checkPrivateTree, createHostShutdown };
