// The pinned extension factory exposes no relay handle or abort signal. Keep
// the complete bridge in an owned thread so its sockets can be revoked even
// while that factory waits for approval. No user browser process is killed.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { configureBrowserEnvironment, refuseRemoteGrid } from './config.js';

export async function createExtensionWorkerBridge(config, { workerFactory = data => new Worker(new URL(import.meta.url), {
  workerData: data, stdout: true, stderr: true,
}) } = {}) {
  refuseRemoteGrid();
  const workspace = await fs.realpath(config.workspace);
  const runtime = path.join(workspace, '.toolsengine-runtime');
  await fs.mkdir(runtime, { recursive: true });
  const stat = await fs.lstat(runtime);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Browser runtime directory is not a plain directory.');
  let current, closed = false, sequence = 0;
  const start = async () => {
    if (closed) throw new Error('The browser bridge is closed.');
    if (current) return current.ready;
    const registry = await fs.mkdtemp(path.join(runtime, 'extension-registry-'));
    if (closed) { await fs.rm(registry, { recursive: true, force: true }); throw new Error('The browser bridge is closed.'); }
    const worker = workerFactory({ toolsEngineExtension: true, config, registry });
    const pending = new Map();
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    let resolveStopped;
    const stopped = new Promise(resolve => { resolveStopped = resolve; });
    const state = { worker, registry, pending, ready, stopped };
    current = state;
    // Browser-library diagnostics may contain page data; never forward them.
    worker.stdout?.resume(); worker.stderr?.resume();
    const fail = error => { rejectReady(error); for (const call of pending.values()) call.reject(error); pending.clear(); };
    worker.on('message', message => {
      if (message.type === 'stopped') resolveStopped();
      else if (message.type === 'ready') resolveReady({ state, descriptors: message.tools });
      else if (message.type === 'result') {
        const call = pending.get(message.id);
        if (!call) return;
        pending.delete(message.id);
        if (message.error) call.reject(new Error(message.error)); else call.resolve(message.result);
      }
    });
    worker.on('error', fail);
    worker.on('exit', () => {
      resolveStopped();
      fail(new Error('The extension browser connection ended.'));
      state.cleanup = fs.rm(state.registry, { recursive: true, force: true });
      state.cleanup.catch(() => {});
      if (current === state) current = undefined;
    });
    return ready;
  };
  const stop = async () => {
    const state = current;
    current = undefined;
    if (!state) return;
    // Termination closes the thread's HTTP/WebSocket/pipe handles. Remove only
    // this thread's registry, including a descriptor from interrupted binding.
    let timer;
    try {
      try { state.worker.postMessage({ type: 'stop' }); } catch {}
      await Promise.race([state.stopped, new Promise(resolve => { timer = setTimeout(resolve, 250); })]);
      await state.worker.terminate();
    }
    finally { clearTimeout(timer); await state.cleanup; await fs.rm(state.registry, { recursive: true, force: true }); }
  };
  let initial;
  try { initial = await start(); }
  catch (error) { await stop(); throw error; }
  return {
    tools: initial.descriptors.map(descriptor => ({ ...descriptor,
      async handler(args, { signal } = {}) {
        if (signal?.aborted) throw new Error('The browser request was cancelled; it was not started.');
        const { state } = await start();
        const id = ++sequence;
        let stopping;
        const abort = () => { stopping ||= stop(); stopping.catch(() => {}); };
        signal?.addEventListener('abort', abort, { once: true });
        try {
          if (signal?.aborted) { abort(); throw new Error('The browser request was cancelled.'); }
          const result = await new Promise((resolve, reject) => {
            state.pending.set(id, { resolve, reject });
            state.worker.postMessage({ type: 'call', id, name: descriptor.name, args });
          });
          if (signal?.aborted) throw new Error('The browser request was cancelled.');
          return result;
        } catch (error) {
          if (signal?.aborted) throw new Error('The browser request was cancelled; effects already delivered may have applied. Inspect before retrying.');
          throw error;
        } finally { signal?.removeEventListener('abort', abort); await stopping; }
      },
    })),
    async waitForDownloads() {}, // Attached downloads belong to the browser.
    async close() { closed = true; await stop(); },
  };
}

if (!isMainThread && workerData?.toolsEngineExtension) void (async () => {
  configureBrowserEnvironment();
  // Internal, per-thread storage; an inherited test variable is never trusted.
  process.env.PWTEST_SERVER_REGISTRY = workerData.registry;
  // Keep transient Unix sockets under the same private directory, using a
  // short fd spelling for long workspace paths. The thread owns the handle.
  const socketDirectoryHandle = process.platform === 'linux' ? await fs.open(workerData.registry, 'r') : undefined;
  process.env.PWTEST_SOCKETS_DIR = socketDirectoryHandle
    ? `/proc/${process.pid}/fd/${socketDirectoryHandle.fd}` : workerData.registry;
  parentPort.on('close', () => { void socketDirectoryHandle?.close(); });
  const { createBrowserBridge, connectThroughExtension } = await import('./browser.js');
  const bridge = await createBrowserBridge(workerData.config, { connectExtension: connectThroughExtension });
  parentPort.postMessage({ type: 'ready', tools: bridge.tools.map(({ handler, ...tool }) => tool) });
  parentPort.on('message', async message => {
    if (message.type === 'stop') {
      try { await bridge.close(); }
      finally { parentPort.postMessage({ type: 'stopped' }); }
      return;
    }
    if (message.type !== 'call') return;
    try {
      const tool = bridge.tools.find(tool => tool.name === message.name);
      if (!tool) throw new Error('Tool is not offered.');
      const result = await tool.handler(message.args);
      parentPort.postMessage({ type: 'result', id: message.id, result });
    } catch (error) {
      parentPort.postMessage({ type: 'result', id: message.id, error: String(error.message || error).slice(0, 2000) });
    }
  });
})().catch(error => { throw error; });
