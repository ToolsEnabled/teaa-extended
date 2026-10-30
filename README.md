# TEAA Extended (TEAA + FRA + Hub) 0.5.0-alpha.10

TEAA Extended combines Fleet 5, ToolsEngine, Knowledge, the FRA device client, and the local Fleet Hub gateway lifecycle. Alpha.10 uses a configured `knowledge.command` Python during setup instead of searching PATH, so Python can stay off PATH. It keeps the alpha.9 in-place Fleet runtime rebind and the alpha.8 fix that preserves the login XDG_RUNTIME_DIR through the detached gateway. BASE is pinned to TEAA 0.5.0-alpha.6; the included Fleet component identity is recorded in `components.lock.json`.

## Requirements and setup

This package requires Node.js 22.19 or newer, Python 3.11 or newer, and Git for Knowledge repository operations. The package command and MCP server ID are both `teaa`. Ordinary Fleet V5 contract tools require explicit `--workers` when creating new state. Omitting it preserves workers-off behavior; setup and doctor provide TEAA-specific guidance on `FLEET_V5_WORKERS_REQUIRED`. Preserve existing state and move it aside before creating fresh workers-enabled state. Setup does not start a model, worker, or provider.

Install Node.js 22.19 or newer, Python 3.11 or newer for Knowledge, and Git. Keep Python available to TEAA through the normal user PATH or an explicitly configured runtime (`knowledge.command`; see SETUP.md); TEAA does not install Python globally. On Linux, run `./install.sh --prefix <owned-prefix>`. On Windows, use the shipped `install.cmd --prefix "C:\Tools\TEAA"`; it invokes packaged Node directly without changing PowerShell execution policy. Uninstall the same prefix with `install.cmd --prefix "C:\Tools\TEAA" --uninstall`. Neither installer changes global PATH or host MCP configuration unless `--add-to-path` is explicitly supplied. Then run `teaa setup --folder <workspace> --actor local --no-browser --workers`, `teaa doctor --json`, and `teaa config --server-json`. Add the emitted `teaa` server entry to the MCP host you choose. Workers are explicitly enabled by `--workers`; setup does not persist an administrator flag.

For an in-place upgrade, install the new app into the existing prefix and run `teaa setup`. A verified same-prefix Fleet V5 upgrade with a matching Fleet component identity is rebound automatically with its existing Fleet state and FRA enrollment intact. See `UPGRADE.md` for mismatch handling and the alpha.7 Hub stop note.

The command is `teaa`. Common operations include `teaa mcp`, `teaa hub start`, `teaa hub status`, `teaa hub stop`, `teaa select-hub`, and `teaa select-local`. Use `teaa open`, `teaa accept`, and `teaa status` for the FRA client workflow. See `SETUP.md`, `EXTENDED-SETUP.md`, `ORCHESTRATOR-GUIDE.md`, and `UPGRADE.md`.

## Release packages and this source checkout

TEAA + FRA + Hub 0.5.0-alpha.10 is published on the [TEAA GitHub releases](https://github.com/ToolsEnabled/teaa/releases) (release `v0.5.0-alpha`) as `teaa-extended-0.5.0-alpha.10-linux-x64.tar.gz` and `teaa-extended-0.5.0-alpha.10-windows-x64.zip`, with `SHA256SUMS` and an `INSTALL.md` guide. The install steps above run inside an extracted archive.

This repository holds the source, but it is not an installable tree. The installers verify the archive's `release-manifest.json`, and the archive also carries the staged runtimes listed in its `vendor/manifest.json` (Fleet, ToolsEngine with its Node.js dependencies, Knowledge, FRA and Hub). This checkout contains the component sources but not those files, so `./install.sh` run here stops with an error about `release-manifest.json`. `npm test` runs the test suite from a checkout; tests that set up or start the bundled runtime need the staged runtimes from a release archive and fail in a bare checkout.

## Components and state

The included component versions and source identities are recorded in `components.lock.json`; the actual file inventory and hashes are in `vendor/manifest.json`. User configuration and state remain in the platform's per-user ToolsEnabled directories (XDG paths on Linux; APPDATA/LOCALAPPDATA on Windows). Knowledge repository synchronization defaults off and requires explicit setup. Uninstall removes only the selected installation and command; it retains user state.

The package does not configure telemetry or automatic update checks. ToolsEngine file operations use the selected workspace. Its explicitly selected public-web tools send the requested URL and request metadata to that destination; explicit browser modes can contact visited sites and persist browser data in their configured profile. Optional setup downloads use the configured package sources as documented by ToolsEngine. Fleet provider/model traffic occurs only after an operator selects and invokes a provider. FRA network use is opt-in: self-hosted or hosted FRA routing uses the endpoint configured for that device/account, and installation does not enroll an account. A hosted FRA account/relay is a separate service with its own operator and privacy terms.

Functional qualification and exact remaining limits are recorded in the lane's `REPORT.txt` and `RESULTS.json`; package metadata records the source and component identities. This artifact is a reviewable alpha build and is not a claim of hosted-production readiness.

## Report a problem or get help

- **Something broken or confusing:** [open an issue](https://github.com/ToolsEnabled/teaa-extended/issues/new/choose) and pick **Report a problem**. Include the version that `teaa doctor` shows and the steps to reproduce. Never paste passwords, tokens, API keys or private keys.
- **An idea:** open an issue and pick **Suggest an improvement**.
- **Your toolsenabled.ai account or the hosted service:** email support@toolsenabled.ai.
- **A security problem:** report it privately as the [security policy](https://github.com/ToolsEnabled/.github/blob/main/SECURITY.md) describes, never in a public issue.
