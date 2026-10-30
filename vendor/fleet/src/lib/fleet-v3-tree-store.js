'use strict';

// V3 trees retain the existing in-memory document contract. SQLite stores
// independent records transactionally, so task progress does not rewrite all
// task bodies, job items, history and usage. This module owns persistence only;
// it neither schedules nor resumes agents.
const fs = require('node:fs');
const path = require('node:path');
const { isImmutable, orderedKeys, changedKeys } = require('./fleet-state-draft');
const APPLICATION_ID = 0x46563354;
const VERSION = 2;
const retention = require('./fleet-history-retention');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const set = (parent, key, value) => Object.defineProperty(parent, key, { value, enumerable: true, configurable: true, writable: true });

function privatePath(file, create) {
  const folder = path.dirname(file);
  if (!path.isAbsolute(file) || path.resolve(file) !== file || fs.realpathSync(folder) !== folder)
    fail('FLEET_TREE_PATH_INVALID', 'Tree storage needs a physical absolute path.');
  if (process.platform === 'win32') require('./windows-state-security').assertEntry(folder, true);
  else {
    const stat = fs.lstatSync(folder);
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) fail('FLEET_TREE_PATH_INVALID', 'Tree storage needs an owned private folder.');
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const candidate = file + suffix;
    let stat;
    try { stat = fs.lstatSync(candidate); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))
      fail('FLEET_TREE_PATH_INVALID', 'Tree database and sidecars must be private direct files.');
    if (process.platform === 'win32') require('./windows-state-security').assertEntry(candidate, false);
  }
  if (create && !fs.existsSync(file)) fs.closeSync(fs.openSync(file, 'wx', 0o600));
}

function records(document, emit) {
  const value = (at, item) => emit(at, 'value', item, item);
  function list(at, items) {
    if (!Array.isArray(items)) fail('FLEET_TREE_RECORD_INVALID', `${at.join('.')} must be an array.`);
    const selected = emit(at, 'array', items.length, items, items);
    if (selected === false) return;
    if (selected instanceof Set) { for (const n of selected) value([...at, n], items[n]); return; }
    for (let n = 0; n < items.length; n++) value([...at, n], items[n]);
  }
  function map(at, items, child = value) {
    if (!items || typeof items !== 'object' || Array.isArray(items)) fail('FLEET_TREE_RECORD_INVALID', `${at.join('.')} must be a map.`);
    const keys = orderedKeys(items);
    if (emit(at, 'map', keys, keys, items) === false) return;
    for (const [key, item] of Object.entries(items)) child([...at, key], item);
  }
  function object(at, item, parts) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('FLEET_TREE_RECORD_INVALID', 'Tree objects must be JSON records.');
    const rest = {};
    for (const [key, entry] of Object.entries(item)) if (!Object.hasOwn(parts, key)) set(rest, key, entry);
    if (emit(at, 'object', rest, null, item) === false) return;
    for (const [key, write] of Object.entries(parts)) if (Object.hasOwn(item, key)) write([...at, key], item[key]);
  }
  object([], document, { nodes: list, inbox: list, workerReports: list,
    fleetControl: (at, control) => object(at, control, { tasks: map, rules: map, asks: map,
      taskHistory: list, ruleHistory: list, writeRevisions: (at, revisions) => object(at, revisions, { nodes: map, jobs: map }),
      lanes: (at, lanes) => map(at, lanes, (at, lane) => object(at, lane, { items: list, rules: map, ruleHistory: list })) }),
    fleetMetrics: (at, metrics) => object(at, metrics, { entries: list }) });
}

function cacheTree(rows) {
  const entries = rows.map(row => ({ row, at: JSON.parse(row.key), children: new Map(), count: 1, identity: null }));
  entries.sort((a, b) => a.at.length - b.at.length);
  const byPath = new Map(entries.map(entry => [entry.row.key, entry]));
  for (const entry of entries) if (entry.at.length) byPath.get(JSON.stringify(entry.at.slice(0, -1))).children.set(entry.at.at(-1), entry);
  for (const entry of entries.slice().reverse()) if (entry.at.length) byPath.get(JSON.stringify(entry.at.slice(0, -1))).count += entry.count;
  return byPath.get('[]') || null;
}

