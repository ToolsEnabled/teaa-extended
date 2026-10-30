'use strict';

// A BYTE STREAM OVER FRA. The private FRA relay carries sealed, authenticated
// frames between two enrolled computers, and fra-core's relay shell turns
// them into request/response (relay-shell request() and its localBridge). This
// module builds an ordered two-way stream on top, for one process's stdio:
//
//   POST /hub-lead/v1/open                  {actor, tag?, level?}  -> {stream}
//   POST /hub-lead/v1/s/<id>/in?seq=N       raw bytes, in order by seq
//   GET  /hub-lead/v1/s/<id>/out?ack=N      long-poll; chunks after ack, eof, exit
//   POST /hub-lead/v1/s/<id>/close          end the process's stdin
//
// Both directions are numbered, so a relay reconnect (lease end, network blip)
// resumes the same stream: a duplicate write is ignored, an early one waits for
// its turn, and output is kept until the client acknowledges it. A stream no
// one asks about for idleMs is ended and its process stopped.

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { parseStrictJson } = require('./fra-device.cjs');

const PREFIX = '/hub-lead/v1';
const CHUNK_BYTES = 16 * 1024;       // raw bytes per write; base64 + JSON stay far under MAX_TUNNEL_BODY_BYTES
const OUT_BUDGET = 64 * 1024;        // raw bytes per read answer
const MAX_HELD_OUT = 4 * 1024 * 1024; // unacknowledged output kept per stream
const MAX_EARLY_IN = 64;             // out-of-order writes held per stream
const POLL_MS = 20_000;
const MAX_OPEN_BYTES = 16 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_STREAMS_PER_PAIR = 16;
const MAX_CLIENT_INPUT_HELD = 4 * 1024 * 1024;
const CLIENT_INPUT_PAUSE_AT = 1024 * 1024;
const INPUT_WRITE_MS = 10_000;
const OUTPUT_WRITE_MS = 10_000;
const TERMINAL_RETENTION_MS = 5_000;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function refusal(code, message) { return Object.assign(new Error(message), { code }); }

function json(status, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  return { status, headers: { 'content-type': 'application/json' },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
}

function strictJson(bytes, code) {
  let source;
  try { source = UTF8.decode(bytes); }
  catch { throw refusal(code, 'The stream JSON is not valid UTF-8.'); }
  return parseStrictJson(source || '{}', code);
}

function exactCounter(url, name) {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || [...url.searchParams.keys()].some(key => key !== name)
      || !/^(?:0|[1-9][0-9]*)$/.test(values[0])) return null;
  const value = Number(values[0]);
  return Number.isSafeInteger(value) ? value : null;
}

function errorResponse(error) {
  const responses = {
    BRIDGE_CONFIG_INVALID: 400,
    HUB_FLEET_PAIR_MISMATCH: 409,
    STREAM_INPUT_FAILED: 409,
    STREAM_LIMIT: 429,
    STREAM_REQUEST_INVALID: 400,
    STREAM_SPAWN_FAILED: 503,
  };
  const code = typeof error?.code === 'string' && Object.hasOwn(responses, error.code)
    ? error.code : 'STREAM_INTERNAL';
  const message = code === 'STREAM_INTERNAL'
    ? 'The stream gateway could not complete the request.'
    : String(error?.message || code).slice(0, 200);
  return json(responses[code] || 500, { error: code, message });
}

/* ------------------------------------------------------------ server -- */

/**
 * The gateway's localBridge for ONE authenticated relay pair. spawnSession is
 * called with the parsed open request and returns a child process with piped
 * stdio; the caller binds it to the machine the pair belongs to.
 */
