import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { McpClient, resultText } from '../src/mcp/client.js';
import { Gateway, serveStdio } from '../src/mcp/gateway.js';
import { isPresentationItem, presentationEnabled } from '../src/mcp/presentation.js';
import { isWindows } from '../src/platform.js';

const CATALOG = fileURLToPath(new URL('./fixtures/catalog-mcp.js', import.meta.url));
const TEAA = fileURLToPath(new URL('../bin/teaa.js', import.meta.url));
const launch = (kind, env = {}) => ({ command: process.execPath, args: [CATALOG, '--kind', kind], env });
const HEAD = /^(\S+) (.+)\n(\S+) (.+)$/u;
function heading(text) {
  const match = HEAD.exec(text);
  assert.ok(match, text);
  const lines = text.split('\n');
  assert.equal(lines.length, 2, text);
  assert.ok(lines.every((line) => line.length > 0 && line.length <= 80), text);
  assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text), false, text);
  assert.doesNotMatch(text, /[┌┐└┘│─═╔╗╚╝╭╮╰╯▀▄█]/);
  return { icon: match[1], category: match[2], marker: match[3], phrase: match[4] };
}
const SHAPES = { fleet: 'fleet', engine: 'engine' };

async function gateway(t, options = {}, env = {}) {
  const gw = new Gateway({ upstreams: [{ key: 'fleet', launch: launch('fleet', env) }, { key: 'engine', launch: launch('engine', env) }], ...options });
  t.after(() => gw.close()); await gw.start(); return gw;
}
// The same call made straight to the upstream, without TEAA in between.
async function direct(t, kind, env = {}) {
  const c = new McpClient({ name: kind, ...launch(kind, env) }); t.after(() => c.close()); await c.start(); return c;
}
const withoutLine = (result) => ({ ...result, content: result.content.filter((c) => !isPresentationItem(c)) });

test('every tool, on both upstreams, gets one TEAA line first and byte-identical upstream data after it', async (t) => {
  const gw = await gateway(t), up = { fleet: await direct(t, 'fleet'), engine: await direct(t, 'engine') };
  const tools = gw.listTools();
  assert.equal(tools.length, 49 + 22 + 1);
  const icons = new Set();
  const categories = new Set();
  for (const tool of tools) {
    const result = await gw.call(tool.name, { probe: tool.name });
    const [first, ...rest] = result.content;
    assert.ok(isPresentationItem(first), `${tool.name}: first item is the person-facing line`);
    const h = heading(first.text);
    icons.add(h.icon);
    categories.add(h.category);
    assert.equal(rest.some(isPresentationItem), false);
    if (tool.name === 'teaa_status') { assert.deepEqual(result.structuredContent, gw.status()); assert.equal(rest[0].text, JSON.stringify(gw.status(), null, 2)); continue; }
    const kind = tool.name.startsWith('fleet_') ? 'fleet' : 'engine';
    const original = /^\[\S+ (\S+)\]/.exec(tool.description)[1];
    const raw = await up[SHAPES[kind]].callTool(original, { probe: tool.name });
    assert.equal(JSON.stringify(withoutLine(result)), JSON.stringify(raw), `${tool.name}: upstream result unchanged`);
    if (raw.structuredContent) assert.equal(JSON.stringify(result.structuredContent), JSON.stringify(raw.structuredContent));
    assert.equal(resultText(result), resultText(raw), `${tool.name}: text a parser extracts is unchanged`);
    assert.deepEqual(JSON.parse(resultText({ content: withoutLine(result).content.filter((c) => c.type === 'text') })), JSON.parse(raw.content[0].text));
  }
  assert.ok(icons.size >= 6, `tool families are told apart by icon: ${[...icons].join(' ')}`);
  assert.ok(categories.size >= 6, `tool families are told apart by category: ${[...categories].join(' ')}`);
});

