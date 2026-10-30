// The person's everyday browser, reached through the Playwright Extension
// (--browser-extension). The extension itself is not here: a stand-in plays
// the part of the connection, so these tests show what ToolsEngine does
// before the person approves, after, and when the extension is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { parseConfig, configureBrowserEnvironment, channelExecutable } from '../src/config.js';
import { createBrowserBridge, EXTENSION_WAITING } from '../src/browser.js';
import { browserCapabilityStatus, serverInstructions } from '../src/server.js';
import { ownBrowserSkipped } from './support/browser-under-test.js';

// The real extension relay (pendingRelay below) looks for the installed Google
// Chrome before it opens its connect page, although the fixture stops the
// browser from starting. Without Chrome these tests could only time out.
const chromeInstalled = (() => { try { return Boolean(channelExecutable('chrome')); } catch { return false; } })();
const relaySkipped = chromeInstalled || process.platform === 'win32' ? false
  : `${'needs an installed Google Chrome'}: none was found where ToolsEngine looks for it, and the extension relay looks it up before it opens its connect page (nothing is started)`;

async function workspace(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-extension-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  return folder;
}

test('--browser-extension is its own browser mode and refuses settings that would name another browser', async t => {
  const dir = await workspace(t);
  const config = await parseConfig(['--workspace', dir, '--browser-extension']);
  assert.equal(config.browserExtension, true);
  const edge = await parseConfig(['--workspace', dir, '--browser-extension', '--browser-channel', 'msedge']);
  assert.equal(edge.browserChannel, 'msedge');
  const refused = [
    [['--profile-dir', path.join(dir, '..', 'te-profile-unused')], /Choose only one of --profile-dir, --cdp-endpoint or --browser-extension/],
    [['--cdp-endpoint', 'http://127.0.0.1:9222'], /Choose only one of --profile-dir, --cdp-endpoint or --browser-extension/],
    [['--browser-executable', '/usr/bin/true'], /not --browser-executable/],
    [['--browser-channel', 'firefox'], /chrome or msedge/],
    [['--no-browser-sandbox'], /no meaning with --no-browser, --cdp-endpoint or --browser-extension/],
    [['--no-browser'], /--no-browser cannot be combined/],
  ];
  for (const [extra, message] of refused)
    await assert.rejects(parseConfig(['--workspace', dir, '--browser-extension', ...extra]), message, extra.join(' '));
});

test('the extension connection cannot be steered to another browser, profile or wait by inherited variables', () => {
  const env = {
    PLAYWRIGHT_MCP_BROWSER: 'firefox', PLAYWRIGHT_MCP_EXECUTABLE_PATH: '/tmp/other', PLAYWRIGHT_MCP_PROFILE_DIR_NAME: 'Profile 9',
    PWTEST_EXTENSION_USER_DATA_DIR: '/tmp/x', PWTEST_EXTENSION_PROTOCOL: '1', pwtest_extension_connect_timeout: '1',
    PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'person-chose-this',
  };
  configureBrowserEnvironment({ env, platform: 'linux', profile: '/home/someone' });
  for (const name of ['PLAYWRIGHT_MCP_BROWSER', 'PLAYWRIGHT_MCP_EXECUTABLE_PATH', 'PLAYWRIGHT_MCP_PROFILE_DIR_NAME',
    'PWTEST_EXTENSION_USER_DATA_DIR', 'PWTEST_EXTENSION_PROTOCOL', 'pwtest_extension_connect_timeout'])
    assert.equal(env[name], undefined, name);
  assert.equal(env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, 'person-chose-this');
});

test('status and instructions say it is the person\'s own browser and that the person approves', t => {
  const saved = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  t.after(() => { if (saved === undefined) delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN; else process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = saved; });
  delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  const status = browserCapabilityStatus({ browserExtension: true }, true);
  assert.equal(status.browserMode, 'attached');
  assert.equal(status.browserSession, 'attached-extension-approved-tab');
  assert.equal(status.browserAuthSharing, 'selected-existing-session');
  assert.equal(status.browserApproval, 'each-connection');
  assert.equal(status.browserChannel, 'chrome');
  assert.equal(status.browserSandbox, null);
  assert.equal(status.browserConnectionVerified, false);
  process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = 'x';
  assert.equal(browserCapabilityStatus({ browserExtension: true }, true).browserApproval, 'extension-token');
  const text = serverInstructions({ browser: 'extension', desktop: false });
  assert.match(text, /everyday browser/);
  assert.match(text, /approval page/);
  assert.match(text, /never try to approve it yourself/);
  assert.doesNotMatch(text, /temporary profile|dedicated profile|sandbox/);
});

