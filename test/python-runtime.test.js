import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaults, detectKnowledge, knowledgeLaunch } from '../src/config.js';
import { detectBundledBrowser } from '../src/bundle.js';
import { python311, requirePython311, isWindows } from '../src/platform.js';

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
