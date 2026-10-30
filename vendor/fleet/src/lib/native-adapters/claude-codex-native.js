'use strict';

// Native Claude Code and Codex decisions for Fleet.
//
// The loadable integration is the per-session MCP registration in
// session-registration.js. This module does not publish bytes, does not start
// a model, and does not disable native Edit, Write, Bash, or apply_patch.
// A hook permissionDecision of "allow" would skip native permission checks, and
// "deny" would block the native tool. Neither is a byte-authority redirect, so
// this module emits neither. Worker argv still must not gain --settings or a
// Codex hook -c overlay: tests/inheritance-matrix.test.js keep the person's
// settings and approval policy.

const path = require('node:path');

const HOOK_CLI = path.join(__dirname, 'hook-cli.js');
// Production value preserves the native tool. The faulty variant is 'deny',
// which blocks the tool instead of naming the missing interception contract.
const WORKER_MUTATOR_DECISION = 'preserve';

const MISSING_NATIVE_INTERCEPTION = Object.freeze({
  claude: 'Claude Code 2.1.310 PreToolUse has no field that runs Edit, Write, NotebookEdit, or MultiEdit through ByteAuthority. permissionDecision allow skips native checks; deny blocks the native tool; updatedInput still runs it. claude mcp list does not load --mcp-config.',
  codex: 'Codex 0.164.0 HookHandlerConfig has no onFailure. PreToolUsePermissionDecisionWire allow or deny does not replace apply_patch. mcpServer/tool/call calls an MCP tool on a thread and does not intercept apply_patch. mcpServerStatus/list only loads configured MCP servers. codex mcp list does not spawn them.'
});

const FILE_MUTATORS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'apply_patch']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'exec_command']);
const MEDIATED_SUFFIXES = new Set([
  'host.read_file', 'host.write_file', 'host.patch_file',
  'host_read_file', 'host_write_file', 'host_patch_file'
]);

const INSTALLED_CONTRACT = Object.freeze({
  claude: Object.freeze({
    command: 'claude',
    version: '2.1.310',
    package: '@anthropic-ai/claude-code',
    preToolUseCanBlock: true,
    failClosedField: 'onFailure',
    failClosedValue: 'block',
    failClosedDocumentedSince: '2.1.295',
    allowSkipsNativeChecks: true
  }),
  codex: Object.freeze({
    command: 'codex',
    version: '0.164.0',
    package: '@openai/codex',
    preToolUseCanBlockWhenHookRuns: true,
    failClosedField: null,
    untrustedHooksDoNotRun: true,
    hookErrorCanContinueTool: true,
    writeStdinSkipsSecondPreToolUse: true
  })
});

function scriptPath() { return HOOK_CLI; }

function toolSuffix(name) {
  const parts = String(name).split('__');
  return parts.length >= 3 ? parts[parts.length - 1] : String(name);
}

function isFleetMediatedTool(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 256) return false;
  if (MEDIATED_SUFFIXES.has(name)) return true;
  if (!/^mcp__toolsenabled(?:-fleet-host)?__/i.test(name)) return false;
  return MEDIATED_SUFFIXES.has(toolSuffix(name));
}

function isForeignFileMutation(name) {
  if (typeof name !== 'string' || !name.startsWith('mcp__') || isFleetMediatedTool(name)) return false;
  if (/^mcp__toolsenabled(?:-fleet-host)?__/i.test(name)) return false;
  const suffix = toolSuffix(name).toLowerCase();
  return /(write|edit|delete|remove|rename|move|unlink|patch|truncate)/.test(suffix)
    && /(file|path|dir|folder|apply)/.test(suffix);
}

function classifyTool(toolName) {
  if (typeof toolName !== 'string' || toolName.length === 0) return 'unnamed';
  if (isFleetMediatedTool(toolName)) return 'fleet-mediated';
  if (FILE_MUTATORS.has(toolName) || isForeignFileMutation(toolName)) return 'unmediated-file-mutation';
  if (SHELL_TOOLS.has(toolName)) return 'shell';
  if (toolName === 'Read') return 'native-read';
  return 'other';
}

function noDecision(fields) {
  return Object.freeze({
    exitCode: 0,
    stdout: '',
    permissionDecision: null,
    ...fields
  });
}

function deny(toolName, reason, fields) {
  const body = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  };
  return Object.freeze({
    exitCode: 0,
    stdout: JSON.stringify(body),
    permissionDecision: 'deny',
    toolName,
    reason,
    ...fields
  });
}

function workerMutationReason(toolName) {
  return `Native ${toolName} was not run. This worker hook cannot publish that call through the existing byte authority, and it does not grant the call. Use host.patch_file or host.write_file for a mediated change.`;
}

