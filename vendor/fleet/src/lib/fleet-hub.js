'use strict';

// THE FLEET HUB: ONE FLEET, SEVERAL ORCHESTRATORS, NO SINGLE POINT OF FAILURE.
//
// Without a hub, the agent tree belongs to the MCP server the lead's CLI
// started (`fleetV2 serve`). Every worker is a child process of that server and
// reads its turns from a pipe the server holds, so when the CLI closes or
// reconnects its MCP servers the server's stdin ends, it stops every worker,
// and the next server finds them stopped (src/lib/openshell-tree-store.js
// settleLoadedTree, src/lib/host-runtime.js serveHost).
//
// A hub is that same root server, started detached (its own session, no
// stdin), so no CLI owns it. It holds the tree exactly as `serve` would
// (src/lib/host-agent-mode.js, unchanged), and instead of stdin it serves MCP
// on a private Unix socket. Each orchestrator's own `fleetV2 serve --hub`
// (or `--attach`) is a byte proxy from its CLI to that socket, so closing or
// reconnecting an orchestrator closes only its connection. Workers keep
// running and the remaining orchestrators keep controlling them.
//
// WHAT EACH ATTACHED ORCHESTRATOR GETS
//   * The full root tool surface, under the root session the tree already
//     knows, so every existing revision check, pause-before-edit rule and
//     permission ceiling applies to all of them unchanged.
//   * Its own read cursor into one durable journal of everything the tree
//     delivers to the root (worker reports, asks, messages, handoff notices).
//     Each answer carries what this orchestrator has not yet received; a cursor
//     moves only after the answer carrying those entries was written to its
//     socket (at least once). A late orchestrator starts LATE_ATTACH_BACKLOG
//     entries back and reads anything older with fleet.control action inbox.
//   * A name recorded on every call in hub-audit.jsonl and on the control
//     record's lifecycle, task, rule, answer, archive and settings edits.
//
// EQUAL LEADS. Every attached orchestrator has the same rights: all hub
// actions, answering asks and editing shared settings (recorded by name),
// exactly as the single lead could. There is no primary to promote or hand
// over; every report and ask reaches each one through its own cursor, so any
// of them may close without the others losing anything. fleet.control action
// handoff is a note any lead writes to another (attached or not): it lists the
// fleet's state, is saved under handoffs/ and is announced in the journal.
//
// SAFETY
//   * Same user, same machine: the socket is 0600 in a 0700 per-user runtime
//     directory (src/lib/fleet-runtime-socket.js), and every connection must
//     present the random token from hub.json (0600). No network port.
//   * The attaching serve/call process is observed as the same OS user and
//     resolves to this runtime's entry. No parent/launcher identity is inferred.
//     Levels reflect administrator settings; role and OS ceilings still apply.
//   * Orchestrator names attribute work; they grant no additional rights.
//
// Nothing here runs unless a person starts a hub or passes --hub/--attach.

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { EventEmitter } = require('node:events');

const HUB_PROTOCOL = 1;
const JOURNAL_KEEP = 2048;
const LATE_ATTACH_BACKLOG = 64;
const MAX_REPORTS_PER_ANSWER = 16;
const REPORTS_TEXT_BUDGET = 24 * 1024;
const MAX_HELLO_BYTES = 8192;
const HELLO_TIMEOUT_MS = 10_000;
const MAX_WAIT_SECONDS = 60;
const NOTE_RESULT_CHARS = 12_000;
const MAX_PROCESSES_PER_WORKER = 20;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HUB_ACTIONS = Object.freeze(['orchestrators', 'handoff', 'inbox']);
const CONTROL_NAMES = new Set(['fleet.control', 'fleet_control']);

function refusal(code, message) { return Object.assign(new Error(message), { code }); }
const nowIso = () => new Date().toISOString();

/* ----------------------------------------------------------- files -- */

function writePrivate(file, text) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
}
function privateDir(folder) {
  if (process.platform === 'win32') { require('./windows-state-security').check('create', folder); return folder; }
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.chmodSync(folder, 0o700);
  return folder;
}
function treeFolderOf(stateRoot, treeKey) {
  return path.join(stateRoot, 'workers', require('./openshell-tree-store').TREE_FOLDER, treeKey);
}
function hubFile(folder) { return path.join(folder, 'hub.json'); }

/** hub.json, only when it is a private regular file of this user naming a live hub. */
function readHub(folder, { requireAlive = true } = {}) {
  const file = hubFile(folder);
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096
      || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)))
    throw refusal('HUB_RECORD_UNSAFE', 'hub.json must be a private regular file owned by you; it was preserved.');
  let hub;
  try { hub = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw refusal('HUB_RECORD_UNREADABLE', 'hub.json could not be read; it was preserved.'); }
  if (!hub || hub.v !== HUB_PROTOCOL || !Number.isSafeInteger(hub.pid) || typeof hub.socketPath !== 'string'
      || typeof hub.token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(hub.token))
    throw refusal('HUB_RECORD_UNREADABLE', 'hub.json is not a hub record this version can use; it was preserved.');
  const alive = require('./proc/process-group').sameProcessAlive(hub.pid, hub.startTime);
  if (requireAlive && !alive) return null;
  return { ...hub, alive };
}

/* --------------------------------------------------------- journal -- */

function reportKey(report) {
  return crypto.createHash('sha256').update(JSON.stringify([report.from, report.nodeId, report.kind, report.at,
    report.text, report.reportId || null])).digest('hex');
}

/** Everything delivered to the root, numbered, durable, with bounded retention. */
function createJournal({ file, keep = JOURNAL_KEEP, now = nowIso }) {
  const events = new EventEmitter();
  events.setMaxListeners(0);
  let entries = [];
  const keys = new Set();
  let head = 0;
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const line of lines.slice(-keep)) {
      try {
        const entry = JSON.parse(line);
        if (Number.isSafeInteger(entry.seq) && entry.report) { entries.push(entry); keys.add(entry.key); head = Math.max(head, entry.seq); }
      } catch { /* a torn last line is skipped, never rewritten here */ }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let lineCount = entries.length;
  function append(report, kind = report?.kind || 'report') {
    if (!report || typeof report !== 'object') return null;
    const key = reportKey(report);
    if (keys.has(key)) return null;
    const entry = { seq: head + 1, at: now(), kind, key, report };
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    head = entry.seq;
    entries.push(entry);
    keys.add(key);
    lineCount += 1;
    if (entries.length > keep) for (const gone of entries.splice(0, entries.length - keep)) keys.delete(gone.key);
    if (lineCount > keep * 2) { writePrivate(file, entries.map(item => JSON.stringify(item)).join('\n') + '\n'); lineCount = entries.length; }
    events.emit('append', entry);
    return entry;
  }
  /** Entries after `cursor`, at most MAX_REPORTS_PER_ANSWER and REPORTS_TEXT_BUDGET bytes (one always). */
  function since(cursor, { max = MAX_REPORTS_PER_ANSWER, budget = REPORTS_TEXT_BUDGET } = {}) {
    const waiting = entries.filter(entry => entry.seq > cursor);
    const shown = [];
    let size = 0;
    for (const entry of waiting) {
      if (shown.length >= max) break;
      const bytes = Buffer.byteLength(JSON.stringify(entry.report));
      if (shown.length > 0 && size + bytes > budget) break;
      shown.push(entry);
      size += bytes;
    }
    return { entries: shown, more: waiting.length - shown.length };
  }
  function page({ offset, limit = 20 } = {}) {
    const first = entries.length ? entries[0].seq : head + 1;
    const start = offset === undefined ? Math.max(first, head - limit + 1) : offset;
    return { head, oldestRetained: first, entries: entries.filter(entry => entry.seq >= start).slice(0, limit) };
  }
  function waitSince({ since, limit = 20, waitSeconds, signal }) {
    if (!Number.isSafeInteger(since) || since < 0 || !Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds * 1000 > 2147468647)
      return Promise.reject(refusal('HUB_INBOX_INVALID', 'Supply a nonnegative since sequence and waitSeconds within the timer range.'));
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      return Promise.reject(refusal('HUB_INBOX_INVALID', 'Choose a limit from 1 through 100.'));
    return new Promise((resolve, reject) => {
      const current = () => page({ offset: since + 1, limit });
      const cleanup = () => { clearTimeout(timer); events.off('append', appended); signal?.removeEventListener('abort', aborted); };
      const finish = timedOut => { const value = current(); cleanup(); resolve({ ...value, timedOut }); };
      const appended = () => { if (current().entries.length) finish(false); };
      const aborted = () => { cleanup(); reject(signal.reason || new Error('Inbox wait cancelled.')); };
      const timer = setTimeout(() => finish(true), waitSeconds * 1000);
      events.on('append', appended);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
      else appended(); // Subscribe and inspect synchronously: no missed append.
    });
  }
  return Object.freeze({ append, since, page, waitSince, head: () => head, oldest: () => (entries.length ? entries[0].seq : head + 1),
    pending: cursor => entries.filter(entry => entry.seq > cursor).length, events });
}

