# FleetV2 control protocol

The standalone `fleetV2` profile adds `fleet.control`. Existing MCP definitions
retain the session role and permission checks. The root cannot discover or
invoke `agent_comms.send_local`; the retained tree also refuses that route if
called directly. Workers retain parent/child and automatically linked-peer
messaging. A peer link grants no lifecycle or folder authority.

In the V3 candidate, `{"action":"read"}` returns compact metadata for leads:
the current integer `revision`, `tasks`, `rules`, `asks`, history counts and
`pendingAsks`. Worker reads still return their complete assignment and asks.
Use `view:"full"` for retained bodies and history; `nodeId` and `status` scope
both views. An explicitly full unfiltered read retains the V2 response shape.
Use `offset` and `limit` for task pages, following `page.nextOffset` until null.
Pass the first page's `revision` as `expectedRevision` on later read pages;
an intervening edit refuses the read so the caller can restart the traversal.
Pagination changes delivery only: complete text and history remain retained.
Mutation receipts acknowledge only the changed record by default; `view:"full"`
requests the prior complete receipt. Every root mutation requires `expectedRevision` matching
the latest read. Concurrent edits with the same revision have one winner.

An assignment is keyed by the existing worker `nodeId`. A root pauses it with
`{"action":"pause","nodeId":"...","expectedRevision":1}` and edits with
`{"action":"task","nodeId":"...","text":"Revised assignment","expectedRevision":2}`.
Resume with the revision returned by the edit. Pause waits for native execution
quiescence, retires the old link token and fences queued actions. Resume reads
the current durable task/rules/answers; it cannot accept replacement instructions
through an ephemeral message. `stop` and `remove` use the same lifecycle path.

Ordinary task edits retain task identity. Set `newTask:true`, or replace a
completed assignment, to start a new task identity. With
`fleet.worker_reset_after_task` on, that new task starts a fresh provider
conversation. With it off, the conversation is retained. Rule/answer edits do
not require replacement task text. After answering an ask, read the new revision
and resume with `action: "resume"`, `nodeId` and `expectedRevision`; omit `text`
to keep the current assignment and saved conversation. Text supplied to this
control action creates a new task, so use it only for an actual replacement.

An unexpected resume failure returns `FLEET_RESUME_FAILED` with a diagnostic
reference instead of an unexplained internal error. Read current task/node state
before retrying. Sanitized exception type, message, stack and cause are retained
in `logs/fleet-errors.jsonl` under the capability state root. MCP errors expose
only the reference; the hub audit records its id and error code. Diagnostics do
not include tool arguments, environment values or credentials.

Rule/answer edits do not themselves reset the conversation. Workers report durable status with
`{"action":"progress","text":"..."}` or `{"action":"complete","text":"..."}`.
Completed tasks must be replaced before a resume or restart.

Workers file `{"action":"ask","id":"stable-id","question":"..."}`. Repeating
that exact id/question returns the retained record; changing the question under
the same id refuses. The root answers with `action:"answer"`, `id`, `answer` and
`expectedRevision`. Answering pauses an active questioner before committing.
Identical answer replay does not execute a worker or replenish any authority. Asks are bound to task identity; a new task supersedes old open questions and never receives earlier task answers. Task results and prior rule/task revisions remain in retained history. New asks also wake the root’s existing report wait with a generic notice; the durable record remains authoritative.
With `resume:true`, the answer is saved first and Fleet attempts one resume of
that task. The response contains `resume.resumed` and the host result or failure
reason. A durable attempt is saved before dispatch. Replaying an answer with
an existing attempt never dispatches again, even after a host restart or later
lead pause. A pending attempt means dispatch is unconfirmed, not that nothing
ran. Inspect the worker and use an explicit lifecycle action for recovery.
Completed, held, removed or superseded tasks never advance to another task as
a side effect of answering. A lane's conversation survives stop/resume and
host restart; a new unrelated task still follows the configured reset policy.
Shared rule edits require all workers paused. Resume explicitly adopts them.