function decideNativeHook({ provider, path: pathKind, event } = {}) {
  if (provider !== 'claude' && provider !== 'codex') {
    return noDecision({
      guarantee: 'unknown-provider',
      outcome: 'unknown',
      skip: 'provider is not claude or codex'
    });
  }
  if (pathKind !== 'worker' && pathKind !== 'direct') {
    return noDecision({
      guarantee: 'unknown-path',
      outcome: 'unknown',
      provider,
      skip: 'path is not worker or direct'
    });
  }
  const record = event && typeof event === 'object' && !Array.isArray(event) ? event : {};
  const hookEvent = typeof record.hook_event_name === 'string' ? record.hook_event_name : '';
  const toolName = typeof record.tool_name === 'string' ? record.tool_name : '';
  const sessionId = typeof record.session_id === 'string' ? record.session_id : null;
  const kind = classifyTool(toolName);
  const base = {
    provider,
    path: pathKind,
    toolName,
    sessionId,
    kind,
    nestedAgentId: typeof record.agent_id === 'string' ? record.agent_id : null
  };
  if (hookEvent !== 'PreToolUse') {
    return noDecision({
      ...base,
      guarantee: hookEvent === 'PostToolUse' || hookEvent === 'PostToolUseFailure'
        ? 'post-tool-cannot-undo'
        : 'event-not-pretool',
      outcome: 'no-hook-decision',
      skip: hookEvent === '' ? 'hook_event_name missing' : `event ${hookEvent} is not a pre-execution gate`
    });
  }
  if (kind === 'fleet-mediated') {
    return noDecision({
      ...base,
      guarantee: 'existing-byte-authority',
      outcome: 'native-permissions-continue',
      skip: 'Fleet host file tool already uses the byte authority; the hook does not decide for it'
    });
  }
  if (kind === 'shell') {
    return noDecision({
      ...base,
      guarantee: 'unsupported-alternate-writer',
      outcome: 'native-permissions-continue',
      skip: 'shell and unified-exec follow-ups are not a complete enforcement boundary'
    });
  }
  if (kind !== 'unmediated-file-mutation') {
    return noDecision({
      ...base,
      guarantee: 'not-a-file-mutation',
      outcome: 'native-permissions-continue',
      skip: 'no file-mutation decision; native permission checks still apply'
    });
  }
  const missingContract = MISSING_NATIVE_INTERCEPTION[provider];
  if (WORKER_MUTATOR_DECISION === 'deny') {
    return deny(toolName, workerMutationReason(toolName), {
      ...base,
      guarantee: 'faulty-native-tool-deny',
      missingContract,
      outcome: record.cancelled === true ? 'cancelled' : 'blocked-before-native-tool'
    });
  }
  return noDecision({
    ...base,
    guarantee: 'mandatory-interception-unsupported',
    missingContract,
    outcome: record.cancelled === true ? 'cancelled' : 'native-permissions-continue',
    skip: pathKind === 'direct'
      ? 'direct/exterior native tool stays under native permissions; session MCP registration is separate'
      : 'worker native tool stays under native permissions; a deny hook is not byte mediation'
  });
}

function mapAuthorityRefusal(errorOrResult) {
  if (errorOrResult && errorOrResult.contract === 'v4-native-execution/1' && typeof errorOrResult.outcome === 'string') {
    const outcome = errorOrResult.outcome;
    return Object.freeze({
      permissionDecision: null,
      outcome,
      code: errorOrResult.uncertainty && errorOrResult.uncertainty.code || errorOrResult.reason || null,
      retry: false,
      reason: outcome === 'confirmed'
        ? 'The native-execution contract confirmed the publication. This hook does not grant or deny a native tool.'
        : 'The native-execution contract did not confirm a publication. This hook does not grant or deny a native tool.'
    });
  }
  const code = errorOrResult && typeof errorOrResult.code === 'string' ? errorOrResult.code : 'UNKNOWN';
  const stale = code === 'BYTE_READ_SET_STALE' || code === 'BYTE_READ_REQUIRED';
  return Object.freeze({
    permissionDecision: null,
    outcome: stale ? 'no' : 'unknown',
    code,
    retry: false,
    reason: stale
      ? 'The byte authority refused this write because the scope must reread current bytes. The refusal is not a native permission decision.'
      : 'The byte authority did not confirm this write. Do not retry it as a new publication, and do not deny the native tool from this mapping.'
  });
}

