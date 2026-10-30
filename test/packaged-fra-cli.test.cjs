'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

test('packaged TEAA status and open reach the FRA device/account path', { timeout: 30_000 }, async t => {
  const { createPrivateDataPath } = await import('../src/bundle.js');
  const scratch = process.platform === 'win32'
    ? path.join(os.tmpdir(), `teaa-packaged-fra-cli-${process.pid}-${crypto.randomBytes(8).toString('hex')}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'teaa-packaged-fra-cli-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  if (process.platform === 'win32') createPrivateDataPath(scratch);

  const env = {
    PATH: process.env.PATH || process.env.Path || '',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
    ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
    HOME: scratch,
    USERPROFILE: scratch,
    XDG_CONFIG_HOME: path.join(scratch, 'config'),
    XDG_DATA_HOME: path.join(scratch, 'data'),
    APPDATA: path.join(scratch, 'roaming'),
    LOCALAPPDATA: path.join(scratch, 'local'),
  };
  for (const directory of [env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.APPDATA, env.LOCALAPPDATA]) {
    createPrivateDataPath(directory);
  }
  if (process.platform === 'win32') {
    createPrivateDataPath(path.join(env.LOCALAPPDATA, 'ToolsEnabled', 'toolsenabled-agent-kit', 'extended', 'devices', 'default'));
  }

  const teaa = path.join(root, 'bin', 'teaa.js');
  const run = args => spawnSync(process.execPath, [teaa, ...args], {
    cwd: scratch, env, encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  const runAsync = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [teaa, ...args], {
      cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Packaged TEAA CLI timed out: ${stderr}`));
    }, 15_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
  const statusBefore = run(['status']);
  assert.equal(statusBefore.status, 0, statusBefore.stderr);
  assert.deepEqual(JSON.parse(statusBefore.stdout), { enrolled: false });

  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requests.push({ method: request.method, url: request.url, origin: request.headers.origin, body });
        if (request.method !== 'POST' || request.url !== '/v1/devices/claim-code'
            || request.headers.origin !== origin || body.name !== 'TEAA task6 local fixture'
            || typeof body.ed25519PublicKey !== 'string' || body.ed25519PublicKey.length < 32) {
          response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: { code: 'FIXTURE_REQUEST_INVALID', message: 'Expected local device claim request.' } }));
          return;
        }
        response.writeHead(201, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ claim: {
          code: 'TC-ABCD-EFGH', pollToken: 'task6-local-claim',
          expiresAtMs: Date.now() + 300_000, intervalSeconds: 2,
        } }));
      } catch {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        response.end('{"error":{"code":"FIXTURE_JSON_INVALID","message":"Malformed request."}}');
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(() => new Promise(resolve => server.close(resolve)));

  const opened = await runAsync(['open', '--account', origin, '--name', 'TEAA task6 local fixture', '--allow-insecure-loopback']);
  assert.equal(opened.status, 0, `${opened.error?.message || ''} ${opened.stderr} ${opened.stdout} requests=${requests.length}`);
  assert.deepEqual(JSON.parse(opened.stdout), { code: 'TC-ABCD-EFGH' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].url, '/v1/devices/claim-code');

  const statusAfter = run(['status']);
  assert.equal(statusAfter.status, 0, statusAfter.stderr);
  assert.deepEqual(JSON.parse(statusAfter.stdout), { enrolled: false });
});