test('the owner example and named families read as plain verb phrases', async (t) => {
  const gw = await gateway(t);
  const line = async (name) => heading((await gw.call(name, {})).content[0].text);
  const saved = await line('fleet_r_ledger_file');
  assert.equal(saved.icon, '⚡');
  assert.equal(saved.category, 'Ledger');
  assert.match(saved.phrase, /rule saved/);
  const fleetFile = await line('fleet_host_write_file'), engineFile = await line('engine_workspace_write_file');
  assert.equal(fleetFile.icon, engineFile.icon, 'file tools share one icon across upstreams');
  assert.equal(fleetFile.category, engineFile.category);
  assert.equal(fleetFile.marker, saved.marker, 'writes share a success marker');
  const task = await line('fleet_task_submit');
  assert.notEqual(task.icon, fleetFile.icon);
  assert.notEqual(task.category, fleetFile.category);
  const browser = await line('engine_browser_navigate'), web = await line('engine_web_fetch');
  assert.notEqual(browser.icon, web.icon);
  assert.notEqual(browser.category, web.category);
  for (const name of ['fleet_brand_new_tool', 'engine_browser_hover']) heading((await gw.call(name, {})).content[0].text);
  for (const tool of gw.listTools()) assert.doesNotMatch((await gw.call(tool.name, {})).content[0].text, /claude|codex|openai|anthropic|approve|permission|system:/i);
});

test('every Fleet V2 tool reads as its own plain phrase, never a raw function name', async (t) => {
  const gw = await gateway(t);
  const lines = new Map();
  for (const tool of gw.listTools().filter((x) => x.name.startsWith('fleet_') && x.name !== 'fleet_brand_new_tool')) {
    const original = /^\[\S+ (\S+)\]/.exec(tool.description)[1];
    const text = (await gw.call(tool.name, {})).content[0].text;
    assert.doesNotMatch(text, /[._]|step done$/, `${original}: ${text} (not a raw name or a family fallback)`);
    assert.doesNotMatch(tool.annotations.title, /[._]/, `${original} title: ${tool.annotations.title}`);
    lines.set(original, text);
  }
  assert.equal(lines.size, 48);
  const spawned = heading(lines.get('agent.spawn'));
  const sent = heading(lines.get('agent_comms.send_local'));
  const verified = heading(lines.get('audit.verify'));
  assert.equal(spawned.icon, '🤖');
  assert.match(spawned.phrase, /worker started/);
  assert.equal(sent.icon, '💬');
  assert.match(sent.phrase, /message sent/);
  assert.equal(verified.icon, '🧾');
  assert.match(verified.phrase, /audit log verified/);
  assert.equal(spawned.marker, sent.marker, 'writes share a success marker');
  assert.notEqual(verified.marker, spawned.marker, 'a verify receipt is not a success write');
  const icon = (name) => heading(lines.get(name)).icon;
  const category = (name) => heading(lines.get(name)).category;
  for (const [a, b] of [['agent.spawn', 'task.submit'], ['agent_comms.send_local', 'agent.spawn'], ['audit.tail', 'system.status'], ['fleet.control', 'agent.stop']]) {
    assert.notEqual(icon(a), icon(b), `${a} and ${b} are different families`);
    assert.notEqual(category(a), category(b), `${a} and ${b} are different categories`);
  }
});

