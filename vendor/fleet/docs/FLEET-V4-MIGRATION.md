# Private V3 to V4 migration and rollback

This procedure is for the owning lead after qualification of a fixed candidate. Owner authorization already permits that migration. This worker has performed synthetic imports only; it has not changed an installed runtime, account profile, shared hub or study. A model-free transport check does not qualify a native model turn or mandatory interception of native file tools.

## Scope and preconditions

Use a verified Linux candidate archive and its exact source commit. `verify.cjs` validates its complete manifest. Keep the previous runtime and V3 state root. The existing offline importer now accepts V3 transactional state through `fleetV4 import-v3`; the V3 `import-v2` path is retained. `rebind` is still same-generation only.

The entire source state root must be quiescent. Use Fleet controls to pause workers at a known task revision and retain their conversations, unfinished work, asks, submissions and assessments. Let any in-flight operation resolve; do not retry an unknown publication. Close direct source MCP clients and stop each owning hub with the previous generation's `hub stop`. Coordinate with every owning lead before switching its registration. Do not change the runtime beneath a frozen running study cohort. If such a cohort shares the root, defer migration of that root; there is no selective tree migration in this procedure.

The importer never signals a process. Live owner/process/claim records, unsafe links, mixed generations, unresolved host byte publications and a changed source census refuse by name. These checks supplement operator quiescence; they cannot exclude unmanaged exterior writers. Files must be private and owned, and the destination must be new, absolute, outside the source and runtime directories, with a private physical parent. No source record or provider sign-in file is copied into the distributable archive. The local state copy is private operational state, not a distributable artifact.

## Import and activation

The operator supplies `CANDIDATE_RUNTIME`, `PREVIOUS_RUNTIME`, `SOURCE_STATE`, `DESTINATION_STATE`, `LEAD_ACTOR` and the actual tree keys. These are paths/identity choices, not new permissions. From the extracted candidate's top folder:

```sh
node verify.cjs
node "$CANDIDATE_RUNTIME/bin/fleetV4.js" import-v3 \
  --source-state-root "$SOURCE_STATE" --state-root "$DESTINATION_STATE"
node "$CANDIDATE_RUNTIME/bin/fleetV4.js" status --state-root "$DESTINATION_STATE" --actor "$LEAD_ACTOR"
```

Import preserves the source byte-for-byte. It copies opaque state, retains original configuration/tree bytes under `v3-import-originals`, reads source SQLite databases through disposable copies, and rewrites only destination runtime-dependent sealed records and transient process/session fields. Task revisions, provider thread IDs, jobs, reports, assessments, metrics and inboxes survive. Worker launch is explicit: `workersStarted` is zero. The configuration file is the final activation marker, written after copy comparison and fsync. An interrupted/failed destination is retained without a valid marker; inspect it and choose another new destination instead of overwriting it.

Inspect the returned entry and retained Fleet task/ask/history records before changing client registration. Use the existing provider registration mechanism with its own profile and native permissions. Preserve the actor and tree key; point it at the candidate's `fleetV4 serve --state-root` entry. AGY is first-party internal use only and is not shipped in this release; its worker hold stays enabled. Claude/Codex direct registration is separate from managed-worker link configuration.

Start/attach the owning V4 hub through Fleet. Resume only explicitly selected retained workers through Fleet with the current task revision. An answered ask must have an explicit resume. Validate a complete work/read/refusal/result flow before broadening traffic. Keep account settings, ToolsEngine browser state and opaque credentials unchanged. Never treat loading an MCP service as proof of native mutation mediation or provider effectiveness.

## Rollback

Before rollback, quiesce V4 through its own Fleet controls and close its owning clients/hubs. Preserve the whole V4 destination, all new conversations/results, and the package pin. Return registration to the retained previous runtime and untouched source root, then use V3 status and explicitly resume only the appropriate retained work.

Rollback returns to the frozen source snapshot. It does not merge work performed in V4, undo workspace file edits, reverse external effects, or make unknown publications safe to retry. The owning lead must reconcile later V4 results and workspace effects against the retained source tasks before any resume. If such effects are unresolved, keep both roots stopped until reconciled; do not replay them from the old assignment. No automated reverse import, source deletion or compensating write is provided.

## Reproduction

`tests/fleet-v4-import.test.js` calls the real CLI/importer and recording-provider lifecycle: live-source refusal, private copied state, byte-identical source, retained control/accounting/thread identity, explicit answer-and-resume, fenced completion, separate lead assessment, wrong-generation/alias/overlap/existing-destination refusals, interrupted setup, copy race, unknown publication refusal and return to V3 status. `tests/fleet-rules-package.test.js` performs import and registration from the actual V4 archive. These are synthetic state/model-free checks; owning-lead live migration remains separate.

Codex custody keeps the required deployment pin: set `TELOGINS_CODEX_CUSTODY_CONFIG` to a readable absolute configuration path, and set `TELOGINS_CODEX_CUSTODY_HOST` to exactly that configuration's `host` field. Missing or mismatched pins refuse before SSH. Refusals now name the actual cause and repair: missing, unreadable or invalid configuration; missing accounts root; missing or mismatched host pin; failed or timed-out SSH; a service attestation refusal; or credit/spending policy refusal. The existing `FLEET_ACCOUNT_CUSTODY_UNAVAILABLE`, `FLEET_ACCOUNT_CUSTODY_INVALID`, `FLEET_ACCOUNT_HOME_INVALID` and `FLEET_ACCOUNT_SPEND_UNKNOWN` codes retain their roles, with a diagnostic `reason` on account-service errors. Service refusal messages include the stated reason with credential values redacted; process output and configuration values are never forwarded. Identity, single-holder custody, freshness, subscription and no-credit guards remain required at launch and thread admission.

See [custody diagnostics](FLEET-V4-SETUP.md#codex-custody-diagnostics) for individual causes and repairs.