function decode(rows) {
  if (!rows.length) return null;
  const entries = rows.map(row => {
    let at, value;
    try { at = JSON.parse(row.key); value = JSON.parse(row.json); } catch { fail('FLEET_TREE_RECORD_INVALID', 'Tree storage contains unreadable JSON; it was preserved.'); }
    if (!Array.isArray(at) || JSON.stringify(at) !== row.key || at.some(key => typeof key !== 'string' && (!Number.isSafeInteger(key) || key < 0)))
      fail('FLEET_TREE_RECORD_INVALID', 'Tree storage contains an invalid record path.');
    return { ...row, at, value };
  }).sort((a, b) => a.at.length - b.at.length);
  const byPath = new Map(entries.map(entry => [entry.key, entry]));
  if (!byPath.has('[]')) fail('FLEET_TREE_RECORD_INVALID', 'The tree root is missing; no empty replacement was created.');
  let document;
  for (const entry of entries) {
    const { at, value, kind } = entry;
    let restored;
    if (kind === 'value') restored = value;
    else if (kind === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('FLEET_TREE_RECORD_INVALID', 'Invalid tree object.');
      restored = value;
    } else if (kind === 'map') {
      if (!Array.isArray(value) || value.some(key => typeof key !== 'string') || new Set(value).size !== value.length)
        fail('FLEET_TREE_RECORD_INVALID', 'Invalid tree map.');
      restored = {};
      entry.members = new Set(value);
      for (const key of value) {
        if (!byPath.has(JSON.stringify([...at, key]))) fail('FLEET_TREE_RECORD_INVALID', 'A retained map record is missing.');
        set(restored, key, undefined);
      }
    } else if (kind === 'array') {
      if (!Number.isSafeInteger(value) || value < 0 || value > rows.length) fail('FLEET_TREE_RECORD_INVALID', 'Invalid tree list length.');
      restored = [];
      for (let n = 0; n < value; n++) if (!byPath.has(JSON.stringify([...at, n]))) fail('FLEET_TREE_RECORD_INVALID', 'A retained list record is missing.');
    } else fail('FLEET_TREE_RECORD_INVALID', 'Unknown tree record kind.');
    if (!at.length) {
      if (kind !== 'object') fail('FLEET_TREE_RECORD_INVALID', 'The tree root must be an object.');
      document = restored; continue;
    }
    const parentEntry = byPath.get(JSON.stringify(at.slice(0, -1)));
    if (!parentEntry || parentEntry.kind === 'value') fail('FLEET_TREE_RECORD_INVALID', 'A tree record has no structural parent.');
    const key = at.at(-1);
    if (parentEntry.kind === 'array' && (!Number.isSafeInteger(key) || key >= parentEntry.value) || parentEntry.kind === 'map' && !parentEntry.members.has(key) || parentEntry.kind === 'object' && typeof key !== 'string')
      fail('FLEET_TREE_RECORD_INVALID', 'A tree record does not belong to its parent.');
    let parent = document;
    for (const part of at.slice(0, -1)) parent = parent[part];
    if (parentEntry.kind === 'object' && Object.hasOwn(parent, key)) fail('FLEET_TREE_RECORD_INVALID', 'A tree record overlaps another record.');
    set(parent, key, restored);
  }
  return document;
}