/* -------------------------------------------------- orchestrators -- */

function createRegistry({ file, journal, backlog = LATE_ATTACH_BACKLOG, now = nowIso }) {
  privateDir(path.dirname(file));
  const { DatabaseSync } = require('node:sqlite');
  const databaseFile = `${file}.sqlite3`;
  const db = new DatabaseSync(databaseFile);
  if (process.platform !== 'win32') fs.chmodSync(databaseFile, 0o600);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS orchestrators (name TEXT PRIMARY KEY, cursor INTEGER NOT NULL, record TEXT NOT NULL, attached INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID; CREATE TABLE IF NOT EXISTS registry_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;');
  if (!db.prepare('PRAGMA table_info(orchestrators)').all().some(column => column.name === 'attached'))
    db.exec('ALTER TABLE orchestrators ADD COLUMN attached INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS orchestrators_attached_name ON orchestrators(attached,name)');
  let legacySnapshot = null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const migrated = db.prepare("SELECT value FROM registry_meta WHERE key='legacy-json-imported'").get();
    if (!migrated) {
      let legacy = null, legacyBytes = null;
      try { legacyBytes = fs.readFileSync(file, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (legacyBytes !== null) {
        try { legacy = JSON.parse(legacyBytes); }
        catch { throw refusal('HUB_REGISTRY_LEGACY_INVALID', 'The legacy orchestrator registry is malformed; its bytes were preserved and import was not recorded.'); }
        const validOrchestrators = legacy && typeof legacy === 'object' && !Array.isArray(legacy)
          && legacy.orchestrators && typeof legacy.orchestrators === 'object' && !Array.isArray(legacy.orchestrators);
        const validLegacy = validOrchestrators && legacy.v === 1;
        const validCompact = validOrchestrators && legacy.v === 2 && Object.keys(legacy.orchestrators).length === 0;
        if (!validLegacy && !validCompact)
          throw refusal('HUB_REGISTRY_LEGACY_INVALID', 'The legacy orchestrator registry has an unsupported shape; its bytes were preserved and import was not recorded.');
        legacySnapshot = legacy;
      }
      if (legacySnapshot?.v === 1) {
        const insert = db.prepare('INSERT OR IGNORE INTO orchestrators(name,cursor,record) VALUES(?,?,?)');
        for (const [name, value] of Object.entries(legacySnapshot.orchestrators)) {
          if (!value || typeof value !== 'object' || Array.isArray(value)
              || (value.cursor !== undefined && (!Number.isSafeInteger(value.cursor) || value.cursor < 0)))
            throw refusal('HUB_REGISTRY_LEGACY_INVALID', `The legacy orchestrator record for ${name} is invalid; import was not recorded.`);
          const record = { ...value, cursor: value.cursor ?? 0 };
          insert.run(name, record.cursor, JSON.stringify(record));
        }
      }
      db.prepare("INSERT INTO registry_meta(key,value) VALUES('legacy-json-imported','1')").run();
    }
    const totalCount = db.prepare("SELECT value FROM registry_meta WHERE key='total-count'").get();
    if (!totalCount) db.prepare("INSERT INTO registry_meta(key,value) VALUES('total-count',?)")
      .run(String(db.prepare('SELECT COUNT(*) AS n FROM orchestrators').get().n));
    const activeCount = db.prepare("SELECT value FROM registry_meta WHERE key='active-count'").get();
    if (!activeCount) db.prepare("INSERT INTO registry_meta(key,value) VALUES('active-count','0')").run();
    // Connections cannot survive a process restart. Clear only rows indexed as
    // attached and reset the exact counter; detached history is never walked.
    db.exec("UPDATE orchestrators SET attached=0 WHERE attached=1; UPDATE registry_meta SET value='0' WHERE key='active-count';");
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} db.close(); throw error; }
  // Replace the legacy hot file only after its indexed import commits. Its full
  // historical contents remain in SQLite and are available through paging.
  if (legacySnapshot?.v === 1 && Object.keys(legacySnapshot.orchestrators).length)
    writePrivate(file, `${JSON.stringify({ v: 2, orchestrators: {} })}\n`);
  const live = new Map(); // name -> { connection, pid, attachedAt }
  const get = name => {
    const row = db.prepare('SELECT record,attached FROM orchestrators WHERE name=?').get(name);
    if (!row) return null;
    try { return { ...JSON.parse(row.record), attached: row.attached === 1 }; } catch { throw refusal('HUB_REGISTRY_CORRUPT', `The retained orchestrator record for ${name} is unreadable.`); }
  };
  const put = (name, record) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = db.prepare('SELECT attached FROM orchestrators WHERE name=?').get(name);
      const attached = record.attached === true ? 1 : 0;
      db.prepare('INSERT INTO orchestrators(name,cursor,record,attached) VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET cursor=excluded.cursor,record=excluded.record,attached=excluded.attached')
        .run(name, record.cursor, JSON.stringify(record), attached);
      if (!previous) db.prepare("UPDATE registry_meta SET value=CAST(value AS INTEGER)+1 WHERE key='total-count'").run();
      if ((previous?.attached === 1) !== (attached === 1)) db.prepare("UPDATE registry_meta SET value=CAST(value AS INTEGER)+? WHERE key='active-count'").run(attached ? 1 : -1);
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  };
  const rowView = ([name, record]) => ({ name, actor: record.actor, role: live.has(name) ? 'lead' : 'detached',
    attached: live.has(name), cursor: record.cursor, pending: journal.pending(record.cursor),
    level: record.level ?? null, firstAttachedAt: record.firstAttachedAt, lastAttachedAt: record.lastAttachedAt,
    ...(record.lastDetachedAt ? { lastDetachedAt: record.lastDetachedAt } : {}) });
  function attach({ name, actor, pid, connection, level }) {
    const existing = live.get(name);
    if (existing) {
      if (existing.pid && require('./proc/process-group').sameProcessAlive(existing.pid, existing.startTime))
        throw refusal('HUB_ORCHESTRATOR_NAME_IN_USE', `Orchestrator ${name} is held by ${get(name)?.actor || 'unknown actor'}, pid ${existing.pid}, attached ${new Date(existing.attachedAt).toISOString()}. Reuse that connection or choose another name.`);
      existing.connection.destroy();
      live.delete(name);
    }
    const known = get(name);
    const record = known || { actor, cursor: Math.max(0, journal.head() - backlog), firstAttachedAt: now() };
    record.actor = actor;
    record.lastAttachedAt = now();
    record.level = level;
    record.attached = true;
    put(name, record);
    live.set(name, { connection, pid, startTime: require('./proc/process-group').processStartTime(pid), attachedAt: Date.now() });
    return { name, role: 'lead', cursor: record.cursor };
  }
  function detach(name, connection) {
    const entry = live.get(name);
    if (!entry || entry.connection !== connection) return { detached: false };
    live.delete(name);
    const record = get(name);
    if (record) { record.lastDetachedAt = now(); record.attached = false; put(name, record); }
    return { detached: true };
  }
  function known(name) {
    if (!get(name)) throw refusal('HUB_HANDOFF_TARGET_UNKNOWN', `${name} has never attached to this fleet. Use orchestrator history paging to find retained names.`);
    return { name, attached: live.has(name) };
  }
  function advance(name, seq) {
    const record = get(name);
    if (!record || !Number.isSafeInteger(seq) || seq <= record.cursor) return;
    record.cursor = seq;
    put(name, record);
  }
  function list() {
    return db.prepare('SELECT name,record,attached FROM orchestrators WHERE attached=1 ORDER BY name LIMIT 100').all()
      .map(row => [row.name, { ...JSON.parse(row.record), attached: row.attached === 1 }]).map(rowView);
  }
  function history({ offset = 0, limit = 20 } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw refusal('HUB_ORCHESTRATOR_PAGE_INVALID', 'History paging requires a nonnegative offset and a limit from 1 through 100.');
    const total = Number(db.prepare("SELECT value FROM registry_meta WHERE key='total-count'").get().value);
    // Names are ordered by SQLite's primary-key index; no full history is loaded.
    const rows = db.prepare('SELECT name,record FROM orchestrators ORDER BY name LIMIT ? OFFSET ?').all(limit, offset)
      .map(row => [row.name, JSON.parse(row.record)]).map(rowView);
    return { entries: rows, offset, limit, total, nextOffset: offset + rows.length < total ? offset + rows.length : null };
  }
  const counts = () => { const total = Number(db.prepare("SELECT value FROM registry_meta WHERE key='total-count'").get().value);
    const attached = Number(db.prepare("SELECT value FROM registry_meta WHERE key='active-count'").get().value);
    return { total, attached, detached: total - attached }; };
  return Object.freeze({ attach, detach, known, advance, list, history, counts, close: () => db.close(),
    cursor: name => get(name)?.cursor ?? 0,
    attached: () => [...live.keys()], connectionOf: name => live.get(name)?.connection || null });
}

