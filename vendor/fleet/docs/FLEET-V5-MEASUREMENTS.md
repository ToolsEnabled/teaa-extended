# Fleet V5 operational measurement projection

`src/lib/fleet-v5-measurements.js` exports the pure function
`projectOperationalObservation({ configuration, runtimeRevision, policyVersion,
contractId, usage, usageQuery, job, workers, verification, quota,
apiEquivalentEstimate, evaluatorVersion, taskRevision,
verificationTaskRevision })`.

The output is a new allowlisted value shaped for optimizer grouping and offline
analysis. It keeps supported configuration fields `provider`, `model`, `tier`,
the selected `runtimeRevision`, `agentCount`, `minimumAgents`, `roles`,
`coordination`, `workforce`, `productEffort`, and `vendorEffort`; it excludes
computer, account, worker, job, session, and other customer identifiers. Unknown
configuration properties and nested objects never survive projection. Native
`workforce` retains only `topology`, `rootRole`, `maxAgents`, `allowedRoles`, `providers`,
and `coordination.mode`. Unknown keys inside these recognized structures are
rejected rather than silently omitted. The grouping fingerprint hashes only
that projected configuration, `runtimeRevision`, and `policyVersion`; an
embedded selected runtime revision must match the top-level revision.

`usage` must be the native `usage-read` result. Pass the exact request as
`usageQuery`. A job read whose `id` matches `job.id` and whose returned rows
carry that job association is `job-scoped`. For a managed team, query
`{action:'usage-read', contractId:record.contractId, view:'full'}` and pass the
same `contractId` to the projector. It is used only for a local identity join
and is omitted from the output. Contract filtering includes root, child and
grandchild attempts with their original membership, regardless of job lane.
A complete, unnarrowed retained-contract read is `contract-scoped`; narrowed,
paged or archived reads are `contract-scoped-subset` and remain incomplete.
Other mismatches produce `unknown` attribution and null subtotals.
Each token category independently carries a
measured subtotal, measured/unknown attempt coverage, and completeness. A
measured zero remains `0`; absent data remains `null`. The projection consumes
the numeric categories produced by `fleet-usage-view` and never sums cache or
reasoning subsets into input/output totals a second time. Partial subtotals stay
incomplete when native lost, skipped, legacy, or child-unobserved coverage is
present.

Native submission captures contract membership once, or a solo root whose
objectiveRef matches its active job lane. Later task or membership changes do
not relabel a submitted turn. New attempts explicitly outside a managed
contract retain a null local contract tag; older records with no tag remain
unknown. `unattributedContractAttempts` reports that historical uncertainty
separately from the number of selected attempts. No historical membership is
inferred. A SQLite history wrapper with zero archived metric events preserves
the complete retained-contract scope; actual archived events limit completeness.
The external lead's usage remains outside the measured Fleet worker scope.

The `job` input is the native full `job-read` result. Its projection contains
only status/count summaries, worker-turn/failure counts, and durations derived
from observed timestamps. A complete native job item omits `failures` at zero;
that known omission is recorded as zero. Missing failure data in incomplete or
unrecognized records stays unknown. Paged job items or worker lists are incomplete unless
their native page reports offset zero and returned equals total. Supply either
the full worker list array or `{ items, page }`; paged or absent records cannot
claim complete topology, retry, outcome, or duration observations. Worker
topology uses native worker records internally and returns only count/depth,
never their identifiers. For a configured workforce, the `workforce`
projection counts nodes with the exact contract membership, requires a
complete worker list and the contract root, and reports member count,
guaranteed minimum, enforced maximum, role counts and state counts without
node IDs. Missing or incomplete membership remains unknown. Reported item outcomes
and native command verification are separate; `contractAcceptance` remains
`unknown`, even when Fleet commands pass. A verification preserves the native
Fleet `passed`/`failed` result when its source is `Fleet` (failed records need
not have the pass-only `verifiedBy`). Pass the selected task revision and the
revision attached to the verification read as `taskRevision` and
`verificationTaskRevision`; a mismatch or missing binding makes the checked
status `unknown` while retaining `observedStatus`. Missing revision inputs are
marked `unbound`. Worker-reported checks never become independent verification.

Provider-reported monetary values from usage views stay under
`reportedActualCosts` with their native session-unallocated scope. They are not
allocated to a job. `subscriptionQuota` is a separate optional caller-supplied
projection with an explicit subscription source and version; this module does
not query quota services or infer quota from usage. `apiEquivalentEstimate` is
also separate and requires an allowed estimator source, version, amount, and
currency. Missing cost, quota, or estimate remains unknown; none is treated as
free.

Contract-filtered reads and contract-bound projections omit unallocated session
charges; they cannot establish what fraction belongs to this contract.

The current codebase has no native subscription-quota reader or API-equivalent
price estimator schema. Their input shapes are intentionally explicit and
documented here; a caller must provide provenance. This module creates no
collector, network telemetry, aggregate store, or extra log.

Focused tests use real `createObservability` and `createFleetControl` usage/job
records. Run them with:

```sh
node --test tests/fleet-v5-measurements.test.js
```
