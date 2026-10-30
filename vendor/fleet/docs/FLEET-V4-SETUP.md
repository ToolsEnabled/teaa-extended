# Fleet V4 4.0.2

Internal only; open sourcing and publication are not authorized by the owner.

Fleet V4 4.0.2 is a standalone MCP product on the Fleet V3 lifecycle. It keeps V3 task revision fencing, transactional tree storage, and worker sessions, and adds a distinct product identity. V2 and V3 installations and state stay in place. This version provides explicit offline V3 state import into a new root. It does not upgrade an installed client or turn on an operating-system sandbox.

Requires Node.js 22.19 or newer. Extract into a new private folder and verify the archive checksum. From the extracted folder run:

```sh
node verify.cjs
node /absolute/path/to/runtime/bin/fleetV4.js setup --state-root /absolute/path/to/new-v4-state
```

The default state root is `~/.fleetV4`. The explicit state root must be new. Setup uses the terminal's working directory and prints the MCP server command. Use the lead provider as `--actor` when serving. `--coordination-only` disables workers. Setup does not register clients or start a shared hub.

Fleet inherits its launching environment. The working directory is not a filesystem sandbox. Configure desired restrictions outside Fleet.

Inspect the configuration:

```sh
node /absolute/path/to/runtime/bin/fleetV4.js status --state-root /absolute/path/to/new-v4-state
node /absolute/path/to/runtime/bin/fleetV4.js serve --state-root /absolute/path/to/new-v4-state --actor PROVIDER
```

V4 records `generation: 4` and `treeStorage: sqlite-v1`. Its server identifies itself as `fleetV4`. The V2, V3, and V4 entry points refuse each other's state. `rebind` changes runtime paths within the same generation only.

V4 worker asks, progress, complete, and hold must include the assignment taskRevision as expectedTaskRevision. A worker completion remains unassessed until the lead records its own assessment.

Mediated file edits go through the existing byte authority. The native execution contract admits the changed byte spans of one file as one publication. It refuses a multi-file commit before any effect, because the authority has no cross-file transaction and compensating writes are not atomic. Shell, Git, formatters, other MCP tools, and unmanaged writers are accounted for and are not intercepted. An in-process bookkeeping grant is not an operating-system or native-client permission.

For preserved-state import and rollback, see [FLEET-V4-MIGRATION.md](FLEET-V4-MIGRATION.md). Run `fleetV4 import-v3 --source-state-root ABS --state-root NEW_ABS` only after source quiescence. It starts no workers and preserves the source. There is no automatic migration or installation rollout.

## Stable runtime link

Register MCP servers and scripts against a stable link such as
`~/.local/opt/fleetV4-current/runtime` pointing at the versioned install's
`runtime` directory. For example, create the link once, then register
`node ~/.local/opt/fleetV4-current/runtime/bin/fleetV4.js serve --attach`
with your existing state root, actor and optional tree key; use the expanded
absolute path in MCP registrations. Scripts use the
same linked entry with `call`. The hub resolves the link to verify that the
lead uses its runtime; a link to a different runtime copy is refused.

For each upgrade, install and verify the new version, stop the hub, run the
new runtime's `rebind`, repoint the link, then start the hub:

```sh
node "$HOME/.local/opt/fleetV4-current/runtime/bin/fleetV4.js" hub stop --state-root ABS --actor PROVIDER
node /absolute/path/to/new-version/runtime/bin/fleetV4.js rebind --state-root ABS
ln -sfn /absolute/path/to/new-version/runtime "$HOME/.local/opt/fleetV4-current/runtime"
node "$HOME/.local/opt/fleetV4-current/runtime/bin/fleetV4.js" hub start --state-root ABS --actor PROVIDER
```

The example assumes the stable link already exists; initially create its parent
with `mkdir -p "$HOME/.local/opt/fleetV4-current"` and the link with
`ln -s /absolute/path/to/version/runtime "$HOME/.local/opt/fleetV4-current/runtime"`.
Keep the same state root, actor and `--tree-key` if you use one. Leads change
nothing: MCP registrations and scripts keep the stable path.

## Codex custody diagnostics

Codex custody keeps the required deployment pin: set `TELOGINS_CODEX_CUSTODY_CONFIG` to a readable absolute configuration path, and set `TELOGINS_CODEX_CUSTODY_HOST` to exactly that configuration's `host` field. Missing or mismatched pins refuse before SSH. Refusals now name the actual cause and repair: missing, unreadable or invalid configuration; missing accounts root; missing or mismatched host pin; failed or timed-out SSH; a service attestation refusal; or credit/spending policy refusal. The existing `FLEET_ACCOUNT_CUSTODY_UNAVAILABLE`, `FLEET_ACCOUNT_CUSTODY_INVALID`, `FLEET_ACCOUNT_HOME_INVALID` and `FLEET_ACCOUNT_SPEND_UNKNOWN` codes retain their roles, with a diagnostic `reason` on account-service errors. Service refusal messages include the stated reason with credential values redacted; process output and configuration values are never forwarded. Identity, single-holder custody, freshness, subscription and no-credit guards remain required at launch and thread admission.

| Diagnostic reason | Repair |
| --- | --- |
| `CUSTODY_CONFIG_MISSING` | Set `TELOGINS_CODEX_CUSTODY_CONFIG` to the canonical configuration's absolute path. |
| `CUSTODY_CONFIG_UNREADABLE` | Restore that file and its read permissions. |
| `CUSTODY_CONFIG_INVALID` | Use an absolute path and valid JSON with version 1, a host, and absolute adapter/store paths. |
| `ACCOUNTS_ROOT_MISSING` | Provision the existing accounts directory through Telogins; set `TELOGINS_ACCOUNTS_ROOT` or repair its service resolver. |
| `CUSTODY_HOST_PIN_MISSING` | Set `TELOGINS_CODEX_CUSTODY_HOST` to exactly the config's `host` field. |
| `CUSTODY_HOST_PIN_MISMATCH` | Verify the canonical host, then correct the pin/configuration disagreement. |
| `CUSTODY_SSH_FAILED` | Check host connectivity, SSH authentication and the remote custody command. |
| `CUSTODY_SSH_TIMEOUT` | Restore connectivity or service responsiveness. Connection timeout remains 10 seconds; the complete command is bounded at 15 seconds. |
| `CUSTODY_RESPONSE_INVALID` | Repair the adapter's invalid JSON response. |
| `CUSTODY_READ_FAILED` | Check the configured custody reader; arbitrary reader exceptions are not forwarded. |
| `ATTESTATION_REFUSED` | Repair the service's stated condition; this is a responding service, not proof of an outage. |
| `ATTESTATION_INVALID` | Repair mismatched identity, plan, single-holder or stale attestation records through Telogins. |
| `CREDITS_REFUSED` | Disable credits and verify custody, identity and authenticated provider spending state. |
| `SPENDING_UNVERIFIED` | Verify the provider's credit state before retrying. |
| `SPENDING_POLICY_REFUSED` | Match the model policy to the canonical plan and explicitly forbid credits. |

These diagnostics never select a fallback account, enable spending or refresh credentials. The same cause survives the final custody recheck before provider thread admission. A negative JSON attestation from a remote adapter can be explained even when it exits nonzero; SSH transport failure (exit 255) remains a transport refusal.
