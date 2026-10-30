// `teaa setup` and `teaa doctor`: report actual readiness, not just executable presence.
import { existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, detectFleet, detectEngine, detectKnowledge, fleetServerEntry, fleetLaunch, fleetAuditLaunch, engineLaunch, knowledgeLaunch, ensureFolder, mcpFolder, fleetActor, serverEntry, validateActor, isBundledFleet } from './config.js';
import { attachLocalKnowledgeOrigin, ensureCustomerKnowledge } from './bundle.js';
import { McpClient } from './mcp/client.js';
import { osLabel, isWindows, which, selectPython311, expandHome, resolveCommand } from './platform.js';
import { VERSION } from './version.js';
import fleetPins from './fleet-pin.cjs';
const FLEET_PIN=fleetPins.fleetPin();
const ok = (s) => `  ✓ ${s}`;
const bad = (s) => `  ✗ ${s}`;
const info = (s) => `  · ${s}`;
const ENGINE_INSTALL = 'Install ToolsEngine from https://toolsenabled.ai/toolsengine/ or use the complete TEAA archive.';
const KNOWLEDGE_INSTALL = 'Knowledge not found. Use the complete TEAA archive, or run teaa setup --knowledge /path/to/knowledge.py. Knowledge MCP needs Python 3.11 or newer.';
const LABELS = { fleet: 'Fleet', engine: 'ToolsEngine', knowledge: 'Knowledge' };
export async function runSetup({ fleet, engine, knowledge, folder, actor, noBrowser, browser, workers, localKnowledgeOrigin = false, printServerJson = false } = {}) {
  const cfg = loadConfig();
  const log = printServerJson ? console.error : console.log;
  if (actor !== undefined) cfg.mcp.actor = validateActor(actor);
  log(`TEAA Extended ${VERSION} setup on ${osLabel()}\n`);
  if (typeof folder === 'string') cfg.mcp.folder = resolve(expandHome(folder));
  ensureFolder(mcpFolder(cfg));
  log(ok(`MCP work folder ${mcpFolder(cfg)}`));
  if (noBrowser && browser) throw new Error('Choose --browser or --no-browser, not both');
  if (noBrowser) cfg.engine.browser = false;
  if (browser) cfg.engine.browser = true;
  let problems = 0;
  // Only a complete release carries bundled runtimes. The helper uses upstream setup.
  const bundlePath = new URL('./bundle.js', import.meta.url);
  if (existsSync(bundlePath)) {
    const { prepareBundledRuntime, rebaseOwnedRuntimeEntries, rebindEarlierFleetRuntime } = await import('./bundle.js');
    const reboundFleet = typeof fleet === 'string' ? null : rebindEarlierFleetRuntime({ fleetConfig: cfg.fleet });
    if (reboundFleet?.rebound) log(info(`Fleet state rebound from ${reboundFleet.from} to this TEAA runtime; enrollment and Fleet state retained`));
    for (const key of rebaseOwnedRuntimeEntries(cfg)) {
      if (key === FLEET_PIN.runtime.migrationKey) log(info(`This TEAA release bundles ${FLEET_PIN.runtime.name}. Setup creates the pinned generation state; earlier Fleet state is kept unchanged`));
      else log(info(`Updated ${LABELS[key] || key} to this installed TEAA bundle; existing arguments and environment retained`));
    }
    const host = fileURLToPath(new URL('../'+FLEET_PIN.runtime.entry, import.meta.url));
    const includeFleet = cfg.fleet.enabled && !fleet && (!cfg.fleet.command || (workers !== undefined || actor !== undefined || typeof folder === 'string') && cfg.fleet.args.includes(host));
    const engineHost = fileURLToPath(new URL('../vendor/toolsengine/bin/toolsengine.js', import.meta.url));
    const includeEngine = cfg.engine.enabled && !engine && (!cfg.engine.command || (browser || noBrowser) && cfg.engine.args.includes(engineHost));
    const knowledgeHost = fileURLToPath(new URL('../vendor/knowledge/knowledge.py', import.meta.url));
    const includeKnowledge = cfg.knowledge.enabled && !knowledge && (!cfg.knowledge.command || cfg.knowledge.args.includes(knowledgeHost));
    if (includeFleet || includeEngine || includeKnowledge) {
      try {
        const bundled = await prepareBundledRuntime({ folder: mcpFolder(cfg), workers, actor: cfg.mcp.actor ?? undefined, includeFleet, includeEngine, includeKnowledge, knowledgePython: cfg.knowledge.command, browser: cfg.engine.browser });
        if (bundled?.fleet && includeFleet) {
          cfg.fleet = { ...cfg.fleet, ...bundled.fleet };
          log(info(`Fleet ${bundled.versions.fleet} state ${bundled.fleetStateRoot} (workers ${bundled.fleetWorkers ? 'on' : 'off'})`));
          for (const earlier of bundled.earlierFleetStateRoots || []) log(info(`Earlier Fleet state kept unchanged at ${earlier}; the pinned generation does not read it`));
        }
        if (bundled?.engine && includeEngine) {
          cfg.engine = { ...cfg.engine, ...bundled.engine };
          if (bundled.browser) log(info(`ToolsEngine browser: ${bundled.browser}`));
        }
        if (bundled?.knowledge && includeKnowledge) {
          cfg.knowledge = { ...cfg.knowledge, ...bundled.knowledge, sync: 'off', interior: 'refuse' };
          if (bundled.knowledgeRepo) cfg.knowledge.repo = bundled.knowledgeRepo;
          log(info(bundled.knowledgeConfigCreated
            ? `Knowledge ${bundled.versions.knowledge} sample repository ${bundled.knowledgeRepo} (sync off, interior refuse${localKnowledgeOrigin ? '; local origin follows' : ', no origin'})`
            : `Knowledge config already present at ${bundled.knowledgeConfig}; left unchanged`));
        }
      } catch (err) { throw new Error(`Bundled runtime setup failed: ${err.message}`); }
    }
  }
  for (const key of ['fleet', 'engine', 'knowledge']) {
    const supplied = key === 'fleet' ? fleet : key === 'engine' ? engine : knowledge;
    const label = LABELS[key];
    try {
      if (typeof supplied === 'string') {
        const p = resolve(expandHome(supplied));
        if (!existsSync(p)) throw new Error(`${label} not found at ${p}`);
        if (key === 'knowledge') {
          const python = selectPython311(cfg.knowledge.command);
          const ensured = ensureCustomerKnowledge();
          cfg.knowledge = { ...cfg.knowledge, enabled: true, command: python, args: [p, '--config', ensured.configPath, '--owner-launch'], env: cfg.knowledge.env || {} };
          if (ensured.repo) cfg.knowledge.repo = ensured.repo;
          log(info(ensured.created ? `Knowledge sample repository ${ensured.repo}` : `Knowledge config already present at ${ensured.configPath}; left unchanged`));
        } else {
          const d = key === 'fleet' ? fleetServerEntry(p, { actor: cfg.mcp.actor ?? undefined }) : resolveCommand(p);
          const entry = key === 'fleet' ? d : { command: d.file, args: d.args };
          cfg[key] = { ...cfg[key], enabled: true, ...entry };
        }
      } else if (cfg[key].enabled && !cfg[key].command) {
        const d = key === 'fleet' ? detectFleet() : key === 'engine' ? detectEngine() : detectKnowledge();
        if (d) {
          cfg[key] = { ...cfg[key], command: d.command, args: d.args, env: d.env || {} };
          if (key === 'knowledge' && d.args?.some((arg) => arg.endsWith(`${sep}knowledge.py`) || arg.endsWith('/knowledge.py')) && !d.args.includes('--config')) {
            const ensured = ensureCustomerKnowledge();
            cfg.knowledge.args = [d.args.find((arg) => arg.endsWith(`${sep}knowledge.py`) || arg.endsWith('/knowledge.py')), '--config', ensured.configPath, '--owner-launch'];
            if (ensured.repo) cfg.knowledge.repo = ensured.repo;
          }
        }
      }
      if (!cfg[key].enabled) log(info(`${label} disabled in settings`));
      else if (!cfg[key].command) {
        problems++;
        log(bad(key === 'fleet' ? 'Fleet not found. Use the complete TEAA archive or install Fleet from https://toolsenabled.ai/fleet/.' : key === 'engine' ? ENGINE_INSTALL : KNOWLEDGE_INSTALL));
      } else log(ok(`${label} configured: ${cfg[key].command}`));
    } catch (err) { problems++; log(bad(err.message)); }
  }
  if (localKnowledgeOrigin) {
    if (!cfg.knowledge.enabled || !cfg.knowledge.command) throw new Error('--local-knowledge-origin needs Knowledge configured. No origin was added.');
    const attached = attachLocalKnowledgeOrigin();
    log(info(attached.already
      ? `Knowledge local bare origin already present at ${attached.bare} (sync off, no network remote)`
      : `Knowledge local bare origin ${attached.bare} (sync off, no network remote)`));
  }
  log(info(`MCP actor: ${fleetActor(cfg)} (Fleet ownership identity; model and login stay in the host)`));
  const path = saveConfig(cfg, { pinFolders: true });
  if (cfg.fleet.enabled && cfg.fleet.command && isBundledFleet(cfg.fleet)) {
    const audit = await confirmFleetAudit(cfg);
    if (!audit.ok) problems++;
    log((audit.ok ? ok : bad)(`Fleet audit: ${audit.detail}`));
  }
  for (const check of await upstreamChecks(cfg)) {
    if (!check.ok) problems++;
    log((check.skipped ? info : check.ok ? ok : bad)(`${check.name}: ${check.detail}`));
  }
  log(`\nSaved ${path}\n${problems ? 'MCP setup still needs attention. ' : 'MCP setup ready. '}Use teaa config --server-json to register in your host. Provider CLIs are needed only for optional Fleet workers. FRA, Hub and the account service are not started.`);
  if (printServerJson) console.log(JSON.stringify(serverEntry(cfg), null, 2));
  return problems ? 1 : 0;
}
async function confirmFleetAudit(cfg) {
  const launch = fleetAuditLaunch(cfg);
  if (!launch) return { ok: false, detail: 'Fleet is not configured' };
  // V5 ordinary leads expose only the nine contract tools. Use the explicit
  // native-admin route for this local setup audit, without saving it in cfg or
  // adding it to the server entry TEAA returns to an MCP host.
  if (FLEET_PIN.runtime.generation === 5 && isBundledFleet(cfg.fleet)) {
    const args = [...launch.args];
    const serve = args.indexOf('serve');
    if (serve >= 0 && !args.includes('--admin')) args.splice(serve + 1, 0, '--admin');
    launch.args = args;
  }
  const client = new McpClient({ name: 'Fleet', ...launch, timeoutMs: 45_000 });
  try {
    await client.start();
    if (!client.tools.some((tool) => tool.name === 'system.status')) return { ok: false, detail: 'system.status was not offered' };
    const result = await client.callTool('system.status', {});
    const audit = result.structuredContent?.audit;
    if (audit?.ok === true) return { ok: true, detail: 'signing key available (audit.ok true)' };
    const code = audit?.error?.code || 'audit.ok is not true';
    const message = audit?.error?.message || 'Fleet system.status did not report a usable audit signing key';
    return { ok: false, detail: `${code}: ${message}` };
  } catch (err) { return { ok: false, detail: err.message }; }
  finally { await client.close(); }
}
export async function probe(name, launch, cwd, { bundledFleet = false } = {}) {
  if (!launch) return { name, ok: false, detail: 'not set up (run teaa setup)' };
  const c = new McpClient({ name, ...launch, cwd: cwd ?? launch.cwd, timeoutMs: 45_000 });
  try {
    await c.start();
    if (!c.tools.length) throw new Error('Server connected but offered no tools');
    return { name, ok: true, detail: `${c.serverInfo.name} ${c.serverInfo.version}, ${c.tools.length} tools (MCP connection checked)` };
  } catch (err) {
    const detail = bundledFleet && name === 'Fleet' && /\bFLEET_V5_WORKERS_REQUIRED\b/.test(err.message)
      ? 'FLEET_V5_WORKERS_REQUIRED: ordinary TEAA requires the Fleet V5 contract tools, but this state was created with workers disabled. Fleet fixes that choice when the state is created. Preserve the existing fleetV5-state folder; to use ordinary TEAA, move it aside without deleting it, then rerun `teaa setup --workers` from the intended project (and pass any original --folder/--actor options). This creates fresh Fleet V5 state and does not import the old state. The --workers option enables worker capability but does not start a worker or provider.'
      : err.message;
    return { name, ok: false, detail };
  }
  finally { await c.close(); }
}
async function upstreamChecks(cfg) {
  return Promise.all(['fleet', 'engine', 'knowledge'].map(async (key) => {
    const name = LABELS[key];
    if (!cfg[key].enabled) return { name, ok: true, skipped: true, detail: 'disabled in TEAA settings' };
    try {
      const launch = key === 'fleet' ? fleetLaunch(cfg) : key === 'engine' ? engineLaunch(cfg) : knowledgeLaunch(cfg);
      return await probe(name, launch, undefined, { bundledFleet: key === 'fleet' && isBundledFleet(cfg.fleet) });
    }
    catch (err) { return { name, ok: false, detail: err.message }; }
  }));
}
export async function runDoctor({ json = false } = {}) {
  const cfg = loadConfig(), checks = [];
  const [major, minor] = process.versions.node.split('.').map(Number);
  checks.push({ name: 'Node.js', ok: major > 22 || major === 22 && minor >= 19, detail: `${process.versions.node} (needs 22.19+)` });
  checks.push({ name: 'System', ok: ['linux', 'win32'].includes(process.platform), detail: `${osLabel()} ${process.arch}${isWindows ? ' (native)' : ''}` });
  const folder = mcpFolder(cfg);
  try {
    if (!statSync(folder).isDirectory()) throw new Error('not a directory');
    checks.push({ name: 'MCP folder', ok: true, detail: folder });
  } catch (err) { checks.push({ name: 'MCP folder', ok: false, detail: `${folder}: ${err.message}` }); }
  checks.push(...await upstreamChecks(cfg));
  const passes = (names) => checks.filter((c) => names.includes(c.name)).every((c) => c.ok);
  const readiness = {
    mcp: passes(['Node.js', 'System', 'MCP folder', 'Fleet', 'ToolsEngine', 'Knowledge']),
  };
  const healthy = readiness.mcp;
  const scope = 'MCP startup and tool discovery checked for enabled upstreams. No browser action, provider login, model call, hub or account change exercised.';
  if (json) console.log(JSON.stringify({ version: VERSION, healthy, scope, actor: fleetActor(cfg), readiness, checks }, null, 2));
  else {
    console.log(`TEAA Extended ${VERSION} doctor\n`);
    for (const c of checks) console.log((c.skipped || c.optional ? info : c.ok ? ok : bad)(`${c.name.padEnd(17)} ${c.detail}${c.optional ? ' [optional]' : ''}`));
    console.log(`\n${scope}`);
    console.log(`\nReady: MCP ${readiness.mcp ? 'yes' : 'no'}\nMCP actor: ${fleetActor(cfg)}\nSettings: ${cfg._path}`);
  }
  return healthy ? 0 : 1;
}
