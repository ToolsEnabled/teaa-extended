'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fraConnector, validateRemoteConfig } = require('../vendor/hub/remote/remote-lead-mcp.cjs');
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
