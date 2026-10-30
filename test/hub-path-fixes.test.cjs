'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { fraConnector, validateRemoteConfig, boundedRelayRequest, keepSession, RESET_ERROR } = require('../vendor/hub/remote/remote-lead-mcp.cjs');
const { pumpStream } = require('../vendor/hub/remote/fra-stream.cjs');
const gateway = require('../vendor/hub/bin/fra-gateway.cjs');
const compatibility = require('../vendor/hub/remote/compatibility.json');

test('FRA attach reads and sends the selected gateway compatibility claim', async () => {
  const claim = { adapterId: 'fra-hub', adapterSchema: 2, generation: 5, fleetVersion: '5.0.0-alpha.13',
    fleetIdentitySha256: 'a'.repeat(64), hubVersion: '1.0.0-security-candidate.1',
    capabilities: [...compatibility.capabilities] };
  const calls = [];
  let opened = null;
  const relay = { call: async (method, pathname, body) => {
    calls.push({ method, pathname });
    if (pathname.includes('/compatibility')) return { status: 200, body: Buffer.from(JSON.stringify(claim)) };
    if (pathname.endsWith('/open')) { opened = JSON.parse(Buffer.from(body).toString('utf8')); return { status: 200, body: Buffer.from(JSON.stringify({ stream: 'Abcdefgh12345678' })) }; }
    if (pathname.includes('/out?')) return { status: 200, body: Buffer.from(JSON.stringify({ chunks: [], eof: true, exit: 0 })) };
    if (pathname.endsWith('/close')) return { status: 200, body: Buffer.from(JSON.stringify({ closing: true })) };
    throw new Error('unexpected mocked FRA request');
  } };
  const connected = await fraConnector(relay, { actor: 'codex', level: 3, tag: 'laptop' });
  await connected.closed;
  const compatibilityRequest = calls.find(call => call.pathname.includes('/compatibility'));
  assert.ok(compatibilityRequest, 'the remote client must ask the gateway for its selected route claim');
  assert.equal(compatibilityRequest.method, 'GET');
  const query = new URL('https://hub.invalid' + compatibilityRequest.pathname).searchParams;
  assert.equal(query.get('actor'), 'codex');
  assert.equal(query.get('level'), '3');
  assert.equal(query.get('tag'), 'laptop');
  assert.deepEqual(opened, { actor: 'codex', tag: 'laptop', level: 3, compatibility: claim });
});

test('select-hub output is accepted by the remote lead configuration schema', () => {
  const route = { transports: ['fra'], fleetRoot: path.resolve('/pkg/vendor/fleet'),
    fleetStateRoot: path.resolve('/private/fleet-state'),
    fra: { accountUrl: 'https://account.example.test', relayPairId: 'pair-' + 'a'.repeat(32),
      fraCore: path.resolve('/pkg/vendor/fra-core'), state: path.resolve('/private/devices/default') } };
  assert.doesNotThrow(() => validateRemoteConfig(route));
  assert.equal(Object.hasOwn(route, 'session'), false);
});

test('hub client wrapper has a callable remote lead entry point', () => {
  const entry = require('../vendor/hub/remote/remote-lead-mcp.cjs');
  assert.equal(typeof entry.main, 'function');
});

test('gateway health probe accepts both account-service health paths', async () => {
  const originalFetch = global.fetch;
  try {
    for (const servedPath of ['/v1/health', '/healthz']) {
      const requested = [];
      global.fetch = async url => {
        const pathname = new URL(url).pathname;
        requested.push(pathname);
        return { ok: pathname === servedPath, status: pathname === servedPath ? 200 : 404 };
      };
      await gateway.waitHealthy('https://account.example.test', () => {});
      assert.ok(requested.includes(servedPath), `the gateway must probe ${servedPath}`);
    }
  } finally { global.fetch = originalFetch; }
});

