'use strict';

// The dispatch binds this scope from its transport's effective session, never
// from tool arguments. Each async file operation keeps its own ceiling.
const { AsyncLocalStorage } = require('node:async_hooks');
const scope = new AsyncLocalStorage();
const fileScope = new AsyncLocalStorage();
const authorizations = new WeakMap();

function create({ fileToolContext, permissionSession, observation, env = process.env } = {}) {
  const session = require('./permission-tier-policy').session(permissionSession);
  if (env.TOOLSENABLED_RUNTIME_MODE !== 'host' || env.TOOLSENABLED_HOST_SETUP_KIND === 'plugin'
      || session.origin !== 'local' || session.tier !== 'full'
      || observation?.source !== 'administrator-settings'
      || observation?.level !== 4) return undefined;
  require('./file-tool-context').requireFileToolContext(fileToolContext);
  const authorization = Object.freeze({});
  authorizations.set(authorization, { fileToolContext });
  return authorization;
}

function createInherited({ fileToolContext, resolve, env = process.env } = {}) {
  if (env.TOOLSENABLED_RUNTIME_MODE !== 'host' || env.TOOLSENABLED_HOST_SETUP_KIND === 'plugin'
      || typeof resolve !== 'function') return undefined;
  require('./file-tool-context').requireFileToolContext(fileToolContext);
  const authorization = Object.freeze({});
  authorizations.set(authorization, { fileToolContext, resolve, admitted: false });
  return authorization;
}

// Only the transport composition root supplies this resolver. It reads the
// operator policy or the authenticated parent link, never request arguments.
function createScoped({ fileToolContext, resolveFolderScope, env = process.env } = {}) {
  if (env.TOOLSENABLED_RUNTIME_MODE !== 'host' || env.TOOLSENABLED_HOST_SETUP_KIND === 'plugin'
      || env.TOOLSENABLED_FLEET_PROFILE !== 'fleetV2' || typeof resolveFolderScope !== 'function') return undefined;
  require('./file-tool-context').requireFileToolContext(fileToolContext);
  const authorization = Object.freeze({});
  authorizations.set(authorization, { fileToolContext, resolveFolderScope });
  return authorization;
}

function createAmbient({ fileToolContext, resolveAmbientAccess, cwd, env = process.env } = {}) {
  if (env.TOOLSENABLED_RUNTIME_MODE !== 'host' || env.TOOLSENABLED_HOST_SETUP_KIND === 'plugin'
      || env.TOOLSENABLED_FLEET_PROFILE !== 'fleetV2' || typeof resolveAmbientAccess !== 'function') return undefined;
  require('./file-tool-context').requireFileToolContext(fileToolContext);
  const authorization = Object.freeze({});
  authorizations.set(authorization, { fileToolContext, resolveAmbientAccess, cwd: require('node:fs').realpathSync(cwd), admitted: false });
  return authorization;
}

function scopeKey(value) {
  return JSON.stringify([value.revision, value.source, value.readAll === true, value.readRoots, value.writeRoots]);
}

function bound(context) {
  const authorization = authorizations.get(context?.hostFileAuthorization);
  return authorization?.fileToolContext === context?.fileToolContext ? authorization : null;
}

async function prepare(context) {
  const authorization = bound(context);
  if (authorization?.resolveAmbientAccess && context?.setupKind !== 'plugin' && !context?.researchAccess) {
    authorization.admitted = await authorization.resolveAmbientAccess() === true;
    if (!authorization.admitted) throw Object.assign(new Error('The ambient standalone session is no longer available.'), { code: 'FLEET_AMBIENT_ACCESS_REVOKED' });
    const records = require('./setup/machine-record');
    const record = records.readMachineRecord({ servicesRoot: records.resolveServicesRoot({}), adopt: false });
    return { ...context, permissionSession: require('./permission-tier-policy').effectiveSessionFromRecord(4, record) };
  }
  if (authorization?.resolveFolderScope && context?.setupKind !== 'plugin' && !context?.researchAccess) {
    const folderScope = require('./fleet-folder-scope').normalize(await authorization.resolveFolderScope());
    const records = require('./setup/machine-record');
    const record = records.readMachineRecord({ servicesRoot: records.resolveServicesRoot({}), adopt: false });
    return { ...context, hostFolderScope: folderScope,
      permissionSession: require('./permission-tier-policy').effectiveSessionFromRecord(4, record) };
  }
  if (!authorization?.resolve || context?.setupKind === 'plugin' || context?.researchAccess) return context;
  require('./file-tool-context').requireFileToolContext(authorization.fileToolContext);
  authorization.admitted = await authorization.resolve() === true;
  if (!authorization.admitted) return context;
  const records = require('./setup/machine-record');
  const record = records.readMachineRecord({ servicesRoot: records.resolveServicesRoot({}), adopt: false });
  // This is a live authenticated inheritance result, not a guessed parent
  // level. The saved setup and role/function checks still narrow the call.
  return { ...context, permissionSession: require('./permission-tier-policy').effectiveSessionFromRecord(4, record) };
}