A lane stacks an ordered workload on one tree worker. The root creates it with
`{"action":"lane","id":"docs","nodeId":"...","tasks":["First","Second"],"rules":{"scope":"..."},"expectedRevision":N}`.
Lane rules reach the lane worker and every worker below it, and nobody else.
The worker's durable task is always the lane's current task, so `read`,
`progress`, `complete`, asks and `resume` work as for any assignment. A running
worker is never interrupted: its first lane task starts at its next idle turn
boundary; a paused or stopped worker gets it at once and `resume` sends it.
When the worker reports `complete`, Fleet sends the next task as its next turn.
`lane-add` with `tasks` appends while the lane runs, and wakes a lane that had
finished. `lane-read` (or `job-read`) with `id` summarizes state, counts and the
current task; without `id` it lists every lane summary. Use `view:"full"` to
include complete task text, reports and hold reasons. `offset` and `limit`
select a page of items; a compact item page includes metadata and hold reasons.
Only an explicit `hold` with a reason or a `complete` report advances an active
task. Failed or uncertain turns pause the job, retain the assignment and record
`lastFailure`; earlier attempts remain in `failureHistory` in the full view.
Inspect existing artifacts and the failure before `job-resume` (alias
`lane-resume`). If the worker is stopped, resume it through the ordinary worker
lifecycle too. An uncertain send is never automatically retried.
Turns without new recorded progress retain the task and notify the lead once
per unchanged streak. Counters remain visible; progress clears the attention.
There is no implicit three-turn abandonment. An open ask on the current task
waits for its answer without spending turns. Each started, done or held task,
attention notice, paused job and finished job is posted to the root's report
inbox (`kind:"lane"`). `lane-rule`
edits lane rules while the lane's workers are paused. `lane-close` ends a lane;
its unstarted tasks stay listed as queued. A lane worker's task cannot be
replaced with `task` until its lane is closed. A worker enrolled in
`agent.continue` cannot take a lane until that run is disabled.

`settings-read` lists the pinned old setting ids, defaults, options and mapping.
`settings` writes validated `changes:{"setting.id":value}` after workers pause.
Current runtime values remain available through `settings.read`. Behavioral old
orchestration choices are retained as assignment policy; they are instructions,
not claimed OS enforcement. `import-settings` accepts an old id/value map,
imports supported controls and reports excluded ids with reasons. Remove any
credential values before making a tool call. The actual old resource preference
key `mc.resources.v1` accepts its JSON object or JSON string. Folder roots,
permission tier and provider approval mode cannot be changed through settings.

The exact old engine catalogue is retained in
`config/fleet-v2-settings-import.json` (103 entries, including original metadata).
The app-specific inventory identifies controls with no standalone UI equivalent
and records any remaining useful capability gaps separately.

Resource-aware starts use `resources-read`, `resources` with a `policy` object,
and `resource-advice`. The policy is the old `mc.resources.v1` shape: mode
`off|mechanical|controller|both`, `reserveBytes`, provider-specific
`providerBytes`, `maxConcurrentStarts`, CPU thresholds, normal/busy start
intervals, sample expiry and settling time. Defaults remain off. Mechanical
checks use native CPU/RAM observations and launch reservations. Controller mode
requires root advice containing `id`, `provider`, `decision:allow|hold`,
`launches`, and an `expiresAtMs` within sixty seconds; advice replay never refills
spent starts. The old admission core is used directly. These controls admit
starts; they do not terminate already-running workers or widen folder scope.

The operator changes parent folder policy through the local standalone CLI,
never model-selected setting values. The host checks the private revisioned
record before root lifecycle/control calls and every linked worker request,
and checks it every 500ms while running. A newer policy quiesces all descendants
before adoption. Worker file mediation also obtains the current authenticated
scope. Malformed/backward/revisionless policy changes refuse new work and pause
active workers on the watcher. A saved CLI policy receipt does not claim the
live host has already adopted it.

Saved worker action profiles use the actual old `mc.action-permissions.v1`
object (or JSON string) through `import-settings`, or `permission-profiles`
with `profiles`. `permission-profiles-read` returns the active profile document.
Profile inheritance, function allowlists and per-action modes apply to workers;
changes require workers paused. Authenticated worker MCP calls refresh that
policy before discovery/dispatch, and raw tree operations check it again.
The orchestrator retains its separate lifecycle authority. Headless workers
have no fabricated direct-user or inherited-user approval provenance.

