# ToolsEngine privacy

ToolsEngine runs locally under your OS account. ToolsEnabled receives no telemetry or usage records. Requested workspace files and tool results are visible to the connected assistant; Codex conversation handling is governed by your agreement with OpenAI. Do not request credential files or expose secrets: ToolsEngine does not reliably recognize or redact private data.

The Codex plugin starts the fixed OpenAI profile with --no-browser: it reads and writes files only within the chosen current project and can fetch requested public HTTP(S) pages. Web requests send the requested URL, network address and ToolsEngine user agent to the selected destination and its redirects; private/local-network destinations are refused by this profile. Installation uses GitHub and explicit npm setup uses registry.npmjs.org or your own configured registry. There is no hosted MCP endpoint or ToolsEngine login.

Requested project files persist until you remove them. Other explicit ToolsEngine modes can keep browser snapshots under artifacts/toolsengine (newest 64), and browser download/artifact quotas are 256 files/64 MiB/16 MiB each including at most 32 downloads. Dedicated browser profiles retain cookies and sign-ins until you delete their chosen folder. The no-browser Codex plugin starts no browser or desktop helper and creates no browser profile. Uninstalling leaves project files and any artifacts/profiles you created; delete those folders yourself when no session is using them. Codex keeps its own plugin cache and session records under its configuration, managed by Codex rather than this server.

MIT LICENSE governs this source; no separate hosted service terms or product account apply. The public website terms are not claimed to cover this plugin. Questions: support@toolsenabled.ai.

The Codex plugin forwards TOOLSENGINE_CODEX_WORKSPACE and TOOLSENGINE_CODEX_RUNTIME. The latter selects a durable runtime folder outside the disposable Codex plugin cache; it holds source and npm dependencies until you delete it. Startup checks matching source/lock bytes and never downloads dependencies.

The optional standalone Linux `--firefox-hidden` MCP mode creates a separate
private profile and an authenticated private display. Startup never imports
the everyday Firefox profile. An explicit user-requested transfer can copy local
saved logins, keys and cookies into the dedicated profile, replacing its old login
state. Credential values are never returned by that tool; the local copies remain
until the dedicated profile is removed. Fleet settings can disable transfer.
The OpenAI plugin entry always selects no-browser mode and cannot offer or
dispatch this transfer tool. Observations in standalone Firefox mode
are returned to the client without automatic page-snapshot files. Firefox keeps
its own downloads and sign-ins, outside the Chromium artifact quotas, until you
close its owned browser and remove its dedicated profile. Closing the MCP
connection detaches the helper and preserves that browser/profile for reuse.
Its file chooser, print dialog, downloads and notifications stay on its private
display and its own session bus; nothing is shown through your desktop's portal
or notifier, and links are not handed to other applications.
See [private Firefox](docs/hidden-firefox.md) for prerequisites and limitations.

The optional Linux `browser.show` tool (with `--private-display` or
`--firefox-hidden`) shows the hidden browser in a window on your screen
through TigerVNC programs on this computer only: a Unix socket in a private
folder, a random password per showing, no network port, no shared clipboard.
Nothing is sent anywhere; the folder and password are removed when the window
closes. While the window is shown, your clicks and keys reach the browser the
assistant uses. See [showing the hidden browser](docs/browser-show-hide.md).

Standalone Firefox offers a user-authorized opaque credential handoff. It reads
visible text from the selected source origin into bounded, short-lived process
memory and returns only a destination-bound one-use handle. Password input uses
local process stdin; no credential value enters MCP arguments or results. Source
observations and screenshots are withheld as described in docs/hidden-firefox.md.
Captured-value output redaction lasts until expiry; no global secret detector,
OS memory isolation or complete Python memory erasure is promised. Existing
ordinary password typing/inspection exclusions and the no-browser plugin remain.

Hidden Chrome mode (--chrome-hidden) supports explicit origin-scoped session transfer through the installed Chrome’s approved Playwright Extension connection. Transfer reads browser-decrypted cookies and supported site storage in memory, returns counts only, and disconnects the source. Its connection setup may open a visible approval page; ordinary browser work remains headless. The separate Chrome profile persists cookies, localStorage and JSON-compatible IndexedDB locally; imported sessionStorage lasts only for the current hidden browser. Saved passwords and device-bound authentication are excluded. See docs/hidden-chrome.md for boundaries. The OpenAI plugin has no browser or transfer tools.
