# Fleet V5 contract tools

The native Fleet host installs the V5 contract capability when its computer
resolver is available. MCP exposes `fleet.contract.options`,
`fleet.contract.submit`, `fleet.contract.inspect`, `fleet.contract.amend`, and
`fleet.contract.cancel` only on that capability-backed host.

Write the job as task snippets, each with its completion contract and an
intention for every decision left to the worker:
[CONTRACT-SNIPPETS.md](CONTRACT-SNIPPETS.md) explains how, with a worked example.

## Submit

`fleet.contract.submit` accepts an `idempotencyKey` and a `contract` containing
`objective`, authorized `scope`, optional `rules`, `inputs`, `outputs`,
`checks`, `definitionOfDone`, `requirements`, exact `provider`, `model`,
`computerId`, canonical `productEffort` (or matching `userEffort` alias),
separate `vendorEffort`, `resourceLimits`, `constraints`, injected `policy`,
and optional `workforce`, `role`, `roles`, and `coordination`. A caller does not
supply a candidate ID, root node ID, or current Fleet control revision.
`expectedControlRevision` remains an optional compatibility precondition.

`resourceLimits.maxAgents` is enforced against the selected configuration's
agent ceiling. Adaptive workforce requests bind the ceiling and allowed roles
to the durable Fleet contract membership; `minimumAgents` and `roles` report
guaranteed initial members only. Unsupported resource limit dimensions refuse
before preparation.
Only complete currently eligible configurations are selectable. Unknown
outcome and cost estimates remain unknown; cost dimensions require explicit
policy weights and compatible observations. No vendor rates are inferred.

The operation prepares a stopped native worker, writes the ordinary Fleet job
with rules and checks, then resumes through Fleet's control path. Native
provider/account admission still runs at resume. Unconfirmed external outcomes
remain unknown and are inspected instead of replayed automatically.

## Options and baseline

`fleet.contract.options` returns schema, `baselineConfiguration`, and
`baselineConfigured`, plus a provider summary. Each provider names the account
Fleet will use, or null when that identity is unknown, then its models and
the allowed efforts for each model, whether a team (adaptive) contract is
possible, and the max agents. The full configuration list and its operational
supply metadata are included only when the request sets `detail` to true.
Candidate IDs are receipt join keys and are not returned. A sole current
candidate can serve as baseline. For a multi-candidate cold start, inject
`policy.baselineConfiguration` from an options result. Fleet resolves it to an
internal ID only after an exact, unique configuration match.

Options accepts the same configuration-affecting setup selectors as submit:
exact provider/model/computer and effort filters plus `role`, one guaranteed
root `roles` entry, `workforce`, `resourceLimits.maxAgents`, and
`coordination`. `detail` is a boolean and is not forwarded as a setup selector.
Workforce and resource ceilings must agree. These selectors
are resolved against whole configurations; discovery does not prepare a worker.
Unsupported resource dimensions refuse before catalog resolution.

The integrated adapter supports solo and adaptive native workforces on the
current local computer. Remote configurations remain discovery-only without a
native preparation route.

## Inspect, amend, cancel

`inspect` joins native job items to the current or archived task record by node
and task revision. Worker-reported completion, Fleet command verification, and
lead assessment are separate. Fleet-run commands can mark the contract
`verified`; only native lead assessment marks it `accepted`. Missing evidence
remains unknown. Verification rework, held work, job completion, and
cancellation retain the native Fleet states.

For a configured workforce, `workforceMembers` separately reports the currently
retained Fleet members' node ID, parent, state, turn, role, and provider. The
content-free `operationalObservation.workforce` projection returns aggregate
member, role, and state counts without member identifiers. Incomplete worker
snapshots leave membership unknown.

`amend` requires the contract revision. Rule changes use native `job-rule`;
objective or requirement changes append a marked follow-up that retains the
original scope and checks. Ambiguous amendment effects reconcile by marker and
are not duplicated. `cancel` closes through native `job-close`; this records
Fleet's hold/close semantics without claiming process rollback.

`resolves` on `answer` and `amend` names the open points an event settles. It
accepts an open point ID (`op-N`), the unit ID the point is on (such as
`objective:2` or `done:1`) or, for a composition, a requirement ID.

## Stored records

Fleet stores one contract record per idempotency key in memory namespace
`fleet.v5.contracts`. One stored value holds at most 32 KB, and a record grows
with worker reports, asks, events and the after view, so the record is split:

- The head keeps the record's identity and state.
- The review (`review.before`) is always stored apart.
- The largest other fields are stored apart while the head would still not fit.

Each part is stored as content-addressed pieces in `fleet.v5.contract-parts`
under `<record key>/<field>/<head revision>/<sha256>/<n>`:

- The pieces are written before the head and checked against their digest when
  read.
- An unchanged part keeps its pieces.
- Once a new head is saved, the pieces only the previous head named are
  overwritten with a small released marker, because the store has no
  single-key delete.

`inspect` returns the joined record, so open point IDs stay the ones the
submitted review gave. A record stored whole by an earlier build reads as
before. A missing or altered piece is refused with
`FLEET_V5_RECORD_PART_MISSING`.
