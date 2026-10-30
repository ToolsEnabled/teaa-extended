'use strict';

/* A read-only catalog of execution destinations and their provider choices.
 * A snapshot says what a computer reports; it cannot prove that the computer
 * or account can launch. Native Fleet admission must revalidate at spawn time.
 */
const models = require('./agents/model-discovery');
const crypto = require('node:crypto');
const fs = require('node:fs');
const registryModule = require('./agents/registry');

function refusal(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function freezeRow(row) {
  return Object.freeze({ ...row,
    ...(Array.isArray(row.efforts) ? { efforts: Object.freeze([...row.efforts]) } : {}),
  });
}

function buildComputerCatalog(snapshots) {
  if (!Array.isArray(snapshots)) throw refusal('FLEET_V5_CATALOG_INVALID', 'Computer snapshots must be an array.');
  const seen = new Set();
  const computers = snapshots.map(snapshot => {
    if (!snapshot || typeof snapshot.id !== 'string' || !snapshot.id.trim()
        || typeof snapshot.runtimeRevision !== 'string' || !snapshot.runtimeRevision.trim()
        || !snapshot.choices || typeof snapshot.choices !== 'object' || Array.isArray(snapshot.choices)) {
      throw refusal('FLEET_V5_CATALOG_INVALID', 'Each snapshot needs a computer id, runtime revision, and provider choices.');
    }
    if (seen.has(snapshot.id)) throw refusal('FLEET_V5_DUPLICATE_COMPUTER', `Computer id "${snapshot.id}" occurs more than once.`);
    seen.add(snapshot.id);
    const choices = Object.create(null);
    for (const provider of Object.keys(snapshot.choices).sort()) {
      const source = snapshot.choices[provider];
      if (!source || typeof source.state !== 'string' || !['listed','no-list','not-found','unreadable'].includes(source.state)) {
        throw refusal('FLEET_V5_CATALOG_INVALID', `Catalog state for provider "${provider}" is invalid.`);
      }
      const rows = source.rows || {};
      const providerRows = Object.create(null);
      for (const [key, row] of Object.entries(rows)) {
        if (!row || row.provider !== provider) continue;
        providerRows[key] = freezeRow(row);
      }
      choices[provider] = Object.freeze({ state: source.state,
        reason: typeof source.reason === 'string' ? source.reason : null,
        rows: Object.freeze(providerRows) });
    }
    return Object.freeze({ id: snapshot.id, runtimeRevision: snapshot.runtimeRevision, choices: Object.freeze(choices) });
  }).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return Object.freeze({ computers: Object.freeze(computers) });
}

function resolveComputerRequest(catalog, request) {
  if (!catalog || !Array.isArray(catalog.computers) || !request || typeof request !== 'object'
      || Array.isArray(request) || ![Object.prototype, null].includes(Object.getPrototypeOf(request))) {
    throw refusal('FLEET_V5_REQUEST_INVALID', 'A catalog and request object are required.');
  }
  if (Object.keys(request).some(key => !['computerId', 'provider', 'model', 'effort'].includes(key))) {
    throw refusal('FLEET_V5_REQUEST_INVALID', 'Supported selectors are computerId, provider, model and effort.');
  }
  for (const field of ['computerId', 'provider', 'effort']) {
    if (request[field] !== undefined && (typeof request[field] !== 'string' || !request[field].trim())) {
      throw refusal('FLEET_V5_REQUEST_INVALID', `${field} must be nonempty text when supplied.`);
    }
  }
  if (request.model !== undefined) {
    const invalidModel = models.modelRefusal({}, { provider: '', passThrough: true }, request.model);
    if (invalidModel) throw refusal('FLEET_V5_MODEL_REFUSED', invalidModel);
  }
  const candidates = catalog.computers.filter(computer => request.computerId === undefined || computer.id === request.computerId);
  const matches = [];
  for (const computer of candidates) {
    const providerIds = request.provider === undefined ? Object.keys(computer.choices) : [request.provider];
    for (const provider of providerIds) {
      if (!Object.hasOwn(computer.choices, provider)) continue;
      const choice = computer.choices[provider];
      if (!choice) continue;
      if (request.model === undefined) {
        if (choice.rows[provider]) matches.push({ computer, provider, choice, row: choice.rows[provider], model: undefined, listed: false });
        continue;
      }
      const listed = models.listedSelection(choice.rows, provider, request.model);
      if (listed) matches.push({ computer, provider, choice, row: choice.rows[listed], model: request.model, listed: true });
      else if (choice.rows[provider] && choice.rows[provider].passThrough) matches.push({ computer, provider, choice, row: choice.rows[provider], model: request.model, listed: false });
    }
  }
  if (!matches.length) {
    if (request.computerId !== undefined && !candidates.length) throw refusal('FLEET_V5_COMPUTER_UNKNOWN', `Computer "${request.computerId}" is not in the catalog.`);
    const relevantChoices = candidates.flatMap(computer => Object.entries(computer.choices)
      .filter(([provider]) => request.provider === undefined || request.provider === provider)
      .map(([, choice]) => choice));
    if (request.model !== undefined && relevantChoices.some(choice => choice.state === 'unreadable' || choice.state === 'not-found')) {
      throw refusal('FLEET_V5_CATALOG_UNKNOWN', 'No readable catalog can confirm this model selection on the requested computer set.');
    }
    throw refusal('FLEET_V5_SELECTION_MISMATCH', 'No computer/provider choice matches the exact request.');
  }
  if (matches.length > 1) throw refusal('FLEET_V5_SELECTION_AMBIGUOUS', 'The request matches multiple computer/provider choices; specify computerId and provider.');
  const hit = matches[0];
  if (request.effort !== undefined) {
    const why = models.effortRefusal(hit.row, request.effort, hit.listed ? `${hit.provider}/${request.model}` : hit.provider);
    if (why) throw refusal('FLEET_V5_EFFORT_REFUSED', why);
  }
  const args = { tier: hit.listed ? `${hit.provider}/${request.model}` : hit.provider, provider: hit.provider };
  if (request.model !== undefined) args.model = request.model;
  if (request.effort !== undefined) args.effort = request.effort;
  return Object.freeze({ computer: hit.computer.id, runtimeRevision: hit.computer.runtimeRevision,
    provider: hit.provider, model: request.model === undefined ? null : request.model,
    selection: hit.listed ? 'listed' : request.model === undefined ? 'provider-default' : 'pass-through',
    catalogState: hit.choice.state, launchability: 'unknown',
    spawnArgs: Object.freeze(args),
    provenance: Object.freeze({ computerId: hit.computer.id, runtimeRevision: hit.computer.runtimeRevision,
      provider: hit.provider, catalogState: hit.choice.state }) });
}

function candidateKey(configuration) {
  return `fleet-v5-${crypto.createHash('sha256').update(JSON.stringify(configuration)).digest('hex').slice(0, 32)}`;
}

function localComputerIdentity(env) {
  try {
    const record = require('./setup/machine-record');
    const servicesRoot = record.resolveServicesRoot({ env });
    const saved = record.readMachineRecord({ servicesRoot, adopt: false });
    const identity = require('./product-identity').productIdentity(env);
    if (!identity.version) throw new Error(identity.versionError || 'the running Fleet product has no version');
    return Object.freeze({
      computerId: saved?.machine?.id || record.defaultMachineId(),
      runtimeRevision: `${identity.name}@${identity.version}`,
    });
  } catch (cause) {
    throw Object.assign(new Error('The local computer/runtime identity could not be read; inject stable computerId and runtimeRevision or repair the machine/runtime record.'), {
      code: 'FLEET_V5_LOCAL_IDENTITY_UNKNOWN', cause,
    });
  }
}

function controlState(tree) {
  return tree?.fleetControl ? tree : tree?.document?.fleetControl ? tree.document : null;
}

function managedCodexChoice(snapshot) {
  const catalog = snapshot?.catalog;
  const fingerprint = require('./fleet-v3-accounts').accountCatalogFingerprint(catalog);
  if (!fingerprint || fingerprint !== snapshot.catalogFingerprint)
    throw refusal('FLEET_V5_CATALOG_UNKNOWN', 'The selected managed Codex account catalog is stale, partial, or unavailable.');
  const rows = Object.create(null), ids = new Set(), modelsSeen = new Set();
  for (const entry of catalog.models) {
    if (typeof entry.id !== 'string' || typeof entry.model !== 'string' || typeof entry.hidden !== 'boolean'
        || models.modelRefusal({}, { provider: 'codex', passThrough: true }, entry.id)
        || models.modelRefusal({}, { provider: 'codex', passThrough: true }, entry.model)
        || ids.has(entry.id) || modelsSeen.has(entry.model))
      throw refusal('FLEET_V5_CATALOG_INVALID', 'The selected account catalog contains an invalid model row.');
    ids.add(entry.id); modelsSeen.add(entry.model);
    if (entry.efforts !== undefined && (!Array.isArray(entry.efforts)
        || entry.efforts.some(effort => typeof effort !== 'string' || models.effortRefusal({ provider: 'codex',
          listed: true, takesEffort: true, efforts: [effort] }, effort, entry.model))))
      throw refusal('FLEET_V5_CATALOG_INVALID', 'The selected account catalog contains invalid effort metadata.');
    if (entry.defaultEffort !== undefined && (typeof entry.defaultEffort !== 'string'
        || !/^[a-z][a-z0-9_-]{0,31}$/.test(entry.defaultEffort)
        || Array.isArray(entry.efforts) && !entry.efforts.includes(entry.defaultEffort)))
      throw refusal('FLEET_V5_CATALOG_INVALID', 'The selected account catalog contains invalid default-effort metadata.');
    rows[`codex/${entry.id}`] = { provider: 'codex', model: entry.model, listed: entry.hidden !== true,
      takesEffort: Array.isArray(entry.efforts) && entry.efforts.length > 0,
      ...(Array.isArray(entry.efforts) ? { efforts: [...entry.efforts] } : {}),
      ...(typeof entry.defaultEffort === 'string' ? { defaultEffort: entry.defaultEffort } : {}) };
  }
  return { state: 'listed', reason: null, rows,
    accountBinding: { account: snapshot.account, defaultModel: snapshot.defaultModel,
      catalogFingerprint: fingerprint } };
}

function createFleetV5ComputerResolver({
  env = process.env, accounts = null, tree = null, host, computerId: configuredComputerId, runtimeRevision: configuredRuntimeRevision,
  discoverSnapshots, candidatePolicy = () => ({ eligible: true }),
  supplyPolicy = () => true,
  readObservations = () => [],
  hasActiveJob, ready, refresh, authorizeWorkspace: authorizeNativeWorkspace,
} = {}) {
  if (!host || typeof host.rootSessionId !== 'string' || typeof host.workspaceRoot !== 'string'
      || typeof host.prepareWorker !== 'function' || typeof host.list !== 'function') {
    throw refusal('FLEET_V5_ADAPTER_INVALID', 'The native host must expose rootSessionId, workspaceRoot, list, and prepareWorker.');
  }
  function managedCandidateKey(binding, configuration) {
    const accountRef = crypto.createHash('sha256').update(binding.account).digest('hex');
    const identity = { configuration, supply: { accountRef, defaultModel: binding.defaultModel,
      catalogFingerprint: binding.catalogFingerprint } };
    return `fleet-v5-managed-${crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32)}`;
  }

  function localIdentity() {
    if (typeof configuredComputerId === 'string' && configuredComputerId
        && typeof configuredRuntimeRevision === 'string' && configuredRuntimeRevision) {
      return { computerId: configuredComputerId, runtimeRevision: configuredRuntimeRevision };
    }
    const detected = localComputerIdentity(env);
    return {
      computerId: configuredComputerId || detected.computerId,
      runtimeRevision: configuredRuntimeRevision || detected.runtimeRevision,
    };
  }

  function activeJob(nodeId) {
    const state = controlState(tree);
    if (!state) return true;
    const injected = typeof hasActiveJob === 'function' ? hasActiveJob(nodeId) : false;
    if (injected === true) return true;
    const task = state.fleetControl.tasks?.[nodeId];
    if (task && !['completed', 'held', 'removed'].includes(task.status)) return true;
    const lanes = Object.values(state.fleetControl.lanes || {}).filter(lane => lane.nodeId === nodeId);
    return lanes.some(lane => !['closed', 'removed'].includes(lane.state));
  }

  function assertSupportedSetup(contract, configuration) {
    const limits = contract?.resourceLimits;
    if (limits !== undefined) {
      if (!limits || typeof limits !== 'object' || Array.isArray(limits))
        throw refusal('FLEET_V5_RESOURCE_LIMIT_INVALID', 'resourceLimits must be an object.');
      const unsupported = Object.keys(limits).find(key => key !== 'maxAgents' && limits[key] !== undefined);
      if (unsupported) throw refusal('FLEET_V5_RESOURCE_LIMIT_UNSUPPORTED', `Resource limit "${unsupported}" is not enforced by native Fleet admission.`);
      if (limits.maxAgents !== undefined && (!Number.isSafeInteger(limits.maxAgents) || limits.maxAgents < 1))
        throw refusal('FLEET_V5_RESOURCE_LIMIT_INVALID', 'resourceLimits.maxAgents must be a positive safe integer.');
    }
    const workforce = contract?.workforce ?? configuration?.workforce;
    if (!workforce && contract?.resourceLimits?.maxAgents !== undefined) {
      if (!Number.isSafeInteger(contract.resourceLimits.maxAgents) || contract.resourceLimits.maxAgents < 1)
        throw refusal('FLEET_V5_RESOURCE_LIMIT_INVALID', 'resourceLimits.maxAgents must be a positive safe integer.');
    }
    if (workforce !== undefined) {
      const rootRole = contract?.role ?? workforce.rootRole ?? contract?.roles?.[0] ?? 'worker';
      if (contract?.role !== undefined && workforce.rootRole !== undefined && contract.role !== workforce.rootRole)
        throw refusal('FLEET_V5_WORKFORCE_ROOT_ROLE_REFUSED', 'contract.role and workforce.rootRole disagree.');
      if (contract?.roles !== undefined && (!Array.isArray(contract.roles) || contract.roles.length !== 1 || contract.roles[0] !== rootRole))
        throw refusal('FLEET_V5_SETUP_UNSUPPORTED', 'contract.roles may name only the guaranteed root role; use workforce.allowedRoles for descendant choices.');
      require('./fleet-v5-workforce').normalize({ ...workforce, rootRole }, { contractId: 'v5-preview-contract' });
      if (Array.isArray(contract?.setup?.agents) && contract.setup.agents.length !== 1
          || Array.isArray(contract?.agents) && contract.agents.length !== 1
          || Array.isArray(configuration?.setup?.agents) && configuration.setup.agents.length !== 1) {
        throw refusal('FLEET_V5_SETUP_UNSUPPORTED', 'Native workforce setup starts from one prepared Fleet root; descendants are added through native Fleet delegation.');
      }
      if (contract?.resourceLimits?.maxAgents !== undefined && contract.resourceLimits.maxAgents !== workforce.maxAgents)
        throw refusal('FLEET_V5_WORKFORCE_INVALID', 'resourceLimits.maxAgents and workforce.maxAgents must agree.');
      return { ...workforce, rootRole };
    }
    const contractAgents = contract?.setup?.agents ?? contract?.agents;
    const configuredAgents = configuration?.setup?.agents ?? configuration?.agents;
    if (Array.isArray(contractAgents) && contractAgents.length !== 1
        || Array.isArray(configuredAgents) && configuredAgents.length !== 1
        || contract?.agentCount !== undefined && contract.agentCount !== 1
        || configuration?.agentCount !== undefined && configuration.agentCount !== 1
        || Array.isArray(contract?.roles) && contract.roles.length !== 1
        || Array.isArray(configuration?.roles) && configuration.roles.length !== 1
        || contract?.coordination !== undefined || configuration?.coordination !== undefined) {
      throw refusal('FLEET_V5_SETUP_UNSUPPORTED', 'This adapter requires one Fleet root unless an explicit supported workforce policy is supplied.');
    }
    return null;
  }

  function accountModelRefusal(nodeId, configuration, binding = null) {
    if (configuration.provider !== 'codex') return null;
    const state = controlState(tree);
    const saved = nodeId ? state?.nodes?.find(node => node.nodeId === nodeId) : null;
    // Match native bindAccountRoute: retained conversations keep their route;
    // a new launch inherits the current default only when not already bound.
    const route = saved?.accountRouteProvider === 'codex' ? saved.accountRoute
      : saved?.threadId ? null : state?.fleetControl.accountDefaults?.codex;
    if (!route) return null;
    if (route.provider !== 'codex') return 'The retained native account route does not match this provider.';
    if (route.admission === 'ordinary-work' && configuration.model !== route.model && !binding)
      return 'The native account route pins a different explicit model; this configuration cannot use that route.';
    if (route.authentication === 'api-key' && typeof route.model === 'string'
        && configuration.model !== route.model && !binding)
      return 'The configured Codex API-key route pins a different requested model.';
    if (binding && saved && (saved.accountRoute?.account !== binding.account
        || saved.accountRoute?.model !== configuration.model
        || (saved.accountRoute?.effort ?? null) !== (configuration.vendorEffort ?? null)))
      return 'The saved worker is pinned to a different managed account.';
    return null;
  }

  async function snapshots() {
    let result;
    if (discoverSnapshots) result = await discoverSnapshots({ env, accounts, tree, host });
    else {
      const local = localIdentity();
      const registry = registryModule.activeRegistry(env);
      const ids = registryModule.workerAgentIds(registry);
      const discovery = models.workerChoices(registry, ids, { env });
      const choices = Object.fromEntries(ids.map(provider => [provider, {
        state: discovery.lists[provider].state,
        reason: discovery.lists[provider].reason,
        rows: discovery.rows,
      }]));
      result = [{ id: local.computerId, runtimeRevision: local.runtimeRevision, choices }];
    }
    const selected = controlState(tree)?.fleetControl.accountDefaults?.codex;
    if (!selected) return result;
    // API-key routes have no subscription account home to query. Keep ordinary
    // native discovery as the model source so requested models still require a
    // currently advertised provider catalog entry.
    if (selected.authentication === 'api-key') return result;
    if (host.accountModelBindingVersion !== 1 || typeof host.accountModelCatalog !== 'function') {
      if (selected.admission === 'ordinary-work')
        throw refusal('FLEET_V5_ACCOUNT_MODEL_BINDING_UNAVAILABLE', 'Authenticated exact-model catalog and native binding are unavailable for the selected ordinary-work Codex route.');
      return result;
    }
    const authenticated = await host.accountModelCatalog();
    if (authenticated.account !== selected.account || authenticated.defaultModel !== (selected.model ?? null))
      throw refusal('FLEET_V5_CATALOG_STALE', 'The selected managed Codex account route changed during discovery.');
    const choice = managedCodexChoice(authenticated);
    const local = localIdentity();
    let localSnapshot = result.find(snapshot => snapshot.id === local.computerId);
    if (!localSnapshot) {
      localSnapshot = { id: local.computerId, runtimeRevision: local.runtimeRevision, choices: {} };
      result = [...result, localSnapshot];
    }
    const choices = { ...localSnapshot.choices, codex: choice };
    result = result.map(snapshot => snapshot === localSnapshot ? { ...snapshot, choices } : snapshot);
    return result;
  }

  function configurationFor(computer, provider, row, effort, contract) {
    if (contract?.productEffort !== undefined && contract?.userEffort !== undefined
        && !require('node:util').isDeepStrictEqual(contract.productEffort, contract.userEffort)) {
      throw refusal('FLEET_V5_EFFORT_CONFLICT', 'productEffort and its userEffort alias disagree.');
    }
    const productEffort = contract?.productEffort !== undefined ? contract.productEffort : contract?.userEffort;
    let workforce = contract?.workforce;
    if (workforce && !workforce.providers.includes(provider)) return null;
    const resourceMax = contract?.resourceLimits?.maxAgents;
    if (resourceMax !== undefined && (!Number.isSafeInteger(resourceMax) || resourceMax < 1))
      throw refusal('FLEET_V5_RESOURCE_LIMIT_INVALID', 'resourceLimits.maxAgents must be a positive safe integer.');
    if (workforce && resourceMax !== undefined && workforce.maxAgents !== resourceMax)
      throw refusal('FLEET_V5_WORKFORCE_INVALID', 'resourceLimits.maxAgents and workforce.maxAgents must agree.');
    if (!workforce && resourceMax !== undefined) workforce = {
      topology: resourceMax === 1 ? 'solo' : 'adaptive', maxAgents: resourceMax,
      allowedRoles: Array.isArray(contract?.roles) ? [...contract.roles] : [contract?.role || 'worker'],
      rootRole: contract?.role || contract?.roles?.[0] || 'worker',
      providers: [provider], coordination: { mode: resourceMax === 1 ? 'none' : 'delegated' },
    };
    const requestedRootRole = contract?.role ?? workforce?.rootRole ?? contract?.roles?.[0] ?? 'worker';
    if (workforce) {
      const normalized = require('./fleet-v5-workforce').normalize({ ...workforce, rootRole: requestedRootRole },
        { contractId: 'v5-preview-contract' });
      workforce = { topology: normalized.topology, rootRole: normalized.rootRole,
        maxAgents: normalized.maxAgents, allowedRoles: [...normalized.allowedRoles],
        providers: [...normalized.providers], coordination: normalized.coordination };
    }
    if (!workforce && contract?.roles !== undefined
        && (!Array.isArray(contract.roles) || contract.roles.length !== 1 || contract.roles[0] !== requestedRootRole))
      throw refusal('FLEET_V5_SETUP_UNSUPPORTED', 'A non-workforce configuration must identify exactly one guaranteed root role.');
    return Object.freeze({
      computerId: computer.id,
      runtimeRevision: computer.runtimeRevision,
      provider,
      ...(workforce?.topology === 'adaptive' ? { minimumAgents: 1, maxAgents: workforce.maxAgents } : { agentCount: 1, maxAgents: workforce?.maxAgents ?? 1 }),
      rootRole: workforce?.rootRole ?? requestedRootRole,
      roles: [workforce?.rootRole ?? requestedRootRole],
      ...(workforce ? { workforce: structuredClone(workforce) } : {}),
      ...(workforce?.coordination !== undefined ? { coordination: workforce.coordination } : contract?.coordination !== undefined ? { coordination: contract.coordination } : {}),
      ...(productEffort !== undefined ? { productEffort } : {}),
      ...(row.selectedModel !== undefined ? { model: row.selectedModel } : row.listed ? { model: row.model } : {}),
      ...(effort !== undefined ? { vendorEffort: effort } : {}),
      ...(contract?.rootNodeId ? { rootNodeId: contract.rootNodeId } : {}),
    });
  }

  async function collectCandidates(contract) {
    assertSupportedSetup(contract);
    const discovered = await snapshots();
    const accountBindings = new Map();
    for (const snapshot of discovered) for (const [provider, choice] of Object.entries(snapshot.choices || {}))
      if (choice.accountBinding) accountBindings.set(`${snapshot.id}\0${provider}`, choice.accountBinding);
    const catalog = buildComputerCatalog(discovered);
    const local = localIdentity();
    const rootNodeId = contract?.rootNodeId || null;
    const existing = rootNodeId ? host.list().find(node => node.nodeId === rootNodeId) : null;
    if (rootNodeId && !existing) throw refusal('FLEET_V5_WORKER_UNKNOWN', 'The requested existing worker is not in this tree.');
    const requestedModel = contract?.model ?? contract?.configuration?.model;
    const requestedProvider = contract?.provider ?? contract?.configuration?.provider;
    const requestedComputer = contract?.computerId ?? contract?.configuration?.computerId;
    const choices = [];
    const bindingByCandidateId = new Map();
    for (const computer of catalog.computers) {
      if (requestedComputer !== undefined && computer.id !== requestedComputer) continue;
      for (const [provider, choice] of Object.entries(computer.choices)) {
        if (requestedProvider !== undefined && provider !== requestedProvider) continue;
        for (const [key, row] of Object.entries(choice.rows)) {
          if (row.provider !== provider || !(key === provider && row.providerDefault || row.listed)) continue;
          if (requestedModel !== undefined && (row.listed ? row.model !== requestedModel : !row.passThrough)) continue;
          const selectedModel = !row.listed && requestedModel !== undefined ? requestedModel : undefined;
          const selectedRow = selectedModel === undefined ? row : { ...row, selectedModel };
          const requestedEffort = contract?.vendorEffort;
          if (requestedEffort !== undefined) {
            const effortWhy = models.effortRefusal(row, requestedEffort,
              row.listed ? `${provider}/${row.model}` : provider);
            if (effortWhy) continue;
          }
          const efforts = requestedEffort !== undefined ? [requestedEffort]
            : Array.isArray(row.efforts) ? [...new Set([undefined, ...row.efforts])] : [undefined];
          for (const effort of efforts) {
            const configuration = configurationFor(computer, provider, selectedRow, effort, contract);
            if (!configuration) continue;
            const accountBinding = provider === 'codex' ? accountBindings.get(`${computer.id}\0${provider}`) || null : null;
            if (rootNodeId && (computer.id !== local.computerId
                || !['paused', 'stopped'].includes(existing.state) || existing.turn === 'running'
                || ['provider', 'model', 'effort'].some(field => Object.hasOwn(existing.pending || {}, field))
                || existing.parentNodeId !== null || existing.provider !== provider
                || existing.role !== configuration.rootRole
                || (existing.model ?? '') !== (selectedRow.listed ? selectedRow.model : selectedRow.selectedModel ?? '')
                || (existing.effort ?? null) !== (effort ?? null) || (existing.queue?.length || 0) > 0
                || activeJob(existing.nodeId))) continue;
            if (!supplyPolicy({ contract, computer, provider, row: selectedRow, effort, configuration })) continue;
            const policy = candidatePolicy({ contract, computer, provider, row: selectedRow, effort, configuration });
            const hasNativeRoute = computer.id === local.computerId && computer.runtimeRevision === local.runtimeRevision;
            const accountWhy = accountModelRefusal(rootNodeId, configuration, accountBinding);
            const eligibility = !hasNativeRoute ? { eligible: false, reason: 'No native preparation route exists for this computer.' }
              : accountWhy ? { eligible: false, reason: accountWhy }
              : policy === false ? { eligible: false, reason: 'Candidate policy refused this setup.' }
              : policy && typeof policy === 'object' ? policy : { eligible: true };
            const id = accountBinding ? managedCandidateKey(accountBinding, configuration) : candidateKey(configuration);
            if (accountBinding) bindingByCandidateId.set(id, accountBinding);
            choices.push(Object.freeze({
              candidateId: id,
              configuration,
              eligible: eligibility.eligible !== false,
              ...(eligibility.reason ? { reason: String(eligibility.reason) } : {}),
            }));
          }
        }
      }
    }
    const eligible = new Map(choices.map(candidate => [candidate.candidateId, candidate.eligible]));
    const observations = readObservations({ contract, candidates: choices }) ?? [];
    if (!Array.isArray(observations)) throw refusal('FLEET_V5_OBSERVATIONS_INVALID', 'Outcome observations must be supplied as an array.');
    const selectedDefault = controlState(tree)?.fleetControl.accountDefaults?.codex;
    const baselineMatches = selectedDefault?.provider === 'codex' && selectedDefault.admission === 'ordinary-work'
      && typeof selectedDefault.account === 'string' && typeof selectedDefault.model === 'string'
      ? choices.filter(candidate => candidate.eligible && candidate.configuration.provider === 'codex'
        && candidate.configuration.model === selectedDefault.model
        && (candidate.configuration.vendorEffort ?? null) === (selectedDefault.effort ?? null)
        && bindingByCandidateId.get(candidate.candidateId)?.account === selectedDefault.account) : [];
    const baselineCandidateId = baselineMatches.length === 1 ? baselineMatches[0].candidateId : null;
    const result = Object.freeze({
      candidates: Object.freeze(choices.map(candidate => Object.freeze({
        id: candidate.candidateId,
        configuration: candidate.configuration,
        supply: Object.freeze({ computerId: candidate.configuration.computerId,
          runtimeRevision: candidate.configuration.runtimeRevision }),
        ...(candidate.candidateId === baselineCandidateId ? { baseline: true } : {}),
        ...(candidate.reason ? { reason: candidate.reason } : {}),
      }))),
      observations: Object.freeze([...observations]),
      ...(baselineCandidateId ? { baselineCandidateId } : {}),
      eligible(candidate) { return eligible.get(candidate?.id) === true; },
    });
    return { result, bindingByCandidateId };
  }

  async function candidates({ contract } = {}) {
    return (await collectCandidates(contract)).result;
  }

  async function apply({ configuration, contract, candidateId, contractId, workspaceRoot } = {}) {
    assertSupportedSetup(contract, configuration);
    if (typeof ready === 'function') await ready();
    else if (ready) await ready;
    if (typeof refresh === 'function') await refresh();
    const { result: available, bindingByCandidateId } = await collectCandidates(contract);
    const selected = available.candidates.find(candidate => candidate.id === candidateId);
    if (!selected || available.eligible(selected) !== true) throw refusal('FLEET_V5_CANDIDATE_STALE', 'The selected candidate is no longer available under current discovery and setup policy.');
    if (configuration && JSON.stringify(configuration) !== JSON.stringify(selected.configuration)) {
      throw refusal('FLEET_V5_CONFIGURATION_STALE', 'The selected configuration differs from the current candidate.');
    }
    const currentBinding = bindingByCandidateId.get(selected.id) || null;
    const picked = selected.configuration;
    const effectiveWorkforce = picked.workforce;
    const resolved = resolveComputerRequest(buildComputerCatalog(await snapshots()), {
      computerId: picked.computerId,
      provider: picked.provider,
      ...(Object.hasOwn(picked, 'model') ? { model: picked.model } : {}),
      ...(Object.hasOwn(picked, 'vendorEffort') ? { effort: picked.vendorEffort } : {}),
    });
    if (resolved.runtimeRevision !== picked.runtimeRevision) {
      throw refusal('FLEET_V5_CONFIGURATION_STALE', 'The computer runtime changed during resolution; no worker was prepared.');
    }
    const brief = contract?.objective;
    if (typeof brief !== 'string' || !brief.trim()) throw refusal('FLEET_V5_CONTRACT_INVALID', 'A non-empty contract assignment is required before worker preparation.');
    let native;
    const preparedWorkspace = workspaceRoot ?? (contract?.scope && typeof contract.scope === 'object' ? contract.scope.folder : host.workspaceRoot);
    const rootNodeId = picked.rootNodeId;
    if (rootNodeId) {
      const existing = host.list().find(node => node.nodeId === rootNodeId);
      if (!existing || existing.parentNodeId !== null || !['paused', 'stopped'].includes(existing.state)
          || existing.turn === 'running' || ['provider', 'model', 'effort'].some(field => Object.hasOwn(existing.pending || {}, field))
          || existing.provider !== resolved.provider || (existing.model ?? '') !== (resolved.model ?? '')
          || !picked.roles?.includes(existing.role)
          || (Object.hasOwn(resolved.spawnArgs, 'effort') ? resolved.spawnArgs.effort : null) !== (existing.effort ?? null)
          || (existing.queue?.length || 0) > 0
          || activeJob(existing.nodeId)) {
        throw refusal('FLEET_V5_WORKER_INCOMPATIBLE', 'The requested existing worker is missing, active, busy, or has a different provider/model/effort; it was not changed.');
      }
      native = await host.prepareWorker({
        rootNodeId,
        parentSessionId: host.rootSessionId,
        workspaceRoot: preparedWorkspace,
        tier: resolved.spawnArgs.tier,
        provider: resolved.provider,
        ...(Object.hasOwn(resolved.spawnArgs, 'model') ? { model: resolved.spawnArgs.model } : {}),
        ...(Object.hasOwn(resolved.spawnArgs, 'effort') ? { effort: resolved.spawnArgs.effort } : {}),
        role: picked.rootRole,
        ...(effectiveWorkforce ? { objectiveRef: contractId, workforce: effectiveWorkforce } : {}),
      });
    } else {
      native = await host.prepareWorker({
        parentSessionId: host.rootSessionId,
        workspaceRoot: preparedWorkspace,
        tier: currentBinding ? 'codex' : resolved.spawnArgs.tier,
        provider: resolved.spawnArgs.provider,
        ...(Object.hasOwn(resolved.spawnArgs, 'model') ? { model: resolved.spawnArgs.model } : {}),
        ...(Object.hasOwn(resolved.spawnArgs, 'effort') ? { effort: resolved.spawnArgs.effort } : {}),
        ...(currentBinding ? { bindAccountModel: true, expectedAccount: currentBinding.account,
          expectedDefaultModel: currentBinding.defaultModel, expectedCatalogFingerprint: currentBinding.catalogFingerprint } : {}),
        ...(typeof contractId === 'string' && contractId ? { objectiveRef: contractId } : {}),
        ...(effectiveWorkforce ? { workforce: effectiveWorkforce } : {}),
        ...(contract?.resourceLimits ? { resourceLimits: contract.resourceLimits } : {}),
        brief,
        role: picked.rootRole,
        ...(contract?.requirements ? { requirements: contract.requirements } : {}),
        ...(contract?.tools ? { tools: contract.tools } : {}),
        ...(contract?.contractRole ? { contractRole: contract.contractRole } : {}),
      });
    }
    const expectedModel = rootNodeId ? existingModel(host, rootNodeId) : (resolved.model ?? '');
    if (!native?.nodeId || native.provider !== resolved.provider
        || (native.model ?? '') !== (expectedModel ?? '')
        || native.prepared !== true) {
      throw refusal('FLEET_V5_PREPARE_UNVERIFIED', 'Native Fleet did not confirm the requested worker identity and prepared state.');
    }
    return Object.freeze({ eligible: true, configuration: picked, nodeId: native.nodeId, prepared: true,
      nativeReceipt: native, productEffort: picked.productEffort ?? null, vendorEffort: picked.vendorEffort ?? null });
  }

  async function authorizeWorkspace(folder) {
    if (typeof ready === 'function') await ready();
    else if (ready) await ready;
    if (typeof refresh === 'function') await refresh();
    if (typeof authorizeNativeWorkspace === 'function') return authorizeNativeWorkspace(folder);
    if (typeof folder !== 'string' || !require('node:path').isAbsolute(folder) || folder !== host.workspaceRoot) return null;
    try {
      if (fs.realpathSync(folder) !== folder) return null;
    } catch { return null; }
    return folder;
  }

  return Object.freeze({ candidates, apply, authorizeWorkspace });
}

function existingModel(host, nodeId) {
  return host.list().find(node => node.nodeId === nodeId)?.model ?? '';
}

module.exports = Object.freeze({ buildComputerCatalog, resolveComputerRequest, createFleetV5ComputerResolver });
