'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const root = path.resolve(__dirname, '..');
const teaa = path.join(root, 'bin/teaa.js');
const fleet = path.join(root, 'vendor/fleet/bin/fleetV5.js');

test('TEAA Extended sets up and controls the native V5 Hub; ordinary sessions reconnect with nine public tools', { timeout: 180_000 }, async t => {
  const { createPrivateDataPath } = await import('../src/bundle.js');
  const testRoot = process.env.TEAA_TEST_ROOT;
  if (process.platform === 'win32' && testRoot && !path.isAbsolute(testRoot)) {
    throw new Error('TEAA_TEST_ROOT must be an absolute owned test directory.');
  }
  const scratch = process.platform === 'win32'
    ? path.join(testRoot || path.join(process.env.LOCALAPPDATA || os.homedir(), 'ToolsEnabled'), `TEAA Extended Hub space ${process.pid}-${Date.now()}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'TEAA Extended Hub space '));
  if (process.platform === 'win32') createPrivateDataPath(scratch);
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const workspace = path.join(scratch, 'project space');
  fs.mkdirSync(workspace, { recursive: true });
  const env = {
    ...process.env,
    HOME: scratch,
    ...(process.platform === 'win32' ? { USERPROFILE: process.env.USERPROFILE } : { USERPROFILE: scratch }),
    XDG_CONFIG_HOME: path.join(scratch, 'config space'),
    XDG_DATA_HOME: path.join(scratch, 'data space'),
    APPDATA: path.join(scratch, 'roaming space'),
    LOCALAPPDATA: path.join(scratch, 'local space'),
  };
  if (process.platform === 'win32') {
    for (const directory of [env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.APPDATA, env.LOCALAPPDATA]) {
      createPrivateDataPath(directory);
    }
  }
  function run(entry, args) {
    return spawnSync(process.execPath, [entry, ...args], { cwd: workspace, env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  }
  const setup = run(teaa, ['setup', '--folder', workspace, '--actor', 'local', '--no-browser', '--workers']);
  assert.equal(setup.status, 0, setup.stderr + setup.stdout);
  assert.match(setup.stdout, /TEAA Extended|TEAA .*setup/i);
  const doctor = run(teaa, ['doctor', '--json']);
  assert.equal(doctor.status, 0, doctor.stderr + doctor.stdout);
  assert.equal(JSON.parse(doctor.stdout).healthy, true);
  let stopped = false;
  t.after(() => { if (!stopped) run(teaa, ['hub', 'stop', '--actor', 'local']); });
  const start = run(teaa, ['hub', 'start', '--actor', 'local']);
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stdout, /"started":true/);
  const status = run(teaa, ['hub', 'status', '--actor', 'local']);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /"treeKey":"local"/);

  const dataRoot = process.platform === 'win32'
    ? path.join(env.LOCALAPPDATA, 'ToolsEnabled', 'toolsenabled-agent-kit')
    : path.join(env.XDG_DATA_HOME, 'toolsenabled-agent-kit');
  const state = path.join(dataRoot, 'fleetV5-state');
  async function attachOptions() {
    const child = spawn(process.execPath, [fleet, 'serve', '--state-root', state, '--actor', 'local', '--attach'], {
      cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const lines = readline.createInterface({ input: child.stdout });
    const pending = new Map();
    let id = 0;
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    lines.on('line', line => {
      let value;
      try { value = JSON.parse(line); } catch { return; }
      if (pending.has(value.id)) { const item = pending.get(value.id); pending.delete(value.id); clearTimeout(item.timer); item.resolve(value); }
    });
    child.on('close', code => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(`Fleet attach exited ${code}: ${stderr}`)); } pending.clear(); });
    const request = (method, params) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`MCP ${method} timed out: ${stderr}`)); }, 25_000);
      pending.set(requestId, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    });
    try {
      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'teaa-extended-test', version: '1' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const list = await request('tools/list', {});
      const names = list.result?.tools?.map(tool => tool.name) || [];
      const expected = ['fleet.contract.options', 'fleet.contract.review', 'fleet.contract.library', 'fleet.contract.submit', 'fleet.contract.inspect', 'fleet.contract.answer', 'fleet.contract.amend', 'fleet.contract.cancel', 'fleet.contract.determinacy'];
      assert.deepEqual([...names].sort(), [...expected].sort());
      const result = await request('tools/call', { name: 'fleet.contract.options', arguments: { request: {} } });
      assert.ok(!result.isError && !result.result?.isError, JSON.stringify(result));
      const closed = new Promise(resolve => child.once('close', resolve));
      child.stdin.end();
      await closed;
      lines.close();
      return { names, result: result.result };
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }
  const first = await attachOptions();
  const second = await attachOptions();
  assert.deepEqual(second, first);
  const stop = run(teaa, ['hub', 'stop', '--actor', 'local']);
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stdout, /"stopped":true/);
  stopped = true;
  const absent = run(teaa, ['hub', 'status', '--actor', 'local']);
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /HUB_NOT_RUNNING|No Fleet hub is running/);
});
