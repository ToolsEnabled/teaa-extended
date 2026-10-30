import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { defaults, loadConfig, fleetServerEntry, fleetLaunch, engineLaunch } from '../src/config.js';
import { spawnResolved, spawnResolvedSync, shimTarget, isWindows } from '../src/platform.js';
import { McpClient, PROTOCOL_VERSION } from '../src/mcp/client.js';
import { Gateway, serveStdio } from '../src/mcp/gateway.js';
import { isPresentationItem } from '../src/mcp/presentation.js';
import { probe } from '../src/setup.js';
import { detectBundledBrowser } from '../src/bundle.js';
const MCP = fileURLToPath(new URL('./fixtures/runtime-mcp.js', import.meta.url));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const temp = (t) => { const dir = mkdtempSync(join(tmpdir(), 'teaa-runtime-')); t.after(() => rmSync(dir, { force: true, recursive: true })); return dir; };
async function until(fn, ms = 2500) { const start = Date.now(); while (!fn()) { if (Date.now() - start > ms) throw new Error('Fixture condition timed out'); await pause(10); } }
const launch = (mode, env = {}) => ({ command: process.execPath, args: [MCP], env: { RUNTIME_MCP_MODE: mode, ...env } });
const client = (mode) => new McpClient({ name: 'fixture', ...launch(mode), timeoutMs: 1000 });

test('settings reject malformed nested values with useful errors', (t) => {
  const dir = temp(t), file = join(dir, 'config.json');
  for (const [value, expected] of [[{ fleet: null }, /fleet/], [{ mcp: { folder: 23 } }, /mcp.folder/], [{ engine: { args: 'wrong' } }, /engine.args/], [{ mcp: { actor: 4 } }, /actor/], [[], /expected an object/]]) {
    writeFileSync(file, JSON.stringify(value)); assert.throws(() => loadConfig({ file }), expected);
  }
  writeFileSync(file, '{"__proto__":{"polluted":true}}');
  assert.throws(() => loadConfig({ file }), /Unsupported settings key/); assert.equal({}.polluted, undefined);
});
test('Fleet refuses a failed setup instead of fabricating serve argv', (t) => {
  const file = join(temp(t), 'host.js'); writeFileSync(file, 'process.stderr.write("fixture setup required"); process.exit(4)');
  assert.throws(() => fleetServerEntry(file), /fixture setup required/);
});
test('engine workspace follows selected MCP folder, removing old duplicates', () => {
  const cfg = defaults(); cfg.engine.command = 'node'; cfg.engine.args = ['/app/engine.js', '--workspace', '/old', '--workspace=/stale'];
  assert.deepEqual(engineLaunch(cfg, { folder: '/chat' }).args, ['/app/engine.js', '--workspace', '/chat', '--no-browser']);
});
test('Windows shim parsing supports standard forms while shell fallback is refused', (t) => {
  const dir = temp(t), entry = join(dir, 'main.js'); writeFileSync(entry, '');
  for (const prefix of ['%~dp0', '%dp0%\\']) { const file = join(dir, 'command.cmd'); writeFileSync(file, `@node "${prefix}main.js" %*`); assert.equal(shimTarget(file), entry); }
  assert.throws(() => spawnResolved({ file: 'anything.cmd', args: ['%PATH%&echo BAD'], shell: true }), /without a command shell/);
  assert.throws(() => spawnResolvedSync({ file: 'anything.cmd', args: [], shell: true }), /without a command shell/);
});
test('MCP startup is shared, failed initialization never remains healthy', async (t) => {
  const c = client('normal'); t.after(() => c.close()); const a = c.start(), b = c.start(); assert.equal(a, b); await a;
  for (const mode of ['initialize-error', 'bad-protocol', 'repeat-cursor']) {
    const bad = client(mode); await assert.rejects(bad.start()); assert.equal(bad.state, 'failed'); assert.equal(bad.tools.length, 0); await bad.close();
  }
});

