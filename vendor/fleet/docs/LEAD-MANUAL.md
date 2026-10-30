# Fleet lead manual

This manual is for the lead: the agent the person talks to, which spawns and
coordinates workers through Fleet. It ships with Fleet (and with TEAA, which
bundles Fleet), is the same for every user, and changes only when the program
changes. Fleet hands it to every lead connection in the MCP server
instructions. Workers do not receive it. The person's own rules and briefs
come on top of this manual and are not part of it.

Start with the [lead quickstart](LEAD-QUICKSTART.md) for an executable website
contract, verified delivery, recurring business work and the few lead interventions.

## Worker levels

Fleet workers launch at level 4 (bypassed) by default, independently of the
lead's launcher name or CLI flags. They do not ask for approval. An administrator can
set `TOOLSENABLED_WORKER_LEVEL` to 1, 2, 3 or 4 in Fleet's environment to lower
this default; other nonempty values refuse worker startup. `TOOLSENABLED_LEVEL_CAP`
still lowers the result. Roles and ancestor worker ceilings can lower it further;
no worker level exceeds 4. Native CLI settings and OS restrictions still apply.
A permission request that remains unavailable is declined and reported.

Fleet admits leads using local OS user identity, its private local socket and
session token, and the verified serve/call entry for this runtime. Launcher
names, resolved agent executables and CLI permission flags do not set Fleet
permissions. Lead levels default to 4 within TOOLSENABLED_LEVEL_CAP; worker
levels also honor TOOLSENABLED_WORKER_LEVEL and role ceilings. The former
TOOLSENABLED_HUB_STRICT_LEVEL setting has no effect.


## Nodes

- Lead `fleet.control` reads are compact by default. Use `nodeId` for the
  worker you need; request `view: "full"` for assignment text or history.
  Job reads summarize counts and current work. Request full item details only
  when needed, with `offset` and `limit` for a page. Follow `nextOffset` until
  it is null; carry `revision` as `expectedRevision` across read pages so a
  changed workload cannot silently mix two snapshots. Mutation receipts
  acknowledge the changed record without repeating the whole tree.
- Supply the read's `expectedRevision` for lead edits. In V3, single-worker
  `task`, `pause`, `stop`, `resume`, `answer` and `assess` use target scope by
  default: sibling reports and independent edits do not require another read.
  Other supported worker, Ask or job edits can opt in with `revisionScope: "target"`.
  Changes to the target, its ancestor job context, or shared rules/settings
  still refuse. Use `revisionScope: "global"` for a decision based on the whole tree.
  Shared edits, subtree actions and paged reads use strict global revisions.
  This is a control-record concurrency check, not a snapshot of external
  files or provider state; normal lifecycle and task-identity checks remain.
- Before you spawn a worker, check whether an existing node already holds the
  context for the work. If one does, give it the task and resume it
  (`agent.resume` with an assignment, or a `fleet.control` task edit followed
  by resume). For a follow-up, use `task` with `keepConversation: true` to keep
  the provider thread even when reset-after-task is enabled. A completed or
  held plain task reopens without a pause and reaches a running worker at its
  next idle turn boundary. Paused or stopped workers still need an explicit
  resume. This option applies to that task edit; omit it to retain the normal
  reset behavior. A verifying task keeps its completion and checks; wait for
  verification before assigning this follow-up. To correct a live worker's
  current open assignment, edit its task without `newTask`: the worker keeps its current turn and gets the new
  text at its next turn; until it has seen the correction it cannot complete
  or hold the task. Replacing unfinished live work, or editing a finished
  task without `keepConversation`, requires the worker to be paused
  (`fleet.control` action `pause`) or stopped first; then edit its task
  and resume it. A fresh spawn starts with none of that context. `agent.spawn` reports matching
  paused/stopped conversations as `reuseCandidates`; prefer resuming them.
