'use strict';

// Explicit host workers share the existing native adapters and tree protocol.
// The adapters retain normal CLI confinement and owned process containment.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { rulesText, claudeRulesSession, codexRulesSession } = require('./agent-engine/worker-rules');

// Override the installed host entry in this worker process. A second name
// would leave the root registration active beside the narrower worker server.
const SERVER_NAME = 'toolsenabled-fleet-host';
const APPROVAL_DENIED = 'Fleet could not present this native permission request and refused it; no human rejected it. Review the needed action in your own CLI session. Fleet added no permission grants.';
const MODES = ['Only', 'Optimized', 'Enabled', 'Disabled'];
const SERVER_ENV = ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_DATA_HOME', 'LOCALAPPDATA',
  'TOOLSENABLED_SINGLE_USE_GUEST',
  'TOOLSENABLED_CODEX_START_TIMEOUT_MS',
  'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'];
const TREE_ENV = ['TOOLSENABLED_OPENSHELL_ROLE', 'TOOLSENABLED_OPENSHELL_DIRECT_ONLY', 'TOOLSENABLED_TOOL_ALLOWLIST', 'TOOLSENABLED_LEVEL_CAP'];
function refusal(code, message) { return Object.assign(new Error(message), { code }); }
function requireEnabled(config, env) {
  if (config?.mode !== 'host' || config.workers !== true || env.TOOLSENABLED_RUNTIME_MODE !== 'host'
      || env.TOOLSENABLED_HOST_WORKERS !== '1') {
    throw refusal('HOST_WORKERS_DISABLED', 'Host workers require explicit host mode and the saved worker opt-in.');
  }
}
function within(root, value) {
  const relative = path.relative(root, value);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function privateFolder(folder, root) {
  if (!path.isAbsolute(root) || !path.isAbsolute(folder) || !within(root, folder)) {
    throw refusal('HOST_WORKER_PATH_INVALID', 'Worker files must stay in the private host state folder.');
  }
  if (process.platform === 'win32') {
    const security = require('./windows-state-security');
    security.check('inspect', root);
    security.check('create', folder);
    return;
  }
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(folder) !== path.resolve(folder)) throw refusal('HOST_WORKER_PATH_INVALID', 'Worker folders cannot cross links.');
  const stat = fs.lstatSync(folder);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
    throw refusal('HOST_WORKER_PATH_INVALID', 'The worker folder must be private and owned by you.');
  }
}
function writePrivate(file, text, root) {
  privateFolder(path.dirname(file), root);
  const temporary = `${file}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function hostWorkerEntry({ env, config, provider, socketPath, spec, tokenFile }) {
  const narrowed = spec.serverEnv || {};
  for (const [name, value] of Object.entries(narrowed)) {
    if (!TREE_ENV.includes(name) || typeof value !== 'string') throw refusal('HOST_WORKER_ENV_INVALID', 'Unexpected worker environment field.');
  }
  const parent = new Set(String(env.TOOLSENABLED_TOOL_ALLOWLIST || '').split(',').filter(Boolean));
  const tools = String(narrowed.TOOLSENABLED_TOOL_ALLOWLIST ?? env.TOOLSENABLED_TOOL_ALLOWLIST ?? '').split(',').filter(Boolean);
  if (!tools.length || tools.some(name => !parent.has(name))) {
    throw refusal('HOST_WORKER_ENV_INVALID', 'A worker tool list must be nonempty and no wider than its parent.');
  }
  const forwarded = Object.fromEntries(SERVER_ENV.filter(name => typeof env[name] === 'string').map(name => [name, env[name]]));
  return {
    command: process.execPath,
    args: [path.resolve(__dirname, '../../bin/toolsenabled-host.js'), 'serve', '--state-root', config.stateRoot, '--actor', provider],
    env: { ...forwarded, TOOLSENABLED_RUNTIME_MODE: 'host',
      TOOLSENABLED_STATE_ROOT: path.join(config.stateRoot, 'capability'),
      TOOLSENABLED_HOST_WORKERS: '1', TOOLSENABLED_AGENT_ACTOR: provider,
      ...(spec.fleetV2 ? { TOOLSENABLED_FLEET_PROFILE: 'fleetV2' } : {}),
      ...(spec.fleetV2 && require('./product-identity').transactionalGeneration(config.generation) ? { TOOLSENABLED_FLEET_GENERATION: String(config.generation) } : {}),
      TOOLSENABLED_LEVEL_CAP: String(levels.narrowest(levels.isLevel(spec.level) ? spec.level : levels.DEFAULT_LEVEL,
        Number(narrowed.TOOLSENABLED_LEVEL_CAP), Number(env.TOOLSENABLED_LEVEL_CAP))),
      TOOLSENABLED_TOOL_ALLOWLIST: tools.join(','), TOOLSENABLED_HOST_TREE_SOCKET: socketPath,
      TOOLSENABLED_HOST_NODE: spec.nodeId, TOOLSENABLED_HOST_SESSION: spec.sessionId,
      TOOLSENABLED_HOST_LINK_TOKEN_FILE: tokenFile,
      ...(spec.fleetV2 && spec.workspaceRoot ? { TOOLSENABLED_FLEET_WORKSPACE: spec.workspaceRoot } : {}),
      TOOLSENABLED_HOST_ROLE: narrowed.TOOLSENABLED_OPENSHELL_ROLE || '',
      TOOLSENABLED_HOST_DIRECT_ONLY: narrowed.TOOLSENABLED_OPENSHELL_DIRECT_ONLY || '0' },
  };
}
// Variables that bind a process to the agent session or app that started
// Fleet: session ids, a messaging socket, sign-in refresh provided by the host,
// account ids and host-only tools. A subagent is its own CLI session on its own
// sign-in, so none of them are passed on. Sign-in locations such as
// CLAUDE_CONFIG_DIR and CODEX_HOME are kept.
const HOST_SESSION_ENV = Object.freeze(new Set([
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_CLOUD_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH', 'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH', 'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'CLAUDE_CODE_HOST_AUTH_REFRESH_TIMEOUT_MS', 'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN', 'CLAUDE_BRIDGE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_ORGANIZATION_UUID', 'CLAUDE_CODE_ACCOUNT_UUID',
  'CLAUDE_CODE_BRIDGE_OWNER_ACCOUNT_UUID', 'USE_STAGING_OAUTH', 'USE_LOCAL_OAUTH',
  'CLAUDE_CODE_DESKTOP_APP_VERSION', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_TERMINAL_MCP_TOOLS',
  'CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL', 'CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING', 'CLAUDE_CODE_REPORT_FINDINGS', 'CLAUDE_CODE_EAGER_FLUSH',
  'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR', 'CLAUDE_ENV_FILE',
  'MCP_CONNECTION_NONBLOCKING', 'MCP_SERVER_CONNECTION_BATCH_SIZE', 'AI_AGENT', 'SENTRY-TRACE', 'BAGGAGE',
  'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_CI',
  // What Claude Code sets for the programs it starts, describing the lead session itself: its effort,
  // process id, background-job folder, whether a person attends it, its own program path, that a program
  // runs inside it, and the cloud-session marker. A worker is its own session (the plugin's 45a4ac7/4a6459e).
  // CLAUDE_CODE_OAUTH_SCOPES is not here: it belongs to the person's own OAuth token and stays with it.
  'CLAUDE_EFFORT', 'CLAUDE_PID', 'CLAUDE_JOB_DIR', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_REMOTE',
]));
const FLEET_OPENSHELL_BINDINGS = new Set([
  'TOOLSENABLED_OPENSHELL_AGENT_ID', 'TOOLSENABLED_OPENSHELL_AGENT_RESUME', 'TOOLSENABLED_OPENSHELL_HOST',
  'TOOLSENABLED_OPENSHELL_LINK_TOKEN_FILE', 'TOOLSENABLED_OPENSHELL_NODE', 'TOOLSENABLED_OPENSHELL_SESSION',
  'TOOLSENABLED_OPENSHELL_TREE_SOCKET', 'TOOLSENABLED_OPENSHELL_ROLE', 'TOOLSENABLED_OPENSHELL_LEAD_ROLE',
  'TOOLSENABLED_OPENSHELL_DIRECT_ONLY', 'TOOLSENABLED_OPENSHELL_AGENTS',
]);
function cliEnvironment(env, inheritedEnvironment = false) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => (inheritedEnvironment || name !== 'OPENSHELL_SANDBOX')
    && (inheritedEnvironment ? !FLEET_OPENSHELL_BINDINGS.has(name) : !name.startsWith('TOOLSENABLED_OPENSHELL_'))
    && !name.startsWith('TOOLSENABLED_HOST_')
    && !['TOOLSENABLED_AGENT_ID', 'TOOLSENABLED_AGENT_ACTOR'].includes(name)
    && !HOST_SESSION_ENV.has(name.toUpperCase())));
}
// Codex starts MCP servers with a minimal environment. Fleet's server needs the
// session bus to reach the audit signing key in the login keyring.
function codexOverrides(entry, apiMode, names = require('./agents/registration').forwardEnvNames()) {
  const key = `mcp_servers.${SERVER_NAME}`;
  const args = ['-c', `${key}.command=${JSON.stringify(entry.command)}`,
    '-c', `${key}.args=${JSON.stringify(entry.args)}`,
    ...Object.entries(entry.env).flatMap(([name, value]) => ['-c', `${key}.env.${name}=${JSON.stringify(value)}`]),
    '-c', `${key}.env_vars=${JSON.stringify(names)}`,
    '-c', `${key}.tool_timeout_sec=900`, '-c', apiMode === 'Disabled' ? `${key}.enabled=false` : `${key}.required=true`];
  if (apiMode === 'Only') {
    args.push('-c', 'web_search="disabled"',
      ...require('./agent-confinement-constants').CODEX_API_ONLY_DISABLED_FEATURES.flatMap(name => ['-c', `features.${name}=false`]),
      '-c', 'features.code_mode_host=true', '-c', 'features.skip_host_skill_discovery=true');
  }
  return args;
}

function codexEvents(onEvent, identity = {}) {
  let session;
  const deniedTurns = new Map();
  const assistantText = new Map();
  const forward = event => { if (typeof onEvent === 'function') onEvent(event); };
  return {
    bind(value) { session = value; },
    onEvent(event) {
      if (event?.type === 'interaction_required') {
        deniedTurns.set(event.turnId, event.payload?.state === 'pending'
          ? 'This turn needs a human response through the Fleet interactions terminal. Fleet has supplied no answer or new permissions.'
          : 'Fleet could not hand off this interaction (' + event.payload?.reason + '); no human rejected it. Review the request in your own session.');
      }
      if (event?.type === 'interaction_resolved') {
        if (event.payload?.state === 'answered') deniedTurns.delete(event.turnId);
        else deniedTurns.set(event.turnId, 'The pending interaction was cancelled (' + event.payload?.reason
          + '). This does not imply a human rejected it. Fleet added no permission grants.');
      }
      if (event?.type === 'input_resolved' && event.payload?.reason === 'unavailable') {
        deniedTurns.set(event.turnId, 'An input request was cancelled because this worker cannot present user interaction. Review the request in your own agent session; Fleet supplied no answers or new permissions.');
        return;
      }
      if (event?.type === 'approval_request') {
        const approval = event.approval;
        deniedTurns.set(event.turnId, APPROVAL_DENIED);
        forward({ type: 'interaction_required', threadId: event.threadId, turnId: event.turnId,
          payload: { ...identity, interactionId: approval?.approvalId || null, kind: 'native-approval',
            sourceName: 'provider-native', state: 'unavailable', reason: 'native_approval_human_route_unavailable', requiresUserDecision: true, responseAuthority: 'same-owner-interactive-terminal' } });
        try {
          if (!approval || !['commandExecution', 'fileChange', 'permissions'].includes(approval.kind)
              || !session?.adapter?.answerApproval) throw refusal('HOST_APPROVAL_UNAVAILABLE', APPROVAL_DENIED);
          session.adapter.answerApproval({ approvalId: approval.approvalId,
            response: approval.kind === 'permissions' ? { permissions: {}, scope: 'turn' } : { decision: 'decline' } });
        } catch {
          try { session?.close(); } catch { /* the normal owned-session close remains authoritative */ }
          forward({ type: 'turn_completed', threadId: event.threadId, turnId: event.turnId, status: 'failed', text: APPROVAL_DENIED });
          deniedTurns.delete(event.turnId);
          assistantText.delete(event.turnId);
        }
        return;
      }
      if (event?.type === 'assistant_text') assistantText.set(event.turnId, event.text);
      if (event?.type === 'turn_completed') {
        if (deniedTurns.has(event.turnId)) event = { ...event,
          text: [event.text || assistantText.get(event.turnId), deniedTurns.get(event.turnId)].filter(Boolean).join('\n\n') };
        deniedTurns.delete(event.turnId);
        assistantText.delete(event.turnId);
      }
      forward(event);
    },
  };
}

function claudeEvents(onEvent, { workspaceRoot = null } = {}) {
  const assistantText = new Map();
  return event => {
    if (event?.type === 'assistant_text') assistantText.set(event.turnId, event.text);
    if (event?.type === 'turn_completed') {
      if (event.payload?.permissionDenied === true) {
        const names = Array.isArray(event.payload.permissionDeniedTools) ? event.payload.permissionDeniedTools : [];
        const rules = names.filter(name => typeof name === 'string'
          && name.startsWith(`mcp__${SERVER_NAME}__`) && /^[A-Za-z0-9_.-]{1,160}$/.test(name));
        // A worker runs at the level it inherited, under the person's own saved
        // permission settings; it cannot ask, so whatever would prompt is denied.
        const explanation = ['The worker was denied tool calls that its inherited level and your saved permission settings do not allow, and it cannot ask.'];
        if (rules.length) explanation.push(`If you want to allow a denied Fleet tool, add only its exact permission rule yourself in the agent's settings: ${rules.map(name => JSON.stringify(name)).join(', ')}.`);
        else if (names.length) explanation.push(`Denied tools: ${names.join(', ')}. Review those requests in your own session and choose any new permission yourself.`);
        else explanation.push('The agent did not supply a usable tool name. Review the denied request in your own session before choosing any new permission.');
        explanation.push('Fleet added no permission grants. Resume the worker after making any permission change you choose.');
        event = { ...event, text: [event.text || assistantText.get(event.turnId), explanation.join(' ')].filter(Boolean).join('\n\n') };
      }
      assistantText.delete(event.turnId);
    }
    if (typeof onEvent === 'function') return onEvent(event);
  };
}