test('bundled V5 worker-mode refusal gives TEAA recovery guidance without rewriting external Fleet errors', async (t) => {
  const dir = temp(t), refused = join(dir, 'fleet-workers-required.js');
  writeFileSync(refused, `process.stderr.write('FLEET_V5_WORKERS_REQUIRED: Fleet V5 ordinary lead connections require workers enabled. Re-run Fleet V5 setup without --coordination-only, or use explicit --admin for native administration.'); process.exit(1);`);
  const upstream = { command: process.execPath, args: [refused] };
  const bundled = await probe('Fleet', upstream, undefined, { bundledFleet: true });
  assert.equal(bundled.ok, false);
  assert.match(bundled.detail, /^FLEET_V5_WORKERS_REQUIRED:/);
  assert.match(bundled.detail, /teaa setup --workers/);
  assert.match(bundled.detail, /move it aside without deleting it/i);
  assert.doesNotMatch(bundled.detail, /Re-run Fleet V5 setup without --coordination-only/);

  const external = await probe('Fleet', upstream, undefined, { bundledFleet: false });
  assert.equal(external.ok, false);
  assert.match(external.detail, /Re-run Fleet V5 setup without --coordination-only/);
});
test('closing during initialization rejects pending calls and never becomes ready', async () => {
  const c = client('normal'), started = c.start(); const closed = c.close(); await assert.rejects(started, /closed/); await closed; assert.equal(c.state, 'closed');
});
test('gateway preserves every colliding tool and all upstream annotations/results', async (t) => {
  const gw = new Gateway({ upstreams: [{ key: 'fleet', launch: launch('collision') }] }); t.after(() => gw.close()); await gw.start();
  const names = gw.listTools().filter((tool) => tool.name !== 'teaa_status');
  assert.equal(names.length, 4); assert.equal(new Set(names.map((tool) => tool.name)).size, 4);
  const originals = [];
  for (const tool of names) {
    assert.equal(tool.annotations.title, 'Original title'); assert.equal(tool.annotations.customFlag, 'preserve-me');
    const result = await gw.call(tool.name, { payload: '%! &"' }); originals.push(result.structuredContent.name);
    assert.deepEqual(result.content.filter((c) => !isPresentationItem(c)), [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }]); assert.equal(result._meta.untouched, true);
  }
  assert.equal(new Set(originals).size, 4);
});
test('gateway updates dynamic tools and stops advertising a dead connection', async (t) => {
  const gw = new Gateway({ upstreams: [{ key: 'fleet', launch: launch('normal') }] }); t.after(() => gw.close()); await gw.start();
  await gw.call('fleet_old_tool', { action: 'change' }); await until(() => gw.listTools().some((tool) => tool.name === 'fleet_new_tool'));
  assert.equal(gw.listTools().some((tool) => tool.name === 'fleet_old_tool'), false);
  await gw.call('fleet_new_tool', { action: 'die' }); await until(() => gw.status().upstreams[0].status === 'failed');
  assert.equal(gw.status().upstreams[0].tools, 0); assert.deepEqual(gw.listTools().map((tool) => tool.name), ['teaa_status']);
});
test('gateway forwards cancellation and remaps progress without losing result metadata', async (t) => {
  const log = join(temp(t), 'cancel.log');
  const gw = new Gateway({ upstreams: [{ key: 'fleet', launch: launch('normal', { RUNTIME_MCP_LOG: log }) }] }); t.after(() => gw.close()); await gw.start();
  const progress = once(gw, 'notification'); const result = await gw.call('fleet_old_tool', {}, { meta: { progressToken: 'client-token', privateExtra: 'unchanged' } });
  assert.equal((await progress)[0].params.progressToken, 'client-token'); assert.equal(result.structuredContent.meta.privateExtra, 'unchanged');
  const controller = new AbortController(); const waiting = gw.call('fleet_old_tool', { action: 'wait' }, { signal: controller.signal }); controller.abort();
  assert.equal((await waiting).isError, true); await until(() => existsSync(log)); assert.equal(JSON.parse(readFileSync(log, 'utf8').trim()).method, 'notifications/cancelled');
});
test('stdio gateway handles malformed requests and negotiates supported protocol', async (t) => {
  const input = new PassThrough(), output = new PassThrough(); const gw = new Gateway({ upstreams: [] });
  t.after(() => { input.end(); gw.close(); }); const rows = []; let buf = '';
  output.on('data', (chunk) => { buf += chunk; let i; while ((i = buf.indexOf('\n')) >= 0) { rows.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  await serveStdio(gw, { input, output });
  input.write('null\n'); input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: 'invented' } }) + '\n');
  await until(() => rows.some((row) => row.id === 2));
  assert.equal(rows.find((row) => row.id === null).error.code, -32600); assert.equal(rows.find((row) => row.id === 1).error.code, -32000);
  assert.equal(rows.find((row) => row.id === 2).result.protocolVersion, PROTOCOL_VERSION);
});
test('doctor upstream probe fails disconnected or refused runtimes', async () => {
  assert.equal((await probe('Fleet', null)).ok, false);
  assert.equal((await probe('Fleet', launch('initialize-error'))).ok, false);
  assert.equal((await probe('Fleet', launch('normal'))).ok, true);
});

