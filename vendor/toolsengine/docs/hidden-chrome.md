# Hidden Chrome session transfer on Linux and Windows

Standalone MCP can use a dedicated persistent Chrome profile without showing a
browser window or sending desktop input:

```sh
node /absolute/toolsengine/bin/toolsengine.js --workspace /absolute/project --chrome-hidden
```

On native Windows use native Node and Windows paths with the same options.
Neither WSL nor a virtual display is used. Install Google Chrome first.
ToolsEngine starts the installed Chrome headless with its sandbox enabled;
failure is reported and never falls back to a visible browser.

The default profile is ~/.local/share/toolsengine/agent-chrome on Linux, or
%USERPROFILE%\\AppData\\Local\\ToolsEngine\\agent-chrome on Windows. An explicit
--profile-dir may choose another empty or already marked ToolsEngine profile.
An ordinary Chrome profile is refused. Chrome owns its profile lock; concurrent
use of the destination fails rather than taking over a running browser.
Closing ToolsEngine closes its owned hidden browser and preserves that profile.

After an explicit user request, call browser.transfer_chrome_session with an
origins array such as ["https://example.com", "https://accounts.example.com"].
Fleet setting browser.agent_chrome_session_transfer=false disables this before
connecting to the source. Transfer is never automatic.

The installed source Chrome must have a current Microsoft Playwright Extension\nthat supports browser-level cookie commands (Storage.getCookies). Older\nextensions must be updated by the person; failed source reads stop transfer.
ToolsEngine uses the existing extension connection and always asks the person\nto select and approve a source tab for transfer. A startup extension token is\nignored in the transfer worker; it cannot select the signed-in source tab. Its
connection page may open visibly during this setup. Agents must never approve
that page themselves. Chrome and its extension may change connection/group\nmetadata during approval and disconnection. Subsequent agent work uses only\nthe hidden browser.
Each requested origin must already have an open shared source tab; transfer
does not navigate, focus, open or close source tabs. The first shared tab at an
origin supplies its per-tab storage. Source read APIs do not make a transaction
across cookies and multiple tabs; a site changing its session concurrently may
need a new transfer.

Chrome reads its own decrypted cookies through its supported browser connection.
ToolsEngine does not copy Cookies, Login Data or Local State files, decrypt
DPAPI/app-bound encryption itself, bypass source locks, or claim that copied
encrypted files work. The same JavaScript implementation runs on Linux and
native Windows. The source API enumerates context cookies in private memory,
then filters transferred cookies by the requested origin domains and schemes
while retaining all paths. For each requested origin, only its existing shared
tab supplies localStorage, JSON-compatible IndexedDB and sessionStorage. IndexedDB values such as Blob,
Date, binary arrays, circular structures or undefined are refused before hidden
state replacement. Export is bounded to 16 MiB and 10,000 IndexedDB records\nper origin, with a 16 MiB aggregate transfer limit. Cookies shared by a domain can apply to its other subdomains
after import, as ordinary browser cookie rules require.

Transfer closes the previous hidden tabs and replaces the hidden context's
previous cookies and site storage. Unsaved work in those tabs is lost.
Cookies, localStorage and IndexedDB persist in the dedicated profile.
SessionStorage is supplied to tabs during the current hidden browser lifetime;
closing or restarting that browser ends it. Later changes in either browser
are independent. Re-transfer can replace the hidden state again.

Saved passwords, passkeys, device-bound authentication, client certificates,
service workers, Cache Storage and origin-private files are not transferred.
Some services reject copied sessions or require reauthentication. A count-only
import receipt never claims the website has accepted the sign-in.
Transfer state travels through private process memory, is not written to a
state export file, and is not returned in MCP output or error diagnostics.\nInherited Playwright protocol/file diagnostics are disabled for this mode and\nremoved from the source worker environment.
The destination browser persists its ordinary profile state locally.
Snapshots and screenshots from later page work can contain private content.

The OpenAI plugin remains limited to its eight scoped-file/public-web/status
tools. It has no browser or session-transfer capability.


Development qualification uses only synthetic profiles and a local site:

    TOOLSENGINE_CHROME_LIVE=1 node --test tests/chrome-session.integration.test.js

For the full extension workflow also set TOOLSENGINE_CHROME_EXTENSION_FIXTURE
to a private fixture directory containing Microsoft's unpacked Playwright
Extension as extension/, plus portable Chrome for Testing as
chrome-win64/chrome.exe on Windows or an executable chrome-sandbox-wrapper
on Linux. The Linux wrapper must use the existing installed Chrome sandbox
policy; it must not disable the sandbox or change OS policy. Run the headed
source fixture on an authenticated private Xvfb display. Only this synthetic
source approval is automated. The actual installed native Chrome remains the
headless target. tests/support/chrome-session-worker-fixture.mjs selects only
that test source; the production worker, factory, extension and relay execute
normally. The release test gate requires this approved-extension success on
Linux and native Windows, alongside its existing browser and Firefox checks.