const levels = require('./agents/permission-level');
const RESOLVED_SANDBOX = Object.freeze({ 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' });
const SANDBOX_ORDER = Object.freeze(['readOnly', 'workspaceWrite', 'dangerFullAccess']);
// Directory path only. The provider's own profile variable wins; otherwise the
// documented default folder under that process's HOME. Credential files stay unread.
function inheritedConfigBinding(provider, env) {
  const agents = require('./agents/registry');
  const agent = agents.bundledRegistry().get(provider);
  const variable = agent?.register?.profile?.env;
  if (!['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME'].includes(variable)) return null;
  const configDir = require('./agents/registration').profile(agent, env).root;
  if (typeof configDir !== 'string' || !path.isAbsolute(configDir)) return null;
  return { provider, configDir, authentication: 'inherited-environment' };
}
/* The already-created worker MCP entry carries the requested ceiling. A
   stricter resolved sandbox cannot safely retain that entry either: refuse
   the launch instead of letting MCP tools exceed the worker's actual policy. */
function assertSandboxNotWider(session, settings, level) {
  const asked = settings.sandbox ? SANDBOX_ORDER.indexOf(RESOLVED_SANDBOX[settings.sandbox]) : null;
  const got = SANDBOX_ORDER.indexOf(session.resolvedSandbox && session.resolvedSandbox.type);
  if (got === -1 || (asked !== null && got > asked)) {
    try { session.close(); } catch { /* closing anyway */ }
    throw refusal('HOST_WORKER_POLICY_WIDE', `The worker resolved an unknown or wider sandbox than level ${level} (${levels.LEVEL_NAMES[level]}) allows, so it was stopped.`);
  }
  if ((asked !== null && got < asked) || (level >= 2 && got === 0)) {
    try { session.close(); } catch { /* closing anyway */ }
    throw refusal('HOST_WORKER_POLICY_NARROWED', 'The worker resolved a stricter sandbox than its inherited permission level, so it was stopped. Lower TOOLSENABLED_WORKER_LEVEL to that stricter level and retry.');
  }
}

function createHostWorkerLauncher({ env = process.env, config, workspaceRoot, socketPath, interactionBroker = null,
  observeThreadPolicyForLaunch = null, accountService = null,
  startCodex = options => require('./agent-engine/codex-process').startCodexSession(options),
  resumeCodex = options => require('./agent-engine/codex-process').resumeCodexSession(options),
  startClaude = options => require('./agent-engine/claude-cli-process').startClaudeSession(options),
  resumeClaude = options => require('./agent-engine/claude-cli-process').resumeClaudeSession(options),
  startPi = options => require('./providers/pi-rpc-worker').startPiSession(options),
  resumePi = options => require('./providers/pi-rpc-worker').resumePiSession(options),
  startAcp = options => require('./agent-engine/acp-process').startAcpSession(options),
  resumeAcp = options => require('./agent-engine/acp-process').resumeAcpSession(options),
  startModelApi = options => require('./agent-engine/model-api-process').startModelApiSession(options),
  resumeModelApi = options => require('./agent-engine/model-api-process').resumeModelApiSession(options),
  checkNative = () => require('./host-worker-prerequisite').requireHostWorkerNative(),
  agentApiMode = () => require('./agent-api-policy').agentApiMode({ env }),
} = {}) {
  requireEnabled(config, env);
  if (observeThreadPolicyForLaunch !== null && typeof observeThreadPolicyForLaunch !== 'function')
    throw refusal('HOST_WORKER_POLICY_OBSERVER_INVALID', 'A private launch observer factory is required.');
  async function startNative(spec, { launchObservation = null } = {}) {
    requireEnabled(config, env);
    const workerWorkspaceRoot = spec.workspaceRoot || workspaceRoot;
    if (spec.fleetV2 && spec.fleetV2Security !== 'inherited-environment' && process.platform === 'win32')
      throw refusal('FLEET_WINDOWS_PROVIDER_IPC_UNQUALIFIED', 'The native folder boundary is implemented, but provider IPC under it has not passed qualification; no bypass worker was started.');
    if (launchObservation !== null && typeof launchObservation !== 'function')
      throw refusal('HOST_WORKER_POLICY_OBSERVER_INVALID', 'A private launch observation function is required.');
    const agents = require('./agents/registry');
    const known = agents.activeRegistry(env);
    agents.assertWorkerAvailable(known, spec.provider);
    const agent = known.get(spec.provider);
    const driver = agent ? agent.worker.driver : null;
    const connection = agent ? null : require('./openshell-model-connections').workerConnection(spec, env);
    if (agent && !agents.WORKER_DRIVERS.includes(driver)) {
      throw refusal('HOST_WORKER_PROVIDER_UNSUPPORTED', `This build cannot start "${spec.provider}" as a host worker. Host workers can be: ${agents.workerAgentIds(known).join(', ')}.`);
    }
    checkNative();
    const apiMode = typeof agentApiMode === 'function' ? agentApiMode() : agentApiMode;
    if (!MODES.includes(apiMode)) throw refusal('AGENT_API_MODE_UNAVAILABLE', 'The saved Agent API mode is unavailable.');
    if (apiMode === 'Optimized' && driver && driver !== 'stream-json') throw refusal('AGENT_OPTIMIZED_TOOLS_UNSUPPORTED', 'Optimized Agent API mode supports stream-json agents only.');
    let launchEnv = env, accountLaunch = null;
    if (spec.accountRoute) {
      if (!spec.fleetV2 || !accountService) throw refusal('FLEET_ACCOUNT_SERVICE_UNAVAILABLE', 'The pinned account route needs its configured account-home service; no fallback launch was attempted.');
      if (spec.accountRoute.provider !== spec.provider) throw refusal('FLEET_ACCOUNT_PROVIDER_MISMATCH', 'The pinned account belongs to another provider; preserve this thread and select the matching provider.');
      accountLaunch = await accountService.launch(spec.accountRoute, { model: spec.model });
      launchEnv = accountLaunch.env;
    }
    const tokenFile = path.join(spec.nodeFolder, 'link-token');
    const entry = hostWorkerEntry({ env: launchEnv, config, provider: connection ? 'local' : spec.provider, socketPath, spec, tokenFile });
    writePrivate(tokenFile, `${spec.linkToken}\n`, config.stateRoot);
    if (connection) return require('./agent-engine/model-api-process').startConnectionWorker({ spec, connection,
      env, fleetServer: entry, workspaceRoot: workerWorkspaceRoot, apiMode, startModelApi, resumeModelApi });
    // Every worker keeps the person's environment, sign-in variables included;
    // only Fleet's own identity and the launching session's private bindings
    // (HOST_SESSION_ENV, which belong to that one session) are removed.
    // TOOLSENABLED_WORKER_ID marks the CLI as a Fleet worker, so the person's
    // own client hooks (a UserPromptSubmit hook, say) can tell a worker's task
    // text, which an agent wrote, from words the person typed.
    const common = { cwd: workerWorkspaceRoot, env: { ...cliEnvironment(launchEnv, spec.fleetV2 && spec.fleetV2Security === 'inherited-environment'), TOOLSENABLED_WORKER_ID: spec.nodeId },
      onEvent: spec.onEvent, containProcessTree: true };
    // The worker starts at the level it inherited (default 4, or lower), in
    // this agent's own terms. Fleet never asks for more.
    const level = levels.isLevel(spec.level) ? spec.level : levels.DEFAULT_LEVEL;
    if (!spec.fleetV2) levels.assertWorkerLevel(agent, level, { registry: known });
    // Approval mode is independent of MCP capability level and OS folders.
    const settings = levels.workerSettings(agent, spec.fleetV2 ? 4 : level);
    const removals = levels.nativeRemovalSettings(agent, spec.removeNativeTools);
    common.env = require('./agents/native-removal-environment').removalEnvironment(removals, common.env, { ...spec, workerSettings: settings });
    let inheritedBinding = null;
    if (!spec.accountRoute && spec.fleetV2 && spec.fleetV2Security === 'inherited-environment') {
      try { inheritedBinding = inheritedConfigBinding(spec.provider, common.env); }
      catch { inheritedBinding = null; }
    }
    if (driver === 'pi-rpc') {
      const options = { ...common, level: spec.fleetV2 ? 4 : level, nodeFolder: spec.nodeFolder, apiMode,
        fleetServer: entry, serverName: SERVER_NAME, removeNativeTools: spec.removeNativeTools,
        threadOptions: { ...(spec.model ? { model: spec.model } : {}), ...(spec.effort ? { effort: spec.effort } : {}) } };
      const session = spec.threadId ? await resumePi({ ...options, threadId: spec.threadId }) : await startPi(options);
      return Object.freeze({ ...session, ...(inheritedBinding ? { inheritedBinding } : {}), apiMode, level, turnCompletion: 'event' });
    }
    if (driver === 'acp') {
      const options = { ...common, provider: agent.id, level: spec.fleetV2 ? 4 : level, nodeFolder: spec.nodeFolder,
        removeNativeTools: levels.nativeToolRemovals(spec.removeNativeTools, ['subagents']), apiMode, fleetServer: entry, serverName: SERVER_NAME,
        threadOptions: { ...(spec.model ? { model: spec.model } : {}), ...(spec.effort ? { effort: spec.effort } : {}) } };
      const session = spec.threadId ? await resumeAcp({ ...options, threadId: spec.threadId }) : await startAcp(options);
      return Object.freeze({ ...session, ...(inheritedBinding ? { inheritedBinding } : {}), apiMode, level, turnCompletion: 'event' });
    }
    if (driver === 'app-server') {
      const identity = { nodeId: spec.nodeId, sessionId: spec.sessionId, parentSessionId: spec.parentSessionId || null };
      const observeThreadPolicy = launchObservation || (observeThreadPolicyForLaunch ? observeThreadPolicyForLaunch(spec) : null);
      if (observeThreadPolicy !== null && typeof observeThreadPolicy !== 'function')
        throw refusal('HOST_WORKER_POLICY_OBSERVER_INVALID', 'The private launch observer is unavailable.');
      const events = codexEvents(require('./fleet-v3-accounts').creditCompletionEvents(spec.onEvent, accountLaunch?.codex), identity);
      // The worker keeps the person's own MCP servers, as the lead does; the
      // person's registration of Fleet is replaced by the worker's own server,
      // so the worker never acts as the lead.
      const forwarding = require('./agents/registration');
      const names = forwarding.forwardEnvNames(forwarding.recordedPassEnv({ servicesRoot: path.join(config.stateRoot, 'services'), env }), known);
      const overrides = codexOverrides(entry, apiMode, names);
      const options = { ...common, onEvent: events.onEvent,
        ...(spec.rulesInstructions !== undefined ? { rulesInstructions: rulesText(spec.rulesInstructions),
          rulesStateFile: path.join(spec.nodeFolder, 'codex-rules-state.json') } : {}),
        ...(observeThreadPolicy ? { observeThreadPolicy } : {}),
        ...(interactionBroker ? { requestInput: (request, context) => interactionBroker.request(
          { ...identity, level }, request, { ...context, onEvent: events.onEvent }) } : {}),
        clientInfo: { name: 'toolsenabled-fleet', title: 'ToolsEnabled Fleet', version: '1' },
        command: agent.command, provider: agent.id,
        ...(accountLaunch?.codex ? { requestGate: accountLaunch.codex.requestGate, ...(accountLaunch.codex.beforeThread ? { beforeThread: accountLaunch.codex.beforeThread } : {}) } : {}),
        args: [...(accountLaunch?.codex?.args || ['app-server']), ...overrides, ...Object.entries(removals.overrides).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])],
        threadOptions: {
          ...(spec.model ? { model: spec.model } : {}),
          ...(settings.sandbox ? { sandbox: settings.sandbox } : {}),
          approvalPolicy: settings.approvalPolicy } };
      const session = spec.threadId ? await resumeCodex({ ...options, threadId: spec.threadId, threadProvider: spec.provider }) : await startCodex(options);
      if (spec.threadId && (typeof session.threadCwd !== 'string'
          || path.resolve(session.threadCwd) !== path.resolve(workerWorkspaceRoot))) {
        session.close();
        throw refusal('HOST_WORKER_WORKSPACE_MISMATCH', 'The saved Codex thread belongs to another workspace. Start a new worker in this workspace.');
      }
      if (accountLaunch?.codex && (spec.accountRoute?.admission === 'ordinary-work' || accountLaunch.codex.creditSpend) && (session.model !== (spec.accountRoute.model || accountLaunch.codex.model) || session.accountAdmission?.model !== (spec.accountRoute.model || accountLaunch.codex.model) || session.accountAdmission?.kind !== 'ordinary-work' || session.accountAdmission.account !== spec.accountRoute.account || session.accountAdmission.workspaceId !== accountLaunch.codex.workspaceId)) {
        await session.quiesce(); throw refusal('FLEET_ACCOUNT_MODEL_UNCONFIRMED', 'Provider did not confirm the exact ordinary-work model and admission; no turn was submitted.');
      }
      events.bind(session);
      assertSandboxNotWider(session, settings, level);
      if (spec.effort) {
        try { await session.adapter.updateThreadSettings(session.threadId, { effort: spec.effort }); }
        catch (error) { session.close(); throw error; }
      }
      const resolvedLevel = { readOnly: 1, workspaceWrite: 3, dangerFullAccess: 4 }[session.resolvedSandbox?.type];
      const established = Object.freeze({ ...session, ...(accountLaunch ? { accountWithheldEnv: accountLaunch.withheldEnv || [] } : {}), ...(accountLaunch?.usage ? { accountUsage: accountLaunch.usage } : {}), ...(inheritedBinding ? { inheritedBinding } : {}), apiMode, level: levels.narrowest(level, resolvedLevel),
        rulesInstructionsInContext: spec.fleetV2 === true && spec.rulesInstructions !== undefined });
      if (accountLaunch?.codex?.requestGate && established.rulesInstructionsInContext) {
        const durable = codexRulesSession(established, { options, start: startCodex, resume: resumeCodex, initialRules: spec.rulesInstructions, initialEffort: spec.effort,
          validate: async (refreshed, { effort }) => {
            if (refreshed.threadId !== session.threadId || typeof refreshed.threadCwd !== 'string' || path.resolve(refreshed.threadCwd) !== path.resolve(workerWorkspaceRoot)
                || refreshed.model !== session.model || refreshed.accountAdmission?.kind !== session.accountAdmission?.kind
                || refreshed.accountAdmission?.account !== session.accountAdmission?.account
                || refreshed.accountAdmission?.workspaceId !== session.accountAdmission?.workspaceId
                || refreshed.accountAdmission?.model !== session.accountAdmission?.model)
              throw refusal('FLEET_ACCOUNT_MODEL_UNCONFIRMED', 'Managed rules refresh did not confirm the same conversation, workspace, account and model; no turn was submitted.');
            assertSandboxNotWider(refreshed, settings, level);
            if (effort) await refreshed.adapter.updateThreadSettings(refreshed.threadId, { effort });
          } });
        events.bind(durable); // Approvals must reach the current owned adapter.
        return durable;
      }
      return established;
    }
    const mcpConfig = path.join(spec.nodeFolder, 'mcp.json');
    writePrivate(mcpConfig, JSON.stringify({ mcpServers: apiMode === 'Disabled' ? {} : { [SERVER_NAME]: { type: 'stdio', ...entry } } }) + '\n', config.stateRoot);
    // Retain saved settings and sign-in. Only instruction discovery is scoped
    // to this task; the lead supplies the worker's rules and manual separately.
    const claudeSettings = path.join(spec.nodeFolder, 'claude-settings.json');
    writePrivate(claudeSettings, JSON.stringify(require('./claude-worker-context').workerContextSettings(
      workerWorkspaceRoot, common.env)) + '\n', config.stateRoot);
    const rulesInstructionsFile = spec.rulesInstructions !== undefined ? path.join(spec.nodeFolder, 'claude-rules.txt') : null;
    if (rulesInstructionsFile) writePrivate(rulesInstructionsFile, rulesText(spec.rulesInstructions), config.stateRoot);
    const options = { ...common, ...(rulesInstructionsFile ? { rulesInstructionsFile } : {}), provider: agent.id, command: agent.command, onEvent: claudeEvents(spec.onEvent, { workspaceRoot: workerWorkspaceRoot }),
      threadOptions: { ...(spec.model ? { model: spec.model } : {}), ...(spec.effort ? { effort: spec.effort } : {}) },
      plan: { mcpConfig, settings: claudeSettings, nativeToolArgs: removals.args,
        claudePermissionMode: settings.permissionMode,
        agentApiMode: apiMode === 'Disabled' ? 'Enabled' : apiMode,
        roleFunctionsOnly: false, preserveSettingsSources: true,
        workspaceFileTools: false } };
    const session = spec.threadId ? await resumeClaude({ ...options, threadId: spec.threadId, threadProvider: spec.provider }) : await startClaude(options);
    const revalidateAccount = fn => async options => {
      if (spec.accountRoute) await accountService.validate(spec.accountRoute);
      return fn(options);
    };
    const durable = rulesInstructionsFile ? claudeRulesSession(session, { options, start: revalidateAccount(startClaude), resume: revalidateAccount(resumeClaude), resumed: !!spec.threadId,
      initialRules: spec.rulesInstructions, writeRules: text => writePrivate(rulesInstructionsFile, text, config.stateRoot) }) : session;
    // Keep live provider lifecycle accessors; spreading would freeze their
    // initial values and leave the host watcher on the old process identity.
    return Object.freeze(Object.defineProperties({}, {
      ...Object.getOwnPropertyDescriptors(durable),
      ...(accountLaunch ? { accountWithheldEnv: { value: accountLaunch.withheldEnv || [], enumerable: true } } : {}),
      ...(accountLaunch?.usage ? { accountUsage: { value: accountLaunch.usage, enumerable: true } } : {}),
      ...(inheritedBinding ? { inheritedBinding: { value: inheritedBinding, enumerable: true } } : {}),
      rulesInstructionsInContext: { value: spec.fleetV2 === true && Boolean(rulesInstructionsFile), enumerable: true },
      apiMode: { value: apiMode, enumerable: true },
      level: { value: level, enumerable: true },
    }));
  }
  async function start(spec, options) {
    if (spec.fleetV2 && env.TOOLSENABLED_HOST_SETUP_KIND === 'plugin')
      throw refusal('FLEET_PROFILE_REFUSED', 'Provider bypass workers require standalone fleetV2.');
    if (spec.fleetV2Security != null && (!spec.fleetV2 || spec.fleetV2Security !== 'inherited-environment'))
      throw refusal('FLEET_SECURITY_MODE_INVALID', 'Inherited launch security is available only in explicit standalone fleetV2.');
    if (spec.fleetV2 && spec.fleetV2Security === 'inherited-environment') {
      if (spec.folderScope != null) throw refusal('FLEET_SECURITY_MODE_INVALID', 'Inherited launch security cannot add a Fleet folder boundary.');
      // Native processes inherit the caller's token/kernel policy unchanged.
      // Retained process groups/Jobs remain enabled; provider approval is separate.
      return startNative(spec, options);
    }
    if (spec.fleetV2) return require('./fleet-folder-scope').run(spec.folderScope, () => startNative(spec, options));
    return startNative(spec, options);
  }
  return Object.freeze({ start });
}

module.exports = { createHostWorkerLauncher, hostWorkerEntry, HOST_SESSION_ENV };
