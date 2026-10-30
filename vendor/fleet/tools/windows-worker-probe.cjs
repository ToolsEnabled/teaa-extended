'use strict';
// Disposable native admission probe. It launches only this Node executable,
// receives the actual Job Object EMPTY receipt, and uses no provider login.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnInJob } = require('../src/lib/windows-job-control');
const { safeLaunchEnvironment } = require('../src/lib/supervision/launch-environment');
const security = require('../src/lib/windows-state-security');

(async () => {
  if (process.platform !== 'win32') throw new Error('Native Windows is required.');
  const root = path.join(os.userInfo().homedir, `.fleet-native-probe-${crypto.randomUUID()}`);
  security.check('create', root);
  let child;
  try {
    child = spawnInJob(process.execPath, ['-e', 'process.exit(0)'], {
      cwd: root, env: process.env, stdio: ['ignore', 'ignore', 'ignore'],
      terminateDescendantsOnRootExit: true,
    }, { recordDirectory: path.join(root, 'jobs'), assemblyCacheDirectory: null, safeLaunchEnvironment });
    child.on('error', () => {});
    await child.jobReady;
    const outcome = await child.jobOutcome;
    const closed = await child.jobClosed;
    if (outcome.type !== 'exit' || outcome.exitCode !== 0 || outcome.activeProcesses !== 0
        || closed.failure || closed.code !== 0 || closed.signal) throw new Error('Native containment probe failed.');
    process.stdout.write('{"available":true,"backend":"windows-job-object-v1"}\n');
  } finally {
    if (child) {
      await child.terminateJob();
      await child.jobClosed;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(() => { process.stderr.write('Windows native process admission failed.\n'); process.exitCode = 1; });
