'use strict';

// REMOTE LEAD MCP (runs on the owner's other machine). An agent CLI starts this
// as its MCP server; it opens one SSH stream to the Vultr hub bridge with this
// machine's own restricted key and passes stdio through, so the agent's MCP
// session is a hub orchestrator session.
//
// It reads which agent started it, and at what level, with this machine's own
// Fleet (permission-level.js findLead, the same code the hub runs), and tells
// the bridge. Nothing is stored; no credential is read or printed.
//
// config.json beside this file (written by enrol-machine.sh):
//   { "host": "user@address", "keyFile": "...", "knownHosts": "...",
//     "fleetRoot": "<Fleet package root or null>", "ssh": "<ssh binary or null>" }
// An agent this machine's Fleet does not bundle is read
// from the descriptors in <fleetStateRoot>/agents/, Fleet's own place for a
// person's added agents; fleetStateRoot defaults to fleet-state/ beside this file.
// Options: --tag ID (a second lead of the same agent on this machine),
//          --actor AGENT (only when Fleet cannot read the lead), --config FILE.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fileVault, readPrivateJsonFile, validatePrivateFilePath, appendPrivateTextFile,
  validateSecureOrigin } = require('./fra-device.cjs');

const WORD = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PAIR = /^pair-[0-9a-f]{32}$/;
const SSH_HOST = /^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9.:[\]-]{1,255}$/;
const CONTROL = /[\x00-\x1f\x7f]/;

