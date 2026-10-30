'use strict';

// A lead's retained choice is metadata. Credentials remain in the existing
// account home; this module neither provisions nor refreshes nor copies them.
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
function refuse(code, message, reason) { throw Object.assign(new Error(message), { code, ...(reason ? { reason } : {}) }); }
const accountFailures = new WeakMap();
async function accountIO(subject, read) {
  try { return await read(); }
  catch (error) { accountFailures.set(error, subject); throw error; }
}
const accountText = (file, subject) => accountIO(subject, () => fs.readFile(file, 'utf8'));
const accountJson = (file, subject) => accountIO(subject, async () => JSON.parse(await fs.readFile(file, 'utf8')));
function accountVerificationFailure(error) {
  const subject = accountFailures.get(error) || 'account directory';
  if (error?.code === 'ENOENT')
    refuse(subject === 'account directory' ? 'FLEET_ACCOUNT_HOME_MISSING' : 'FLEET_ACCOUNT_FILE_MISSING',
      `The selected ${subject} is missing. Next: provision that directory or file through the existing account service.`, 'NOT_FOUND');
  if (['EACCES', 'EPERM'].includes(error?.code))
    refuse('FLEET_ACCOUNT_READ_DENIED', `The selected ${subject} is unreadable. Next: restore its owner and read permissions.`, 'READ_DENIED');
  if (['ENOTDIR', 'EISDIR', 'ELOOP'].includes(error?.code))
    refuse('FLEET_ACCOUNT_HOME_INVALID', `The selected ${subject} has an invalid file type or link path. Next: repair its directory and file layout.`, 'PATH_INVALID');
  if (error instanceof SyntaxError)
    refuse('FLEET_ACCOUNT_METADATA_INVALID', `The selected ${subject} contains invalid JSON. Next: repair it through the account service.`, 'INVALID_JSON');
  refuse('FLEET_ACCOUNT_UNVERIFIED', 'The existing account verification service failed. Next: check its identity/access integration; no credential details were retained.', 'ACCOUNT_VERIFICATION_FAILED');
}
async function classifyAccountHomeResolutionFailure(root, home, error) {
  if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
  const invalid = () => refuse('FLEET_ACCOUNT_HOME_INVALID',
    'The selected account home has an invalid path layout. Next: repair it through the existing account-home service.', 'PATH_INVALID');
  const alias = () => refuse('FLEET_ACCOUNT_HOME_INVALID',
    'The selected home crosses a link. Next: provision a verified canonical account home.', 'ACCOUNT_HOME_ALIAS');
  const missing = () => refuse('FLEET_ACCOUNT_HOME_MISSING',
    'The selected account directory is missing. Next: provision it through the existing account service.', 'NOT_FOUND');
  let canonicalRoot;
  try { canonicalRoot = await fs.realpath(root); }
  catch (rootError) { if (rootError?.code === 'ENOENT') return missing(); throw rootError; }
  if (canonicalRoot !== path.resolve(root)) return alias();
  let current = path.resolve(root);
  for (const segment of path.relative(current, path.resolve(home)).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (entryError) {
      if (entryError?.code === 'ENOENT') return missing();
      if (entryError?.code === 'ENOTDIR') return invalid();
      throw entryError;
    }
    if (stat.isSymbolicLink() || stat.isReparsePoint?.()) return alias();
    if (!stat.isDirectory()) return invalid();
  }
  return invalid();
}
const GRANT_FIELDS = ['account', 'email', 'workspaceId', 'creditAuthority', 'creditModels', 'grantedAt'];
function creditGrant(value, { account, email, workspaceId } = {}) {
  if (typeof account !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(account)
      || typeof email !== 'string' || typeof workspaceId !== 'string' || !workspaceId.trim()
      || !value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== GRANT_FIELDS.length || Object.keys(value).some(key => !GRANT_FIELDS.includes(key))
      || value.account !== account || typeof value.email !== 'string' || value.email !== email?.toLowerCase()
      || value.workspaceId !== workspaceId || !workspaceId
      || typeof value.creditAuthority !== 'string' || !value.creditAuthority.trim() || value.creditAuthority.length > 16384
      || !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/.test(value.creditAuthority)
      || typeof value.grantedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value.grantedAt) || !Number.isFinite(Date.parse(value.grantedAt))
      || !Array.isArray(value.creditModels) || !value.creditModels.length || value.creditModels.length > 100
      || value.creditModels.some(model => typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(model))
      || new Set(value.creditModels).size !== value.creditModels.length) return null;
  return { account, email: value.email, workspaceId, creditAuthority: value.creditAuthority,
    creditModels: [...value.creditModels].sort(), grantedAt: value.grantedAt };
}
function creditBalance(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) return null;
  const balance = Number(value);
  return Number.isFinite(balance) && balance >= 0 ? balance : null;
}
function creditCompletionEvents(forward, codex) {
  if (!codex?.creditCompletion) return forward;
  const emit = typeof forward === 'function' ? forward : () => {};
  const completed = new Set();
  return event => {
    if (event?.type !== 'turn_completed' || !event.threadId || !event.turnId) return emit(event);
    const key = `${event.threadId}:${event.turnId}`;
    if (completed.has(key)) return;
    completed.add(key); if (completed.size > 128) completed.delete(completed.values().next().value);
    return Promise.resolve().then(() => codex.creditCompletion()).catch(() => ({
      ...codex.creditSpend(), balanceAtCompletion: null, completionStatus: 'unavailable'
    })).then(spend => emit({ ...event, creditSpend: spend }));
  };
}
const custodyErrors = new WeakSet();
function custodyUnavailable(reason, message) {
  const error = Object.assign(new Error(message), { code: 'FLEET_ACCOUNT_CUSTODY_UNAVAILABLE', reason });
  custodyErrors.add(error);
  throw error;
}
function rethrowCustody(error) {
  // Only our own diagnostics are safe to forward; arbitrary adapter errors can
  // contain credentials, stdout, stderr, or the remote command.
  if (custodyErrors.has(error)) throw error;
  custodyUnavailable('CUSTODY_READ_FAILED', 'Canonical Codex custody could not be read; check the configured custody adapter before retrying.');
}
function attestationReason(custody, auth) {
  const stated = custody?.reason ?? custody?.error;
  if (typeof stated !== 'string') return 'No reason was supplied.';
  let safe = stated;
  const secrets = [];
  const collect = (value, sensitive = false) => {
    if (typeof value === 'string' && sensitive && value) secrets.push(value);
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value))
      collect(item, sensitive || /token|secret|password|credential|api.?key|authorization/i.test(key));
  };
  collect(auth); collect(custody);
  for (const secret of secrets.sort((a, b) => b.length - a.length)) safe = safe.replaceAll(secret, '[redacted]');
  return safe.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[redacted private key]')
    .replace(require('./secret-patterns').plaintextCredentialPattern('gi'), '[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|password|secret|credential)\b["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;"'}]+)/gi, '[redacted credential]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\bsk-[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 400);
}
function invalidCustody(custody, identity, auth, fallback) {
  if (custody && (custody.status !== 'ok' || (custody.singleHolder !== true && (custody.reason || custody.error))))
    refuse('FLEET_ACCOUNT_CUSTODY_INVALID', `The canonical Codex custody service answered but refused attestation: ${attestationReason(custody, auth)} Repair the service's stated condition before retrying.`, 'ATTESTATION_REFUSED');
  refuse('FLEET_ACCOUNT_CUSTODY_INVALID', fallback, 'ATTESTATION_INVALID');
}
const PROVIDER_KEYS = Object.freeze({ codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'], claude: ['ANTHROPIC_API_KEY'],
  grok: ['XAI_API_KEY', 'GROK_API_KEY'], gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] });
