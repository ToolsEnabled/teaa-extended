'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const gateway = require('../bin/hub-gateway-runtime.cjs');

test('Linux private state creation creates a new leaf with owner-only mode', { skip: process.platform === 'win32' }, async () => {
  const { createPrivateDataPath } = await import('../src/bundle.js');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'teaa-private-state-'));
  const target = path.join(scratch, 'extended', 'hub-gateway');
  try {
    createPrivateDataPath(target);
    const stat = fs.statSync(target);
    assert.equal(stat.isDirectory(), true);
    assert.equal(stat.mode & 0o777, 0o700);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('Hub gateway configuration binds the enrolled account connection to the local Fleet tree', () => {
  const runtime = gateway.buildGatewayRuntime({
    packageRoot: '/opt/teaa', dataDirectory: '/tmp/teaa-test-owner/.local/share/toolsenabled-agent-kit',
    state: '/tmp/teaa-test-owner/.local/share/toolsenabled-agent-kit/extended/devices/default',
    fleetStateRoot: '/tmp/teaa-test-owner/.local/share/toolsenabled-agent-kit/fleetV5-state',
    treeKey: 'local', runtime: '/usr/bin/node', accountUrl: 'https://account.example.test',
    relayPairId: `pair-${'a'.repeat(32)}`, machine: 'desk',
  });
  assert.equal(runtime.config.accountUrl, 'https://account.example.test');
  assert.equal(runtime.config.machines[`pair-${'a'.repeat(32)}`], 'desk');
  assert.equal(runtime.config.bridgeConfig, runtime.files.bridge);
  assert.match(runtime.bridge, /FLEET_HUB_STATE_ROOT=\/home\/owner\/\.local\/share\/toolsenabled-agent-kit\/fleetV5-state/);
  assert.match(runtime.bridge, /FLEET_HUB_TREE_KEY=local/);
  assert.match(runtime.bridge, /FLEET_HUB_RUNTIME=\/opt\/teaa\/vendor\/fleet/);
  assert.equal(JSON.stringify(runtime).includes('deviceToken'), false);
});

test('starting the Hub creates a private FRA gateway from the enrolled account pairing and stops it by process identity', { timeout: 10_000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'teaa-hub-gateway-'));
  try {
    const dataDirectory = path.join(scratch, 'data');
    const pair = `pair-${'b'.repeat(32)}`;
    let relayLookup = null;
    let processAlive = true;
    const result = await gateway.startGateway({
      packageRoot: path.resolve('/opt/teaa'), dataDirectory,
      state: path.join(dataDirectory, 'extended', 'devices', 'default'),
      fleetStateRoot: path.join(dataDirectory, 'fleetV5-state'), treeKey: 'local',
      runtime: '/usr/bin/node', accountUrl: 'https://account.example.test', machine: 'desk',
      discoverRelayPair: async input => { relayLookup = input; return pair; },
      createPrivateDataPath: directory => fs.mkdirSync(directory, { recursive: true, mode: 0o700 }),
      assertPrivateDataPath: () => {},
      startTime: () => 'fake-process-start', alive: () => processAlive,
      spawnProcess: (_exe, args, options) => {
        assert.deepEqual(args.slice(-2), ['--config', args.at(-1)]);
        assert.match(args.at(-1), /hub-gateway[\/]gateway\.json$/);
        assert.equal(options.detached, true);
        assert.equal(Object.hasOwn(options.env, 'NODE_OPTIONS'), false);
        const config = JSON.parse(fs.readFileSync(args.at(-1), 'utf8'));
        fs.writeFileSync(config.log, `${JSON.stringify({ at: new Date().toISOString(), machine: 'desk', connected: 'machine-a' })}\n`, { mode: 0o600 });
        return { pid: 424242, unref() {}, kill() {} };
      },
    });
    assert.deepEqual(result, { started: true, connected: true });
    assert.equal(relayLookup.accountUrl, 'https://account.example.test');
    assert.equal(relayLookup.state, path.join(dataDirectory, 'extended', 'devices', 'default'));
    const files = gateway.pathsFor(dataDirectory);
    const config = JSON.parse(fs.readFileSync(files.config, 'utf8'));
    assert.equal(config.machines[pair], 'desk');
    assert.equal(fs.statSync(files.config).mode & 0o777, 0o600);
    assert.deepEqual(gateway.statusGateway({ dataDirectory, alive: () => processAlive }), { running: true, machine: 'desk' });

    const stopped = await gateway.stopGateway({ dataDirectory, alive: () => processAlive,
      kill: (_pid, signal) => { assert.equal(signal, 'SIGTERM'); processAlive = false; } });
    assert.deepEqual(stopped, { stopped: true, wasRunning: true });
    assert.equal(fs.existsSync(files.record), false);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});


