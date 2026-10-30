'use strict';

// PreToolUse command hook. Reads one JSON object on stdin and writes either
// no bytes (native permissions continue) or a deny object. It does not publish
// files, spawn Codex, or print tool arguments.

const fs = require('node:fs');
const { decideNativeHook } = require('./claude-codex-native');

function flag(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) return null;
  return args[index + 1];
}

function finish(decision, stderr) {
  if (stderr) process.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`);
  if (decision.stdout) process.stdout.write(decision.stdout);
  process.exit(decision.exitCode);
}

function main(args, readStdin) {
  const provider = flag(args, '--provider');
  const pathKind = flag(args, '--path');
  let raw = '';
  try {
    raw = readStdin();
  } catch (error) {
    const stderr = `native-adapter: stdin unreadable (${error && error.code ? error.code : 'read-failed'})`;
    if (pathKind === 'worker') finish({ exitCode: 2, stdout: '' }, stderr);
    finish({ exitCode: 0, stdout: '' }, `${stderr}; direct path left the call to native permissions`);
  }
  let event;
  try {
    const text = String(raw);
    if (text.trim() === '') throw Object.assign(new Error('empty'), { code: 'empty' });
    event = JSON.parse(text);
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw Object.assign(new Error('shape'), { code: 'shape' });
    }
  } catch (error) {
    const stderr = `native-adapter: hook input refused (${error && error.code ? error.code : 'invalid-json'})`;
    if (pathKind === 'worker') finish({ exitCode: 2, stdout: '' }, stderr);
    finish({ exitCode: 0, stdout: '' }, `${stderr}; direct path left the call to native permissions`);
  }
  let decision;
  try {
    decision = decideNativeHook({ provider, path: pathKind, event });
  } catch (error) {
    const stderr = `native-adapter: decision failed (${error && error.code ? error.code : 'threw'})`;
    if (pathKind === 'worker') finish({ exitCode: 2, stdout: '' }, stderr);
    finish({ exitCode: 0, stdout: '' }, `${stderr}; direct path left the call to native permissions`);
  }
  // A pass writes nothing. Empty stdout is the Claude and Codex "no decision"
  // signal; a stderr notice here could be treated as a hook failure and, with
  // onFailure block, would stop the native tool the pass meant to leave alone.
  // The named skip stays on the decision object for in-process callers.
  finish(decision, '');
}

if (require.main === module) {
  main(process.argv.slice(2), () => fs.readFileSync(0, 'utf8'));
}

module.exports = { main };
