# Fleet V5 computer and model resolution

`src/lib/fleet-v5-computers.js` exports catalog, resolution, and native adapter
functions:

- `buildComputerCatalog(snapshots)` accepts an explicit array of
  `{ id, runtimeRevision, choices }` snapshots. Each provider choice has a
  discovery `state` and the provider's rows from V4 `workerChoices`.
  Duplicate computer ids and malformed snapshots are rejected with structured
  error codes. The builder copies and freezes the records.
- `resolveComputerRequest(catalog, request)` resolves optional
  `computerId`, `provider`, exact `model`, and `effort`. It refuses
  ambiguous and mismatched requests. Its result includes the selected computer
  and runtime revision, catalog provenance, selection kind, and frozen
  `spawnArgs` (`tier`, `provider`, and any explicitly requested model or
  effort).

Catalog rows and model ids come from V4
`src/lib/agents/model-discovery.js` (`workerChoices`,
`listedSelection`, `modelRefusal`, and `effortRefusal`). A provider default
passes no model; a listed model is selected as
`<provider>/<exact model id>`; an explicit exact id can pass through only
where the source provider row permits pass-through. The resolver never
substitutes a model. Unknown and unreadable catalogs remain unknown, and
`launchability` is always `unknown`: native Fleet must revalidate machine
and account admission immediately before starting work.

`createFleetV5ComputerResolver({ env, accounts, tree, host, discoverSnapshots,
supplyPolicy, candidatePolicy, readObservations, hasActiveJob, ready, refresh })` returns
async `candidates({ contract })` and
`apply({ configuration, contract, candidateId, contractId? })` waits for an injected readiness promise/function and optional refresh callback before native preparation. Candidate discovery
returns `{ candidates, observations, eligible }` for Fleet's V5 selector;
each candidate has `id`, `configuration`, and `supply`. Snapshot discovery,
candidate supply, setup policy, observations, and
active-job checks can be injected. Provider model and effort options come only
from discovered provider rows; the adapter contains no model list or effort
formula. Missing outcome or cost evidence remains unknown; the adapter does
not add guessed outcome or cost fields to candidates. Candidate
candidate enumeration is complete and is not capped or truncated by this adapter or the V5 selector. An explicit provider constraint filters candidates to that provider; unsupported vendor effort rows are excluded. Foreign computers remain in discovery but are ineligible without a native preparation route.
Existing-worker selection requires current tree Fleet control state and fails
closed when it is unavailable. The resolver checks retained task and lane
state; an injected `hasActiveJob` callback can add a further refusal.
Without injected discovery, the local computer id comes from the retained machine
record (or its stable machine-id fallback), and runtime revision comes from
the current Fleet product identity/version. Ordinary candidate IDs are
`fleet-v5-` followed by the first 32 hexadecimal characters of SHA-256 over
serialized configuration. Managed Codex candidate IDs are deterministic opaque
digests that bind the selected account, default model,
authenticated catalog fingerprint and configuration without exposing the
account in candidate configuration or the ID. They remain stable for unchanged
selection data across resolver reconstruction. They are join keys only; native
service validation remains the authorization step.

Solo and adaptive native workforce setups are supported. A configuration's
`rootRole` is the role actually prepared; `roles` lists only guaranteed
initial members. Adaptive configurations expose `minimumAgents` and an
enforced `maxAgents` ceiling, with no exact `agentCount` claim. The separate
`workforce.allowedRoles` set is permission to add future descendants, not a
claim they already exist. Candidate identity sorts allowed-role/provider sets,
so their input order does not change the selected root or candidate ID.

The selector compares `maxAgents` against the enforceable ceiling. Its
`minAgents` and `requiredRoles` checks use only the guaranteed minimum and
initial `roles`. Native contract admission persists a per-contract membership
reservation on each retained Fleet node and shares it with descendants through
the existing worker assignment composition. The caller shape is
`workforce: { topology, rootRole, maxAgents, allowedRoles, providers, coordination }`.

Contract inspect currently retains the selection/configuration and reconciles
native job outcomes, but does not yet return actual workforce member IDs/states.
Those fields require the canonical contract-inspection integration; they are
not claimed by this native adapter contribution. Actual membership is available
from the native tree until that integration lands.

