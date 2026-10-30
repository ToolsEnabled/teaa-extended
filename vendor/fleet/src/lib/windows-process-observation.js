'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Owner SID, argument splitting and creation ordering are checked by the native
// helper. These observations never authorize process termination.
function readWindowsProcesses({ startPid, descendants = false, single = false, run = spawnSync, env = process.env } = {}) {
  const unavailable = () => Object.assign(new Error('Windows process observation is unavailable.'), { code: 'HUB_PROCESS_OBSERVATION_UNAVAILABLE' });
  if (!Number.isSafeInteger(startPid) || startPid < 2 || (single && descendants)) throw unavailable();
  const shell = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = run(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.resolve(__dirname, '../../tools/windows-process-observation.ps1'), '-StartPid', String(startPid), ...(descendants ? ['-Descendants'] : []), ...(single ? ['-Single'] : [])],
  { encoding: 'utf8', env, windowsHide: true, shell: false, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.signal || result.status !== 0) throw unavailable();
  let rows;
  try { rows = JSON.parse(result.stdout.replace(/^\uFEFF/, '')); } catch { throw unavailable(); }
  if (!Array.isArray(rows) || rows.length > 8192 || rows.some(row => !Number.isSafeInteger(row.pid) || row.pid < 2
    || !Number.isSafeInteger(row.ppid) || row.ppid < 0 || !/^win32:\d{12,20}$/.test(row.startTime)
    || (row.executable !== undefined && (typeof row.executable !== 'string' || row.executable.length > 32768))
    || !Array.isArray(row.argv) || row.argv.some(word => typeof word !== 'string'))) throw unavailable();
  const table = new Map(rows.map(row => [row.pid, row]));
  if (table.size !== rows.length || !table.has(startPid)) throw unavailable();
  return table;
}
module.exports = { readWindowsProcesses };
