'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const helper = path.resolve(__dirname, '../../tools/windows-state-security.ps1');
const operations = new Set(['inspect', 'create', 'file', 'tree', 'ancestors', 'publish']);

function refuse() {
  return Object.assign(new Error('Windows host state must use a private, owned NTFS path without links or untrusted writers.'),
    { code: 'HOST_STATE_UNSAFE' });
}

let phase = null;
function withPhase(run, { stateRoot } = {}) {
  if (process.platform !== 'win32' || phase) return run();
  const current = { helper: null, stateRoot }; phase = current;
  try { return run(); }
  finally { try { if (current.helper) current.helper.close(); } finally { phase = null; } }
}

function check(operation, filename, source) {
  if (process.platform !== 'win32' || !operations.has(operation)
      || typeof filename !== 'string' || !path.isAbsolute(filename)) throw refuse();
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let result;
  if (phase) {
    phase.helper ||= require('./windows-security-phase').session({ command: shell,
      recordDirectory: path.join(phase.stateRoot, 'security-phase-jobs'),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Server'] });
    result = phase.helper.request(JSON.stringify({ operation, path: filename, ...(source === undefined ? {} : { source }) }));
  } else result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive',
    '-ExecutionPolicy', 'Bypass', '-File', helper], {
    input: JSON.stringify({ operation, path: filename, ...(source === undefined ? {} : { source }) }), encoding: 'utf8',
    windowsHide: true, shell: false, timeout: 30000, maxBuffer: 16384,
  });
  let evidence;
  try { evidence = JSON.parse(result.stdout.replace(/^\uFEFF/, '')); } catch { throw refuse(); }
  if (result.error || result.status !== 0 || evidence.ok !== true) throw refuse();
  if (operation === 'ancestors' || operation === 'publish') return evidence;
  if (evidence.fileSystem !== 'NTFS' || evidence.fixedDrive !== true
      || (operation === 'file' ? evidence.ownerTrusted !== true : evidence.ownedByUser !== true)
      || evidence.private !== true
      || evidence.writeRestricted !== true) throw refuse();
  return evidence;
}

function assertEntry(filename, directory) {
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
      || (!directory && stat.nlink !== 1)) throw refuse();
  check(directory ? 'inspect' : 'file', filename);
  return stat;
}

function assertTree(root) {
  check('tree', root);
  // NTFS file ACL inspection does not establish single-link identity.
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name), stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink()) throw refuse();
      if (stat.isDirectory()) visit(filename);
      else if (!stat.isFile() || stat.nlink !== 1) throw refuse();
    }
  };
  visit(root);
}

module.exports = Object.freeze({ check, assertEntry, assertTree, withPhase });
