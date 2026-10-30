'use strict';
// Synchronous callers keep their original check/mutation order. A worker owns
// the asynchronous stdio of one short-lived helper, never verdicts or paths.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const LIMIT = 16384, REQUEST_MS = 30000, CLOSE_MS = 5000;
function unsafe() { return Object.assign(new Error('Windows host state security helper did not complete safely.'), { code: 'HOST_STATE_UNSAFE' }); }
function session({ command, args, timeout = REQUEST_MS, recordDirectory }) {
  const life = new Int32Array(new SharedArrayBuffer(16));
  const worker = new Worker(__filename, { workerData: { command, args, timeout, recordDirectory, life: life.buffer } });
  // Errors also publish through shared memory, since the caller is synchronous.
  worker.on('error', () => {});
  let closed = false;
  function exchange(op, input) {
    const shared = new SharedArrayBuffer(LIMIT + 8), control = new Int32Array(shared, 0, 2);
    worker.postMessage({ op, input, shared });
    if (Atomics.wait(control, 0, 0, timeout + CLOSE_MS) === 'timed-out') throw unsafe();
    const length = Atomics.load(control, 1);
    if (length < 1 || length > LIMIT) throw unsafe();
    const result = JSON.parse(Buffer.from(shared, 8, length).toString('utf8'));
    if (result.error) throw unsafe();
    return result;
  }
  return Object.freeze({
    request(input) { if (closed) throw unsafe(); return exchange('request', input); },
    close() {
      if (closed) return;
      closed = true;
      exchange('close');
      // The helper close event precedes the reply; the thread must exit too.
      if (Atomics.load(life, 1) !== 1) throw unsafe();
      if (Atomics.load(life, 2) !== 1) Atomics.wait(life, 2, 0, CLOSE_MS);
      if (Atomics.load(life, 2) !== 1) throw unsafe();
    },
  });
}
if (!isMainThread && workerData?.life) {
  const life = new Int32Array(workerData.life);
  let child, pending, output = '', failed = false, closing, startup;
  function reply(shared, result) {
    const data = Buffer.from(JSON.stringify(result));
    const control = new Int32Array(shared, 0, 2);
    if (data.length > LIMIT) result = { error: true };
    const bytes = Buffer.from(JSON.stringify(result));
    new Uint8Array(shared, 8, bytes.length).set(bytes);
    Atomics.store(control, 1, bytes.length); Atomics.store(control, 0, 1); Atomics.notify(control, 0);
  }
  function kill() {
    if (child?.terminateRetainedWrapper) void child.terminateRetainedWrapper().catch(() => {});
    else child?.kill('SIGKILL');
  }
  async function stop(force = false) {
    if (!child) { Atomics.store(life, 1, 1); return; }
    if (closing) { if (force) kill(); return closing; }
    closing = new Promise(resolve => {
      if (Atomics.load(life, 1) === 1) return resolve();
      const timer = setTimeout(kill, 1000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      if (force) kill(); else child.stdin.end();
    });
    return closing;
  }
  async function fail() {
    failed = true;
    await stop(true);
    if (pending) { clearTimeout(pending.timer); reply(pending.shared, { error: true }); pending = null; }
  }
  function start() {
    if (startup) return startup;
    startup = new Promise((resolve, reject) => {
      if (process.platform === 'win32' && workerData.recordDirectory) {
        // Reuse the existing suspended-create, KILL_ON_JOB_CLOSE owner. The
        // helper's identity stays in the authenticated owner channel, so its
        // bootstrap needs neither private token files nor security recursion.
        const { safeLaunchEnvironment } = require('./supervision/launch-environment');
        child = require('./windows-job-control').spawnInJob(workerData.command, workerData.args,
          { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'], terminateDescendantsOnRootExit: true },
          { persistIdentity: false, assemblyCacheDirectory: null,
            cleanupTimeoutMs: CLOSE_MS, handshakeTimeoutMs: workerData.timeout, safeLaunchEnvironment });
        child.jobReady.then(() => { Atomics.store(life, 0, child.pid); resolve(); }, reject);
      } else {
        child = spawn(workerData.command, workerData.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
        child.once('spawn', () => { Atomics.store(life, 0, child.pid); resolve(); });
      }
      child.once('error', reject);
      child.once('close', () => { Atomics.store(life, 1, 1); if (pending) void fail(); });
      child.stdin.on('error', () => { void fail(); });
      child.stderr.resume(); // Never log helper stderr (may include path data).
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        output += chunk;
        if (Buffer.byteLength(output) > LIMIT || !pending) return void fail();
        const end = output.indexOf('\n'); if (end < 0) return;
        const line = output.slice(0, end).replace(/\r$/, ''); output = output.slice(end + 1);
        let evidence; try { evidence = JSON.parse(line); } catch { return void fail(); }
        if (output || !evidence || typeof evidence.ok !== 'boolean') return void fail();
        const request = pending; pending = null; clearTimeout(request.timer);
        reply(request.shared, { status: evidence.ok ? 0 : 1, stdout: line });
      });
    });
    return startup;
  }
  parentPort.on('message', async message => {
    if (message.op === 'close') {
      try { await stop(); reply(message.shared, { status: 0 }); }
      catch { reply(message.shared, { error: true }); }
      parentPort.close();
      // A blocked synchronous caller cannot drain Worker stdio. After the
      // owned helper's close, exit this thread without awaiting diagnostic IO.
      process.exit(0);
    }
    if (failed || pending || Atomics.load(life, 1) === 1) { reply(message.shared, { error: true }); return; }
    pending = { shared: message.shared, timer: setTimeout(() => { void fail(); }, workerData.timeout) };
    try { await start(); if (pending) child.stdin.write(message.input + '\n'); }
    catch { await fail(); }
  });
  process.on('exit', () => {
    if (pending) reply(pending.shared, { error: true });
    Atomics.store(life, 2, 1); Atomics.notify(life, 2);
  });
}
module.exports = Object.freeze({ session });
