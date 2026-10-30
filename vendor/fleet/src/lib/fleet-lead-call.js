'use strict';

// One attachment, sequential requests, and deliberately no reconnect or retry.
const path = require('node:path');
const recovery = require('./fleet-recovery');
const invalid = message => Object.assign(new Error(message), { code: 'FLEET_CALL_INPUT_INVALID', fleetRefusal: true });

function parse(argv) {
  const options = { timeout: 60 }, positional = [], seen = new Set();
  const names = { '--state-root': 'stateRoot', '--actor': 'actor', '--tree-key': 'treeKey', '--name': 'name', '--timeout': 'timeout' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--')) { positional.push(flag); continue; }
    if (seen.has(flag)) throw invalid(`Supply ${flag} once.`);
    seen.add(flag);
    if (flag === '--admin') { options.admin = true; continue; }
    if (flag === '--batch') { options.batch = true; continue; }
    if (!names[flag] || !argv[i + 1] || argv[i + 1].startsWith('--')) throw invalid(`Unknown option or missing value: ${flag}`);
    options[names[flag]] = argv[++i];
  }
  if (!options.stateRoot || !path.isAbsolute(options.stateRoot) || !options.actor) throw invalid('Call requires --state-root ABS and --actor PROVIDER.');
  options.timeout = Number(options.timeout);
  if (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout * 1000 > 2147483647) throw invalid('--timeout must be positive seconds within the timer range.');
  if (options.batch ? positional.length : positional.length < 1 || positional.length > 2) throw invalid('Supply TOOL [JSON_ARGS | -], or --batch with calls on stdin.');
  return { ...options, tool: positional[0], json: positional[1] };
}

async function callsFrom(options) {
  let json = options.json;
  if (options.batch || json === '-') {
    process.stdin.setEncoding('utf8');
    json = '';
    for await (const chunk of process.stdin) json += chunk;
  }
  let calls;
  try { calls = options.batch ? JSON.parse(json) : [{ tool: options.tool, arguments: json === undefined ? {} : JSON.parse(json) }]; }
  catch { throw invalid('Supply valid JSON arguments, or a JSON array of {tool, arguments} for --batch.'); }
  if (!Array.isArray(calls) || !calls.every(call => call && typeof call.tool === 'string' && call.tool.trim()
      && call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
      && Object.keys(call).every(key => ['tool', 'arguments'].includes(key)))) throw invalid('Each call requires a tool name and an arguments object.');
  return calls;
}

function session(socket, rest) {
  let sequence = 0, pending = null, failure = null, buffer = rest;
  function fail(error) { failure = error; if (pending) { const request = pending; pending = null; request.reject(error); } }
  function drain() {
    if (buffer.length > 16 * 1024 * 1024) { fail(new Error('MCP response exceeds transport bound.')); socket.destroy(); return; }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { fail(new Error('Invalid MCP response.')); socket.destroy(); return; }
      if (pending && message.id === pending.id) { const request = pending; pending = null; request.resolve(message); }
    }
  }
  socket.on('data', chunk => { buffer += chunk; drain(); });
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('Fleet transport closed.')));
  socket.on('end', () => fail(new Error('Fleet transport ended.')));
  drain();
  return {
    request(method, params) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending = { id, resolve, reject };
        socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    initialized() { socket.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); }
  };
}

function refusal(details, tool) {
  const code = details.code || 'FLEET_OPERATION_REFUSED';
  const message = details.message || details.reason || 'Fleet refused the call.';
  const nextAction = recovery.message(code, message, { tool }).split(' Next: ').at(-1);
  return { ...details, code, message, nextAction: details.nextAction || nextAction };
}
function resultOf(response, tool) {
  if (response.error) throw Object.assign(new Error(response.error.message || 'MCP refused the request.'), { fleetRefusal: true, details: response.error });
  const result = response.result;
  if (!result || !Object.hasOwn(result, 'structuredContent')) throw new Error('Fleet returned no structured MCP result.');
  const value = result.structuredContent;
  if (result.isError || value?.error || value?.ok === false || value?.accepted === false || ['refused', 'unsupported', 'skipped'].includes(value?.status)) {
    const details = value?.error || value || {};
    throw Object.assign(new Error(details.message || details.reason || 'Fleet refused the call.'), { fleetRefusal: true, details: refusal(details, tool) });
  }
  return value;
}

async function run(argv, product) {
  let socket, timer;
  const print = value => process.stdout.write(JSON.stringify(value) + '\n');
  try {
    const options = parse(argv);
    require('./fleet-v5-surface').validateAdmin(product.generation, options.admin);
    const calls = await callsFrom(options);
    const runtime = require('./host-runtime');
    // Match serve's sealed standalone configuration and provider validation.
    let config;
    try {
      config = runtime.readHostConfig(options.stateRoot);
      if ((config.generation || 2) !== product.generation) throw Object.assign(new Error('Use the matching Fleet generation for this state.'), { code: 'FLEET_GENERATION_MISMATCH' });
      if (config.profile !== 'fleetV2' || config.setupKind === 'plugin' || (!config.fleetV2Scope && config.fleetV2Security !== 'inherited-environment')) throw invalid('Call requires a standalone Fleet installation.');
      const registry = require('./agents/registry').activeRegistry({ ...process.env, TOOLSENABLED_STATE_ROOT: path.join(config.stateRoot, 'capability') });
      if (options.actor !== 'local' && !registry.has(options.actor)) throw invalid('Actor must be a described provider or local.');
    } catch (error) { error.fleetRefusal = true; throw error; }
    const controller = new AbortController();
    const deadlineAt = performance.now() + options.timeout * 1000;
    timer = setTimeout(() => controller.abort(new Error('Fleet call deadline exceeded.')), options.timeout * 1000);
    const attached = await require('./fleet-hub').openAttachment({ config, actor: options.actor, treeKey: options.treeKey || null,
      name: options.name || `call-${process.pid}-${require('node:crypto').randomBytes(6).toString('hex')}`,
      entry: product.entry, signal: controller.signal, deadlineAt, ...(options.admin ? { admin: true } : {}) });
    socket = attached.socket;
    const rpc = session(socket, attached.rest);
    const initialized = await rpc.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: `${product.name}-call`, version: product.metadata.version } });
    if (initialized.error) throw Object.assign(new Error(initialized.error.message), { fleetRefusal: true, details: initialized.error });
    if (!initialized.result?.serverInfo) throw new Error('Invalid MCP initialization response.');
    rpc.initialized();
    const call = async (tool, args) => resultOf(await rpc.request('tools/call', { name: tool, arguments: args }), tool);
    for (const entry of calls) {
      let args = entry.arguments;
      if (args.expectedRevision === 'latest') {
        const read = await call('fleet.control', { action: 'read', ...(args.nodeId ? { nodeId: args.nodeId } : {}) });
        if (!Number.isSafeInteger(read.revision)) throw new Error('Fleet read returned no control revision.');
        args = { ...args, expectedRevision: read.revision };
      }
      print(await call(entry.tool, args));
    }
  } catch (error) {
    if (error.fleetRefusal) {
      print(refusal(error.details || { code: error.code || 'FLEET_CALL_REFUSED', message: error.message }, 'fleet.control'));
      process.exitCode = 2;
    } else {
      print({ code: 'FLEET_CALL_OUTCOME_UNKNOWN', message: 'Transport or deadline failure; the outcome is unknown.',
        nextAction: 'Read Fleet state before any retry. This command never replays a call.' });
      process.exitCode = 3;
    }
  } finally { clearTimeout(timer); socket?.destroy(); }
}

module.exports = { run };
