'use strict';
// Admission core ported from pinned 1.0.50. These are start reservations,
// never a process-count ceiling or a change to provider/folder authority.
const admission = require('./agent-resource-admission');
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function validatePolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('FLEET_RESOURCE_POLICY_INVALID', 'Resource policy must be an object.');
  const normalized = admission.normalizeSettings(value);
  for (const [key, raw] of Object.entries(value)) {
    if (!Object.hasOwn(normalized, key)) fail('FLEET_RESOURCE_POLICY_INVALID', `Unknown resource control ${key}.`);
    if (key === 'providerBytes') {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('FLEET_RESOURCE_POLICY_INVALID', 'Provider estimates must be an object.');
      for (const [provider, bytes] of Object.entries(raw))
        if (!Object.hasOwn(normalized.providerBytes, provider) || normalized.providerBytes[provider] !== bytes)
          fail('FLEET_RESOURCE_POLICY_INVALID', `Invalid reservation estimate for ${provider}.`);
    } else if (normalized[key] !== raw) fail('FLEET_RESOURCE_POLICY_INVALID', `Invalid resource control ${key}; preserve the CPU and interval relationships.`);
  }
  return normalized;
}
function createResourceGate({ settings, rootSessionId, now = Date.now,
  sample = require('./agent-resource-monitor').createResourceSampler({ now }), intervalMs = 1000 } = {}) {
  let closed = false, lastTick = now();
  const governor = admission.createResourceAdmission({ now, settings,
    authorizeAdvice: value => !closed && value.controllerId === rootSessionId });
  function tick() {
    if (closed) return;
    const current = now();
    if (settings().mode !== 'off') governor.recordSample(sample({ loopLagMs: Math.max(0, current - lastTick - intervalMs) }));
    lastTick = current;
  }
  const timer = intervalMs > 0 ? setInterval(tick, intervalMs) : null;
  timer?.unref?.();
  function checked(result) {
    if (!result.ok) fail(result.code, result.reason);
    return result;
  }
  async function start(spec, operation) {
    if (closed) fail('FLEET_RESOURCE_GATE_CLOSED', 'The resource gate is closed.');
    const reservation = checked(governor.reserve({ provider: spec.provider }));
    try {
      checked(governor.revalidate(reservation.token));
      const session = await operation();
      governor.ready(reservation.token);
      return session;
    } catch (error) { governor.release(reservation.token); throw error; }
  }
  function advise(input) {
    const value = { ...input, controllerId: rootSessionId };
    if (!governor.setAdvice(value)) fail('FLEET_RESOURCE_ADVICE_INVALID', 'Advice needs a stable id, supported provider, allow/hold decision, valid launch allowance and expiry within sixty seconds.');
    return { accepted: true, id: input.id, provider: input.provider };
  }
  return { start, advise, snapshot: governor.snapshot, tick,
    close: () => { closed = true; clearInterval(timer); } };
}
module.exports = { ...admission, validatePolicy, createResourceGate };
