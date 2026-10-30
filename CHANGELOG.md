# TEAA Extended 0.5.0-alpha.10 — configured Knowledge Python

- Setup uses a configured `knowledge.command` Python that is not on PATH: with `knowledge.args` naming the bundled `knowledge.py`, setup failed with `Bundled runtime setup failed: Python 3.11 or newer was not found on PATH`. The configured interpreter is now version-checked and kept, the sample Knowledge repository and `knowledge-config.json` are still created, and PATH is searched only when no command is configured. `teaa setup --knowledge` uses the configured interpreter too.
- A failed `teaa open` (for example an unreachable account origin) prints the FRA error and exits nonzero, as alpha.9 already did; a regression test now covers unreachable, refused and invalid account origins.
- Pin TEAA BASE 0.5.0-alpha.6 (BASE alpha.5 plus the same fix); keep Fleet 2c37a8a with the same component identity, so alpha.9 to alpha.10 in-place upgrades rebind Fleet state as before.

# TEAA Extended 0.5.0-alpha.9 — in-place Fleet runtime upgrade

- Rebind a verified earlier TEAA-managed Fleet runtime in the same prefix when the Fleet component identity matches, preserving existing Fleet state and FRA enrollment.
- Include the alpha.8 Linux Hub fix that preserves XDG_RUNTIME_DIR in the detached FRA gateway environment.
- Keep the TEAA BASE 0.5.0-alpha.5 and Fleet 2c37a8a pins.

# TEAA Extended 0.5.0-alpha.8 — Linux Hub runtime environment

- Preserve XDG_RUNTIME_DIR in the detached FRA gateway environment so bridge attach proxies can validate Hub sockets under a normal Linux login runtime directory.
- Keep the TEAA BASE 0.5.0-alpha.5 and Fleet 2c37a8a pins.

# TEAA Extended 0.5.0-alpha.7 — reconnect and Windows state lifecycle

- Re-establish the Hub session from the same running MCP process after a Hub restart or transient network break; fail an interrupted call promptly with a retryable reset.
- Route Hub-first and FRA-first Windows state creation through the private-state helper while retaining strict owner checks.
- Keep the TEAA BASE 0.5.0-alpha.5 and Fleet 2c37a8a pins.

# TEAA Extended 0.5.0-alpha.6 — private successor candidate

Fix the packaged Hub-over-FRA path: include the gateway compatibility claim in stream opens, persist valid Hub selection state, export the bundled Hub entry point, probe both supported account health paths, and create the Windows private device state leaf with the package security helper. `teaa hub start --account` now discovers the enrolled computer's unique relay pair and manages the local FRA gateway alongside Fleet Hub. BASE remains pinned to TEAA 0.5.0-alpha.5. This is a private candidate; no publication or activation is claimed.

# TEAA Extended 0.5.0-alpha.5 — private successor candidate

This worktree prepares the accepted Fleet V5 2c37a8a component fix (lost amendment retention and exact 64-character part identifiers). It preserves the FRA CommonJS package-scope derivation and actual packaged CLI regression from alpha4. The exact accepted BASE alpha5 code/integrity pin is recorded in BASE-PIN.json. Extended A/B package and behavioral qualification remain in progress; no release or activation is claimed.

# TEAA Extended 0.5.0-alpha.4 — private successor candidate

Keep the existing `--workers` opt-in and workers-off state behavior. When the bundled Fleet V5 server refuses an ordinary connection with `FLEET_V5_WORKERS_REQUIRED`, setup and doctor now give TEAA-specific recovery guidance: preserve and move the workers-off `fleetV5-state` aside, then run `teaa setup --workers` to create fresh state. The message no longer recommends rerunning Fleet setup or using `--admin` as an ordinary TEAA recovery. Enabling worker capability does not start workers or providers. No state migration, publication, or live activation is included.

TEAA Extended also includes the FRA device client and local native Hub gateway. The alpha4 packaged FRA CLI now classifies vendored FRA CommonJS modules under their own CommonJS package scope; upstream FRA module bytes remain unchanged. See the task6 handoff for exact platform receipts and limits.

# TEAA Extended 0.5.0-alpha.3

TEAA Extended combines the qualified BASE component tuple with FRA client transport and the native Fleet Hub gateway lifecycle. The release manifest and reproducibility receipt record exact source and component identities.

Linux x64 packaged Hub start/status/stop and nine-tool reconnect tests pass. Native Windows x64 installation, setup, doctor, config discovery, local Hub lifecycle, and loopback FRA transport are tested on Windows 11. The hosted account/relay service and production enrollment are separate and are not qualified by this package handoff.

Windows setup requires Node.js 22.19 or newer, Python 3.11 or newer for Knowledge, and Git. The Windows `install.cmd` wrapper invokes Node directly, avoiding PowerShell execution-policy changes. Installation does not change global PATH, MCP host configuration, or user policy.