/* ------------------------------------------------ fan-out wrapper -- */

/* The installed tree host, with one change at the dispatch boundary: whatever
   reports an answer carries go into the journal, and each orchestrator's answer
   carries instead its own unreceived journal entries. Inner calls (fleet.control
   lifecycle, the courier) use the unwrapped host and are unchanged. */
function wrapTreeHost(host, { journal, registry, als, listNodes }) {
  const absorb = result => {
    if (result && typeof result === 'object' && Array.isArray(result.reports)) for (const report of result.reports) journal.append(report);
  };
  const slice = name => {
    const { entries, more } = journal.since(registry.cursor(name));
    return { reports: entries.map(entry => Object.freeze({ ...entry.report, seq: entry.seq })), more,
      last: entries.length ? entries[entries.length - 1].seq : null };
  };
  const inject = result => {
    const context = als.getStore();
    if (!context?.orchestrator || !result || typeof result !== 'object' || Array.isArray(result)) return result;
    const { reports: _reports, moreReports: _more, ...rest } = result;
    const mine = slice(context.orchestrator);
    if (!mine.reports.length) return Object.freeze(rest);
    context.pendingCursor = Math.max(context.pendingCursor || 0, mine.last);
    return Object.freeze({ ...rest, reports: mine.reports, ...(mine.more ? { moreReports: mine.more } : {}) });
  };
  const wrap = fn => (typeof fn === 'function' ? async (...args) => { const result = await fn(...args); absorb(result); return inject(result); } : fn);
  const activeTurns = () => listNodes().filter(node => node.state === 'starting' || node.turn === 'running').length;
  async function wait(request = {}) {
    const context = als.getStore();
    if (!context?.orchestrator || request.reportId !== undefined || request.offset !== undefined || request.limit !== undefined
        || request.parentSessionId !== host.rootSessionId) return wrap(host.wait)(request);
    const seconds = request.timeoutSeconds === undefined ? 30 : request.timeoutSeconds;
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_WAIT_SECONDS)
      throw refusal('AGENT_WAIT_TIMEOUT_INVALID', `Choose a timeout from 1 through ${MAX_WAIT_SECONDS} seconds.`);
    const name = context.orchestrator;
    const ready = () => journal.pending(registry.cursor(name)) > 0 || activeTurns() === 0;
    let timedOut = false;
    if (!ready()) {
      await new Promise((resolve, reject) => {
        const signal = request.signal;
        const finish = (expired, error) => {
          clearTimeout(timer); clearInterval(poll);
          journal.events.off('append', onAppend);
          signal?.removeEventListener('abort', onAbort);
          if (error) reject(error); else { timedOut = expired; resolve(); }
        };
        const onAppend = () => { if (ready()) finish(false); };
        const onAbort = () => finish(false, Object.assign(new Error('Waiting for worker reports was cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' }));
        const timer = setTimeout(() => finish(true), seconds * 1000);
        const poll = setInterval(() => { if (ready()) finish(false); }, 1000);
        journal.events.on('append', onAppend);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort(); else if (ready()) finish(false);
      });
    }
    return inject({ ok: true, timedOut: timedOut && journal.pending(registry.cursor(name)) === 0, activeTurns: activeTurns() });
  }
  const wrapped = { ...host };
  for (const name of ['spawn', 'spawnConfined', 'command', 'commandConfined', 'commandContinuationConfined',
    'commandConfigurationConfined', 'commandSpeedConfined']) if (typeof host[name] === 'function') wrapped[name] = wrap(host[name]);
  wrapped.wait = wait;
  if (host.localComms) wrapped.localComms = Object.freeze({ send: wrap(host.localComms.send), roster: wrap(host.localComms.roster) });
  return Object.freeze(wrapped);
}

/* --------------------------------------------- lead verification -- */

