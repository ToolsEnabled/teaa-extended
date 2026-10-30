#!/usr/bin/env node
'use strict';

// Executable Grok paths. `hook` is fail-open and does not write.
// `mediate` is a legacy model-free Pi-tool validation helper, not an
// override for official Grok native tools. Grok uses its existing host MCP.
// Neither one is a live provider call.

const fs = require('node:fs');
const adapters = require('./native-harness-adapters');

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

function emit(value, code) {
  process.stdout.write(JSON.stringify(value) + '\n');
  process.exit(code);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}

function runHook() {
  const raw = readStdin();
  let input = {};
  if (raw.trim()) {
    try {
      input = JSON.parse(raw);
    } catch {
      emit({
        harness: 'grok',
        failOpen: true,
        mandatoryBoundary: false,
        authorizesMediation: false,
        mediatesBytes: false,
        decision: 'fail-open',
        reason: 'malformed-json'
      }, 0);
    }
  }
  if (input && (Object.hasOwn(input, 'event') || Object.hasOwn(input, 'exitCode') || input.timedOut === true)) {
    const classified = adapters.classifyGrokHook(input);
    emit(classified, classified.blocksTool ? 2 : 0);
  }
  emit({
    harness: 'grok',
    failOpen: true,
    mandatoryBoundary: false,
    authorizesMediation: false,
    mediatesBytes: false,
    decision: 'allow',
    reason: 'fail-open-hook-is-not-a-grant'
  }, 0);
}

function runContext() {
  const requested = Number(argument('--requested'));
  const windows = String(argument('--windows') || '').split(',').filter(Boolean).map(Number);
  const fallback = argument('--default');
  const selected = adapters.selectNativeContext({
    requestedTokens: requested,
    catalogWindows: windows,
    catalogDefault: fallback === undefined ? undefined : Number(fallback)
  });
  emit(selected, 0);
}

async function runMediate() {
  if (argument('--state-root') !== undefined) {
    emit({
      outcome: 'no',
      publicationCommitted: false,
      mediatesBytes: false,
      reason: 'HOST_SECOND_STORE_REJECTED',
      message: 'Grok mediation uses TOOLSENABLED_STATE_ROOT and hostByteAuthority. --state-root is not a second store.'
    }, 2);
  }
  const workspace = argument('--workspace');
  const resource = argument('--resource');
  const edits = JSON.parse(argument('--edits'));
  const bridge = require('./pi-host-bridge');
  const client = bridge.openHostClient({ harness: 'grok', workspace });
  try {
    const result = await bridge.editOfficial(client, { path: resource, edits });
    emit({
      outcome: 'confirmed',
      publicationCommitted: true,
      hookGuarantee: null,
      mediatesBytes: true,
      failOpen: true,
      mandatoryBoundary: false,
      autoObserve: false,
      nativeGrokTool: false,
      validationHelper: 'official-pi-operations',
      contentText: result.content[0].text,
      agentObservation: false
    }, 0);
  } catch (error) {
    const outcome = error && error.outcome === 'unknown' ? 'unknown' : 'no';
    const publicationCommitted = error && error.publicationCommitted === true
      ? true
      : error && error.publicationCommitted === 'unknown' ? 'unknown' : false;
    emit({
      outcome,
      publicationCommitted,
      mediatesBytes: true,
      failOpen: true,
      mandatoryBoundary: false,
      autoObserve: false,
      reason: error && error.code ? error.code : 'EDIT_FAILED'
    }, outcome === 'unknown' ? 3 : 2);
  }
}

async function main() {
  const command = process.argv[2];
  if (command === 'hook') return runHook();
  if (command === 'context') return runContext();
  if (command === 'mediate') return runMediate();
  emit({ reason: 'GROK_COMMAND_UNKNOWN', commands: ['hook', 'context', 'mediate'] }, 2);
}

main().catch(error => {
  emit({ outcome: 'unknown', reason: error && error.code ? error.code : 'GROK_PATH_FAILED', message: String(error && error.message || error) }, 3);
});
