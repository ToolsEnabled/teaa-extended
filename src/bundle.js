// Provision bundled upstreams through their supported CLI. Never edit their runtime/state schema.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, win32 as windowsPath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { dataDir, selectPython311, isWindows, which } from './platform.js';
import fleetPins from './fleet-pin.cjs';
const FLEET_PIN = fleetPins.fleetPin();
import { verifyRelease } from './install.js';
import { inheritedEnv } from './mcp/client.js';
import { BUNDLED_FLEET_DROP, knowledgeConfigPath } from './config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FLEET_ENTRY = FLEET_PIN.runtime.entry;
// Earlier TEAA bundles. Their state is a different generation and is never opened or converted.
// A verified earlier TEAA V4 install is explicitly rebound by `teaa setup`.
// Its fleetV4-state is never opened: V5 creates only fleetV5-state.
const EARLIER_FLEET = ['vendor/fleet/bin/fleetV4.js'];
const ENGINE_ENTRY = 'vendor/toolsengine/bin/toolsengine.js';
const KNOWLEDGE_ENTRY = 'vendor/knowledge/knowledge.py';
// Explicit setup after an owned version upgrade follows the new bundled binaries.
// External runtimes and modified/unverified installations remain explicit user choices.
// An owned legacy or regular Fleet entry is cleared (reported by the runtime pin) so setup
// creates this bundle's Fleet state. The earlier state folder stays as it was.
export function rebaseOwnedRuntimeEntries(cfg, { root = ROOT } = {}) {
  const changed = [];
  const current = resolve(root);
  for (const [key, relative, earlier] of [
    ['fleet', FLEET_ENTRY, EARLIER_FLEET],
    ['engine', ENGINE_ENTRY, []],
    ['knowledge', KNOWLEDGE_ENTRY, []],
  ]) {
    const entry = cfg[key], next = join(current, relative);
    if (!entry || !existsSync(next)) continue;
    for (let i = 0; i < (entry.args || []).length; i++) {
      const old = entry.args[i];
      if (typeof old !== 'string' || resolve(old) === next) continue;
      const from = [relative, ...earlier].find((name) => name && old.replace(/\\/g, '/').endsWith('/' + name));
      if (!from) continue;
      const previous = resolve(old, key === 'knowledge' ? '../../..' : '../../../..');
      if (dirname(previous) !== dirname(current)) continue;
      try {
        const receipt = JSON.parse(readFileSync(join(previous, '.teaa-install.json'), 'utf8'));
        if (receipt.product !== '@toolsenabled/teaa' || resolve(receipt.app) !== previous) continue;
        verifyRelease(previous);
      } catch { continue; }
      if (earlier.includes(from)) {
        cfg[key] = { ...entry, command: null, args: [], env: {} };
        changed.push(FLEET_PIN.runtime.migrationKey);
        break;
      }
      entry.args = entry.args.map((value, n) => n === i ? next : value);
      changed.push(key);
      break;
    }
  }
  return changed;
}

function refusal(reason) {
  return new Error(`TEAA could not automatically rebind Fleet state (${reason}). The state was left unchanged. Run teaa setup from the TEAA release that created this state, or ask your administrator to resolve the runtime mismatch.`);
}

function fleetIdentity(app) {
  const lock = JSON.parse(readFileSync(join(app, 'components.lock.json'), 'utf8'));
  const target = `${process.platform === 'win32' ? 'windows' : 'linux'}-x64`;
  const fleet = lock?.fleet;
  if (fleet?.platform !== target || typeof fleet.version !== 'string' || !/^[a-f0-9]{40}$/.test(fleet.commit || '')
      || !/^[a-f0-9]{64}$/.test(fleet.archiveSha256 || '')
      || !/^[a-f0-9]{64}$/.test(fleet.identitySha256 || '')
      || !/^[a-f0-9]{64}$/.test(fleet.packagedFilesSha256 || '')) throw new Error('invalid Fleet component identity');
  return { version: fleet.version, commit: fleet.commit, archiveSha256: fleet.archiveSha256,
    identitySha256: fleet.identitySha256, packagedFilesSha256: fleet.packagedFilesSha256 };
}

