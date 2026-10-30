'use strict';

// FRA Hub gateway. It opens an outbound relay connection for each enrolled
// machine and serves the FRA stream protocol over that connection. It does
// not expose a listener reachable from other machines.
// connection runs hub-lead-bridge.cjs --machine M: the machine name comes from
// WHICH authenticated relay pair carried the request (sealed end to end with
// that machine's pinned identity key), never from anything the machine sends.
//
//   node fra-gateway.cjs [--config var/fra/gateway.json]
//
// gateway.json: { fraCore, state, accountUrl, origin, tunnel: { ssh: [...], localPort, remotePort },
//                 bridgeConfig, machines: { "<relayPairId>": "<machine>" } }

const path = require('node:path');
const { spawn } = require('node:child_process');
const { createStreamServer } = require('../remote/fra-stream.cjs');
const { fileVault, readPrivateJsonFile, appendPrivateTextFile, validateSecureOrigin } = require('../remote/fra-device.cjs');
const { selectors, selectedPair, assertClaim, mismatch } = require('./gateway-compatibility.cjs');

const ROOT = path.join(__dirname, '..');
const MACHINE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const ACTOR = /^[a-z][a-z0-9-]{0,31}$/;
const TAG = /^[a-z0-9][a-z0-9-]{0,15}$/;
const PAIR = /^pair-[0-9a-f]{32}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function option(argv, name, fallback) { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : fallback; }