function configuredKey(provider, env) {
  return PROVIDER_KEYS[provider]?.find(name => typeof env[name] === 'string' && env[name].trim());
}
function checkedRoute(route) {
  if (route?.provider === 'codex' && route.authentication === 'api-key' && route.keySource === 'account-home') {
    const selected = checkedRoute({ provider: route.provider, account: route.account });
    return { ...selected, authentication: 'api-key', keySource: 'account-home', ...(route.model ? { model: route.model } : {}) };
  }
  if (route?.authentication === 'api-key' && Object.hasOwn(PROVIDER_KEYS, route.provider))
    return { provider: route.provider, authentication: 'api-key', ...(route.model ? { model: route.model } : {}) };
  if (!['claude', 'codex'].includes(route?.provider)) refuse('FLEET_ACCOUNT_PROVIDER_UNSUPPORTED', 'Select a qualified Claude or Codex account through the existing account service.');
  if (typeof route.account !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(route.account))
    refuse('FLEET_ACCOUNT_UNKNOWN', 'The account id is invalid or contains path components. Next: select a registered id using letters, digits, underscores or hyphens.', 'ACCOUNT_ID_INVALID');
  if (route.provider === 'codex' && route.admission === 'ordinary-work') {
    if (typeof route.model !== 'string' || !route.model.trim()) refuse('FLEET_ACCOUNT_MODEL_MISMATCH', 'Choose an explicit currently advertised model for ordinary work.');
    if (route.effort !== undefined && (typeof route.effort !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(route.effort)))
      refuse('FLEET_ACCOUNT_MODEL_MISMATCH', 'Choose an explicit supported reasoning effort from the current account catalog.');
    return { provider: route.provider, account: route.account, admission: 'ordinary-work', model: route.model,
      ...(route.effort !== undefined ? { effort: route.effort } : {}) };
  }
  return { provider: route.provider, account: route.account };
}
function accountCatalogFingerprint(catalog) {
  if (!catalog || catalog.source !== 'authenticated-provider' || catalog.complete !== true
      || catalog.refreshRequested === true || !Array.isArray(catalog.models)) return null;
  const models = catalog.models.map(model => {
    if (!model || typeof model.id !== 'string' || typeof model.model !== 'string' || typeof model.hidden !== 'boolean') return null;
    const efforts = Array.isArray(model.efforts)
      ? model.efforts.map(effort => typeof effort === 'string' ? effort : effort?.id)
      : null;
    if (efforts?.some(effort => typeof effort !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(effort))) return null;
    const defaultEffort = typeof model.defaultEffort === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(model.defaultEffort)
      && (!efforts || efforts.includes(model.defaultEffort)) ? model.defaultEffort : null;
    if (model.defaultEffort != null && model.defaultEffort !== defaultEffort) return null;
    return { id: model.id, model: model.model, hidden: model.hidden, efforts, defaultEffort };
  });
  if (models.some(model => model === null)) return null;
  return require('node:crypto').createHash('sha256').update(JSON.stringify(models)).digest('hex');
}
function bindAccountRoute(document, node) {
  if (node.accountRouteProvider === node.provider) return;
  // Pre-existing conversations keep the original inherited home. No transcript
  // moves, new thread, account failover, or change to an already-running CLI.
  const chosen = node.threadId ? null : document.fleetControl?.accountDefaults?.[node.provider];
  node.accountRoute = chosen ? checkedRoute(chosen) : null;
  if (node.accountRoute?.admission === 'ordinary-work') node.accountWorkEvidence ||= { completionStatus: 'not-observed' };
  node.accountRouteProvider = node.provider;
}
function recordAccountCompletion(node, event, at) {
  if (!node.accountRoute || !node.accountAdmission || (node.accountRoute?.admission !== 'ordinary-work' && !node.accountAdmission.creditSpend)
      || node.accountAdmission.model !== (node.accountRoute.model || node.model) || node.accountAdmission.account !== node.accountRoute.account || event.threadId !== node.threadId || !event.turnId) return;
  const previous = node.accountWorkEvidence || { completionStatus: 'not-observed' };
  const success = ['completed', 'success', 'end_turn'].includes(event.status);
  const attempt = { status: success ? 'succeeded' : event.status === 'failed' ? 'failed' : 'not-confirmed',
    model: node.accountRoute.model, account: node.accountRoute.account, workspaceId: node.accountAdmission.workspaceId, threadId: event.threadId, turnId: event.turnId, at };
  const admitted = node.accountAdmission.creditSpend;
  if (admitted) {
    const observed = event.creditSpend;
    const matching = observed?.creditAuthority === admitted.creditAuthority && observed.account === admitted.account && observed.workspaceId === admitted.workspaceId;
    attempt.creditSpend = { ...admitted,
      balanceAtCompletion: matching ? creditBalance(observed.balanceAtCompletion) : null,
      completionStatus: matching && creditBalance(observed.balanceAtCompletion) !== null ? 'observed' : 'unavailable',
      ...(matching && Number.isFinite(Date.parse(observed.completionObservedAt)) ? { completionObservedAt: observed.completionObservedAt } : {}) };
  }
  node.accountWorkEvidence = { ...previous, lastAttempt: attempt,
    ...(attempt.creditSpend ? { creditSpend: attempt.creditSpend } : {}),
    ...(success ? { completionStatus: 'succeeded', lastSuccess: attempt } : {}) };
}