function createStreamServer({ spawnSession, compatibility, validateOpen, idleMs = 45_000,
  maxStreams = MAX_STREAMS_PER_PAIR, now = Date.now, log = () => {} }) {  // > 2 x POLL_MS
  if (!Number.isSafeInteger(maxStreams) || maxStreams < 1 || maxStreams > 256) {
    throw new RangeError('maxStreams must be an integer from 1 to 256');
  }
  const streams = new Map();
  function remove(stream) {
    clearInterval(stream.reaper);
    streams.delete(stream.id);
  }
  function end(stream, reason) {
    if (stream.ended) return;
    stream.ended = true;
    try { stream.child.stdin.end(); } catch { /* gone */ }
    setTimeout(() => { if (stream.exit === null) try { stream.child.kill('SIGTERM'); } catch { /* gone */ } }, 5000).unref();
    log({ stream: stream.id, ended: reason });
  }
  function wake(stream) { for (const resolve of stream.waiters.splice(0)) resolve(); }
  function open(request, validated) {
    if (streams.size >= maxStreams) throw refusal('STREAM_LIMIT', 'This authenticated relay pair has too many open streams.');
    const child = spawnSession(request, validated);
    if (!child || !child.stdin || !child.stdout || !child.stderr || typeof child.on !== 'function') {
      try { child?.kill?.('SIGTERM'); } catch { /* invalid child */ }
      throw refusal('STREAM_SPAWN_FAILED', 'The Hub session process did not expose bounded stdio.');
    }
    const stream = { id: crypto.randomBytes(12).toString('base64url'), child, nextIn: 0, early: new Map(),
      inChain: Promise.resolve(), out: [], outSeq: 0, held: 0, outputRefused: false,
      ackedOut: 0, exit: null, eof: false, ended: false, touched: now(), waiters: [] };
    const push = fd => chunk => {
      if (stream.outputRefused) return;
      for (let at = 0; at < chunk.length; at += CHUNK_BYTES) {
        const part = chunk.subarray(at, at + CHUNK_BYTES);
        if (stream.held + part.length > MAX_HELD_OUT) {
          stream.outputRefused = true;
          log({ stream: stream.id, refused: 'STREAM_OUTPUT_UNREAD' });
          end(stream, 'output-unread');
          break;
        }
        stream.outSeq += 1;
        stream.out.push({ seq: stream.outSeq, fd, data: part });
        stream.held += part.length;
      }
      wake(stream);
    };
    child.stdout.on('data', push(1));
    child.stderr.on('data', push(2));
    child.stdin.on('error', () => {});
    child.once('error', error => {
      log({ stream: stream.id, refused: error.code || 'STREAM_CHILD_ERROR' });
      stream.exit = 1;
      stream.eof = true;
      wake(stream);
    });
    // 'close', not 'exit': exit can come before the last stdout bytes are read.
    child.on('close', code => { stream.exit = code ?? 1; stream.eof = true; wake(stream); });
    stream.reaper = setInterval(() => {
      if (!stream.ended && now() - stream.touched > idleMs) end(stream, 'idle');
      if (stream.eof && now() - stream.touched > TERMINAL_RETENTION_MS) remove(stream);
    }, 1000);
    stream.reaper.unref?.();
    streams.set(stream.id, stream);
    log({ stream: stream.id, opened: true });
    return stream;
  }
  async function fetch(pathname, init = {}) {
    try {
      if (typeof pathname !== 'string' || Buffer.byteLength(pathname, 'utf8') > MAX_PATH_BYTES) {
        throw refusal('STREAM_REQUEST_INVALID', 'The stream path is invalid.');
      }
      if (!pathname.startsWith('/') || pathname.includes('%') || pathname.includes('#')
          || /[\\\x00-\x20\x7f]/.test(pathname)) {
        throw refusal('STREAM_REQUEST_INVALID', 'The stream path is not canonical.');
      }
      let url;
      try { url = new URL(pathname, 'http://stream.invalid'); }
      catch { throw refusal('STREAM_REQUEST_INVALID', 'The stream path is invalid.'); }
      if (url.origin !== 'http://stream.invalid' || `${url.pathname}${url.search}` !== pathname) {
        throw refusal('STREAM_REQUEST_INVALID', 'The stream path is not canonical.');
      }
      const method = String(init.method || 'GET').toUpperCase();
      if (url.pathname === `${PREFIX}/compatibility`) {
        if (method !== 'GET') return json(405, { error: 'STREAM_METHOD' });
        if (init.body !== undefined && Buffer.from(init.body).length) {
          throw refusal('STREAM_REQUEST_INVALID', 'The compatibility request has no body.');
        }
        if (!compatibility) return json(404, { error: 'STREAM_COMPATIBILITY_UNAVAILABLE' });
        return json(200, compatibility(url));
      }
      if (url.pathname === `${PREFIX}/open`) {
        if (method !== 'POST') return json(405, { error: 'STREAM_METHOD' });
        if (url.search) throw refusal('STREAM_REQUEST_INVALID', 'The open request has no query parameters.');
        const bytes = Buffer.from(init.body || []);
        if (bytes.length > MAX_OPEN_BYTES) throw refusal('STREAM_REQUEST_INVALID', 'The open request exceeds its size limit.');
        const request = strictJson(bytes, 'STREAM_REQUEST_INVALID');
        const validated = validateOpen ? validateOpen(request) : undefined;
        return json(200, { stream: open(request, validated).id });
      }
      const match = /^\/hub-lead\/v1\/s\/([A-Za-z0-9_-]{16})\/(in|out|close)$/.exec(url.pathname);
      const stream = match && streams.get(match[1]);
      if (!stream) return json(404, { error: 'STREAM_UNKNOWN' });
      stream.touched = now();
      if (match[2] === 'in' && method === 'POST') {
        const seq = exactCounter(url, 'seq');
        if (seq === null) return json(400, { error: 'STREAM_SEQ_INVALID' });
        const input = Buffer.from(init.body || []);
        if (input.length > CHUNK_BYTES) return json(413, { error: 'STREAM_CHUNK_TOO_LARGE' });
        if (stream.ended) return json(409, { error: 'STREAM_ENDED' });
        if (seq >= stream.nextIn && !stream.early.has(seq)) {
          if (stream.early.size >= MAX_EARLY_IN) return json(429, { error: 'STREAM_TOO_FAR_AHEAD', next: stream.nextIn });
          stream.early.set(seq, input);
        }
        const drain = async () => {
          while (!stream.ended && stream.early.has(stream.nextIn)) {
            const bytes = stream.early.get(stream.nextIn);
            if (bytes.length) await new Promise((resolve, reject) => {
              let settled = false;
              const finish = error => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (error) reject(refusal('STREAM_INPUT_FAILED', 'The Hub session stopped accepting input.'));
                else resolve();
              };
              const timer = setTimeout(() => finish(new Error('timeout')), INPUT_WRITE_MS);
              timer.unref?.();
              try { stream.child.stdin.write(bytes, finish); } catch (error) { finish(error); }
            });
            stream.early.delete(stream.nextIn);
            stream.nextIn += 1;
          }
        };
        const pending = stream.inChain.then(drain);
        stream.inChain = pending.catch(() => {});
        try { await pending; }
        catch (error) { end(stream, 'input-failed'); throw error; }
        return json(200, { next: stream.nextIn });
      }
      if (match[2] === 'out' && method === 'GET') {
        const ack = exactCounter(url, 'ack');
        if (ack === null) return json(400, { error: 'STREAM_SEQ_INVALID' });
        if (ack < stream.ackedOut || ack > stream.outSeq) {
          return json(409, { error: 'STREAM_ACK_INVALID', acknowledged: stream.ackedOut, produced: stream.outSeq });
        }
        while (stream.out.length && stream.out[0].seq <= ack) stream.held -= stream.out.shift().data.length;
        stream.ackedOut = ack;
        if (!stream.out.length && !stream.eof) {
          await new Promise(resolve => { stream.waiters.push(resolve); setTimeout(resolve, POLL_MS).unref?.(); });
          stream.touched = now();
        }
        const chunks = [];
        let budget = OUT_BUDGET;
        for (const item of stream.out) {
          if (chunks.length && item.data.length > budget) break;
          chunks.push({ seq: item.seq, fd: item.fd, data: item.data.toString('base64') });
          budget -= item.data.length;
        }
        const drained = chunks.length === stream.out.length;
        return json(200, { chunks, eof: stream.eof && drained, exit: stream.eof && drained ? stream.exit : null });
      }
      if (match[2] === 'close' && method === 'POST') {
        if (url.search || (init.body !== undefined && Buffer.from(init.body).length)) {
          return json(400, { error: 'STREAM_REQUEST_INVALID' });
        }
        await stream.inChain;
        if (stream.early.size) return json(409, { error: 'STREAM_INPUT_GAP', next: stream.nextIn });
        end(stream, 'client-closed');
        return json(200, { closing: true });
      }
      return json(405, { error: 'STREAM_METHOD' });
    } catch (error) { return errorResponse(error); }
  }
  return { fetch, streams, endAll: reason => {
    for (const stream of [...streams.values()]) { end(stream, reason); remove(stream); }
  } };
}