`agent.status_injection` defaults off. On, automatic worker onboarding/resume
includes native CPU and memory measurements; the first CPU sample and unavailable
state/audit/backlog/quota measurements are explicitly unknown. Overrides retain
the old exact agent, lane, host precedence and fail closed if malformed.
`metrics.local_history` records private numeric lifecycle and token metadata
separately from provider traces. Root `metrics-read` supports `offset` and `limit`
(up to 1000). Off records nothing new and returns no saved-history rows; existing
records remain. Usage events must match the current generation, thread and turn.

`browser.agent_chrome_session_transfer` defaults true and controls availability
of explicitly authorized Chrome session transfer in the separately registered
ToolsEngine MCP. `toolsEngineMcpEnvironment(config)` in
`src/lib/fleet-v2-browser-settings.js` supplies `TOOLSENABLED_SETTINGS` pointing
at the actual `<stateRoot>/services/settings.json`. Configure that environment
on the separate ToolsEngine registration. It rereads the file for each transfer;
false refuses before source connection. This capability does not replace the
per-transfer user authorization.

The full pinned source inspection is
`docs/FLEET-V2-SETTINGS-APP-INVENTORY.json`. It preserves the audit snapshot and
adds a final integration resolution for fixes made after inspection. It includes
app settings rows, mounted panels, resource fields, setup controls and quick
sliders, with explicit standalone exclusions and behavioral-only limitations.


New standalone setups may explicitly select
`fleetV2Security:"inherited-environment"` without a `fleetV2Scope`. In this mode
Fleet starts in the terminal's physical working directory, inherits its existing
OS permissions and external sandbox, and adds no filesystem sandbox or scope
watcher. Relative host paths use that starting directory; byte mediation remains
available across OS-accessible paths. Fleet never elevates the process or removes
external restrictions. Existing protected runtime-state and credential-store
rules on Fleet's host tools remain in effect.

Saved declared-scope setups remain scoped when the ambient marker is absent.
The configuration rejects combining the ambient marker with declared roots;
opening an existing scoped setup never silently widens it. The scope-refresh
behavior described above applies to those declared-scope sessions. Durable
tasks, rules, Asks, lifecycle and peer messaging work in both modes.

## Retiring standing rules

A lead uses `r_ledger.withdraw` to retire an obsolete or mistaken R rule. Read
`ledger.read` first, then supply `actor`, the exact rule `id`, its exact
`scope` and `key` (omit key for global), the current `expectedRevision`, and a
`reason`. The server binds the actor and lead identity to the transport. A hub
records the attached orchestrator's name and a per-connection session identity.
Workers cannot use this operation; they ask their lead for maintenance.

Withdrawal marks the rule and all dotted refinements removed. It retains
original words, authorship, decisions, and the existing history, and appends the
lead's actor, identity and reason. Ordinary reads omit removed records; use
`removed:true` to inspect them. Future turns omit the withdrawn rules from
current rule delivery; earlier conversation history stays intact. Other rules
and job rules remain. Withdrawing a replacement does not reactivate the rule it
superseded. A repeat at the current revision returns `alreadyRemoved:true`
without another event. A stale revision or mismatched scope refuses before
publication.

A direct lead may use `fleetV2 serve --state-root ABS --actor PROVIDER
--ledger-only` to open only `ledger.read` and `r_ledger.withdraw` beside existing
workers. This does not open a tree, change saved configuration, or stop workers.
It refuses worker-linked startup. Keep worker environment markers intact;
clearing them to impersonate a lead is not supported. Existing MCP transports
need their normal next connection to advertise new tools; a running hub keeps
its current code until its lead schedules a normal upgrade.

Standalone Fleet keeps D3 lead-managed administration; non-Fleet editions keep
their existing person-only removal surface. Explicit native
ledger paths must be valid absolute paths (and `rootPath` must be a function
returning absolute paths); malformed configuration refuses instead of selecting
ambient state. Native store APIs trust the host caller and are not a supported
worker route to lead authority.

Writes use the existing ledger transaction and history protocol. An atomic
publication failure leaves the prior record intact. A history-append error can
follow durable record publication; that error is not success, and a repeat
refuses until history is checked/recovered through the existing supported path.