async function loadExistingService(root) {
  if (!root || !path.isAbsolute(root)) refuse('FLEET_ACCOUNT_SERVICE_UNAVAILABLE', 'Set TOOLSENABLED_ACCOUNT_SERVICE_ROOT to the existing validated account-home service source folder on this host.');
  const [health, serve, usage, launch, codex, proxy] = await Promise.all(['health.js', 'serve.js', 'usage.js', 'launch.js', 'codex-policy.js', 'codex-model-proxy.js'].map(name => import(pathToFileURL(path.join(root, name)).href)));
  if (codex.NATIVE_FIRST_WORK !== 'catalog-admission-v1')
    refuse('FLEET_ACCOUNT_SERVICE_UNAVAILABLE', 'Use an account service with authenticated catalog support.');
  return { ...health, accountEmail: serve.accountEmail,
    usageUrl: usage.CLAUDE_USAGE_URL, overrides: launch.AUTH_OVERRIDES,
    checkedCatalog: codex.checkedCatalog, pinCodexArguments: codex.pinCodexArguments,
    guardedCodexRequest: proxy.guardedRequest, fetchCodexUsage: usage.fetchCodexUsage, codexUsageUrl: usage.CODEX_USAGE_URL };
}
function createAccountService({ env = process.env, loadService = loadExistingService, fetchImpl = globalThis.fetch, now = Date.now, readCustody = readCodexCustody, readCatalog = readCodexCatalog } = {}) {
  // Do not load private integration code unless the lead actually selects it.
  async function resolve(route, requestedModel, catalogOnly = false) {
    // A retained account choice wins over inherited provider keys. Only an
    // explicit key route, or a key with no selected account, uses env auth.
    if ((route?.authentication === 'api-key' && route.keySource !== 'account-home')
        || (!route?.account && configuredKey(route?.provider, env))) {
      const selected = checkedRoute({ ...route, authentication: 'api-key', keySource: undefined });
      if (!configuredKey(selected.provider, env))
        refuse('FLEET_ACCOUNT_AUTH_UNAVAILABLE', 'The selected API-key route needs its provider key configured in the launch environment.');
      return { route: selected, apiKey: true };
    }
    const selected = checkedRoute(route);
    let service;
    try { service = await loadService(env.TOOLSENABLED_ACCOUNT_SERVICE_ROOT); }
    catch { refuse('FLEET_ACCOUNT_SERVICE_UNAVAILABLE', 'Configure a readable existing account-home service with TOOLSENABLED_ACCOUNT_SERVICE_ROOT; no account was selected.'); }
    if ([...(service.overrides || []).filter(name => !Object.values(PROVIDER_KEYS).flat().includes(name)), ...(selected.provider === 'codex' ? ['CODEX_ACCESS_TOKEN', 'CODEX_AUTH_TOKEN', 'CODEX_SQLITE_HOME'] : [])].some(name => Boolean(env[name]))) refuse('FLEET_ACCOUNT_AUTH_OVERRIDE', 'Remove inherited authentication or endpoint overrides before selecting an account; Fleet will not override them.');
    const identities = service.EXPECTED_IDENTITIES?.[selected.provider] || {};
    const expected = Object.hasOwn(identities, selected.account) && identities[selected.account];
    if (!expected) refuse('FLEET_ACCOUNT_UNKNOWN', 'This account id is not registered with the account-home service.');
    let root;
    try { root = env.TELOGINS_ACCOUNTS_ROOT || service.resolveAccountsRoot(); }
    catch (error) {
      if (selected.provider !== 'codex') throw error;
      refuse('FLEET_ACCOUNT_HOME_INVALID', 'The Codex accounts root could not be resolved; set TELOGINS_ACCOUNTS_ROOT or repair the Telogins accounts-root resolver before retrying.', 'ACCOUNTS_ROOT_MISSING');
    }
    if (typeof root !== 'string' || !path.isAbsolute(root)) refuse('FLEET_ACCOUNT_HOME_INVALID', 'Set TELOGINS_ACCOUNTS_ROOT or repair the account-home service to resolve an absolute existing accounts root.', 'ACCOUNTS_ROOT_MISSING');
    if (selected.provider === 'codex') {
      try { if (!(await fs.stat(root)).isDirectory()) throw Error('Not a directory'); }
      catch { refuse('FLEET_ACCOUNT_HOME_INVALID', 'The Codex accounts root is missing or unreadable; provision it through Telogins and set TELOGINS_ACCOUNTS_ROOT to the existing accounts directory.', 'ACCOUNTS_ROOT_MISSING'); }
    }
    const home = path.join(root, selected.provider, selected.account);
    try {
      // Refuse aliases and unexpected custody instead of following a folder to
      // a refresher or another account. Read values only in memory, never logs.
      let realHome;
      try { realHome = await fs.realpath(home); }
      catch (error) { await classifyAccountHomeResolutionFailure(root, home, error); }
      if (realHome !== undefined && realHome !== home)
        refuse('FLEET_ACCOUNT_HOME_INVALID', 'The selected home crosses a link. Next: provision a verified canonical account home.', 'ACCOUNT_HOME_ALIAS');
      if (selected.provider === 'codex') return await codexRoute(selected, home, expected, service, requestedModel, catalogOnly);
      const auth = await accountJson(path.join(home, '.credentials.json'), 'Claude credential file');
      const oauth = auth.claudeAiOauth;
      if (oauth?.refreshToken || auth.sessionKey) refuse('FLEET_ACCOUNT_CUSTODY_INVALID', 'The selected home is not access-only; use the existing single-holder delivery service.');
      if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken.trim() || !Number.isFinite(oauth.expiresAt) || oauth.expiresAt <= now())
        refuse('FLEET_ACCOUNT_EXPIRED', 'The selected home needs current access from the existing login service; Fleet will not refresh or fall back.');
      const metadata = await accountJson(path.join(home, '.claude.json'), 'Claude identity file');
      const identity = metadata.oauthAccount;
      if (await service.accountEmail('claude', home) !== expected.toLowerCase() || !identity?.accountUuid || !identity.organizationUuid)
        refuse('FLEET_ACCOUNT_IDENTITY_INVALID', 'The selected account identity is missing or mismatched; repair it through the existing account-home service.');
      // Probe for reporting only. Unreadable or exhausted usage never changes
      // admission; identity and access were independently checked above.
      let report, observed = null;
      try { report = await service.probeClaudeAccount(selected.account, root, { allowanceExhausted: () => false,
        fetchImpl: async (url, options) => {
          if (url !== service.usageUrl) throw Error('Unexpected usage endpoint');
          const response = await fetchImpl(url, options);
          if (response.ok) observed = await response.clone().json();
          return response;
        } }); }
      catch { /* The observation below explicitly reports unavailable data. */ }
      if ((report?.account && report.account !== selected.account) || (report?.provider && report.provider !== 'claude'))
        refuse('FLEET_ACCOUNT_IDENTITY_INVALID', 'The usage service reported a different account or provider.');
      const windows = {};
      for (const [name, window] of Object.entries(observed || {})) {
        if (!/^(five_hour|seven_day(?:_.*)?)$/.test(name) || name === 'seven_day_breakdown') continue;
        windows[name] = window && Number.isFinite(window.utilization) && window.utilization >= 0 && window.utilization <= 100
          ? { usedPercent: window.utilization, resetsAt: Number.isFinite(Date.parse(window.resets_at)) ? new Date(window.resets_at).toISOString() : null } : null;
      }
      const usage = { usageKnown: Object.values(windows).some(Boolean), outcome: observed ? 'observed' : 'unavailable', windows,
        fiveHour: windows.five_hour ?? null, sevenDay: windows.seven_day ?? null,
        hasExtraUsageEnabled: typeof identity.hasExtraUsageEnabled === 'boolean' ? identity.hasExtraUsageEnabled : null,
        extraUsage: observed?.extra_usage ? { isEnabled: typeof observed.extra_usage.is_enabled === 'boolean' ? observed.extra_usage.is_enabled : null,
          monthlyLimit: creditBalance(observed.extra_usage.monthly_limit), usedCredits: creditBalance(observed.extra_usage.used_credits) } : null };
      if (oauth.expiresAt <= now()) refuse('FLEET_ACCOUNT_EXPIRED', 'Access expired during validation; refresh through the existing single-holder service before retrying.');
      return { home, usage };
    } catch (error) {
      if (error?.code?.startsWith('FLEET_ACCOUNT_')) throw error;
      accountVerificationFailure(error);
    }
  }
  async function codexRoute(selected, home, expected, service, requestedModel, catalogOnly) {
    const credential = path.join(home, 'auth.json');
    const stat = await accountIO('Codex credential file', () => fs.lstat(credential));
    if (!stat.isFile() || stat.isSymbolicLink())
      refuse('FLEET_ACCOUNT_CUSTODY_INVALID', 'Codex access must be a private owned file in its canonical account home.');
    if (process.platform === 'win32') {
      // POSIX mode bits and uid are not Windows ACL evidence. Reuse Fleet's
      // native state-file verifier for NTFS owner, DACL, hard-link and reparse
      // checks; any uncertainty remains a custody refusal.
      try { require('./windows-state-security').assertEntry(credential, false); }
      catch { refuse('FLEET_ACCOUNT_CUSTODY_INVALID', 'Codex access must be a private owned file in its canonical account home.'); }
    } else if ((stat.mode & 0o077) || stat.uid !== process.getuid()) {
      refuse('FLEET_ACCOUNT_CUSTODY_INVALID', 'Codex access must be a private owned file in its canonical account home.');
    }
    const before = await accountText(credential, 'Codex credential file');
    const auth = await accountIO('Codex credential file', async () => JSON.parse(before)), tokens = auth.tokens;
    if (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim() && !tokens?.refresh_token)
      return { home, apiKey: true, route: checkedRoute({ ...selected, authentication: 'api-key', keySource: 'account-home' }) };
    if (selected.authentication === 'api-key')
      refuse('FLEET_ACCOUNT_AUTH_UNAVAILABLE', 'The selected account-home API-key route no longer contains its configured key; restore that route before retrying.');
    if (auth.auth_mode !== 'chatgpt' || auth.OPENAI_API_KEY || !tokens?.access_token || tokens.refresh_token)
      refuse('FLEET_ACCOUNT_CUSTODY_INVALID', 'Codex launches need a subscription access-only home from the single-holder store.');
    const identity = await accountJson(path.join(home, '.telogins-identity.json'), 'Codex identity file');
    let custody;
    try { custody = await readCustody(selected.account, env); }
    catch (error) { rethrowCustody(error); }
    // Grants describe provenance; missing or differing spending metadata does
    // not authorize Fleet to prevent the provider from handling the request.
    const granted = creditGrant(identity.creditGrant, { account: selected.account, email: expected, workspaceId: tokens.account_id });
    if (typeof tokens.account_id !== 'string' || !tokens.account_id.trim() || custody?.version !== 1 || custody.status !== 'ok' || custody.singleHolder !== true || custody.account !== selected.account
        || custody.email !== expected.toLowerCase() || custody.workspaceId !== tokens.account_id
        || identity.workspaceId !== custody.workspaceId || identity.email?.toLowerCase() !== custody.email
        || typeof custody.planType !== 'string' || !custody.planType.trim() || identity.planType !== custody.planType || !Number.isFinite(custody.observedAtMs)
        || Math.abs(now() - custody.observedAtMs) > 30000)
      invalidCustody(custody, identity, auth, 'Current canonical custody, account identity, and plan must all agree; repair the mismatched or stale attestation through Telogins before retrying.');
    let usage, creditSpend, observation;
    const readUsage = async () => {
      let observed = null, identityError;
      try {
        usage = await service.fetchCodexUsage(tokens, async (url, options) => {
          if (url !== service.codexUsageUrl) throw Error('Unexpected usage endpoint');
          const response = await fetchImpl(url, options);
          if (response.ok) {
            const body = await response.clone().json();
            if ((body.email != null && body.email?.toLowerCase() !== custody.email) || (body.plan_type != null && body.plan_type !== custody.planType)) {
              identityError = Object.assign(new Error('Current provider identity or plan differs from canonical custody.'), { code: 'FLEET_ACCOUNT_IDENTITY_INVALID' });
              throw identityError;
            }
            observed = body;
          }
          return response;
        });
      } catch { usage = { outcome: 'unavailable' }; }
      if (identityError) throw identityError;
      const balance = creditBalance(observed?.credits?.balance);
      const credits = observed?.credits ? { hasCredits: typeof observed.credits.has_credits === 'boolean' ? observed.credits.has_credits : null,
        unlimited: typeof observed.credits.unlimited === 'boolean' ? observed.credits.unlimited : null, balance } : null;
      let fiveHour = null, sevenDay = null;
      for (const window of [observed?.rate_limit?.primary_window, observed?.rate_limit?.secondary_window]) {
        if (!window || !Number.isFinite(window.used_percent) || window.used_percent < 0 || window.used_percent > 100
            || !Number.isFinite(window.limit_window_seconds) || window.limit_window_seconds <= 0 || !Number.isFinite(window.reset_at)
            || window.reset_at * 1000 <= now()) continue;
        const reset = new Date(window.reset_at * 1000);
        if (!Number.isFinite(reset.getTime())) continue;
        const measured = { usedPercent: window.used_percent, resetsAt: reset.toISOString() };
        if (window.limit_window_seconds >= 5 * 86400) sevenDay = measured; else fiveHour = measured;
      }
      usage = { outcome: observed ? 'observed' : 'unavailable', usageKnown: !!(fiveHour || sevenDay), fiveHour, sevenDay, credits,
        providerAllowed: typeof observed?.rate_limit?.allowed === 'boolean' ? observed.rate_limit.allowed : null,
        providerLimitReached: typeof observed?.rate_limit?.limit_reached === 'boolean' ? observed.rate_limit.limit_reached : null };
      observation = { account: selected.account, email: custody.email, workspaceId: custody.workspaceId,
        creditAuthority: granted?.creditAuthority ?? null, grantedAt: granted?.grantedAt ?? null,
        creditAuthoritySource: granted ? 'account-identity' : null,
        balanceAtAdmission: balance, admissionObservedAt: new Date(now()).toISOString(),
        observationStatus: observed ? 'observed' : 'unavailable', credits };
      creditSpend ||= observation;
      return usage;
    };
    await readUsage();
    const ordinary = selected.admission === 'ordinary-work' || catalogOnly;
    if (ordinary && requestedModel !== undefined && requestedModel !== selected.model)
      refuse('FLEET_ACCOUNT_MODEL_MISMATCH', 'Worker model differs from the lead-selected ordinary-work model.');
    // The integration's launch authorizer also gates on usage/credit state.
    // Read model/identity policy locally and reuse only its catalog and argument
    // checks, so a usage-read outage cannot be mistaken for an auth failure.
    let policy, model, admission = null;
    try {
      if (ordinary) {
        policy = { email: identity.email, workspaceId: identity.workspaceId, planType: identity.planType };
        model = catalogOnly ? null : selected.model;
        const catalog = await readCatalog(home, launchEnvironment(selected, { home }).env);
        service.checkedCatalog(catalog, identity, home, model, now());
        admission = { kind: 'ordinary-work', model, catalog, completionStatus: 'not-observed' };
      } else {
        if (!path.isAbsolute(env.TELOGINS_MODEL_POLICY || '')) throw Error();
        const registry = await accountJson(env.TELOGINS_MODEL_POLICY, 'Codex model-policy file');
        policy = registry.version === 1 && Object.hasOwn(registry.accounts || {}, selected.account) && registry.accounts[selected.account];
        model = policy?.defaultModel;
        if (!model || policy.realCallPassed !== true || !['allowedModels', 'verifiedModels', 'advertisedModels'].every(key => Array.isArray(policy[key]) && policy[key].includes(model))) throw Error();
      }
    } catch (error) {
      if (accountFailures.has(error)) throw error;
      refuse('FLEET_ACCOUNT_CODEX_UNVERIFIED', 'Current catalog or model policy could not be verified. Repair its current service record.');
    }
    if (policy.email?.toLowerCase() !== custody.email || policy.workspaceId !== custody.workspaceId || policy.planType !== custody.planType)
      refuse('FLEET_ACCOUNT_IDENTITY_INVALID', 'Codex model policy differs from the canonical account identity or plan.');
    const authorized = { model, policy, admission };
    if (requestedModel !== undefined && requestedModel !== authorized.model)
      refuse('FLEET_ACCOUNT_MODEL_MISMATCH', 'Requested Codex model differs from the existing account-specific verified model.');
    if (before !== await accountText(credential, 'Codex credential file'))
      refuse('FLEET_ACCOUNT_CHANGED', 'Access changed during verification; retry this pinned route after delivery finishes.');
    if (catalogOnly) return { home, catalog: authorized.admission.catalog };
    const pinned = service.pinCodexArguments(['app-server'], authorized.policy, authorized.admission);
    return { home, usage, codex: { model: authorized.model, workspaceId: custody.workspaceId, args: pinned.args,
      creditSpend: () => ({ ...creditSpend }), creditCompletion: async () => {
        const admitted = { ...creditSpend };
        if (before !== await accountText(credential, 'Codex credential file')) throw Error('Credit observation unavailable');
        await readUsage();
        return { ...admitted, balanceAtCompletion: observation.balanceAtAdmission,
          completionObservedAt: observation.admissionObservedAt,
          completionStatus: observation.balanceAtAdmission === null ? 'unavailable' : 'observed' };
      }, beforeThread: async adapter => {
        const current = { ...(await adapter.readAccountCatalog()), source: 'authenticated-provider', complete: true, refreshRequested: false, observedAtMs: now(), home };
        service.checkedCatalog(current, identity, home, selected.model || authorized.model, now());
        await readUsage();
        creditSpend = observation;
        let currentCustody;
        try { currentCustody = await readCustody(selected.account, env); }
        catch (error) { rethrowCustody(error); }
        if (currentCustody?.singleHolder !== true || currentCustody.status !== 'ok' || currentCustody.account !== selected.account
            || currentCustody.workspaceId !== custody.workspaceId || currentCustody.email !== custody.email || currentCustody.planType !== custody.planType
            || !Number.isFinite(currentCustody.observedAtMs) || Math.abs(now() - currentCustody.observedAtMs) > 30000)
          invalidCustody(currentCustody, identity, auth, 'Current canonical custody changed before thread admission; repair or renew the pinned account attestation through Telogins before retrying.');
        if (before !== await accountText(credential, 'Codex credential file')) refuse('FLEET_ACCOUNT_CHANGED', 'Access changed before provider thread admission.');
        return { kind: 'ordinary-work', model: selected.model || authorized.model, account: selected.account, workspaceId: custody.workspaceId, catalogObservedAtMs: current.observedAtMs, completionStatus: 'not-observed',
          ...(creditSpend ? { creditSpend: { ...creditSpend } } : {}) };
      },
      requestGate: message => service.guardedCodexRequest({ jsonrpc: '2.0', ...message }, authorized.model) } };
  }
  function launchEnvironment(route, resolved) {
    const launchEnv = { ...env }, withheldEnv = [];
    if (resolved.home) {
      // Account-home key routes also keep their selected file credentials;
      // inherited environment keys must not replace that explicit identity.
      for (const name of PROVIDER_KEYS[route.provider] || []) {
        if (Object.hasOwn(launchEnv, name)) withheldEnv.push(name);
        delete launchEnv[name];
      }
      launchEnv[route.provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = resolved.home;
    }
    return { env: launchEnv, withheldEnv };
  }
  async function launch(route, { model } = {}) {
    const resolved = await resolve(route, model);
    if (!resolved.apiKey && route.provider === 'codex' && !model)
      refuse('FLEET_ACCOUNT_MODEL_MISMATCH', 'Specify the account-specific verified Codex model explicitly.');
    return { ...launchEnvironment(route, resolved), codex: resolved.codex, usage: resolved.usage };
  }
  return Object.freeze({ catalog: async route => (await resolve(route, undefined, true)).catalog, validate: async route => { const resolved = await resolve(route); return resolved.route || checkedRoute(route); },
    environment: async route => { const resolved = await resolve(route); return launchEnvironment(route, resolved).env; }, launch });
}

