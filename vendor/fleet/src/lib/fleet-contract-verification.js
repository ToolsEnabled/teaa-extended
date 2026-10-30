'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const OUTPUT_TAIL_BYTES = 8192;

// cmd.exe owns the final command-tail grammar. Passing that tail through the
// generic CRT argv encoder inserts backslash-escaped quotes, changing the
// lead-authored shell command. The wrapper's explicit verbatimArguments mode
// preserves only these inner arguments; its outer PowerShell argv stays CRT
// quoted as usual.
function buildWindowsCheckLaunch(command, { cwd, env, stdio, signal }) {
  return { command: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`],
    options: { cwd, env, stdio, signal, terminateDescendantsOnRootExit: true, verbatimArguments: true } };
}

// Use the current retained assignment, including after a task replacement or
// restart. CONTRACT/1 expansion puts its target in the opening ROLE line.
function assignmentWorkingDirectory(text, workspaceRoot) {
  const assignment = String(text || '').trim();
  const startingDirectory = /^Starting directory:\s*(.+)$/m.exec(assignment)?.[1]?.trim();
  const base = startingDirectory ? path.resolve(workspaceRoot, startingDirectory) : workspaceRoot;
  const target = /^ROLE: [A-Z]+ working in (.+?) -- /m.exec(assignment)?.[1]
    || (/^CONTRACT\/1(?:\r?\n|$)/.test(assignment) ? /^target(?:\s+|:\s*)(.+)$/m.exec(assignment)?.[1]?.trim() : null);
  if (target) {
    const directory = path.resolve(base, target);
    try { if (fs.statSync(directory).isDirectory()) return directory; } catch { /* A file/glob or absent target is not a working folder. */ }
  }
  return base;
}

// One shell at a time, inherited environment, no provider or tool-call lifetime.
// Abort on host shutdown leaves the durable task verifying for the next host.
function runCheck(check, { cwd, env, signal }) {
  return new Promise(resolve => {
    const started = performance.now();
    let tail = Buffer.alloc(0), timedOut = false, spawnError = null;
    const append = chunk => { tail = Buffer.concat([tail, Buffer.from(chunk)]).subarray(-OUTPUT_TAIL_BYTES); };
    let child;
    try {
      const options = { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], terminateDescendantsOnRootExit: true };
      // Verification is explicitly a lead-authored command in the inherited
      // host environment, rather than a provider login or observer launch.
      const dependencies = { safeLaunchEnvironment: environment => ({ ...environment }) };
      if (process.platform === 'linux') child = require('./linux-process-control').spawnLinuxOwned('sh', ['-c', check.command], options, dependencies);
      else if (process.platform === 'win32') {
        const launch = buildWindowsCheckLaunch(check.command, options);
        child = require('./windows-job-control').spawnInJob(launch.command, launch.args, launch.options, dependencies);
      }
      else child = spawn(check.command, { cwd, env, shell: true, detached: true, stdio: options.stdio });
    } catch (error) {
      resolve({ id: check.id, status: 'failed', exitCode: null, signal: null, durationMs: Math.round(performance.now() - started),
        timedOut: false, outputTail: String(error.code || 'SPAWN_FAILED'), outputTailBytes: OUTPUT_TAIL_BYTES, error: error.code || 'SPAWN_FAILED' });
      return;
    }
    const kill = () => {
      if (typeof child.terminateJob === 'function') { child.terminateJob().catch(() => {}); }
      else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); } }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, (check.timeoutSeconds ?? 600) * 1000);
    signal?.addEventListener('abort', kill, { once: true });
    if (signal?.aborted) kill();
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.on('error', error => { spawnError = error.code || 'SPAWN_FAILED'; append(`\n${spawnError}: ${error.message}`); });
    child.on('close', (exitCode, exitSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', kill);
      let outputTail = tail.toString('utf8');
      while (Buffer.byteLength(outputTail) > OUTPUT_TAIL_BYTES) outputTail = outputTail.slice(1);
      resolve({ id: check.id, status: exitCode === 0 && !timedOut && !spawnError ? 'passed' : 'failed',
        exitCode, signal: exitSignal, durationMs: Math.round(performance.now() - started), timedOut,
        outputTail, outputTailBytes: OUTPUT_TAIL_BYTES, ...(spawnError ? { error: spawnError } : {}) });
    });
  });
}
async function runChecks(checks, options) {
  const results = [];
  for (const check of checks) {
    if (options.signal?.aborted) return null;
    results.push(await runCheck(check, options));
  }
  return options.signal?.aborted ? null : results;
}
module.exports = { runChecks, assignmentWorkingDirectory, buildWindowsCheckLaunch, OUTPUT_TAIL_BYTES };
