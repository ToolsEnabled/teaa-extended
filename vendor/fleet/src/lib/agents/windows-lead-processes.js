'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function readWindowsLeadProcesses(startPid) {
  try {
    const identity = require('../process-claim-lock').processStartIdentity(process.pid);
    if (!/^win32:\d+$/.test(identity || '')) return null;
    const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32',
      'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive',
      '-ExecutionPolicy', 'Bypass', '-File', path.resolve(__dirname, '../../../tools/windows-lead-processes.ps1'),
      '-StartPid', String(startPid), '-ChildStartTicks', identity.slice(6)], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 15000, maxBuffer: 512 * 1024,
    });
    if (result.error || result.status !== 0) return null;
    const rows = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
    if (!Array.isArray(rows) || rows.length > 6 || rows.some(row =>
      !Number.isSafeInteger(row.pid) || !Number.isSafeInteger(row.parent) || !Array.isArray(row.argv)
      || row.argv.some(word => typeof word !== 'string'))) return null;
    return new Map(rows.map(row => [row.pid, row]));
  } catch { return null; }
}
module.exports = { readWindowsLeadProcesses };