// Diagnostics. An agent CLI usually discards an MCP server's stderr, so set
// FLEET_HUB_LEAD_LOG to a path to keep a copy of these same lines. No
// credential, token or payload is ever written here.
function note(text) {
  process.stderr.write(text);
  const file = process.env.FLEET_HUB_LEAD_LOG;
  if (!file) return;
  try { appendPrivateTextFile(file, `${new Date().toISOString()} pid=${process.pid} ppid=${process.ppid} ${text}`); } catch { /* diagnostics never block a lead */ }
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** The agent that started this process and its level, read by Fleet; null when unreadable. */
function readLead(fleetRoot, { stateRoot = path.join(__dirname, 'fleet-state'), startPid = process.ppid } = {}) {
  if (!fleetRoot) return { lead: null, reason: 'no Fleet package on this machine was configured' };
  try {
    const LEVELS = require(path.join(fleetRoot, 'src', 'lib', 'agents', 'permission-level.js'));
    const registry = require(path.join(fleetRoot, 'src', 'lib', 'agents', 'registry.js'))
      .activeRegistry({ ...process.env, TOOLSENABLED_STATE_ROOT: path.resolve(stateRoot) });
    const lead = LEVELS.findLead({ registry, startPid });
    return lead ? { lead } : { lead: null, reason: 'the process that started this is not a described agent CLI' };
  } catch (error) {
    return { lead: null, reason: `Fleet could not read the lead (${error.code || error.name})` };
  }
}

// A Fleet worker inherits its account's MCP servers, so a worker would start
// this too and become a hub lead. A worker's agent process carries Fleet's
// own environment, and a Fleet server or supervisor sits above it; a lead the
// owner started has neither. Returns the reason to refuse, or null.
const FLEET_ENV = ['TOOLSENABLED_STATE_ROOT', 'TOOLSENABLED_FLEET_PROFILE', 'TOOLSENABLED_RUNTIME_MODE'];
const FLEET_PROCESS = /(?:^|[\\/])(?:fleetV[2345]\.js|toolsenabled-host\.js|linux-process-supervisor\.py)$/;
function ownWindowsProcesses(pid) {
  try {
    const helper = require(path.resolve(__dirname, '../../../src/windows-process-observation.cjs'));
    return helper.readOwnWindowsProcesses({ startPid: pid });
  } catch { return null; }
}
function fleetWorker(pid, { platform = process.platform, readEnv = readEnviron, readArgv = readCmdline,
  readParent = parentOf, readProcesses = ownWindowsProcesses, envNames } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  if (platform === 'win32') {
    const names = envNames || Object.keys(process.env);
    const named = FLEET_ENV.find(name => names.includes(name));
    if (named) return `the agent that started this runs inside Fleet (${named})`;
    const rows = readProcesses(pid);
    if (!rows) return null;
    for (const [ancestor, row] of rows) {
      if (ancestor === pid || !Array.isArray(row.argv)) continue;
      const entry = row.argv.find(word => FLEET_PROCESS.test(word));
      if (entry) return `the agent that started this is a Fleet worker (pid ${ancestor} is ${path.basename(entry)})`;
    }
    return null;
  }
  const env = readEnv(pid);
  const named = env && FLEET_ENV.find(name => env.includes(name));
  if (named) return `the agent that started this runs inside Fleet (${named})`;
  let current = pid;
  for (let step = 0; step < 32; step += 1) {
    current = readParent(current);
    if (!Number.isInteger(current) || current <= 1) return null;
    const argv = readArgv(current) || [];
    if (argv.some(word => FLEET_PROCESS.test(word))) return `the agent that started this is a Fleet worker (pid ${current} is ${path.basename(argv.find(word => FLEET_PROCESS.test(word)))})`;
  }
  return null;
}
function readEnviron(pid) {
  try { return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').map(entry => entry.split('=')[0]); } catch { return null; }
}
function readCmdline(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { return null; }
}
function parentOf(pid) {
  try { return Number(/^PPid:\s*(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]); } catch { return null; }
}

function request({ actor, level, tag }) {
  if (typeof actor !== 'string' || !WORD.test(actor)
      || (tag !== undefined && (typeof tag !== 'string' || !WORD.test(tag)))
      || (level !== undefined && ![1, 2, 3, 4].includes(level))) {
    throw Object.assign(new Error('The remote lead identity is invalid.'), { code: 'REMOTE_LEAD_CONFIG_INVALID' });
  }
  return ['attach', `actor=${actor}`, ...(tag ? [`tag=${tag}`] : []), ...(level ? [`level=${level}`] : [])].join(' ');
}

function plainRecord(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, allowed) { return Object.keys(value).every(key => allowed.includes(key)); }
function absolutePath(value) { return typeof value === 'string' && path.isAbsolute(value) && !CONTROL.test(value); }
function boundedMs(value) { return Number.isSafeInteger(value) && value >= 1000 && value <= 120_000; }

function validateFraRoute(fra) {
  if (!plainRecord(fra) || !exactKeys(fra, ['accountUrl', 'origin', 'relayPairId', 'fraCore', 'state',
    'allowInsecureLoopback', 'handshakeTimeoutMs', 'callWaitMs'])) {
    throw Object.assign(new Error('The FRA route has unknown or invalid fields.'), { code: 'REMOTE_LEAD_CONFIG_INVALID' });
  }
  const allowInsecureLoopback = fra.allowInsecureLoopback ?? false;
  if (typeof allowInsecureLoopback !== 'boolean' || !absolutePath(fra.fraCore) || !absolutePath(fra.state)
      || !PAIR.test(fra.relayPairId)
      || (fra.handshakeTimeoutMs !== undefined && !boundedMs(fra.handshakeTimeoutMs))
      || (fra.callWaitMs !== undefined && !boundedMs(fra.callWaitMs))) {
    throw Object.assign(new Error('The FRA route values are invalid.'), { code: 'REMOTE_LEAD_CONFIG_INVALID' });
  }
  validateSecureOrigin(fra.accountUrl, allowInsecureLoopback, 'The FRA account URL');
  validateSecureOrigin(fra.origin ?? fra.accountUrl, allowInsecureLoopback, 'The FRA asserted Origin');
  return Object.freeze({ ...fra, origin: fra.origin ?? fra.accountUrl, allowInsecureLoopback });
}

function validateRemoteConfig(input) {
  if (!plainRecord(input) || !exactKeys(input, ['host', 'keyFile', 'knownHosts', 'fleetRoot', 'fleetStateRoot',
    'ssh', 'transports', 'fra'])) {
    throw Object.assign(new Error('The remote lead config has unknown or invalid fields.'), { code: 'REMOTE_LEAD_CONFIG_INVALID' });
  }
  const transports = input.transports ?? (input.fra ? ['fra', 'ssh'] : ['ssh']);
  if (!Array.isArray(transports) || transports.length < 1 || transports.length > 2
      || transports.some(kind => !['fra', 'ssh'].includes(kind)) || new Set(transports).size !== transports.length) {
    throw Object.assign(new Error('The remote lead transport list is invalid.'), { code: 'REMOTE_LEAD_CONFIG_INVALID' });
  }
  const fra = input.fra === undefined ? undefined : validateFraRoute(input.fra);
  if (transports.includes('fra') && !fra) throw Object.assign(new Error('The FRA transport has no route.'), { code: 'REMOTE_LEAD_CONFIG_INVALID' });
  if (input.fleetRoot !== null && input.fleetRoot !== undefined && !absolutePath(input.fleetRoot)) {
    throw Object.assign(new Error('The Fleet package path is invalid.'), { code: 'REMOTE_LEAD_CONFIG_INVALID' });
  }
  if (input.fleetStateRoot !== undefined && !absolutePath(input.fleetStateRoot)) {
    throw Object.assign(new Error('The Fleet state path is invalid.'), { code: 'REMOTE_LEAD_CONFIG_INVALID' });
  }
  if (input.ssh !== null && input.ssh !== undefined
      && (typeof input.ssh !== 'string' || input.ssh.length < 1 || input.ssh.length > 1024 || CONTROL.test(input.ssh)
        || (input.ssh !== 'ssh' && !path.isAbsolute(input.ssh)))) {
    throw Object.assign(new Error('The SSH executable is invalid.'), { code: 'REMOTE_LEAD_CONFIG_INVALID' });
  }
  if (transports.includes('ssh')) {
    if (typeof input.host !== 'string' || !SSH_HOST.test(input.host) || input.host.startsWith('-')
        || !absolutePath(input.keyFile) || !absolutePath(input.knownHosts)) {
      throw Object.assign(new Error('The SSH fallback config is invalid.'), { code: 'REMOTE_LEAD_CONFIG_INVALID' });
    }
    validatePrivateFilePath(input.keyFile, 1024 * 1024);
    validatePrivateFilePath(input.knownHosts, 1024 * 1024);
  }
  return Object.freeze({ ...input, transports: Object.freeze([...transports]), ...(fra ? { fra } : {}) });
}

async function main(argv) {
  const configFile = option(argv, '--config') || path.join(__dirname, 'config.json');
  const config = validateRemoteConfig(readPrivateJsonFile(configFile));
  const { lead, reason } = readLead(config.fleetRoot || null, config.fleetStateRoot ? { stateRoot: config.fleetStateRoot } : {});
  const actor = lead ? lead.agentId : option(argv, '--actor');
  if (!actor) {
    note(`[remote-lead-mcp] refused: cannot tell which agent started this (${reason}); pass --actor.\n`);
    process.exit(2);
  }
  if (!lead) note(`[remote-lead-mcp] lead level not reported: ${reason}.\n`);
  const worker = fleetWorker(lead ? lead.pid : process.ppid);
  if (worker) {
    note(`[remote-lead-mcp] refused: ${worker}; only a lead the owner started may join the hub.\n`);
    process.exit(2);
  }
  const tag = option(argv, '--tag') || process.env.FLEET_HUB_LEAD_TAG || undefined;
  const level = lead ? lead.level : undefined;
  request({ actor, level, tag }); // fail before opening either transport
  const transports = config.transports;
  const wanted = { actor, level, tag };
  const relay = transports.includes('fra') && config.fra ? fraRelay(config.fra) : null;
  const connect = async () => {
    let failure = null;
    for (const kind of transports) {
      try {
        if (kind === 'fra' && relay) return await fraConnector(relay, wanted);
        if (kind === 'ssh') return sshConnector(config, wanted);
      } catch (error) {
        failure = error;
        note(`[remote-lead-mcp] ${kind} attach failed (${error.code || error.message}).\n`);
      }
    }
    throw failure || Object.assign(new Error('no usable transport configured'), { code: 'NO_TRANSPORT' });
  };
  const code = await keepSession({ connect, stdin: process.stdin, stdout: process.stdout });
  if (relay) relay.stop();
  // Windows pipes write asynchronously: flush before leaving.
  await new Promise(resolve => process.stdout.write('', resolve));
  process.exit(code ?? 0);
}

/* A Hub restart ends every attached session, and some agent CLIs do not
 * restart an MCP server that exits. Keep the agent's stdio open across Hub
 * sessions. Calls that were in flight when a session
 * ended get an error (they may or may not have run); calls made while the hub is
 * away wait. On re-attach the agent's own initialize handshake is replayed, and
 * its answer is kept from the agent, which has already been initialized once.
 * connect() resolves to { up, down, closed, leave } or throws; it is retried
 * with backoff for as long as the agent keeps its input open. */
const RESET_ERROR = -32001;
const FRA_REQUEST_TIMEOUT_MS = 25_000; // FRA stream output polls last 20 seconds.
function fraDisconnected(message) {
  return Object.assign(new Error(message), { code: 'FRA_DISCONNECTED' });
}
function boundedRelayRequest(handle, method, pathname, options, timeoutMs = FRA_REQUEST_TIMEOUT_MS) {
  let timer;
  const closed = Promise.resolve(handle.closed).then(
    () => { throw fraDisconnected('The FRA relay connection closed while a Hub request was in flight; reconnect and retry after checking its state.'); },
    () => { throw fraDisconnected('The FRA relay connection closed while a Hub request was in flight; reconnect and retry after checking its state.'); });
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(fraDisconnected('The Hub did not answer over FRA before the bounded request deadline; this call may or may not have completed. Check its state, then retry after reconnect.'));
      try { handle.close?.(); } catch { /* the relay is already gone */ }
    }, timeoutMs);
  });
  return Promise.race([
    Promise.resolve().then(() => handle.request(method, pathname, options)),
    closed,
    deadline,
  ]).finally(() => clearTimeout(timer));
}
function keepSession({ connect, stdin, stdout, log = note, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  maxWaitMs = 15_000, signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] }) {
  return new Promise(resolveSession => {
    let initialize = null;   // the agent's own initialize request
    let initialized = null;  // its notifications/initialized line
    let current = null;      // the attached hub session
    let inputEnded = false;
    let finished = false;
    let reattaching = false;
    let replays = 0;
    const inFlight = new Set();
    const queued = [];
    const parse = line => { try { return JSON.parse(line); } catch { return null; } };
    const finish = code => { if (!finished) { finished = true; resolveSession(code); } };
    const lines = (stream, onLine) => {
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', text => {
        buffer += text;
        for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
          const line = buffer.slice(0, at).replace(/\r$/, '');
          buffer = buffer.slice(at + 1);
          if (line.trim()) onLine(line);
        }
      });
    };
    const send = line => {
      const message = parse(line);
      if (message && message.method && message.id !== undefined) inFlight.add(message.id);
      current.up.write(`${line}\n`);
    };
    lines(stdin, line => {
      const message = parse(line);
      if (message && message.method === 'initialize' && message.id !== undefined) initialize = message;
      if (message && message.method === 'notifications/initialized') initialized = line;
      if (current) send(line); else queued.push(line);
    });
    const endInput = () => {
      if (inputEnded) return;
      inputEnded = true;
      if (!current) { finish(0); return; }
      try { current.leave?.(); } catch { /* gone */ }
      try { current.up.end(); } catch { /* gone */ }
    };
    stdin.once('end', endInput);
    for (const signal of signals) {
      try { process.once(signal, () => { endInput(); setTimeout(() => finish(0), 3000).unref?.(); }); } catch { /* not on this platform */ }
    }
    const drop = connection => {
      try { connection.leave?.(); } catch { /* gone */ }
      try { connection.up.end(); } catch { /* gone */ }
    };
    const attach = async again => {
      const next = await connect();
      let replayId = null;
      let markReplayed = () => {};
      const replayed = new Promise(resolve => { markReplayed = resolve; });
      lines(next.down, line => {
        const message = parse(line);
        if (message && replayId !== null && message.id === replayId) { markReplayed(message); return; }
        if (message && message.id !== undefined && !message.method) inFlight.delete(message.id);
        stdout.write(`${line}\n`);
      });
      next.closed.then(code => onClosed(next, code));
      if (again && initialize) {
        replays += 1;
        replayId = `remote-lead-replay-${replays}`;
        next.up.write(`${JSON.stringify({ ...initialize, id: replayId })}\n`);
        const answer = await Promise.race([replayed, next.closed.then(() => null)]);
        if (!answer || answer.error) {
          drop(next);
          throw Object.assign(new Error(answer ? `hub refused the replayed handshake: ${answer.error.message}` : 'hub session ended during the handshake'), { code: 'REPLAY_FAILED' });
        }
        if (initialized) next.up.write(`${initialized}\n`);
      }
      if (inputEnded) { drop(next); return; }
      current = next;
      if (again) log('[remote-lead-mcp] re-attached to the hub; the agent session continues.\n');
      while (queued.length && current === next) send(queued.shift());
    };
    const reattach = async () => {
      if (reattaching) return;
      reattaching = true;
      try {
        for (let wait = 1000; !inputEnded; wait = Math.min(wait * 2, maxWaitMs)) {
          try { await attach(true); return; } catch (error) {
            log(`[remote-lead-mcp] re-attach failed (${error.code || error.message}); retrying in ${Math.round(wait / 1000)} s.\n`);
            await sleep(wait);
          }
        }
        finish(0);
      } finally { reattaching = false; }
    };
    const onClosed = (connection, code) => {
      if (current !== connection) return;
      current = null;
      if (inputEnded) { finish(code); return; }
      for (const id of inFlight) {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: RESET_ERROR,
          message: 'The Fleet Hub session was reset after a Hub restart or relay interruption. This call may or may not have completed; check its state, then retry after the Hub reconnects.' } })}\n`);
      }
      inFlight.clear();
      log(`[remote-lead-mcp] hub session ended (exit ${code}); re-attaching.\n`);
      reattach();
    };
    attach(false).catch(error => {
      log(`[remote-lead-mcp] attach failed (${error.code || error.message}); retrying.\n`);
      reattach();
    });
  });
}

/* The stream must carry THIS machine's dedicated key, the only one the hub
 * answers with the bridge. `-i` alone does not guarantee that: a Host block in
 * the user's ssh_config, or a key in their agent, is offered first and the hub
 * then gives that key its ordinary shell, which answers the attach request with
 * "attach: command not found". A user SSH host rule or agent key can be
 * offered before this dedicated key. Leave both out: -F none needs OpenSSH
 * 8.0 (2019) or newer. */
function sshArgs(config, { actor, level, tag }) {
  return ['-F', 'none', '-T', '-i', config.keyFile,
    '-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
    '-o', `UserKnownHostsFile=${config.knownHosts}`, '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', '-o', 'ConnectTimeout=20',
    config.host, request({ actor, level, tag })];
}

function sshConnector(config, wanted) {
  const child = spawn(config.ssh || 'ssh', sshArgs(config, wanted), { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const closed = new Promise(resolve => {
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on('error', error => { note(`[remote-lead-mcp] could not start ssh (${error.code}).\n`); resolve(2); });
  });
  child.stdin.on('error', () => {});
  note('[remote-lead-mcp] attaching over SSH.\n');
  return { up: child.stdin, down: child.stdout, closed, leave: () => { try { child.kill('SIGTERM'); } catch { /* gone */ } } };
}

/* The FRA route: this machine's own enrolled FRA device opens the relay pair
   it shares with the Vultr gateway; each hub session is one fra-stream over it.
   The relay connection survives relay reconnects and lease ends. */
function fraRelay(fra) {
  const lib = name => require(path.join(fra.fraCore, 'src', 'lib', name));
  const { createRelayShell } = lib('online-fra-relay-shell.js');
  const vault = fileVault(fra.state);
  const relayUrl = `${fra.accountUrl.startsWith('https:') ? 'wss' : 'ws'}://${new URL(fra.accountUrl).host}/v1/rendezvous`;
  const refuseAll = { fetch: async () => { const bytes = Buffer.from('{"error":"NOT_SERVED"}'); return { status: 404, headers: { 'content-type': 'application/json' }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }; } };
  let handle = null;
  let renewTimer = null;
  let stopping = false;
  let reconnecting = null;
  const connect = async () => {
    const shell = createRelayShell({ accountOrigin: fra.accountUrl, relayUrl, vault, localBridge: refuseAll, origin: fra.origin || fra.accountUrl,
      allowInsecureLoopback: fra.allowInsecureLoopback ?? false,
      handshakeTimeoutMs: fra.handshakeTimeoutMs ?? 20_000 });
    const next = await shell.connectToPeer({ relayPairId: fra.relayPairId });
    await next.handshake;
    handle = next;
    const scheduleRenew = () => {
      clearTimeout(renewTimer);
      renewTimer = setTimeout(async () => {
        try { await next.renewLease(); scheduleRenew(); } catch { next.close(); }
      }, Math.max(5_000, next.leaseExpiresAtMs - Date.now() - 90_000));
      renewTimer.unref?.();
    };
    scheduleRenew();
    next.closed.then(() => { if (handle === next) handle = null; if (!stopping) reconnect(); });
  };
  const reconnect = () => {
    if (reconnecting) return reconnecting;
    reconnecting = (async () => {
      for (let wait = 1000; !stopping; wait = Math.min(wait * 2, 15_000)) {
        try { await connect(); note('[remote-lead-mcp] FRA relay reconnected.\n'); return; }
        catch { await new Promise(resolve => setTimeout(resolve, wait)); }
      }
    })().finally(() => { reconnecting = null; });
    return reconnecting;
  };
  // Never wait on the relay without limit: when it is unreachable, the call
  // fails so the caller can fall back to SSH or retry, and says why.
  const call = async (method, pathname, body) => {
    if (!handle) {
      if (reconnecting) await Promise.race([reconnecting, new Promise(resolve => setTimeout(resolve, fra.callWaitMs ?? 20_000).unref?.())]);
      else {
        try { await connect(); } catch (error) {
          note(`[remote-lead-mcp] FRA relay unreachable (${error.code || error.message}).\n`);
          throw Object.assign(new Error('no relay connection'), { code: 'FRA_DISCONNECTED' });
        }
      }
      if (!handle) throw Object.assign(new Error('no relay connection'), { code: 'FRA_DISCONNECTED' });
    }
    const current = handle;
    return boundedRelayRequest(current, method, pathname,
      body === undefined ? {} : { body, headers: { 'content-type': 'application/octet-stream' } });
  };
  const stop = () => { stopping = true; clearTimeout(renewTimer); try { handle?.close(); } catch { /* gone */ } };
  return { call, stop };
}

