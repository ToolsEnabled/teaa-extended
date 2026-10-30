'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('Windows path preflight validates a missing Fleet state path without creating it', { skip: process.platform !== 'win32' }, async () => {
  const { assertPrivateDataPath, createPrivateDataPath } = await import('../src/bundle.js');
  const parent = path.join(process.env.LOCALAPPDATA || os.homedir(), 'ToolsEnabled', `TEAA Extended private path ${process.pid}-${Date.now()}`);
  createPrivateDataPath(parent);
  const target = path.join(parent, 'Fleet state with spaces');
  try {
    assert.equal(fs.existsSync(target), false);
    assert.doesNotThrow(() => assertPrivateDataPath(target));
    assert.equal(fs.existsSync(target), false, 'the preflight created the state root before Fleet setup');
    createPrivateDataPath(target);
    assert.doesNotThrow(() => assertPrivateDataPath(target));
    assert.equal(fs.statSync(target).isDirectory(), true);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('Windows private data creation gives an explicitly owned leaf to its runtime', { skip: process.platform !== 'win32' }, async () => {
  const { createPrivateDataPath, assertPrivateDataPath } = await import('../src/bundle.js');
  const parent = path.join(process.env.LOCALAPPDATA || os.homedir(), 'ToolsEnabled', `TEAA Extended private create ${process.pid}-${Date.now()}`);
  createPrivateDataPath(parent);
  const target = path.join(parent, 'Knowledge repo with spaces');
  try {
    assert.equal(fs.existsSync(target), false);
    assert.doesNotThrow(() => createPrivateDataPath(target));
    assert.equal(fs.statSync(target).isDirectory(), true);
    assert.doesNotThrow(() => assertPrivateDataPath(target));
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});