class TreeStore {
  constructor(file, { readOnly = false, beforeCommit = null } = {}) {
    privatePath(file, !readOnly);
    this.file = file; this.readOnly = readOnly; this.beforeCommit = beforeCommit;
    this.structure = null; this.encoded = new WeakMap(); this.revision = 0; this.closed = false;
    const { DatabaseSync } = require('node:sqlite');
    this.db = new DatabaseSync(file, { readOnly, allowExtension: false });
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      const app = this.db.prepare('PRAGMA application_id').get().application_id;
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (!readOnly && app === 0 && version === 0) {
        if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length) fail('FLEET_TREE_DATABASE_INVALID', 'This database belongs to another application.');
        this.db.exec(`BEGIN IMMEDIATE; CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL) WITHOUT ROWID;
          INSERT INTO meta VALUES ('revision',0);
          CREATE TABLE records (key TEXT PRIMARY KEY, kind TEXT NOT NULL, json TEXT NOT NULL) WITHOUT ROWID;
          PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${VERSION}; COMMIT;`);
      } else if (app !== APPLICATION_ID || ![1, VERSION].includes(version)) fail('FLEET_TREE_DATABASE_INVALID', 'Unknown tree database identity or version; it was preserved.');
      if (!readOnly) {
        this.db.exec(`BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS history (
          kind TEXT NOT NULL, scope TEXT NOT NULL, seq INTEGER NOT NULL,
          nodeId TEXT, taskRevision INTEGER, itemN INTEGER, reportId TEXT, json TEXT NOT NULL,
          PRIMARY KEY(kind,scope,seq)) WITHOUT ROWID;
          CREATE INDEX IF NOT EXISTS history_task ON history(kind,nodeId,taskRevision);
          CREATE INDEX IF NOT EXISTS history_item ON history(kind,scope,itemN);
          CREATE INDEX IF NOT EXISTS history_report ON history(reportId);
          CREATE TABLE IF NOT EXISTS history_counts (kind TEXT NOT NULL,scope TEXT NOT NULL,total INTEGER NOT NULL,
            PRIMARY KEY(kind,scope)) WITHOUT ROWID;
          PRAGMA user_version=${VERSION}; COMMIT;`);
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      }
      // Cold evidence is checked when read, not rescanned on every restart.
      // A full offline PRAGMA quick_check still covers every archive page.
      const integrity = this.db.prepare('PRAGMA quick_check(records)').get().quick_check;
      if (integrity !== 'ok') fail('FLEET_TREE_DATABASE_INVALID', 'Tree database integrity failed; it was preserved.');
      this.load();
    } catch (error) { this.db.close(); throw error; }
  }
  load() {
    this.db.exec('BEGIN');
    let rows, revision;
    try {
      revision = this.db.prepare("SELECT value FROM meta WHERE key='revision'").get()?.value;
      if (!Number.isSafeInteger(revision) || revision < 0) fail('FLEET_TREE_DATABASE_INVALID', 'The tree database revision is invalid.');
      rows = this.db.prepare('SELECT key,kind,json FROM records').all();
      const value = decode(rows);
      if (revision > 0 && !value) fail('FLEET_TREE_RECORD_INVALID', 'A previously saved tree has no records; it was preserved.');
      this.db.exec('COMMIT');
      this.structure = cacheTree(rows); this.revision = revision;
      return value;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  save(document, { historyUpdates = [], compactHistory = true } = {}) {
    if (this.readOnly || this.closed) fail('FLEET_TREE_WRITE_REFUSED', 'This tree store is not open for writing.');
    privatePath(this.file, false);
    // Offline import preserves the exact live/archive boundary. Ordinary saves
    // retain the normal bounded-history policy.
    const input = document, planned = compactHistory ? retention.plan(document) : { document, moves: [] };
    document = planned.document;
    const updates = [], removed = [], visited = new Map();
    const attach = (parent, key, entry) => (parent.delta ? parent.replacements : parent.next.children).set(key, entry);
    let next, serializedBytes = 0, storedBytes = 0, visitedRecords = 0, reusedRecords = 0;
    records(document, (at, kind, value, source, identity = source) => {
      visitedRecords++;
      const key = JSON.stringify(at);
      const parent = at.length ? visited.get(JSON.stringify(at.slice(0, -1))) : null;
      const old = parent ? parent.old?.children.get(at.at(-1)) : this.structure;
      if (old?.row.kind === kind && isImmutable(identity) && old.identity === identity) {
        if (parent) attach(parent, at.at(-1), old); else next = old;
        reusedRecords += old.count;
        return false;
      }
      const frozen = isImmutable(source);
      let cached = frozen && this.encoded.get(source)?.get(kind);
      if (cached === undefined || cached === false) {
        cached = JSON.stringify(value);
        if (cached === undefined) fail('FLEET_TREE_RECORD_INVALID', 'Tree storage requires JSON values.');
        serializedBytes += Buffer.byteLength(cached);
        if (frozen) { if (!this.encoded.has(source)) this.encoded.set(source, new Map()); this.encoded.get(source).set(kind, cached); }
      }
      const row = { key, kind, json: cached }, entry = { row, identity: isImmutable(identity) ? identity : null, children: new Map(), count: 1 };
      const context = { old, next: entry };
      let selected;
      if (kind === 'array' && old?.row.kind === kind) {
        const touched = changedKeys(identity, old.identity);
        if (touched) {
          const previousLength = JSON.parse(old.row.json);
          selected = new Set();
          for (const key of touched) if (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)) {
            const n = Number(key); if (Number.isSafeInteger(n) && n < value) selected.add(n);
          }
          // Extended holes must still fail; truncation deletes every removed
          // record even when the draft only assigned the length property.
          for (let n = previousLength; n < value; n++) selected.add(n);
          context.deleted = new Set();
          for (let n = value; n < previousLength; n++) context.deleted.add(n);
          context.delta = true; context.replacements = new Map();
          entry.children = old.children;
          entry.count = old.count;
          reusedRecords += old.count - 1 - context.deleted.size - [...selected].filter(n => n < previousLength).length;
        }
      }
      visited.set(key, context);
      if (parent) attach(parent, at.at(-1), entry); else next = entry;
      if (!old || old.row.kind !== kind || old.row.json !== cached) { updates.push(row); storedBytes += Buffer.byteLength(cached); }
      return selected;
    });
    const remove = entry => { removed.push(entry.row.key); for (const child of entry.children.values()) remove(child); };
    for (const { old, next: entry, delta, replacements, deleted } of [...visited.values()].reverse()) {
      if (delta) {
        for (const key of deleted) { const child = old.children.get(key); if (child) { remove(child); entry.count -= child.count; } }
        for (const [key, child] of replacements) entry.count += child.count - (old.children.get(key)?.count || 0);
        continue;
      }
      for (const [key, child] of old?.children || []) if (!entry.children.has(key)) remove(child);
      for (const child of entry.children.values()) entry.count += child.count;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const revision = this.db.prepare("SELECT value FROM meta WHERE key='revision'").get().value;
      if (revision !== this.revision) fail('FLEET_TREE_STALE', 'Another writer changed this tree; reload before saving.');
      for (const move of planned.moves) {
        let sequence = this.historyCount(move.kind, move.scope);
        const insert = this.db.prepare('INSERT INTO history VALUES (?,?,?,?,?,?,?,?)');
        for (const row of move.entries) insert.run(move.kind, move.scope, ++sequence, row.nodeId || null,
          (move.kind === 'tasks' ? row.taskRevision || 1 : row.taskRevision || null), row.n || null, row.reportId || null, JSON.stringify(row));
        this.db.prepare('INSERT INTO history_counts VALUES (?,?,?) ON CONFLICT(kind,scope) DO UPDATE SET total=excluded.total').run(move.kind, move.scope, sequence);
      }
      for (const update of historyUpdates) {
        const result = this.db.prepare('UPDATE history SET json=? WHERE kind=? AND scope=? AND seq=? AND json=?')
          .run(JSON.stringify(update.row), update.kind, update.scope, update.seq, update.before);
        if (result.changes !== 1) fail('FLEET_TREE_STALE', 'The archived result changed; read it again.');
      }
      const put = this.db.prepare('INSERT INTO records(key,kind,json) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET kind=excluded.kind,json=excluded.json');
      for (const row of updates) put.run(row.key, row.kind, row.json);
      const drop = this.db.prepare('DELETE FROM records WHERE key=?');
      for (const key of removed) drop.run(key);
      this.db.prepare("UPDATE meta SET value=? WHERE key='revision'").run(revision + 1);
      this.beforeCommit?.({ updates: updates.length, removed: removed.length });
      this.db.exec('COMMIT');
      // The shared child maps remain untouched until the database commits.
      // Failed writes keep the complete previous traversal cache for retry.
      for (const context of visited.values()) if (context.delta) {
        for (const key of context.deleted) context.next.children.delete(key);
        for (const [key, child] of context.replacements) context.next.children.set(key, child);
      }
      this.revision = revision + 1; this.structure = next;
      for (const key of ['fleetControl', 'fleetMetrics', 'workerReports', 'inbox']) if (document[key] !== input[key]) input[key] = document[key];
      return { revision: this.revision, records: next.count, updatedRecords: updates.length, deletedRecords: removed.length, serializedBytes, storedBytes, visitedRecords, reusedRecords };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  historyCount(kind, scope = '') {
    return this.db.prepare('SELECT total FROM history_counts WHERE kind=? AND scope=?').get(kind, scope)?.total || 0;
  }
  historyPage(document, { kind, id = '', offset = 0, limit = 100, expectedHistoryRevision } = {}) {
    if (!Object.hasOwn(retention.LIMITS, kind) || typeof id !== 'string' || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      fail('FLEET_HISTORY_PAGE_INVALID', 'Choose a history kind, nonnegative offset and limit from 1 through 1000.');
    if (expectedHistoryRevision !== undefined && expectedHistoryRevision !== this.revision)
      fail('FLEET_HISTORY_STALE_REVISION', 'History changed; restart the page on its current revision.');
    const archived = this.historyCount(kind, id);
    const live = retention.streams(document).find(stream => stream.kind === kind && stream.scope === id)?.entries || [];
    const entries = offset < archived ? this.db.prepare('SELECT json FROM history WHERE kind=? AND scope=? AND seq>? ORDER BY seq LIMIT ?')
      .all(kind, id, offset, Math.min(limit, archived - offset)).map(row => JSON.parse(row.json)) : [];
    if (entries.length < limit) entries.push(...live.slice(Math.max(0, offset - archived), Math.max(0, offset - archived) + limit - entries.length));
    const total = archived + live.length;
    return { revision: document.fleetControl?.revision || 0, historyRevision: this.revision, kind, id, archived,
      entries, page: { offset, total, returned: entries.length, nextOffset: offset + entries.length < total ? offset + entries.length : null } };
  }
  archivedReport(reportId) {
    const row = this.db.prepare("SELECT json FROM history WHERE kind='reports' AND reportId=?").get(reportId);
    return row ? JSON.parse(row.json) : null;
  }
  archivedTask(nodeId, taskRevision) {
    const row = this.db.prepare("SELECT scope,seq,json FROM history WHERE kind='tasks' AND nodeId=? AND taskRevision=? AND (json_extract(json,'$.submission') IS NOT NULL OR json_extract(json,'$.status') IN ('completed','held')) ORDER BY seq DESC LIMIT 1").get(nodeId, taskRevision);
    return row ? { kind: 'tasks', scope: row.scope, seq: row.seq, before: row.json, row: JSON.parse(row.json) } : null;
  }
  archivedItem(id, n) {
    const row = this.db.prepare("SELECT seq,json FROM history WHERE kind='items' AND scope=? AND itemN=?").get(id, n);
    return row ? { kind: 'items', scope: id, seq: row.seq, before: row.json, row: JSON.parse(row.json) } : null;
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}

function read(file) { const store = new TreeStore(file, { readOnly: true }); try { return store.load(); } finally { store.close(); } }
module.exports = { TreeStore, read, records, decode, VERSION, APPLICATION_ID };
