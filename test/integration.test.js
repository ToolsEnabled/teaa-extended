import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { McpClient, resultText } from '../src/mcp/client.js';
import { Gateway, exposedName } from '../src/mcp/gateway.js';
import { isPresentationItem } from '../src/mcp/presentation.js';
import { shimTarget, cmdQuote, resolveCommand, isWindows } from '../src/platform.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK_MCP = join(HERE, 'fixtures', 'mock-mcp.js');
const TEAA = join(HERE, '..', 'bin', 'teaa.js');
const tmp = () => mkdtempSync(join(tmpdir(), 'teaa-test-'));

test('mcp client: start, list and call a stdio server', async () => {
  const c = new McpClient({ name: 'mock', command: 'node', args: [MOCK_MCP, '--kind', 'fleet'] });
  await c.start();
  assert.equal(c.serverInfo.name, 'mock-fleet');
  assert.equal(c.tools.length, 4);
  const r = await c.callTool('task.list', { limit: 1 });
  assert.equal(JSON.parse(resultText(r)).tasks[0].taskId, 'task_1');
  c.close();
});

test('mcp client: a missing program is reported, not thrown later', async () => {
  const c = new McpClient({ name: 'none', command: 'teaa-no-such-program-xyz', args: [] });
  await assert.rejects(c.start(), /program not found/);
  assert.equal(c.state, 'failed');
});

test('gateway: prefixes names, keeps annotations, adds teaa_status, routes calls', async () => {
  const gw = new Gateway({
    upstreams: [
      { key: 'fleet', launch: { command: 'node', args: [MOCK_MCP, '--kind', 'fleet'] } },
      { key: 'engine', launch: { command: 'node', args: [MOCK_MCP, '--kind', 'engine'] } },
    ],
  });
  await gw.start();
  const tools = gw.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('fleet_system_status'));
  assert.ok(names.includes('engine_web_fetch'));
  assert.ok(names.includes('teaa_status'));
  assert.ok(names.every((n) => /^[A-Za-z0-9_-]{1,64}$/.test(n)));
  const write = tools.find((t) => t.name === 'fleet_host_write_file');
  assert.equal(write.annotations.destructiveHint, true);
  assert.equal(write.annotations.readOnlyHint, false);
  const r = await gw.call('engine_workspace_list', { a: 1 });
  assert.deepEqual(JSON.parse(resultText(r)), { called: 'workspace.list', args: { a: 1 }, kind: 'engine' });
  const st = await gw.call('teaa_status', {});
  assert.equal(st.structuredContent.upstreams.length, 2);
  const bad = await gw.call('fleet_nope', {});
  assert.equal(bad.isError, true);
  assert.match(gw.instructions(), /Mock fleet rules/);
  gw.close();
});

test('gateway: an upstream that fails to start leaves the other one working', async () => {
  const gw = new Gateway({ upstreams: [
    { key: 'fleet', launch: { command: 'teaa-missing-fleet-xyz', args: [] } },
    { key: 'engine', launch: { command: 'node', args: [MOCK_MCP, '--kind', 'engine'] } },
  ] });
  await gw.start();
  assert.ok(gw.listTools().some((t) => t.name === 'engine_web_fetch'));
  assert.equal(gw.status().upstreams[0].status, 'failed');
  gw.close();
});

test('exposed names stay within 64 characters', () => {
  assert.equal(exposedName('fleet', 'a.b'), 'fleet_a_b');
  assert.ok(exposedName('fleet', 'x'.repeat(100)).length <= 64);
});

function envFor(dir) {
  const env = { ...process.env, XDG_CONFIG_HOME: join(dir, 'cfg'), XDG_DATA_HOME: join(dir, 'data'), APPDATA: join(dir, 'appdata'), LOCALAPPDATA: join(dir, 'local') };
  return env;
}

function writeConfig(dir, cfg) {
  const p = isWindows ? join(dir, 'appdata', 'ToolsEnabled', 'toolsenabled-agent-kit') : join(dir, 'cfg', 'toolsenabled-agent-kit');
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'config.json'), JSON.stringify(cfg));
}

test('teaa mcp: end to end over stdio with both upstreams', { timeout: 15000 }, async (t) => {
  const dir = tmp();
  mkdirSync(join(dir, 'work'));
  writeConfig(dir, {
    fleet: { command: process.execPath, args: [MOCK_MCP, '--kind', 'fleet'] },
    engine: { command: process.execPath, args: [MOCK_MCP, '--kind', 'engine'] },
    mcp: { folder: join(dir, 'work') },
  });
  const child = spawn(process.execPath, [TEAA, 'mcp', '--actor', 'codex'], { env: envFor(dir), stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.stdin.end(); if (child.exitCode === null) child.kill(); });
  const lines = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  const waitFor = (id) => new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const check = () => { const m = lines.find((l) => l.id === id); if (m) resolve(m); else if (Date.now() > deadline || child.exitCode !== null) reject(new Error(`MCP response ${id} unavailable`)); else setTimeout(check, 20); };
    check();
  });
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  const init = await waitFor(1);
  assert.equal(init.result.serverInfo.name, 'teaa');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const list = await waitFor(2);
  assert.ok(list.result.tools.some((t) => t.name === 'fleet_task_list'));
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fleet_system_status', arguments: {} } });
  const call = await waitFor(3);
  const data = call.result.content.filter((c) => !isPresentationItem(c)); // the optional TEAA line is for the person
  assert.equal(data.length, 1);
  assert.equal(JSON.parse(data[0].text).actor, 'codex', '--actor reaches Fleet');
  child.stdin.end();
  await new Promise((r) => child.on('exit', r));
});
