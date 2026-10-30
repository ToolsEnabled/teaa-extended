import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { defaults, loadConfig, saveConfig, fleetLaunch, fleetAuditLaunch, fleetActor, serverEntry } from '../src/config.js';
import { configDir, dataDir, isWindows } from '../src/platform.js';
import { McpClient } from '../src/mcp/client.js';
const CLI = fileURLToPath(new URL('../bin/teaa.js', import.meta.url));
const BUNDLE = new URL('../src/bundle.js', import.meta.url).href;
const WINDOWS_FLEET_SECURITY = fileURLToPath(new URL('../vendor/fleet/tools/windows-state-security.ps1', BUNDLE));
const MCP = fileURLToPath(new URL('./fixtures/runtime-mcp.js', import.meta.url));
function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'teaa-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { PATH: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, HOME: dir, APPDATA: dir, LOCALAPPDATA: dir, USERPROFILE: dir, ...(isWindows ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}) };
  const file = join(configDir(env), 'config.json');
  mkdirSync(dirname(file), { recursive: true });
  const cfg = defaults(); cfg.mcp.folder = '.';
  cfg.fleet.command = cfg.engine.command = cfg.knowledge.command = process.execPath;
  cfg.fleet.args = cfg.engine.args = cfg.knowledge.args = [MCP];
  writeFileSync(file, JSON.stringify(cfg));
  return { dir, env, file, cfg };
}
const run = (args, state) => spawnSync(process.execPath, [CLI, ...args], { cwd: state.dir, env: state.env, encoding: 'utf8', timeout: 15000 });

test('Fleet saved actor survives defaults and an explicit actor replaces every old actor option', () => {
  const cfg = defaults(); cfg.fleet.command = process.execPath;
  for (const old of [['--actor', 'claude'], ['--actor=agy']]) {
    cfg.fleet.args = ['/fleet.js', 'serve', ...old];
    const before = [...cfg.fleet.args];
    assert.equal(fleetActor(cfg), old.at(-1).split('=').at(-1));
    assert.deepEqual(fleetLaunch(cfg).args.slice(-2), ['--actor', fleetActor(cfg)]);
    assert.deepEqual(fleetLaunch(cfg, { actor: 'codex' }).args, ['/fleet.js', 'serve', '--actor', 'codex']);
    assert.deepEqual(cfg.fleet.args, before);
  }
  cfg.fleet.args = ['/fleet.js', '--actor', 'claude', '--actor=agy']; cfg.mcp.actor = 'local';
  assert.deepEqual(fleetLaunch(cfg).args, ['/fleet.js', '--actor', 'local']);
  assert.deepEqual(fleetLaunch(cfg, { actor: 'codex' }).args, ['/fleet.js', '--actor', 'codex']);
  cfg.mcp.actor = null; cfg.fleet.args = ['/fleet.js'];
  assert.equal(fleetActor(cfg), 'local');
  assert.throws(() => fleetLaunch(cfg, { actor: '--bad' }), /Invalid Fleet actor/);
});

test('bundled Fleet audit uses transient administration while ordinary V5 launch stays unchanged', () => {
  const cfg = defaults();
  const bundledDir = join(tmpdir(), 'teaa-bundle-with-spaces', 'vendor', 'fleet');
  cfg.fleet.command = process.execPath;
  cfg.fleet.args = [join(bundledDir, 'bin', 'fleetV5.js'), 'serve', '--state-root', join(tmpdir(), 'fleet-state'), '--actor', 'local'];
  cfg.mcp.folder = tmpdir();
  const ordinaryBefore = fleetLaunch(cfg, { bundledDir });
  const audit = fleetAuditLaunch(cfg, { bundledDir });
  assert.deepEqual(audit.args, [cfg.fleet.args[0], 'serve', '--admin', ...cfg.fleet.args.slice(2)]);
  assert.deepEqual(fleetLaunch(cfg, { bundledDir }), ordinaryBefore);
  assert.deepEqual(cfg.fleet.args, [join(bundledDir, 'bin', 'fleetV5.js'), 'serve', '--state-root', join(tmpdir(), 'fleet-state'), '--actor', 'local']);

  const external = { ...cfg, fleet: { ...cfg.fleet, args: ['/external/fleet.js', 'serve', '--state-root', '/external/state'] } };
  assert.deepEqual(fleetAuditLaunch(external, { bundledDir }).args, fleetLaunch(external, { bundledDir }).args);
});

