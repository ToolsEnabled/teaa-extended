import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaults, detectKnowledge, knowledgeLaunch } from '../src/config.js';
import { detectBundledBrowser } from '../src/bundle.js';
import * as platform from '../src/platform.js';
import { python311, requirePython311, isWindows, which } from '../src/platform.js';

const CLI = fileURLToPath(new URL('../bin/teaa.js', import.meta.url));
const BUNDLED_KNOWLEDGE = fileURLToPath(new URL('../vendor/knowledge/knowledge.py', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'teaa-python-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('Python discovery requires a successful 3.11+ probe and keeps Linux python3 selection', t => {
  const root = fixture(t);
  const executable = join(root, isWindows ? 'python3.exe' : 'python3');
  if (isWindows) {
    // Native Windows qualification covers python.exe selection and Store alias avoidance.
    t.skip('Windows executable-name selection is qualified on native Windows');
    return;
  }
  writeFileSync(executable, '#!/bin/sh\nexit 1\n');
  chmodSync(executable, 0o700);
  assert.equal(python311({ PATH: root }), null, 'a present but unsupported interpreter is not accepted');
  assert.throws(() => requirePython311({ PATH: root }), /Python 3\.11 or newer/);

  const valid = process.env.PATH.split(delimiter).find(dir => python311({ PATH: dir }));
  assert.ok(valid, 'host PATH provides a usable python3 runtime');
  const selected = python311({ PATH: valid });
  assert.ok(selected.endsWith('/python3'));
});

test('TEAA_KNOWLEDGE and bundled Knowledge share the validated interpreter discovery', t => {
  const root = fixture(t), script = join(root, 'knowledge.py');
  writeFileSync(script, '# fixture\n');
  if (isWindows) {
    t.skip('Windows executable-name selection is qualified on native Windows');
    return;
  }
  const pythonDir = process.env.PATH.split(delimiter).find(dir => python311({ PATH: dir }));
  const env = { PATH: pythonDir, TEAA_KNOWLEDGE: script };
  const external = detectKnowledge(env);
  assert.equal(external.command, python311(env));
  assert.deepEqual(external.args, [script]);

  const cfg = defaults();
  cfg.knowledge.command = '/explicit/python-runtime';
  cfg.knowledge.args = [script];
  const launch = knowledgeLaunch(cfg);
  assert.equal(launch.command, '/explicit/python-runtime', 'an explicit configured runtime remains authoritative');
  assert.deepEqual(launch.args.slice(0, 1), [script]);
});

// The host's real Python 3.11+ interpreter, used as a "portable" runtime that is
// deliberately absent from the PATH given to the code under test.
function hostPython() {
  const dir = process.env.PATH.split(delimiter).find(d => python311({ PATH: d }));
  assert.ok(dir, 'host PATH provides a usable python3 runtime');
  return realpathSync(python311({ PATH: dir }));
}

// A PATH that offers git (Knowledge repository operations) but no Python at all.
function pathWithoutPython(root) {
  const bin = join(root, 'path-without-python');
  mkdirSync(bin, { mode: 0o700 });
  symlinkSync(which('git'), join(bin, 'git'));
  assert.equal(python311({ PATH: bin }), null, 'the stripped PATH offers no Python');
  return bin;
}

function oldPython(root) {
  const fake = join(root, 'old-python', 'python3');
  mkdirSync(dirname(fake), { recursive: true, mode: 0o700 });
  writeFileSync(fake, '#!/bin/sh\nexit 1\n'); // fails the 3.11+ probe like an older interpreter
  chmodSync(fake, 0o700);
  return fake;
}

