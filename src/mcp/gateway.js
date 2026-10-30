// One MCP connection, with upstream policy and tool results preserved.
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { McpClient, PROTOCOL_VERSION, SUPPORTED_PROTOCOLS, protocolHasIcons } from './client.js';
import { VERSION } from '../version.js';
import { humanTitle, present, presentationEnabled, describe, toolIcons, serverIcons } from './presentation.js';
const NAME_OK = /^[A-Za-z0-9_-]{1,64}$/;
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
export function exposedName(prefix, name) {
  const n = `${prefix}_${name.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  return n.length <= 64 ? n : n.slice(0, 47) + '_' + hash(`${prefix}:${name}`);
}
const LABEL = { fleet: 'Fleet', engine: 'ToolsEngine', knowledge: 'Knowledge' };
export class Gateway extends EventEmitter {
  constructor({ upstreams, log = () => {}, presentation = presentationEnabled() }) {
    super();
    if (new Set(upstreams.map((u) => u.key)).size !== upstreams.length) throw new Error('Duplicate upstream key');
    this.upstreams = upstreams.map((u) => ({ ...u, client: null, status: u.launch ? 'pending' : u.disabled ? 'disabled' : 'not configured' }));
    this.map = new Map();
    this.progress = new Map();
    this.log = log;
    this.presentation = presentation;
    this.closed = false;
  }
  start() {
    if (this.closed) return Promise.reject(new Error('Gateway closed'));
    return this.starting ||= this._start();
  }
  async _start() {
    await Promise.all(this.upstreams.map(async (u) => {
      if (!u.launch) return;
      const c = u.client = new McpClient({ name: LABEL[u.key] || u.key, ...u.launch });
      c.on('tools', () => { if (u.status === 'ready') this.rebuild(); });
      c.on('failure', (message) => { u.status = 'failed'; u.error = message; this.rebuild(); });
      c.on('notification', (msg) => {
        if (msg.method === 'notifications/progress') {
          const original = this.progress.get(msg.params?.progressToken);
          if (original?.key === u.key) this.emit('notification', { ...msg, params: { ...msg.params, progressToken: original.token } });
        }
      });
      try {
        await c.start();
        if (this.closed) { c.close(); return; }
        u.status = 'ready'; u.error = null;
      } catch (err) {
        u.status = this.closed ? 'closed' : 'failed'; u.error = err.message;
        this.log(`${u.key}: ${err.message}`);
        c.close();
      }
    }));
    this.rebuild();
  }
  rebuild() {
    const previous = JSON.stringify(this.listTools());
    this.map.clear();
    const entries = [];
    for (const u of this.upstreams) {
      if (u.status !== 'ready' || u.client.state !== 'ready') continue;
      for (const t of u.client.tools) entries.push({ upstream: u, tool: t, base: exposedName(u.key, t.name) });
    }
    // Dots, underscores and truncation can otherwise map different tools onto one name.
    const counts = new Map();
    for (const e of entries) counts.set(e.base, (counts.get(e.base) || 0) + 1);
    for (const e of entries.sort((a, b) => `${a.upstream.key}:${a.tool.name}`.localeCompare(`${b.upstream.key}:${b.tool.name}`))) {
      let name = e.base;
      if (counts.get(name) > 1 || name === 'teaa_status') name = `${name.slice(0, 47)}_${hash(`${e.upstream.key}:${e.tool.name}`)}`;
      let counter = 0;
      while (this.map.has(name) || name === 'teaa_status') name = `${e.base.slice(0, 47)}_${hash(`${e.upstream.key}:${e.tool.name}:${++counter}`)}`;
      if (!NAME_OK.test(name)) throw new Error(`Invalid upstream namespace: ${e.upstream.key}`);
      this.map.set(name, e);
    }
    if (JSON.stringify(this.listTools()) !== previous) this.emit('tools');
  }
  instructions() {
    const parts = ['TEAA Extended (ToolsEnabled Agent Architecture) offers Fleet, ToolsEngine and Knowledge through one connection, with the FRA device client and bundled Hub commands. Tools named fleet_* come from Fleet, engine_* from ToolsEngine and knowledge_* from Knowledge. Each upstream enforces its own settings; TEAA does not provide a sandbox. Host permissions depend on the actual runtime and process ancestry, so inspect status rather than assuming this gateway preserves direct-agent privileges. A heading added to a tool result is text for the host to show; TEAA does not draw native tool-call rows.'];
    for (const u of this.upstreams) {
      if (u.status === 'ready' && u.client.instructions) parts.push(`## ${LABEL[u.key] || u.key} (${u.key}_*)\n${u.client.instructions}`);
      else if (u.status !== 'ready') parts.push(`## ${LABEL[u.key] || u.key}: ${u.status}${u.error ? ` (${u.error})` : ''}`);
    }
    return parts.join('\n\n');
  }
  // Tool annotations (and so annotations.title) exist from protocol 2025-03-26 on.
  listTools({ protocol = PROTOCOL_VERSION } = {}) {
    const tools = [];
    const annotated = protocol !== '2024-11-05';
    const withIcons = protocolHasIcons(protocol);
    for (const [name, { upstream, tool }] of this.map) {
      const label = LABEL[upstream.key] || upstream.key;
      const human = humanTitle(upstream.key, tool.name, label);
      const out = { ...tool, name, title: `${label}: ${tool.title || tool.annotations?.title || human}`, description: `[${label} ${tool.name}] ${tool.description || ''}`.trim() };
      if (annotated && typeof tool.annotations?.title !== 'string') out.annotations = { ...tool.annotations, title: human };
      // Icons are presentation metadata. Safety hints on annotations stay as the upstream sent them.
      if (withIcons) out.icons = toolIcons(describe(upstream.key, tool.name, label).family);
      else delete out.icons;
      tools.push(out);
    }
    const status = { name: 'teaa_status', title: 'TEAA: status', description: 'Report live upstream connections, versions, tool counts and startup errors. Connection health does not verify browser authentication or provider access.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { title: 'TEAA: status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } };
    if (withIcons) status.icons = toolIcons('teaa');
    tools.push(status);
    return tools;
  }
  status() {
    return { name: 'TEAA', version: VERSION, upstreams: this.upstreams.map((u) => ({ key: u.key, label: LABEL[u.key] || u.key, status: u.status, server: u.client?.serverInfo || null, tools: u.status === 'ready' ? u.client.tools.length : 0, error: u.error || u.client?.error || null })) };
  }
  async call(name, args, { signal, meta } = {}) {
    if (name === 'teaa_status') { const status = this.status(); return this.present({ content: [{ type: 'text', text: JSON.stringify(status, null, 2) }], structuredContent: status }, 'teaa', 'status', 'TEAA'); }
    const entry = this.map.get(name);
    if (!entry || entry.upstream.status !== 'ready') return { isError: true, content: [{ type: 'text', text: `Unknown or disconnected tool ${name}. Call teaa_status to inspect connections.` }] };
    let token;
    if (meta?.progressToken !== undefined) {
      token = randomUUID();
      this.progress.set(token, { key: entry.upstream.key, token: meta.progressToken });
      meta = { ...meta, progressToken: token };
    }
    const label = LABEL[entry.upstream.key] || entry.upstream.key;
    let result;
    try { result = await entry.upstream.client.callTool(entry.tool.name, args ?? {}, { timeoutMs: 15 * 60_000, signal, meta }); }
    catch (err) { result = { isError: true, content: [{ type: 'text', text: `${label} ${entry.tool.name} failed: ${err.message}` }] }; }
    finally { if (token) this.progress.delete(token); }
    return this.present(result, entry.upstream.key, entry.tool.name, label, args);
  }
  present(result, key, name, label, args) {
    return this.presentation ? present(result, key, name, label, args) : result;
  }
  close() {
    this.closed = true;
    for (const u of this.upstreams) { u.status = 'closed'; u.client?.close(); }
    this.rebuild();
  }
}
export async function serveStdio(gateway, { input = process.stdin, output = process.stdout } = {}) {
  let started = null, initialized = false, ended = false, buffer = '', protocol = PROTOCOL_VERSION;
  const active = new Map();
  const send = (msg) => { if (!ended && !output.destroyed) output.write(JSON.stringify(msg) + '\n'); };
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  const close = () => { ended = true; for (const c of active.values()) c.abort(); active.clear(); gateway.close(); };
  gateway.on('tools', () => { if (initialized) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); });
  gateway.on('notification', (msg) => { if (initialized) send(msg); });
  output.on('error', close);
  input.on('error', close);
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    if (ended) return;
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
      if (line.length > 16 * 1024 * 1024) { fail(null, -32600, 'Message exceeds transport limit'); close(); return; }
      if (line) void handle(line);
    }
    if (buffer.length > 16 * 1024 * 1024) { fail(null, -32600, 'Message exceeds transport limit'); close(); }
  });
  input.on('end', close);
  async function handle(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'Parse error'); }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(null, -32600, 'Invalid request');
    const { id, method, params } = msg;
    if (id === undefined) {
      if (method === 'notifications/cancelled') active.get(params?.requestId)?.abort();
      else if (method === 'notifications/initialized' && started) initialized = true;
      return;
    }
    if ((typeof id !== 'string' && typeof id !== 'number') || active.has(id)) return fail(id ?? null, -32600, 'Invalid or duplicate request id');
    const controller = new AbortController(); active.set(id, controller);
    try {
      if (method === 'initialize') {
        if (started) return fail(id, -32600, 'Already initialized');
        started = gateway.start();
        await started;
        if (ended) return;
        protocol = SUPPORTED_PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSION;
        const serverInfo = { name: 'teaa', title: 'TEAA', version: VERSION };
        if (protocolHasIcons(protocol)) serverInfo.icons = serverIcons();
        return reply(id, { protocolVersion: protocol, capabilities: { tools: { listChanged: true } }, serverInfo, instructions: gateway.instructions() });
      }
      if (method === 'ping') return reply(id, {});
      if (!started) return fail(id, -32000, 'Initialize the MCP connection first');
      await started;
      if (ended) return;
      if (method === 'tools/list') return reply(id, { tools: gateway.listTools({ protocol }) });
      if (method === 'tools/call') {
        if (typeof params?.name !== 'string' || params.arguments !== undefined && (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments))) return fail(id, -32602, 'tools/call needs a name and object arguments');
        return reply(id, await gateway.call(params.name, params.arguments, { signal: controller.signal, meta: params._meta }));
      }
      return fail(id, -32601, `Method not found: ${method}`);
    } catch (err) { return fail(id, -32603, err.message); }
    finally { active.delete(id); }
  }
}
