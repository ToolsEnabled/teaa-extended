# Fleet V3 development candidate

Fleet V3 is a standalone MCP runtime for a lead coordinating durable worker assignments. This candidate adds compact, scoped and paged coordination reads, retained answer/resume attempts, preserved worker conversations, and transactional tree storage. Provider CLIs, subscriptions and ToolsEngine remain separate installations.

This is an unpublished development candidate. Linux source tests and recording-provider checks do not establish live model effectiveness or native Windows qualification. Existing V2 installations remain separate; the explicit Linux importer below preserves their source state.

Requires Node.js 22.19 or newer; Linux process cleanup uses Python 3. Extract into a new private folder and verify the received archive checksum through its delivery channel. From the extracted folder run:

```sh
node verify.cjs
node /absolute/path/to/runtime/bin/fleetV3.js setup --state-root /absolute/path/to/new-v3-state
```

The default state root is `~/.fleetV3`. The explicit state root must be new. Setup uses the terminal's working directory and prints the MCP server command. Use the lead provider as `--actor` when serving, and launch from the intended working directory. `--coordination-only` disables workers. Setup does not register clients or start a shared hub automatically.

Fleet inherits its launching environment. The working directory is not a filesystem sandbox; configure desired restrictions in that environment. Existing explicit folder policies remain supported. Private-state and credential protections continue to apply.

Inspect the configuration:

```sh
node /absolute/path/to/runtime/bin/fleetV3.js status --state-root /absolute/path/to/new-v3-state
```

V3 records `generation: 3` and `treeStorage: sqlite-v1`. Its V2-compatible internal tool profile does not change its V3 product identity. The V2 and V3 entry points refuse each other's state. The `rebind` operation only changes runtime paths within the same generation; it is not a V2-to-V3 importer.

Lead reads of `fleet.control` are compact by default. Use `view: full` for complete retained content, with `nodeId`, `offset` and `limit` when appropriate. Supply the first page's `expectedRevision` on later pages to detect changes. Workers receive their complete current assignment. V3 worker asks, progress, complete and hold must include its taskRevision as expectedTaskRevision; stale reports cannot complete a successor task. Mutation receipts contain the changed record summary; they do not repeat the entire retained tree.

Answer an Ask to save the answer and request one resume by default. Set `resume: false` to save the answer and keep the asker paused. The saved attempt prevents a repeated answer from dispatching another worker or reversing a later pause. A failed or unconfirmed attempt remains visible: inspect the worker and use an explicit resume to recover. See the lead and worker manuals for lifecycle and reporting details.

Optional structured requirements and worker results are described in `docs/FLEET-V3-RESULTS.md`. A worker completion remains unassessed until the lead records its own evidence-backed assessment; recording an assessment does not schedule work or gate a queue.

V3 stores each tree in `tree.sqlite3`, retaining tasks, rules, Asks, job items, history, complete worker reports, nodes, inbox and usage metadata. A transaction writes changed records together, with a revision check to reject stale writers. It uses SQLite WAL and full synchronization. Do not copy a live database file by itself: committed data may still reside in its WAL. Close the clients and hub before copying or moving state. A clean close checkpoints the database; preserve the entire state directory and all other runtime records.

The storage change reduces repeated serialization and writes. Unchanged deeply immutable branches are reused without traversing retained records. When a changed immutable list has known ancestry, persistence visits its changed entries; unknown or collected ancestry falls back to full traversal. Worker report histories have independent records, including reports previously stored inside the root row. Draft finalization still copies/freezes changed arrays, maps enumerate their entries, and mutable node data is rechecked. The entire tree is currently loaded in memory; this does not establish unlimited capacity. Existing corrupted or mixed-format trees are refused and preserved rather than replaced by empty state.

This candidate has no automatic installation rollout. Keep the runtime at its configured path.

This isolated runtime port adds lead-managed agent rules and attributed native
withdrawal. All Fleet rules form a variable instruction layer maintained by
leads. `ownerQuote` is provenance; the person's own authority remains in their
instructions and knowledge briefs. Legacy ownership/approval settings do not
block a lead's filing. Original authorship and the history hash chain remain
canonical; public rule reads use the neutral `ruleType: agent` view.

A lead can withdraw a mistaken or stale rule with `r_ledger.withdraw`: first
read `ledger.read`, then supply the exact id, scope/key, current ledger revision,
actor, and reason. It retires the rule and dotted refinements while preserving
words, authorship and lead-attributed history. A repeat at the current revision
is a no-op; a stale revision or wrong scope refuses. Removing a replacement never
reactivates its superseded predecessor. Workers ask their lead for this change.
The ledger remains its existing JSON record plus append-only history; SQLite
stores the tree/control state. These are separate revision domains.

For ledger maintenance beside an existing V3 tree, a direct lead can run:

```sh
node /absolute/path/to/runtime/bin/fleetV3.js serve --state-root /absolute/path/to/v3-state --actor PROVIDER --ledger-only
```

This serves only `ledger.read` and `r_ledger.withdraw`. It does not open a tree,
change the saved worker setting, or stop workers. Linked worker startup is
refused. Current turns and earlier conversation history are not rewritten;
future rule delivery omits withdrawn rules.

