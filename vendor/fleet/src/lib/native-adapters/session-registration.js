'use strict';

// Private direct-client registration for the official Claude Code and Codex
// clients. The command is the existing Fleet entry. The default is this
// checkout's generation-4 transport, bin/fleetV4.js. Registration identifies
// the configured generation; a model-free load is not a native model turn.
//
// Each client process is one stdio transport. src/mcp-server.js
// transportSession creates that process's file-tool context. Clients that
// share the private state root share the host store byte-coordination-host.
// This file does not choose a scope id, does not construct a byte authority,
// and does not start a second filesystem server.
//
// Fleet workers stay on src/lib/openshell-worker-session.js, which launches
// src/mcp-server.js with the tree link identity. That column is not this
// registration.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { MISSING_NATIVE_INTERCEPTION } = require('./claude-codex-native');

const SERVER_NAME = 'fleet_v4_native';
const PACKAGE_ROOT = path.resolve(__dirname, '../../..');
const DEFAULT_ENTRY = path.join(PACKAGE_ROOT, 'bin', 'fleetV4.js');
const WORKER_SCRIPT = path.join(PACKAGE_ROOT, 'src', 'mcp-server.js');

function tomlString(value) {
  return JSON.stringify(value);
}

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function cleanLaunchEnv(base = process.env) {
  return Object.fromEntries(Object.entries(base).filter(([name]) =>
    !name.startsWith('TOOLSENABLED_') && name !== 'OPENSHELL_SANDBOX'));
}

function serveArgs(entry, stateRoot, actor) {
  return Object.freeze([entry, 'serve', '--state-root', stateRoot, '--actor', actor]);
}

function createSessionRegistration({
  directory,
  execPath = process.execPath,
  entry = DEFAULT_ENTRY,
  env = process.env
} = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw Object.assign(new Error('The registration directory must be absolute.'), { code: 'ADAPTER_INVALID' });
  }
  if (typeof entry !== 'string' || !path.isAbsolute(entry) || !fs.existsSync(entry) || !fs.statSync(entry).isFile()) {
    throw Object.assign(new Error('The Fleet entry must be an absolute path of an existing file.'), { code: 'ADAPTER_INVALID' });
  }
  const root = path.resolve(directory);
  const resolvedEntry = path.resolve(entry);
  const workspace = path.join(root, 'workspace');
  const stateRoot = path.join(root, 'state');
  const claudeConfigDir = path.join(root, 'claude-config');
  const codexHome = path.join(root, 'codex-home');
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  fs.mkdirSync(claudeConfigDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  if (fs.existsSync(stateRoot)) {
    throw Object.assign(new Error('The private Fleet state directory must not already exist.'), { code: 'ADAPTER_INVALID' });
  }
  const setup = spawnSync(execPath, [
    resolvedEntry, 'setup', '--workspace', workspace, '--state-root', stateRoot,
    '--read-root', workspace, '--write-root', workspace, '--coordination-only', '--actor', 'claude'
  ], { env: cleanLaunchEnv(env), encoding: 'utf8', timeout: 60000 });
  if (setup.status !== 0) {
    throw Object.assign(new Error((setup.stderr || setup.stdout || 'Fleet setup failed.').slice(0, 2000)), {
      code: 'FLEET_SETUP_FAILED'
    });
  }
  const defaultEntry = resolvedEntry === path.resolve(DEFAULT_ENTRY);
  const claudeServeArgs = serveArgs(resolvedEntry, stateRoot, 'claude');
  const codexServeArgs = serveArgs(resolvedEntry, stateRoot, 'codex');
  const mcpConfigPath = path.join(root, 'claude.mcp.json');
  writePrivate(mcpConfigPath, `${JSON.stringify({
    mcpServers: {
      [SERVER_NAME]: {
        type: 'stdio',
        command: execPath,
        args: [...claudeServeArgs]
      }
    }
  }, null, 2)}\n`);
  const codexKey = `mcp_servers.${SERVER_NAME}`;
  const codexConfigArgs = [
    '-c', `${codexKey}.command=${tomlString(execPath)}`,
    '-c', `${codexKey}.args=${tomlString([...codexServeArgs])}`
  ];
  const claudeRegisterArgs = [
    'mcp', 'add-json', '-s', 'user', SERVER_NAME,
    JSON.stringify({ type: 'stdio', command: execPath, args: [...claudeServeArgs] })
  ];
  return Object.freeze({
    serverName: SERVER_NAME,
    directory: root,
    workspace,
    stateRoot,
    entry: resolvedEntry,
    defaultEntry: path.resolve(DEFAULT_ENTRY),
    qualification: defaultEntry ? 'integrated-v4-transport' : 'entry-override-not-v4-qualification',
    v4Qualification: false, // A registration alone never qualifies live native behavior.
    storeName: 'byte-coordination-host',
    scopeId: null,
    parallelFilesystemServer: false,
    mandatoryMediation: false,
    nativeToolsDisabled: false,
    permissionBypass: false,
    missingNativeInterception: MISSING_NATIVE_INTERCEPTION,
    launchEnv: cleanLaunchEnv(env),
    claude: Object.freeze({
      column: 'direct',
      actor: 'claude',
      configDir: claudeConfigDir,
      mcpConfigPath,
      serveArgs: claudeServeArgs,
      sessionArgs: Object.freeze(['--mcp-config', mcpConfigPath, '--strict-mcp-config']),
      registerArgs: Object.freeze(claudeRegisterArgs),
      loadArgs: Object.freeze(['mcp', 'list']),
      env: Object.freeze({ CLAUDE_CONFIG_DIR: claudeConfigDir })
    }),
    codex: Object.freeze({
      column: 'direct',
      actor: 'codex',
      home: codexHome,
      serveArgs: codexServeArgs,
      configArgs: Object.freeze(codexConfigArgs),
      appServerArgs: Object.freeze(['app-server', ...codexConfigArgs]),
      statusMethod: 'mcpServerStatus/list',
      env: Object.freeze({ CODEX_HOME: codexHome })
    }),
    worker: Object.freeze({
      column: 'worker',
      script: WORKER_SCRIPT,
      serverName: 'toolsenabled',
      launchedBy: 'src/lib/openshell-worker-session.js workerServerEntry',
      identityEnv: Object.freeze([
        'TOOLSENABLED_OPENSHELL_NODE',
        'TOOLSENABLED_OPENSHELL_SESSION',
        'TOOLSENABLED_OPENSHELL_LINK_TOKEN_FILE'
      ]),
      usesDirectRegistration: false
    })
  });
}

module.exports = Object.freeze({
  SERVER_NAME,
  DEFAULT_ENTRY,
  WORKER_SCRIPT,
  cleanLaunchEnv,
  createSessionRegistration
});
