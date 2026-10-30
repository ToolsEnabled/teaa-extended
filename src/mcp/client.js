// Bounded newline-delimited JSON-RPC transport for local MCP servers.
import { EventEmitter } from 'node:events';
import { resolveCommand, spawnResolved, killTree } from '../platform.js';
import { VERSION } from '../version.js';
import { isPresentationItem } from './presentation.js';

export const PROTOCOL_VERSION = '2025-06-18';
export function inheritedEnv(dropPrefixes = [], env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !dropPrefixes.some((prefix) => name.startsWith(prefix))));
}
// 2025-11-25 is accepted when the peer asks for it. The default we speak to
// upstreams stays 2025-06-18, so older servers still negotiate as before.
export const SUPPORTED_PROTOCOLS = [PROTOCOL_VERSION, '2025-03-26', '2024-11-05', '2025-11-25'];
// Tool and implementation icons exist in the 2025-11-25 base spec. Older
// negotiated versions do not get an icons field.
export const ICON_PROTOCOLS = Object.freeze(['2025-11-25']);
export function protocolHasIcons(protocol) {
  return ICON_PROTOCOLS.includes(protocol) && SUPPORTED_PROTOCOLS.includes(protocol);
}
const MAX_LINE = 16 * 1024 * 1024;
export class McpClient extends EventEmitter {
  // dropInherited: name prefixes of this process's variables the server must not inherit.
  constructor({ name, command, args = [], env = {}, cwd, timeoutMs = 60_000, dropInherited = [] }) {
    super();
    Object.assign(this, { name, command, args, env, cwd, timeoutMs, dropInherited });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderrTail = [];
    this.state = 'stopped';
    this.serverInfo = null;
    this.instructions = '';
    this.tools = [];
    this.error = null;
  }
  start() {
    if (this.state === 'ready') return Promise.resolve(this);
    if (this.starting) return this.starting;
    if (this.state !== 'stopped') return Promise.reject(new Error(this.error || `${this.name} is ${this.state}`));
    this.starting = this._start();
    return this.starting;
  }
  async _start() {
    this.state = 'starting';
    try {
      const env = { ...inheritedEnv(this.dropInherited), ...this.env };
      const resolved = resolveCommand(this.command, this.args, env);
      if (!resolved.file) throw new Error(`program not found: ${this.command}`);
      const child = this.child = spawnResolved(resolved, { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => this._onData(d));
      child.stderr.on('data', (d) => {
        for (const line of d.split(/\r?\n/)) if (line.trim()) this.stderrTail.push(line.slice(0, 500));
        this.stderrTail = this.stderrTail.slice(-40);
        this.emit('stderr', d.slice(0, MAX_LINE));
      });
      child.stdin.on('error', (err) => { if (this.state !== 'closed') this._fail(err.message); });
      child.on('error', (err) => this._fail(err.message));
      child.on('exit', () => {
        this.drainTimer = setTimeout(() => {
          killTree(child, 'SIGKILL', { drain: true });
          child.stdout.destroy(); child.stderr.destroy();
        }, 1500);
      });
      child.on('close', (code, signal) => {
        child.teaaClosed = true;
        clearTimeout(this.drainTimer);
        clearTimeout(this.killTimer);
        clearTimeout(this.hardKillTimer);
        if (this.state !== 'closed') this._fail(`${this.name} exited (${signal || code})${this.stderrTail.length ? ': ' + this.stderrTail.slice(-3).join(' | ') : ''}`);
        this.resolveClosed();
        this.emit('exit', code, signal);
      });
      const init = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'teaa', title: 'TEAA', version: VERSION } });
      if (!init || !SUPPORTED_PROTOCOLS.includes(init.protocolVersion) || typeof init.serverInfo?.name !== 'string' || typeof init.serverInfo?.version !== 'string') throw new Error(`${this.name}: unsupported or malformed MCP initialization`);
      this.serverInfo = init.serverInfo;
      this.protocolVersion = init.protocolVersion;
      this.instructions = typeof init.instructions === 'string' ? init.instructions : '';
      this.capabilities = init.capabilities || {};
      this.notify('notifications/initialized');
      if (this.capabilities.tools) await this.refreshTools();
      if (this.state !== 'starting') throw new Error(this.error || `${this.name} closed during startup`);
      this.state = 'ready';
      if (this.refreshAgain) { this.refreshAgain = false; await this.refreshTools(); }
      return this;
    } catch (err) {
      this._fail(err.message);
      this._stopProcess();
      throw err;
    }
  }
  async refreshTools() {
    if (this.refreshing) { this.refreshAgain = true; return this.refreshing; }
    this.refreshing = this._listTools();
    try { return await this.refreshing; }
    finally {
      this.refreshing = null;
      if (this.refreshAgain && this.state === 'ready') {
        this.refreshAgain = false;
        this.refreshTools().catch((err) => { this._fail(err.message); this._stopProcess(); });
      }
    }
  }
  async _listTools() {
    const tools = [], cursors = new Set(), names = new Set();
    let cursor;
    do {
      const page = await this.request('tools/list', cursor ? { cursor } : {});
      if (!page || !Array.isArray(page.tools)) throw new Error(`${this.name}: invalid tools/list response`);
      for (const tool of page.tools) {
        if (!tool || typeof tool.name !== 'string' || !tool.name || !tool.inputSchema || names.has(tool.name)) throw new Error(`${this.name}: invalid or duplicate tool name`);
        names.add(tool.name); tools.push(tool);
      }
      cursor = page.nextCursor;
      if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursors.has(cursor))) throw new Error(`${this.name}: invalid or repeated tool-list cursor`);
      if (cursor) cursors.add(cursor);
      if (cursors.size > 100 || tools.length > 100_000) throw new Error(`${this.name}: tool list exceeds the transport limit`);
    } while (cursor);
    if (this.state === 'closed' || this.state === 'failed') throw new Error(this.error || `${this.name} closed`);
    this.tools = tools;
    this.emit('tools');
    return tools;
  }
  callTool(name, args = {}, { timeoutMs, signal, meta } = {}) {
    if (this.state !== 'ready') return Promise.reject(new Error(this.error || `${this.name} is not ready`));
    return this.request('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) }, { timeoutMs, signal });
  }
  request(method, params, { timeoutMs = this.timeoutMs, signal } = {}) {
    if (!this.child || !['starting', 'ready'].includes(this.state)) return Promise.reject(new Error(this.error || `${this.name} is not running`));
    if (signal?.aborted) return Promise.reject(new Error('Request cancelled'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(id); };
      const abort = () => {
        cleanup(); this.notify('notifications/cancelled', { requestId: id, reason: 'cancelled' }); reject(new Error('Request cancelled'));
      };
      const timer = setTimeout(() => {
        cleanup(); this.notify('notifications/cancelled', { requestId: id, reason: 'timeout' });
        reject(new Error(`${this.name}: ${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, cleanup, method });
      signal?.addEventListener('abort', abort, { once: true });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method, params) { this._send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }); }
  _send(msg) {
    if (!this.child || !['starting', 'ready'].includes(this.state)) return;
    try { this.child.stdin.write(JSON.stringify(msg) + '\n'); } catch (err) { this._fail(err.message); this._stopProcess(); }
  }
  _onData(chunk) {
    if (!['starting', 'ready'].includes(this.state)) return;
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).trim(); this.buffer = this.buffer.slice(i + 1);
      if (line.length > MAX_LINE) { this._fail(`${this.name}: oversized MCP message`); this._stopProcess(); return; }
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { this.emit('noise', line.slice(0, 1000)); continue; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') continue;
      if (msg.id !== undefined && msg.id !== null && ('result' in msg || 'error' in msg)) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        p.cleanup();
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'MCP error'), { code: msg.error.code, data: msg.error.data }));
        else p.resolve(msg.result);
      } else if (msg.method && msg.id !== undefined) {
        if (msg.method === 'ping') this._send({ jsonrpc: '2.0', id: msg.id, result: {} });
        else this._send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `TEAA does not offer ${msg.method}` } });
      } else if (msg.method) {
        this.emit('notification', msg);
        if (msg.method === 'notifications/tools/list_changed') {
          if (this.state === 'starting') this.refreshAgain = true;
          else if (this.state === 'ready') this.refreshTools().catch((err) => { this._fail(err.message); this._stopProcess(); });
        }
      }
    }
    if (this.buffer.length > MAX_LINE) { this._fail(`${this.name}: oversized MCP message`); this._stopProcess(); }
  }
  _fail(message) {
    if (this.state === 'closed') return;
    this.error = message;
    this.state = 'failed';
    this.tools = [];
    for (const p of [...this.pending.values()]) { p.cleanup(); p.reject(new Error(message)); }
    this.emit('failure', message);
  }
  _stopProcess() {
    const child = this.child;
    if (!child || this.killTimer) return;
    try { child.stdin.end(); } catch { /* already closed */ }
    this.killTimer = setTimeout(() => {
      killTree(child);
      this.hardKillTimer = setTimeout(() => killTree(child, 'SIGKILL'), 1500);
    }, 500);
  }
  close() {
    if (this.state === 'closed') return this.closed || Promise.resolve();
    this.state = 'closed';
    this.tools = [];
    for (const p of [...this.pending.values()]) { p.cleanup(); p.reject(new Error(`${this.name} closed`)); }
    this._stopProcess();
    return this.closed || Promise.resolve();
  }
}
export function resultText(result) {
  if (!result) return '';
  const parts = [];
  for (const c of result.content || []) {
    if (isPresentationItem(c)) continue; // the person-facing TEAA line is not result data
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'image') parts.push(`[image ${c.mimeType || ''}]`);
    else if (c.type === 'resource') parts.push(c.resource?.text || `[resource ${c.resource?.uri || ''}]`);
    else parts.push(`[${c.type}]`);
  }
  if (!parts.length && result.structuredContent) parts.push(JSON.stringify(result.structuredContent, null, 2));
  return parts.join('\n');
}