test('before approval a browser call says it is waiting, does nothing, and opens no second approval page; after approval it acts in the approved tab', { skip: ownBrowserSkipped }, async t => {
  const dir = await workspace(t);
  let calls = 0;
  let approve;
  const approved = new Promise(resolve => { approve = resolve; });
  const connectExtension = async ({ channel }) => { calls++; assert.equal(channel, 'chrome'); return approved; };
  const bridge = await createBrowserBridge({ workspace: dir, browserExtension: true, extensionApprovalWaitMs: 150 }, { connectExtension });
  t.after(() => bridge.close());
  const names = bridge.tools.map(tool => tool.name);
  assert.ok(!names.includes('browser.close'), 'the person\'s browser is never closed from here');
  const tabs = bridge.tools.find(tool => tool.name === 'browser.tabs');
  assert.deepEqual(tabs.inputSchema.properties.action.enum, ['list', 'new', 'select']);
  const snapshot = bridge.tools.find(tool => tool.name === 'browser.snapshot');
  assert.match(snapshot.description, /everyday browser, through its Playwright Extension/);

  for (let i = 0; i < 2; i++) {
    const waiting = await snapshot.handler({});
    assert.equal(waiting.isError, true);
    assert.deepEqual(waiting.content, [{ type: 'text', text: EXTENSION_WAITING }]);
  }
  assert.equal(calls, 1, 'one approval page, however often the assistant asks');

  // The person approves: a browser with one tab open stands in for theirs.
  const browser = await chromium.launch({ headless: true, chromiumSandbox: false, ...(process.env.TOOLSENGINE_TEST_BROWSER ? { executablePath: process.env.TOOLSENGINE_TEST_BROWSER } : {}) });
  t.after(() => browser.close().catch(() => {}));
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent('<title>Approved tab</title><h1>Signed in as the person</h1>');
  approve(browser);
  const result = await snapshot.handler({});
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.match(result.content.map(part => part.text || '').join('\n'), /Signed in as the person/);
  assert.equal(calls, 1);
});