async function fraCompatibility(relay, wanted) {
  const { PREFIX } = require(path.join(__dirname, 'fra-stream.cjs'));
  const query = new URLSearchParams({ actor: wanted.actor });
  if (wanted.tag) query.set('tag', wanted.tag);
  if (wanted.level) query.set('level', String(wanted.level));
  const response = await relay.call('GET', `${PREFIX}/compatibility?${query}`);
  if (!response || response.status !== 200 || !Buffer.isBuffer(response.body) || response.body.length > 4096) {
    throw Object.assign(new Error('The selected FRA gateway did not provide a valid compatibility claim.'),
      { code: 'HUB_FLEET_PAIR_MISMATCH' });
  }
  let claim;
  try { claim = JSON.parse(response.body.toString('utf8')); } catch {
    throw Object.assign(new Error('The selected FRA gateway returned an invalid compatibility claim.'),
      { code: 'HUB_FLEET_PAIR_MISMATCH' });
  }
  const keys = ['adapterId', 'adapterSchema', 'generation', 'fleetVersion', 'fleetIdentitySha256', 'hubVersion', 'capabilities'];
  if (!plainRecord(claim) || Object.keys(claim).length !== keys.length || Object.keys(claim).some(key => !keys.includes(key))
      || claim.adapterId !== 'fra-hub' || !Number.isSafeInteger(claim.adapterSchema) || claim.adapterSchema < 1
      || !Number.isSafeInteger(claim.generation) || claim.generation < 1
      || typeof claim.fleetVersion !== 'string' || typeof claim.hubVersion !== 'string'
      || typeof claim.fleetIdentitySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(claim.fleetIdentitySha256)
      || !Array.isArray(claim.capabilities) || claim.capabilities.length < 1 || claim.capabilities.length > 16
      || claim.capabilities.some(value => typeof value !== 'string')) {
    throw Object.assign(new Error('The selected FRA gateway returned an invalid compatibility claim.'),
      { code: 'HUB_FLEET_PAIR_MISMATCH' });
  }
  return claim;
}