test('configured upstreams run relative file tools in their selected workspace', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'teaa-runtime-')), cfg = defaults(); cfg.mcp.folder = folder;
  Object.assign(cfg.fleet, launch('normal')); Object.assign(cfg.engine, launch('normal'));
  const gw = new Gateway({ upstreams: [{ key: 'fleet', launch: fleetLaunch(cfg) }, { key: 'engine', launch: engineLaunch(cfg) }] });
  t.after(async () => {
    // Windows retains a child's current directory until the process closes.
    // Keep shutdown and removal in one hook so a removal error cannot skip shutdown.
    gw.close();
    await Promise.all(gw.upstreams.map((u) => u.client?.close()));
    rmSync(folder, { force: true, recursive: true });
  });
  await gw.start();
  for (const name of ['fleet_old_tool', 'engine_old_tool']) assert.equal((await gw.call(name, {})).structuredContent.cwd, folder);
});

test('disabling browser removes mutually exclusive launch settings but preserves file policy', () => {
  const cfg = defaults(); cfg.engine.command = process.execPath;
  cfg.engine.args = ['/engine.js', '--browser-channel', 'chrome', '--profile-dir', '/profile', '--browser-extension', '--no-browser-sandbox', '--plugin-profile', 'openai']; cfg.engine.browser = false;
  assert.deepEqual(engineLaunch(cfg).args, ['/engine.js', '--plugin-profile', 'openai', '--workspace', cfg.mcp.folder, '--no-browser']);
});

test('bundle browser selection uses installed platform channels and refuses missing downloads', (t) => {
  const root = temp(t); mkdirSync(join(root, 'src')); writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  const entry = join(root, 'bin', 'toolsengine.js');
  writeFileSync(join(root, 'src', 'config.js'), 'export function channelExecutable(c){ return "/installed/" + c; }');
  assert.deepEqual(detectBundledBrowser(entry, { platform: 'win32', find: () => null }).args, ['--browser-channel', 'msedge']);
  assert.deepEqual(detectBundledBrowser(entry, { platform: 'linux', find: () => null }).args, ['--browser-channel', 'chrome']);
  writeFileSync(join(root, 'src', 'config.js'), 'export function channelExecutable(){ throw Error("absent"); }');
  assert.throws(() => detectBundledBrowser(entry, { platform: 'win32', find: () => null }), /setup --no-browser/);
  assert.deepEqual(detectBundledBrowser(entry, { platform: 'linux', find: (n) => n === 'chromium' ? '/installed/chromium' : null }).args, ['--browser-executable', '/installed/chromium']);
});