function parentOf(pid, procRoot = '/proc', table = null) {
  if (table) { const row = table.get(pid); if (!row) throw refusal('HUB_PROCESS_GONE', 'process exited'); return row.ppid; }
  const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
}
function isAncestor(candidate, { start = process.pid, procRoot = '/proc', maxSteps = 16, platform = process.platform, observe = require('./windows-process-observation').readWindowsProcesses } = {}) {
  let table;
  try { if (platform === 'win32') table = observe({ startPid: start }); } catch { return false; }
  let pid = start;
  for (let step = 0; step < maxSteps && pid > 1; step += 1) {
    try { pid = parentOf(pid, procRoot, table); } catch { return false; }
    if (pid === candidate) return !table || table.has(pid);
  }
  return false;
}
function ownProcess(pid, procRoot = '/proc') {
  try {
    const status = fs.readFileSync(path.join(procRoot, String(pid), 'status'), 'utf8');
    const uid = Number((/^Uid:\s+(\d+)/m.exec(status) || [])[1]);
    return uid === process.getuid();
  } catch { return false; }
}
function cmdline(pid, procRoot = '/proc') {
  try { return fs.readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'utf8').split('\0').filter(Boolean); } catch { return null; }
}

function realEntryPath(file, realpath = fs.realpathSync) {
  try { return realpath(file); } catch { return null; }
}

/** Verify the attaching local runtime process, never a guessed parent agent. */
function orchestratorLead(pid, { registry, procRoot = '/proc', entry, platform = process.platform, observe = require('./windows-process-observation').readWindowsProcesses, realpath = fs.realpathSync } = {}) {
  const realEntry = realEntryPath(entry, realpath);
  if (!realEntry) return { verified: false, level: null };
  const matchesEntry = word => {
    const resolved = realEntryPath(word, realpath);
    return resolved !== null && (platform === 'win32' ? resolved.toLowerCase() === realEntry.toLowerCase() : resolved === realEntry);
  };
  if (platform === 'win32') {
    try {
      const table = observe({ startPid: pid, single: true });
      const proxy = table.get(pid);
      if (!proxy || !proxy.argv.some(matchesEntry) || !proxy.argv.some(word => ['serve', 'call'].includes(word))) return { verified: false, level: null };
      return { verified: true, lead: null, level: require('./agents/permission-level').leadLevel().level };
    } catch { return { verified: false, level: null }; }
  }
  if (!Number.isSafeInteger(pid) || pid <= 1 || !ownProcess(pid, procRoot)) return { verified: false, level: null };
  const argv = cmdline(pid, procRoot);
  if (!argv || !argv.some(matchesEntry) || !argv.some(word => ['serve', 'call'].includes(word))) return { verified: false, level: null };
  return { verified: true, lead: null, level: require('./agents/permission-level').leadLevel().level };
}

/** Local runtime identity is required; launcher names and strict-level inference are retired. */
function admitLevel(orchestratorLevel) {
  if (!Number.isSafeInteger(orchestratorLevel)) return { ok: false, code: 'HUB_ORCHESTRATOR_UNVERIFIED', message: 'The attaching orchestrator could not be verified from this machine\'s process table.' };
  return { ok: true };
}

/* ---------------------------------------------------- handoff note -- */

function redact(text) {
  try { return String(text).replace(require('./secret-patterns').plaintextCredentialPattern('gi'), '[redacted]'); }
  catch { return String(text); }
}
function processTable(procRoot = '/proc') {
  const rows = new Map();
  for (const name of fs.readdirSync(procRoot)) {
    if (!/^\d+$/.test(name)) continue;
    try { rows.set(Number(name), { ppid: parentOf(Number(name), procRoot), argv: cmdline(Number(name), procRoot) || [] }); } catch { /* raced */ }
  }
  return rows;
}
/* Which process is each worker, and what did it start? In host mode the tree
   record keeps no worker pid (the native supervisor owns it), so a worker is
   found among this hub's descendants by its private per-node MCP config path
   (<tree>/nodes/<nodeId>/) on its command line. Its jobs are its descendants
   other than Fleet's own servers. Bounded per worker; the bound is reported. */
function workerProcesses({ rootPid = process.pid, nodeIds, procRoot = '/proc', max = MAX_PROCESSES_PER_WORKER, platform = process.platform, observe = require('./windows-process-observation').readWindowsProcesses } = {}) {
  if (!nodeIds.length) return {};
  const table = platform === 'win32' ? observe({ startPid: rootPid, descendants: true }) : processTable(procRoot);
  const separator = platform === 'win32' ? path.win32.sep : path.sep;
  const children = new Map();
  for (const [pid, row] of table) { if (!children.has(row.ppid)) children.set(row.ppid, []); children.get(row.ppid).push(pid); }
  const below = pid => { const out = []; const seen = new Set([pid]); const queue = [...(children.get(pid) || [])]; while (queue.length) { const next = queue.shift(); if (seen.has(next)) continue; seen.add(next); out.push(next); queue.push(...(children.get(next) || [])); } return out; };
  const descendants = below(rootPid);
  const own = argv => argv.some(word => /toolsenabled-host\.js$|fleetV[234]\.js$|linux-process-supervisor\.py$/.test(word));
  const result = {};
  for (const nodeId of nodeIds) {
    const marker = `${separator}nodes${separator}${nodeId}${separator}`;
    const worker = descendants.find(pid => !own(table.get(pid)?.argv || []) && (table.get(pid)?.argv || []).some(word => word.includes(marker)));
    if (!worker) { result[nodeId] = { pid: null, processes: [], total: 0 }; continue; }
    // A job the worker detached (nohup, setsid, &) is adopted by the worker's
    // supervisor, a subreaper, not by the agent CLI: look below that.
    const parent = table.get(worker)?.ppid;
    const scope = parent && (table.get(parent)?.argv || []).some(word => /linux-process-supervisor\.py$/.test(word)) ? parent : worker;
    const found = [];
    let total = 0;
    for (const pid of below(scope)) {
      const row = table.get(pid);
      if (!row || pid === worker || own(row.argv)) continue;
      total += 1;
      if (found.length < max) found.push({ pid, command: redact(row.argv.join(' ')).slice(0, 200) });
    }
    result[nodeId] = { pid: worker, processes: found, total, ...(total > max ? { shown: max } : {}) };
  }
  return result;
}