- For non-delegating workers, Fleet subtracts named lifecycle, memory, search,
  audit, ledger, system and settings tools from the admitted surface. All other
  tools stay available, including task and workspace tools and extension tools.
  Delegating roles keep their admitted surface. If subtraction would leave no
  tools, Fleet keeps the admitted surface. Pass `tools: "all"` to preserve the
  full surface, or `tools: ["memory.get"]` to keep specific exact tools too.
  These selections remain capped by the parent, saved role, permission level
  and direct-user authorization policy; they cannot grant new access.
- A node with no live work is resumed with a task, stopped (`agent.stop`
  keeps its conversation for later reuse), or removed. `agent.remove`
  permanently deletes the node and its conversation; remove it only when
  nothing in it will be needed again and the person's rules permit deletion.
- An open assignment continues by itself. When a worker's turn ends and its
  plain task is still assigned, Fleet sends the next turn at the idle turn
  boundary, as it does for a job. It stops when the worker completes or holds
  the task, files an ask, has a failed turn, or after 3 automatic turns that
  record no new progress; Fleet then sends you a notice and the task stays
  assigned. Short unfinished turns are spaced out (30 seconds, doubling to
  15 minutes), and a worker can hold automatic turns while it waits with
  `waitSeconds` on its progress. Do not stop and resume a worker only to keep
  it going. Set
  `autoContinue: false` on a task edit when a worker must wait for you after
  each turn.
- Never leave a node in state `running` with no turn in progress for hours.
  If its turn ended, its process died or it is waiting on something that will
  not come, pause or stop it; then resume it with the current task, or remove
  it under the conditions above.
- Answering a worker's ask (`fleet.control` action `answer`) records the
  answer and resumes the asker by default. Set `resume: false` to record the
  answer and keep the asker paused. For a verifying task, the answer is saved
  without pausing or resuming the worker. Inspect `resume.resumed` and the reason
  on failure. Fleet retains the resume
  attempt, so replaying an answer cannot undo a later pause or dispatch twice.
  For a failed or unconfirmed attempt, inspect the worker and recover through
  the explicit lifecycle action; do not keep replaying the answer.
- Scale the team to the job. Every node costs the person usage and attention,
  so use one worker for one focused task and add workers only for parts that
  really run in parallel.

## Assignments and outcomes

Use task text or the spawn contract to state the objective. Optional
`requirements` on `agent.spawn` or `fleet.control` task/resume describe input
references, the worker's ownership scope, output IDs and acceptance checks.
They reach the first worker turn and remain with its result. For queued jobs,
use `workItems: [{text, requirements}]` instead of `tasks` when items need
structured requirements. Choose references and checks specific enough for the
selected worker model to act without guessing. Ownership scope is task data,
not a change to filesystem permissions.

For recurring work, create a job normally, then call `fleet.control` with
`action: "job-schedule"`, its `id`, current `expectedRevision`, and `schedule`.
Use `{every: N, unit: "minutes"}` (or `"hours"`, `"days"`), or
`{dailyUtc: "09:00"}` for a daily UTC time. For example:

```json
{"action":"job-schedule","id":"daily-operations","expectedRevision":12,"schedule":{"dailyUtc":"09:00"}}
```

The template defaults to the job's original tasks; optional `tasks` or
`workItems` on `job-schedule` replaces that recurring template. The original
job runs immediately as usual. Intervals first fall due N units after schedule
configuration; daily times first fall due at the next occurrence. Fleet
checks schedules on its worker watch (normally every five seconds), appends
one due run, and delivers it at the worker's next idle turn boundary. Existing
active or queued work skips that occurrence with reason `previous run still
active`; a paused job records `job paused`. Schedules never start or resume
workers. After downtime, older occurrences are counted as skipped and at most
one current run is queued, so there is no catch-up backlog. Timing, templates,
run counts and skipped-run reasons survive Fleet restarts. `job-read` shows
`schedule.nextDueAt`, `schedule.skippedRuns`, and the latest skip; `view: "full"`
includes every skip record (a record may count several missed occurrences).
Set `schedule: null` with `job-schedule` to turn future runs off while keeping
already queued work and history. Closing a job also disables its schedule.

