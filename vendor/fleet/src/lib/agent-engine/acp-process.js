'use strict';

const { AcpAdapter } = require('./acp-adapter');
const { createCodexProcessTransport } = require('./codex-process');
const { createStartupControl } = require('./startup-control');
const { cleanupFailure, validateCleanupTimeout, withOwnedStartupCleanup } = require('./codex-startup-cleanup');
const agents = require('../agents/registry');
const levels = require('../agents/permission-level');

const EDIT_KINDS = Object.freeze(['read', 'search', 'think', 'edit', 'delete', 'move']);
function refusal(code, message) { return Object.assign(new Error(message), { code }); }

// Fleet server programs. An agent's own MCP entry that runs one of these (or
// anything inside this installation) is a person's Fleet registration.
const RUNTIME_ROOT = require('node:path').resolve(__dirname, '..', '..', '..');
const FLEET_PROGRAMS = Object.freeze(['fleetV2.js', 'fleetV3.js', 'fleetV4.js', 'toolsenabled-host.js', 'mcp-server.js']);
const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const AMBIENT_LIST_TIMEOUT_MS = 20_000;
const AMBIENT_LIST_MAX_BYTES = 1024 * 1024;

function launchesFleet(row) {
  const path = require('node:path');
  return [row.command, ...(Array.isArray(row.args) ? row.args : [])].some(value => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return false;
    const resolved = path.resolve(value);
    return FLEET_PROGRAMS.includes(path.basename(resolved))
      || resolved === RUNTIME_ROOT || resolved.startsWith(RUNTIME_ROOT + path.sep);
  });
}

/** Names of the person's Fleet registrations this agent would load next to the
 *  worker's own server, read with the agent's own list command. An ACP agent
 *  merges servers from its own configuration with the session's servers, and
 *  a session server replaces a configured one of the same name. */
function ambientFleetNames(agent, { cwd, env, runList }) {
  if (!agent.mcp.listJson) return [];
  const unchecked = detail => refusal('ACP_AMBIENT_MCP_UNCHECKED', `${agent.name}'s own MCP server list could not be read (${detail}), `
    + 'so this worker was not started: that list might hold a lead\'s Fleet registration, which a worker must never use.');
  const run = runList(agent.command, [...agent.mcp.listJson], { cwd, env, encoding: 'utf8', timeout: AMBIENT_LIST_TIMEOUT_MS,
    maxBuffer: AMBIENT_LIST_MAX_BYTES, stdio: ['ignore', 'pipe', 'pipe'] });
  if (run.error) throw unchecked(run.error.code || 'start failed');
  if (run.status !== 0) throw unchecked(`exit ${run.status === null ? run.signal : run.status}`);
  let rows;
  try { rows = JSON.parse(run.stdout); } catch { throw unchecked('output is not JSON'); }
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || typeof row.name !== 'string')) throw unchecked('output is not a list of named servers');
  const names = [...new Set(rows.filter(row => row.enabled !== false && launchesFleet(row)).map(row => row.name))];
  if (names.some(name => !SERVER_NAME_PATTERN.test(name))) throw unchecked('a Fleet registration has an unusable name');
  return names;
}

// A worker has no person to ask. Use only the agent's once-only choices so
// answering one request never changes permissions for a later request.
function workerEvents({ allow, level, rejectKinds = [], onEvent, adapter }) {
  const turns = new Map();
  return event => {
    let turn = turns.get(event.turnId);
    if (!turn) { turn = { text: '', denied: new Set() }; turns.set(event.turnId, turn); }
    if (event.type === 'approval_request') {
      const { approvalId, details, availableDecisions } = event.approval;
      const kind = details.toolCall.kind;
      const allowed = !rejectKinds.includes(kind) && !(rejectKinds.length && !kind)
        && (allow === 'all' || allow === 'edits' && EDIT_KINDS.includes(kind));
      const choices = availableDecisions || [];
      const option = (allowed && choices.find(choice => choice.kind === 'allow_once'))
        || choices.find(choice => choice.kind === 'reject_once');
      if (!option || option.kind !== 'allow_once') turn.denied.add(kind || 'unknown');
      adapter().answerApproval({ approvalId, response: { outcome: option
        ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } });
      return;
    }
    if (event.type === 'assistant_text') turn.text = event.text;
    if (event.type === 'turn_completed') {
      if (turn.denied.size) {
        const explanation = `The worker denied native permission requests at inherited level ${level} (${levels.LEVEL_NAMES[level]}): ${[...turn.denied].join(', ')}. It cannot ask for approval, and Fleet added no permission grants.`;
        event = { ...event, text: [event.text || turn.text, explanation].filter(Boolean).join('\n\n'),
          payload: { ...event.payload, permissionDenied: true, permissionDeniedTools: [...turn.denied] } };
      }
      turns.delete(event.turnId);
    }
    if (typeof onEvent === 'function') return onEvent(event);
  };
}