async function fraConnector(relay, { actor, level, tag }) {
  const { PassThrough } = require('node:stream');
  const { pumpStream } = require(path.join(__dirname, 'fra-stream.cjs'));
  const compatibility = await fraCompatibility(relay, { actor, level, tag });
  const up = new PassThrough();
  const down = new PassThrough();
  let markOpen = () => {};
  const opened = new Promise(resolve => { markOpen = resolve; });
  const pumping = pumpStream({ call: relay.call, request: { actor, ...(tag ? { tag } : {}), ...(level ? { level } : {}), compatibility },
    stdin: up, stdout: down, stderr: process.stderr, onOpened: markOpen });
  pumping.catch(() => {});
  const id = await Promise.race([opened, pumping.then(code => {
    throw Object.assign(new Error(`stream ended before it opened (exit ${code})`), { code: 'STREAM_NOT_OPENED' });
  })]);
  note('[remote-lead-mcp] attached over FRA (private relay, end-to-end sealed).\n');
  const closed = pumping.catch(error => { note(`[remote-lead-mcp] FRA stream failed (${error.code || error.message}).\n`); return 2; });
  return { up, down, closed, leave: () => relay.call('POST', `/hub-lead/v1/s/${id}/close`).catch(() => {}) };
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { note(`[remote-lead-mcp] ${error.message}\n`); process.exit(2); });
module.exports = { request, readLead, fleetWorker, sshArgs, keepSession, RESET_ERROR, fraRelay, fraConnector, fraCompatibility, main,
  sshConnector, validateRemoteConfig, boundedRelayRequest };
