'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

test('Extended CLI version matches the package release identity', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const versionSource = fs.readFileSync(path.join(root, 'src/version.js'), 'utf8');
  assert.ok(versionSource.includes(`export const VERSION = '${pkg.version}';`));
});

test('select-hub stores the real FRA route with package-owned client state and restores local Fleet', async () => {
  const source = fs.readFileSync(path.join(root, 'bin/teaa-extended.js'), 'utf8');
  const code = source.replace(/^import .*;$/mg, '').replace(/^#!.*\n/, '')
    .replace('const FLEET_PIN=fleetPins.fleetPin();', 'const FLEET_PIN={runtime:{stateDirectory:"fleetV5-state"}};')
    .replace('import.meta.url', '"file:///C:/app/bin/teaa-extended.js"')
    .replace('main();', 'globalThis.__run=main;');
  const originalFleet = { enabled: true, command: 'node', args: ['local-fleet'], env: {} };
  const config = { fleet: originalFleet };
  const input = { transports: ['fra'], fra: { accountUrl: 'http://127.0.0.1:12345', origin: 'http://127.0.0.1:12345', relayPairId: 'pair-' + 'a'.repeat(32), allowInsecureLoopback: true } };
  const writes = new Map();
  const context = {
    dirname: path.win32.dirname, join: path.win32.join, resolve: path.win32.resolve,
    fileURLToPath: () => 'C:\\app\\bin\\teaa-extended.js',
    readFileSync: () => JSON.stringify(input), mkdirSync: () => {}, existsSync: () => false,
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }),
    writeFileSync: (file, data) => writes.set(file, JSON.parse(data)),
    loadConfig: () => config, saveConfig: () => {}, configDir: () => 'C:\\private\\config',
    dataDir: () => 'C:\\private\\data', assertPrivateDataPath: () => {}, createPrivateDataPath: () => {},
    hubProfile: { discoverRelayPair: async () => 'pair-' + 'd'.repeat(32) },
    process: { argv: ['node', 'teaa-extended.js', 'select-hub', 'profile.json'], execPath: 'C:\\Program Files\\nodejs\\node.exe' },
    console,
  };
  vm.runInNewContext(code, context);
  await context.__run();
  const target = 'C:\\private\\config\\extended\\hub.json';
  const stored = writes.get(target);
  assert.ok(stored);
  assert.equal(Object.hasOwn(stored, 'session'), false);
  assert.equal(stored.fra.state, 'C:\\private\\data\\extended\\devices\\default');
  assert.equal(stored.fra.fraCore, 'C:\\app\\vendor\\fra-core');
  assert.equal(stored.fleetRoot, 'C:\\app\\vendor\\fleet');
  assert.equal(stored.fleetStateRoot, 'C:\\private\\data\\fleetV5-state');
  assert.equal(config.fleet.command, 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(config.fleet.args[0], 'C:\\app\\bin\\hub-client.cjs');
  assert.deepEqual(config.extended.localFleet, originalFleet);
});

