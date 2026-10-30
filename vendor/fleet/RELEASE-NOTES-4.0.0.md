# Fleet V4 — 4.0.0

Internal only. No public release or open-source publication is authorized. On
2026-10-26 the owner said: "no we are not open sourcing this right now" (board 183).

Two different internal builds carried version `4.0.0`:

- `01cb0bb1` (Linux SHA-256
  `3b4c4f792181d6aca2dd1b68f733c4de04aae601029c4255b167902a2bd0f110`)
  is withdrawn.
- `57ec462` (Linux SHA-256
  `047b4af4c8983d2d9165e30e1d871b02b36d411ea097ca966405dc23445b4dee`)
  ran internally from 2026-10-26 21:01 UTC.

Subsequent builds use distinct versions; see [4.0.1](RELEASE-NOTES-4.0.1.md).
The implementation history and earlier evidence below remain scoped as recorded.
Product version: `4.0.0`. This records integrated history from `44426f0` through
`76388be`, plus release metadata changes. Evidence references identify the
implementation or measured report; earlier live trials do not certify a later
archive. The internal qualification matrix is `release/qualification-matrix.json`.

Fleet V4 is a standalone MCP product on the existing Fleet lifecycle and byte
authority. Node.js 22.19 or newer is required. The CLI is `fleetV4`, with separate
`~/.fleetV4` generation-4 SQLite state. V2/V3 state and installations remain
separate. Verify the archive checksum and run `node verify.cjs` before setup.
See [setup](docs/FLEET-V4-SETUP.md) and the
[lead quickstart](docs/LEAD-QUICKSTART.md).

## Fixed before release

- **V3 importer:** preserve the audit keystore's legitimate empty `store.lock`
  sentinel, oversized live metrics and existing cold history without compaction.
  Invalid-record errors identify the file and record kind. Evidence: `1f34ffc`;
  `tests/fleet-v4-import.test.js`.

- **Explicit worker waits:** schedule the next eligible automatic turn at the
  requested deadline, replacing short-turn backoff and resetting its streak.
  Waits shorter than 30 seconds use a 30-second minimum; a later progress report
  without `waitSeconds` cancels the wait. Evidence: `02f5ba2`, integrated as
  `57ec462`; `tests/fleet-v4-assignment-continuation.test.js`.

## Work that continues and verifies

- **F2 repaired:** Pi abort signals cancel queued native edits before byte-authority
  admission (`229f177`; `tests/pi-host-bridge.test.js`). Participating host and Pi
  read/edit operations share the existing authority; replay distinguishes known
  and uncertain outcomes. Cancellation does not establish universal mediation.
- **Plain assignments continue:** an unfinished turn schedules another turn without
  lead intervention, with spacing for short turns. Progress can carry `waitSeconds`
  from 1 through 2,592,000 (30 days). Open asks, directed pauses/stops, failures,
  opt-outs and bounded no-progress attempts still block automatic continuation.
  Corrections must be read before completion. Evidence: `c98475d`, `87ba5f8`,
  `b98b1b6`, `f9cff5d`, `3728f4b`, `ac24f37`, and
  `tests/fleet-v4-assignment-continuation.test.js` /
  `tests/fleet-v4-worker-wait-schema.test.js`.
- **Lead checks run in Fleet:** lead-owned requirement commands execute in the
  assignment folder after a worker's completion report. Fleet retains verifying
  status, outputs and check outcomes, can request bounded rework, and holds work
  when it cannot accept it. Reports and lead acceptance remain distinct.
  Verification notices are delivered from committed state; notice failures are
  retained. Evidence: `301a023`, `064780c`, `5b9771b`, `31a6c2d`, `262dcac`;
  `tests/fleet-v4-contract-checks.test.js` and
  `tests/fleet-v4-verification-notices.test.js`.
- **Recurring jobs:** durable intervals in minutes, hours or days, or daily UTC
  times, enqueue canonical job templates. Runs skip overlap with active/queued
  work and retain the skip reason. Schedules survive restarts. Evidence:
  `565d766`, `866ab32`, `a713821c0302127a58098827615a29b233157e0d`; `tests/fleet-v4-recurring.test.js`.
- **Restart recovery:** known unfinished/waiting assignment boundaries and pending
  verification recover across clean and abrupt hub restarts; waits retain their
  deadline and saved conversation. The continuation opt-out survives runtime
  profile reset. Evidence: `678758e`, `c3db1dd`, `9acb3cc`, `e7811cd`;
  assignment-continuation and contract-checks tests. Recovery is for known retained
  boundaries, not permission to replay uncertain external effects.

## Bounded history and simpler operation

- **Live history is bounded:** older records move atomically to a pageable SQLite
  cold store. Current, waiting and verifying work, unread notices and current
  follow-ups remain live. Interrupted archive commits and stale page revisions
  are tested (`8d82cc3`, `a713821c0302127a58098827615a29b233157e0d`, `2d8b32d`;
  `tests/fleet-history-retention.test.js`).
- **90 simulated days:** the recurring lane's scripted-provider soak executed
  34,655 scheduled business runs per arm. Without retention, day-90 full lead
  read was 232 ms, hub restart 15.8 s, fresh-process ready 14.7 s, RSS 1.76 GB,
  and live rows 242,946. With retention: 2.2 ms, 0.18 s, 0.29 s, 132 MiB and
  4,331 live rows. Items, reports and metrics matched, and SQLite `quick_check`
  passed. Source: lane `STATUS.md`, 18:16 UTC soak record; integrated as
  `4fed1a3` with `evidence/int2/REPORT.txt`. Dates were accelerated and providers
  scripted: these are storage/load measurements, not 90 wall-clock days or
  real-model business reliability.
