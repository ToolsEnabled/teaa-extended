'use strict';

// Offline, separate-root import. The source remains the rollback copy. No
// source lock can exclude every older Fleet writer, so the operator must close
// its clients; process checks and two exact censuses detect overlapping work.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const setup = require('./fleet-v2-setup');
const KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const refuse = (code, message) => { throw Object.assign(new Error(message), { code: `FLEET_IMPORT_${code}` }); };
// Diagnostic context contains paths and record kinds, never record values or
// parser messages (which may include private fragments of the source body).
const invalid = (file, kind) => refuse('INVALID', `Cannot read ${kind} in ${JSON.stringify(file)}; source state was preserved.`);
const sourceRead = (file, kind, read) => {
  try { return read(); } catch { invalid(file, kind); }
};
const json = (file, relative, kind) => sourceRead(relative, kind, () => JSON.parse(fs.readFileSync(file, 'utf8')));
// The audit keystore uses an empty, persistent flock inode, not a PID record.
// Keep it byte-for-byte; only process-ownership records are detached.
const archivedImportRecord = relative => /^v[2-4]-import-originals(?:\/|$)/.test(relative);
const auditLock = relative => relative === 'capability/audit-keys/store.lock';
const ownershipRecord = relative => !archivedImportRecord(relative) && !auditLock(relative) && /(?:^|\/)(?:owner\.json|hub\.json|ownership-claim\.json|[^/]+\.lock)$/.test(relative);
function stamp(stat) { return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':'); }
function digest(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    for (let size; (size = fs.readSync(fd, buffer, 0, buffer.length, null));) hash.update(buffer.subarray(0, size));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}
function census(root) {
  const entries = [];
  function visit(relative) {
    const file = path.join(root, relative), stat = fs.lstatSync(file, { bigint: true });
    if (stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o077n) || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n)))
      refuse('PATH', 'Import requires private owned directories and direct regular files. Close Fleet and remove its inactive sockets through its normal shutdown before importing.');
    const entry = { relative, kind: stat.isDirectory() ? 'directory' : 'file', stamp: stamp(stat) };
    if (stat.isFile()) entry.sha256 = digest(file);
    if (stamp(fs.lstatSync(file, { bigint: true })) !== entry.stamp) refuse('CHANGED', 'Source state changed during import; close all source clients and try a new destination.');
    entries.push(entry);
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
  }
  visit(''); return entries;
}
function inactive(record, relative, kind = 'ownership record') {
  if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 0) invalid(relative, kind);
  // Conservatively refuse any surviving PID, including one whose recorded
  // identity cannot be checked. Import never signals a source process.
  if (require('./process-claim-lock').pidAlive(record.pid)) refuse('LIVE', 'A source server, worker or state writer may still be running. Close the source clients and hub using Fleet controls before importing.');
}
// Even SQLite read-only WAL connections can update shared-memory files.
// Inspect a disposable database copy so the rollback source stays byte-exact.
function readDatabaseCopy(file, read) {
  const folder = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'fleet-import-inspect-'));
  try {
    const copied = path.join(folder, path.basename(file));
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(file + suffix)) {
      fs.copyFileSync(file + suffix, copied + suffix, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(copied + suffix, 0o600);
    }
    return read(copied);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
}
function inspect(root, entries, sourceGeneration) {
  const trees = [];
  const files = new Set(entries.filter(entry => entry.kind === 'file').map(entry => entry.relative.split(path.sep).join('/')));
  for (const entry of entries) {
    const relative = entry.relative.split(path.sep).join('/');
    if (entry.kind === 'directory' && /^workers\/openshell-tree\/[^/]+$/.test(relative)
        && (!KEY.test(relative.split('/')[2]) || !files.has(`${relative}/${sourceGeneration >= 3 ? 'tree.sqlite3' : 'tree.json'}`)))
      invalid(relative, 'tree directory');
  }
  for (const entry of entries) {
    if (entry.kind !== 'file') continue;
    const relative = entry.relative.split(path.sep).join('/'), file = path.join(root, entry.relative);
    if (archivedImportRecord(relative)) continue; // Earlier rollback evidence is opaque, never live ownership.
    // Unresolved publications retain uncertainty. Do not move their staging
    // paths or attempt recovery as a side effect of state migration.
    if (relative.endsWith('/byte-coordination-host/data.sqlite')) readDatabaseCopy(file, copied => {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(copied, { readOnly: true });
      try {
        if (db.prepare("SELECT 1 FROM operations WHERE status IN ('PREPARED','UNKNOWN') LIMIT 1").get())
          refuse('UNRESOLVED', 'Resolve or account for pending host publications through their owning Fleet session before import. No publication was retried.');
      } finally { db.close(); }
    });
    if (auditLock(relative) && fs.statSync(file).size !== 0) invalid(relative, 'audit keystore flock sentinel');
    if (ownershipRecord(relative)) inactive(json(file, relative, 'ownership record'), relative);
    if (/\.claims\//.test(relative)) refuse('LIVE', 'Source state retains a process claim. Finish its Fleet lifecycle before importing.');
    if (sourceGeneration === 2 && /^workers\/openshell-tree\/[^/]+\/tree\.sqlite3(?:-|$)/.test(relative)
        || sourceGeneration >= 3 && /^workers\/openshell-tree\/[^/]+\/tree\.json$/.test(relative))
      refuse('GENERATION', 'Mixed tree storage generations are not imported.');
    const treePattern = sourceGeneration >= 3 ? /^workers\/openshell-tree\/[^/]+\/tree\.sqlite3$/ : /^workers\/openshell-tree\/[^/]+\/tree\.json$/;
    if (!treePattern.test(relative)) continue;
    const key = relative.split('/')[2], document = sourceGeneration >= 3
      ? sourceRead(relative, 'SQLite tree record', () => readDatabaseCopy(file, require('./fleet-v3-tree-store').read)) : json(file, relative, 'JSON tree record');
    if (!KEY.test(key) || document?.v !== 1 || document.treeKey !== key || !document.root || typeof document.root.actor !== 'string'
        || !Array.isArray(document.nodes) || !document.nodes.every(node => node && typeof node === 'object' && !Array.isArray(node) && typeof node.nodeId === 'string' && KEY.test(node.nodeId))
        || new Set(document.nodes.map(node => node.nodeId)).size !== document.nodes.length
        || document.inbox !== undefined && !Array.isArray(document.inbox)) invalid(relative, 'tree identity');
    for (const node of document.nodes) if (node.process) inactive(node.process, relative, 'node process ownership record');
    if (Object.hasOwn(document, 'fleetControl') && (!document.fleetControl || typeof document.fleetControl !== 'object' || Array.isArray(document.fleetControl)))
      invalid(relative, 'fleetControl record');
    // Run the runtime's control preflight on a disposable copy. Do not repair,
    // normalize or fabricate reports in the imported document itself.
    sourceRead(relative, 'fleetControl record', () => require('./fleet-v2-control').createFleetControl({ document: structuredClone(document), rootSessionId: 'import-validation', scopedRevisions: true }));
    trees.push({ relative: entry.relative, document });
  }
  return trees;
}
function write(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function syncDirectory(folder) {
  const fd = fs.openSync(folder, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function importState({ sourceStateRoot, stateRoot } = {}, { runtime = require('./host-runtime'), beforeVerify = () => {} } = {}, sourceGeneration = 2) {
  const generation = sourceGeneration + 1;
  const backupName = `v${sourceGeneration}-import-originals`;
  process.umask(0o077);
  if (process.platform !== 'linux') refuse('PLATFORM', 'This development importer is qualified on Linux only.');
  setup.physicalDirectory(sourceStateRoot, 'Source state');
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot) || path.resolve(stateRoot) !== stateRoot || stateRoot.includes('\0'))
    refuse('PATH', 'Choose an absolute normalized new destination directory.');
  setup.physicalDirectory(path.dirname(stateRoot), 'Destination parent');
  if ([sourceStateRoot, runtime.INSTALL_ROOT].some(root => setup.isWithin(root, stateRoot) || setup.isWithin(stateRoot, root)))
    refuse('OVERLAP', 'Source, destination and runtime directories must be separate.');
  if (fs.existsSync(stateRoot)) refuse('EXISTS', 'The destination already exists; choose a new directory.');
  const original = census(sourceStateRoot);
  const previous = sourceRead('host-mode.json', 'host configuration', () => runtime.readHostConfig(sourceStateRoot, { allowStandaloneRebind: true }));
  if (previous.profile !== 'fleetV2' || previous.setupKind || (previous.generation || 2) !== sourceGeneration
      || (sourceGeneration === 2 ? Boolean(previous.treeStorage) : previous.treeStorage !== 'sqlite-v1'))
    refuse('GENERATION', `Import requires standalone V${sourceGeneration} state.`);
  const machine = require('./setup/machine-record'), servicesRoot = path.join(sourceStateRoot, 'services');
  const record = sourceRead('services/machine.json', 'sealed machine record', () => machine.readMachineRecord({ servicesRoot, adopt: false }));
  if (!record || machine.verifyMachineRecordIntegrity(record, { servicesRoot }).state !== 'sealed'
      || record.installRoot !== previous.installRoot || record.servicesRoot !== servicesRoot
      || record.workspaceRoots.length !== 1 || record.workspaceRoots[0] !== previous.workspace)
    invalid('services/machine.json', 'sealed machine record matching host-mode.json');
  const trees = inspect(sourceStateRoot, original, sourceGeneration);
  if (original.some(entry => entry.relative === backupName)) refuse('EXISTS', 'Source already contains this import backup.');
  // Reserve exactly this new directory. host-mode.json is the last commit
  // marker: a failed or interrupted import cannot be served as valid state.
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  const backup = path.join(stateRoot, backupName);
  fs.mkdirSync(backup, { mode: 0o700 });
  let copiedFiles = 0;
  for (const entry of original) {
    if (!entry.relative) continue;
    const target = entry.relative === 'host-mode.json' ? path.join(backup, 'host-mode.json') : path.join(stateRoot, entry.relative);
    if (entry.kind === 'directory') { fs.mkdirSync(target, { mode: 0o700 }); continue; }
    fs.copyFileSync(path.join(sourceStateRoot, entry.relative), target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o600);
    if (digest(target) !== entry.sha256) refuse('CHANGED', 'A copied file differs from its source snapshot; destination was not activated.');
    copiedFiles++;
  }
  const changes = [];
  function retainOriginal(relative) {
    const file = path.join(stateRoot, relative), saved = path.join(backup, relative);
    fs.mkdirSync(path.dirname(saved), { recursive: true, mode: 0o700 });
    fs.renameSync(file, saved); changes.push(relative);
  }
  for (const entry of original) if (entry.kind === 'file' && ownershipRecord(entry.relative.split(path.sep).join('/'))) retainOriginal(entry.relative);
  for (const tree of trees) {
    const document = structuredClone(tree.document);
    for (const node of document.nodes) {
      node.process = null; node.sessionId = null; node.turn = 'none';
      if (['running', 'starting'].includes(node.state)) { node.state = 'stopped'; node.stoppedReason = `v${sourceGeneration}-import`; }
    }
    retainOriginal(tree.relative);
    // Keep any checkpoint/WAL companions with the exact original database.
    // Reopen this detached copy transactionally, retaining its archive tables.
    if (sourceGeneration >= 3) for (const suffix of ['-wal', '-shm']) {
      const companion = tree.relative + suffix;
      if (fs.existsSync(path.join(stateRoot, companion))) retainOriginal(companion);
    }
    // Reopen the detached V3 database rather than rebuilding only its hot
    // document: cold history tables and their indexes must survive too.
    if (sourceGeneration >= 3) for (const suffix of ['', '-wal', '-shm']) {
      const relative = tree.relative + suffix, saved = path.join(backup, relative);
      if (fs.existsSync(saved)) fs.copyFileSync(saved, path.join(stateRoot, relative), fs.constants.COPYFILE_EXCL);
    }
    const { TreeStore, read } = require('./fleet-v3-tree-store');
    const file = path.join(stateRoot, path.dirname(tree.relative), 'tree.sqlite3'), store = new TreeStore(file);
    try { store.save(document, { compactHistory: false }); } finally { store.close(); }
    if (!isDeepStrictEqual(read(file), document)) refuse('VERIFY', 'Converted tree did not round-trip exactly; destination was not activated.');
  }
  const config = { ...previous, generation, treeStorage: 'sqlite-v1', stateRoot, installRoot: runtime.INSTALL_ROOT, nodePath: process.execPath };
  // Preserve the sealed source record as evidence, and let the normal setup
  // implementation regenerate runtime-dependent records using the copied key.
  const machineRelative = path.relative(stateRoot, machine.machineRecordPath(path.join(stateRoot, 'services')));
  fs.mkdirSync(path.dirname(path.join(backup, machineRelative)), { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(stateRoot, machineRelative), path.join(backup, machineRelative), fs.constants.COPYFILE_EXCL);
  runtime.setupHost(config, { pluginRebindFrom: previous.installRoot });
  // buildMachineRecord accepts machineId/Label inputs, whereas saved records
  // use machine.id/label. Preserve that identity explicitly across the move.
  const rebound = machine.readMachineRecord({ servicesRoot: path.join(stateRoot, 'services'), adopt: false });
  machine.writeMachineRecord({ ...rebound, machine: record.machine }, { servicesRoot: path.join(stateRoot, 'services') });
  runtime.checkPrivateTree(stateRoot);
  runtime.validateHostConfig(config, stateRoot);
  if (Buffer.byteLength(JSON.stringify(config) + '\n') > 16384) invalid('host-mode.json', 'destination host configuration (size limit)');
  const server = setup.leadServer(config, config.leadActor);
  beforeVerify();
  const final = census(sourceStateRoot); inspect(sourceStateRoot, final, sourceGeneration);
  if (JSON.stringify(original) !== JSON.stringify(final)) refuse('CHANGED', 'Source state changed during import; destination was not activated. Close source clients and try a new destination.');
  const receipt = { v: 1, sourceGeneration, generation, sourceStateRoot, stateRoot, importedAt: new Date().toISOString(), copiedFiles, trees: trees.length,
    originalRecords: ['host-mode.json', machineRelative, ...changes], workersStarted: 0, sourcePreserved: true };
  write(path.join(backup, 'receipt.json'), receipt);
  // Flush both copied and regenerated bytes, then their directory entries,
  // before publishing the configuration commit marker.
  function syncTree(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) syncTree(file);
      else { const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
    }
    syncDirectory(folder);
  }
  syncTree(stateRoot);
  syncDirectory(path.dirname(stateRoot));
  setup.writeHostMode(stateRoot, config);
  return { name: `fleetV${generation}`, imported: true, sourceStateRoot, stateRoot, trees: trees.length, copiedFiles,
    workersStarted: 0, server,
    note: `V${sourceGeneration} state remains intact. Keep its clients closed while using V${generation}. Inspect retained work and explicitly resume workers through Fleet. Rollback returns to the frozen source snapshot; it does not merge later destination work.` };
}
const importV2 = (options, dependencies) => importState(options, dependencies, 2);
const importV3 = (options, dependencies) => importState(options, dependencies, 3);
const importV4 = (options, dependencies) => importState(options, dependencies, 4);
module.exports = { importV2, importV3, importV4 };