function run(context, callback) {
  const session = require('./permission-tier-policy').session(context?.permissionSession);
  const authorization = bound(context);
  const active = authorization?.resolveFolderScope && context.hostFolderScope
    ? { ...authorization, admittedScope: context.hostFolderScope, revoked: false } : authorization;
  return fileScope.run(context?.fileToolContext, () => scope.run(active
    && session.origin === 'local' && session.tier === 'full'
    // Turning byte coordination off must not disable the independent V2
    // folder policy (including read-only protection inside the workspace).
    && (active.resolveAmbientAccess || active.resolveFolderScope || require('./providers/host-control').hostByteMediationEnabled())
    && !context?.researchAccess && context?.setupKind !== 'plugin' ? active : null, callback));
}

function unrestricted() {
  const authorization = scope.getStore();
  if (!authorization || process.env.TOOLSENABLED_RUNTIME_MODE !== 'host'
      || process.env.TOOLSENABLED_HOST_SETUP_KIND === 'plugin') return false;
  require('./file-tool-context').requireFileToolContext(authorization.fileToolContext);
  assertCurrent();
  // Re-read the sealed setup at every path/publication check: a downgrade or
  // unreadable record cannot retain the broader scope of an earlier call.
  const records = require('./setup/machine-record');
  const record = records.readMachineRecord({ servicesRoot: records.resolveServicesRoot({}), adopt: false });
  return Boolean(record && require('./permission-tier-policy').installTierFromRecord(record) === 'unrestricted');
}

function assertCurrent() {
  const current = fileScope.getStore();
  if (current) require('./file-tool-capabilities').requireFileToolContext(current);
  const authorization = scope.getStore();
  if (!authorization) return;
  require('./file-tool-context').requireFileToolContext(authorization.fileToolContext);
  if (authorization.resolveFolderScope && (!authorization.admittedScope || authorization.revoked)) {
    throw Object.assign(new Error('The parent folder policy changed during this operation. Read again under its current revision.'),
      { code: 'FLEET_FOLDER_SCOPE_CHANGED' });
  }
  if ((authorization.resolve || authorization.resolveAmbientAccess) && !authorization.admitted) {
    throw Object.assign(new Error('The worker no longer inherits unrestricted file access.'), { code: 'HOST_FILE_ACCESS_REVOKED' });
  }
}

async function refresh() {
  const current = fileScope.getStore();
  if (current) await require('./file-tool-capabilities').refreshFileToolContext(current);
  const authorization = scope.getStore();
  if (!authorization) return;
  require('./file-tool-context').requireFileToolContext(authorization.fileToolContext);
  if (authorization.resolveFolderScope) {
    try {
      const current = require('./fleet-folder-scope').normalize(await authorization.resolveFolderScope());
      if (scopeKey(current) !== scopeKey(authorization.admittedScope)) authorization.revoked = true;
    } catch (error) { authorization.revoked = true; throw error; }
  }
  if (authorization.resolve) authorization.admitted = await authorization.resolve() === true;
  if (authorization.resolveAmbientAccess) authorization.admitted = await authorization.resolveAmbientAccess() === true;
  assertCurrent();
}

function workingDirectory() {
  const authorization = scope.getStore();
  if (!authorization?.resolveAmbientAccess) return null;
  assertCurrent(); return authorization.cwd;
}

function assertPath(candidate, { forWrite = false } = {}) {
  const authorization = scope.getStore();
  if (!authorization?.resolveFolderScope) return;
  assertCurrent();
  if (!forWrite && authorization.admittedScope.readAll === true) return;
  const paths = require('node:path');
  const roots = forWrite ? authorization.admittedScope.writeRoots : authorization.admittedScope.readRoots;
  if (!roots.some(root => {
    const relative = paths.relative(root, candidate);
    return relative === '' || relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
  })) throw Object.assign(new Error(`The path is outside the current parent ${forWrite ? 'write' : 'read'} folder scope.`),
    { code: 'FLEET_FOLDER_SCOPE_DENIED' });
}

// Resource syntax is separate from access authorization. Host adapters check
// the live session again before reading/publishing; the journal can validate
// its resource names even when their original transport has closed.
function resourcePath(value, { platform = process.platform } = {}) {
  const paths = platform === 'win32' ? require('node:path').win32 : require('node:path');
  if (typeof value !== 'string' || !paths.isAbsolute(value) || value.includes('\0')) {
    throw Object.assign(new Error('A host resource needs an absolute local file path.'), { code: 'HOST_PATH_INVALID' });
  }
  if (platform !== 'win32') return paths.normalize(value);
  const local = value.replace(/^\\\\\?\\(?=[a-z]:\\)/i, '');
  const normalized = paths.normalize(local);
  const parts = normalized.slice(3).split('\\');
  if (!/^[a-z]:\\/i.test(normalized)
      || parts.some(part => /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw Object.assign(new Error('Host file tools require ordinary local drive paths; network, device and alternate-stream paths are unsupported.'),
      { code: 'HOST_PATH_INVALID' });
  }
  return normalized;
}

module.exports = { create, createInherited, createScoped, createAmbient, workingDirectory, prepare, run, unrestricted, assertCurrent, refresh, assertPath, resourcePath };
