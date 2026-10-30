import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { Gateway, serveStdio } from '../src/mcp/gateway.js';
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOLS, protocolHasIcons } from '../src/mcp/client.js';
import { callState, describe, isPresentationItem, lightningSvg, present, presentationLine, serverIcons, toolIcons } from '../src/mcp/presentation.js';
import { isWindows } from '../src/platform.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CATALOG = fileURLToPath(new URL('./fixtures/catalog-mcp.js', import.meta.url));
const TEAA = join(ROOT, 'bin', 'teaa.js');
const PREVIEW = join(ROOT, 'preview');
const HEAD = /^(\S+) (\S+)\n(\S+) (.+)$/u;
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
const ARGUMENT_MARKER = 'argument-marker';

function launch(kind) {
  return { command: process.execPath, args: [CATALOG, '--kind', kind] };
}
function gateway(t) {
  const gw = new Gateway({ upstreams: [{ key: 'fleet', launch: launch('fleet') }, { key: 'engine', launch: launch('engine') }] });
  t.after(() => gw.close());
  return gw.start().then(() => gw);
}
function esc(value) {
  return String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

test('older protocols stay negotiable and icons stay on 2025-11-25', () => {
  assert.equal(PROTOCOL_VERSION, '2025-06-18');
  for (const version of ['2025-06-18', '2025-03-26', '2024-11-05', '2025-11-25']) assert.equal(SUPPORTED_PROTOCOLS.includes(version), true, version);
  assert.equal(protocolHasIcons('2025-11-25'), true);
  for (const version of ['2025-06-18', '2025-03-26', '2024-11-05', '1999-01-01', '']) assert.equal(protocolHasIcons(version), false, version);
});

test('a call failure is not told as success, and a recorded task failure stays a recording', () => {
  const saved = presentationLine('fleet', 'r_ledger.file', {});
  const failed = presentationLine('fleet', 'r_ledger.file', {
    isError: true,
    result: { isError: true, structuredContent: { status: 'completed', assessment: { decision: 'accepted' } } },
  });
  assert.notEqual(failed, saved);
  assert.match(failed, /couldn't/);
  assert.doesNotMatch(failed, /saved|accepted|completed/);
  const refused = presentationLine('fleet', 'r_ledger.file', { result: { ok: false, structuredContent: { status: 'refused' } } });
  assert.match(refused, /couldn't/);
  assert.doesNotMatch(refused, /saved|accepted/);
  const complete = presentationLine('fleet', 'task.complete', {});
  const completeFailed = presentationLine('fleet', 'task.complete', { result: { structuredContent: { status: 'failed' } } });
  assert.notEqual(completeFailed, complete);
  assert.match(completeFailed, /couldn't/);
  assert.doesNotMatch(completeFailed, /completed|accepted/);
  const recorded = presentationLine('fleet', 'task.fail', { result: { structuredContent: { status: 'failed', disposition: 'failed' } } });
  assert.equal(recorded, presentationLine('fleet', 'task.fail', {}));
  assert.equal(callState({ structuredContent: { status: 'failed' } }, { name: 'task.fail' }), 'ok');
  assert.doesNotMatch(recorded, /couldn't|accepted/);
  const objectError = presentationLine('fleet', 'r_ledger.file', { result: { error: { code: 'EXAMPLE_FAILURE', message: 'Example failure' } } });
  assert.equal(callState({ error: { code: 'EXAMPLE_FAILURE', message: 'Example failure' } }), 'error');
  assert.equal(callState({ error: { code: 12 } }), 'error');
  assert.equal(callState({ structuredContent: { error: { message: 'Example failure' } } }), 'error');
  assert.notEqual(objectError, saved);
  assert.equal(heading(objectError).marker, heading(failed).marker);
  assert.match(objectError, /couldn't/);
  assert.equal(objectError.includes('EXAMPLE_FAILURE'), false);
  assert.equal(objectError.includes('Example failure'), false);
  const stringError = presentationLine('fleet', 'host.write_file', { result: { error: 'disk full' } });
  assert.match(stringError, /couldn't/);
  assert.equal(stringError.includes('disk full'), false);
  const failedRecord = presentationLine('fleet', 'task.fail', { result: { status: 'failed', error: { code: 'EXAMPLE_FAILURE', message: 'Example failure' } } });
  assert.notEqual(failedRecord, recorded);
  assert.match(failedRecord, /couldn't/);
  assert.equal(failedRecord.includes('EXAMPLE_FAILURE'), false);
  const completed = presentationLine('fleet', 'task.complete', { result: { structuredContent: { status: 'completed' } } });
  assert.equal(completed, complete);
  assert.equal(heading(completed).marker, heading(saved).marker);
});

test('waiting, held, queued and a no-op stop do not use the finished line', () => {
  const finished = presentationLine('fleet', 'agent.wait', {});
  const waiting = presentationLine('fleet', 'agent.wait', { result: { structuredContent: { ok: true, timedOut: true, activeTurns: 2 } } });
  assert.notEqual(waiting, finished);
  assert.match(waiting, /wait/i);
  assert.doesNotMatch(waiting, /collected|accepted/);
  const pending = presentationLine('fleet', 'agent.set_speed', { result: { structuredContent: { status: 'pending', when: 'next-turn' } } });
  assert.notEqual(pending, presentationLine('fleet', 'agent.set_speed', {}));
  assert.match(pending, /waiting|pending/i);
  const held = presentationLine('fleet', 'fleet.control', { args: { action: 'hold' }, result: { structuredContent: { status: 'held' } } });
  assert.match(held, /held/i);
  assert.doesNotMatch(held, /completed|accepted|saved/);
  const queued = presentationLine('fleet', 'task.claim', { result: { structuredContent: { status: 'queued' } } });
  assert.notEqual(queued, presentationLine('fleet', 'task.claim', {}));
  assert.match(queued, /queued/i);
  assert.doesNotMatch(queued, /accepted|completed/);
  const stopped = presentationLine('fleet', 'agent.stop', {});
  const didStop = presentationLine('fleet', 'agent.stop', { result: { structuredContent: { stopped: true, action: 'stop-node' } } });
  const noop = presentationLine('fleet', 'agent.stop', { result: { structuredContent: { stopped: false, alreadyStopped: true } } });
  assert.equal(didStop, stopped);
  assert.equal(didStop.includes('stop-node'), false);
  assert.notEqual(noop, stopped);
  assert.match(noop, /no change|already/i);
  assert.doesNotMatch(noop, /couldn't/);
  assert.notEqual(heading(noop).marker, heading(stopped).marker);
  assert.notEqual(heading(waiting).marker, heading(finished).marker);
  assert.notEqual(heading(held).marker, heading(queued).marker);
  assert.notEqual(heading(waiting).marker, heading(held).marker);
  const life = presentationLine('fleet', 'lifecycle.pause', { result: { structuredContent: { lifecycle: { noop: true } } } });
  assert.notEqual(life, presentationLine('fleet', 'lifecycle.pause', {}));
  assert.match(life, /no change/i);
  assert.equal(heading(life).marker, heading(noop).marker);
  for (const line of [waiting, pending, held, queued, noop, stopped, didStop, life]) heading(line);
});

test('a reported completion is not an accepted assessment', () => {
  const reported = presentationLine('fleet', 'fleet.control', {
    args: { action: 'complete', text: ARGUMENT_MARKER },
    result: { structuredContent: { status: 'completed', assessment: { decision: 'unassessed' } } },
  });
  assert.equal(reported, presentationLine('fleet', 'fleet.control', { args: { action: 'complete' } }));
  assert.doesNotMatch(reported, /\baccepted\b/);
  assert.equal(reported.includes(ARGUMENT_MARKER), false);
  assert.notEqual(heading(reported).marker, heading(presentationLine('fleet', 'r_ledger.file', {})).marker);
  assert.notEqual(heading(reported).marker, heading(presentationLine('fleet', 'ledger.read', {})).marker);
  const accepted = presentationLine('fleet', 'fleet.control', {
    args: { action: 'assess', note: ARGUMENT_MARKER },
    result: { structuredContent: { assessment: { decision: 'accepted', note: ARGUMENT_MARKER } } },
  });
  assert.match(accepted, /\baccepted\b/);
  assert.doesNotMatch(accepted, /couldn't/);
  assert.equal(accepted.includes(ARGUMENT_MARKER), false);
  assert.notEqual(heading(accepted).marker, heading(reported).marker);
  const rework = presentationLine('fleet', 'fleet.control', { args: { action: 'assess' }, result: { structuredContent: { assessment: { decision: 'rework' } } } });
  assert.match(rework, /rework/);
  assert.doesNotMatch(rework, /\baccepted\b/);
  assert.notEqual(rework, accepted);
  const declined = presentationLine('fleet', 'fleet.control', { args: { action: 'assess' }, result: { structuredContent: { assessment: { decision: 'rejected' } } } });
  assert.match(declined, /not accepted/);
  assert.notEqual(declined, accepted);
  const rejected = presentationLine('fleet', 'fleet.control', { args: { action: 'assess' }, result: { isError: true, structuredContent: { assessment: { decision: 'accepted' } } } });
  assert.match(rejected, /couldn't/);
  assert.doesNotMatch(rejected, /\baccepted\b/);
});

test('the header drops argument values and leaves upstream bytes where they were', () => {
  const upstream = {
    isError: false,
    content: [{ type: 'text', text: `body ${ARGUMENT_MARKER}` }, { type: 'image', data: 'qq', mimeType: 'image/png' }],
    structuredContent: { n: 1, note: ARGUMENT_MARKER },
    _meta: { fixture: 'fleet' },
  };
  const out = present(upstream, 'fleet', 'host.write_file', 'Fleet', { path: 'note.txt', content: ARGUMENT_MARKER });
  assert.equal(out.content[0].text.includes(ARGUMENT_MARKER), false);
  assert.ok(isPresentationItem(out.content[0]));
  assert.equal(out.content.filter(isPresentationItem).length, 1);
  assert.deepEqual(out.content.slice(1), upstream.content);
  assert.equal(out.isError, false);
  assert.deepEqual(out.structuredContent, upstream.structuredContent);
  assert.deepEqual(out._meta, upstream._meta);
  assert.equal(JSON.stringify(out).includes('\u001b'), false);
});

test('Fleet V4 result, assessment, account and lifecycle names stay distinct', () => {
  const names = [
    ['result.record', 'result_record', 'result'],
    ['assessment.record', 'assessment_record', 'assessment'],
    ['account.status', 'account_status', 'account'],
    ['lifecycle.pause', 'lifecycle_pause', 'lifecycle'],
  ];
  const families = new Set();
  const icons = new Set();
  for (const [dotted, underscored, family] of names) {
    for (const name of [dotted, underscored]) {
      const described = describe('fleet', name);
      assert.equal(described.family, family, name);
      assert.match(presentationLine('fleet', name, {}), new RegExp(family, 'i'));
      assert.equal(presentationLine('fleet', name, {}).includes(ARGUMENT_MARKER), false);
    }
    families.add(family);
    icons.add(describe('fleet', dotted).icon);
  }
  assert.equal(families.size, 4);
  assert.equal(icons.size, 4);
  const unknown = presentationLine('fleet', 'brand_new.tool', { label: 'Fleet' });
  assert.match(unknown, /brand_new\.tool/);
  const unknownHead = heading(unknown);
  assert.equal(unknownHead.category, 'Tool');
  const read = heading(presentationLine('fleet', 'ledger.read', {}));
  const write = heading(presentationLine('fleet', 'r_ledger.file', {}));
  assert.notEqual(read.marker, write.marker);
  assert.match(read.phrase, /read/);
  assert.match(write.phrase, /saved/);
  assert.equal(heading(presentationLine('fleet', 'account.status', {})).marker, read.marker);
});

test('icon metadata is inline SVG with no network, font, script or control codes', () => {
  const seen = new Set();
  for (const family of ['teaa', 'ledger', 'files', 'browser', 'result', 'assessment', 'account', 'lifecycle', 'nope']) {
    const [icon] = toolIcons(family);
    assert.equal(icon.mimeType, 'image/svg+xml');
    assert.deepEqual(icon.sizes, ['any']);
    assert.equal(Object.hasOwn(icon, 'theme'), false);
    assert.match(icon.src, /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/);
    const svg = Buffer.from(icon.src.slice(icon.src.indexOf(',') + 1), 'base64').toString('utf8');
    assert.equal(svg, lightningSvg());
    assert.equal(svg, lightningSvg(family));
    assert.match(svg, /#245eb5/);
    assert.match(svg, /#e0b33a/);
    assert.equal((svg.match(/<rect\b/g) || []).length, 1);
    assert.doesNotMatch(svg, /y="20"/);
    assert.deepEqual(svg.match(/https?:\/\/[^"'\s)]+/g), ['http://www.w3.org/2000/svg']);
    assert.doesNotMatch(svg, /<script|href=|foreignObject|@import|url\(/i);
    assert.equal(/[\u0000-\u001f\u007f]/.test(svg), false);
    seen.add(icon.src);
  }
  assert.equal(seen.size, 1);
  assert.equal(serverIcons()[0].src, toolIcons('teaa')[0].src);
  assert.equal(JSON.stringify(serverIcons()).includes('\u001b'), false);
});

async function session(t, protocolVersion) {
  const gw = await gateway(t);
  const input = new PassThrough();
  const output = new PassThrough();
  const rows = [];
  let buf = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      rows.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  await serveStdio(gw, { input, output });
  const send = (msg) => input.write(JSON.stringify(msg) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fleet_r_ledger_file', arguments: { content: ARGUMENT_MARKER } } });
  const start = Date.now();
  while (!rows.some((row) => row.id === 3)) {
    if (Date.now() - start > 8000) throw new Error(`no call reply for ${protocolVersion}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  t.after(() => input.end());
  return {
    init: rows.find((row) => row.id === 1).result,
    tools: rows.find((row) => row.id === 2).result.tools,
    call: rows.find((row) => row.id === 3).result,
  };
}

test('stdio negotiation carries icons and headers only on 2025-11-25', async (t) => {
  const modern = await session(t, '2025-11-25');
  const current = await session(t, '2025-06-18');
  const oldest = await session(t, '2024-11-05');
  assert.equal(modern.init.protocolVersion, '2025-11-25');
  assert.equal(modern.init.serverInfo.icons[0].src, serverIcons()[0].src);
  assert.equal(current.init.protocolVersion, '2025-06-18');
  assert.equal('icons' in current.init.serverInfo, false);
  assert.equal(oldest.init.protocolVersion, '2024-11-05');
  assert.equal('icons' in oldest.init.serverInfo, false);
  const modernTool = modern.tools.find((tool) => tool.name === 'fleet_r_ledger_file');
  const currentTool = current.tools.find((tool) => tool.name === 'fleet_r_ledger_file');
  assert.equal(modernTool.icons[0].mimeType, 'image/svg+xml');
  assert.equal(modernTool.annotations.readOnlyHint, true);
  assert.equal('icons' in currentTool, false);
  assert.equal(currentTool.annotations.title.length > 0, true);
  assert.equal('icons' in oldest.tools.find((tool) => tool.name === 'teaa_status'), false);
  assert.equal(oldest.tools.find((tool) => tool.name === 'fleet_r_ledger_file').annotations.title, undefined);
  const engine = modern.tools.find((tool) => tool.name === 'engine_web_fetch');
  assert.equal(engine.annotations.title, 'Engine web.fetch');
  assert.equal(engine.annotations.openWorldHint, false);
  for (const tool of modern.tools) assert.equal(tool.icons.length, 1, tool.name);
  for (const tool of current.tools) assert.equal('icons' in tool, false, tool.name);
  assert.equal(modern.call.content[0].text.includes(ARGUMENT_MARKER), false);
  assert.equal(modern.call.isError, undefined);
  assert.equal(modern.call.structuredContent.args.content, ARGUMENT_MARKER);
  assert.deepEqual(modern.call.content.slice(1), current.call.content.slice(1));
  assert.deepEqual(modern.call._meta, current.call._meta);
  const sample = {
    note: 'Actual stdio replies from the local gateway and catalog fixture. Not a host screenshot.',
    cap: 'initialize, one fleet tool, teaa_status, and one tools/call per protocol',
    protocols: {
      '2025-11-25': { initialize: modern.init, tool: modernTool, status: modern.tools.find((tool) => tool.name === 'teaa_status'), call: modern.call },
      '2025-06-18': { initialize: current.init, tool: currentTool, call: current.call },
      '2024-11-05': { initialize: oldest.init, tool: oldest.tools.find((tool) => tool.name === 'fleet_r_ledger_file'), call: oldest.call },
    },
  };
  mkdirSync(PREVIEW, { recursive: true });
  const redacted = JSON.stringify(sample, null, 2).split(ARGUMENT_MARKER).join('<argument>');
  writeFileSync(join(PREVIEW, 'wire-samples.json'), redacted + '\n');
  const saved = readFileSync(join(PREVIEW, 'wire-samples.json'), 'utf8');
  assert.equal(saved.includes(ARGUMENT_MARKER), false);
  assert.equal(saved.includes('<argument>'), true);
  assert.equal(saved.includes('\u001b'), false);
});

function writeConfig(dir) {
  const path = isWindows ? join(dir, 'appdata', 'ToolsEnabled', 'toolsenabled-agent-kit') : join(dir, 'cfg', 'toolsenabled-agent-kit');
  mkdirSync(path, { recursive: true });
  mkdirSync(join(dir, 'work'));
  writeFileSync(join(path, 'config.json'), JSON.stringify({
    fleet: { command: process.execPath, args: [CATALOG, '--kind', 'fleet'] },
    engine: { command: process.execPath, args: [CATALOG, '--kind', 'engine'] },
    mcp: { folder: join(dir, 'work') },
  }));
}

function packaged(dir, protocolVersion) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TEAA, 'mcp'], {
      env: { ...process.env, XDG_CONFIG_HOME: join(dir, 'cfg'), XDG_DATA_HOME: join(dir, 'data'), APPDATA: join(dir, 'appdata'), LOCALAPPDATA: join(dir, 'local') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let rows = [];
    let gotResult = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error(`packaged mcp timed out for ${protocolVersion}: ${err}`)); }, 10000);
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.stdout.on('data', (chunk) => {
      out += chunk;
      rows = out.split('\n').filter(Boolean).map((line) => JSON.parse(line));
      if (!gotResult && rows.some((row) => row.id === 3)) {
        gotResult = true;
        child.stdin.end();
      }
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (gotResult) resolve(rows);
      else reject(new Error(err || 'mcp exited before the call'));
    });
    const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fleet_ledger_read', arguments: {} } });
  });
}

test('the packaged mcp command speaks both protocol generations', { timeout: 30000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'teaa-style-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeConfig(dir);
  const modern = await packaged(dir, '2025-11-25');
  const oldest = await packaged(dir, '2024-11-05');
  const modernInit = modern.find((row) => row.id === 1).result;
  const oldestInit = oldest.find((row) => row.id === 1).result;
  assert.equal(modernInit.protocolVersion, '2025-11-25');
  assert.equal(modernInit.serverInfo.icons[0].src, serverIcons()[0].src);
  assert.equal(oldestInit.protocolVersion, '2024-11-05');
  assert.equal('icons' in oldestInit.serverInfo, false);
  const modernTools = modern.find((row) => row.id === 2).result.tools;
  const oldestTools = oldest.find((row) => row.id === 2).result.tools;
  assert.equal(modernTools.every((tool) => tool.icons?.[0]?.mimeType === 'image/svg+xml'), true);
  assert.equal(oldestTools.some((tool) => 'icons' in tool), false);
  const modernCall = modern.find((row) => row.id === 3).result;
  const oldestCall = oldest.find((row) => row.id === 3).result;
  heading(modernCall.content[0].text);
  assert.match(modernCall.content[0].text, /Ledger/);
  assert.match(modernCall.content[0].text, /read/);
  assert.deepEqual(modernCall.content.slice(1), oldestCall.content.slice(1));
  assert.deepEqual(modernCall.structuredContent, oldestCall.structuredContent);
  const receipt = { note: 'Stdout replies from bin/teaa.js mcp against the catalog fixture.', modern: { initialize: modernInit, call: modernCall }, oldest: { initialize: oldestInit, call: oldestCall } };
  writeFileSync(join(PREVIEW, 'packaged-mcp.json'), JSON.stringify(receipt, null, 2) + '\n');
});

test('the contact sheet is built from the generated lines and icons', () => {
  const rows = [
    ['success', presentationLine('fleet', 'r_ledger.file', {}), 'ledger'],
    ['informational', presentationLine('fleet', 'fleet.control', { args: { action: 'read' } }), 'control'],
    ['waiting', presentationLine('fleet', 'agent.wait', { result: { structuredContent: { ok: true, timedOut: true } } }), 'agents'],
    ['held', presentationLine('fleet', 'fleet.control', { args: { action: 'hold' }, result: { structuredContent: { status: 'held' } } }), 'control'],
    ['queued', presentationLine('fleet', 'task.submit', { result: { structuredContent: { status: 'queued' } } }), 'tasks'],
    ['error', presentationLine('fleet', 'r_ledger.file', { isError: true }), 'ledger'],
    ['object error', presentationLine('fleet', 'host.write_file', { result: { error: { code: 'EXAMPLE_FAILURE', message: 'Example failure' } } }), 'files'],
    ['noop', presentationLine('fleet', 'agent.stop', { result: { structuredContent: { stopped: false, alreadyStopped: true } } }), 'agents'],
    ['reported', presentationLine('fleet', 'fleet.control', { args: { action: 'complete' }, result: { structuredContent: { status: 'completed', assessment: { decision: 'unassessed' } } } }), 'control'],
    ['accepted', presentationLine('fleet', 'fleet.control', { args: { action: 'assess' }, result: { structuredContent: { assessment: { decision: 'accepted' } } } }), 'control'],
    ['result', presentationLine('fleet', 'result.record', {}), 'result'],
    ['assessment', presentationLine('fleet', 'assessment.record', {}), 'assessment'],
    ['account', presentationLine('fleet', 'account.status', {}), 'account'],
    ['lifecycle', presentationLine('fleet', 'lifecycle.pause', {}), 'lifecycle'],
  ];
  const tone = { success: '#1f7a4d', informational: '#245eb5', waiting: '#8a6a12', held: '#8a6a12', queued: '#8a6a12', error: '#8d3b3b', 'object error': '#8d3b3b', noop: '#5c6b7a', reported: '#e0b33a', accepted: '#1f7a4d', result: '#245eb5', assessment: '#245eb5', account: '#245eb5', lifecycle: '#245eb5' };
  const cards = rows.map(([state, text, family]) => {
    const svg = lightningSvg(family);
    return `<figure><figcaption>${esc(state)}</figcaption>${svg}<p style="color:${tone[state]}">${esc(text)}</p></figure>`;
  }).join('\n');
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>TEAA tool-call preview</title><style>
body{margin:24px;background:#f4f1ea;color:#1c2430;font:14px/1.4 ui-sans-serif,sans-serif}
h1{font-size:20px;font-weight:650;letter-spacing:.01em;margin:0 0 8px}
p.note{max-width:62ch;margin:0 0 20px}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
figure{margin:0;padding:12px 14px;background:#fff;border-radius:8px}
figcaption{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5c6b7a;margin-bottom:8px}
svg{width:28px;height:28px;display:block;margin-bottom:8px}
p{margin:0;font-variant-ligatures:none;white-space:pre-wrap}
</style></head><body>
<h1>Simulated tool-call sheet</h1>
<p class="note">Simulated view of the generated two-line headers and the one inline SVG icon. This is not a screenshot of Claude or any other host. The colors on this page are local CSS. The MCP messages do not contain ANSI color, and a host may ignore the SVG colors.</p>
<main>${cards}</main>
</body></html>\n`;
  mkdirSync(PREVIEW, { recursive: true });
  writeFileSync(join(PREVIEW, 'contact-sheet.html'), html);
  const saved = readFileSync(join(PREVIEW, 'contact-sheet.html'), 'utf8');
  assert.match(saved, /Simulated view/);
  assert.match(saved, /not a screenshot/i);
  assert.match(saved, /#245eb5/);
  assert.match(saved, /#e0b33a/);
  for (const [, text] of rows) assert.equal(saved.includes(text), true, text);
  assert.equal(saved.includes('\u001b'), false);
  assert.equal(saved.includes('EXAMPLE_FAILURE'), false);
  assert.equal(saved.includes('Example failure'), false);
});