test('select-hub discovers the unique relay pair through the enrolled device API', async () => {
  const { discoverRelayPair } = require('../bin/hub-profile.cjs');
  const credential = { connected: true, pairId: 'pair-' + 'b'.repeat(32), deviceToken: 'dt_' + 'c'.repeat(43) };
  let request = null;
  const relayPairId = await discoverRelayPair({ accountUrl: 'https://account.example.test', state: '/private/device',
    fraCore: '/pkg/vendor/fra-core', credentialProvider: () => credential,
    fetchImpl: async (url, init) => {
      request = { url: new URL(url), init };
      const bytes=Buffer.from(JSON.stringify({ peers: [{ relayPairId: 'pair-' + 'd'.repeat(32) }] }));
      return { status: 200, headers: { get: name => name === 'content-type' ? 'application/json' : null },
        body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
    } });
  assert.equal(relayPairId, 'pair-' + 'd'.repeat(32));
  assert.equal(request.url.pathname, '/v1/devices/peers');
  assert.equal(request.url.searchParams.get('pairId'), credential.pairId);
  assert.equal(request.init.method, 'GET');
  assert.ok(request.init.headers.authorization === 'Device ' + credential.deviceToken);
  assert.equal(request.init.redirect, 'manual');
});

test('FRA request deadline closes a silent peer and returns a retryable error', async () => {
  let closeHandle;
  let closeCount = 0;
  const closed = new Promise(resolve => { closeHandle = resolve; });
  const handle = { closed, request: () => new Promise(() => {}), close() { closeCount += 1; closeHandle(); } };
  const started = Date.now();
  await assert.rejects(boundedRelayRequest(handle, 'GET', '/hub-lead/v1/health', {}, 25), error => {
    assert.equal(error.code, 'FRA_DISCONNECTED');
    assert.match(error.message, /retry/i);
    assert.doesNotMatch(error.message, /pair-|relayPairId|deviceToken|token/i);
    return true;
  });
  assert.equal(closeCount, 1);
  assert.ok(Date.now() - started < 500);
});

test('FRA request settles promptly when the relay connection closes', async () => {
  let closeHandle;
  const closed = new Promise(resolve => { closeHandle = resolve; });
  const handle = { closed, request: () => new Promise(() => {}) };
  const started = Date.now();
  setTimeout(() => closeHandle(), 10);
  await assert.rejects(boundedRelayRequest(handle, 'GET', '/hub-lead/v1/health', {}, 500), error => {
    assert.equal(error.code, 'FRA_DISCONNECTED');
    assert.match(error.message, /reconnect and retry/i);
    return true;
  });
  assert.ok(Date.now() - started < 500);
});

test('FRA stream treats a disconnected peer as terminal instead of retrying the old stream', async () => {
  let closeHandle;
  const closed = new Promise(resolve => { closeHandle = resolve; });
  const handle = { closed, request: () => new Promise(() => {}), close() { closeHandle(); } };
  const call = async (method, pathname, options) => {
    if (pathname.endsWith('/open')) {
      return { status: 200, body: Buffer.from(JSON.stringify({ stream: '0123456789abcdef' })) };
    }
    return boundedRelayRequest(handle, method, pathname, options, 20);
  };
  const started = Date.now();
  await assert.rejects(pumpStream({ call, request: {}, stdin: new PassThrough(),
    stdout: new PassThrough(), stderr: new PassThrough() }), error => error.code === 'FRA_DISCONNECTED');
  assert.ok(Date.now() - started < 500);
});

test('persistent MCP reports a reset for an in-flight call and serves the next call after reattach',
  { timeout: 3000 }, async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const observed = [];
    const waiters = [];
    let outputBuffer = '';
    output.on('data', chunk => {
      outputBuffer += chunk.toString('utf8');
      for (;;) {
        const at = outputBuffer.indexOf('\n');
        if (at < 0) break;
        const line = outputBuffer.slice(0, at);
        outputBuffer = outputBuffer.slice(at + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        observed.push(message);
        for (let i = waiters.length - 1; i >= 0; i -= 1) {
          const waiter = waiters[i];
          if (!waiter.predicate(message)) continue;
          clearTimeout(waiter.timer);
          waiters.splice(i, 1);
          waiter.resolve(message);
        }
      }
    });
    const receive = predicate => {
      const index = observed.findIndex(predicate);
      if (index >= 0) return Promise.resolve(observed.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('MCP_TEST_RESPONSE_TIMEOUT'));
        }, 1000);
        waiters.push(waiter);
      });
    };
    const connections = [];
    const makeConnection = () => {
      const up = new PassThrough();
      const down = new PassThrough();
      let resolveClosed;
      const closed = new Promise(resolve => { resolveClosed = resolve; });
      let resolveInitialized;
      const initialized = new Promise(resolve => { resolveInitialized = resolve; });
      let resolvePendingCall;
      const pendingCallSeen = new Promise(resolve => { resolvePendingCall = resolve; });
      let buffer = '';
      up.setEncoding('utf8');
      up.on('data', text => {
        buffer += text;
        for (;;) {
          const at = buffer.indexOf('\n');
          if (at < 0) break;
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.method === 'initialize') {
            down.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id,
              result: { protocolVersion: '2025-06-18', capabilities: {} } })}\n`);
          } else if (message.method === 'notifications/initialized') resolveInitialized();
          else if (message.method === 'tools/call' && message.id === 2) resolvePendingCall();
          else if (message.method === 'tools/call' && message.id === 3) {
            down.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id,
              result: { content: [], isError: false } })}\n`);
          }
        }
      });
      up.once('end', () => resolveClosed(0));
      const connection = { up, down, closed, initialized, pendingCallSeen,
        leave() { resolveClosed(1); down.end(); } };
      connections.push(connection);
      return connection;
    };
    const running = keepSession({ connect: async () => makeConnection(), stdin: input, stdout: output,
      log() {}, sleep: async () => {}, signals: [] });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    await receive(message => message.id === 1);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    await connections[0].initialized;
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} })}\n`);
    await connections[0].pendingCallSeen;
    connections[0].leave();
    const reset = await receive(message => message.id === 2);
    assert.equal(reset.error?.code, RESET_ERROR);
    assert.match(reset.error?.message || '', /may or may not have completed/i);
    await connections[1].initialized;
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} })}\n`);
    const recovered = await receive(message => message.id === 3);
    assert.equal(recovered.result?.isError, false);
    assert.equal(connections.length, 2);
    input.end();
    await running;
  });