async function buildHandoffNote({ from, to, reason, note, host, rootSessionId, registry, journal, treeFile, folder, now = nowIso }) {
  const workers = host.list();
  let control = null;
  try { control = await host.fleetControl({ action: 'read', view: 'full' }, rootSessionId); } catch (error) { control = { error: error.code || error.message }; }
  const jobs = workerProcesses({ nodeIds: workers.map(node => node.nodeId) });
  const lines = [`# Fleet handoff — ${now()}`, '',
    `From: ${from || 'the operator'}  To: ${to}  Reason: ${reason}`, ''];
  if (note) lines.push(`## Note from ${from || 'the operator'}`, '', redact(note), '');
  lines.push('## Orchestrators (first 100 by name)', '');
  const orchestratorPage = registry.history({ offset: 0, limit: 100 });
  for (const row of orchestratorPage.entries) lines.push(`- ${row.name} (${row.actor}) ${row.role}; cursor ${row.cursor}, ${row.pending} unreceived`);
  lines.push('', `Historical orchestrator identities retained: ${orchestratorPage.total}; ${orchestratorPage.nextOffset === null ? 'all entries shown' : `additional entries start at offset ${orchestratorPage.nextOffset}`}; page all identities with fleet.control action orchestrators and offset/limit.`);
  lines.push('', `Journal head ${journal.head()} (oldest retained ${journal.oldest()}).`, '', '## Workers', '');
  for (const node of workers) {
    const task = control?.tasks?.[node.nodeId];
    lines.push(`### ${node.nodeId} — ${node.displayName}`, '',
      `- ${node.provider} ${node.model || '-'}${node.effort ? `/${node.effort}` : ''}, role ${node.role || '-'}; state ${node.state}, turn ${node.turn || '-'}${node.lastTurn ? `, last turn ${node.lastTurn.status || '-'}` : ''}`);
    if (task) lines.push(`- Task r${task.taskRevision || 1} ${task.status}: ${redact(task.text).slice(0, 400).replace(/\n/g, ' ')}`,
      ...(task.progress ? [`- Progress: ${redact(task.progress).slice(0, 400).replace(/\n/g, ' ')}`] : []));
    const job = jobs[node.nodeId];
    lines.push(`- Process: ${job?.pid ? `pid ${job.pid}` : 'not running'}`);
    if (job && job.total) {
      lines.push(`- Background processes started by this worker: ${job.total}${job.shown ? ` (first ${job.shown} shown)` : ''}`);
      for (const process of job.processes) lines.push(`  - pid ${process.pid}: ${process.command}`);
    } else lines.push('- Background processes started by this worker: none running');
    lines.push('');
  }
  lines.push('## Open asks', '');
  const asks = Array.isArray(control?.pendingAsks) ? control.pendingAsks : [];
  if (!asks.length) lines.push('None.');
  for (const ask of asks) lines.push(`- ${ask.id} (${ask.nodeId}): ${redact(ask.question).slice(0, 600).replace(/\n/g, ' ')}`);
  lines.push('', '## Standing rules (active)', '');
  const rules = Object.entries(control?.rules || {}).filter(([, rule]) => rule.active);
  if (!rules.length) lines.push('None.');
  for (const [id, rule] of rules) lines.push(`- ${id}: ${redact(rule.text).replace(/\n/g, ' ')}`);
  if (control?.policies && Object.keys(control.policies).length) lines.push('', '## Orchestration policies', '', '```json', JSON.stringify(control.policies, null, 2), '```');
  lines.push('', `Control revision ${control?.revision ?? 'unknown'}${control?.error ? ` (read failed: ${control.error})` : ''}.`, '',
    '## Continuing', '', 'Read live state with fleet.control action read; missed reports with fleet.control action inbox; who is attached with fleet.control action orchestrators.');
  const text = lines.join('\n') + '\n';
  const dir = privateDir(path.join(folder, 'handoffs'));
  const file = path.join(dir, `${now().replace(/[^0-9A-Za-z]/g, '')}-${(from || 'operator')}-to-${to}.md`.replace(/[^A-Za-z0-9._-]/g, '_'));
  writePrivate(file, text);
  return { file, text };
}

/* ------------------------------------------------------- the hub -- */

/**
 * Serve the root's MCP over the hub socket. Called by host-runtime.serveHost
 * with the options and worker mode it built, exactly as stdio `serve` would.
 */
