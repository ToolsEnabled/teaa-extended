import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { attachLocalKnowledgeOrigin, ensureCustomerKnowledge } from '../src/bundle.js';
import { knowledgeConfigPath } from '../src/config.js';

const CLI = fileURLToPath(new URL('../bin/teaa.js', import.meta.url));

function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'user.name=Knowledge MCP', '-c', 'user.email=knowledge@localhost', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return (result.stdout || '').trim();
}

function privateHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'teaa-knowledge-origin-'));
  chmodSync(dir, 0o700);
  mkdirSync(join(dir, 'data'), { mode: 0o700 });
  const previous = {
    HOME: process.env.HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
  };
  process.env.HOME = dir;
  process.env.XDG_DATA_HOME = join(dir, 'data');
  process.env.XDG_CONFIG_HOME = join(dir, 'config');
  if (process.platform === 'win32') {
    process.env.APPDATA = join(dir, 'AppData', 'Roaming');
    process.env.LOCALAPPDATA = join(dir, 'AppData', 'Local');
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('setup help names the local knowledge origin flag and rejects an unknown flag', () => {
  const help = spawnSync(process.execPath, [CLI, 'setup', '--help'], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--local-knowledge-origin/);
  assert.match(help.stdout, /leaves sync off/);
  const unknown = spawnSync(process.execPath, [CLI, 'setup', '--local-knowledge-origin', '--cloud-sync'], { encoding: 'utf8', timeout: 15_000 });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Unknown option/);
});

test('the sample has no origin until the explicit local bare origin is attached', (t) => {
  const dir = privateHome(t);
  const ensured = ensureCustomerKnowledge();
  assert.equal(ensured.created, true);
  const configPath = knowledgeConfigPath();
  const before = readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(before);
  assert.equal(parsed.sync, 'off');
  assert.equal(parsed.origin, undefined);
  assert.throws(() => git(ensured.repo, ['remote', 'get-url', 'origin']));
  const attached = attachLocalKnowledgeOrigin();
  assert.equal(attached.already, false);
  assert.equal(attached.sync, 'off');
  assert.equal(readFileSync(configPath, 'utf8'), before);
  assert.equal(git(ensured.repo, ['remote', 'get-url', 'origin']), attached.bare);
  const branch = git(ensured.repo, ['symbolic-ref', '--short', 'HEAD']);
  const local = git(ensured.repo, ['rev-parse', 'HEAD']);
  const origin = git(attached.bare, ['rev-parse', `refs/heads/${branch}`]);
  assert.equal(origin, local);
  const again = attachLocalKnowledgeOrigin();
  assert.equal(again.already, true);
  assert.equal(git(attached.bare, ['rev-parse', `refs/heads/${branch}`]), local);
  assert.equal(existsBareCount(dir), 1);
});

test('a network origin, another repository, sync, and a dirty sample are refused', (t) => {
  const dir = privateHome(t);
  const ensured = ensureCustomerKnowledge();
  git(ensured.repo, ['remote', 'add', 'origin', 'https://example.invalid/knowledge.git']);
  assert.throws(() => attachLocalKnowledgeOrigin(), /does not replace an existing origin/);
  assert.equal(git(ensured.repo, ['remote', 'get-url', 'origin']), 'https://example.invalid/knowledge.git');
  assert.equal(existsBareCount(dir), 0);
  git(ensured.repo, ['remote', 'remove', 'origin']);

  const configPath = knowledgeConfigPath();
  const saved = readFileSync(configPath, 'utf8');
  const other = join(dir, 'other-repo');
  mkdirSync(other, { mode: 0o700 });
  git(other, ['init']);
  const moved = JSON.parse(saved);
  moved.repo = other;
  writeFileSync(configPath, JSON.stringify(moved));
  assert.throws(() => attachLocalKnowledgeOrigin(), /left unchanged/);
  assert.equal(existsBareCount(dir), 0);
  writeFileSync(configPath, saved);

  const background = JSON.parse(saved);
  background.sync = 'background';
  writeFileSync(configPath, JSON.stringify(background));
  assert.throws(() => attachLocalKnowledgeOrigin(), /does not change sync/);
  assert.equal(existsBareCount(dir), 0);
  writeFileSync(configPath, saved);

  writeFileSync(join(ensured.repo, 'dirty.txt'), 'uncommitted\n');
  assert.throws(() => attachLocalKnowledgeOrigin(), /uncommitted changes/);
  assert.equal(existsBareCount(dir), 0);
  assert.throws(() => git(ensured.repo, ['remote', 'get-url', 'origin']));
});

function existsBareCount(dir) {
  const data = process.platform === 'win32'
    ? join(dir, 'AppData', 'Local', 'ToolsEnabled', 'toolsenabled-agent-kit')
    : join(dir, 'data', 'toolsenabled-agent-kit');
  const bare = join(data, 'knowledge-origin.git');
  try { return readFileSync(join(bare, 'HEAD'), 'utf8') ? 1 : 1; }
  catch (err) { return err.code === 'ENOENT' ? 0 : 1; }
}
