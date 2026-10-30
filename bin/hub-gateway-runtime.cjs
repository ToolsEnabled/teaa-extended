'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { processStartTime, sameProcessAlive } = require('../vendor/fleet/src/lib/proc/process-group.js');
const { readPrivateJsonFile, readPrivateTextFile } = require('../vendor/hub/remote/fra-device.cjs');
const { validateAccountOrigin } = require('./hub-profile.cjs');

const PAIR = /^pair-[0-9a-f]{32}$/;
const MACHINE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function pathsFor(dataDirectory) {
  const directory = path.join(dataDirectory, 'extended', 'hub-gateway');
  return Object.freeze({
    directory,
    config: path.join(directory, 'gateway.json'),
    bridge: path.join(directory, 'bridge.env'),
    record: path.join(directory, 'gateway-process.json'),
    log: path.join(directory, 'gateway.log'),
    stderr: path.join(directory, 'gateway-stderr.log'),
  });
}

function buildGatewayRuntime({ packageRoot, state, fleetStateRoot, treeKey, runtime,
  fleetRuntime = path.join(packageRoot, 'vendor', 'fleet'),
  accountUrl, relayPairId, machine = 'hub', dataDirectory, allowInsecureLoopback = false }) {
  if (!PAIR.test(relayPairId || '') || !MACHINE.test(machine || '')) {
    throw Object.assign(new Error('The selected Hub connection or gateway name is invalid.'), { code: 'FRA_GATEWAY_CONFIG_INVALID' });
  }
  for (const [label, value] of Object.entries({ packageRoot, state, fleetStateRoot, runtime, fleetRuntime, dataDirectory })) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) {
      throw Object.assign(new Error(`The Hub ${label} path is invalid.`), { code: 'FRA_GATEWAY_CONFIG_INVALID' });
    }
  }
  if (typeof treeKey !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(treeKey)) {
    throw Object.assign(new Error('The Hub tree key is invalid.'), { code: 'FRA_GATEWAY_CONFIG_INVALID' });
  }
  validateAccountOrigin(accountUrl, allowInsecureLoopback);
  const files = pathsFor(dataDirectory);
  const config = {
    fraCore: path.join(packageRoot, 'vendor', 'fra-core'),
    state,
    accountUrl,
    origin: accountUrl,
    tunnel: null,
    bridgeConfig: files.bridge,
    log: files.log,
    machines: { [relayPairId]: machine },
    ...(allowInsecureLoopback ? { allowInsecureLoopback: true } : {}),
  };
  const bridge = [
    `FLEET_HUB_STATE_ROOT=${fleetStateRoot}`,
    `FLEET_HUB_TREE_KEY=${treeKey}`,
    `FLEET_HUB_RUNTIME=${fleetRuntime}`,
    'FLEET_HUB_LEVEL_MODE=verify',
    'FLEET_HUB_MAX_LEVEL=4',
    '',
  ].join('\n');
  return Object.freeze({ files, config: Object.freeze(config), bridge });
}

function writePrivateFile(file, contents) {
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()
        || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
      throw Object.assign(new Error('The private Hub gateway state file is unsafe; it was preserved.'), { code: 'FRA_GATEWAY_STATE_UNSAFE' });
    }
  }
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    fs.renameSync(temporary, file);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function readRecord(file, readJson = readPrivateJsonFile) {
  if (!fs.existsSync(file)) return null;
  const value = readJson(file);
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1
      || typeof value.startTime !== 'string' || value.startTime.length < 1
      || typeof value.accountUrl !== 'string' || typeof value.machine !== 'string'
      || typeof value.treeKey !== 'string') {
    throw Object.assign(new Error('The retained Hub gateway process record is invalid; it was preserved.'), { code: 'FRA_GATEWAY_STATE_INVALID' });
  }
  return value;
}

function statusGateway({ dataDirectory, readJson = readPrivateJsonFile, alive = sameProcessAlive } = {}) {
  const files = pathsFor(dataDirectory);
  const record = readRecord(files.record, readJson);
  if (!record) return { running: false };
  return { running: alive(record.pid, record.startTime), machine: record.machine };
}

function gatewayEnvironment(source = process.env) {
  const allowed = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMP', 'TEMP', 'TMPDIR', 'SYSTEMROOT',
    'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    'SSL_CERT_FILE', 'SSL_CERT_DIR']);
  return Object.fromEntries(Object.entries(source).filter(([name]) => allowed.has(name.toUpperCase())));
}

