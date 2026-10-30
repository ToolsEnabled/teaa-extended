'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileVault } = require('../vendor/hub/remote/fra-device.cjs');
const { fetchAccountJson } = require('../vendor/fra-core/src/lib/online-fra-account-response.js');
const PAIR = /^pair-[0-9a-f]{32}$/;
const DEVICE_TOKEN = /^dt_[A-Za-z0-9_-]{43}$/;

function exactAccountOrigin(value, allowInsecureLoopback) {
  let endpoint;
  try { endpoint = new URL(value); } catch { endpoint = null; }
  const loopback = endpoint && ['127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (!endpoint || (endpoint.protocol !== 'https:'
      && !(allowInsecureLoopback && loopback && endpoint.protocol === 'http:'))
      || endpoint.username || endpoint.password || endpoint.pathname !== '/'
      || endpoint.search || endpoint.hash || endpoint.origin !== value) {
    throw new Error('The account URL must be one exact HTTPS origin; HTTP is limited to explicitly enabled literal loopback.');
  }
  return endpoint;
}

function enrolledCredential({ state, fraCore, credentialProvider } = {}) {
  if (credentialProvider) return credentialProvider();
  if (typeof state !== 'string' || !path.isAbsolute(state)
      || typeof fraCore !== 'string' || !path.isAbsolute(fraCore)) {
    throw new Error('The enrolled device state or bundled FRA core is unavailable.');
  }
  if (!fs.existsSync(state)) throw new Error('This computer is not enrolled. Enroll it with teaa open and teaa accept first.');
  const { connectionState } = require(path.join(fraCore, 'src', 'lib', 'online-fra-device-claim.js'));
  return connectionState(fileVault(state));
}

async function discoverRelayPair({ accountUrl, state, fraCore, allowInsecureLoopback = false,
  fetchImpl = globalThis.fetch, credentialProvider } = {}) {
  const endpoint = exactAccountOrigin(accountUrl, allowInsecureLoopback);
  if (typeof fetchImpl !== 'function') throw new Error('The account connection lookup is unavailable in this Node.js runtime.');
  const credential = enrolledCredential({ state, fraCore, credentialProvider });
  if (!credential || credential.connected !== true || !PAIR.test(credential.pairId)
      || !DEVICE_TOKEN.test(credential.deviceToken)) {
    throw new Error('This computer is not enrolled. Enroll it with teaa open and teaa accept first.');
  }
  const target = new URL('/v1/devices/peers', endpoint);
  target.searchParams.set('pairId', credential.pairId);
  let answer;
  try {
    answer = await fetchAccountJson(target, { method: 'GET',
      headers: { accept: 'application/json', authorization: `Device ${credential.deviceToken}` },
      signal: AbortSignal.timeout(15_000) }, { fetchImpl, timeoutMs: 15_000 });
  } catch {
    throw new Error('The account connection lookup failed, returned invalid JSON, or timed out. Check the account URL and network, then retry.');
  }
  if (!answer || answer.status !== 200 || !answer.body) {
    throw new Error(`The account did not return this computer's connections (HTTP ${Number.isSafeInteger(answer?.status) ? answer.status : 'unknown'}).`);
  }
  const body=answer.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.peers)
      || body.peers.length > 16 || body.peers.some(peer => !peer || typeof peer !== 'object'
        || Array.isArray(peer) || !PAIR.test(peer.relayPairId))) {
    throw new Error('The account returned an invalid connection list.');
  }
  if (body.peers.length === 0) {
    throw new Error('No Hub connection is paired with this computer. Open the account page, connect Desk and Laptop, then retry.');
  }
  if (body.peers.length !== 1) {
    throw new Error('This computer has multiple Hub connections. Copy the desired relay pair ID from the account page and pass --relay-pair ID.');
  }
  return body.peers[0].relayPairId;
}

module.exports = { discoverRelayPair, validateAccountOrigin: exactAccountOrigin };
