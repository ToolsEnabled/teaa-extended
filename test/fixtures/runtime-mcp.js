// Isolated transport adversary. No network or provider calls.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const mode = process.env.RUNTIME_MCP_MODE || 'normal';
let changed = false;
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const ro = { readOnlyHint: true, title: 'Original title', customFlag: 'preserve-me' };
const tool = (name) => ({ name, inputSchema: { type: 'object' }, annotations: ro });
const tools = () => mode === 'collision' ? ['a.b','a_b','x'.repeat(100),'x'.repeat(99) + 'y'].map(tool) : [tool(changed ? 'new.tool' : 'old.tool')];
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'notifications/cancelled') {
    if (process.env.RUNTIME_MCP_LOG) appendFileSync(process.env.RUNTIME_MCP_LOG, JSON.stringify(msg) + '\n');
    return;
  }
  if (msg.id === undefined) return;
  const result = (value) => send({ jsonrpc: '2.0', id: msg.id, result: value });
  if (msg.method === 'initialize') {
    if (mode === 'initialize-error') return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'fixture initialization refusal' } });
    if (mode === 'bad-protocol') return result({ protocolVersion: 'future-unsupported', serverInfo: { name: 'fixture', version: '1' } });
    return result({ protocolVersion: msg.params.protocolVersion, serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: { listChanged: true } } });
  }
  if (msg.method === 'tools/list') return result(mode === 'repeat-cursor' ? { tools: [], nextCursor: 'again' } : { tools: tools() });
  if (msg.method === 'tools/call') {
    if (msg.params.arguments?.action === 'die') { process.exit(3); }
    if (msg.params.arguments?.action === 'change') {
      changed = true; result({ content: [{ type: 'text', text: 'changed' }] });
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); return;
    }
    if (msg.params.arguments?.action === 'wait') return;
    if (msg.params._meta?.progressToken !== undefined) send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: msg.params._meta.progressToken, progress: 1, total: 2 } });
    return result({ content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }], structuredContent: { cwd: process.cwd(), name: msg.params.name, args: msg.params.arguments, meta: msg.params._meta }, _meta: { untouched: true } });
  }
});
