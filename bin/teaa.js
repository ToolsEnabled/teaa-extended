#!/usr/bin/env node
// TEAA, the ToolsEnabled Agent Architecture: Fleet + ToolsEngine + Knowledge MCP, with optional result text headings.
import { VERSION } from '../src/version.js';

const USAGE = `TEAA Extended (ToolsEnabled Agent Architecture) ${VERSION} — Fleet, ToolsEngine, Knowledge, FRA and Hub

  teaa mcp [--actor NAME]                    Combined MCP on stdin/stdout
  teaa setup [OPTIONS]                       Configure and check the three tools
  teaa doctor [--json]                       Check MCP connectivity
  teaa config [--server-json] [--actor NAME]  Show settings or a server entry
  teaa --version

Extended: teaa open|accept|status [device flags], select-hub CONFIG|--account URL [--relay-pair ID],
          select-local, hub start|status|stop [Hub options]

Setup: --folder DIR --actor NAME --no-browser --browser --workers
       --local-knowledge-origin
       --fleet PATH --engine PATH --knowledge PATH --print-server-json
Run setup from a project folder outside the TEAA install and Fleet state.
The project is saved for this MCP connection. Browser tools and workers are
opt-in. --browser uses installed Chrome, Edge or Chromium and does not
download one. --workers is required for ordinary Fleet V5 contract tools; it
enables worker capability without starting a worker, model or provider. A
workers-off Fleet state cannot be changed in place; preserve it and follow the
FLEET_V5_WORKERS_REQUIRED recovery shown by setup/doctor. Provider CLIs are
needed only when a person later starts a worker. Actor names identify
ownership, not a model or account; default: local.
Knowledge starts as a new local sample repository unless a knowledge config
already exists. That sample has no origin. --local-knowledge-origin adds a
bare git repository beside that sample only, pushes the current branch, and
leaves sync off. It does not contact a network host and does not alter an
existing origin or another repository.
Setup does not start FRA, Hub, or an account service.

The server entry has command and args. Add it under mcpServers["teaa"] in your
MCP host settings, or servers["teaa"] in VS Code. TEAA does not edit host settings.
This release is MCP only. Your agent app owns chat, login and approvals.`;

const VALUES = new Set(['--fleet', '--engine', '--knowledge', '--folder', '--actor']);
const OPTIONS = {
  setup: ['--fleet', '--engine', '--knowledge', '--folder', '--actor', '--no-browser', '--browser', '--workers', '--local-knowledge-origin', '--print-server-json'],
  mcp: ['--actor'], doctor: ['--json'], config: ['--server-json', '--actor'],
};
function options(cmd, args) {
  const allowed = OPTIONS[cmd] || [], parsed = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (!allowed.includes(name)) throw new Error(`Unknown option for ${cmd}: ${name}`);
    if (Object.hasOwn(parsed, name)) throw new Error(`Duplicate option: ${name}`);
    if (VALUES.has(name)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
      parsed[name] = value;
    } else parsed[name] = true;
  }
  return parsed;
}

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || major === 22 && minor < 19) {
  console.error(`TEAA needs Node.js 22.19 or newer (this is ${process.versions.node}). Get it from https://nodejs.org`);
  process.exit(1);
}

const [cmd = 'help', ...args] = process.argv.slice(2);
const EXTENDED_COMMANDS = new Set(['open', 'accept', 'status', 'select-hub', 'select-local', 'hub']);
try {
  if (EXTENDED_COMMANDS.has(cmd)) { await import('./teaa-extended.js'); }
  else if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(USAGE); } else {
    const opts = options(cmd, args);
    switch (cmd) {
      case 'mcp': {
        const { loadConfig, fleetLaunch, engineLaunch, knowledgeLaunch } = await import('../src/config.js');
        const { Gateway, serveStdio } = await import('../src/mcp/gateway.js');
        const cfg = loadConfig();
        const gw = new Gateway({ upstreams: [
          { key: 'fleet', disabled: !cfg.fleet.enabled, launch: fleetLaunch(cfg, { actor: opts['--actor'] }) },
          { key: 'engine', disabled: !cfg.engine.enabled, launch: engineLaunch(cfg) },
          { key: 'knowledge', disabled: !cfg.knowledge.enabled, launch: knowledgeLaunch(cfg) },
        ], log: (line) => process.stderr.write(`[teaa] ${line}\n`) });
        await serveStdio(gw);
        break;
      }
      case 'setup': {
        const { runSetup } = await import('../src/setup.js');
        process.exitCode = await runSetup({ fleet: opts['--fleet'], engine: opts['--engine'], knowledge: opts['--knowledge'], folder: opts['--folder'], actor: opts['--actor'], noBrowser: opts['--no-browser'], browser: opts['--browser'], workers: opts['--workers'], localKnowledgeOrigin: !!opts['--local-knowledge-origin'], printServerJson: !!opts['--print-server-json'] });
        break;
      }
      case 'doctor': {
        const { runDoctor } = await import('../src/setup.js');
        process.exitCode = await runDoctor({ json: !!opts['--json'] });
        break;
      }
      case 'config': {
        const { loadConfig, serverEntry } = await import('../src/config.js');
        const cfg = loadConfig();
        if (opts['--server-json']) console.log(JSON.stringify(serverEntry(cfg, { actor: opts['--actor'] }), null, 2));
        else {
          if (opts['--actor']) throw new Error('config --actor requires --server-json; use setup --actor to save an actor');
          console.log(cfg._path);
          const { _path, ...plain } = cfg;
          console.log(JSON.stringify(plain, null, 2));
        }
        break;
      }
      case '--version': case '-v': case 'version': console.log(VERSION); break;
      case 'help': case '--help': case '-h': console.log(USAGE); break;
      default: console.error(`Unknown command: ${cmd}\n\n${USAGE}`); process.exitCode = 2;
    }
  }
} catch (err) {
  console.error(`'teaa': ${err.message}`);
  process.exitCode = err.code === 'ENOENT' ? 127 : err.code === 'EACCES' ? 126 : 1;
}