test('fleet.control says what its action did, and an error never claims it', async (t) => {
  const gw = await gateway(t);
  const line = async (args) => heading((await gw.call('fleet_fleet_control', args)).content[0].text);
  const progress = await line({ action: 'progress', text: 'halfway' });
  const rule = await line({ action: 'rule', id: 'r1', text: 'x' });
  const read = await line({ action: 'read' });
  assert.equal(progress.icon, '🎛️');
  assert.equal(progress.category, 'Control');
  assert.equal(rule.category, progress.category);
  assert.equal(read.category, progress.category);
  assert.match(progress.phrase, /progress reported/);
  assert.match(rule.phrase, /rule saved/);
  assert.match(read.phrase, /assignment read/);
  assert.equal(progress.phrase.includes('halfway'), false);
  assert.equal(rule.marker, progress.marker);
  assert.notEqual(read.marker, progress.marker, 'a read receipt is not a successful write');
  for (const args of [{}, { action: 'something-new' }, { action: '__proto__' }, { action: 7 }]) {
    const answered = await line(args);
    assert.match(answered.phrase, /Fleet control answered/, JSON.stringify(args));
    assert.equal(answered.marker, progress.marker, JSON.stringify(args));
  }
  const failing = await gateway(t, {}, { CATALOG_FAIL: 'fleet.control' });
  const failed = heading((await failing.call('fleet_fleet_control', { action: 'complete', text: 'done' })).content[0].text);
  assert.match(failed.phrase, /couldn't report task completion/);
  assert.equal(failed.phrase.includes('done'), false);
  assert.notEqual(failed.marker, progress.marker);
  assert.notEqual(failed.marker, read.marker);
});

test('an agent that reads underscore tool names gets the same lines', async (t) => {
  const gw = new Gateway({ upstreams: [{ key: 'fleet', launch: { command: process.execPath, args: [CATALOG, '--kind', 'fleet', '--names', 'underscore'] } }] });
  t.after(() => gw.close()); await gw.start();
  const line = async (name) => heading((await gw.call(name, {})).content[0].text);
  const listed = await line('fleet_task_list');
  const saved = await line('fleet_r_ledger_file');
  const spawned = await line('fleet_agent_spawn');
  const control = await line('fleet_fleet_control');
  assert.equal(listed.icon, '📋');
  assert.match(listed.phrase, /tasks listed/);
  assert.equal(saved.icon, '⚡');
  assert.match(saved.phrase, /rule saved/);
  assert.equal(spawned.icon, '🤖');
  assert.match(spawned.phrase, /worker started/);
  assert.equal(control.icon, '🎛️');
  assert.match(control.phrase, /Fleet control answered/);
  assert.notEqual(listed.marker, saved.marker, 'a list is not a successful write');
  assert.equal(spawned.marker, saved.marker);
});

test('errors keep isError and their text, with a line that does not claim success', async (t) => {
  const gw = await gateway(t, {}, { CATALOG_FAIL: 'r_ledger.file' });
  const result = await gw.call('fleet_r_ledger_file', {});
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /saved/);
  const failedLine = heading(result.content[0].text);
  assert.match(failedLine.phrase, /couldn't/);
  assert.deepEqual(withoutLine(result).content, [{ type: 'text', text: 'r_ledger.file refused: fixture' }]);
  const dead = await gateway(t);
  dead.upstreams[0].client.callTool = async () => { throw new Error('connection lost'); };
  const failed = await dead.call('fleet_task_list', {});
  assert.equal(failed.isError, true);
  heading(failed.content[0].text);
  assert.match(failed.content[0].text, /couldn't/);
  assert.match(resultText(failed), /connection lost/);
});

test('switch off returns the upstream result exactly; bad switch values are refused by name', async (t) => {
  for (const [value, on] of [[undefined, true], ['on', true], ['1', true], ['off', false], ['0', false], ['FALSE', false], [' no ', false]]) assert.equal(presentationEnabled(value === undefined ? {} : { TEAA_PRESENTATION: value }), on, String(value));
  assert.throws(() => presentationEnabled({ TEAA_PRESENTATION: 'sparkly' }), /TEAA_PRESENTATION/);
  const off = await gateway(t, { presentation: false }), up = await direct(t, 'fleet');
  for (const name of ['fleet_r_ledger_file', 'teaa_status', 'engine_workspace_read_file']) assert.equal((await off.call(name, {})).content.some(isPresentationItem), false);
  assert.equal(JSON.stringify(await off.call('fleet_r_ledger_file', { a: 1 })), JSON.stringify(await up.callTool('r_ledger.file', { a: 1 })));
});

function writeConfig(dir) {
  const p = isWindows ? join(dir, 'appdata', 'ToolsEnabled', 'toolsenabled-agent-kit') : join(dir, 'cfg', 'toolsenabled-agent-kit');
  mkdirSync(p, { recursive: true }); mkdirSync(join(dir, 'work'));
  writeFileSync(join(p, 'config.json'), JSON.stringify({ fleet: { command: process.execPath, args: [CATALOG, '--kind', 'fleet'] }, engine: { command: process.execPath, args: [CATALOG, '--kind', 'engine'] }, mcp: { folder: join(dir, 'work') } }));
}
// One real `teaa mcp` process: initialize, then call one tool; resolves the reply or the exit.
function teaaCall(dir, env, name) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TEAA, 'mcp'], { env: { ...process.env, XDG_CONFIG_HOME: join(dir, 'cfg'), XDG_DATA_HOME: join(dir, 'data'), APPDATA: join(dir, 'appdata'), LOCALAPPDATA: join(dir, 'local'), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('teaa mcp timed out')); }, 10000);
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => {
      out += d; const rows = out.split('\n').filter(Boolean).map((l) => JSON.parse(l)); const reply = rows.find((r) => r.id === 2);
      if (reply) { clearTimeout(timer); child.stdin.end(); child.kill(); resolve({ reply }); }
    });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stderr: err }); });
    const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: {} } });
  });
}
test('the installed command honours TEAA_PRESENTATION', { timeout: 30000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'teaa-presentation-')); t.after(() => rmSync(dir, { recursive: true, force: true })); writeConfig(dir);
  const on = await teaaCall(dir, { TEAA_PRESENTATION: undefined }, 'fleet_r_ledger_file');
  const onHead = heading(on.reply.result.content[0].text);
  assert.equal(onHead.icon, '⚡');
  assert.equal(onHead.category, 'Ledger');
  assert.match(onHead.phrase, /rule saved/);
  const off = await teaaCall(dir, { TEAA_PRESENTATION: 'off' }, 'fleet_r_ledger_file');
  assert.equal(off.reply.result.content.some(isPresentationItem), false); assert.ok(off.reply.result.structuredContent);
  const bad = await teaaCall(dir, { TEAA_PRESENTATION: 'maybe' }, 'fleet_r_ledger_file');
  assert.notEqual(bad.code, 0); assert.match(bad.stderr, /TEAA_PRESENTATION must be on or off/);
});

