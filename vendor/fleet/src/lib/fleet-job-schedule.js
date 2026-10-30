'use strict';

const units = { minutes: 60000, hours: 3600000, days: 86400000 };
function invalid() {
  throw Object.assign(new Error('Schedule must be null (off), {every: positive whole number, unit: minutes|hours|days}, or {dailyUtc: HH:MM}.'), { code: 'FLEET_JOB_SCHEDULE_INVALID' });
}
function configure(input, previous, templateTasks, at) {
  const base = { ...(previous || {}), editedAt: at };
  if (input === null) return { ...base, enabled: false, nextDueAt: null };
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  let timing, next;
  const current = Date.parse(at);
  if (Object.keys(input).length === 2 && Object.hasOwn(input, 'every') && Object.hasOwn(units, input.unit)
      && Number.isSafeInteger(input.every) && input.every > 0 && Number.isSafeInteger(input.every * units[input.unit])) {
    timing = { every: input.every, unit: input.unit };
    next = current + input.every * units[input.unit];
  } else if (Object.keys(input).length === 1 && typeof input.dailyUtc === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.dailyUtc)) {
    timing = { dailyUtc: input.dailyUtc };
    next = Date.parse(`${at.slice(0, 10)}T${input.dailyUtc}:00.000Z`);
    if (next <= current) next += units.days;
  } else invalid();
  if (!Number.isFinite(next) || next > 8640000000000000) invalid();
  return { ...base, enabled: true, timing, templateTasks, nextDueAt: new Date(next).toISOString(),
    runs: previous?.runs || 0, skippedRuns: previous?.skippedRuns || 0, skips: previous?.skips || [] };
}
function due(schedule, at) {
  return !!schedule?.enabled && Date.parse(schedule.nextDueAt) <= Date.parse(at);
}
function skip(schedule, count, first, last, at, reason) {
  if (!count) return;
  schedule.skippedRuns += count;
  schedule.skips.push({ status: 'skipped', count, firstDueAt: new Date(first).toISOString(), lastDueAt: new Date(last).toISOString(), at, reason });
}
function advance(schedule, at, reason) {
  const first = Date.parse(schedule.nextDueAt);
  const interval = schedule.timing.dailyUtc ? units.days : schedule.timing.every * units[schedule.timing.unit];
  const count = Math.floor((Date.parse(at) - first) / interval) + 1;
  const latest = first + (count - 1) * interval;
  schedule.nextDueAt = new Date(first + count * interval).toISOString();
  if (reason) { skip(schedule, count, first, latest, at, reason); return false; }
  // Collapse downtime into one current run, never a backlog of old runs.
  skip(schedule, count - 1, first, latest - interval, at, 'missed schedule checks; no catch-up backlog');
  schedule.runs++;
  schedule.lastRun = { status: 'queued', dueAt: new Date(latest).toISOString(), queuedAt: at };
  return true;
}
function summary(schedule, compact) {
  const { templateTasks, skips, ...metadata } = schedule;
  return { ...metadata, templateTaskCount: templateTasks?.length || 0,
    ...(compact ? { lastSkippedRun: skips?.at(-1) || null } : { templateTasks, skips: skips || [] }) };
}
module.exports = { configure, due, advance, summary };
