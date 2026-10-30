#!/usr/bin/env node
// Stdio MCP fixture advertising the real Fleet V2 2.0.0-alpha.4 / ToolsEngine 0.1.9-rc.1 tool names.
// --names underscore advertises Fleet names the way an underscore-reading agent sees them (task_list).
// Fleet-shaped results carry structuredContent plus JSON text; ToolsEngine-shaped results are JSON text only.
// CATALOG_FAIL=name makes that tool answer isError. No network or provider calls.
import { createInterface } from 'node:readline';
const kind = process.argv[process.argv.indexOf('--kind') + 1];
const underscore = process.argv.includes('--names') && process.argv[process.argv.indexOf('--names') + 1] === 'underscore';
const LISTED = {
  // Fleet V2 2.0.0-alpha.4 with workers on (48 tools), plus one name TEAA has never seen.
  fleet: ['a_ledger.file', 'agent.continue', 'agent.remove', 'agent.restart', 'agent.resume', 'agent.set_effort', 'agent.set_model',
    'agent.set_provider', 'agent.set_role', 'agent.set_speed', 'agent.spawn', 'agent.stop', 'agent.wait', 'agent_comms.local_roster',
    'agent_comms.send_local', 'audit.status', 'audit.tail', 'audit.verify', 'capability.find', 'fleet.control', 'host.list_dir',
    'host.patch_file', 'host.read_file', 'host.write_file', 'ledger.read', 'memory.get', 'memory.search', 'memory.set', 'r_ledger.file',
    'search.index', 'search.query', 'search.status', 'settings.read', 'system.doctor', 'system.status', 't_ledger.complete',
    't_ledger.file', 't_ledger.progress', 'task.cancel', 'task.checkpoint', 'task.claim', 'task.complete', 'task.fail', 'task.get',
    'task.heartbeat', 'task.list', 'task.start', 'task.submit', 'brand_new.tool'],
  engine: ['capability.find', 'system.status', 'web.extract', 'web.fetch', 'workspace.list', 'workspace.read_file', 'workspace.search',
    'workspace.write_file', 'browser.windows', 'browser.snapshot', 'browser.tabs', 'browser.navigate', 'browser.navigate_back',
    'browser.click', 'browser.type', 'browser.select_option', 'browser.file_upload', 'browser.press_key', 'browser.take_screenshot',
    'browser.transfer_firefox_profile', 'browser.close', 'browser.hover'],
}[kind];
const NAMES = underscore ? LISTED.map((name) => name.replace(/\./g, '_')) : LISTED;
const ann = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const tools = NAMES.map((name) => kind === 'engine' ? { name, title: `Engine ${name}`, inputSchema: { type: 'object' }, annotations: { title: `Engine ${name}`, ...ann } } : { name, inputSchema: { type: 'object' }, annotations: ann });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const result = (r) => send({ jsonrpc: '2.0', id: m.id, result: r });
  if (m.method === 'initialize') return result({ protocolVersion: m.params.protocolVersion, serverInfo: { name: `catalog-${kind}`, version: '1' }, capabilities: { tools: {} } });
  if (m.method === 'tools/list') return result({ tools });
  if (m.method === 'tools/call') {
    const { name, arguments: args } = m.params;
    if (process.env.CATALOG_FAIL === name) return result({ isError: true, content: [{ type: 'text', text: `${name} refused: fixture` }] });
    const data = { tool: name, args, unicode: 'é ✓  ', nested: { n: 1.5, list: [true, null] } };
    return result(kind === 'fleet'
      ? { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, _meta: { fixture: kind } }
      : { content: [{ type: 'text', text: JSON.stringify(data) }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] });
  }
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } });
});
