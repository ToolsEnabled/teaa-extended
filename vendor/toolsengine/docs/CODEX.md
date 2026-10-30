# Codex plugin

Requires Node.js 22.14+ and a local Codex CLI with plugin support. This self-distributed stdio plugin is not a public-directory listing or OpenAI approval. The compatibility manifest explicitly declares empty hooks; no Claude hooks are required.

```sh
codex plugin marketplace add ToolsEnabled/toolsengine --ref main
codex plugin add toolsengine@toolsengine
codex plugin list --json
```

These main-branch commands apply after publication of 0.2.0-alpha.4. To deliberately evaluate an unpublished Windows-port candidate, select the release candidate branch for both the marketplace and runtime; keep both at the same revision. The separate OpenAI development branch is not the integrated Windows release.

Prepare a durable runtime outside the Codex plugin cache and outside your project. From a terminal, choose a new private folder and clone the same branch there, then install its pinned dependencies:

```sh
git clone --branch main https://github.com/ToolsEnabled/toolsengine.git /chosen/toolsengine-runtime
cd /chosen/toolsengine-runtime
npm ci --omit=dev --ignore-scripts
export TOOLSENGINE_CODEX_RUNTIME="$PWD"
```

Replace the example path with a folder you choose. In PowerShell set `$env:TOOLSENGINE_CODEX_RUNTIME = (Get-Location).Path` after setup. This explicit setup downloads dependencies from registry.npmjs.org or your configured registry. Startup never installs or downloads anything. The launcher compares runtime source and lock bytes with its installed plugin and refuses missing/mismatched setup. Keep this runtime outside the plugin cache: Codex can refresh that cache on session start, removing dependencies installed directly there. After updating the plugin, prepare the matching runtime revision in a new folder and select it. A matching release archive's app folder can also supply the runtime. No browser download or system-wide install is performed.

Before starting Codex, explicitly select an existing project outside the plugin folder: in a POSIX shell from that project use `export TOOLSENGINE_CODEX_WORKSPACE="$PWD"`; in PowerShell use `$env:TOOLSENGINE_CODEX_WORKSPACE = (Get-Location).Path`. Restart Codex with this environment. Missing or relative selection is refused. The selected folder becomes the server workspace; all existing physical path and traversal checks apply. A project containing the installed plugin, or inside it, is refused.

Ask: “Use ToolsEngine system.status, write plugin-check.txt with the text hello in this project, then read it back.” Expect browserEnabled false, a successful write and exactly hello. This plugin offers the eight file/public-web/status/discovery tools of --no-browser. Browser/desktop integration remains available through the separate explicit MCP configuration in [clients.md](clients.md); it is not qualified by this plugin check. Do not install this plugin and a duplicate manually registered ToolsEngine server in the same session unless you deliberately want both.

The server runs with your OS account permissions; its workspace file boundary is enforced by the server, and approvals/task authority remain with Codex and the person. No product account, OAuth service, API key or paid model API is required. Codex authentication is separate. See [privacy](../PRIVACY.md) for data, retention and deletion. Uninstall using `codex plugin remove toolsengine@toolsengine`; project files and artifacts remain until you delete them. The Codex marketplace/install and actual model-task evidence covers Linux with Codex CLI 0.162.1. Windows native launcher/stdio qualification is separate from the owner's real Codex desktop/session check; no Windows Codex host or public-directory approval is implied by the Linux evidence.

The standalone MCP's optional Firefox profile-transfer capability is outside
this plugin entry. The launcher fixes its arguments to `--no-browser`, and
the server rejects browser/profile-transfer dispatch in that mode. Installing
the full matching runtime does not add those capabilities to the plugin.

The launcher fixes `--plugin-profile openai --no-browser`. This profile rejects browser, desktop and private-network options before startup and fixes the eight-tool registry for both listing and execution. See [PLUGIN-POLICY.md](PLUGIN-POLICY.md) for the reviewed scope and marketplace status.