- **Safe defaults:** omitted revisions resolve to safe task-local context; unrelated
  worker edits do not invalidate a worker's task revision. Answering an ask resumes
  by default, with explicit opt-out. `keepConversation` preserves a conversation
  for a directed follow-up. Refusals quote invalid values or give concrete recovery
  steps. Evidence: `68feb27`, `9e3000e`, `ebe03c1`, `afb8579`, `3bcbabc`;
  `tests/fleet-v4-control-simplicity.test.js` and
  `tests/fleet-v4-actionable-refusals.test.js`.

## Worker context, permissions and platforms

- **Claude instruction cost:** managed Claude workers exclude ancestor instruction
  files while preserving task-local instructions, native sign-in and Fleet's
  manual/rules. Managed instructions are no longer duplicated per turn.
  Implementation: `7728722`, `3cdbe65`, `ba05450`, `ded2f90`;
  `tests/fleet-v4-claude-context.test.js` and
  `tests/fleet-v4-worker-overhead.test.js`. The lane's 17:32 UTC context trial
  measured first-request input 269,056 → 23,060 tokens (-91.4%) and whole one-line
  turn 811,270 → 99,582. This is a specific packaged Haiku comparison, not a
  guarantee for all tasks/providers (lane `STATUS.md`, context record).
- **Tools follow roles:** non-delegating roles omit named Fleet coordination
  overhead from their already admitted surface; delegating roles keep their
  admitted surface. Exact additions or `tools: "all"` can widen a worker only
  within existing parent/role/permission limits. Selections persist through
  resume and refresh. Evidence: `ea33ac2`, `05c035d`, `408027a`;
  `tests/fleet-v4-worker-tools.test.js`.
- **Executable identity and worker defaults:** resolved executables identify
  renamed/anonymous-argv agent launches. Workers default to level 4 (bypassed),
  independently of the lead; administrator, role and ancestor caps still apply.
  Narrower leads attach by default, with strict mode opt-in. Evidence: `b4b456b`,
  `36092bf`, `3d7c82b`, `76388be`; `tests/fleet-v4-levels.test.js`.
- **Native Windows:** same-user CIM process/executable observation, named hub trees,
  account-owned private state, audit signing and Job Object cleanup support the
  Windows package. Evidence: `98d9683`, `36483ca`, `36092bf`; Windows observation,
  state-security and audit-keystore tests. Native package qualification at
  `3d7c82b` verified 389 payload files and exercised hub attach, exact executable
  identity, queue outcomes, worker lifecycle, folder scope and cleanup
  (`team/windows/REPORT-LEVELS.md`). Those native runs used synthetic providers;
  Windows real-model entitlement/execution is not claimed.
- **Custody pin and diagnostics:** managed Codex requires
  `TELOGINS_CODEX_CUSTODY_CONFIG` and a matching `TELOGINS_CODEX_CUSTODY_HOST`.
  Missing/mismatched pins refuse before SSH. Specific refusals distinguish
  configuration, accounts root, transport/timeout, attestation and spending
  policy failures; credential values are redacted. Identity, single-holder,
  freshness, subscription and no-credit guards remain. Evidence: `59ddb79`,
  `5031bbe`, `845940a`; `tests/release-kit-custody.test.js`. See
  [custody diagnostics](docs/FLEET-V4-SETUP.md#codex-custody-diagnostics).
- **Executable lead quickstart:** delegate, inspect Fleet verification, repair and
  reuse context through the documented MCP flow. Both the example and committed
  notice behavior run as tests (`a86e8cd`, `4e5d7b1`, `8587cc7`;
  `tests/lead-quickstart.test.js`).

## Qualification and known limits

Claude/Codex bounded benchmark outputs passed 32/32 unattended tasks on earlier
builds; all used zero automatic turns. The purported on/off arms both had
continuation enabled, so that comparison is withdrawn (`BENCHMARK.md`, corrected
17:27 UTC). The separate acceptance baseline at `f9cff5d` passed six website
outputs and one 60-minute business trial, independently checked. Its token totals
are incomplete/lower bounds because cleanup preceded final provider usage; exact
cost and cross-model efficiency are unknown (`team/acceptance/REPORT.md`).

Grok workers passed 3/3 easy tasks on `ded2f90`; a direct Grok lead also spawned
one real Claude worker that completed and passed an exact-byte check
(`REPORT-GROK.md`). Native counters and Fleet counters have different coverage.
These earlier Linux live results are distinct from final archive verification.
AGY is first-party internal use only and is not shipped, by owner decision
(board post 149). Pi real-model direct/worker qualification remains unknown;
recording-provider and official model-free checks do not establish it. Official
Pi remains an external dependency. See the internal qualification matrix for
per-provider, platform and requirement evidence.

Fleet supplies neither an OS sandbox nor universal native-write interception.
Shell, Git, formatters, native tools outside participating adapters, other MCP
servers and unmanaged writers keep native behavior. Cross-file atomic publication,
universal native delete/rename mediation and Pi generic fork are unsupported.
Fail-open hooks and post-write notifications are not enforcement. These boundaries
are recorded in `fleet-v4-requirements.json` and native-execution tests.

Offline `import-v3` preserves a quiescent V3 source and starts zero workers
(`tests/fleet-v4-import.test.js`). Activation and rollback remain owning-lead
operations: [migration](docs/FLEET-V4-MIGRATION.md). Release upload scripts require
explicit authorization, reviewed artifact pins and `releaseVerified: true`;
preparation leaves it false (`tests/release-kit-publish.test.js`). No publication,
installed migration or five-provider parity is implied by version 4.0.0.
