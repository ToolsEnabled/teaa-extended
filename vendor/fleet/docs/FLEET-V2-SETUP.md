# fleetV2 standalone MCP candidate

State permission checks inspect the actual state directory. A group/other-writable
directory or unexpected owner produces a warning; it does not refuse startup.
Readable/executable bits and shared parent directories do not make state unsafe.
In a declared single-use guest, set `TOOLSENABLED_SINGLE_USE_GUEST=1` to skip this
permission check. This does not grant OS access or change private link-file checks.
Bundled providers exclude redundant local descriptor paths, while other custom
providers and the original local files remain available and retained.

Fleet V2 is a standalone MCP runtime. Provider CLIs, their subscriptions and ToolsEngine are separately installed. This package does not install or build vendor plugins.

Requires Node.js 22.19 or newer. Linux uses Python 3 for retained process-tree cleanup. Linux and native Windows x64 are supported targets; Windows uses native PowerShell and NTFS, without WSL. See the retained platform qualification receipts for the exact tested provider paths.

Fleet inherits the environment from which it is launched. The terminal starting directory becomes the working directory; it is not a filesystem boundary. Fleet does not add a folder sandbox or discover the lead client's folder permissions. Configure any desired filesystem or network restrictions outside Fleet, for example in the sandbox that launches the terminal. Existing operating-system restrictions still apply. Fleet does not elevate privileges or escape an external sandbox.

Extract into a new, private folder outside the state folder. Authenticate the archive checksum through the channel from which you received it, then run `node verify.cjs` to check extracted contents. Keep the runtime folder stable after setup.

From your intended working directory, run:

```sh
node /path/to/runtime/bin/fleetV2.js setup --state-root /absolute/private-state
```

Use absolute native paths on Windows. The state folder must be new. Setup defaults to the current directory; `--workspace` selects a setup directory explicitly. `--coordination-only` disables worker launching. Each new server process and its workers use the server's starting directory, so an MCP client must launch it with the intended working directory.

Setup prints a `server` command and arguments for the MCP client. Its example actor is `codex`; choose the provider that owns the lead connection. It also prints `toolsEngineEnvironment`, which can be added to a separately configured ToolsEngine MCP. The shared Chrome transfer setting takes effect on the next transfer request and does not replace explicit user authorization.

Fleet rules are agent rules filed and maintained by leads with `r_ledger.file`.
They stack per job and form the variable instruction layer. The person's own
authority lives outside Fleet in their Markdown files and knowledge briefs;
`ownerQuote` is optional provenance text and never changes a rule's authority or
editability. Workers report needed rule changes to the lead. Legacy filing and
approval settings do not gate a lead's filing. Each rule records who filed it and
when. Refine with `parent: "R3"` (R3.1), or replace with `supersedes: "R3"`; the
superseded record stays in history and is no longer delivered. A credential-shaped
value is redacted with a warning while the rule is filed. Leads receive active
global rules at connection; workers receive their applicable rules separately
from the static interior manual. `system.status` and `ledger.read` expose rule
health as `rules`, including ledger existence and active/superseded counts.

Inspect configuration and the supported launch entry with:

```sh
node runtime/bin/fleetV2.js status --state-root /absolute/private-state
```

The orchestrator coordinates through task assignments, rules and durable Asks. It retains lifecycle and settings control. Workers use provider bypass and message linked peers. Pausing and editing assignments invalidates stale task authority before resume. Retained process groups and Windows Jobs control lifecycle; they do not grant additional filesystem rights.

MCP file tools provide byte-coordinated edits across paths accessible to the running process. Private state/credential protections remain. Native and shell edits do not participate in byte mediation. The working directory is only the default for relative paths.

Existing explicitly scoped development installations retain their saved restrictions. The old read/write-root flags and `scope` update command remain available for those installations; an old state is never silently widened. New installations without root flags use `inherited-environment` and do not require folder-policy configuration.

After an upgrade that installs the runtime in a new folder (TEAA does this for each release), the state the earlier runtime made refuses to open with `HOST_CONFIG_INVALID`. Close every client and hub using it, then move that same state to the new runtime with:

```sh
node runtime/bin/fleetV2.js rebind --state-root /absolute/private-state
```

Rebind changes only the recorded runtime and Node paths; workers, folder policy, workspace, actor, tasks, rules, Asks and memory stay as they are, and each rebind is appended to `runtime-rebinds.jsonl` in the state folder. It changes nothing if a server still holds one of the state's trees, or if the state's sealed machine record does not name the same earlier runtime. Update the client's server entry from `status` afterwards.

Close the MCP client before moving or retiring this extracted runtime. No client registration or live installation is changed automatically. Preserve the separate state directory for task history, rules, Asks and audit records.