async function readCodexCatalog(home, env) {
  const registry = require('./agents/registry');
  const known = registry.activeRegistry(env); registry.assertWorkerAvailable(known, 'codex');
  const agent = known.get('codex');
  if (agent.worker.driver !== 'app-server') refuse('FLEET_ACCOUNT_CATALOG_INVALID', 'Codex catalog needs its native app-server driver.');
  return require('./agent-engine/codex-process').inspectCodexAccountCatalog({ command: agent.command, provider: 'codex', env: { ...env, TOOLSENABLED_WORKER_ID: 'fleet-account-catalog-read' }, cwd: home });
}

// Read-only custody measurement, never an account selector, refresher or agent
// lifecycle helper. Fixed argument grammar avoids interpolating account input.
async function readCodexCustody(account, env) {
  const file = env.TELOGINS_CODEX_CUSTODY_CONFIG;
  if (!file) custodyUnavailable('CUSTODY_CONFIG_MISSING', 'TELOGINS_CODEX_CUSTODY_CONFIG is missing; set it to the absolute path of the canonical Codex custody configuration.');
  if (typeof file !== 'string' || !path.isAbsolute(file)) custodyUnavailable('CUSTODY_CONFIG_INVALID', 'TELOGINS_CODEX_CUSTODY_CONFIG must name an absolute configuration path; correct it before retrying.');
  let text, config;
  try { text = await fs.readFile(file, 'utf8'); }
  catch { custodyUnavailable('CUSTODY_CONFIG_UNREADABLE', 'The file named by TELOGINS_CODEX_CUSTODY_CONFIG is unreadable; restore the file and its read permissions before retrying.'); }
  try { config = JSON.parse(text); }
  catch { custodyUnavailable('CUSTODY_CONFIG_INVALID', 'The file named by TELOGINS_CODEX_CUSTODY_CONFIG is not valid JSON; repair the configuration before retrying.'); }
  if (!config || config.version !== 1 || typeof config.host !== 'string' || !config.host
      || typeof config.adapter !== 'string' || !path.isAbsolute(config.adapter)
      || typeof config.store !== 'string' || !path.isAbsolute(config.store))
    custodyUnavailable('CUSTODY_CONFIG_INVALID', 'The file named by TELOGINS_CODEX_CUSTODY_CONFIG is invalid; require version 1, a host, and absolute adapter and store paths.');
  if (!env.TELOGINS_CODEX_CUSTODY_HOST)
    custodyUnavailable('CUSTODY_HOST_PIN_MISSING', "TELOGINS_CODEX_CUSTODY_HOST is missing; set it to exactly the config's host field before retrying.");
  if (config.host !== env.TELOGINS_CODEX_CUSTODY_HOST)
    custodyUnavailable('CUSTODY_HOST_PIN_MISMATCH', "TELOGINS_CODEX_CUSTODY_HOST differs from the config's host field; verify the canonical host and make the pin and configuration agree before retrying.");
  const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
  const command = ['env', 'TELOGINS_STORE=' + config.store, 'python3', '-I', config.adapter, 'custody', account].map(quote).join(' ');
  let stdout;
  try { ({ stdout } = await require('node:util').promisify(require('node:child_process').execFile)(
    'ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', config.host, command], { encoding: 'utf8', env, timeout: 15000 })); }
  catch (error) {
    if (error.killed || error.code === 'ETIMEDOUT')
      custodyUnavailable('CUSTODY_SSH_TIMEOUT', 'SSH to the canonical Codex custody host timed out; restore host connectivity or service responsiveness before retrying.');
    // A remote adapter can report its refusal as JSON with a nonzero exit.
    // SSH itself reserves 255 for transport/authentication failures.
    if (Number.isInteger(error.code) && error.code > 0 && error.code < 255) {
      try { const response = JSON.parse(error.stdout); if (response && response.status && response.status !== 'ok') return response; }
      catch { /* Never forward raw process output. */ }
    }
    if (/timed? out/i.test(error.stderr || ''))
      custodyUnavailable('CUSTODY_SSH_TIMEOUT', 'SSH to the canonical Codex custody host timed out; restore host connectivity or service responsiveness before retrying.');
    custodyUnavailable('CUSTODY_SSH_FAILED', 'SSH to the canonical Codex custody host failed; check host connectivity, SSH authentication and the remote custody command before retrying.');
  }
  try { return JSON.parse(stdout); }
  catch { custodyUnavailable('CUSTODY_RESPONSE_INVALID', 'SSH completed but the canonical Codex custody service returned invalid JSON; repair the custody adapter response before retrying.'); }
}
module.exports = { createAccountService, bindAccountRoute, recordAccountCompletion, readCodexCustody, accountCatalogFingerprint, creditGrant, creditBalance, creditCompletionEvents };