test('teaa hub start provisions its FRA gateway from the enrolled account connection', async () => {
  const source = fs.readFileSync(path.join(root, 'bin/teaa-extended.js'), 'utf8');
  const code = source.replace(/^import .*;$/mg, '').replace(/^#!.*\n/, '')
    .replace('const FLEET_PIN=fleetPins.fleetPin();', 'const FLEET_PIN={runtime:{stateDirectory:"fleetV5-state"}};')
    .replace('import.meta.url', '"file:///C:/app/bin/teaa-extended.js"')
    .replace('main();', 'globalThis.__run=main;');
  const starts = [];
  const context = {
    dirname: path.win32.dirname, join: path.win32.join, resolve: path.win32.resolve,
    fileURLToPath: () => 'C:\\app\\bin\\teaa-extended.js',
    existsSync: () => true, lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }),
    spawnSync: () => ({ status: 0 }),
    hubProfile: { discoverRelayPair: async () => `pair-${'d'.repeat(32)}`, validateAccountOrigin: url => assert.equal(url, 'https://account.example.test') },
    hubGateway: { startGateway: async options => { starts.push(options); return { started: true, connected: true }; },
      stopGateway: async () => ({ stopped: true }), statusGateway: () => ({ running: true }) },
    inheritedEnv: () => ({}), loadConfig: () => ({ mcp: { actor: 'local' } }), saveConfig: () => {},
    configDir: () => 'C:\\private\\config', dataDir: () => 'C:\\private\\data',
    createPrivateDataPath: () => {}, assertPrivateDataPath: () => {},
    process: { argv: ['node', 'teaa-extended.js', 'hub', 'start', '--actor', 'local', '--account', 'https://account.example.test', '--machine', 'desk'],
      execPath: 'C:\\Program Files\\nodejs\\node.exe', exitCode: 0 }, console,
  };
  vm.runInNewContext(code, context);
  await context.__run();
  assert.equal(starts.length, 1);
  assert.equal(starts[0].accountUrl, 'https://account.example.test');
  assert.equal(starts[0].machine, 'desk');
  assert.equal(starts[0].state, 'C:\\private\\data\\extended\\devices\\default');
  assert.equal(starts[0].fleetStateRoot, 'C:\\private\\data\\fleetV5-state');
  assert.equal(starts[0].treeKey, 'local');
  assert.equal(starts[0].relayPairId, null);
});

test('native Windows client recognizes the V5 Hub parent and allows an ordinary shell parent', () => {
  const { fleetWorker } = require('../vendor/hub/remote/remote-lead-mcp.cjs');
  const workerTree = new Map([
    [100, { pid: 100, ppid: 200, argv: ['codex.exe'] }],
    [200, { pid: 200, ppid: 1, argv: ['node.exe', 'C:\\TEAA\\vendor\\fleet\\bin\\fleetV5.js', 'serve', '--actor', 'codex'] }],
  ]);
  assert.match(fleetWorker(100, { platform: 'win32', envNames: [], readProcesses: () => workerTree }), /Fleet worker/);
  const shellTree = new Map([
    [100, { pid: 100, ppid: 200, argv: ['codex.exe'] }],
    [200, { pid: 200, ppid: 1, argv: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'] }],
  ]);
  assert.equal(fleetWorker(100, { platform: 'win32', envNames: [], readProcesses: () => shellTree }), null);
});


test('first Extended open creates its Windows state leaf with the private-state helper', async () => {
  const source = fs.readFileSync(path.join(root, 'bin/teaa-extended.js'), 'utf8');
  const code = source.replace(/^import .*;$/mg, '').replace(/^#!.*\n/, '')
    .replace('const FLEET_PIN=fleetPins.fleetPin();', 'const FLEET_PIN={runtime:{stateDirectory:"fleetV5-state"}};')
    .replace('import.meta.url', '"file:///C:/app/bin/teaa-extended.js"')
    .replace('main();', 'globalThis.__run=main;');
  const events = [];
  const context = {
    dirname: path.win32.dirname, join: path.win32.join, resolve: path.win32.resolve,
    fileURLToPath: () => 'C:\\app\\bin\\teaa-extended.js',
    spawnSync: (...args) => { events.push(['spawn', ...args]); return { status: 0 }; },
    assertPrivateDataPath: value => events.push(['inspect', value]),
    createPrivateDataPath: value => events.push(['create', value]),
    hubProfile: { discoverRelayPair: async () => 'pair-' + 'd'.repeat(32) },
    inheritedEnv: () => ({}), loadConfig: () => ({}), saveConfig: () => {},
    configDir: () => 'C:\\private\\config', dataDir: () => 'C:\\private\\data',
    process: { argv: ['node', 'teaa-extended.js', 'open', '--account', 'https://account.example.test', '--name', 'Laptop'],
      execPath: 'C:\\Program Files\\nodejs\\node.exe' }, console,
  };
  vm.runInNewContext(code, context);
  await context.__run();
  assert.deepEqual(events.map(event => event[0]), ['create', 'inspect', 'spawn']);
  assert.equal(events[0][1], 'C:\\private\\data\\extended\\devices\\default');
});
