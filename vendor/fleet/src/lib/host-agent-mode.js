'use strict';

// Native host workers use the shared tree and private Unix IPC. MCP itself
// remains stdio. No OpenShell identity, policy or credentials are fabricated.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const shared = require('./openshell-agent-host');
const store = require('./openshell-tree-store');
const link = require('./openshell-tree-link');
const runtimeSocket = require('./fleet-runtime-socket');

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function refusal(code, message) { return Object.assign(new Error(message), { code }); }
function confinedTreeHost(host, config, authorizeWorkspace = null) {
  const workspace = host.workspaceRoot;
  const exactWorkspace = () => {
    let real;
    try { real = fs.realpathSync(workspace); } catch {
      throw refusal('HOST_WORKSPACE_UNAVAILABLE', 'The sealed host workspace is unavailable; no Standard worker was started.');
    }
    if (real !== workspace) {
      throw refusal('HOST_WORKSPACE_SYMLINK_REFUSED', 'The sealed host workspace changed to an alias; no Standard worker was started.');
    }
  };
  return Object.freeze({ ...host,
    confinedTreeSpawnVersion: 1,
    confinedTreeLifecycleVersion: 1,
    confinedContinuationControlVersion: 1,
    commandContinuationConfined: request => {
      exactWorkspace();
      if (request?.action !== 'set-node-continuation') throw refusal('TREE_CONTINUATION_CONTROL_REFUSED', 'This host control accepts only continuation over already assigned tree tasks.');
      return host.command(request);
    },
    confinedConfigurationControlVersion: 1,
    commandConfigurationConfined: request => {
      exactWorkspace();
      if (!['set-node-model', 'set-node-effort', 'set-node-role'].includes(request?.action)) {
        throw refusal('TREE_CONFIGURATION_CONTROL_REFUSED', 'This host control accepts only model, effort or role selection on the retained tree.');
      }
      return host.command(request);
    },
    confinedSpeedControlVersion: 1,
    commandSpeedConfined: request => {
      exactWorkspace();
      if (request?.action !== 'set-node-speed') throw refusal('TREE_SPEED_CONTROL_REFUSED', 'The speed control accepts only a speed selection.');
      return host.command(request);
    },
    spawnConfined: request => {
      exactWorkspace();
      if (request?.workspaceRoot !== workspace || request.research !== undefined) {
        throw refusal('TREE_DELEGATION_REFUSED', 'A Standard host worker must stay in its sealed workspace.');
      }
      return host.spawn(request);
    },
    ...(typeof host.prepareWorker === 'function' ? { prepareWorker: async request => {
      exactWorkspace();
      const authorized = request?.workspaceRoot === workspace || typeof authorizeWorkspace === 'function'
        && await authorizeWorkspace(request?.workspaceRoot) === request?.workspaceRoot;
      if (!authorized || request.research !== undefined) {
        throw refusal('TREE_DELEGATION_REFUSED', 'A prepared Standard worker must stay in its sealed workspace.');
      }
      return host.prepareWorker(request);
    } } : {}),
    commandConfined: request => {
      exactWorkspace();
      if (!['resume-node', 'fresh-start-existing-node'].includes(request?.action)) {
        throw refusal('TREE_DELEGATION_REFUSED', 'A Standard host worker may resume or restart only through its tree.');
      }
      return host.command(request);
    },
  });
}
// Global host mode seals the account home as the workspace. Workers then start
// in the folder the lead works in (this server's working folder) when that is
// inside the home and outside its hidden entries; otherwise in the workspace.
function workerFolder(config, cwd = process.cwd(), env = process.env) {
  const fleetV2 = config.profile === 'fleetV2' && config.setupKind !== 'plugin';
  const inherited = fleetV2 && config.fleetV2Security === 'inherited-environment';
  const defaultFolder = inherited ? fs.realpathSync(cwd) : (() => {
    let home, real;
    try { home = fs.realpathSync(require('node:os').userInfo().homedir); real = fs.realpathSync(cwd); }
    catch { return config.workspace; }
    if (config.workspace !== home || real === home) return config.workspace;
    const boundary = require('./workspace-boundary');
    return boundary.containedBy(home, real) && !boundary.hiddenUnderHome(home, real) ? real : config.workspace;
  })();
  const requested = env.TOOLSENABLED_FLEET_WORKSPACE;
  if (requested !== undefined) {
    if (!fleetV2 || typeof requested !== 'string' || !path.isAbsolute(requested) || requested.includes('\0'))
      throw refusal('FLEET_WORKSPACE_INVALID', 'The internal worker workspace must be an absolute Fleet V5 folder.');
    let real;
    try { real = fs.realpathSync(requested); } catch { throw refusal('FLEET_WORKSPACE_UNAVAILABLE', 'The internal worker workspace is unavailable.'); }
    if (real !== path.resolve(requested) || !fs.statSync(real).isDirectory())
      throw refusal('FLEET_WORKSPACE_INVALID', 'The internal worker workspace must be a canonical directory.');
    if (inherited) {
      if (real !== defaultFolder) throw refusal('FLEET_WORKSPACE_REFUSED', 'Inherited-environment workers must remain in their established workspace.');
      return real;
    }
    const scope = require('./fleet-folder-scope').normalize(config.fleetV2Scope);
    const within = roots => roots.some(root => {
      const relative = path.relative(root, real);
      return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
    if (!within(scope.readRoots) || !within(scope.writeRoots))
      throw refusal('FLEET_WORKSPACE_REFUSED', 'The worker workspace is outside the saved Fleet read/write folder scope.');
    return real;
  }
  if (inherited) return defaultFolder;
  return defaultFolder;
}
function context({ agentId, sessionId, roleId, surface, config, workspaceRoot }) {
  return Object.freeze({ agentId, agentSessionId: sessionId,
    agentPrincipal: Object.freeze({ kind: 'agent-session', sessionId, agentId, provider: 'host', ...(roleId ? { roleId } : {}) }),
    agentRole: surface ? require('./role-functions').normalizeFunctionPolicy({ functions: surface.names,
      requiresDirectUserAuthorization: surface.requiresDirectUserAuthorization === true })
      : Object.freeze({ functions: null, requiresDirectUserAuthorization: false }),
    workspaceRoots: Object.freeze([workspaceRoot || workerFolder(config)]) });
}
function workerToken(env, config) {
  const filename = env.TOOLSENABLED_HOST_LINK_TOKEN_FILE;
  if (typeof filename !== 'string' || !path.isAbsolute(filename)
      || !filename.startsWith(path.join(config.stateRoot, 'workers') + path.sep)
      || fs.realpathSync(filename) !== filename) throw refusal('HOST_WORKER_LINK_INVALID', 'A worker needs its own private link file under this host state.');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (process.platform === 'win32') {
      const checked = require('./windows-state-security').assertEntry(filename, false);
      if (checked.dev !== stat.dev || checked.ino !== stat.ino) throw refusal('HOST_WORKER_LINK_INVALID', 'The worker link file changed during validation.');
    }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024
        || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
      throw refusal('HOST_WORKER_LINK_INVALID', 'The worker link file must be private and owned by you.');
    }
    const token = fs.readFileSync(fd, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw refusal('HOST_WORKER_LINK_INVALID', 'The worker link token is invalid.');
    return token;
  } finally { fs.closeSync(fd); }
}
function actionPermissions({ readSaved, readSavedForPrincipal } = {}) {
  require('./action-permission-profiles').installHost({
    readSaved: readSaved || (() => ({ v: 1, activeProfileId: 'default', profiles: [{ id: 'default', name: 'Default', parentId: null, actions: { agentResume: 'automatic' } }] })),
    ...(readSavedForPrincipal ? { readSavedForPrincipal } : {}),
    isDirectUserTurn: () => false, hasInheritedUserPermission: () => false,
  });
}
function absentSocket(socketPath, env) {
  runtimeSocket.assertPrivateRuntimeSocketPath(socketPath, { env });
  try { fs.lstatSync(socketPath); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  // Even an owned stale socket is retained. A fresh random basename per root
  // startup makes recovery possible without the shared link's stale unlink.
  throw refusal('HOST_WORKER_SOCKET_UNSAFE', 'The worker socket path already exists; it was preserved. Retry to select a fresh private socket name.');
}
function scopedHostPreparation(host, { ready, scopeRefresh } = {}) {
  if (typeof host?.prepareWorker !== 'function') return undefined;
  return async request => {
    await ready;
    if (scopeRefresh) await scopeRefresh.refresh();
    return host.prepareWorker(request);
  };
}
function startHostAgentMode({ config, actor, treeKey = null, allowNamedTree = false, enableRoleControl = false, env = process.env, listen = true, controlAttribution = () => null,
  fleetV5Capabilities = null,
  installTreeSpawnHost = require('./tree-host-registry').installTreeSpawnHost,
  createHost = shared.createOpenShellAgentHost,
  createLauncher = options => require('./host-worker-session').createHostWorkerLauncher(options),
  socketName = () => `${crypto.randomBytes(6).toString('hex')}.sock`,
} = {}) {
  if (config?.mode !== 'host' || config.workers !== true) return null;
  if (typeof enableRoleControl !== 'boolean') throw refusal('HOST_ROLE_CONTROL_INVALID', 'Role control must be an explicit boolean startup selection.');
  if (enableRoleControl && (env.TOOLSENABLED_HOST_NODE || env.TOOLSENABLED_HOST_TREE_SOCKET || env.TOOLSENABLED_HOST_SESSION)) {
    throw refusal('HOST_ROLE_CONTROL_ROOT_REQUIRED', 'The explicit role-control option belongs only to the owner root startup, never a worker-linked invocation.');
  }
  if (env.TOOLSENABLED_RUNTIME_MODE !== 'host') throw refusal('HOST_WORKERS_DISABLED', 'Host mode must be selected explicitly.');
  const inheritedEnvironment = config.profile === 'fleetV2' && config.setupKind !== 'plugin' && config.fleetV2Security === 'inherited-environment';
  const clean = inheritedEnvironment ? { ...env } : Object.fromEntries(Object.entries(env).filter(([name]) => name !== 'OPENSHELL_SANDBOX' && !name.startsWith('TOOLSENABLED_OPENSHELL_')));
  clean.TOOLSENABLED_HOST_WORKERS = '1';
  if (clean.TOOLSENABLED_HOST_NODE || clean.TOOLSENABLED_HOST_TREE_SOCKET) {
    const nodeId = clean.TOOLSENABLED_HOST_NODE;
    const sessionId = clean.TOOLSENABLED_HOST_SESSION;
    const socketPath = clean.TOOLSENABLED_HOST_TREE_SOCKET;
    if (!ID.test(nodeId || '') || typeof sessionId !== 'string' || !sessionId || sessionId.length > 256
        || typeof socketPath !== 'string' || !path.isAbsolute(socketPath)) {
      throw refusal('HOST_WORKER_LINK_INVALID', 'A host worker needs its bound node, session and Unix socket.');
    }
    const token = workerToken(clean, config);
    const host = shared.createOpenShellTreeClient({ socketPath, token, sessionId, ledgerContinuationVersion: 1 });
    const names = String(clean.TOOLSENABLED_TOOL_ALLOWLIST || '').split(',').filter(Boolean);
    if (!names.length) throw refusal('HOST_WORKER_LINK_INVALID', 'A host worker needs its narrowed tool list.');
    const roleId = clean.TOOLSENABLED_HOST_ROLE || null;
    const surface = { names, requiresDirectUserAuthorization: clean.TOOLSENABLED_HOST_DIRECT_ONLY === '1' };
    const workerHost = clean.TOOLSENABLED_FLEET_PROFILE === 'fleetV2' && config.setupKind !== 'plugin'
      // Fleet's task composition carries the complete manual on every managed
      // worker turn. Do not also put it in MCP instructions: clients can copy
      // those instructions into every discovered tool description.
      ? { ...host, fleetControlVersion: 1, workerManualInTask: true } : host;
    const confined = confinedTreeHost(workerHost, config);
    installTreeSpawnHost(confined);
    let permissionProfiles = { v: 1, activeProfileId: 'default', profiles: [{ id: 'default', name: 'Default', parentId: null, actions: { agentResume: 'automatic' } }] };
    const resolvePermissionProfiles = async () => {
      const result = await host.fileAccess();
      if (result?.nodeId !== nodeId || result?.sessionId !== sessionId) throw refusal('HOST_WORKER_LINK_INVALID', 'Permission profiles belong to another session.');
      permissionProfiles = require('./action-permission-profiles').normalize(result.permissionProfiles);
      return permissionProfiles;
    };
    actionPermissions(clean.TOOLSENABLED_FLEET_PROFILE === 'fleetV2' ? { readSaved: () => permissionProfiles } : {});
    const resolveAmbientAccess = async () => {
      const result = await host.fileAccess();
      if (result?.nodeId !== nodeId || result?.sessionId !== sessionId) throw refusal('HOST_WORKER_LINK_INVALID', 'Ambient file authority belongs to another session.');
      return result.fleetV2Security === 'inherited-environment';
    };
    const resolveFolderScope = async () => {
      const result = await host.fileAccess();
      if (result?.nodeId !== nodeId || result?.sessionId !== sessionId)
        throw refusal('HOST_WORKER_LINK_INVALID', 'The folder scope belongs to a different worker session.');
      return require('./fleet-folder-scope').normalize(result.folderScope);
    };
    const resolveFileTask = async () => {
      const result = await host.fileAccess();
      if (result?.nodeId !== nodeId || result?.sessionId !== sessionId)
        throw refusal('HOST_WORKER_LINK_INVALID', 'The file task belongs to a different worker session.');
      return result.fileTask ? { nodeId, sessionId, ownerId: result.fileTask.ownerId, taskRevision: result.fileTask.taskRevision } : null;
    };
    const inheritedFileAccess = async () => {
      const cap = Number(clean.TOOLSENABLED_LEVEL_CAP);
      if ([1, 2, 3].includes(cap)) return false;
      const result = await host.fileAccess();
      if (result?.nodeId !== nodeId || result?.sessionId !== sessionId) {
        throw refusal('HOST_WORKER_LINK_INVALID', 'The file-access handoff belongs to a different worker session.');
      }
      return result.unrestricted === true;
    };
    return Object.freeze({ host: confined, context: Object.freeze({
      ...context({ agentId: nodeId, sessionId, roleId, surface, config }),
      inheritedFileAccess, ...(config.generation === 5 ? { resolveFileTask } : {}), ...(clean.TOOLSENABLED_FLEET_PROFILE === 'fleetV2' ? { ...(config.fleetV2Security === 'inherited-environment' ? { resolveAmbientAccess } : { resolveFolderScope }), resolvePermissionProfiles } : {}) }),
      ready: Promise.resolve(), close: async () => {} });
  }
  const agentId = actor && ID.test(actor) ? actor : 'host-owner';
  const leadAgent = actor ? require('./agents/registry').activeRegistry().get(actor) : null;
  const root = { agentId, actor: actor || null, displayName: leadAgent ? leadAgent.name : 'Lead' };
  const rootSessionId = `host-root-${crypto.randomUUID()}`;
  const name = socketName();
  if (typeof name !== 'string' || !/^[a-z0-9_-]{1,16}\.sock$/.test(name)) {
    throw refusal('HOST_WORKER_SOCKET_UNSAFE', 'A host worker socket requires a bounded private basename.');
  }
  // Check the private short runtime location before acquiring durable tree
  // state; the socket itself never lives under the state-root pathname.
  runtimeSocket.runtimeSocketPath(path.join(config.stateRoot, 'workers', store.TREE_FOLDER, `${agentId}-32`, name),
    { env: clean, create: false });
  const tree = store.acquireTree({ stateRoot: path.join(config.stateRoot, 'workers'), baseKey: agentId, root, preferredKey: treeKey, allowNamedTree, storageFormat: config.treeStorage || 'json' });
  if (treeKey && tree.document.root?.displayName) root.displayName = tree.document.root.displayName;
  let socketPath;
  try { socketPath = runtimeSocket.runtimeSocketPath(path.join(tree.folder, name), { env: clean }); }
  catch (error) { tree.release(); throw error; }
  let host;
  let control;
  let accounts;
  let observability;
  let scopeRefresh;
  let resources;
  let currentFolderScope = config.fleetV2Scope;
  const fleetV2 = clean.TOOLSENABLED_FLEET_PROFILE === 'fleetV2' && config.setupKind !== 'plugin';
  const ambient = fleetV2 && config.fleetV2Security === 'inherited-environment';
  const interactions = require('./host-worker-interactions').createInteractionBroker();
  let interactionTerminal;
  let server;
  let ready;
  let cleaned;
  const cleanup = () => {
    if (!cleaned) cleaned = (async () => {
      try { if (resources) resources.close(); if (scopeRefresh) await scopeRefresh.close(); interactions.close(); if (interactionTerminal) await interactionTerminal.close(); if (host) await host.closeAll(); }
      finally {
        try { if (server) await server.close(); }
        finally { tree.release(); }
      }
    })();
    return cleaned;
  };
  try {
    absentSocket(socketPath, clean);
    const folder = workerFolder(config, process.cwd(), clean);
    accounts = fleetV2 ? require('./fleet-v3-accounts').createAccountService({ env: clean }) : null;
    const nativeLauncher = createLauncher({ env: clean, config, workspaceRoot: folder, socketPath, interactionBroker: listen ? interactions : null, accountService: accounts });
    if (fleetV2) resources = require('./fleet-v2-resources').createResourceGate({ rootSessionId,
      settings: () => require('./fleet-v2-resources').validatePolicy(tree.document.fleetControl?.resources || { mode: 'off' }) });
    const launcher = resources ? { ...nativeLauncher, start: spec => resources.start(spec, () => nativeLauncher.start(spec)) } : nativeLauncher;
    // A plugin setup may limit subagents to some agent CLIs. The limit comes
    // from the saved setup, not from the OpenShell variables removed above.
    const limitsFor = saved => shared.rootLimits({ ...clean,
      ...(saved.providers ? { [shared.PROVIDERS_ENV]: saved.providers.join(',') } : {}),
      ...(saved.models ? { [shared.MODELS_ENV]: saved.models.join(',') } : {}) });
    // A plugin setup is re-read for each spawn, so changing providers or models
    // applies to this session; an unreadable file keeps this session's start.
    const limits = config.setupKind === 'plugin'
      ? { limits: () => { const live = require('./host-runtime').currentPluginLimits();
        return limitsFor(live && live.workers ? live : config); } }
      : config.providers || config.models ? { limits: limitsFor(config) } : {};
    if (fleetV2) observability = require('./fleet-v2-observability').createObservability({ document: tree.document, history: store.history(tree.treeFile), persist: (document, options) => store.saveTree(tree.treeFile, document, options), laneId: tree.document.treeKey });
    if (fleetV2) control = require('./fleet-v2-control').createFleetControl({
      requireTaskRevision: require('./product-identity').transactionalGeneration(config.generation),
      diagnosticRoot: config.stateRoot, scopedRevisions: require('./product-identity').transactionalGeneration(config.generation),
      // Open plain assignments continue at idle turn boundaries unless the
      // person turns it off for this hub (TOOLSENABLED_ASSIGNMENT_CONTINUATION=0).
      assignmentContinuation: clean.TOOLSENABLED_ASSIGNMENT_CONTINUATION !== '0',
      document: tree.document, history: store.history(tree.treeFile), persist: (document, options) => store.saveTree(tree.treeFile, document, options), rootSessionId, resources, observability, accounts, onAsk: ask => host.notifyControlAsk(ask), onLane: event => host.notifyLane(event), wake: nodeId => host.laneWake(nodeId), inspect: () => host.list(), attribution: controlAttribution,
      command: request => host.command(request), stopSubtree: request => host.stopSubtree(request), slotStatus: () => host.slotStatus(), settings: (changes, options) => options?.import ? require('./fleet-v2-settings').importSettings(changes) : require('./fleet-v2-settings').set(changes),
    });
    host = createHost({ fleetV2, ...(accounts ? { accountService: accounts } : {}), immutableReports: require('./product-identity').transactionalGeneration(config.generation), ...(ambient ? { fleetV2Security: 'inherited-environment' } : fleetV2 ? { folderScope: config.fleetV2Scope } : {}),
      ...(control ? { getAssignment: control.assignment, getRules: control.rulesFor, recordAssignment: control.ensureTask, controlRequest: control.request, laneTurn: control.laneTurn, scheduleTick: control.scheduleTick, pendingVerification: control.pendingVerification, finishVerification: control.finishVerification, getPermissionProfiles: control.permissionProfiles, statusIntroduction: observability.introduction, recordMetrics: observability.record } : {}), mode: 'host', enableRoleControl, rootSessionId, workspaceRoot: folder, env: clean, launcher, recordedTier: config.tier || 'unrestricted',
      unrestrictedFileRoot: config.setupKind !== 'plugin' && config.tier === 'unrestricted', ...limits,
      root, document: tree.document, history: store.history(tree.treeFile), persist: (document, options) => store.saveTree(tree.treeFile, document, options), nodeFolder: tree.nodeFolder,
      codexEndpoint: () => null });
    if (fleetV2 && !ambient) {
      const refresh = require('./fleet-v2-scope-refresh');
      scopeRefresh = refresh.createScopeRefresh({ initialScope: config.fleetV2Scope,
        read: () => refresh.readScope(config.stateRoot), update: async scope => { await host.updateFolderScope(scope); currentFolderScope = scope; },
        onError: async error => {
          for (const node of host.list()) if (['running', 'starting'].includes(node.state))
            await host.command({ action: 'pause-node', nodeId: node.nodeId, parentSessionId: rootSessionId }).catch(() => {});
          process.stderr.write(`[fleetV2] parent folder refresh refused: ${error.code || 'UNAVAILABLE'}\n`);
        } });
    }
    server = listen ? link.createTreeLinkServer({ socketPath, refuseExisting: true,
      handle: async (token, op, request) => { if (scopeRefresh) await scopeRefresh.refresh(); return host.handleLink(token, op, request); } }) : null;
    ready = store.settleLoadedTree(tree.document, {
      canRecoverAssignment: node => fleetV2 && control?.laneTurn({ nodeId: node.nodeId, phase: 'recoverable' })?.ready === true,
    }).then(async () => {
      store.saveTree(tree.treeFile, tree.document);
      if (server) {
        interactionTerminal = await require('./host-interaction-terminal').startInteractionTerminal({
          stateRoot: config.stateRoot, broker: interactions, env: clean });
        absentSocket(socketPath, clean);
        return server.listen();
      }
    }).catch(async error => { await cleanup(); throw error; });
  } catch (error) {
    tree.release();
    cleanup().catch(() => {});
    throw error;
  }
  // A failed private link never silently starts a worker with broken routing.
  ready.catch(() => {});
  const prepareReady = async () => { await ready; if (scopeRefresh) await scopeRefresh.refresh(); };
  const authorizeContractWorkspace = async target => {
    await prepareReady();
    if (typeof target !== 'string' || !path.isAbsolute(target) || target.includes('\0')) return null;
    let physical;
    try { physical = fs.realpathSync(target); } catch { return null; }
    if (physical !== path.resolve(target)) return null;
    if (ambient) return fs.statSync(physical).isDirectory() ? physical : null;
    let scope;
    try { scope = require('./fleet-folder-scope').normalize(currentFolderScope); } catch { return null; }
    const contained = roots => roots.some(root => {
      const relative = path.relative(root, physical);
      return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
    return contained(scope.readRoots) && contained(scope.writeRoots) ? physical : null;
  };
  const scopedPrepareWorker = scopedHostPreparation(host, { ready, scopeRefresh });
  const resolverHost = scopedPrepareWorker ? Object.freeze({ ...host, prepareWorker: scopedPrepareWorker }) : host;
  let capabilities = fleetV5Capabilities;
  if (!capabilities && control && scopedPrepareWorker) {
    try {
      const computers = require('./fleet-v5-computers');
      if (typeof computers.createFleetV5ComputerResolver === 'function') {
        capabilities = computers.createFleetV5ComputerResolver({ env: clean, accounts, tree: tree.document,
          host: resolverHost, rootSessionId, ready: prepareReady,
          authorizeWorkspace: authorizeContractWorkspace });
      }
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND' || !String(error.message).includes("'./fleet-v5-computers'")) throw error;
    }
  }
  const fleetV5Contracts = control && capabilities ? require('./fleet-v5-contracts').createFleetV5Contracts({
    store: require('./state-store').getStateStore(),
    control: { request: async request => { await ready; if (scopeRefresh) await scopeRefresh.refresh(); return control.request(request, rootSessionId); } },
    authorizeWorkspace: authorizeContractWorkspace,
    capabilities,
    listWorkers: async () => { await ready; if (scopeRefresh) await scopeRefresh.refresh();
      return tree.document.nodes.map(node => ({ nodeId: node.nodeId, parentNodeId: node.parentNodeId || null,
        state: node.state, turn: node.turn, role: node.role, provider: node.provider,
        ...(node.workforceMembership ? { workforceMembership: structuredClone(node.workforceMembership) } : {}) })); }
  }) : null;
  const gated = Object.freeze({ ...host,
    ...(control ? { fleetControlVersion: 1, fleetOrchestrator: true, fleetControl: async (request, sessionId) => { await ready; if (scopeRefresh) await scopeRefresh.refresh(); return control.request(request, sessionId); } } : {}),
    ...(fleetV5Contracts ? { fleetV5ContractsVersion: 1, fleetV5Contracts } : {}),
    ...(host.accountModelBindingVersion === 1 && typeof host.accountModelCatalog === 'function'
      ? { accountModelBindingVersion: 1,
        accountModelCatalog: async () => { await ready; if (scopeRefresh) await scopeRefresh.refresh(); return host.accountModelCatalog(); } }
      : {}),
    spawn: async request => { await ready; if (scopeRefresh) await scopeRefresh.refresh(); return host.spawn(request); },
    ...(scopedPrepareWorker ? { prepareWorker: scopedPrepareWorker } : {}),
    command: async request => { await ready; if (scopeRefresh) await scopeRefresh.refresh(); return host.command(request); },
    wait: async request => { await ready; return host.wait(request); } });
  const confined = confinedTreeHost(gated, config, authorizeContractWorkspace);
  try { installTreeSpawnHost(confined); actionPermissions(control ? { readSavedForPrincipal: principal => principal.sessionId === rootSessionId ? { v: 1, activeProfileId: 'default', profiles: [{ id: 'default', name: 'Default', parentId: null, actions: { agentResume: 'automatic' } }] } : control.permissionProfiles() } : {}); }
  catch (error) {
    ready.then(cleanup, cleanup).catch(() => {});
    tree.release();
    throw error;
  }
  let closed;
  const close = () => {
    if (!closed) closed = (async () => {
      await ready.catch(() => {});
      await cleanup();
    })();
    return closed;
  };
  return Object.freeze({ host: confined, context: Object.freeze({
    ...context({ agentId, sessionId: rootSessionId,
      roleId: host.root.roleId, surface: host.root.surface, config, workspaceRoot: host.workspaceRoot }),
    ...(ambient ? { resolveAmbientAccess: async () => { await ready; const live = require('./host-runtime').readHostConfig(config.stateRoot); return live.profile === 'fleetV2' && live.setupKind !== 'plugin' && live.fleetV2Security === 'inherited-environment'; } } : fleetV2 ? { resolveFolderScope: async () => { await ready; await scopeRefresh.refresh(); return require('./fleet-folder-scope').normalize(currentFolderScope); } } : {}),
      permissionSession: require('./permission-tier-policy').effectiveSession(host.root.level, config.tier)
  }), ready, close, treeKey: tree.treeKey, socketPath });
}
module.exports = { startHostAgentMode, workerFolder, scopedHostPreparation };