A worker's complete call records reported completion. For executable checks,
set `requirements.checks: [{id, description, command, timeoutSeconds}]` on spawn,
task/resume, or a job work item. Only the lead may set check commands or timeouts.
Workers may give their own children evidence-only requirements; they cannot add
or change commands. Timeout defaults to 600 seconds, with a maximum of 3600. Commands are visible in the assignment for the worker to run first.
Complete returns promptly with status `verifying`; the host runs commands
serially with inherited environment in the contract target when it is a folder,
otherwise the assignment's `Starting directory:`, falling back to the Fleet
workspace. Relative targets resolve from that starting directory. File or glob
targets use the starting directory. It retains exit code, duration, timeout and
the last 8192 bytes of combined output per check. All pass: `completed`, verification passed and verified by Fleet. Any
fail: `assigned` with automatic rework naming each failing check and output
tail. After 3 failed verifications, or with assignment or host continuation off,
the task is held with evidence. Compact reads and `agent.wait` include results.
A host restart reruns all commands for a task still verifying: choose repeatable
checks. Fleet verification establishes that these commands passed; other worker
evidence still requires assessment. Compact reads show reported check outcomes, missing outputs or
checks, and whether the lead has assessed the result. Full reads retain the
submission and evidence. Job counts describe execution; the separate outcomes
counts describe reporting and assessment.

When you have checked a result, you may record that decision with action
`assess`, nodeId, the exact `expectedTaskRevision`, current `expectedRevision`,
and `assessment: {decision, note, evidence}`. Decision is accepted, rework or
rejected; evidence is a nonempty list of `{id, reference, description?}`.
This records your judgment and its basis; assessment does not execute checks
or certify your claim. Executable requirement checks run separately on
completion. Assessments can target a retained task after its worker has moved
on. Revisions preserve earlier judgments. This optional record
neither creates a review round nor delays queue advancement. Rework still
needs an explicit assignment; an assessment does not launch a worker.

Job recovery preserves unfinished work. A failed or uncertain provider turn
pauses its job with `lastFailure` and leaves the item active. Inspect the saved
conversation and existing artifacts, then use `job-resume`; if the worker is
stopped, resume that worker as well. Missing progress produces attention and
counters without discarding the task or silently imposing a turn limit. Use
that evidence to refine the assignment, resolve an Ask, or stop unproductive
work. Explicit `agent.continue` maxTurns limits still apply when requested.


## Usage

`fleet.control` action `usage-read` shows retained worker attempts and measured
token subtotals, including failures. Filter by `nodeId` or job `id`; full views
page with `expectedMetricsRevision`, independent of the control revision.
Check completeness and unknown counts before comparing totals. External lead
usage is not observed here, and session cost reports are not job costs. See
`docs/FLEET-V3-USAGE.md` for provider semantics and measurement limits.

## Rules

- Every rule in Fleet is an agent rule filed by a lead and that lead's job to
  fix. If it blocks the only working route, the filing lead fixes or replaces
  it in the same turn (refine it with a child rule using `parent`, or replace
  it with `supersedes`, or retire it with `r_ledger.withdraw` using the
  current ledger revision and exact scope/key). Withdrawal keeps the original
  words, authorship and lead-attributed history. Rules stack per job and are the variable layer.
  There is no owner-rule category or approval wait for a lead's filing.
  `ownerQuote` is optional provenance text; it never makes a rule uneditable.
  The person's authority lives outside Fleet in their own Markdown files and
  knowledge briefs. Read and follow those instructions; an agent rule cannot
  change the person's decisions.
- Add no new gates: no rule, review round, approval step or waiting step that
  can stall running work. Fixing a broken rule is required and does not count
  as a new gate.
- Before you file a rule that records the person's own wording, repeat that
  wording back to the person and ask directly whether it is right. File it
  only after the person confirms.

## Blockers