/* ------------------------------------------------------------ client -- */

/**
 * Pump this process's stdio through one stream. `call(method, path, body)`
 * returns {status, body: Buffer} over the CURRENT relay connection; when it
 * throws, the pump waits `retryMs` and calls again (the caller reconnects in
 * between), so the stream survives relay reconnects. Resolves with the remote
 * process's exit code.
 */
async function pumpStream({ call, request, stdin, stdout, stderr, retryMs = 1000, giveUpMs = 120_000, onOpened = () => {} }) {
  const parse = response => {
    if (!response || !Buffer.isBuffer(response.body) || response.body.length > MAX_RESPONSE_BYTES) {
      throw refusal('STREAM_RESPONSE_INVALID', 'The gateway returned an invalid response.');
    }
    try { return strictJson(response.body, 'STREAM_RESPONSE_INVALID'); }
    catch (error) {
      if (error.code === 'STREAM_RESPONSE_INVALID') throw error;
      throw refusal('STREAM_RESPONSE_INVALID', 'The gateway returned invalid JSON.');
    }
  };
  const opened = await call('POST', `${PREFIX}/open`, Buffer.from(JSON.stringify(request)));
  if (opened.status !== 200) {
    let answer = null;
    try { answer = parse(opened); } catch { /* retain the status-only refusal */ }
    if (answer && answer.error === 'HUB_FLEET_PAIR_MISMATCH'
        && typeof answer.message === 'string' && answer.message.length <= 200) {
      throw refusal(answer.error, answer.message);
    }
    throw refusal('STREAM_OPEN_REFUSED', `open answered ${opened.status}`);
  }
  const openAnswer = parse(opened);
  if (!openAnswer || Object.keys(openAnswer).length !== 1
      || typeof openAnswer.stream !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(openAnswer.stream)) {
    throw refusal('STREAM_RESPONSE_INVALID', 'The gateway returned an invalid stream identifier.');
  }
  const id = openAnswer.stream;
  onOpened(id);
  const retrying = async (label, attempt, cancelled = () => false) => {
    const started = Date.now();
    for (;;) {
      if (cancelled()) throw refusal('STREAM_CANCELLED', `${label} was cancelled.`);
      try {
        const response = await attempt();
        if (!response || !Number.isSafeInteger(response.status)) {
          throw refusal('STREAM_RESPONSE_INVALID', `${label} returned no valid status.`);
        }
        if (response.status === 404) throw refusal('STREAM_LOST', 'The gateway no longer has this stream.');
        if (response.status !== 200 && response.status !== 429) throw refusal('STREAM_REFUSED', `${label} answered ${response.status}`);
        if (response.status === 200) return response;
      } catch (error) {
        if (['STREAM_LOST', 'STREAM_REFUSED', 'STREAM_RESPONSE_INVALID', 'STREAM_CANCELLED'].includes(error.code)) throw error;
        if (Date.now() - started >= giveUpMs) throw refusal('STREAM_UNREACHABLE', `${label}: ${error.code || error.message}`);
      }
      if (Date.now() - started >= giveUpMs) throw refusal('STREAM_UNREACHABLE', `${label}: retry limit reached`);
      await new Promise(resolve => setTimeout(resolve, retryMs));
    }
  };
  const writeOutput = (target, bytes) => new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(refusal('STREAM_OUTPUT_FAILED', 'The local lead stopped accepting Hub output.'));
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error('timeout')), OUTPUT_WRITE_MS);
    timer.unref?.();
    try { target.write(bytes, finish); } catch (error) { finish(error); }
  });
  // Writes, strictly in order, each retried with the same seq until accepted.
  // Local input is bounded too: pausing the stream applies backpressure before
  // a relay outage can turn this adapter into an unbounded in-memory queue.
  let seq = 0;
  const queue = [];
  let queuedBytes = 0;
  let wakeWriter = null;
  let inputEnded = false;
  let inputError = null;
  let inputPaused = false;
  let stopped = false;
  const wake = () => { const resolve = wakeWriter; wakeWriter = null; resolve?.(); };
  const pauseInput = () => {
    if (!inputPaused && typeof stdin.pause === 'function') { stdin.pause(); inputPaused = true; }
  };
  const resumeInput = () => {
    if (inputPaused && queuedBytes < CLIENT_INPUT_PAUSE_AT / 2 && typeof stdin.resume === 'function') {
      inputPaused = false;
      stdin.resume();
    }
  };
  const onData = chunk => {
    if (stopped || inputError) return;
    let bytes;
    try { bytes = Buffer.from(chunk); }
    catch { inputError = refusal('STREAM_INPUT_OVERFLOW', 'The local lead supplied invalid input.'); wake(); return; }
    if (queuedBytes + bytes.length > MAX_CLIENT_INPUT_HELD) {
      inputError = refusal('STREAM_INPUT_OVERFLOW', 'The local lead input queue exceeded its bound.');
      pauseInput();
      wake();
      return;
    }
    for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
      const part = bytes.subarray(at, at + CHUNK_BYTES);
      queue.push(part);
      queuedBytes += part.length;
    }
    if (queuedBytes >= CLIENT_INPUT_PAUSE_AT) pauseInput();
    wake();
  };
  const onEnd = () => { inputEnded = true; wake(); };
  stdin.on('data', onData);
  stdin.once('end', onEnd);
  const writer = (async () => {
    for (;;) {
      if (inputError) throw inputError;
      if (stopped) return;
      if (!queue.length) {
        if (inputEnded) {
          const response = await retrying('close', () => call('POST', `${PREFIX}/s/${id}/close`), () => stopped);
          const closed = parse(response);
          if (!closed || Object.keys(closed).length !== 1 || closed.closing !== true) {
            throw refusal('STREAM_RESPONSE_INVALID', 'The gateway returned an invalid close acknowledgement.');
          }
          return;
        }
        await new Promise(resolve => { wakeWriter = resolve; });
        continue;
      }
      const bytes = queue.shift();
      queuedBytes -= bytes.length;
      resumeInput();
      const mine = seq;
      const response = await retrying('in', () => call('POST', `${PREFIX}/s/${id}/in?seq=${mine}`, bytes), () => stopped);
      const accepted = parse(response);
      if (!accepted || Object.keys(accepted).length !== 1 || accepted.next !== mine + 1) {
        throw refusal('STREAM_RESPONSE_INVALID', 'The gateway returned an invalid input acknowledgement.');
      }
      seq += 1;
    }
  })();
  // A successful writer waits for the child to exit; only a writer failure
  // races the output poll and ends the pump.
  const writerFailure = writer.then(() => new Promise(() => {}));
  let ack = 0;
  try {
    for (;;) {
      const response = await Promise.race([
        retrying('out', () => call('GET', `${PREFIX}/s/${id}/out?ack=${ack}`)),
        writerFailure,
      ]);
      const answer = parse(response);
      if (!answer || Object.keys(answer).length !== 3 || !Array.isArray(answer.chunks)
          || typeof answer.eof !== 'boolean'
          || (answer.eof
            ? !(Number.isSafeInteger(answer.exit) && answer.exit >= 0 && answer.exit <= 255)
            : answer.exit !== null)
          || answer.chunks.length > 4096) {
        throw refusal('STREAM_RESPONSE_INVALID', 'The gateway returned an invalid output envelope.');
      }
      let expected = ack + 1;
      for (const chunk of answer.chunks) {
        if (!chunk || Object.keys(chunk).length !== 3 || chunk.seq !== expected || ![1, 2].includes(chunk.fd)
            || typeof chunk.data !== 'string' || chunk.data.length < 4
            || chunk.data.length > Math.ceil(CHUNK_BYTES / 3) * 4
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)) {
          throw refusal('STREAM_RESPONSE_INVALID', 'The gateway returned an invalid output chunk.');
        }
        const bytes = Buffer.from(chunk.data, 'base64');
        if (bytes.length < 1 || bytes.length > CHUNK_BYTES || bytes.toString('base64') !== chunk.data) {
          throw refusal('STREAM_RESPONSE_INVALID', 'The gateway returned a non-canonical output chunk.');
        }
        await writeOutput(chunk.fd === 2 ? stderr : stdout, bytes);
        ack = chunk.seq;
        expected += 1;
      }
      if (answer.eof) return answer.exit;
    }
  } finally {
    stopped = true;
    wake();
    stdin.off?.('data', onData);
    stdin.off?.('end', onEnd);
    if (inputPaused) { inputPaused = false; stdin.resume?.(); }
    writer.catch(() => {});
  }
}

module.exports = { createStreamServer, pumpStream, PREFIX, CHUNK_BYTES };