function privateSetupHome(t, { python, path }) {
  const root = fixture(t);
  chmodSync(root, 0o700);
  const env = { PATH: path, HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data') };
  const settings = join(env.XDG_CONFIG_HOME, 'toolsenabled-agent-kit');
  const data = join(env.XDG_DATA_HOME, 'toolsenabled-agent-kit');
  const work = join(root, 'work');
  mkdirSync(settings, { recursive: true, mode: 0o700 });
  mkdirSync(env.XDG_DATA_HOME, { recursive: true, mode: 0o700 });
  mkdirSync(work, { mode: 0o700 });
  const knowledgeConfig = join(data, 'knowledge-config.json');
  // INSTALL.md: configure the Python command and the canonical bundled knowledge.py; PATH stays unchanged.
  writeFileSync(join(settings, 'config.json'), JSON.stringify({
    fleet: { enabled: false }, engine: { enabled: false },
    knowledge: { enabled: true, command: python, args: [BUNDLED_KNOWLEDGE, '--config', knowledgeConfig, '--owner-launch'], env: {} },
    mcp: { folder: work },
  }, null, 2));
  const setup = (...extra) => spawnSync(process.execPath, [CLI, 'setup', '--folder', work, '--actor', 'local', '--no-browser', ...extra], {
    cwd: root, env, encoding: 'utf8', timeout: 90_000,
  });
  const saved = () => JSON.parse(readFileSync(join(settings, 'config.json'), 'utf8'));
  return { root, env, data, work, knowledgeConfig, setup, saved };
}

test('a configured Knowledge Python is validated and used; PATH is searched only without one', t => {
  if (isWindows) {
    t.skip('Windows configured-runtime selection is qualified on native Windows');
    return;
  }
  assert.equal(typeof platform.selectPython311, 'function', 'platform exports the configured-runtime selector');
  assert.equal(typeof platform.isPython311, 'function', 'platform exports the interpreter validator');
  const root = fixture(t), empty = join(root, 'empty-path');
  mkdirSync(empty);
  const configured = hostPython();
  assert.equal(platform.isPython311(configured, { PATH: empty }), true);
  assert.equal(platform.selectPython311(configured, { PATH: empty }), configured, 'the configured runtime is used although PATH has no Python');

  const old = oldPython(root);
  const named = (path) => (error) => error.message.includes(path) && /knowledge\.command/.test(error.message) && /Python 3\.11 or newer/.test(error.message);
  assert.equal(platform.isPython311(old, { PATH: empty }), false, 'the configured interpreter version is checked');
  assert.throws(() => platform.selectPython311(old, { PATH: empty }), named(old));
  assert.throws(() => platform.selectPython311(old, { PATH: dirname(configured) }), named(old), 'a configured runtime is never silently replaced by PATH');
  const missing = join(root, 'missing', 'python3');
  assert.throws(() => platform.selectPython311(missing, { PATH: empty }), named(missing));

  assert.equal(platform.selectPython311(null, { PATH: dirname(configured) }), python311({ PATH: dirname(configured) }), 'without a configured command PATH remains the fallback');
  assert.throws(() => platform.selectPython311(undefined, { PATH: empty }), /Python 3\.11 or newer was not found on PATH/);
});

test('setup with a configured Python that is not on PATH provisions the bundled Knowledge sample and config', { timeout: 120_000 }, t => {
  if (isWindows) {
    t.skip('Windows configured-runtime setup is qualified on native Windows');
    return;
  }
  const python = hostPython();
  const home = privateSetupHome(t, { python, path: pathWithoutPython(fixture(t)) });
  const result = home.setup();
  assert.equal(result.status, 0, `setup failed: ${result.stderr}\n${result.stdout}`);
  assert.doesNotMatch(result.stderr + result.stdout, /not found on PATH/);
  assert.match(result.stdout, /Knowledge \S+ sample repository/);
  assert.ok(result.stdout.includes(`Knowledge configured: ${python}`), result.stdout);
  assert.match(result.stdout, /Knowledge: .*MCP connection checked/, 'the configured interpreter really starts the bundled Knowledge MCP');
  const saved = home.saved();
  assert.equal(saved.knowledge.command, python, 'the configured interpreter stays selected');
  assert.deepEqual(saved.knowledge.args, [BUNDLED_KNOWLEDGE, '--config', home.knowledgeConfig, '--owner-launch']);
  const knowledgeConfig = JSON.parse(readFileSync(home.knowledgeConfig, 'utf8'));
  assert.equal(knowledgeConfig.repo, join(home.data, 'knowledge-repo'));
  assert.equal(knowledgeConfig.sync, 'off');
  assert.ok(existsSync(join(knowledgeConfig.repo, '.git')), 'the bundled Knowledge sample repository was created');
  assert.ok(existsSync(join(knowledgeConfig.repo, 'projects', 'sample', 'brief.md')));
});

test('setup --knowledge uses the configured Python that is not on PATH', { timeout: 120_000 }, t => {
  if (isWindows) {
    t.skip('Windows configured-runtime setup is qualified on native Windows');
    return;
  }
  const python = hostPython();
  const home = privateSetupHome(t, { python, path: pathWithoutPython(fixture(t)) });
  const result = home.setup('--knowledge', BUNDLED_KNOWLEDGE);
  assert.equal(result.status, 0, `setup failed: ${result.stderr}\n${result.stdout}`);
  assert.equal(home.saved().knowledge.command, python);
  assert.ok(existsSync(home.knowledgeConfig), 'the Knowledge config was provisioned');
});

test('setup refuses a configured Python older than 3.11 instead of replacing it from PATH', { timeout: 120_000 }, t => {
  if (isWindows) {
    t.skip('Windows configured-runtime setup is qualified on native Windows');
    return;
  }
  const python = hostPython();
  const root = fixture(t), old = oldPython(root);
  const home = privateSetupHome(t, { python: old, path: [dirname(python), dirname(which('git'))].join(delimiter) });
  const before = readFileSync(join(home.env.XDG_CONFIG_HOME, 'toolsenabled-agent-kit', 'config.json'), 'utf8');
  const result = home.setup();
  assert.notEqual(result.status, 0, 'setup must not succeed with an unusable configured interpreter');
  assert.ok(result.stderr.includes(old), result.stderr);
  assert.match(result.stderr, /knowledge\.command/);
  assert.equal(readFileSync(join(home.env.XDG_CONFIG_HOME, 'toolsenabled-agent-kit', 'config.json'), 'utf8'), before, 'settings were left unchanged');
  assert.equal(existsSync(home.knowledgeConfig), false, 'no Knowledge config was created');
});

test('default bundled-browser detection remains a read-only availability check', () => {
  const engine = fileURLToPath(new URL('../vendor/toolsengine/bin/toolsengine.js', import.meta.url));
  try {
    const browser = detectBundledBrowser(engine);
    assert.equal(typeof browser.executable, 'string');
    assert.ok(browser.executable.length > 0);
  } catch (error) {
    assert.match(error.message, /No installed Chrome, Edge or Chromium was found/);
  }
});