async function openAcpSession({ provider, cwd, env = process.env, level = levels.DEFAULT_LEVEL, removeNativeTools = [], nodeFolder,
  fleetServer, serverName, apiMode = 'Enabled', clientInfo, onEvent,
  threadId = null, threadOptions = {}, rootLaunch, signal = null,
  containProcessTree = true, processGroup = false,
  startupTimeoutMs = 60_000, cleanupTimeoutMs = 5_000,
  transportFactory = createCodexProcessTransport, runList = require('node:child_process').spawnSync } = {}) {
  const registry = agents.activeRegistry(env);
  agents.assertWorkerAvailable(registry, provider);
  const agent = registry.get(provider);
  if (agent?.worker.driver !== 'acp') throw refusal('ACP_AGENT_UNSUPPORTED', 'This worker needs an agent descriptor with the ACP driver.');
  if (!levels.isLevel(level)) level = levels.DEFAULT_LEVEL;
  levels.assertWorkerLevel(agent, level, { registry });
  const settings = levels.workerSettings(agent, level);
  const removals = levels.nativeRemovalSettings(agent, removeNativeTools);
  if (!settings || !Array.isArray(settings.args) || !['none', 'edits', 'all'].includes(settings.allow)) {
    throw refusal('ACP_LEVEL_UNAVAILABLE', 'The descriptor cannot enforce this worker level, so no worker was started.');
  }
  env = require('../agents/native-removal-environment').removalEnvironment(removals, env, { nodeFolder, workerSettings: settings });
  if (apiMode !== 'Enabled' && apiMode !== 'Disabled') {
    throw refusal('ACP_API_MODE_UNSUPPORTED', 'This ACP driver cannot enforce the saved Agent API tool restrictions. Choose Enabled or Disabled before starting this worker.');
  }
  if (!fleetServer || typeof serverName !== 'string' || !serverName) {
    throw refusal('ACP_SERVER_REQUIRED', 'An ACP worker needs its own Fleet server entry.');
  }
  const model = threadOptions.model;
  if (model != null && (typeof model !== 'string' || model && !/^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/.test(model))) {
    throw refusal('ACP_MODEL_UNAVAILABLE', 'Choose a model name accepted by the agent descriptor.');
  }
  const args = [...agent.worker.args, ...settings.args,
    ...(model && agent.worker.modelSelection !== 'session' ? [agent.models.flag, model] : [])];
  // The person's own Fleet registration is replaced by this worker's server,
  // so the worker never acts as the lead (as Codex workers' overrides do).
  const ambient = ambientFleetNames(agent, { cwd, env, runList });
  if (ambient.length > 1) {
    throw refusal('ACP_AMBIENT_FLEET_AMBIGUOUS', `${agent.name}'s own configuration registers Fleet more than once (${ambient.join(', ')}). `
      + 'A worker can replace only one, so this worker was not started. Keep one Fleet entry in that configuration.');
  }
  if (ambient.length && apiMode === 'Disabled') {
    throw refusal('ACP_AMBIENT_FLEET_UNREPLACED', `${agent.name}'s own configuration registers Fleet as "${ambient[0]}", and with the Agent API disabled `
      + 'this worker would keep that lead registration. This worker was not started.');
  }
  const workerServerName = ambient.length ? ambient[0] : serverName;
  const mcpServers = apiMode === 'Disabled' ? [] : [{ name: workerServerName, command: fleetServer.command,
    args: [...fleetServer.args], env: Object.entries(fleetServer.env).map(([name, value]) => ({ name, value })) }];
  validateCleanupTimeout(cleanupTimeoutMs);
  const startup = createStartupControl({ signal, timeoutMs: startupTimeoutMs, label: 'ACP worker startup', codePrefix: 'ACP_START' });
  let transport, adapter;
  try {
    startup.throwIfStopped();
    transport = transportFactory({ provider, command: agent.command, args, cwd, env, rootLaunch, containProcessTree, processGroup });
    adapter = new AcpAdapter({ transport, clientInfo, defaultCwd: cwd, mcpServers });
    adapter.onEvent(workerEvents({ allow: settings.allow, level, rejectKinds: removals.rejectKinds, onEvent, adapter: () => adapter }));
    if (rootLaunch) await startup.wait(() => transport.rootReady);
    await startup.wait(() => adapter.initialize());
    // The agent uses its existing environment and profile. Advertised auth
    // methods never authorize Fleet to authenticate or inspect credentials.
    const started = await startup.wait(() => threadId === null ? adapter.startThread() : adapter.resumeThread(threadId));
    if (removals.workerAgent) await startup.wait(() => adapter.selectMode(started.threadId, removals.workerAgent.name));
    if (model && agent.worker.modelSelection === 'session') await startup.wait(() => adapter.selectModel(started.threadId, model));
    if (threadOptions.effort) await startup.wait(() => adapter.selectEffort(started.threadId, threadOptions.effort));
    return Object.freeze({ adapter, threadId: started.threadId, level, apiMode, turnCompletion: 'event', fleetServerName: workerServerName,
      ...(transport.processGroup ? { processGroup: transport.processGroup } : {}),
      async quiesce() { try { adapter.close(); } finally { await transport.closeForStartupFailure(cleanupTimeoutMs); } },
      close() { try { adapter.close(); } finally { transport.close(); } } });
  } catch (error) {
    const nestedCleanup = typeof error?.retryCleanup === 'function' ? error.retryCleanup.bind(error) : null;
    let cleaned = false;
    const retryCleanup = async () => {
      if (cleaned) return;
      const errors = [];
      if (nestedCleanup) { try { await nestedCleanup(); } catch (failure) { errors.push(failure); } }
      try { adapter?.close(); } catch (failure) { errors.push(failure); }
      try { await transport?.closeForStartupFailure(cleanupTimeoutMs); } catch (failure) { errors.push(failure); }
      if (errors.length) throw cleanupFailure('ACP_START_CLEANUP_UNPROVEN', error, errors, retryCleanup);
      cleaned = true;
    };
    await retryCleanup();
    throw withOwnedStartupCleanup(error, retryCleanup);
  } finally { startup.dispose(); }
}

function startAcpSession(options) { return openAcpSession(options); }
function resumeAcpSession(options) {
  if (typeof options?.threadId !== 'string' || !options.threadId) {
    return Promise.reject(refusal('ACP_RESUME_ID_REQUIRED', 'Choose the worker conversation to resume.'));
  }
  return openAcpSession(options);
}

module.exports = Object.freeze({ startAcpSession, resumeAcpSession, ambientFleetNames, launchesFleet });
