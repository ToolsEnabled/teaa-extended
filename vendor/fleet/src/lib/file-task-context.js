'use strict';

// A private transport composition helper. Only the authenticated parent link
// supplies task identity; no MCP argument can open, reset or weaken a read set.
const contexts = require('./file-tool-capabilities');
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;

function changed() {
  return Object.assign(new Error('The assigned Fleet task changed during this file call. Read under the current task and reconcile the edit before retrying.'), {
    code: 'FLEET_FILE_TASK_CHANGED'
  });
}

function identity(value) {
  if (!value || typeof value.nodeId !== 'string' || typeof value.sessionId !== 'string'
      || !ID.test(value.nodeId) || !ID.test(value.sessionId) || typeof value.ownerId !== 'string' || !/^[a-f0-9]{64}$/.test(value.ownerId)
      || !Number.isSafeInteger(value.taskRevision) || value.taskRevision < 1) {
    throw Object.assign(new Error('The parent has not supplied a current Fleet task for file mediation.'), {
      code: 'FLEET_FILE_TASK_REQUIRED'
    });
  }
  return Object.freeze({ nodeId: value.nodeId, sessionId: value.sessionId, ownerId: value.ownerId, taskRevision: value.taskRevision });
}
const key = task => JSON.stringify([task.nodeId, task.sessionId, task.ownerId, task.taskRevision]);

function createTaskFileScope({ transport, resolveTask } = {}) {
  contexts.requireFileToolContext(transport);
  if (typeof resolveTask !== 'function') throw new TypeError('A private parent task resolver is required.');
  let current = null;
  let pending = Promise.resolve();
  const owner = Object.freeze({});
  contexts.onFileToolContextRetired(transport, owner, reason =>
    current ? contexts.retireFileToolContext(current.context, reason) : undefined);

  async function select() {
    contexts.requireFileToolContext(transport);
    const task = identity(await resolveTask());
    contexts.requireFileToolContext(transport);
    const taskKey = key(task);
    if (current && current.key === taskKey) {
      contexts.requireFileToolContext(current.context);
      return current.context;
    }
    if (current) {
      // A stale response must not rotate back into an old task or manufacture
      // another fresh scope for the same assignment.
      if (task.nodeId !== current.task.nodeId || task.sessionId !== current.task.sessionId || task.ownerId !== current.task.ownerId
          || task.taskRevision <= current.task.taskRevision) throw changed();
      await contexts.retireFileToolContext(current.context, 'fleet-task-replaced');
      contexts.requireFileToolContext(transport);
    }
    let revoked = false;
    const assertCurrent = () => {
      contexts.requireFileToolContext(transport);
      if (revoked) throw changed();
    };
    const context = Object.freeze({ binding: Object.freeze({
      // Durable task identity survives an authenticated transport reconnect.
      // The guard above still binds every live call to its actual session.
      principal: `worker:${task.ownerId}`, runtimeScopeId: `file-task-${task.ownerId}-${task.taskRevision}`,
      scopeKind: 'fleet-task', taskOwnerId: task.ownerId, taskRevision: task.taskRevision,
      canonicalLaunchId: null, laneId: null, runId: null, rosterRef: null
    }) });
    contexts.registerFileToolContext(context, {
      assertCurrent,
      async refresh() {
        const latest = identity(await resolveTask());
        if (key(latest) !== taskKey) revoked = true;
        assertCurrent();
      }
    });
    current = { task, key: taskKey, context };
    return context;
  }

  // Concurrent read dispatches share the same task scope. Resolve inside the
  // queue so a delayed response cannot replace a newer assignment's scope.
  return Object.freeze({ prepare() {
    const result = pending.then(select);
    pending = result.then(() => undefined, () => undefined);
    return result;
  } });
}

module.exports = { createTaskFileScope };