Refusals and answer-resume skips retain their code and reason and give a `Next:`
recovery instruction. Follow it before retrying. If a notice cannot be built or
delivered, compact/full reads retain `lastNoticeError` with its node, status,
stage, time and reason; the task result remains authoritative. A failed or
unconfirmed lifecycle call is not evidence that the worker stopped or resumed.

- If a blocker is within your authority, fix it yourself instead of filing it
  and waiting. Ask only for decisions that really belong to someone else, ask
  once, and include your recommendation.
- Credentials never stall work. If a sign-in needs the person's physical
  touch (a hardware key, a phone prompt), ask for it once and keep doing
  every part of the work that does not depend on it. Never print or copy a
  credential value.
- A check you would repeat (polling, waiting, status collection, per-item
  verification) is a script that runs on its own and reports the exceptions.
  It is never an agent doing the check by hand turn after turn.

## Reporting

- Report from artifacts: exit codes, test counts, files and their hashes,
  log lines. Never report from impressions. A check that could not run is
  reported as "could not be checked", never as passed.
- Read the person's knowledge briefs for the work before you act. If there is
  no brief for the work, write one, so the next session starts from what is
  known rather than from nothing.

### Recent history and durable pages on SQLite hubs

SQLite hubs keep current work and a bounded window of recent evidence in the
live tree. Older evidence moves into indexed `history` rows in the **same**
`tree.sqlite3`, in the transaction that removes its live copy. Back up that
whole database with SQLite's backup mechanism; copying only the live `records`
table omits older evidence. The writable store upgrades schema version 1 to 2
in place; older binaries refuse version 2 rather than treating it as a complete
version 1 tree.

The live windows are 100–200 finished items **per job**, 500–1,000 retired
tasks, reports and delivered inbox entries, 1,000–2,000 metric events, and
100–200 entries per rule, failure or skip history. A window rolls when it
exceeds twice its lower bound, retaining its newest lower-bound entries.
Unfinished job items and unread inbox entries stay live. Current assignments
are never moved to the archive: open or verifying tasks, pending conversation
follow-ups, wait deadlines, current verification and its full attempt history
remain in the live task record. The latest notices remain in the recent inbox
window, and the latest notice delivery error stays in the control record.
These windows bound ordinary completed history, not the person's outstanding
workload.

`read` returns exact `historyCounts`; `job-read` returns exact lifetime counts
and outcome counts, its current item, schedule counters and recent evidence.
An explicit `job-read` item page spans archived and live items, oldest first:

```json
{"action":"job-read","id":"daily-operations","view":"full","offset":0,"limit":20}
```

For any evidence stream, use `history-read`. Kinds are `items`, `tasks`,
`reports`, `metrics`, `skips`, `rules`, `failures` and `inbox`. Give `id` for a
job's items, skips, rules or failures; omit it for tree-wide streams:

```json
{"action":"history-read","kind":"items","id":"daily-operations","offset":0,"limit":20}
```

The result contains complete `entries`, `archived`, and a `page` with exact
`total` and `nextOffset`. Carry `historyRevision` as `expectedHistoryRevision`
when requesting subsequent pages. A changed history revision refuses the page;
restart from the beginning. This revision includes metrics and host writes;
it is separate from the control revision. Page sizes are 1–1,000.

`metrics-read` also spans cold and live raw events and returns the exact event
total. `usage-read` summarizes the **recent** worker attempts represented by
the live metrics window and explicitly names that scope; it returns exact
`metricsEvents` and `archivedEvents` counts and an archive retrieval reference.
It does not claim lifetime token totals. A cumulative provider sample whose
baseline has aged out remains unknown. Original raw samples remain pageable
for offline lifetime analysis. Original report IDs still work with
`agent.wait({reportId,offset,limit})`; the original subtree access checks
apply. `assess` also works for an old task revision, updating its retained
assessment trail and the job's exact outcome counts transactionally.

Durable disk use grows with evidence. Normal reads and restarts load only the
live window; they do not scan all archived evidence. Startup checks the live
SQLite `records` table, while SQLite checks archived pages when accessed.
Use a full SQLite integrity check as offline maintenance when desired.
