'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { validateSendTurnRequest } = require('./engine-contract');
function rulesText(value) {
  if (typeof value !== 'string') throw Object.assign(new TypeError('Durable rules instructions must be a complete string.'), { code: 'PROVIDER_RULES_INVALID' });
  return value;
}
function rulesDeliveryKey(value) {
  // Fleet's control revision also advances for progress and task bookkeeping.
  // The ledger revision and complete rules body remain authoritative; a
  // control-only stamp change is not a rules change.
  return rulesText(value).replace(/^(Rules revision: ledger [^;\n]+; control )\d+(; sha256 [a-f0-9]{64}\n)/, '$1*$2');
}
function mergeInstructions(base, rules) {
  return [base, rulesText(rules)].filter(Boolean).join('\n\n');
}
function saveRulesState(file, baseDeveloperInstructions, threadId) {
  if (!file) return;
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ threadId, baseDeveloperInstructions }) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}
function loadRulesBase(file, threadId) {
  if (!file) return null;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return saved.threadId === threadId && typeof saved.baseDeveloperInstructions === 'string' ? saved.baseDeveloperInstructions : null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
// Claude reads --append-system-prompt-file at process startup, not at each
// stdin user message. Rotate only our owned process at a completed-turn boundary
// and resume the native conversation; never rely on compacted user text.
function processRulesSession(initial, { options, start, resume, resumed = false, writeRules, initialRules,
  provider = 'Claude', prefix = 'CLAUDE', refreshOptions = () => ({}), initialEffort, validate = async () => {} }) {
  let session = initial, rules = rulesText(initialRules), used = false, busy = false, closed = false, changingProcess = false;
  let compactions = 0, appliedCompactions = 0, unsubscribe = null;
  let refreshing = null, stopping = null, effort = initialEffort;
  function observeCompaction() {
    unsubscribe?.();
    unsubscribe = session.adapter.onEvent?.(event => {
      if (event.type === 'context_compacted' && event.threadId === initial.threadId) compactions++;
    });
  }
  observeCompaction();
  const facade = new Proxy({}, { get(_target, key) {
    if (key === 'sendTurn') return async request => {
      if (closed) throw Object.assign(new Error(`This durable ${provider} worker is closed.`), { code: `${prefix}_CLI_CLOSED` });
      if (busy) throw Object.assign(new Error(`This durable ${provider} worker already has a turn.`), { code: `${prefix}_CLI_TURN_ACTIVE` });
      const { rulesInstructions, ...turn } = validateSendTurnRequest(request);
      const nextRules = rulesInstructions === undefined ? rules : rulesText(rulesInstructions);
      busy = true;
      try {
        // An unused new session can restart under its already-minted id;
        // existing conversations always resume their provider-owned history.
        if (rulesDeliveryKey(nextRules) !== rulesDeliveryKey(rules) || compactions !== appliedCompactions) {
          const refreshingCompactions = compactions;
          if (typeof session.quiesce !== 'function') throw Object.assign(new Error(`${provider} cannot confirm the previous process stopped before refreshing durable rules.`), { code: `${prefix}_RULES_REFRESH_UNSUPPORTED` });
          changingProcess = true;
          refreshing = (async () => {
            await session.quiesce();
            writeRules(nextRules);
            if (closed) throw Object.assign(new Error(`This durable ${provider} worker closed during refresh.`), { code: `${prefix}_CLI_CLOSED` });
            const nextOptions = { ...options, ...refreshOptions(nextRules) };
            session = used || resumed
              ? await resume({ ...nextOptions, threadId: initial.threadId, threadProvider: options.provider })
              : await start({ ...nextOptions, initialThreadId: initial.threadId });
            // Shutdown may have started before native startup returned its handle.
            // Do not validate or submit work after that ownership boundary closes.
            if (closed) { await session.quiesce(); throw Object.assign(new Error(`This durable ${provider} worker closed during resume.`), { code: `${prefix}_CLI_CLOSED` }); }
            try { await validate(session, { effort }); } catch (error) { await session.quiesce(); throw error; }
            if (closed) { await session.quiesce(); throw Object.assign(new Error(`This durable ${provider} worker closed during validation.`), { code: `${prefix}_CLI_CLOSED` }); }
            observeCompaction();
            appliedCompactions = refreshingCompactions;
          })();
          try { await refreshing; } finally { refreshing = null; }
        }
        changingProcess = false;
        rules = nextRules;
        const pending = session.adapter.sendTurn(turn);
        // Image/validation failures can reject before the native process has
        // seen a user message. Do not resume an unsaved thread in that case.
        used = used || !!session.adapter.pendingTurnForInterrupt?.({ threadId: initial.threadId });
        const result = await pending;
        used = true;
        return result;
      } finally { changingProcess = false; busy = false; }
    };
    const value = session.adapter[key];
    if (key === 'updateThreadSettings' && typeof value === 'function') return async (threadId, settings) => {
      const result = await value.call(session.adapter, threadId, settings);
      if (threadId === initial.threadId && settings.effort !== undefined) effort = settings.effort;
      return result;
    };
    return typeof value === 'function' ? value.bind(session.adapter) : value;
  } });
  return { ...initial, adapter: facade,
    get processGroup() { return session.processGroup; },
    get processTransition() { return changingProcess; },
    close() { closed = true; unsubscribe?.(); return session.close(); },
    quiesce() {
      closed = true; unsubscribe?.();
      if (!stopping) stopping = (async () => {
        const current = session, pending = refreshing;
        // Stop an already-returned replacement too, so pending validation can
        // settle. Joining startup then exposes any not-yet-returned replacement.
        try { await current.quiesce(); } finally {
          if (pending) { try { await pending; } catch { /* the sending turn retains the refresh failure */ } }
          if (session !== current) await session.quiesce();
        }
      })().catch(error => { stopping = null; throw error; });
      return stopping;
    }
  };
}
function claudeRulesSession(initial, options) { return processRulesSession(initial, options); }
// Managed Codex's model gate deliberately excludes collaborationMode overrides.
// Refresh through its already-qualified thread/resume developerInstructions
// path, retaining the native thread, account/model gate and admission checks.
function codexRulesSession(initial, options) {
  return processRulesSession(initial, { ...options, provider: 'Codex', prefix: 'CODEX', resumed: true,
    writeRules() {}, refreshOptions: rulesInstructions => ({ rulesInstructions }) });
}
module.exports = { rulesText, rulesDeliveryKey, mergeInstructions, saveRulesState, loadRulesBase, claudeRulesSession, codexRulesSession };