function installMarker(app) {
  const markerPath = join(app, '.teaa-install.json');
  const stat = lstatSync(markerPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) throw new Error('invalid TEAA install marker');
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  if (marker.product !== '@toolsenabled/teaa' || resolve(marker.app) !== resolve(app)
      || typeof marker.shim !== 'string' || resolve(marker.shim) !== marker.shim) throw new Error('invalid TEAA install marker');
  return marker;
}

function ownedApp(app, shim) {
  try {
    const marker = installMarker(app);
    if (resolve(marker.shim) !== resolve(shim)) return null;
    const manifest = verifyRelease(app);
    if (marker.version !== manifest.version) return null;
    return { app, identity: fleetIdentity(app), marker };
  } catch { return null; }
}

function readPriorHostConfig(stateRoot) {
  if (!existsSync(stateRoot)) return null;
  try {
    assertPrivateDataPath(stateRoot);
    const file = join(stateRoot, 'host-mode.json');
    let stat;
    try { stat = lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024
        || process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.nlink !== 1
          || typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new Error('Fleet host configuration is not a private regular file');
    }
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch { throw refusal('the saved host configuration could not be verified'); }
}

function sameComponent(a, b) {
  return a.version === b.version && a.commit === b.commit && a.archiveSha256 === b.archiveSha256
    && a.identitySha256 === b.identitySha256 && a.packagedFilesSha256 === b.packagedFilesSha256;
}

// A failed setup can already have rebased teaa's saved command to this app.
// Discover the previous app from the host state and verify it beside this app
// before asking the bundled Fleet CLI to rebind its own state.
export function rebindEarlierFleetRuntime({ root = ROOT, stateRoot = join(dataDir(), FLEET_PIN.runtime.stateDirectory), fleetConfig, runFleet } = {}) {
  if (fleetConfig && !fleetConfig.enabled) return null;
  const currentApp = resolve(root);
  if (fleetConfig?.command) {
    const selectsOwnedBundle = (fleetConfig.args || []).some((arg) => {
      if (typeof arg !== 'string' || !arg.replace(/\\/g, '/').endsWith('/' + FLEET_ENTRY)) return false;
      const selected = resolve(arg);
      return selected === resolve(currentApp, ...FLEET_ENTRY.split('/'))
        || /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(resolve(selected, '../../../..').split(/[\\/]/).pop())
          && dirname(resolve(selected, '../../../..')) === dirname(currentApp);
    });
    if (!selectsOwnedBundle) return null;
  }
  const config = readPriorHostConfig(stateRoot);
  if (!config) return null;
  const currentFleetRoot = resolve(currentApp, 'vendor/fleet');
  const samePath = (a, b) => process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b;
  const absolute = (value) => typeof value === 'string' && value.length > 0 && resolve(value) === value;
  if (config.schemaVersion !== 1 || config.mode !== 'host' || config.profile !== 'fleetV2'
      || config.setupKind !== undefined || config.generation !== 5 || config.treeStorage !== 'sqlite-v1'
      || typeof config.workers !== 'boolean' || !['unrestricted', 'standard', 'guided'].includes(config.tier || 'unrestricted')
      || !absolute(config.stateRoot) || !samePath(config.stateRoot, resolve(stateRoot))
      || !absolute(config.installRoot) || !absolute(config.nodePath) || !absolute(config.workspace)) {
    throw refusal('the saved configuration is not a standalone TEAA Fleet V5 state');
  }
  const savedFleetRoot = resolve(config.installRoot);
  const sameRuntime = samePath(savedFleetRoot, currentFleetRoot) && samePath(resolve(config.nodePath), resolve(process.execPath));
  if (sameRuntime) return null;

  let current;
  try {
    const marker = installMarker(currentApp);
    current = ownedApp(currentApp, marker.shim);
  } catch { current = null; }
  if (!current) throw refusal('the current TEAA installation could not be verified');

  const appsRoot = dirname(currentApp), candidates = [];
  let appEntries;
  try { appEntries = readdirSync(appsRoot, { withFileTypes: true }); } catch { throw refusal('the TEAA install prefix could not be verified'); }
  for (const entry of appEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(entry.name)) continue;
    const app = resolve(appsRoot, entry.name), marker = ownedApp(app, current.marker.shim);
    if (marker && samePath(resolve(app, 'vendor/fleet'), savedFleetRoot)) candidates.push(marker);
  }
  if (candidates.length !== 1) throw refusal('the previous runtime is not a verified TEAA installation in this install prefix');
  let nextIdentity;
  try { nextIdentity = fleetIdentity(currentApp); } catch { throw refusal('the current Fleet component identity could not be verified'); }
  if (!sameComponent(candidates[0].identity, nextIdentity)) throw refusal('the previous and current Fleet component identities differ');

  const entry = join(currentApp, ...FLEET_ENTRY.split('/'));
  const invoke = runFleet || ((fleetEntry, args) => spawnSync(process.execPath, [fleetEntry, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
    env: inheritedEnv(BUNDLED_FLEET_DROP),
  }));
  const result = invoke(entry, ['rebind', '--state-root', stateRoot]);
  if (result?.error || result?.status !== 0) {
    const code = /^([A-Z0-9_]+):/.exec(result?.stderr || '')?.[1] || 'FLEET_REBIND_REFUSED';
    const guidance = code === 'FLEET_V2_REBIND_LIVE'
      ? 'Stop the TEAA Hub or client using this state, then rerun teaa setup.'
      : 'Run teaa setup from the TEAA release that created this state, or ask your administrator to resolve the runtime mismatch.';
    throw new Error(`TEAA could not rebind Fleet state (${code}). ${guidance}`);
  }
  let response;
  try { response = JSON.parse(result.stdout); } catch { throw new Error('TEAA Fleet rebind returned an invalid response; check the state before retrying teaa setup.'); }
  if (!['rebound', 'not-needed'].includes(response?.rebind)) throw new Error('TEAA Fleet rebind did not confirm the state update; check the state before retrying teaa setup.');
  return response.rebind === 'rebound' ? { from: savedFleetRoot, to: currentFleetRoot, rebound: true } : null;
}

