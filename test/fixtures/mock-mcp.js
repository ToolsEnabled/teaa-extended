#!/usr/bin/env node
// A tiny stdio MCP server for tests. --kind fleet|engine picks a tool set shaped like the real one.
const kind = process.argv.includes('--kind') ? process.argv[process.argv.indexOf('--kind') + 1] : 'fleet';
const actor = process.argv.includes('--actor') ? process.argv[process.argv.indexOf('--actor') + 1] : null;

const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const TOOLS = {
  fleet: [
    { name: 'system.status', description: 'Function ID: system.status. Return Fleet runtime health.', inputSchema: { type: 'object', properties: {} }, annotations: ro },
    { name: 'task.list', description: 'Function ID: task.list. List tasks.', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } }, annotations: ro },
    { name: 'ledger.read', description: 'Function ID: ledger.read. Read the ledger.', inputSchema: { type: 'object', properties: {} }, annotations: ro },
    { name: 'host.write_file', description: 'Function ID: host.write_file. Write a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
  ],
  engine: [
    { name: 'web.fetch', title: 'Fetch a public web resource', description: 'Fetch one page.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }, annotations: { ...ro, openWorldHint: true } },
    { name: 'web.extract', title: 'Extract text', description: 'Extract text from HTML.', inputSchema: { type: 'object', properties: { html: { type: 'string' } } }, annotations: ro },
    { name: 'workspace.list', title: 'List a workspace folder', description: 'List files.', inputSchema: { type: 'object', properties: {} }, annotations: ro },
  ],
}[kind];

let buf = '';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: `mock-${kind}`, version: '9.9.9' }, instructions: `Mock ${kind} rules.` } });
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
    else if (m.method === 'tools/call') {
      const { name, arguments: args } = m.params;
      if (name === 'task.list') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ tasks: [{ taskId: 'task_1', queue: 'q', type: 'demo', status: 'queued' }] }) }] } });
      else if (name === 'system.status') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ name: 'Mock Fleet', version: '9.9.9', mode: 'test', actor }) }] } });
      else if (name === 'web.fetch') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ status: 200, text: '<html><body><p>Hello page</p></body></html>' }) }] } });
      else if (name === 'web.extract') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ text: 'Hello page' }) }] } });
      else send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ called: name, args, kind }) }] } });
    } else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } });
  }
});
