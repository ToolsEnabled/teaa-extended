'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

test('Hub gateway child environment drops provider and Node preload variables', () => {
  const env = gateway.gatewayEnvironment({ PATH: '/usr/bin', HOME: '/tmp/teaa-test-owner', NODE_OPTIONS: '--require hostile.js', OPENAI_API_KEY: 'synthetic' });
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/tmp/teaa-test-owner' });
});