function createHubTransport({ config, actor, als, stdoutReady = true, entry }) {
  entry = realEntryPath(entry);
  return async function transport(options, workers, lifecycle = {}) {
    if (!workers) throw refusal('HUB_WORKERS_DISABLED', 'A Fleet hub holds workers; this installation has workers turned off.');
    if (typeof lifecycle.shutdown !== 'function') throw refusal('HUB_SHUTDOWN_UNAVAILABLE', 'The host did not provide its graceful shutdown path.');
    const shutdownHost = lifecycle.shutdown;
    const mcp = require('../mcp-server');
    const LEVELS = require('./agents/permission-level');
    const agents = require('./agents/registry').activeRegistry();
    const store = require('./openshell-tree-store');
    const folder = treeFolderOf(config.stateRoot, workers.treeKey);
    const treeFile = path.join(folder, config.treeStorage === 'sqlite-v1' ? 'tree.sqlite3' : 'tree.json');
    const journal = createJournal({ file: path.join(folder, 'hub-journal.jsonl') });
    const registry = createRegistry({ file: path.join(folder, 'hub-orchestrators.json'), journal });
    const auditFile = path.join(folder, 'hub-audit.jsonl');
    const audit = row => { try { fs.appendFileSync(auditFile, `${JSON.stringify({ at: nowIso(), ...row })}\n`, { mode: 0o600 }); } catch { /* audit is best effort, never fatal */ } };
    const raw = workers.host;
    const rootSessionId = workers.context.agentSessionId;
    const hubLevel = LEVELS.leadLevel().level;
    const wrapped = wrapTreeHost(raw, { journal, registry, als, listNodes: () => raw.list() });
    require('./tree-host-registry').installTreeSpawnHost(wrapped);
    const launch = mcp.transportActorOptions(options);
    const { observation, permissionSession } = mcp.transportPermission(launch);
    const token = crypto.randomBytes(32).toString('base64url');
    const socketPath = require('./fleet-runtime-socket').runtimeSocketPath(path.join(folder, 'hub.sock'));
    try { const stat = fs.lstatSync(socketPath); if (stat.isSocket()) fs.unlinkSync(socketPath); else throw refusal('HUB_SOCKET_UNSAFE', 'The hub socket path is not a socket; it was preserved.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }

    // The tree delivers to the root; the hub reads it into the journal at once.
    let draining = true, stopping = false;
    (async () => {
      while (draining) {
        try {
          const result = await raw.wait({ parentSessionId: rootSessionId, timeoutSeconds: 30 });
          if (Array.isArray(result?.reports)) for (const report of result.reports) journal.append(report);
          if (!result?.reports?.length && !result?.timedOut) await new Promise(resolve => setTimeout(resolve, 1000).unref());
        } catch { await new Promise(resolve => setTimeout(resolve, 2000).unref()); }
      }
    })();

    const handoff = async ({ from, to, reason, note }) => {
      registry.known(to);
      const written = await buildHandoffNote({ from, to, reason, note, host: raw, rootSessionId, registry, journal, treeFile, folder });
      journal.append({ from: 'fleet-hub', nodeId: null, kind: 'handoff', at: nowIso(),
        text: `Handoff note from ${from || 'the operator'} to ${to} (${reason}): ${written.file}` }, 'handoff');
      audit({ orchestrator: from, op: 'handoff', to, reason, note: written.file });
      return written;
    };
    const status = () => ({ hub: { pid: process.pid, treeKey: workers.treeKey, actor, level: hubLevel, socketPath, since: started },
      orchestrators: registry.list(), orchestratorCounts: registry.counts(), journal: { head: journal.head(), oldestRetained: journal.oldest() },
      workers: (() => { const nodes = raw.list(); const procs = workerProcesses({ nodeIds: nodes.map(node => node.nodeId) });
        return nodes.map(node => ({ nodeId: node.nodeId, displayName: node.displayName, state: node.state, turn: node.turn,
          pid: procs[node.nodeId]?.pid || null, backgroundProcesses: procs[node.nodeId]?.total || 0 })); })() });

    async function hubAction(name, args) {
      if (args.action === 'orchestrators') {
        const snapshot = status();
        const offset = args.offset === undefined ? 0 : args.offset;
        const limit = args.limit === undefined ? 20 : args.limit;
        return { you: name, ...snapshot, orchestratorHistory: registry.history({ offset, limit }) };
      }
      if (args.action === 'inbox') {
        if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0)) throw refusal('HUB_INBOX_INVALID', 'offset is a journal sequence number.');
        const limit = args.limit === undefined ? 20 : args.limit;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw refusal('HUB_INBOX_INVALID', 'Choose a limit from 1 through 100.');
        return { you: name, yourCursor: registry.cursor(name), ...journal.page({ offset: args.offset, limit }),
          note: 'Reading the inbox does not move your cursor; unreceived entries still arrive on your next agent.* answer.' };
      }
      if (args.action === 'handoff') {
        if (typeof args.id !== 'string' || !NAME.test(args.id)) throw refusal('HUB_HANDOFF_INVALID', 'Name the orchestrator to hand off to in id.');
        if (args.id === name) throw refusal('HUB_HANDOFF_INVALID', 'Name another orchestrator; a handoff note is for someone else.');
        const written = await handoff({ from: name, to: args.id, reason: 'explicit handoff', note: args.text });
        return { ok: true, from: name, to: args.id, noteFile: written.file, note: written.text.slice(0, NOTE_RESULT_CHARS),
          ...(written.text.length > NOTE_RESULT_CHARS ? { noteTruncated: true } : {}),
          closing: 'Every lead keeps the same rights; you may close this session and the workers keep running.' };
      }
      throw refusal('FLEET_CONTROL_ACTION_INVALID', 'Unknown Fleet control action.');
    }

    function patchToolList(result) {
      if (!result || !Array.isArray(result.tools)) return result;
      return { ...result, tools: result.tools.map(tool => {
        if (!CONTROL_NAMES.has(tool.name) || !tool.inputSchema?.properties?.action?.enum) return tool;
        const add = schema => ({ ...schema, properties: { ...schema.properties, action: { ...schema.properties.action,
          enum: [...schema.properties.action.enum, ...HUB_ACTIONS.filter(item => !schema.properties.action.enum.includes(item))] } } });
        return { ...tool, description: `${tool.description} Shared fleet (hub): action orchestrators lists at most 100 attached orchestrators and exact retained identity counts; use offset/limit to page durable orchestrator history. inbox reads the report journal (offset, limit); handoff writes a handoff note (fleet state plus optional text) for the orchestrator named in id and announces it to every lead; all attached leads have equal rights.`,
          inputSchema: add(tool.inputSchema), ...(tool.baseInputSchema?.properties?.action?.enum ? { baseInputSchema: add(tool.baseInputSchema) } : {}) };
      }) };
    }

    const started = nowIso();
    function attachConnection(socket, hello, rest) {
      const name = hello.name;
      const orchActor = hello.actor || actor;
      if (typeof name !== 'string' || !NAME.test(name)) throw refusal('HUB_ORCHESTRATOR_NAME_INVALID', 'Name an orchestrator with a lowercase id.');
      if (orchActor !== 'local' && !agents.has(orchActor)) throw refusal('HUB_ACTOR_INVALID', 'Actor must be a described provider or local.');
      const verified = orchestratorLead(hello.pid, { registry: agents, entry });
      const admitted = admitLevel(verified.verified ? verified.level : null, hubLevel, { lead: verified.lead });
      if (!admitted.ok) throw refusal(admitted.code, admitted.message);
      const attached = registry.attach({ name, actor: orchActor, pid: hello.pid, connection: socket, level: verified.level });
      audit({ orchestrator: name, op: 'attach', actor: orchActor, pid: hello.pid, level: verified.level, role: attached.role,
        detectedLead: verified.lead?.agentId || null, detectedLevel: verified.lead?.level ?? null,
        identifiedBy: 'local-runtime', program: verified.lead?.program || null,
        flags: verified.lead?.flags || [], strictLevel: false });
      socket.write(`${JSON.stringify({ fleetHub: HUB_PROTOCOL, ok: true, orchestrator: attached,
        hub: { pid: process.pid, treeKey: workers.treeKey, level: hubLevel } })}\n`);
      const leadTools = require('./fleet-v5-surface').leadToolNames({ generation: config.generation, admin: hello.admin === true, linkedWorker: false });
      const allowedToolNames = leadTools === undefined ? launch.allowedToolNames
        : launch.allowedToolNames === undefined ? leadTools : leadTools.filter(name => launch.allowedToolNames.includes(name));
      const nativeControlAllowed = allowedToolNames === undefined || allowedToolNames.includes('fleet.control');
      const { lineOptions, directFileScope } = mcp.transportSession({ ...launch, ...(allowedToolNames === undefined ? {} : { allowedToolNames }), agentActor: orchActor,
        ledgerLead: Object.freeze({ actor: orchActor, role: 'lead', id: name, sessionId: `hub-lead-${crypto.randomUUID()}` }) }, { observation, permissionSession });
      const handle = mcp.createLineDispatcher();
      const active = new Set();
      const onLine = line => {
        if (!line.trim()) return;
        let message = null;
        try { message = JSON.parse(line); } catch { /* the dispatcher answers a parse error */ }
        const context = { orchestrator: name, pendingCursor: null };
        const call = message && message.method === 'tools/call' ? message.params || {} : null;
        const write = value => {
          let output = value;
          if (message?.method === 'tools/list' && value?.result) output = { ...value, result: patchToolList(value.result) };
          const pending = context.pendingCursor;
          context.pendingCursor = null;
          socket.write(`${JSON.stringify(output)}\n`, error => { if (!error && pending) registry.advance(name, pending); });
          if (call) {
            const args = call.arguments && typeof call.arguments === 'object' ? call.arguments : {};
            audit({ orchestrator: name, op: 'tool', tool: call.name, ...(args.action ? { action: args.action } : {}),
              ...(args.nodeId ? { nodeId: args.nodeId } : {}), ...(args.id ? { id: args.id } : {}),
              ok: !(value?.error || value?.result?.isError),
              ...(value?.result?.structuredContent?.error?.code ? { errorCode: value.result.structuredContent.error.code } : {}),
              ...(value?.result?.structuredContent?.error?.diagnostic?.id ? { diagnosticId: value.result.structuredContent.error.diagnostic.id } : {}),
              ...(pending ? { delivered: pending } : {}) });
          }
        };
        const run = () => {
          if (call && nativeControlAllowed && CONTROL_NAMES.has(call.name) && HUB_ACTIONS.includes(call.arguments?.action)) {
            return hubAction(name, call.arguments).then(value => write({ jsonrpc: '2.0', id: message.id, result: mcp.toolResult(value) }),
              error => write({ jsonrpc: '2.0', id: message.id, result: mcp.toolError(error) }));
          }
          return handle(line, write, lineOptions, `hub:${name}`);
        };
        const request = als.run(context, run).catch(error => process.stderr.write(`[fleet-hub] ${mcp.publicMessage(error)}\n`));
        active.add(request);
        request.finally(() => active.delete(request));
      };
      let buffer = rest;
      const drain = () => {
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); onLine(line); }
      };
      socket.on('data', chunk => { buffer += chunk; if (buffer.length > 16 * 1024 * 1024) socket.destroy(); else drain(); });
      drain();
      socket.on('close', () => {
        registry.detach(name, socket);
        audit({ orchestrator: name, op: 'detach' });
        Promise.allSettled([...active]).then(() => require('./file-tool-context').retireFileToolContext(directFileScope, 'hub-detached').catch(() => {}));
      });
    }

    function adminConnection(socket, hello) {
      const reply = (value, flushed) => socket.end(`${JSON.stringify({ fleetHub: HUB_PROTOCOL, ...value })}\n`, flushed);
      (async () => {
        if (hello.op === 'status') return reply({ ok: true, ...status() });
        if (hello.op === 'inbox') {
          const controller = new AbortController();
          const disconnected = () => controller.abort(new Error('Inbox client disconnected.'));
          socket.once('close', disconnected);
          try {
            const page = hello.waitSeconds === undefined
              ? journal.page({ offset: hello.since, limit: Math.min(Math.max(Number(hello.limit) || 20, 1), 100) })
              : await journal.waitSince({ since: hello.since, limit: hello.limit, waitSeconds: hello.waitSeconds, signal: controller.signal });
            if (!socket.destroyed) reply({ ok: true, ...page, ...(hello.orchestrator ? { cursor: registry.cursor(hello.orchestrator) } : {}) });
          } finally { socket.off('close', disconnected); }
          return;
        }
        if (hello.op === 'handoff') {
          if (typeof hello.to !== 'string' || !NAME.test(hello.to)) throw refusal('HUB_HANDOFF_INVALID', 'Name the orchestrator to hand off to.');
          const written = await handoff({ from: null, to: hello.to, reason: 'operator handoff (fleetV2 hub handoff)', note: hello.note });
          return reply({ ok: true, from: null, to: hello.to, noteFile: written.file });
        }
        if (hello.op === 'stop') {
          const firstStop = !stopping;
          stopping = true;
          if (firstStop) {
            let shutdownStarted = false;
            const beginShutdown = () => {
              if (shutdownStarted) return;
              shutdownStarted = true;
              void shutdownHost();
            };
            socket.once('close', beginShutdown);
            reply({ ok: true, stopping: true }, beginShutdown);
            audit({ op: 'stop', by: 'operator' });
          } else reply({ ok: true, stopping: true });
          return undefined;
        }
        throw refusal('HUB_OP_INVALID', 'Unknown hub operation.');
      })().catch(error => { if (!socket.destroyed) reply({ ok: false, code: error.code || 'HUB_ERROR', message: error.message }); });
    }

    const server = net.createServer(socket => {
      socket.setEncoding('utf8');
      let buffer = '';
      const timer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
      const onData = chunk => {
        buffer += chunk;
        const index = buffer.indexOf('\n');
        if (index < 0) { if (buffer.length > MAX_HELLO_BYTES) socket.destroy(); return; }
        clearTimeout(timer);
        socket.off('data', onData);
        const rest = buffer.slice(index + 1);
        let hello;
        try { hello = JSON.parse(buffer.slice(0, index)); } catch { hello = null; }
        const fail = (code, message) => socket.end(`${JSON.stringify({ fleetHub: HUB_PROTOCOL, ok: false, code, message })}\n`);
        const presented = Buffer.from(String(hello?.token || ''));
        const expected = Buffer.from(token);
        if (!hello || hello.fleetHub !== HUB_PROTOCOL || presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
          audit({ op: 'refused', code: 'HUB_TOKEN_INVALID' });
          return fail('HUB_TOKEN_INVALID', 'This connection did not present the hub token.');
        }
        if (hello.op !== 'attach') return adminConnection(socket, hello);
        try { attachConnection(socket, hello, rest); }
        catch (error) { audit({ op: 'refused', orchestrator: hello.name, code: error.code }); fail(error.code || 'HUB_ATTACH_REFUSED', error.message); }
      };
      socket.on('data', onData);
      socket.on('error', () => {});
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); });
    fs.chmodSync(socketPath, 0o600);
    const record = { v: HUB_PROTOCOL, pid: process.pid, startTime: require('./proc/process-group').processStartTime(process.pid),
      since: started, socketPath, token, treeKey: workers.treeKey, actor, level: hubLevel, entry };
    writePrivate(hubFile(folder), `${JSON.stringify(record)}\n`);
    audit({ op: 'start', pid: process.pid, treeKey: workers.treeKey, level: hubLevel });
    const cleanup = () => {
      draining = false;
      try { registry.close(); } catch { /* cleanup is best-effort during shutdown */ }
      try { const current = readHub(folder, { requireAlive: false }); if (current && current.pid === process.pid) fs.rmSync(hubFile(folder), { force: true }); } catch { /* preserved */ }
      try { fs.rmSync(socketPath, { force: true }); } catch { /* best effort */ }
    };
    process.once('exit', cleanup);
    if (stdoutReady) {
      // The starter reads this one line and goes; nothing else is written here.
      process.stdout.on('error', () => {});
      process.stdout.end(`${JSON.stringify({ fleetHub: HUB_PROTOCOL, ready: true, pid: process.pid, treeKey: workers.treeKey, level: hubLevel })}\n`);
    }
    return { server, journal, registry, cleanup };
  };
}