Task text comes from
`contract.objective`; optional
`contract.requirements`, `contract.tools`, `contract.contractRole`, and
`contract.role` flow through native preparation. An optional
`contract.productEffort` is canonical and remains separate from the candidate's
`vendorEffort`. `contract.userEffort` is an explicit alias; conflicting aliases
refuse before preparation. The ambiguous `contract.effort` field is not a
product-effort alias. An explicit `contract.model` can request a catalog model or
an exact provider pass-through where V4 permits it. A supplied
`contract.rootNodeId` can only select an existing stopped/paused direct child
whose provider/model/effort already match and which has no active Fleet task.
Existing worker configuration is never changed.

Native `host.prepareWorker` uses the host's normal validation, permission,
slot, role, and initial task persistence path for a new worker, then retains a
stopped node without calling the provider launcher. The resolver validates
existing workers for stopped state, exact configuration, no pending
configuration change, no queued work, and no active Fleet task/lane.
Native preparation is also invoked for existing workers and returns a reused
receipt only after checking retained task, lane, and queue state; it does not
retask or change them. The contract
layer can then persist its job, rules, and checks and call Fleet's normal resume
action. Native account
admission still runs at actual launch/resume. Public `spawn` has no deferred
start option and retains its existing first-turn behavior.

When the native host exposes `accountModelBindingVersion: 1`, managed Codex
discovery calls its zero-argument `accountModelCatalog()` capability, which
derives the currently selected account and reads its complete authenticated
catalog through Fleet's existing account service. Unknown, partial, stale or
refused results have no process-cache fallback. Exact visible model and effort
IDs become the existing V4 catalog rows; hidden models are omitted. Hosts
without the capability retain ordinary provider discovery. `apply` re-reads
catalog state and native root-only `prepareWorker` validates the exact account,
model and optional effort through the same account service before persisting a
prepared node. Public `spawn` cannot request this capability. Preparation does
not start a provider turn or alter the global account default; normal native
launch revalidates custody, identity, catalog and allowance before thread
admission. Saved conversations keep their retained account route when future
defaults change.

If exactly one eligible whole configuration matches the currently configured
native Codex account, exact model and effort, discovery marks it with
`baseline: true` and returns `baselineCandidateId`. It does not select the first
model or invent an effort. When native effort is unset, the baseline keeps
`vendorEffort` unset. `apply({ workspaceRoot })` forwards an optional
per-contract mapped workspace to native preparation and defaults to
`host.workspaceRoot`; this argument does not authorize that path or claim that
the current native implementation changes worker/check working directories.
Core workspace mapping owns that runtime meaning. A managed preparation receipt
contains execution-local `accountModelBinding` evidence from service validation;
this is not optimizer telemetry or provider completion evidence.

The adapter accepts `ready` (a promise or callback) and a `refresh` callback;
both finish before preparation. Production wiring must refresh the current
workspace scope before native preparation. `contractId` becomes the new
worker's `objectiveRef`. Explicit provider and computer selectors constrain
candidates. A catalog for another computer or runtime remains ineligible
without a native route; local preparation cannot claim remote execution.

Example integration:

```js
const { workerChoices } = require('./agents/model-discovery');
const { buildComputerCatalog, resolveComputerRequest } = require('./fleet-v5-computers');

const localChoices = workerChoices(registry, ['codex', 'claude']);
const catalog = buildComputerCatalog([{
  id: computerId,
  runtimeRevision,
  choices: Object.fromEntries(['codex', 'claude'].map(provider => [provider, {
    state: localChoices.lists[provider].state,
    reason: localChoices.lists[provider].reason,
    rows: localChoices.rows
  }]))
}]);
const selection = resolveComputerRequest(catalog, {
  computerId,
  provider: 'codex',
  model: 'exact-id-from-the-catalog'
});
// Pass selection.spawnArgs to native Fleet's existing admission/resolution
// path, and revalidate the selected computer before launch.
```

This module is a catalog and resolver seam. It does not implement a remote
adapter, network connection, provider launch, health probe, price estimate, or
availability claim. A future remote adapter must supply a stable computer id,
a runtime revision, explicit provider discovery snapshots with their state,
and an authenticated transport owned by its separate integration boundary.
No account files or credential values belong in this interface.