test('unknown well-formed actor is passed to the upstream registry and its refusal is reported', async t => {
  const { dir, cfg } = sandbox(t), fixture = join(dir, 'actor-server.cjs');
  writeFileSync(fixture, `const actor=process.argv.at(-1);if(!['local','claude','codex','agy'].includes(actor)){process.stderr.write('Actor must be a described provider or local.');process.exit(2)};import(${JSON.stringify(new URL('./fixtures/runtime-mcp.js', import.meta.url).href)});`);
  cfg.fleet.args = [fixture]; cfg.mcp.folder = dir;
  const launch = fleetLaunch(cfg, { actor: 'unknown_actor' });
  assert.equal(launch.args.at(-1), 'unknown_actor');
  const client = new McpClient({ name: 'Fleet', ...launch, timeoutMs: 1000 });
  try { await assert.rejects(client.start(), /Actor must be a described provider or local/); }
  finally { await client.close(); }
});

test('old lead metadata is not imported into the new MCP folder', t => {
  const { file, dir } = sandbox(t);
  const old = { lead: { provider: 'old-provider', model: 'old-model', folder: dir, sandbox: 'old-policy' }, chat: { folder: '/unused', withTools: true }, fleet: { args: ['--actor', 'claude'] } };
  writeFileSync(file, JSON.stringify(old));
  const cfg = loadConfig({ file });
  assert.equal(cfg.mcp.folder, process.cwd()); assert.equal(fleetActor(cfg), 'claude');
  saveConfig(cfg);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(saved.lead, old.lead); assert.deepEqual(saved.chat, old.chat);
  assert.equal(defaults().lead, undefined); assert.equal(defaults().chat, undefined);
});

test('registration JSON is read only, contains only command/args and carries per-host explicit actor', t => {
  const state = sandbox(t), before = readFileSync(state.file, 'utf8');
  state.cfg.fleet.args.push('--actor', 'agy'); writeFileSync(state.file, JSON.stringify(state.cfg));
  const configured = readFileSync(state.file, 'utf8');
  for (const [args, actor] of [[[], 'agy'], [['--actor', 'claude'], 'claude']]) {
    const result = run(['config', '--server-json', ...args], state);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { command: process.execPath, args: [CLI, 'mcp', '--actor', actor] });
    assert.equal(readFileSync(state.file, 'utf8'), configured);
  }
  assert.notEqual(before, configured);
  assert.deepEqual(Object.keys(serverEntry(state.cfg)).sort(), ['args', 'command']);
});

test('setup and doctor pass MCP readiness with no provider or GUI executable and save the setup project', t => {
  const state = sandbox(t);
  const result = run(['setup', '--actor', 'claude', '--print-server-json'], state);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).args.slice(-3), ['mcp', '--actor', 'claude']);
  assert.match(result.stderr, /MCP setup ready/);
  const cfg = JSON.parse(readFileSync(state.file, 'utf8'));
  assert.equal(cfg.mcp.actor, 'claude'); assert.equal(cfg.mcp.folder, state.dir);
  const doctor = run(['doctor', '--json'], state);
  assert.equal(doctor.status, 0, doctor.stderr);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.healthy, true); assert.deepEqual(report.readiness, { mcp: true });
  assert.ok(report.checks.every(c => !['claude', 'agy', 'codex', 'Companion window'].includes(c.name)));
  assert.equal(report.checks.find(c => c.name === 'MCP folder').detail, state.dir);
});

test('optional providers found on PATH are never run during setup or doctor', t => {
  const state = sandbox(t), marker = join(state.dir, 'provider-was-run');
  for (const command of ['claude', 'agy', 'codex']) writeFileSync(join(state.dir, command + (isWindows ? '.cmd' : '')), isWindows ? `@echo BAD > "${marker}"\r\n` : `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'BAD');`, { mode: 0o700 });
  for (const args of [['setup'], ['doctor', '--json']]) assert.equal(run(args, state).status, 0);
  assert.equal(existsSync(marker), false);
});