/** `fleetV2 hub run`: the detached process itself. */
async function runHub({ config, actor, treeKey = null, leadPid = null, entry }) {
  const key = treeKey || actor;
  const als = new AsyncLocalStorage();
  const transport = createHubTransport({ config, actor, als, entry });
  return require('./host-runtime').serveHost(config, { actor, treeKey: key, allowNamedTree: true, transport,
    controlAttribution: () => als.getStore()?.orchestrator || null });
}

/* ------------------------------------------------------ clients -- */

function connect(socketPath, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || new Error('Fleet attachment aborted.')); return; }
    const socket = net.createConnection({ path: socketPath, ...(signal ? { signal } : {}) });
    const cleanup = () => { socket.off('connect', onConnect); socket.off('error', onError); };
    const onConnect = () => { cleanup(); resolve(socket); };
    const onError = error => { cleanup(); socket.destroy(); reject(error); };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}
function firstLine(socket, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => { cleanup(); reject(refusal('HUB_TIMEOUT', 'The hub did not answer.')); }, timeoutMs);
    const onData = chunk => {
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      cleanup();
      try { resolve({ value: JSON.parse(buffer.slice(0, index)), rest: buffer.slice(index + 1) }); } catch (error) { reject(error); }
    };
    const onEnd = () => { cleanup(); reject(refusal('HUB_CLOSED', 'The hub closed the connection.')); };
    const onError = error => { cleanup(); reject(error); };
    const cleanup = () => { clearTimeout(timer); socket.off('data', onData); socket.off('end', onEnd); socket.off('error', onError); socket.off('close', onEnd); };
    socket.setEncoding('utf8');
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('close', onEnd);
    socket.once('error', onError);
  });
}

/** After stop is accepted, resolve only once that hub process is no longer the live record.
 *  Uses the same 60s bound as hub start. A following start must not join the hub that just stopped. */