// Observations go through the caller's v4-native-execution/1 session. This
// module submits the exact delivered window: an internal reread must not
// create an agent observation, and a missing session must not invent one.
async function recordAgentObservation({ execution, session, resource, startByte, endByte, delivered, purpose, tool } = {}) {
  const preservedTool = typeof tool === 'string' ? tool : '';
  if (purpose === 'internal-reread') {
    if (!execution || typeof execution.internalReread !== 'function') {
      return Object.freeze({
        recorded: false, observationRefreshed: false, reason: 'internal-reread', tool: preservedTool, outcome: 'no'
      });
    }
    const check = await execution.internalReread(session, { resource });
    return Object.freeze({
      recorded: false,
      observationRefreshed: check ? check.observationRefreshed === true : false,
      returnedContent: Boolean(check && (Object.hasOwn(check, 'content') || Object.hasOwn(check, 'bytes'))),
      reason: 'internal-reread',
      tool: preservedTool,
      outcome: 'no'
    });
  }
  if (purpose !== 'agent-visible') {
    return Object.freeze({
      recorded: false,
      reason: 'purpose-not-agent-visible',
      tool: preservedTool,
      outcome: 'no'
    });
  }
  if (!execution || typeof execution.observeDelivered !== 'function') {
    return Object.freeze({
      recorded: false,
      reason: 'v4-native-execution/1-not-supplied',
      tool: preservedTool,
      outcome: 'unknown'
    });
  }
  if (!Buffer.isBuffer(delivered) || !Number.isSafeInteger(startByte) || startByte < 0
      || !Number.isSafeInteger(endByte) || endByte < startByte || delivered.length !== endByte - startByte) {
    return Object.freeze({ recorded: false, tool: preservedTool, outcome: 'no', reason: 'delivered-window-required' });
  }
  try {
    const observed = await execution.observeDelivered(session, { resource, startByte, endByte, delivered });
    return Object.freeze({
      recorded: true,
      tool: preservedTool,
      outcome: 'confirmed',
      receiptRef: observed && typeof observed.receiptRef === 'string' ? observed.receiptRef : null
    });
  } catch (error) {
    return Object.freeze({
      recorded: false,
      tool: preservedTool,
      outcome: 'unknown',
      code: error && typeof error.code === 'string' ? error.code : 'UNKNOWN',
      reason: 'observation failed once and was not retried'
    });
  }
}

function coverageMatrix() {
  const rows = [
    ['claude', 'direct', 'Edit/Write/NotebookEdit/MultiEdit', 'native-permissions-preserved', 'mandatory-interception-missing'],
    ['claude', 'worker', 'Edit/Write/NotebookEdit/MultiEdit', 'native-permissions-preserved', 'not-attached-to-worker-argv'],
    ['claude', 'direct', 'host.read_file/host.write_file/host.patch_file', 'existing-fleet-v4-serve', 'private-claude-config-mcp-list'],
    ['claude', 'worker', 'host.read_file/host.write_file/host.patch_file', 'existing-production-mcp', 'worker-mcp-config-not-a-deny-hook'],
    ['claude', 'both', 'Bash/PowerShell', 'unsupported-alternate-writer', 'not-disabled'],
    ['codex', 'direct', 'apply_patch/Edit/Write', 'native-permissions-preserved', 'mandatory-interception-missing'],
    ['codex', 'worker', 'apply_patch/Edit/Write', 'native-permissions-preserved', 'not-attached-trust-and-fail-open'],
    ['codex', 'direct', 'host.read_file/host.write_file/host.patch_file', 'existing-fleet-v4-serve', 'private-codex-home-mcpServerStatus-list'],
    ['codex', 'worker', 'host.read_file/host.write_file/host.patch_file', 'existing-production-mcp', 'worker-mcp-servers-c-override'],
    ['codex', 'both', 'Bash/exec_command/write_stdin', 'unsupported-alternate-writer', 'not-disabled'],
    ['codex', 'both', 'code-mode host', 'unchanged-existing-process', 'not-this-adapter'],
    ['both', 'both', 'PermissionRequest', 'no-decision', 'native-prompt-continues'],
    ['both', 'both', 'PostToolUse', 'cannot-undo', 'not-mediation'],
    ['both', 'both', 'create', 'existing-host.write_file', 'missing-file-create-existing-replace-requires-read'],
    ['both', 'both', 'delete/rename', 'unsupported-not-mediated', 'no-host-delete-or-rename-tool']
  ];
  return Object.freeze({
    versions: INSTALLED_CONTRACT,
    mandatoryMediation: false,
    newExecutor: false,
    nativeToolsDisabled: false,
    permissionBypass: false,
    missingNativeInterception: MISSING_NATIVE_INTERCEPTION,
    rows: Object.freeze(rows.map(row => Object.freeze({
      provider: row[0], path: row[1], surface: row[2], decision: row[3], attachment: row[4]
    })))
  });
}

module.exports = Object.freeze({
  INSTALLED_CONTRACT,
  MISSING_NATIVE_INTERCEPTION,
  WORKER_MUTATOR_DECISION,
  scriptPath,
  classifyTool,
  decideNativeHook,
  mapAuthorityRefusal,
  recordAgentObservation,
  coverageMatrix
});