test('doctor reports upstream workspace refusal without creating or substituting a directory', t => {
  const state = sandbox(t), missing = join(state.dir, 'must-not-create');
  state.cfg.mcp.folder = missing; writeFileSync(state.file, JSON.stringify(state.cfg));
  const result = run(['doctor', '--json'], state);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.readiness.mcp, false); assert.equal(existsSync(missing), false);
  assert.match(report.checks.find(c => c.name === 'MCP folder').detail, /must-not-create/);
});

// A stand-in for the bundled Fleet V5 command line with its documented state rules:
// setup creates a NEW state (refusing an existing folder) and fixes workers then;
// status answers the server entry for an existing state. No provider is started.
const FAKE_FLEET_V3 = `const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');const a=process.argv.slice(2);
const opt=n=>{const i=a.indexOf(n);return i<0?undefined:a[i+1];};const root=opt('--state-root'),actor=opt('--actor')||'codex';
const server={command:process.execPath,args:[__filename,'serve','--state-root',root,'--actor',actor]};
if(a[0]==='setup'){if(fs.existsSync(root)){process.stderr.write('FLEET_V2_STATE_EXISTS: Choose a fresh state directory');process.exit(1);}
 if(process.platform==='win32'){const ps=path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');const r=cp.spawnSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',process.env.TEAA_TEST_FLEET_SECURITY],{input:JSON.stringify({operation:'create',path:root}),encoding:'utf8',windowsHide:true,timeout:30000});let q;try{q=JSON.parse(r.stdout)}catch{}if(r.error||r.status!==0||!q?.ok){process.stderr.write(q?.reason||r.stderr||r.error?.message||'native state creation refused');process.exit(3)}}else fs.mkdirSync(root,{recursive:true});const workers=!a.includes('--coordination-only');
 fs.writeFileSync(path.join(root,'host-mode.json'),JSON.stringify({profile:'fleetV2',generation:3,workers,workspace:opt('--workspace'),inherited:Object.keys(process.env).filter(n=>n.startsWith('TOOLSENABLED_'))}));
 console.log(JSON.stringify({name:'fleetV5',setup:'ready',workers,server}));}
else if(a[0]==='status'){const c=JSON.parse(fs.readFileSync(path.join(root,'host-mode.json'),'utf8'));console.log(JSON.stringify({name:'fleetV5',workers:c.workers,server}));}
else process.exit(2);`;
test('bundled Fleet V5: a new state is coordination-only unless workers are asked for; an existing state is reused and never converted', t => {
  const state = sandbox(t), root = join(state.dir, 'bundle');
  const fleet = join(root, 'vendor', 'fleet', 'bin', 'fleetV5.js'), engine = join(root, 'vendor', 'toolsengine', 'bin', 'toolsengine.js'), knowledge = join(root, 'vendor', 'knowledge', 'knowledge.py');
  mkdirSync(dirname(fleet), { recursive: true }); mkdirSync(dirname(engine), { recursive: true }); mkdirSync(dirname(knowledge), { recursive: true });
  writeFileSync(engine, ''); writeFileSync(fleet, FAKE_FLEET_V3); writeFileSync(knowledge, '# fixture\n');
  writeFileSync(join(root, 'vendor', 'manifest.json'), JSON.stringify({ schemaVersion: 1, platform: process.platform, arch: process.arch, components: { fleet: { version: '3.0.0-alpha.8.combined.5' }, toolsengine: { version: '0.2.0-alpha.2' }, knowledge: { version: '1.1.0' } } }));
  // TEAA started inside another Fleet's session inherits that Fleet's variables.
  const otherFleet = { TOOLSENABLED_STATE_ROOT: join(state.dir, 'other-fleet', 'capability'), TOOLSENABLED_SETTINGS: join(state.dir, 'other-fleet', 'settings.json') };
  const invoke = extra => spawnSync(process.execPath, ['--input-type=module', '-e', `import {prepareBundledRuntime} from ${JSON.stringify(BUNDLE)}; try { console.log(JSON.stringify(prepareBundledRuntime(${JSON.stringify({ root, folder: state.dir, browser: false, includeEngine: false, ...extra })}))); } catch (e) { console.error(e.message); process.exit(3); }`], { cwd: state.dir, env: { ...state.env, ...otherFleet, ...(isWindows ? { TEAA_TEST_FLEET_SECURITY: WINDOWS_FLEET_SECURITY } : {}) }, encoding: 'utf8' });
  const stateRoot = join(dataDir(state.env), 'fleetV5-state'), saved = join(stateRoot, 'host-mode.json');
  let result = invoke({}); assert.equal(result.status, 0, result.stderr);
  let out = JSON.parse(result.stdout);
  assert.deepEqual(out.fleet.args, [fleet, 'serve', '--state-root', stateRoot, '--actor', 'local']);
  assert.equal(JSON.parse(readFileSync(saved, 'utf8')).workers, false, 'workers stay opt-in');
  assert.deepEqual(JSON.parse(readFileSync(saved, 'utf8')).inherited, [], 'the bundled Fleet set up without another Fleet\'s variables');
  assert.equal(out.fleetWorkers, false);
  const before = readFileSync(saved);
  result = invoke({ actor: 'claude' }); assert.equal(result.status, 0, result.stderr);
  out = JSON.parse(result.stdout);
  assert.deepEqual(out.fleet.args.slice(-2), ['--actor', 'claude']);
  assert.deepEqual(readFileSync(saved), before, 'an existing state is reused unchanged');
  result = invoke({ workers: true });
  assert.equal(result.status, 3); assert.match(result.stderr, /workers off and was left unchanged/);
  assert.deepEqual(readFileSync(saved), before);
  rmSync(stateRoot, { recursive: true });
  result = invoke({ workers: true }); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(saved, 'utf8')).workers, true);
  assert.equal(JSON.parse(result.stdout).fleetWorkers, true);
  rmSync(saved);
  result = invoke({});
  assert.equal(result.status, 3); assert.match(result.stderr, /exists without a finished setup/);
  assert.equal(existsSync(saved), false, 'an unfinished state folder is left as it was');
});