async function waitUntilStopped(folder, hub, { timeoutMs = 60_000 } = {}) {
  const group = require('./proc/process-group');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const alive = group.sameProcessAlive(hub.pid, hub.startTime);
    const visible = readHub(folder);
    if (!alive && !visible) return { stopped: true };
    if (Date.now() > deadline) throw refusal('HUB_STOP_TIMEOUT', 'The hub accepted stop but was still running. Nothing else was changed.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** One operator request (status, inbox, handoff, stop) to a running hub. */
async function adminRequest(folder, op, fields = {}) {
  const hub = readHub(folder);
  if (!hub) throw refusal('HUB_NOT_RUNNING', 'No Fleet hub is running for this tree.');
  require('./fleet-runtime-socket').assertPrivateRuntimeSocketPath(hub.socketPath);
  const socket = await connect(hub.socketPath);
  socket.write(`${JSON.stringify({ fleetHub: HUB_PROTOCOL, op, token: hub.token, ...fields })}\n`);
  let value;
  try { ({ value } = await firstLine(socket, fields.waitSeconds === undefined ? 15_000 : fields.waitSeconds * 1000 + 15_000)); }
  finally { socket.destroy(); }
  if (!value.ok) throw refusal(value.code || 'HUB_ERROR', value.message || 'The hub refused.');
  return value;
}

/** A ready line alone is not a successful startup. Never accept another tree. */
function assertHubReady({ ready, hub, key, actor, pid }) {
  if (!ready || ready.fleetHub !== HUB_PROTOCOL || ready.ready !== true || ready.pid !== pid
      || ready.treeKey !== key || !Number.isInteger(ready.level) || ready.level < 1 || ready.level > 4
      || !hub || hub.pid !== pid || hub.treeKey !== key || hub.actor !== actor || hub.level !== ready.level)
    throw refusal('HUB_START_NOT_READY', 'The child and retained hub record did not confirm the requested tree; startup was not confirmed.');
}

/** Start a detached hub (or find the one running). Serialized per tree. */
async function startHub({ config, actor, treeKey = null, entry, env = process.env, timeoutMs = 60_000 }) {
  const key = treeKey || actor;
  if (typeof key !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key))
    throw refusal('OPENSHELL_TREE_KEY_INVALID', 'Use a lowercase tree key with letters, numbers, underscores or hyphens.');
  const folder = treeFolderOf(config.stateRoot, key);
  const matching = record => {
    if (record && (record.treeKey !== key || record.actor !== actor))
      throw refusal('HUB_IDENTITY_MISMATCH', 'The hub record belongs to a different tree or root actor; it was preserved.');
    return record;
  };
  const running = matching(readHub(folder));
  if (running) return { started: false, hub: running };
  const parent = privateDir(path.dirname(folder));
  const claim = require('./process-claim-lock').acquireLock(path.join(parent, `${key}.hub-start.json`));
  try {
    const again = matching(readHub(folder));
    if (again) return { started: false, hub: again };
    const log = fs.openSync(path.join(parent, `${key}.hub.log`), 'a', 0o600);
    const args = [entry, 'hub', 'run', '--state-root', config.stateRoot, '--actor', actor,
      ...(treeKey ? ['--tree-key', treeKey] : [])];
    const child = require('node:child_process').spawn(process.execPath, args, { detached: true, stdio: ['ignore', 'pipe', log], env });
    fs.closeSync(log);
    child.stdout.setEncoding('utf8');
    return await guardHubStartup(child, async () => {
      let ready;
      try { ready = await new Promise((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => reject(refusal('HUB_START_TIMEOUT', `The hub did not report ready; see ${path.join(parent, `${key}.hub.log`)}.`)), timeoutMs);
        child.stdout.on('data', chunk => {
          buffer += chunk;
          const index = buffer.indexOf('\n');
          if (index >= 0) { clearTimeout(timer); try { resolve(JSON.parse(buffer.slice(0, index))); } catch (error) { reject(error); } }
        });
        child.stdout.once('end', () => { clearTimeout(timer); reject(refusal('HUB_START_FAILED', 'The hub closed its ready stream without confirming startup.')); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(refusal('HUB_START_FAILED', `The hub exited (${code}) before it was ready; see ${path.join(parent, `${key}.hub.log`)}.`)); });
      }); } finally { child.stdout.destroy(); }
      const hub = matching(readHub(folder));
      assertHubReady({ ready, hub, key, actor, pid: child.pid });
      // Verify the retained token/socket actually answers for this same tree.
      const status = await adminRequest(folder, 'status');
      if (status.hub?.pid !== hub.pid || status.hub?.treeKey !== key || status.hub?.actor !== actor)
        throw refusal('HUB_START_NOT_READY', 'The hub status did not confirm the requested tree; startup was not confirmed.');
      return { started: true, hub, ready };
    });
  } finally { claim.release(); }
}

// The ChildProcess handle belongs only to this attempted start. Never kill a
// pid recovered from an unverified hub record after a failed start.
async function guardHubStartup(child, verify) {
  const exited = new Promise(resolve => child.once('exit', resolve));
  try { return await verify(); }
  catch (error) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
    throw error;
  } finally { child.stdout.destroy(); child.unref(); }
}

function defaultName(actor, env = process.env) {
  if (env.FLEET_V2_ORCHESTRATOR_NAME) return env.FLEET_V2_ORCHESTRATOR_NAME;
  return `${actor}-${process.ppid}`;
}

/**
 * `fleetV2 serve --attach | --hub`: this CLI's MCP server becomes a byte proxy
 * to the hub. Closing it closes only this orchestrator's connection.
 */
async function openAttachment({ config, actor, treeKey = null, autoStart = false, entry, name = null, signal, deadlineAt, admin = false }) {
  if (signal?.aborted) throw signal.reason || new Error('Fleet attachment aborted.');
  const key = treeKey || actor;
  const folder = treeFolderOf(config.stateRoot, key);
  let hub = readHub(folder);
  if (!hub) {
    if (!autoStart) throw refusal('HUB_NOT_RUNNING', 'No Fleet hub is running for this tree. Start one with fleetV2 hub start, or serve --hub.');
    hub = (await startHub({ config, actor, treeKey, entry })).hub;
  }
  require('./fleet-runtime-socket').assertPrivateRuntimeSocketPath(hub.socketPath);
  const socket = await connect(hub.socketPath, signal);
  const abort = () => socket.destroy(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  socket.once('close', () => signal?.removeEventListener('abort', abort));
  // Keep errors handled between the handshake and the client's listeners.
  socket.on('error', () => {});
  if (signal?.aborted) { socket.destroy(); throw signal.reason; }
  try {
    const remainingMs = deadlineAt === undefined ? undefined : Math.ceil(deadlineAt - performance.now());
    if (remainingMs !== undefined && remainingMs <= 0) throw new Error('Fleet call deadline exceeded.');
    socket.write(`${JSON.stringify({ fleetHub: HUB_PROTOCOL, op: 'attach', token: hub.token,
      name: name || defaultName(actor), actor, pid: process.pid, ...(admin === true ? { admin: true } : {}) })}\n`);
    const { value, rest } = await firstLine(socket, remainingMs);
    if (!value.ok) throw Object.assign(refusal(value.code || 'HUB_ATTACH_REFUSED', value.message || 'The hub refused this orchestrator.'), { fleetRefusal: true });
    return { socket, value, rest };
  } catch (error) { socket.destroy(); throw error; }
}

async function runAttach(options) {
  const { socket, value, rest } = await openAttachment(options);
  process.stderr.write(`[fleetV2] attached to the fleet hub (pid ${value.hub.pid}, tree ${value.hub.treeKey}) as ${value.orchestrator.name}, ${value.orchestrator.role}.\n`);
  if (rest) process.stdout.write(rest);
  socket.on('data', chunk => process.stdout.write(chunk));
  process.stdin.on('data', chunk => socket.write(chunk));
  process.stdin.once('end', () => socket.end());
  return new Promise(resolve => socket.once('close', () => { process.stdin.pause(); resolve(); process.exit(0); }));
}

module.exports = Object.freeze({
  HUB_PROTOCOL, JOURNAL_KEEP, LATE_ATTACH_BACKLOG, HUB_ACTIONS,
  readHub, treeFolderOf, assertHubReady, createJournal, createRegistry, wrapTreeHost, isAncestor, orchestratorLead, admitLevel,
  guardHubStartup, workerProcesses, buildHandoffNote, createHubTransport, runHub, startHub, openAttachment, runAttach, adminRequest, waitUntilStopped,
});
