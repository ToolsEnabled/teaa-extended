'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const CODE = 'LINUX_PROCESS_NATIVE_UNAVAILABLE';
const MESSAGE = 'Host workers require Linux subreaper ownership with working pidfd support, or waitid ownership when pidfd_open is unavailable; this system lacks or blocks the required native process support.';

// Probe the exact host backend in a disposable helper. No provider process is
// admitted, and neither the OpenShell marker nor a successful earlier probe
// selects a backend or waives the guardian's own checks on every launch.
function requireHostWorkerNative({ spawnSyncImpl = spawnSync } = {}) {
  if (process.platform === 'win32') {
    let probe;
    try {
      probe = spawnSyncImpl(process.execPath, [path.resolve(__dirname, '../../tools/windows-worker-probe.cjs')], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false,
        windowsHide: true, timeout: 45000, maxBuffer: 4096,
      });
      if (!probe.error && probe.status === 0 && !probe.signal
          && probe.stdout === '{"available":true,"backend":"windows-job-object-v1"}\n')
        return Object.freeze({ backend: 'windows-job-object-v1' });
    } catch { /* Native failures do not admit an uncontained provider. */ }
    throw Object.assign(new Error('Windows host workers require private NTFS state and a working native Job Object backend.'),
      { code: 'WINDOWS_PROCESS_NATIVE_UNAVAILABLE', retryable: false });
  }
  let result;
  try {
    result = spawnSyncImpl('/usr/bin/python3', ['-I', '-S', '-B',
      path.join(__dirname, 'linux-process-supervisor.py'), '--probe'], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false,
      timeout: 5000, maxBuffer: 4096,
    });
    if (!result.error && result.status === 0 && !result.signal
        && (result.stdout === '{"available":true,"backend":"linux-subreaper-pidfd-v2"}\n'
          || result.stdout === '{"available":true,"backend":"linux-subreaper-waitid-v1"}\n')) {
      return Object.freeze({ backend: JSON.parse(result.stdout).backend });
    }
  } catch { /* Missing helpers, unsupported kernels and blocked syscalls refuse. */ }
  throw Object.assign(new Error(`${CODE}: ${MESSAGE}`), { code: CODE, retryable: false });
}

module.exports = { requireHostWorkerNative };