test('a missing extension is said plainly, with what to install, and the next call asks again', { skip: ownBrowserSkipped }, async t => {
  const dir = await workspace(t);
  let calls = 0;
  const connectExtension = async () => {
    calls++;
    throw new Error('Playwright Extension not found in "/home/someone/.config/google-chrome/Default". Install it from https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm, or set the PLAYWRIGHT_MCP_EXECUTABLE_PATH environment variable to use a browser at a custom location.\nsecond line');
  };
  const bridge = await createBrowserBridge({ workspace: dir, browserExtension: true, extensionApprovalWaitMs: 150 }, { connectExtension });
  t.after(() => bridge.close());
  const snapshot = bridge.tools.find(tool => tool.name === 'browser.snapshot');
  for (let i = 1; i <= 2; i++) {
    const result = await snapshot.handler({});
    assert.equal(result.isError, true);
    const text = result.content.map(part => part.text || '').join('\n');
    assert.match(text, /Playwright Extension not found/);
    assert.match(text, /Install the Playwright Extension in the person's everyday browser/);
    assert.doesNotMatch(text, /second line/);
    assert.doesNotMatch(text, /PLAYWRIGHT_MCP_|environment variable/, 'no advice to set a variable this server removes');
    assert.equal(calls, i);
  }
});


// Exercise the actual factory function with only its bundle dependency replaced.
// No personal browser/profile is touched by these refusal-path tests.
async function extensionFactoryFixture(factory) {
  const { default: vm } = await import('node:vm');
  const source = await fs.readFile(new URL('../src/browser.js', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('export async function connectThroughExtension'), source.indexOf('// The dependency\'s own words when the extension is missing'))
    .replace('export ', '').replaceAll('import.meta.url', JSON.stringify(import.meta.url));
  return vm.runInNewContext('(' + fn + ')', { createRequire: () => () => ({ tools: { createBrowserWithInfo: factory } }) });
}

test('an extension unbind failure refuses the connection and disconnects it', async () => {
  let closed = 0;
  const browser = { unbind: async () => { throw new Error('pipe cleanup failed'); }, close: async () => { closed++; } };
  const connect = await extensionFactoryFixture(async () => ({ browser }));
  await assert.rejects(connect({ workspace: '/fixture' }), /pipe cleanup failed/);
  assert.equal(closed, 1);
});

test('closing after an unanswered approval disconnects a late approved browser', async t => {
  const dir = await workspace(t);
  let approve, started, closed = 0;
  const opening = new Promise(resolve => { started = resolve; });
  const approved = new Promise(resolve => { approve = resolve; });
  const bridge = await createBrowserBridge({ workspace: dir, browserExtension: true, extensionApprovalWaitMs: 10 }, {
    connectExtension: async () => { started(); return approved; },
  });
  const result = await bridge.tools.find(tool => tool.name === 'browser.snapshot').handler({});
  await opening;
  assert.equal(result.isError, true);
  await bridge.close();
  approve({ close: async () => { closed++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1, 'late approval must not retain a browser connection');
});

test('cancellation interrupts an active approval wait before cleanup waits for opening', { timeout: 5000 }, async t => {
  const dir = await workspace(t);
  let started, approve;
  const opening = new Promise(resolve => { started = resolve; });
  const approved = new Promise(resolve => { approve = resolve; });
  const bridge = await createBrowserBridge({ workspace: dir, browserExtension: true, extensionApprovalWaitMs: 3000 }, {
    connectExtension: async () => { started(); return approved; },
  });
  t.after(() => bridge.close());
  const controller = new AbortController();
  const call = bridge.tools.find(tool => tool.name === 'browser.snapshot').handler({}, { signal: controller.signal });
  await opening;
  const began = Date.now();
  controller.abort();
  await assert.rejects(call, /cancelled/);
  assert.ok(Date.now() - began < 500, 'pending approval cancellation must not wait for its timeout');
  approve({ close: async () => {} });
});

test('ending a live extension connection asks again and uses the new approved tab', { skip: ownBrowserSkipped }, async t => {
  const dir = await workspace(t);
  const browsers = [];
  t.after(async () => { for (const browser of browsers) await browser.close().catch(() => {}); });
  for (const title of ['First approval', 'New approval']) {
    const browser = await chromium.launch({ headless: true, chromiumSandbox: false,
      ...(process.env.TOOLSENGINE_TEST_BROWSER ? { executablePath: process.env.TOOLSENGINE_TEST_BROWSER } : {}) });
    browsers.push(browser);
    const page = await (await browser.newContext()).newPage();
    await page.setContent('<h1>' + title + '</h1>');
  }
  let calls = 0;
  const bridge = await createBrowserBridge({ workspace: dir, browserExtension: true, extensionApprovalWaitMs: 50 }, {
    connectExtension: async () => browsers[calls++],
  });
  t.after(() => bridge.close());
  const snapshot = bridge.tools.find(tool => tool.name === 'browser.snapshot');
  assert.match(JSON.stringify(await snapshot.handler({})), /First approval/);
  await browsers[0].close();
  const next = await snapshot.handler({});
  assert.notEqual(next.isError, true, JSON.stringify(next));
  assert.match(JSON.stringify(next), /New approval/);
  assert.equal(calls, 2);
});


// This fixture runs the REAL bundled factory and relay in the product worker.
// Synthetic extension-directory records replace a personal profile; spawn is
// intercepted before any browser process can start. No extension is approved.
async function pendingRelay(t, waitMs = 50) {
  const { Worker } = await import('node:worker_threads');
  const { createExtensionWorkerBridge } = await import('../src/extension-worker.js');
  const dir = await workspace(t);
  const fixtureHome = path.join(dir, 'fixture-home');
  const userDataDir = process.platform === 'win32' ? path.join(fixtureHome, 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
    : process.platform === 'darwin' ? path.join(fixtureHome, 'Library', 'Application Support', 'Google', 'Chrome')
    : path.join(fixtureHome, '.config', 'google-chrome');
  for (const name of ['Default', 'Profile 2', 'Profile 7'])
    await fs.mkdir(path.join(userDataDir, name, 'Extensions', 'mmlmfjhmonkocbjadbfplnigmagldckm'), { recursive: true });
  if (process.platform === 'win32') {
    // The fixture changes the account home before the real dependency loads.
    // A per-user Chrome therefore needs an inert executable entry in that
    // synthetic account too. spawn is intercepted below, so it never runs.
    const executable = path.join(fixtureHome, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe');
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.writeFile(executable, 'inert fixture; never executable');
  }
  await fs.writeFile(path.join(userDataDir, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 7' } }));
  let began;
  const started = new Promise(resolve => { began = resolve; });
  let ownedWorker, nextBegin;
  const nextConnection = () => new Promise(resolve => { nextBegin = resolve; });
  const config = { workspace: dir, browserExtension: true, extensionApprovalWaitMs: waitMs };
  const bridge = await createExtensionWorkerBridge(config, { workerFactory: data => {
    ownedWorker = new Worker(`
      const {parentPort,workerData} = require('node:worker_threads');
      const fixtureOS = require('node:os');
      const actualUserInfo = fixtureOS.userInfo;
      fixtureOS.homedir = () => workerData.fixtureHome;
      fixtureOS.userInfo = () => ({ ...actualUserInfo(), homedir: workerData.fixtureHome });
      require('node:module').syncBuiltinESMExports();
      delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
      require('node:child_process').spawn = (exe, args) => {
        parentPort.postMessage({ type: 'fixtureConnect', url: args.at(-1), profile: args.find(arg => arg.startsWith('--profile-directory=')) });
        return {};
      };
      import(workerData.entry);
    `, { eval: true, workerData: { ...data, fixtureHome,
      entry: new URL('../src/extension-worker.js', import.meta.url).href }, stdout: true, stderr: true });
    ownedWorker.on('message', message => { if (message.type === 'fixtureConnect') { began(message); nextBegin?.(message); nextBegin = undefined; } });
    return ownedWorker;
  } });
  t.after(() => bridge.close());
  return { bridge, started, nextConnection, dir, worker: () => ownedWorker };
}

async function relayPortIsClosed(url) {
  const { default: net } = await import('node:net');
  const endpoint = new URL(new URL(url).searchParams.get('mcpRelayUrl'));
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: endpoint.hostname.replace(/^\[|\]$/g, ''), port: Number(endpoint.port) });
    socket.once('connect', () => { socket.destroy(); reject(new Error('the cancelled relay still accepts connections')); });
    socket.once('error', error => { if (error.code === 'ECONNREFUSED') resolve(); else reject(error); });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('relay closure could not be checked')); });
  });
}

test('the real relay is revoked after a waiting response and late approval cannot connect', { skip: relaySkipped, timeout: 10000 }, async t => {
  const { bridge, started, dir } = await pendingRelay(t);
  const call = bridge.tools.find(tool => tool.name === 'browser.snapshot').handler({});
  const page = await started;
  assert.equal(page.profile, '--profile-directory=Profile 7', 'the last used installed profile is preferred');
  assert.equal(JSON.parse(new URL(page.url).searchParams.get('client')).name, 'ToolsEngine');
  const result = await call;
  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: 'text', text: EXTENSION_WAITING }]);
  const began = Date.now();
  await bridge.close();
  assert.ok(Date.now() - began < 1000);
  await relayPortIsClosed(page.url);
  assert.deepEqual((await fs.readdir(path.join(dir, '.toolsengine-runtime'))).filter(name => name.startsWith('extension-registry-')), []);
});