test('Hub-first and FRA-open-first device state creation both use the private path helper', { timeout: 10_000 }, async () => {
  const fraDevice = require('../vendor/hub/remote/fra-device.cjs');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'teaa-hub-fra-state-order-'));
  try {
    for (const orderName of ['hub-first', 'fra-open-first']) {
      const dataDirectory = path.join(scratch, orderName);
      const state = path.join(dataDirectory, 'extended', 'devices', 'default');
      const pair = `pair-${(orderName === 'hub-first' ? 'c' : 'd').repeat(32)}`;
      const events = [];
      const createPrivateDataPath = directory => {
        events.push(['create', directory]);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      };
      const assertPrivateDataPath = directory => {
        events.push(['assert', directory]);
        assert.equal(fs.statSync(directory).isDirectory(), true);
      };
      const openDevice = () => fraDevice.ensurePrivateDirectory(state, {
        platform: 'win32',
        windowsCreate: directory => {
          events.push(['windows-helper', directory]);
          fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        },
      });
      const startHub = async () => gateway.startGateway({
        packageRoot: path.resolve('/opt/teaa'), dataDirectory, state,
        fleetStateRoot: path.join(dataDirectory, 'fleetV5-state'), treeKey: 'local',
        runtime: '/usr/bin/node', accountUrl: 'https://account.example.test', machine: 'desk',
        discoverRelayPair: async input => {
          events.push(['discover', input.state]);
          assert.equal(fs.existsSync(input.state), true, 'FRA discovery must see helper-created state');
          return pair;
        },
        createPrivateDataPath, assertPrivateDataPath,
        startTime: () => 'fake-process-start', alive: () => true,
        spawnProcess: (_exe, args) => {
          const config = JSON.parse(fs.readFileSync(args.at(-1), 'utf8'));
          fs.writeFileSync(config.log, `${JSON.stringify({ at: new Date().toISOString(), machine: 'desk', connected: 'machine-a' })}\n`);
          return { pid: 515151, unref() {}, kill() {} };
        },
      });
      if (orderName === 'hub-first') {
        await startHub();
        openDevice();
        assert.deepEqual(events.slice(0, 3), [['create', state], ['assert', state], ['discover', state]]);
        assert.deepEqual(events.at(-1), ['windows-helper', state]);
      } else {
        openDevice();
        await startHub();
        assert.deepEqual(events.slice(0, 4), [
          ['windows-helper', state], ['create', state], ['assert', state], ['discover', state],
        ]);
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('Hub gateway child environment keeps required platform paths and drops unrelated variables', () => {
  const source = { PATH: '/usr/bin', HOME: '/tmp/teaa-test-owner', USER: 'owner', LOGNAME: 'owner',
    TMP: '/tmp', TEMP: '/tmp', TMPDIR: '/tmp', SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows',
    APPDATA: 'C:\\Users\\owner\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\owner\\AppData\\Local',
    USERPROFILE: 'C:\\Users\\owner', XDG_CONFIG_HOME: '/tmp/teaa-test-owner/.config',
    XDG_DATA_HOME: '/tmp/teaa-test-owner/.local/share', XDG_RUNTIME_DIR: '/run/user/1001',
    SSL_CERT_FILE: '/etc/ssl/cert.pem', SSL_CERT_DIR: '/etc/ssl/certs',
    NODE_OPTIONS: '--require hostile.js', OPENAI_API_KEY: 'synthetic',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1001/bus', XDG_STATE_HOME: '/tmp/teaa-test-owner/.local/state',
    XDG_CACHE_HOME: '/tmp/teaa-test-owner/.cache', FLEET_HUB_LEAD_TAG: 'tag' };
  const env = gateway.gatewayEnvironment(source);
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/tmp/teaa-test-owner', USER: 'owner', LOGNAME: 'owner',
    TMP: '/tmp', TEMP: '/tmp', TMPDIR: '/tmp', SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows',
    APPDATA: 'C:\\Users\\owner\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\owner\\AppData\\Local',
    USERPROFILE: 'C:\\Users\\owner', XDG_CONFIG_HOME: '/tmp/teaa-test-owner/.config',
    XDG_DATA_HOME: '/tmp/teaa-test-owner/.local/share', XDG_RUNTIME_DIR: '/run/user/1001',
    SSL_CERT_FILE: '/etc/ssl/cert.pem', SSL_CERT_DIR: '/etc/ssl/certs' });
});

test('Hub gateway environment lets a bridge proxy attach when the Hub socket uses XDG_RUNTIME_DIR', {
  timeout: 60_000, skip: process.platform === 'win32',
}, async t => {
  const root = path.resolve(__dirname, '..');
  const teaa = path.join(root, 'bin', 'teaa.js');
  const { createPrivateDataPath } = await import('../src/bundle.js');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'teaa-hub-gateway-runtime-dir-'));
  const home = path.join(scratch, 'home');
  const workspace = path.join(scratch, 'workspace');
  const xdgRuntime = path.join(scratch, 'runtime');
  const dirs = [home, workspace, xdgRuntime, ...['config', 'data', 'state', 'cache', 'tmp'].map(name => path.join(scratch, name))];
  for (const directory of dirs) createPrivateDataPath(directory);
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin', HOME: home,
    USER: process.env.USER || 'teaa-test', LOGNAME: process.env.LOGNAME || process.env.USER || 'teaa-test',
    TMP: path.join(scratch, 'tmp'), TEMP: path.join(scratch, 'tmp'), TMPDIR: path.join(scratch, 'tmp'),
    XDG_RUNTIME_DIR: xdgRuntime, XDG_CONFIG_HOME: path.join(scratch, 'config'),
    XDG_DATA_HOME: path.join(scratch, 'data'), XDG_STATE_HOME: path.join(scratch, 'state'),
    XDG_CACHE_HOME: path.join(scratch, 'cache'), LANG: 'C.UTF-8',
  };
  const run = (entry, args, options = {}) => spawnSync(process.execPath, [entry, ...args], {
    cwd: workspace, env, encoding: 'utf8', timeout: 30_000, windowsHide: true, ...options,
  });
  try {
    const setup = run(teaa, ['setup', '--folder', workspace, '--actor', 'local', '--no-browser', '--workers']);
    assert.equal(setup.status, 0, setup.stderr + setup.stdout);
    const started = run(teaa, ['hub', 'start', '--actor', 'local']);
    assert.equal(started.status, 0, started.stderr + started.stdout);
    const dataRoot = path.join(env.XDG_DATA_HOME, 'toolsenabled-agent-kit');
    const stateRoot = path.join(dataRoot, 'fleetV5-state');
    const bridgeConfig = path.join(scratch, 'bridge.env');
    fs.writeFileSync(bridgeConfig, [
      'FLEET_HUB_STATE_ROOT=' + stateRoot, 'FLEET_HUB_TREE_KEY=local',
      'FLEET_HUB_RUNTIME=' + path.join(root, 'vendor', 'fleet'), 'FLEET_HUB_LEVEL_MODE=verify',
      'FLEET_HUB_MAX_LEVEL=4', '',
    ].join('\n'), { mode: 0o600 });
    const fleetHub = require('../vendor/fleet/src/lib/fleet-hub.js');
    const hub = fleetHub.readHub(fleetHub.treeFolderOf(stateRoot, 'local'));
    assert.ok(hub && hub.socketPath.startsWith(path.join(xdgRuntime, 'tef') + path.sep),
      'Hub socket did not use XDG_RUNTIME_DIR: ' + (hub && hub.socketPath));

    // fra-gateway adds the authenticated relay request after inheriting this
    // filtered environment. Exercise that same environment at the bridge seam.
    const bridgeEnv = { ...gateway.gatewayEnvironment(env), SSH_ORIGINAL_COMMAND: 'attach actor=local level=4' };
    const attached = spawnSync(process.execPath, [path.join(root, 'vendor', 'hub', 'bin', 'hub-lead-bridge.cjs'),
      '--machine', 'desk', '--config', bridgeConfig], {
      cwd: workspace, env: bridgeEnv, encoding: 'utf8', input: '', timeout: 20_000, windowsHide: true,
    });
    assert.equal(attached.status, 0, attached.stderr + attached.stdout);
    assert.match(attached.stderr, /\[fleetV[2345]\] attached to the fleet hub/);
  } finally {
    run(teaa, ['hub', 'stop', '--actor', 'local']);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
