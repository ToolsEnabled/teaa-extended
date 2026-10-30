# TEAA Extended 0.5.0-alpha.7 — private candidate

TEAA Extended combines Fleet 5, ToolsEngine, Knowledge, the FRA device client, and the local Fleet Hub gateway lifecycle. This alpha.7 candidate restores an existing Laptop MCP session after a Hub restart or transient network loss, and creates Windows Hub/FRA state through the private-state helper whichever command runs first. BASE remains pinned to TEAA 0.5.0-alpha.5; the included Fleet component identity is recorded in `components.lock.json`.

## Requirements and setup

This package requires Node.js 22.19 or newer, Python 3.11 or newer, and Git for Knowledge repository operations. The package command and MCP server ID are both `teaa`. Ordinary Fleet V5 contract tools require explicit `--workers` when creating new state. Omitting it preserves workers-off behavior; setup and doctor provide TEAA-specific guidance on `FLEET_V5_WORKERS_REQUIRED`. Preserve existing state and move it aside before creating fresh workers-enabled state. Setup does not start a model, worker, or provider.

Install Node.js 22.19 or newer, Python 3.11 or newer for Knowledge, and Git. Keep Python available to TEAA through the normal user PATH or an explicitly configured runtime; TEAA does not install Python globally. On Linux, run `./install.sh --prefix <owned-prefix>`. On Windows, use the shipped `install.cmd --prefix "C:\Tools\TEAA"`; it invokes packaged Node directly without changing PowerShell execution policy. Uninstall the same prefix with `install.cmd --prefix "C:\Tools\TEAA" --uninstall`. Neither installer changes global PATH or host MCP configuration unless `--add-to-path` is explicitly supplied. Then run `teaa setup --folder <workspace> --actor local --no-browser --workers`, `teaa doctor --json`, and `teaa config --server-json`. Add the emitted `teaa` server entry to the MCP host you choose. Workers are explicitly enabled by `--workers`; setup does not persist an administrator flag.

The command is `teaa`. Common operations include `teaa mcp`, `teaa hub start`, `teaa hub status`, `teaa hub stop`, `teaa select-hub`, and `teaa select-local`. Use `teaa open`, `teaa accept`, and `teaa status` for the FRA client workflow. See `SETUP.md`, `EXTENDED-SETUP.md`, `ORCHESTRATOR-GUIDE.md`, and `UPGRADE.md`.

## Components and state

The included component versions and source identities are recorded in `components.lock.json`; the actual file inventory and hashes are in `vendor/manifest.json`. User configuration and state remain in the platform's per-user ToolsEnabled directories (XDG paths on Linux; APPDATA/LOCALAPPDATA on Windows). Knowledge repository synchronization defaults off and requires explicit setup. Uninstall removes only the selected installation and command; it retains user state.

The package does not configure telemetry or automatic update checks. ToolsEngine file operations use the selected workspace. Its explicitly selected public-web tools send the requested URL and request metadata to that destination; explicit browser modes can contact visited sites and persist browser data in their configured profile. Optional setup downloads use the configured package sources as documented by ToolsEngine. Fleet provider/model traffic occurs only after an operator selects and invokes a provider. FRA network use is opt-in: self-hosted or hosted FRA routing uses the endpoint configured for that device/account, and installation does not enroll an account. A hosted FRA account/relay is a separate service with its own operator and privacy terms.

Functional qualification and exact remaining limits are recorded in the lane's `REPORT.txt` and `RESULTS.json`; package metadata records the source and component identities. This artifact is a reviewable alpha build and is not a claim of hosted-production readiness.