test('engine shutdown cancels an active real relay wait without waiting for approval', { skip: relaySkipped, timeout: 10000 }, async t => {
  const { createToolsEngine } = await import('../src/server.js');
  const { bridge, started, dir } = await pendingRelay(t, 60000);
  const engine = await createToolsEngine({ workspace: dir, browserExtension: true }, { makeBrowserBridge: async () => bridge });
  t.after(() => engine.close());
  const call = engine.call('browser.snapshot', {});
  const page = await started;
  const began = Date.now();
  await engine.close();
  assert.ok(Date.now() - began < 1000, 'engine.close must not wait for extension approval');
  assert.equal((await call).isError, true);
  await relayPortIsClosed(page.url);
});

test('client cancellation closes the real relay and the next browser call opens a fresh approval page', { skip: relaySkipped, timeout: 10000 }, async t => {
  const { bridge, started, nextConnection } = await pendingRelay(t, 60000);
  const snapshot = bridge.tools.find(tool => tool.name === 'browser.snapshot');
  const controller = new AbortController();
  const call = snapshot.handler({}, { signal: controller.signal });
  const page = await started;
  const began = Date.now();
  controller.abort();
  await assert.rejects(call, /cancelled/);
  assert.ok(Date.now() - began < 1000);
  await relayPortIsClosed(page.url);
  const againController = new AbortController();
  const reopened = nextConnection();
  const again = snapshot.handler({}, { signal: againController.signal });
  const fresh = await reopened;
  assert.notEqual(new URL(fresh.url).searchParams.get('mcpRelayUrl'), new URL(page.url).searchParams.get('mcpRelayUrl'));
  againController.abort();
  await assert.rejects(again, /cancelled/);
});


