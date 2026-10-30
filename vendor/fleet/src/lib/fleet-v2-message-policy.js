'use strict';
const IDS = ['agent.message_delivery', 'agent.message_queue_seconds', 'fleet.worker_reset_after_task'];
function readPolicy({ read = () => require('./settings').loadSettings({ ids: IDS }) } = {}) {
  const { values, rejected = [] } = read();
  if (rejected.some(item => item.id === '*' || IDS.includes(item.id)))
    throw Object.assign(new Error('Message policy settings are unreadable.'), { code: 'FLEET_MESSAGE_POLICY_INVALID' });
  const mode = { Instant: 'instant', Timer: 'timer', 'End of turn': 'end-of-turn' }[values[IDS[0]]];
  const seconds = values[IDS[1]], reset = values[IDS[2]];
  if (!mode || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600 || typeof reset !== 'boolean')
    throw Object.assign(new Error('Message and task reset policy settings are invalid.'), { code: 'FLEET_MESSAGE_POLICY_INVALID' });
  return Object.freeze({ mode, intervalMs: seconds * 1000, resetAfterTask: reset });
}
function decision(policy, queue, { active = false, now = Date.now() } = {}) {
  if (!queue.length) return { allowed: false, delayMs: 0 };
  if (policy.mode === 'end-of-turn') return { allowed: !active, delayMs: 0 };
  if (policy.mode === 'instant') return { allowed: true, delayMs: 0 };
  const earliest = Date.parse(queue[0].at);
  // Old retained messages with no usable timestamp are already due.
  const due = Number.isFinite(earliest) ? earliest + policy.intervalMs : now;
  return { allowed: now >= due, delayMs: Math.max(0, due - now) };
}
module.exports = { readPolicy, decision };
