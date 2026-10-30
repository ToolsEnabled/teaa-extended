'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PiRpcAdapter } = require('../agent-engine/pi-rpc-adapter');
const { createCodexProcessTransport } = require('../agent-engine/codex-process');
const { createStartupControl } = require('../agent-engine/startup-control');
const { cleanupFailure, validateCleanupTimeout, withOwnedStartupCleanup } = require('../agent-engine/codex-startup-cleanup');
const refusal = (code, message) => Object.assign(new Error(message), { code });

// Inspect only configuration, never auth files. Existing unrelated servers
// stay loaded. A file MCP entry can override an extension registration, so an
// ambient Fleet registration is a named refusal, not a silent lead identity.
function checkAmbient({ cwd, env, serverName }) {
  const agentDir = env.PI_CODING_AGENT_DIR || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.pi', 'agent');
  for (const file of [path.join(agentDir, 'mcp.json'), path.join(cwd, '.pi', 'mcp.json')]) {
    let config;
    try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw refusal('PI_AMBIENT_MCP_UNCHECKED', 'Pi MCP configuration could not be inspected; no worker was started.');
    }
    for (const [name, entry] of Object.entries(config.mcpServers || {})) {
      if (entry?.enabled === false) continue;
      if (name.replaceAll('-', '_') === serverName.replaceAll('-', '_') || require('../agent-engine/acp-process').launchesFleet(entry || {})) {
        throw refusal('PI_AMBIENT_FLEET_UNREPLACED', 'Pi configuration contains an ambient Fleet entry which could retain lead identity; this worker was not started. Use a session with no ambient Fleet registration.');
      }
    }
  }
}

async function openPiSession({ cwd, env = process.env, level = 4, nodeFolder, fleetServer, serverName,
  apiMode = 'Enabled', threadId = null, threadOptions = {}, removeNativeTools = [], onEvent,
  containProcessTree = true, processGroup = false, rootLaunch, signal = null,
  startupTimeoutMs = 60000, cleanupTimeoutMs = 5000,
  transportFactory = createCodexProcessTransport } = {}) {
  const agents = require('../agents/registry');
  const levels = require('../agents/permission-level');
  const registry = agents.activeRegistry(env);
  const agent = registry.get('pi');
  agents.assertWorkerAvailable(registry, 'pi');
  levels.assertWorkerLevel(agent, level, { registry });
  if (!['Enabled', 'Disabled'].includes(apiMode)) throw refusal('PI_API_MODE_UNSUPPORTED', 'Pi preserves native tools and supports Enabled or Disabled Agent API mode only.');
  if (!nodeFolder || !fleetServer || typeof serverName !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(serverName)) throw refusal('PI_WORKER_BINDING_REQUIRED', 'Pi worker requires a private node folder and Fleet server binding.');
  checkAmbient({ cwd, env, serverName });
  const removals = levels.nativeRemovalSettings(agent, removeNativeTools);
  const configPath = path.join(nodeFolder, 'pi-worker.json');
  fs.mkdirSync(nodeFolder, { recursive: true, mode: 0o700 });
  // Binding data lives only in the worker's private node. No provider account
  // files, credentials, or configuration are copied or changed.
  fs.writeFileSync(configPath, JSON.stringify({ serverName, fleetServer: apiMode === 'Disabled' ? null : fleetServer, workspace: cwd }) + '\n', { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  const selected = threadOptions.model;
  if (selected !== undefined && (typeof selected !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$/.test(selected))) throw refusal('PI_MODEL_INVALID', 'Choose an exact Pi provider/model identifier.');
  if (threadId !== null && (typeof threadId !== 'string' || !path.isAbsolute(threadId) || !fs.statSync(threadId).isFile())) throw refusal('PI_RESUME_ID_REQUIRED', 'Pi resume requires the retained session file.');
  const args = [...agent.worker.args, '--session-dir', path.join(nodeFolder, 'pi-sessions'),
    ...(threadId ? ['--session', threadId] : []),
    ...(selected ? ['--model', selected] : []),
    ...removals.args, '-e', path.join(__dirname, 'pi-worker-extension.mjs')];
  // An explicit private official install is supported without installing it
  // globally. Otherwise use the person's normal `pi` command and sign-in.
  const index = env.FLEET_PI_PACKAGE;
  const command = index ? process.execPath : agent.command;
  if (index) args.unshift(path.join(path.dirname(index), 'bundle', 'cli.js'));
  validateCleanupTimeout(cleanupTimeoutMs);
  const startup = createStartupControl({ signal, timeoutMs: startupTimeoutMs, label: 'Pi worker startup', codePrefix: 'PI_START' });
  let transport, adapter;
  try {
    startup.throwIfStopped();
    transport = transportFactory({ provider: 'pi', command, args, cwd,
      env: { ...env, FLEET_PI_WORKER_CONFIG: configPath, FLEET_PI_WORKSPACE: cwd }, containProcessTree, processGroup, rootLaunch });
    adapter = new PiRpcAdapter({ transport });
    if (onEvent) adapter.onEvent(onEvent);
    if (rootLaunch) await startup.wait(() => transport.rootReady);
    const state = await startup.wait(() => adapter.initialize(threadId));
    if (selected && selected !== state.model?.id && selected !== `${state.model?.provider}/${state.model?.id}`) throw refusal('PI_MODEL_UNCONFIRMED', 'Pi did not confirm the requested model; no turn was sent.');
    if (threadOptions.effort) await startup.wait(() => adapter.updateThreadSettings(adapter.threadId, { effort: threadOptions.effort }));
    return Object.freeze({ adapter, threadId: adapter.threadId, nativeSessionId: state.sessionId,
      model: state.model?.id || null, apiMode, level, turnCompletion: 'event',
      ...(transport.processGroup ? { processGroup: transport.processGroup } : {}),
      close() { try { adapter.close(); } finally { transport.close(); } },
      async quiesce() { try { adapter.close(); } finally { await transport.closeForStartupFailure(cleanupTimeoutMs); } }
    });
  } catch (error) {
    let cleaned = false;
    const retryCleanup = async () => {
      if (cleaned) return;
      const errors = [];
      try { adapter?.close(); } catch (failure) { errors.push(failure); }
      try { await transport?.closeForStartupFailure(cleanupTimeoutMs); } catch (failure) { errors.push(failure); }
      if (errors.length) throw cleanupFailure('PI_START_CLEANUP_UNPROVEN', error, errors, retryCleanup);
      cleaned = true;
    };
    await retryCleanup();
    throw withOwnedStartupCleanup(error, retryCleanup);
  } finally { startup.dispose(); }
}
function startPiSession(options) { return openPiSession(options); }
function resumePiSession(options) {
  if (!options?.threadId) return Promise.reject(refusal('PI_RESUME_ID_REQUIRED', 'Choose the retained Pi session file.'));
  return openPiSession(options);
}
module.exports = { startPiSession, resumePiSession, startPiRpc: startPiSession, checkAmbient, integration: 'pi-rpc' };