test('the bundled browser unbind removes its pipe and registry entry while preserving its context', { skip: ownBrowserSkipped }, async t => {
  const dir = await workspace(t);
  const registry = path.join(dir, 'registry');
  await fs.mkdir(registry);
  const handle = process.platform === 'linux' ? await fs.open(registry, 'r') : undefined;
  const saved = Object.fromEntries(['PWTEST_SERVER_REGISTRY', 'PWTEST_SOCKETS_DIR'].map(name => [name, process.env[name]]));
  process.env.PWTEST_SERVER_REGISTRY = registry;
  process.env.PWTEST_SOCKETS_DIR = process.platform === 'linux' ? `/proc/${process.pid}/fd/${handle.fd}` : registry;
  let browser;
  t.after(async () => {
    await browser?.close().catch(() => {});
    await handle?.close();
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  });
  browser = await chromium.launch({ headless: true, chromiumSandbox: false,
    ...(process.env.TOOLSENGINE_TEST_BROWSER ? { executablePath: process.env.TOOLSENGINE_TEST_BROWSER } : {}) });
  const context = await browser.newContext();
  const page = await context.newPage();
  const { endpoint } = await browser.bind('ToolsEngine fixture', { workspaceDir: dir });
  const entries = (await fs.readdir(registry)).filter(name => name !== 'browser');
  assert.equal(entries.length, 1);
  const descriptor = JSON.parse(await fs.readFile(path.join(registry, entries[0]), 'utf8'));
  assert.equal(descriptor.endpoint, endpoint);
  await browser.unbind();
  assert.deepEqual((await fs.readdir(registry)).filter(name => name !== 'browser'), []);
  if (process.platform !== 'win32') await assert.rejects(fs.stat(endpoint), /ENOENT/);
  assert.equal(browser.isConnected(), true);
  assert.equal(page.isClosed(), false);
});


test('extension descriptions and instructions disclose that a startup token skips approval', async t => {
  const dir = await workspace(t);
  const bridge = await createBrowserBridge({ workspace: dir, browserExtension: true }, { connectExtension: async () => { throw new Error('unused'); } });
  t.after(() => bridge.close());
  for (const tool of bridge.tools) assert.match(tool.description, /token.*skips approval/, tool.name);
  assert.match(serverInstructions({ browser: 'extension', desktop: false }), /token.*skips approval/);
});

test('README and status name the actual automatic extension profile selection', async () => {
  const text = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(text, /last.used profile with the extension installed/i);
  assert.match(text, /Default.*lowest.numbered/i);
  assert.match(text, /closed.*approval page|approval page.*closed/i);
  assert.equal(browserCapabilityStatus({ browserExtension: true }, true).browserProfileSelection, 'last-used-installed-else-default-or-lowest-numbered');
});

test('worker shutdown lets the bridge disconnect and finish cleanup before terminating', { skip: relaySkipped, timeout: 10000 }, async t => {
  const { bridge, started, worker } = await pendingRelay(t);
  let cleaned = false;
  worker().on('message', message => { if (message.type === 'stopped') cleaned = true; });
  const call = bridge.tools.find(tool => tool.name === 'browser.snapshot').handler({});
  await started;
  await call;
  await bridge.close();
  assert.equal(cleaned, true, 'give live browser and artifact cleanup a chance before terminating the relay');
});


test('the real extension stdio handshake offers only attached tools without opening a browser connection', { timeout: 15000 }, async t => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { fileURLToPath } = await import('node:url');
  const client = new Client({ name: 'extension-handshake-fixture', version: '1' });
  // Close the MCP child before removing its Windows current directory.
  t.after(() => client.close());
  const dir = await workspace(t);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../bin/toolsengine.js', import.meta.url)), '--workspace', dir, '--browser-extension'],
    cwd: dir, env: { ...process.env }, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr?.on('data', chunk => { diagnostics += chunk; });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 26);
  assert.ok(!tools.some(tool => tool.name === 'browser.close'));
  assert.deepEqual(tools.find(tool => tool.name === 'browser.tabs').inputSchema.properties.action.enum, ['list', 'new', 'select']);
  assert.match(client.getInstructions(), /token.*skips approval/);
  const result = await client.callTool({ name: 'system.status', arguments: {} });
  const status = JSON.parse(result.content[0].text);
  assert.equal(status.browserProfileSelection, 'last-used-installed-else-default-or-lowest-numbered');
  assert.equal(status.browserConnectionVerified, false);
  assert.equal(diagnostics, '');
});