function logger(file) {
  return row => {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`;
    try { appendPrivateTextFile(file, line); } catch { process.stderr.write(line); }
  };
}

/** The one request a stream may make, re-spelled for the bridge (which checks it again). */
function attachText(request, { allowCompatibility = false } = {}) {
  const allowed = allowCompatibility ? ['actor', 'level', 'tag', 'compatibility'] : ['actor', 'level', 'tag'];
  if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).some(key => !allowed.includes(key))
      || typeof request.actor !== 'string' || !ACTOR.test(request.actor)) {
    throw Object.assign(new Error('actor'), { code: 'STREAM_REQUEST_INVALID' });
  }
  if (request.tag !== undefined && (typeof request.tag !== 'string' || !TAG.test(request.tag))) throw Object.assign(new Error('tag'), { code: 'STREAM_REQUEST_INVALID' });
  if (request.level !== undefined && ![1, 2, 3, 4].includes(request.level)) throw Object.assign(new Error('level'), { code: 'STREAM_REQUEST_INVALID' });
  return ['attach', `actor=${request.actor}`, ...(request.tag ? [`tag=${request.tag}`] : []), ...(request.level ? [`level=${request.level}`] : [])].join(' ');
}

function startTunnel(config, log) {
  let child = null;
  let stopping = false;
  let restartTimer = null;
  const retry = () => {
    if (!stopping && !restartTimer) restartTimer = setTimeout(() => { restartTimer = null; run(); }, 3000);
  };
  const run = () => {
    const { ssh, localPort, remotePort } = config.tunnel;
    child = spawn(ssh[0], [...ssh.slice(1, -1), '-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, ssh[ssh.length - 1]], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', chunk => log({ tunnel: String(chunk).trim().slice(0, 200) }));
    child.once('error', error => { log({ tunnel: 'start-failed', code: error.code || error.name }); retry(); });
    child.once('exit', code => { log({ tunnel: 'exited', code }); retry(); });
  };
  run();
  return { stop: () => { stopping = true; clearTimeout(restartTimer); child?.kill('SIGTERM'); } };
}

async function healthCheck(url) {
  // Current self-hosted and hosted account services expose /v1/health. Keep
  // /healthz as a fallback for an older account front door during migration.
  for (const route of ['/v1/health', '/healthz']) {
    try {
      const response = await fetch(`${url}${route}`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) return true;
      if (response.status !== 404 && response.status !== 405) return false;
    } catch { /* try the legacy route, then retry the front door */ }
  }
  return false;
}

async function waitHealthy(url, log) {
  for (let attempt = 0; ; attempt += 1) {
    if (await healthCheck(url)) return;
    if (attempt % 30 === 29) log({ waiting: 'front door not answering yet' });
    await sleep(1000);
  }
}

// Constructed only for a machine selected by its authenticated relay pair.
// No HTTP listener is created.  A compatibility claim is mandatory and is
// checked against the current server-owned route before any child exists.
function createGatewayServer({ relayPairId = '', machine, config, log = () => {}, spawnSession }) {
  return createStreamServer({
    log: row => log({ machine, ...row }),
    compatibility: url => {
      const request = selectors(url);
      attachText(request);
      return selectedPair(config.bridgeConfig, machine, request, attachText);
    },
    validateOpen: request => {
      const text = attachText(request, { allowCompatibility: true });
      if (!Object.hasOwn(request, 'compatibility')) {
        throw mismatch('complete compatibility claim required');
      }
      const actual = selectedPair(config.bridgeConfig, machine, request, value => attachText(value, { allowCompatibility: true }));
      assertClaim(actual, request.compatibility);
      return Object.freeze({ text, compatibility: actual });
    },
    spawnSession: spawnSession || ((request, validated) => spawn(process.execPath,
      [path.join(ROOT, 'bin', 'hub-lead-bridge.cjs'), '--machine', machine, '--config', config.bridgeConfig],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
        SSH_ORIGINAL_COMMAND: validated.text,
        SSH_CONNECTION: `fra ${relayPairId.slice(0, 12)}`,
        FLEET_HUB_COMPATIBILITY_CLAIM: JSON.stringify(validated.compatibility) } })),
  });
}

async function servePair({ relayPairId, machine, config, lib, vault, log }) {
  const { createRelayShell } = lib('online-fra-relay-shell.js');
  const relayUrl = `${config.accountUrl.startsWith('https:') ? 'wss' : 'ws'}://${new URL(config.accountUrl).host}/v1/rendezvous`;
  const server = createGatewayServer({ relayPairId, machine, config, log });
  for (let backoff = 1000; ; backoff = Math.min(backoff * 2, 30_000)) {
    let handle = null;
    let renewTimer = null;
    try {
      const shell = createRelayShell({ accountOrigin: config.accountUrl, relayUrl, vault, origin: config.origin,
        allowInsecureLoopback: config.allowInsecureLoopback,
        localBridge: { fetch: server.fetch },
        eventSink: event => { if (/closed|failed|renew|admitted|handshake/.test(String(event?.kind))) log({ machine, relay: event.kind, ...(event.leg ? { leg: event.leg } : {}) }); } });
      handle = await shell.connectToPeer({ relayPairId });
      log({ machine, connected: handle.role });
      backoff = 1000;
      const scheduleRenew = () => {
        const wait = Math.max(5_000, handle.leaseExpiresAtMs - Date.now() - 90_000);
        renewTimer = setTimeout(async () => {
          try { await handle.renewLease(); log({ machine, leaseRenewed: true }); scheduleRenew(); }
          catch (error) { log({ machine, leaseRenewFailed: error.code || error.name || 'RELAY_RENEW_FAILED' }); handle.close(); }
        }, wait);
      };
      scheduleRenew();
      await handle.closed;
      log({ machine, disconnected: true });
    } catch (error) {
      log({ machine, connectFailed: error.code || error.name || 'GATEWAY_CONNECT_FAILED' });
    } finally { clearTimeout(renewTimer); }
    await sleep(backoff);
  }
}

function plainRecord(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, allowed) { return Object.keys(value).every(key => allowed.includes(key)); }
function absolutePath(value) { return typeof value === 'string' && path.isAbsolute(value) && !CONTROL.test(value); }
function boundedPort(value) { return Number.isSafeInteger(value) && value >= 1 && value <= 65535; }

function validateGatewayConfig(input, configFile) {
  if (!plainRecord(input) || !exactKeys(input, ['fraCore', 'state', 'accountUrl', 'origin', 'tunnel',
    'bridgeConfig', 'log', 'machines', 'gatewayPairId', 'allowInsecureLoopback'])) {
    throw Object.assign(new Error('The FRA gateway config has unknown or invalid fields.'), { code: 'GATEWAY_CONFIG_INVALID' });
  }
  const allowInsecureLoopback = input.allowInsecureLoopback ?? false;
  if (typeof allowInsecureLoopback !== 'boolean') throw Object.assign(new Error('The FRA gateway transport flag is invalid.'), { code: 'GATEWAY_CONFIG_INVALID' });
  validateSecureOrigin(input.accountUrl, allowInsecureLoopback, 'The gateway account URL');
  validateSecureOrigin(input.origin, allowInsecureLoopback, 'The gateway asserted Origin');
  if (!absolutePath(input.fraCore) || !absolutePath(input.state) || !absolutePath(input.bridgeConfig)
      || (input.log !== undefined && !absolutePath(input.log))) {
    throw Object.assign(new Error('The FRA gateway paths must be absolute and printable.'), { code: 'GATEWAY_CONFIG_INVALID' });
  }
  if (input.gatewayPairId !== undefined && !PAIR.test(input.gatewayPairId)) {
    throw Object.assign(new Error('The FRA gateway pair id is invalid.'), { code: 'GATEWAY_CONFIG_INVALID' });
  }
  if (!plainRecord(input.machines)) throw Object.assign(new Error('The FRA gateway machine map is invalid.'), { code: 'GATEWAY_CONFIG_INVALID' });
  const machines = Object.entries(input.machines);
  if (machines.length < 1 || machines.length > 64
      || machines.some(([pair, machine]) => !PAIR.test(pair) || typeof machine !== 'string' || !MACHINE.test(machine))
      || new Set(machines.map(([, machine]) => machine)).size !== machines.length) {
    throw Object.assign(new Error('Every FRA gateway machine must have one canonical pair and unique name.'), { code: 'GATEWAY_CONFIG_INVALID' });
  }
  if (input.tunnel !== undefined && input.tunnel !== null) {
    const tunnel = input.tunnel;
    if (!plainRecord(tunnel) || !exactKeys(tunnel, ['ssh', 'localPort', 'remotePort'])
        || !Array.isArray(tunnel.ssh) || tunnel.ssh.length < 2 || tunnel.ssh.length > 32
        || tunnel.ssh.some(word => typeof word !== 'string' || word.length < 1 || word.length > 1024 || CONTROL.test(word))
        || tunnel.ssh[0].startsWith('-') || tunnel.ssh.at(-1).startsWith('-')
        || !boundedPort(tunnel.localPort) || !boundedPort(tunnel.remotePort)) {
      throw Object.assign(new Error('The FRA gateway tunnel config is invalid.'), { code: 'GATEWAY_CONFIG_INVALID' });
    }
  }
  return Object.freeze({ ...input, allowInsecureLoopback,
    log: input.log || path.join(path.dirname(configFile), 'gateway.log'), machines: Object.freeze(Object.fromEntries(machines)) });
}

async function main(argv) {
  const configFile = option(argv, '--config', path.join(ROOT, 'var', 'fra', 'gateway.json'));
  const config = validateGatewayConfig(readPrivateJsonFile(configFile), configFile);
  const log = logger(config.log);
  const lib = name => require(path.join(config.fraCore, 'src', 'lib', name));
  const vault = fileVault(config.state);
  const machines = Object.entries(config.machines);
  const tunnel = config.tunnel ? startTunnel(config, log) : null;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { log({ stopping: signal }); tunnel?.stop(); setTimeout(() => process.exit(0), 300); });
  await waitHealthy(config.accountUrl, log);
  log({ started: true, machines: machines.map(([, machine]) => machine) });
  await Promise.all(machines.map(([relayPairId, machine]) => servePair({ relayPairId, machine, config, lib, vault, log })));
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { process.stderr.write(`fra-gateway: ${error.message}\n`); process.exit(1); });
module.exports = { attachText, createGatewayServer, validateGatewayConfig, healthCheck, waitHealthy };