State admission examines the actual state directory. Unexpected ownership or
group/other write permissions produce `HOST_STATE_UNSAFE` warnings; readable
parent directories do not. A declared single-use guest can skip this admission
check with `TOOLSENABLED_SINGLE_USE_GUEST=1`. Worker folders, link credentials,
and SQLite files retain their separate privacy and path checks. This is not
permission escalation and does not make shared SQLite files admissible.

Unexpected resume failures retain scrubbed cause/stack diagnostics in
`<stateRoot>/logs/fleet-errors.jsonl`; receipts refer to a diagnostic id/path.
Answer/resume attempts retain that reference with their failed state. Inspect
before explicitly resuming; replaying the answer cannot dispatch twice.
Claude daemon process titles identify the provider at default level 2 and never
infer elevated permissions. Bundled provider descriptors take precedence over
redundant local paths without deleting those files or other custom descriptors.
Spawns report matching retained conversation candidates for reuse.

For an upgrade between V3 runtime paths, first close clients and stop the hub
through Fleet. Preserve the entire quiescent state directory, including tree
SQLite databases/sidecars, capability ledger/history, services/machine record,
provider conversations, worker homes and logs. Then use the new runtime:

```sh
node /absolute/new/runtime/bin/fleetV3.js rebind --state-root /absolute/path/to/v3-state
node /absolute/new/runtime/bin/fleetV3.js status --state-root /absolute/path/to/v3-state
```

Rebind reseals the machine record, changes runtime/Node paths, and appends
`runtime-rebinds.jsonl`. Update each MCP registration to the returned server
command and reconnect it normally; setup/rebind do not edit client registrations.
Do not rename or hand-edit generation fields, copy V2 tree JSON into V3, or use
rebind as a migration tool.

To import standalone V2 state on Linux, close every V2 lead and stop its hub through Fleet first. Keep those clients closed throughout import and while using the migrated work. Choose a new destination whose parent directory already exists:

```sh
node /absolute/path/to/runtime/bin/fleetV3.js import-v2 \
  --source-state-root /absolute/path/to/v2-state \
  --state-root /absolute/path/to/new-v3-state
```

The command checks private ownership, source configuration and its machine-record seal, recorded process ownership, and exact file fingerprints before and after copying. Source state stays intact. It copies all regular private files, including provider conversation files and SQLite sidecars, converts each tree to transactional storage, and rebinds the destination runtime configuration. Original configuration, tree and stale ownership records are kept privately under `v2-import-originals`. No client registration changes and no worker starts occur. Inspect retained work, then explicitly resume through Fleet. Ordinary task text and artifact references are preserved verbatim, including absolute paths; import does not relocate workspace artifacts or rewrite external provider profiles.

Import requires a clean offline source with no symbolic links, special files or retained process claims. It conservatively refuses a recorded PID that still exists. It is not a live snapshot or a lock against older clients: the operator must keep them closed. If copying, conversion or verification fails, the partial destination has no active host configuration; retain it for inspection and use a different fresh destination when retrying. The source remains available for rollback. Do not run the same assignments from both source and destination. Linux fixture checks cover migration mechanics and recording-provider conversation reuse; live provider upgrades and native Windows migration remain unqualified.

For a lead edit based only on one worker, Ask or job, add `revisionScope: "target"` with the `expectedRevision` returned by its read. Unrelated control changes do not invalidate that edit. Target changes, ancestor job context and shared rules/settings still do. The default remains strict whole-tree concurrency. Shared edits, subtree actions and paged reads require global revisions. This option does not snapshot external files or provider state and does not replace lifecycle or task-identity checks.

Jobs retain unfinished assignments across provider failures and uncertain sends. Inspect `job-read` failure details before explicit recovery. Unchanged turns alert the lead and remain counted without automatically holding tasks. The owner-ledger continuation controller likewise retains unfinished work; its optional explicit `maxTurns` setting is preserved.

### Named hub trees

`hub start --state-root ABS --actor PROVIDER --tree-key ordinary` creates that
exact fresh tree through the native host, or reopens that tree for the same root
actor. Keys use lowercase letters, digits, underscores or hyphens (1–64
characters, starting with a letter or digit). Existing identity, history and
ownership collisions refuse without allocating another tree. Ordinary direct
`serve --tree-key` remains an existing actor-family resume selection; attach to
a named hub with `serve --attach --tree-key ordinary`.

Startup confirms the ready child's PID, tree, level and retained private record,
then authenticates a status request to the same hub. A missing/mismatched ready
record fails; it never returns success with an empty hub. A failed confirmation
is not evidence the child exited: retain its log and use Fleet hub controls for
that exact scratch/operational tree as appropriate.

For a same-generation upgrade, the NEW runtime's native `hub stop` can quiesce
the hub still bound to the earlier install path before `rebind`. Stop keeps the
standalone/profile/generation checks, uses the retained private hub channel,
and waits for that recorded process to exit (60 seconds, then refusal). It does
not rebind, start a tree, activate accounts or change host configuration. Other
hub commands remain bound to their recorded runtime. Quiesce through Fleet and
preserve the complete state before rebinding; retain existing conversations and
ledger history. An empty fresh V3 ledger is not migrated V2 authority.
