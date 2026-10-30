'use strict';

const { randomUUID } = require('node:crypto');
const error = (code, message) => Object.assign(new Error(message), { code });
const MAX_RECORD_BYTES = 8 * 1024 * 1024;

// Pi RPC has no per-turn event id. Only one prompt may be active; the local
// opaque turn identity is allocated before dispatch and retained until settled.
class PiRpcAdapter {
  constructor({ transport, requestTimeoutMs = 60000 }) {
    this.transport = transport;
    this.requestTimeoutMs = requestTimeoutMs;
    this.pending = new Map();
    this.listeners = new Set();
    this.buffer = '';
    this.closed = false;
    this.active = null;
    this.unsubscribe = transport.onData((chunk, exit) => {
      if (chunk === null) return this.fail(error('PI_RPC_EXIT', `Pi RPC exited (${exit?.code ?? 'unknown'}); outstanding outcomes are unconfirmed.`));
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > MAX_RECORD_BYTES && !this.buffer.includes('\n')) return this.fail(error('PI_RPC_RECORD_LIMIT', 'Pi RPC record exceeds 8 MiB.'));
      let at;
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at).replace(/\r$/, '');
        this.buffer = this.buffer.slice(at + 1);
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > MAX_RECORD_BYTES) return this.fail(error('PI_RPC_RECORD_LIMIT', 'Pi RPC record exceeds 8 MiB.'));
        let record;
        try { record = JSON.parse(line); }
        catch { return this.fail(error('PI_RPC_INVALID_JSON', 'Pi RPC returned invalid JSON.')); }
        this.receive(record);
      }
      if (Buffer.byteLength(this.buffer) > MAX_RECORD_BYTES) this.fail(error('PI_RPC_RECORD_LIMIT', 'Pi RPC incomplete record exceeds 8 MiB.'));
    });
  }
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of this.listeners) listener(event); }
  request(command) {
    if (this.closed) return Promise.reject(error('PI_RPC_CLOSED', 'Pi RPC is closed.'));
    const id = `pi-request-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(error('PI_RPC_TIMEOUT', `Pi RPC ${command.type} response is unknown; do not repeat a possibly accepted mutation.`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.transport.write(JSON.stringify({ ...command, id }) + '\n'); }
      catch (cause) { clearTimeout(timer); this.pending.delete(id); reject(cause); }
    });
  }
  receive(record) {
    if (record.type === 'response') {
      const pending = this.pending.get(record.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(record.id);
      if (!record.success) pending.reject(error('PI_RPC_COMMAND_REFUSED', record.error || 'Pi refused the command.'));
      else pending.resolve(record.data);
      return;
    }
    if (record.type === 'extension_ui_request') {
      // An unattended worker never approves an interaction or changes settings.
      if (['confirm', 'select', 'input', 'editor'].includes(record.method)) {
        this.transport.write(JSON.stringify({ type: 'extension_ui_response', id: record.id, cancelled: true }) + '\n');
        if (this.active) {
          this.active.permissionDenied = true;
          this.emit({ type: 'interaction_required', threadId: this.threadId, turnId: this.active.turnId, payload: { kind: 'pi-extension-ui' } });
        }
      }
      return;
    }
    const turn = this.active;
    if (!turn) return;
    const identity = { threadId: this.threadId, turnId: turn.turnId };
    if (record.type === 'message_end' && record.message?.role === 'assistant') {
      const message = record.message;
      turn.text = (message.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
      turn.status = message.stopReason === 'aborted' ? 'interrupted' : message.stopReason === 'error' ? 'failed' : null;
      this.emit({ type: 'assistant_text', ...identity, text: turn.text });
      if (message.usage) {
        const usage = { inputTokens: message.usage.input, outputTokens: message.usage.output,
          cachedInputTokens: message.usage.cacheRead, totalTokens: message.usage.totalTokens };
        this.lastUsage = usage;
        this.emit({ type: 'usage', ...identity, usage });
      }
    }
    if (record.type === 'tool_execution_end') this.emit({ type: 'tool_result', ...identity, payload: { toolName: record.toolName, isError: record.isError } });
    if (record.type === 'auto_compaction_end' && !record.aborted) this.emit({ type: 'context_compacted', ...identity });
    if (record.type === 'agent_settled') this.complete(record.aborted ? 'interrupted' : turn.status || 'completed');
    if (record.type === 'auto_retry_end' && record.success === false) turn.status = 'failed';
  }
  complete(status) {
    const turn = this.active;
    if (!turn) return;
    this.active = null;
    this.emit({ type: 'turn_completed', threadId: this.threadId, turnId: turn.turnId, status, text: turn.text,
      payload: { permissionDenied: turn.permissionDenied === true } });
  }
  async initialize(threadId) {
    const state = await this.request({ type: 'get_state' });
    if (!state || typeof state.sessionId !== 'string' || !state.sessionId || !state.sessionFile || state.isStreaming || state.pendingMessageCount) {
      throw error('PI_SESSION_UNCONFIRMED', 'Pi must identify a retained, idle session before Fleet can submit work.');
    }
    if (threadId && state.sessionFile !== threadId) throw error('PI_RESUME_MISMATCH', 'Pi did not resume the exact retained conversation.');
    this.threadId = state.sessionFile;
    this.sessionId = state.sessionId;
    this.state = state;
    return state;
  }
  async startThread() { await this.initialize(); return { threadId: this.threadId }; }
  async resumeThread(threadId) { await this.initialize(threadId); return { threadId: this.threadId }; }
  async forkThread() { throw error('PI_FORK_UNSUPPORTED', 'Pi RPC fork requires a branch-entry selection; generic Fleet fork is unsupported. Use a separate session.'); }
  answerApproval() { throw error('PI_APPROVAL_UNSUPPORTED', 'Pi permission extensions own native authorization. Fleet cancels unattended UI interactions.'); }
  getUsage(threadId) { return threadId === this.threadId ? this.lastUsage || null : null; }
  pendingTurnForInterrupt() { return this.active && { threadId: this.threadId, turnId: this.active.turnId }; }
  async sendTurn({ threadId, text }) {
    if (threadId !== this.threadId) throw error('PI_THREAD_MISMATCH', 'The turn belongs to another Pi conversation.');
    if (this.active) throw error('PI_TURN_ACTIVE', 'Pi RPC admits one active Fleet turn.');
    const turn = { turnId: `pi-turn-${randomUUID()}`, text: '' };
    this.active = turn;
    try {
      const accepted = await this.request({ type: 'prompt', message: text });
      if (!['started', 'handled'].includes(accepted?.disposition)) throw error('PI_PROMPT_DISPOSITION_UNKNOWN', 'Pi did not confirm a new or handled prompt; automatic retry is forbidden.');
      if (accepted.disposition === 'handled' && this.active === turn) this.complete('completed');
      return { threadId: this.threadId, turnId: turn.turnId };
    } catch (cause) {
      // A timeout cannot prove prompt rejection. Keep the active turn until
      // settled/close so another send cannot repeat work with unknown outcome.
      if (cause.code === 'PI_RPC_COMMAND_REFUSED' && this.active === turn) this.active = null;
      throw cause;
    }
  }
  async updateThreadSettings(threadId, { effort } = {}) {
    if (threadId !== this.threadId) throw error('PI_THREAD_MISMATCH', 'Settings belong to another conversation.');
    if (effort) {
      await this.request({ type: 'set_thinking_level', level: effort });
      const state = await this.request({ type: 'get_state' });
      if (state.thinkingLevel !== effort) throw error('PI_EFFORT_UNCONFIRMED', 'Pi did not confirm requested thinking level.');
    }
  }
  async interrupt({ threadId, turnId } = {}) {
    if (threadId !== this.threadId || turnId && turnId !== this.active?.turnId) throw error('PI_THREAD_MISMATCH', 'Interrupt does not name the current Pi turn.');
    await this.request({ type: 'clear_queue' });
    if (this.active) this.active.status = 'interrupted';
    await this.request({ type: 'abort' });
  }
  fail(cause) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(cause); }
    this.pending.clear();
    this.complete('failed');
    this.emit({ type: 'session_exited', threadId: this.threadId, error: { code: cause.code, message: cause.message } });
  }
  close() { this.fail(error('PI_RPC_CLOSED', 'Pi RPC closed.')); this.unsubscribe?.(); }
}
module.exports = { PiRpcAdapter };