async function listOver(t, protocolVersion) {
  const gw = await gateway(t), input = new PassThrough(), output = new PassThrough(), rows = [];
  output.setEncoding('utf8'); let buf = '';
  output.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { rows.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  await serveStdio(gw, { input, output });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  const start = Date.now(); while (!rows.some((r) => r.id === 2)) { if (Date.now() - start > 5000) throw new Error('no tools/list reply'); await new Promise((r) => setTimeout(r, 10)); }
  t.after(() => input.end());
  return { init: rows.find((r) => r.id === 1).result, tools: rows.find((r) => r.id === 2).result.tools };
}
test('titles: every tool has a human title, annotations.title only where the negotiated protocol defines it, no icons field', async (t) => {
  for (const version of ['2025-06-18', '2025-03-26']) {
    const { init, tools } = await listOver(t, version);
    assert.equal(init.protocolVersion, version);
    for (const tool of tools) {
      assert.equal(typeof tool.title, 'string'); assert.equal(typeof tool.annotations?.title, 'string', `${version} ${tool.name}`);
      assert.ok(tool.annotations.title.length > 0 && !/[._]/.test(tool.annotations.title.split(' ')[0]), `${tool.name}: ${tool.annotations.title} reads as words`);
      assert.equal('icons' in tool, false, 'icons are not defined before protocol 2025-11-25');
    }
    assert.equal('icons' in init.serverInfo, false);
    const engine = tools.find((x) => x.name === 'engine_web_fetch');
    assert.equal(engine.annotations.title, 'Engine web.fetch', 'an upstream title is kept');
  }
  const old = await listOver(t, '2024-11-05');
  const fleet = old.tools.find((x) => x.name === 'fleet_r_ledger_file');
  assert.equal(fleet.annotations.title, undefined, '2024-11-05 has no tool annotations, so none are invented');
  assert.deepEqual(fleet.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
});
