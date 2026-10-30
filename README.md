# TEAA Extended 0.5.0-alpha.6

TEAA Extended combines Fleet 5, ToolsEngine, Knowledge, the FRA device client, and the local Fleet Hub gateway lifecycle. This is an alpha release; interfaces and behavior may change between versions.

## Requirements

- Node.js 22.19 or newer
- Python 3.11 or newer for Knowledge
- Git for Knowledge repository operations

The command and MCP server ID are both `teaa`. Ordinary Fleet V5 contract tools require `--workers` when creating new state. Setup does not start a model, worker, provider, or agent CLI.

## Install from this source checkout

On Linux, run:

```sh
./install.sh --prefix "$HOME/.local/share/teaa"
```

On native Windows, run PowerShell from this checkout:

```powershell
node .\src\install.js --prefix "$env:LOCALAPPDATA\ToolsEnabled\TEAA"
```

The installer does not change global PATH or host MCP configuration unless the corresponding option is explicitly selected. Ensure the installed `teaa` command is on your user PATH, or invoke it by its installed path.

Create or choose an absolute project folder, then run:

```text
teaa setup --folder <absolute-project-folder> --actor local --no-browser --workers
teaa doctor --json
teaa config --server-json
```

Add the emitted `teaa` server entry to the MCP host you choose. See [SETUP.md](SETUP.md) for first-run details and [EXTENDED-SETUP.md](EXTENDED-SETUP.md) for FRA enrollment and Hub pairing.

## Source layout and state

`components.lock.json` records the included component versions and source identities. User configuration and state remain in the platform's per-user ToolsEnabled directories. Knowledge repository synchronization defaults off and requires explicit setup. Uninstall removes only the selected installation and command; it retains user state.

The package does not configure telemetry or automatic update checks. ToolsEngine file operations use the selected workspace. Its explicitly selected public-web tools send the requested URL and request metadata to that destination; browser modes can contact visited sites and persist browser data in their configured profile. Fleet provider/model traffic occurs only after an operator selects and invokes a provider. FRA network use is opt-in and goes to the endpoint configured for the device or account. Installation does not enroll an account.