// An MCP server that reports which variables it was started with. No network or provider calls.
const ENV_ECHO = `const rl=require('node:readline').createInterface({input:process.stdin});const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
rl.on('line',l=>{const m=JSON.parse(l);if(m.id===undefined)return;const r=v=>send({jsonrpc:'2.0',id:m.id,result:v});
if(m.method==='initialize')return r({protocolVersion:m.params.protocolVersion,serverInfo:{name:'env-echo',version:'1'},capabilities:{tools:{}}});
if(m.method==='tools/list')return r({tools:[{name:'env',inputSchema:{type:'object'}}]});
if(m.method==='tools/call')return r({content:[],structuredContent:{names:Object.keys(process.env).sort()}});});`;
test('the bundled Fleet never inherits another Fleet\'s TOOLSENABLED_* variables; configured ones and external Fleets are unchanged', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'teaa-fleet-env-'));
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const bundledDir = join(dir, 'app', 'vendor', 'fleet'), bundled = join(bundledDir, 'bin', 'fleetV2.js'), external = join(dir, 'external', 'fleet.js');
  for (const file of [bundled, external]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, ENV_ECHO); }
  const saved = { ...process.env };
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]; Object.assign(process.env, saved); });
  Object.assign(process.env, { TOOLSENABLED_STATE_ROOT: join(dir, 'other-fleet', 'capability'), TOOLSENABLED_TOOL_ALLOWLIST: 'task.list', TEAA_TEST_KEPT: '1' });
  const names = async args => {
    const cfg = defaults(); cfg.fleet.command = process.execPath; cfg.fleet.args = args; cfg.fleet.env = { TOOLSENABLED_OWN_SETTING: 'configured' }; cfg.mcp.folder = dir;
    const c = new McpClient({ name: 'Fleet', ...fleetLaunch(cfg, { bundledDir }) }); clients.push(c);
    await c.start();
    return (await c.callTool('env', {})).structuredContent.names;
  };
  const inside = await names([bundled, 'serve', '--state-root', join(dir, 'state')]);
  assert.equal(inside.includes('TOOLSENABLED_STATE_ROOT'), false);
  assert.equal(inside.includes('TOOLSENABLED_TOOL_ALLOWLIST'), false);
  assert.ok(inside.includes('TOOLSENABLED_OWN_SETTING'), 'a variable set in TEAA settings is still passed');
  assert.ok(inside.includes('TEAA_TEST_KEPT'), 'other variables are still inherited');
  const outside = await names([external, 'serve']);
  assert.ok(outside.includes('TOOLSENABLED_STATE_ROOT') && outside.includes('TOOLSENABLED_TOOL_ALLOWLIST'), 'an external Fleet keeps its caller\'s environment');
});