async function startGateway({ packageRoot, dataDirectory, state, fleetStateRoot, treeKey, runtime,
  accountUrl, relayPairId, machine = 'hub', discoverRelayPair, allowInsecureLoopback = false,
  createPrivateDataPath = () => {}, assertPrivateDataPath = () => {}, spawnProcess = spawn,
  startTime = processStartTime, alive = sameProcessAlive, readJson = readPrivateJsonFile,
  readText = readPrivateTextFile, timeoutMs = 15_000 } = {}) {
  if (typeof discoverRelayPair !== 'function') throw new TypeError('discoverRelayPair is required');
  if (!relayPairId) relayPairId = await discoverRelayPair({ accountUrl, state, fraCore: path.join(packageRoot, 'vendor', 'fra-core'), allowInsecureLoopback });
  const prepared = buildGatewayRuntime({ packageRoot, state, fleetStateRoot, treeKey, runtime,
    accountUrl, relayPairId, machine, dataDirectory, allowInsecureLoopback });
  const { files } = prepared;
  createPrivateDataPath(files.directory);
  assertPrivateDataPath(files.directory);

  const current = readRecord(files.record, readJson);
  if (current && alive(current.pid, current.startTime)) {
    const activeConfig = readJson(files.config);
    if (current.accountUrl === accountUrl && current.machine === machine && current.treeKey === treeKey
        && Object.keys(activeConfig.machines || {}).length === 1
        && Object.hasOwn(activeConfig.machines, relayPairId)) {
      return { started: false, connected: true };
    }
    throw Object.assign(new Error('A different FRA gateway is already running. Stop it before changing its account or Hub identity.'), { code: 'FRA_GATEWAY_ALREADY_RUNNING' });
  }
  if (current) fs.unlinkSync(files.record);

  for (const [file, reader] of [[files.config, readJson], [files.bridge, readText], [files.log, readText], [files.stderr, readText]]) {
    if (fs.existsSync(file)) reader(file, 1024 * 1024);
  }
  writePrivateFile(files.bridge, prepared.bridge);
  writePrivateFile(files.config, `${JSON.stringify(prepared.config, null, 2)}\n`);
  writePrivateFile(files.stderr, '');

  const startedAt = Date.now();
  const errorLog = fs.openSync(files.stderr, 'a', 0o600);
  let child;
  try {
    child = spawnProcess(runtime, ['--use-openssl-ca', path.join(packageRoot, 'vendor', 'hub', 'bin', 'fra-gateway.cjs'), '--config', files.config], {
      cwd: packageRoot, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', errorLog],
      env: gatewayEnvironment(),
    });
  } finally { fs.closeSync(errorLog); }
  if (!child || !Number.isSafeInteger(child.pid) || child.pid < 1) {
    throw Object.assign(new Error('The FRA gateway process could not be started.'), { code: 'FRA_GATEWAY_START_FAILED' });
  }
  child.unref();
  let identity = null;
  for (let attempt = 0; attempt < 50 && !identity; attempt += 1) {
    identity = startTime(child.pid);
    if (!identity) await sleep(20);
  }
  if (!identity) {
    try { child.kill('SIGTERM'); } catch {}
    throw Object.assign(new Error('The FRA gateway process identity could not be confirmed.'), { code: 'FRA_GATEWAY_START_FAILED' });
  }
  const record = { version: 1, pid: child.pid, startTime: String(identity), accountUrl, machine, treeKey };
  writePrivateFile(files.record, `${JSON.stringify(record)}\n`);

  const deadline = Date.now() + timeoutMs;
  let connected = false;
  while (Date.now() < deadline) {
    if (!alive(child.pid, identity)) break;
    if (fs.existsSync(files.log)) {
      const text = readText(files.log, 1024 * 1024);
      for (const line of text.split(/\r?\n/)) {
        try {
          const row = JSON.parse(line);
          if (row.machine === machine && typeof row.connected === 'string'
              && Date.parse(row.at) >= startedAt - 1_000) connected = true;
        } catch {}
      }
    }
    if (connected) return { started: true, connected: true };
    await sleep(100);
  }
  const code = alive(child.pid, identity) ? 'FRA_GATEWAY_CONNECT_TIMEOUT' : 'FRA_GATEWAY_START_FAILED';
  await stopGateway({ dataDirectory, readJson, alive });
  throw Object.assign(new Error(code === 'FRA_GATEWAY_CONNECT_TIMEOUT'
    ? 'The FRA gateway did not connect to its account relay before the startup deadline.'
    : 'The FRA gateway exited before connecting to its account relay.'), { code });
}

async function stopGateway({ dataDirectory, readJson = readPrivateJsonFile, alive = sameProcessAlive,
  kill = process.kill, timeoutMs = 4_000 } = {}) {
  const files = pathsFor(dataDirectory);
  const record = readRecord(files.record, readJson);
  if (!record) return { stopped: true, wasRunning: false };
  if (alive(record.pid, record.startTime)) {
    try { kill(record.pid, 'SIGTERM'); } catch (error) {
      if (error.code !== 'ESRCH') throw Object.assign(new Error('The FRA gateway could not be stopped safely.'), { code: 'FRA_GATEWAY_STOP_FAILED' });
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && alive(record.pid, record.startTime)) await sleep(50);
    if (alive(record.pid, record.startTime)) {
      try { kill(record.pid, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') throw Object.assign(new Error('The FRA gateway did not stop within the deadline.'), { code: 'FRA_GATEWAY_STOP_FAILED' });
      }
      for (let attempt = 0; attempt < 20 && alive(record.pid, record.startTime); attempt += 1) await sleep(50);
    }
    if (alive(record.pid, record.startTime)) {
      throw Object.assign(new Error('The FRA gateway did not stop within the deadline.'), { code: 'FRA_GATEWAY_STOP_FAILED' });
    }
  }
  fs.unlinkSync(files.record);
  return { stopped: true, wasRunning: true };
}

module.exports = { buildGatewayRuntime, gatewayEnvironment, pathsFor, startGateway, statusGateway, stopGateway };