export function bundledInfo(root = ROOT) {
  const manifest = join(root, 'vendor', 'manifest.json');
  if (!existsSync(manifest)) return null;
  const m = JSON.parse(readFileSync(manifest, 'utf8'));
  if (m.schemaVersion !== 1 || m.platform !== process.platform || m.arch !== process.arch || !m.components?.fleet?.version || !m.components?.toolsengine?.version || !m.components?.knowledge?.version) throw new Error('Bundled runtimes do not match this operating system');
  const fleet = join(root, ...FLEET_ENTRY.split('/'));
  const engine = join(root, ...ENGINE_ENTRY.split('/'));
  const knowledge = join(root, ...KNOWLEDGE_ENTRY.split('/'));
  if (!existsSync(fleet) || !existsSync(engine) || !existsSync(knowledge)) throw new Error('Bundled runtime files are missing; reinstall the verified TEAA archive');
  const earlierFleetStateRoots = [];
  return {
    fleet, engine, knowledge,
    versions: { fleet: m.components.fleet.version, engine: m.components.toolsengine.version, knowledge: m.components.knowledge.version },
    stateRoot: join(dataDir(), FLEET_PIN.runtime.stateDirectory),
    earlierFleetStateRoots,
  };
}
// Ask the shipped upstream for its trusted Chrome/Edge locations. No browser is started.
export function detectBundledBrowser(engine, { platform = process.platform, find = which } = {}) {
  const moduleUrl = pathToFileURL(join(dirname(engine), '..', 'src', 'config.js')).href;
  const order = platform === 'win32' ? ['msedge', 'chrome'] : ['chrome', 'msedge'];
  const source = `const { channelExecutable } = await import(process.argv[1]);
    let selected = null;
    for (const channel of process.argv[2].split(',')) {
      try { const executable = channelExecutable(channel, { platform: process.argv[3] }); selected = { channel, executable }; break; } catch {}
    }
    process.stdout.write(JSON.stringify(selected));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', source, moduleUrl, order.join(','), platform], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024,
  });
  if (r.error || r.status !== 0) throw new Error(`Could not inspect bundled browser support: ${r.error?.message || `exit ${r.status}`}`);
  let selected;
  try { selected = JSON.parse(r.stdout); } catch { throw new Error('Bundled browser detection returned invalid JSON'); }
  if (selected?.channel && typeof selected.executable === 'string') return { args: ['--browser-channel', selected.channel], description: selected.channel === 'msedge' ? 'installed Microsoft Edge' : 'installed Google Chrome', executable: selected.executable };
  if (platform === 'linux') {
    for (const name of ['chromium', 'chromium-browser']) {
      const executable = find(name);
      if (executable) return { args: ['--browser-executable', executable], description: 'installed Chromium', executable };
    }
  }
  throw new Error('No installed Chrome, Edge or Chromium was found. Install a supported browser, or run teaa setup --no-browser for file and public-web tools. No browser was downloaded.');
}

// Same ancestor rule as Fleet's host audit store: no group/other write on the
// path, except a sticky directory owned by root (for example /tmp). The leaf
// may not exist yet. This does not change Fleet's own check.
function verifyPrivateDataPath(target, { create = false } = {}) {
  const absolute = resolve(target);
  if (isWindows) {
    // Fleet state preflight is non-creating. Callers that own creation may
    // explicitly request a private leaf created with the audited native ACL.
    const operation = existsSync(absolute) ? 'inspect' : create ? 'create' : 'ancestors';
    const powershell = windowsPath.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const checked = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, FLEET_PIN.runtime.securityScript)], {
      input: JSON.stringify({operation,path:absolute}), encoding:'utf8', windowsHide:true, timeout:30000, env:{...process.env},
    });
    let answer;try{answer=JSON.parse((checked.stdout||'').replace(/^\uFEFF/,''));}catch{}
    if(checked.error||checked.status!==0||!answer?.ok)throw new Error('Windows private state security refused: '+(answer?.reason||'native ACL and path verification unavailable'));
    return;
  }

  if (!absolute.startsWith('/') || absolute === '/') throw new Error('Fleet state must be an absolute directory below the filesystem root.');
  const parts = absolute.split('/').filter(Boolean);
  let current = '/';
  for (const part of parts) {
    current = join(current, part);
    if (!existsSync(current)) return;
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw new Error(`Fleet state path crosses a link at ${current}. Audit storage refuses links.`);
    if (!info.isDirectory()) throw new Error(`Fleet state path is not a directory at ${current}.`);
    const stickyRoot = info.uid === 0 && (info.mode & 0o1000) !== 0;
    const loose = (info.mode & 0o022) !== 0;
    if ((info.uid !== 0 && info.uid !== process.getuid()) || (loose && !stickyRoot)) {
      const mode = (info.mode & 0o777).toString(8);
      throw new Error(`Fleet cannot store its audit signing key because ${current} is writable by the group or by others, or belongs to another owner (mode ${mode}). TEAA does not weaken that check. Put the TEAA data directory on a private path. A sticky root directory such as /tmp can be the parent of that private path.`);
    }
  }
}

export function assertPrivateDataPath(target) { return verifyPrivateDataPath(target); }

export function createPrivateDataPath(target) {
  const absolute = resolve(target);
  if (!isWindows && !existsSync(absolute)) mkdirSync(absolute, { recursive: true, mode: 0o700 });
  return verifyPrivateDataPath(absolute, { create: true });
}

function assertPython311(configured) {
  return selectPython311(configured);
}

function git(repo, args) {
  const r = spawnSync('git', ['-c', 'user.name=Knowledge MCP', '-c', 'user.email=knowledge@localhost', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 20_000,
  });
  if (r.error || r.status !== 0) throw new Error(`Knowledge sample repository was not finished: ${r.error?.message || r.stderr?.trim() || `git exit ${r.status}`}. ${repo} was left as it is.`);
}

function gitAt(cwd, args) {
  const r = spawnSync('git', ['-c', 'user.name=Knowledge MCP', '-c', 'user.email=knowledge@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 20_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.error || r.status !== 0) {
    const error = new Error(r.error?.message || r.stderr?.trim() || `git exit ${r.status}`);
    error.gitStatus = r.status;
    throw error;
  }
  return (r.stdout || '').trim();
}

// A new local git repository with one sample project. No origin and no other computer's briefs.
function ensureSampleRepo(repo, { allowEmpty = false } = {}) {
  if (existsSync(repo)) {
    if (existsSync(join(repo, '.git'))) return false;
    if (!allowEmpty || readdirSync(repo).length !== 0) throw new Error(`Knowledge folder ${repo} exists without a git repository. It was left unchanged.`);
  }
  mkdirSync(join(repo, 'projects', 'sample'), { recursive: true, mode: 0o700 });
  mkdirSync(join(repo, 'rules'), { recursive: true, mode: 0o700 });
  writeFileSync(join(repo, 'INDEX.md'), '# Knowledge\n\n- `sample` (active): Local sample project created for this computer. This repository is new and does not include another computer\'s briefs or AGENTS.md.\n');
  writeFileSync(join(repo, 'MANIFEST.json'), '{}\n');
  writeFileSync(join(repo, 'rules', 'global.md'), '# Rules\n\nThis is a new local knowledge repository created by TEAA setup. It does not include another computer\'s briefs or AGENTS.md.\n');
  writeFileSync(join(repo, 'projects', 'sample', 'brief.md'), '# sample\n\nEmpty sample project. Replace this brief with your own notes. Nothing here was copied from another computer.\n');
  git(repo, ['init']);
  git(repo, ['add', 'INDEX.md', 'MANIFEST.json', 'rules/global.md', 'projects/sample/brief.md']);
  git(repo, ['commit', '-m', 'Create local sample knowledge repository']);
  return true;
}

// Write knowledge-config.json only when it is absent. An existing file is the customer's.
export function ensureCustomerKnowledge() {
  const configPath = knowledgeConfigPath();
  assertPrivateDataPath(dirname(configPath));
  if (existsSync(configPath)) return { configPath, created: false, repo: null };
  const repo = join(dataDir(), 'knowledge-repo');
  // The native Windows helper creates missing state roots with an explicit
  // owner and private DACL. Permit initialization only when that exact call
  // created an empty repo leaf; a pre-existing non-Git folder remains refused.
  const repoAlreadyExisted = existsSync(repo);
  if (!repoAlreadyExisted) createPrivateDataPath(repo);
  else assertPrivateDataPath(repo);
  const createdRepo = ensureSampleRepo(repo, { allowEmpty: !repoAlreadyExisted });
  assertPrivateDataPath(repo);
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ repo, sync: 'off', interior: 'refuse' }, null, 2) + '\n';
  writeFileSync(configPath, body, { mode: 0o600, flag: 'wx' });
  return { configPath, created: true, repo, createdRepo };
}

// Explicit opt-in. A bare repository beside the sample is a local origin only.
// sync stays off. No network URL is written, and another repository is not touched.
export function attachLocalKnowledgeOrigin() {
  const configPath = knowledgeConfigPath();
  if (!existsSync(configPath)) ensureCustomerKnowledge();
  const before = readFileSync(configPath, 'utf8');
  const raw = JSON.parse(before);
  const sample = join(dataDir(), 'knowledge-repo');
  const bare = join(dataDir(), 'knowledge-origin.git');
  if (typeof raw.repo !== 'string' || resolve(raw.repo) !== resolve(sample)) {
    throw new Error(`--local-knowledge-origin only attaches a bare repository beside the sample at ${sample}. The configured repository was left unchanged.`);
  }
  if (raw.origin) throw new Error('--local-knowledge-origin does not replace origin in knowledge-config.json. That file was left unchanged.');
  if (raw.sync !== 'off') throw new Error('--local-knowledge-origin does not change sync and does not attach while sync is on. knowledge-config.json was left unchanged.');
  if (!existsSync(join(sample, '.git'))) throw new Error(`Knowledge sample ${sample} has no git repository. It was left unchanged.`);
  let current = null;
  try { current = gitAt(sample, ['remote', 'get-url', 'origin']); } catch { current = null; }
  if (current) {
    if (resolve(sample, current) === resolve(bare) && existsSync(bare)) return { repo: sample, bare, sync: 'off', already: true };
    throw new Error('--local-knowledge-origin does not replace an existing origin. The repository was left unchanged.');
  }
  if (gitAt(sample, ['status', '--porcelain'])) throw new Error('--local-knowledge-origin refuses a sample repository with uncommitted changes. It was left unchanged.');
  if (existsSync(bare)) throw new Error(`Bare repository ${bare} already exists without being this sample's origin. It was left unchanged.`);
  createPrivateDataPath(bare);
  let createdBare = false;
  let addedRemote = false;
  try {
    gitAt(dataDir(), ['init', '--bare', bare]);
    createdBare = true;
    chmodSync(bare, 0o700);
    gitAt(sample, ['remote', 'add', 'origin', bare]);
    addedRemote = true;
    const branch = gitAt(sample, ['symbolic-ref', '--short', 'HEAD']);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..')) throw new Error(`unexpected sample branch ${branch}`);
    gitAt(sample, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
    gitAt(bare, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  } catch (err) {
    if (addedRemote) { try { gitAt(sample, ['remote', 'remove', 'origin']); } catch { /* the failed push left no remote when remove works */ } }
    if (createdBare) rmSync(bare, { recursive: true, force: true });
    throw new Error(`Local knowledge origin was not attached: ${err.message}. The sample was left without an origin.`);
  }
  if (readFileSync(configPath, 'utf8') !== before) throw new Error('knowledge-config.json changed while the local origin was attached.');
  return { repo: sample, bare, sync: 'off', already: false, branch: gitAt(sample, ['symbolic-ref', '--short', 'HEAD']) };
}

export function prepareBundledRuntime({ folder, workers, actor, includeFleet = true, includeEngine = true, includeKnowledge = false, knowledgePython = null, browser = true, root = ROOT } = {}) {
  const bundle = bundledInfo(root);
  if (!bundle) return null;
  if (includeFleet || includeKnowledge) assertPrivateDataPath(includeFleet ? bundle.stateRoot : dataDir());
  const invoke = (args) => {
    const r = spawnSync(process.execPath, [bundle.fleet, ...args], { encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 2 * 1024 * 1024, env: inheritedEnv(BUNDLED_FLEET_DROP) });
    if (r.error || r.status !== 0) throw new Error(`Bundled Fleet setup failed: ${r.error?.message || r.stderr?.trim() || `exit ${r.status}`}`);
    try { return JSON.parse(r.stdout); } catch { throw new Error('Bundled Fleet returned an invalid setup response'); }
  };
  const result = { versions: bundle.versions, earlierFleetStateRoots: bundle.earlierFleetStateRoots };
  if (includeEngine) {
    const selected = browser ? detectBundledBrowser(bundle.engine) : null;
    result.engine = { command: process.execPath, args: [bundle.engine, ...(selected ? selected.args : ['--no-browser'])], env: {} };
    result.browser = selected?.description || 'disabled';
  }
  if (includeFleet) {
    // Fleet creates its state once (worker launching is fixed then) and never
    // converts existing state. A later setup reads the existing state's server entry.
    const stateFile = join(bundle.stateRoot, 'host-mode.json');
    const saved = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
    const lead = actor ?? 'local';
    let response;
    if (!saved) {
      if (existsSync(bundle.stateRoot)) throw new Error(`The Fleet state folder ${bundle.stateRoot} exists without a finished setup. It was left unchanged; move it aside and run teaa setup again.`);
      response = invoke(['setup', '--state-root', bundle.stateRoot, '--workspace', realpathSync(resolve(folder)), '--actor', lead,
        ...(workers ? [] : ['--coordination-only'])]);
    } else {
      const has = saved.workers === true;
      if (workers !== undefined && workers !== has) {
        throw new Error(`Fleet fixes worker launching when its state is created. ${bundle.stateRoot} has workers ${has ? 'on' : 'off'} and was left unchanged. `
          + `To ${workers ? 'enable' : 'disable'} workers, move that folder aside (its tasks, rules and memory stay in it) and run teaa setup${workers ? ' --workers' : ''} again.`);
      }
      response = invoke(['status', '--state-root', bundle.stateRoot, '--actor', lead]);
    }
    const fleet = response?.server;
    if (!fleet || typeof fleet.command !== 'string' || !Array.isArray(fleet.args)) throw new Error('Bundled Fleet did not provide a valid server entry');
    result.fleet = { command: fleet.command, args: fleet.args, env: {} };
    result.fleetWorkers = response.workers === true;
    result.fleetStateRoot = bundle.stateRoot;
  }
  if (includeKnowledge) {
    // A configured knowledge.command is used (after its version check); PATH only without one.
    const python = assertPython311(knowledgePython);
    const ensured = ensureCustomerKnowledge();
    result.knowledge = { command: python, args: [bundle.knowledge, '--config', ensured.configPath, '--owner-launch'], env: {} };
    result.knowledgeConfig = ensured.configPath;
    result.knowledgeConfigCreated = ensured.created;
    result.knowledgeRepo = ensured.repo;
  }
  return result;
}
