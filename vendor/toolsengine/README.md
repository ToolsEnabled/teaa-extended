# ToolsEngine portable MCP

Vendor distribution boundaries and current review status: [docs/PLUGIN-POLICY.md](docs/PLUGIN-POLICY.md).

Standalone MCP development candidate: **0.2.0-alpha.1**. No publication or plugin release is implied.

Optional hidden Chrome signed-in session transfer for Linux and native Windows is documented in
[Hidden Chrome](docs/hidden-chrome.md). Browser actions use a separate headless
Chrome; importing supported site state requires an explicit user request and
Chrome’s approved Playwright Extension connection.

Optional Linux Firefox UI control is documented in
[Private Firefox on Linux](docs/hidden-firefox.md). It uses an authenticated
private display and a separate profile, preserves the browser sandbox, and
does not copy passwords or cookies from your everyday browser.

On Linux, Chrome and Edge with `--private-display`, and Firefox with
`--firefox-hidden`, offer `browser.show`, `browser.hide` and
`browser.visibility`. Show the live browser when the person needs to sign in
or take over, then hide it without restarting the browser or losing its
session. See [browser show/hide](docs/browser-show-hide.md) for setup,
including a local dependency installation without administrator access.

A separate local MCP server for browser automation, workspace files and public
web reading on Windows and Linux. Version 0.1.8 adds native Windows installer
ACL checks and guarded desktop focus/dialog repairs to 0.1.7
(0.1.3 was the first public release); what changed in each is listed at the end. It offers 27 core tools; attached-browser modes offer 26.
An explicit Windows desktop option adds four tools for existing signed-in apps.

## Standalone startup from a home folder

Standalone MCP accepts a starting workspace that contains the installation, including your home directory. Workspace tools exclude the ToolsEngine program folder from reads, writes, listing and search; sibling project files remain available. A workspace inside the running program remains refused. Vendor plugin profiles retain their stricter rule that the workspace and program cannot overlap. This is an application-level guard, not an OS sandbox.

## Codex plugin

Version 0.2.0-alpha.4 provides a self-distributed local file/public-web plugin for Codex. See [Codex setup and limits](docs/CODEX.md) and [privacy](PRIVACY.md). The standard MCP connection below also supports explicit browser modes.

## Install

ToolsEngine comes as one archive per system. Everything it needs to run is
inside the archive, so installing downloads nothing and works without a
network connection. The same program is also packaged for npm; that package
is a file on the releases page, not on the npm registry yet, and its route
is described under "From npm" below.

| System | Archive |
| --- | --- |
| Windows 10 or 11, 64-bit | `toolsengine-VERSION-windows-x64.zip` |
| Linux, 64-bit | `toolsengine-VERSION-linux-x64.tar.gz` |

What must already be on the machine:

- **Node.js 22.14 or newer.** Check with `node --version`. It is the one
  program the archive does not carry.
- **Google Chrome or Microsoft Edge**, for the browser tools. With neither,
  ToolsEngine installs with the browser tools switched off; the file and
  web-reading tools work.
- **The client** you want to use it from: Claude Code, Codex, or both.

Every release on <https://github.com/ToolsEnabled/toolsengine/releases>
carries the two archives and `SHA256SUMS`, their SHA-256 sums in `sha256sum -c`
format. Check the archive against it before extracting it, as the first
step for each system does.

### Windows

1. Copy the `.zip` and `SHA256SUMS` to the machine. In a command window in
   their folder, `certutil -hashfile toolsengine-VERSION-windows-x64.zip SHA256`
   prints the archive's SHA-256; it must be the value on the `.zip` line of
   `SHA256SUMS`. Then right-click the `.zip`, choose **Extract All**, open
   the extracted folder, and the folder inside it, until you see
   `install.cmd`.
2. Click the address bar of that folder window, type `cmd` and press Enter. A
   command window opens in that folder.
3. Type this and press Enter:

   ```
   install.cmd --register claude codex
   ```

   Name only `claude` or only `codex` if you use one of them. In PowerShell
   the command is `.\install.cmd --register claude codex`.

### Linux

In the folder that holds the archive and `SHA256SUMS`:

```sh
sha256sum -c --ignore-missing SHA256SUMS
tar -xzf toolsengine-VERSION-linux-x64.tar.gz
cd toolsengine-VERSION-linux-x64
./install.sh --register claude codex
```

The first line answers `toolsengine-VERSION-linux-x64.tar.gz: OK` and exits 0;
`--ignore-missing` passes over the Windows archive, which `SHA256SUMS` also
lists. Without it the check still prints `OK` for the Linux archive but
reports the Windows one as unreadable and exits 1.

On both systems `node install.mjs` with the same options does the same thing:
`install.cmd` and `install.sh` only find Node.js and start it.

Then open a new session in the client. The tools appear under the server name
`toolsengine`, and `system.status` shows what is switched on.

### From npm

The npm package `@toolsenabled/toolsengine` is not on the npm registry yet,
so `npm install -g @toolsenabled/toolsengine` and `npx -y
@toolsenabled/toolsengine` do not work until it is published there. The
package is a file in each release on
<https://github.com/ToolsEnabled/toolsengine/releases>,
`toolsenabled-toolsengine-VERSION.tgz`, with its SHA-256 sum in
`toolsenabled-toolsengine-VERSION.tgz.sha256`. For a machine that already
has Node.js and npm, install it from that file. This route fetches the
program's dependencies from the npm registry and downloads no browser. npm
takes the four dependencies that `package.json` names at their exact
versions and resolves the packages they depend on itself, so some of those
can be newer than the versions this release was tested with, which are
listed in `npm-shrinkwrap.json`; the release archives carry exactly the
tested versions. This route does not run the installer, so the client is
connected with its own command, as shown below.

```sh
sha256sum -c toolsenabled-toolsengine-VERSION.tgz.sha256
npm install -g ./toolsenabled-toolsengine-VERSION.tgz
toolsengine --version
```

`toolsengine --version` prints `ToolsEngine 0.2.0-alpha.1`. Start the server with an
existing absolute folder as the workspace and the installed browser by name:

```
toolsengine --workspace ABSOLUTE_DIRECTORY --browser-channel chrome
```

`--browser-channel msedge` names Microsoft Edge, `--browser-executable
ABSOLUTE_PATH` a browser by its path (not together with `--browser-channel`),
and `--no-browser` leaves the browser tools off. Started in a terminal, the
server waits for MCP input; a client starts it with the same line:

```
claude mcp add --scope user toolsengine -- toolsengine --workspace ABSOLUTE_DIRECTORY --browser-channel chrome
codex mcp add toolsengine -- toolsengine --workspace ABSOLUTE_DIRECTORY --browser-channel chrome
```

With no Chrome and no Edge on the machine, put `--no-browser` in place of
`--browser-channel chrome` in these lines (or `--browser-executable` with the
full path of another Chromium-based browser). The server does not start with
a browser it cannot find: it writes "The selected browser was not found..."
(for a channel) or "--browser-executable names PATH, which does not exist."
(for a path) to its error output and exits, and Claude Code then shows only
"Failed to connect" for it in `claude mcp list`; the message itself is in the
client's MCP log. With `--no-browser` it connects with
its 8 tools that need no browser. This route has no installer to look for
a browser; the release archives' installer does (see "The browser" below).

The release archives, the package file and their SHA-256 sums are on the
project's releases page, <https://github.com/ToolsEnabled/toolsengine/releases>.
Questions and problems go to <support@toolsenabled.ai> or to
<https://github.com/ToolsEnabled/toolsengine/issues>.

### What the installer does

1. **Copies the program** to `ToolsEngine\VERSION` in your profile folder:
   `C:\Users\you\ToolsEngine\VERSION`, on Linux `~/ToolsEngine/VERSION`. Each
   file is checked against the list in `release.json` (SHA-256) before it is
   written, and a damaged archive installs nothing. A version that is already
   installed is never written over: the installer stops and says so.

   The folder is directly under the profile, and not under `AppData`, on
   purpose. On some machines `AppData` and shared work folders can be changed
   by sandboxed apps, and a program that an assistant runs should sit where
   only your account can change it. `--install-root DIR` chooses another
   place. On Windows the installer creates new program and workspace folders
   with a protected DACL for your Windows account, SYSTEM and Administrators.
   An existing program root must belong to your account and exclude other
   accounts' write access. Every existing path ancestor must have a trusted
   owner and exclude other accounts' replacement or ACL-changing rights.
   The exact measured TrustedInstaller service SID is accepted only as an
   existing ancestor owner; it gains no private-entry ownership or writer grant.
   Unsupported raw ACL rule types and unsafe or unverifiable roots are
   refused without changing its ACL. An existing workspace is used as supplied,
   with a notice if its ACL grants other accounts access. Directory paths may
   not traverse junctions or other reparse points. Windows PowerShell 5.1 in
   the system directory is required for these checks.
2. **Creates a workspace folder**, `ToolsEngine\workspace`, unless you name
   one with `--workspace DIR`. A named folder that does not exist is created;
   an existing one is used as it is. The file tools read and write in this
   folder only, and screenshots and PDFs are saved in it.
3. **Finds a browser**, as described in the next section.
4. **Starts the installed server once** and checks it: the handshake, the
   number of tools, `system.status`, and that the browser opens a blank page.
   `--no-check` skips this.
5. **Connects the clients** named after `--register`, using each client's
   own command. Without `--register` nothing is registered, and the installer
   prints the exact command for each client instead.

The installer uses no network. It has no download step, and it switches off
the connection and name-lookup functions of its own process before it does
anything else. The browser it starts for the check is a program of its own:
like every start of Chrome or Edge, it may contact its maker's servers by
itself, and `--no-check` installs without starting it. What the installer
printed is kept in `install-log.txt` in the installed folder, and its
settings in `installation.json`. `--dry-run` shows everything it would do and
changes nothing; `--help` lists every option.

### The browser

No browser is in the archive, and the installer downloads none. ToolsEngine
drives a browser that is already on the machine. The installer takes the
first of these that it finds:

1. Google Chrome
2. Microsoft Edge
3. on Linux, a Chromium from the system's packages (this one is found but
   has not been tested)
4. the Chromium that Playwright downloads, only when the exact build this
   version was made for is already on the machine

It starts that browser in its check, and if it does not start, tries the
next. ToolsEngine runs the browser hidden, with a temporary profile of its
own: it does not open your everyday profile and has none of its sign-ins.
The browser is started with its sandbox on (see "The browser's sandbox"
below); the installer never switches it off.
Install with `--headed` to have the browser open in a window you can see.

`--browser chrome`, `--browser msedge` or `--browser FULL_PATH_OF_A_BROWSER`
chooses one yourself, and `--browser none` installs without browser tools.
With no Chrome and no Edge, either install one of them and install ToolsEngine
again, or download Playwright's Chromium once with the command the installer
prints (this needs the network) and install with `--browser playwright`.

### Connecting Claude Code and Codex

With `--register`, the installer runs the client's own registration command.
Without it, the installer prints the same commands with the real paths filled
in, ready to paste. They have this form:

```
claude mcp add --scope user toolsengine -- NODE ENTRY --workspace WORKSPACE --browser-executable BROWSER
codex mcp add toolsengine -- NODE ENTRY --workspace WORKSPACE --browser-executable BROWSER
```

`NODE` is the Node.js program, `ENTRY` is `app/bin/toolsengine.js` in the
installed folder, `WORKSPACE` is the workspace folder and `BROWSER` is the
browser the installer chose, for example `/opt/google/chrome/chrome`. In its
place the commands carry `--no-browser` when ToolsEngine was installed
without browser tools, and `--browser-channel chrome` or `msedge` when that
browser was asked for by name and the installer did not find it. For Claude Code the
registration is in the `user` scope, so it applies to all your projects. When
a client is not installed, the installer says so and prints its command for
later.

The installer runs a client only when the home folder that the environment
names is your own profile, as the operating system records it. In a terminal
that another account started and that still carries that account's home
folder, the clients would change the other account's configuration; the
installer then prints the commands instead and ends with exit code 2. The
same holds for one client when `CLAUDE_CONFIG_DIR` (Claude Code) or
`CODEX_HOME` (Codex) names a folder outside your profile. `--home DIR` plays
no part in this: it chooses where ToolsEngine is installed, and nothing else.

A server named `toolsengine` that is already registered is left as it is,
and the installer says so. Add `--replace` to switch it to the version being
installed, again with the client's own commands. `--name NAME` registers
under another name instead.

Replacing never ends with no registration at all:

- Codex replaces an entry in one step with `codex mcp add`, so nothing is
  removed beforehand. Settings that were added to the old entry by hand, such
  as Codex time limits, go with it.
- Claude Code refuses to add a name that exists, so the old entry is removed
  first. The installer reads that one entry from Claude Code's configuration
  file beforehand, and puts it back if the new one is refused. An entry it
  could not put back (one that is not a local program, or a file it cannot
  read) is not removed; the installer prints the two commands instead.
- Nothing is removed or run when the new command could not be passed on as
  written. That is the case on Windows when the client is an npm `.cmd`
  launcher and a folder name holds one of `" % ! ^ & | < >`.
- When `--replace` was asked for and an earlier entry was left in place for
  one of these reasons, the installer ends with exit code 2: the replacement
  did not happen.
- If putting an earlier entry back fails as well, the installer shows that
  entry so that you can add it again, with the values of its settings and
  anything in its arguments that can be a secret left out. The whole entry is
  in Claude Code's own backup files.

A printed command is meant to be pasted. On Windows a line can hold a
character that no spelling makes right for both Command Prompt and
PowerShell; the installer then adds a note that says which terminal the line
is right for. With `& | < > ^` in a folder name and a client that is a `.cmd`
launcher, that is Command Prompt.

To connect a client later, or one more client, use the installer that sits
in the installed folder (`INSTALLED` stands for that folder, for example
`C:\Users\you\ToolsEngine\VERSION`):

```
node INSTALLED/install.mjs register claude
node INSTALLED/install.mjs register codex --replace
```

### Windows desktop tools

They are off unless you ask for them. `install.cmd --desktop` turns on the
four `desktop.*` tools, with which the assistant can read and operate the
apps that are open on your Windows account, signed-in ones included. Read
"Boundaries" below first. `--desktop-left-half` adds the startup option of
the same name.

### Check, update, uninstall

```
node INSTALLED/install.mjs check        compare the files with release.json, start the server once
node INSTALLED/install.mjs list         show the installed versions
node INSTALLED/install.mjs uninstall    remove this version
```

To update, install the newer archive. It goes into its own folder beside the
old one. Use `--register claude codex --replace` to point the clients at it,
then uninstall the old version.

Uninstall removes the files the installer put into that version's folder and
nothing else. It keeps the workspace and any other version, and it leaves
the clients alone: it prints the command that removes the registration from
each client (`claude mcp remove toolsengine --scope user` and
`codex mcp remove toolsengine`) for you to run.

The list of what to remove is the installed `release.json`, and it must be
the one that was installed: its SHA-256 is in `installation.json`. A folder
that has no such record is removed only by the installer of the extracted
archive of that version, and only when every file in it is what that archive
holds. Nothing is removed through a link or a junction, and what a link
points to is not looked into.

An install that was interrupted is finished by running the installer again,
without copying a second time, when the folder still holds exactly the files
of the release and the installer's own records and no other installer is at
work in it. Otherwise the installer says what stands in the way. A folder
that a killed installer was still copying into is cleared away only when a
validated marker proves the local process instance is gone. Remote, malformed,
legacy or unverifiable markers are preserved for explicit recovery. Recovery
requires verifiable ownership and plain directories, files and parents; linked
or unreadable records are refused. Windows recovery is currently refused
because this implementation cannot verify the required ownership there.

On Windows this installer cannot establish process-instance identity, so
`.incoming-*` folders are preserved even when their process number no longer
exists. A successful fresh install can leave these older copies beside the new
version; it does not attempt deletion using only a process number.

### Starting it by hand, and from source

The `app` folder of the archive is an ordinary Node.js program. A client that
is configured by hand needs the absolute path of Node.js as `command`, and as
`args` the absolute path of `app/bin/toolsengine.js`, then `--workspace` and
an existing absolute folder. Examples are in
[client configuration](docs/clients.md). An MCP client must start the process
and speak stdio; started in a terminal, it waits for protocol input. No API
key, account discovery, sign-in or other server is needed.

From a source checkout, with the network:

```sh
npm ci
npx playwright install chromium
node bin/toolsengine.js --workspace /absolute/path/to/workspace
```

On Linux that Chromium also needs its system libraries; an administrator can
install them with `npx playwright install-deps chromium`. To use an installed
browser instead, start with `--browser-channel chrome`, `--browser-channel
msedge` or `--browser-executable ABSOLUTE_PATH`.

The release archives are built on Linux with `npm run build:release`. The
third-party packages inside them are listed, each with its licence text, in
`THIRD-PARTY-NOTICES.txt`.

## Tools

| Area | Offered capability |
| --- | --- |
| Browser | Navigate/back, snapshot/find, click/type/fill, keys/select/hover/drag, tabs/dialogs/wait, screenshot/PDF, upload, resize page viewport, close the whole dedicated browser |
| Browser view (Linux, `--private-display` or `--firefox-hidden`) | Show the hidden browser live in a window on the person's screen, where they can watch and use it; hide it again; say whether it is shown |
| Workspace | List, UTF-8 read, create or replace a whole file, bounded literal search |
| Web | Public HTTPS GET, bounded HTML text/link extraction |
| Discovery | Runtime status and ranked search of the actual offered tools |
| Windows desktop (opt-in) | Inspect current-owner windows/controls, capture one window, act on observed controls, click/scroll with the real mouse inside a fresh captured image |

Every tool carries a title and states all four MCP hints (read-only,
destructive, idempotent, open-world). What the descriptions say about effects:

- `browser.close` closes the whole dedicated browser, every tab, not one page.
- `browser.click`, `browser.type`, `browser.press_key`, `browser.fill_form`,
  `browser.drag` and `browser.handle_dialog` are real input to the page: they
  can submit forms, send messages, confirm purchases and delete things.
- `browser.file_upload` hands the full content of workspace files to the page,
  which can send them to its site.
- `workspace.write_file` replaces the entire content of an existing file and
  keeps no copy; it is marked destructive.
- `workspace.write_file` does not create folders: the folder in the path must
  already exist, or the call is refused and says so. That is the safe side.
  A tool that created folders would turn a mistyped or invented path into a
  tree of new folders in your workspace, and nothing could tell such a tree
  from one you meant; a write that lands only in a folder you made stays a
  bounded, single-file action. `workspace.list` shows the folders that
  exist; make a new one yourself.
- `workspace.read_file`, `workspace.list` and `workspace.write_file` treat
  hidden files such as `.env` like any other file in the workspace. Only
  `workspace.search` skips folders whose name starts with a dot.
- Workspace paths must be usable on Windows as well as on Linux: a name with
  a colon or one of `* ? " < > |`, a name that ends in a dot or a space, and
  a Windows device name such as `con`, `aux` or `com1` (also with an
  extension, as in `aux.c`) are refused by the file tools. `workspace.search`
  passes such files and folders by and counts them as `nonPortableNames`.
- `desktop.pointer` moves the person's real mouse cursor, and
  `desktop.capture` returns whatever the window shows, unredacted.
- `browser.show` puts a window on the person's screen that shows the hidden
  browser live, and the person's clicks and keys in it reach the same pages;
  `browser.hide` closes it. Neither restarts or reloads the browser.

[The exact schemas](docs/tool-catalogue.json) are generated from the dispatcher;
[the Windows desktop schemas](docs/desktop-catalogue.json) from the same
descriptors the server offers. The package audit and the test suite compare
both files with the running server and fail on any difference.
This is a new portable implementation, not binary compatibility with the old
ToolsEnabled engine's receipt, approval, ledger, or browser gateway protocols.
Only the tools in the two catalogues exist here; the record of how each tool
of the old engine was replaced, deferred or left out is kept in the source
repository, not in this package.

Calls are serialized: one active call and at most eight waiting calls, with
at most 120 admitted calls per minute. A full queue or exceeded rate returns
a refusal without starting the call. MCP request cancellation removes queued
calls and interrupts an active browser or desktop operation. Cancelling an
owned browser operation closes that browser; an attached connection is
disconnected. Windows helper cancellation terminates only ToolsEngine's
per-call helper. Input already delivered cannot be undone, so inspect the
result before retrying.

## Browser sessions

The default is a new headless Chromium session with a dedicated ephemeral
profile. It does not share an ordinary browser's login state. `--headed` opens
its window.

### Hidden while the assistant works, shown when you ask (`--private-display`)

On Linux, `--private-display` runs ToolsEngine's own Chromium with real
windows on a private, authenticated X display that nobody sees: nothing
appears on your screen and nothing takes your focus. `browser.show` then opens
a window on your screen showing that same browser, live; you can watch it and
click and type in it, for example to sign in. `browser.hide` (or closing the
window) hides it again, and `browser.visibility` says whether it is shown. The
browser is never restarted or reloaded: the same tabs, pages, cookies and
sign-ins stay, and the browser tools go on working throughout. The hidden
Firefox mode (`--firefox-hidden`) offers the same three tools.

Standalone Firefox also offers `browser.capture_credential`,
`browser.fill_credential` and `browser.revoke_credential` for user-authorized
opaque handoffs from visible source-page text to a bound password field. Values
stay inside the native helper; the assistant receives only a short-lived,
one-use handle. Ordinary password reads and typing remain excluded. See
[credential handoff and its privacy limits](docs/hidden-firefox.md#opaque-credential-handoff-standalone-firefox-mcp).

The window is TigerVNC's viewer, connected to TigerVNC's scraping server over
a private, password-protected Unix socket: no network port is opened and the
clipboard is not shared. It needs `xvfb`, `tigervnc-scraping-server` and
`tigervnc-viewer` (Debian and Ubuntu package names), and an X11 or XWayland
display. Windows and macOS are not supported. Details, the security design
and the limits: [docs/browser-show-hide.md](docs/browser-show-hide.md).
Use `browser.snapshot` for inline page content and element references; some
action responses link to snapshot artifacts instead. Output files stay inside
the selected workspace, and a file name given to a tool is refused when it
exists. Uploads require explicit regular workspace files; hidden files and
links are refused.

In the browser that ToolsEngine starts, downloads use unique names such as
`download-<random-id>-report.txt` under `artifacts/toolsengine`. Existing
files are preserved. Saved screenshots, PDFs, snapshots, logs and downloads
are limited to 256 files and 64 MiB in total, 16 MiB per file, including at
most 32 downloads. Explicit output paths elsewhere in the workspace count
toward the same limits. Counts persist across server restarts.

The page-snapshot file that most browser calls write by themselves
(`page-<date and time>.yml` directly in `artifacts/toolsengine`) is kept as
a rolling set: the newest 64 of them, within 16 MiB, stay, and older ones
are deleted when a new one is written and when the server starts. Only
snapshot files that ToolsEngine wrote under that name are deleted; files
saved under a name given to a tool (`filename`), screenshots, PDFs, logs,
downloads and files you put there yourself are never deleted. Delete those
to make room. The snapshot file is written after the click, key press or
navigation has acted on the page, so it never turns the call into an
error: when it cannot be saved (the limits are reached with other files, or
another writer holds the lock), the call's result stands, the link to the
file is replaced, and one sentence says that the action was carried out and
only its snapshot file was not saved. `browser.snapshot` returns the page
inline at any time.

Output writes use a filesystem lock and reload shared accounting. Another
ToolsEngine writing into the same workspace holds the lock only while it
writes one file, and a write waits up to 2 seconds for it. A lock that is
still held after that, `.toolsengine-runtime/artifact-write.lock`, refuses
output that a tool was asked to save; review whether any ToolsEngine for
that workspace is still running before a human removes that runtime lock.
Index failure removes a newly created completed file, and index growth
beyond 64 KiB is refused.

Excess downloads are refused or cancelled. A refusal is reported in the
current or next browser result; input already delivered to the page may
still have applied. Chromium can briefly receive more than the per-file
limit before its temporary-file size observer cancels the download, but that file is not
saved as a completed artifact. A size refusal can cancel other downloads active
in this owned browser. Browser caches and dedicated profiles have
their own storage and are outside the saved-artifact quota.

A browser attached with `--cdp-endpoint` is different: ToolsEngine leaves its
downloads to it. A download goes where that browser saves its downloads, with
that browser's own prompts, and nothing is copied into the workspace.

With `--profile-dir`, `browser.close` closes the browser but the profile
keeps its cookies and sign-ins, and the next browser call starts the browser
with them again. The tool descriptions and the server's instructions are
written for the mode the server was started in: temporary profile, dedicated
profile, attached browser, or no browser.

### The browser's sandbox

ToolsEngine starts its browser with Chromium's sandbox on. The sandbox is the
part of the browser that keeps a web page from acting as your account: a page
that manages to break out of the page is still held in.

`system.status` reports the setting as `browserSandbox`. That value is what
the server asks for when it starts a browser. It is not a check of a running
browser: it is also `true` after a start that was refused, and it cannot see
a browser program that is really a script adding switches of its own.
`browserSandboxVerified` is therefore always `false`, like
`browserConnectionVerified`.

Where the sandbox cannot be set up, the browser does not start, and every
browser tool answers with one message. It says which browser failed and what
you can do about that browser. This happens on Linux with a browser build
that the system does not allow to create its sandbox. Ubuntu 23.10 and later
treat the Chromium that Playwright downloads this way. An installed Google
Chrome or Microsoft Edge sets its sandbox up when it is installed, and starts
normally. It also happens when ToolsEngine runs as root.

`--no-browser-sandbox` starts the browser without the sandbox. The installer
never sets this option: it has to be added to the client's configuration by
hand. The risk: `browser.navigate` opens any address it is given, and without
the sandbox a page that exploits a fault in the browser runs as you, with
everything your account can read and change. Use it only for pages you
control, or inside a container or virtual machine that is itself the
boundary. The option is refused together with `--no-browser` or
`--cdp-endpoint`. A browser attached with `--cdp-endpoint` was started by
someone else: whether it is sandboxed is not known to ToolsEngine, and
`browserSandbox` is then `null`.

The assistant is told where it stands. The refusal message, which it receives
as the result of its tool call, names the option and says that switching the
sandbox off is your decision and that it must not change the server's
configuration itself. When the server was started with `--no-browser-sandbox`,
its instructions to the assistant say that the browser runs without its
sandbox.

The server does not start with `SELENIUM_REMOTE_URL` in its environment,
unless it runs with `--no-browser`. With that variable the browser library
would start the browser on a remote Selenium grid, outside everything
described here.

`system.status` reports configuration, not a successful browser connection or
login. `browserEnabled` means that browser tools are offered. It does not mean
that Chromium has started, that a CDP endpoint is reachable, or that any site is
signed in. `browserSession` distinguishes `dedicated-ephemeral-profile`,
`dedicated-persistent-profile` and `attached-existing`; `browserWindowMode` and
`browserWindowVisibility` distinguish a non-visible headless browser, a headed
window that becomes visible when launched, and an external attached window whose
visibility is not verified. `browserLaunchState` is `not-probed` for managed
browsers because reading status does not start or inspect them, and is
`external-not-managed` for an attached browser. `browserAuthenticationVerified` and
`browserConnectionVerified` remain false because the status call performs no
probe.

For reusable login state, select `--profile-dir ABSOLUTE_PATH`: the directory
must be new/empty or an existing marked ToolsEngine profile. Sign in yourself
using `--headed`. An ordinary browser profile is refused.

The profile folder may lie inside the workspace. The file tools, uploads and
output files then stay out of it: `workspace.list`, `workspace.read_file`,
`workspace.write_file` and `workspace.search` refuse or pass by every path
inside the browser's own folders in the workspace, which are that profile
folder and `.toolsengine-runtime` (temporary files and the temporary
profile), and `browser.file_upload` gives no file from the profile to a page.

To deliberately use an already-running browser, supply
`--cdp-endpoint http://127.0.0.1:PORT` (or its loopback WebSocket URL).
The browser must already offer CDP. The address is checked when the server
starts, and `--browser-executable`, `--browser-channel` and `--headed`, which
only concern a browser ToolsEngine starts itself, are refused alongside it.
This exposes that browser's existing
authenticated context and tabs, and browser actions can change them. ToolsEngine
does not discover profiles, enable remote debugging, restart the browser, or
extract cookie stores directly. Observations and ordinary page input can expose credentials or sign in; no reliable secret redaction or paused-observation takeover is provided. Attached mode omits browser/tab close. Disconnecting preserves
the browser and its tabs. The attached status identifies potential authentication
sharing as `selected-existing-session`, but does not claim that the endpoint is
connected, visible, or signed in.

### Your everyday browser, with your approval (`--browser-extension`)

Chrome does not offer a debugging port on its everyday profiles, so
`--cdp-endpoint` cannot reach the browser you normally sign in with. Start
ToolsEngine with `--browser-extension` instead (and `--browser-channel msedge`
for Edge; Chrome is the default) after installing Microsoft's Playwright
Extension in that browser from the Chrome Web Store
(`https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm`).

- **Approval is required by default.** The first browser call opens the
  extension's connect page in your browser, naming ToolsEngine. Without the
  optional startup token described below, you choose the tab to share and
  approve. Until the extension connects, browser calls answer that they are
  waiting and perform no requested page action; asking again does not open a
  second page. Opening the connect page itself starts Chrome or Edge if needed.
  If you closed the approval page without approving, the relay keeps waiting;
  cancel a browser call in the client, or stop this server session, to revoke it.
  The next browser call after cancellation opens a fresh connect page.
- **While connected**, the browser shows that it is being controlled, and
  the extension's own controls end the connection. The assistant acts in
  your browser with your sign-ins: every click, form and message there is
  yours. It can open and select tabs; it cannot close your browser or its
  tabs. Downloads go where your browser puts them.
- **Approving every time is the default.** If you choose to connect without
  approving each time, give the server the token the extension shows you,
  in the environment variable `PLAYWRIGHT_MCP_EXTENSION_TOKEN`;
  `system.status` then reports `browserApproval: "extension-token"`
  instead of `"each-connection"`.
- ToolsEngine finds the browser by its channel in its standard place. It
  chooses the last-used profile with the extension installed; if that profile
  lacks the extension, it tries Default, then the lowest-numbered installed
  Profile. You cannot choose a profile through this mode. Check the connect
  page's browser/profile before sharing a tab. `system.status` describes this
  selection policy, and does not verify the chosen profile or its sign-ins.
  It ignores inherited
  variables that would pick another browser, profile or executable
  (`PLAYWRIGHT_MCP_BROWSER`, `PLAYWRIGHT_MCP_EXECUTABLE_PATH`,
  `PLAYWRIGHT_MCP_PROFILE_DIR_NAME` and the `PWTEST_EXTENSION_*` test
  variables), and refuses `--browser-executable`, `--profile-dir` and
  `--cdp-endpoint` alongside it.
- The browser library briefly publishes the connected browser on a local
  pipe for its own command-line tools and records it in a private runtime
  registry. Its exported factory offers no way to omit that brief window.
  ToolsEngine requires the pipe and registry entry to be removed before acting;
  if unbinding fails, it disconnects and refuses the connection. Cancellation
  and server shutdown revoke pending approvals and disconnect live connections
  without closing your browser or tabs. A late approval cannot reconnect to
  the stopped relay; ending a live connection asks for approval on the next
  browser call (unless you chose the startup token).
- Sharing a tab grants browser/session access; it is not approval of every
  subsequent action or transmission. The client must enforce the task and
  consequential-action approvals. Observations can expose private data or
  credentials; ToolsEngine has no protected secret-entry observation pause.
- The release includes `app/tests/browser-extension.test.js` and its browser
  test support module. They test synthetic profiles, the bundled relay with
  browser launch intercepted, and test-owned browsers; they do not prove that
  a real signed-in Chrome or Edge extension workflow was verified.

## Boundaries

To use already signed-in Windows apps without restarting them, add
`--desktop-profile-root C:/Users/YOUR_CURRENT_ACCOUNT` at startup. This selects
the current account boundary and helper temp directory; it never imports
browser cookies or profile data. The adapter verifies the target process's
Windows SID and interactive session before reading its UI. It leaves out
password fields and applies the protected-page rule described below.

Windows of the following programs are not listed. The adapter goes by the
name of the program, so this is a list of names and not a recogniser of
terminals: Command Prompt (`cmd`), Windows PowerShell (`powershell`), the
PowerShell ISE (`powershell_ise`), PowerShell 7 (`pwsh`), Windows Terminal
(`wt`, `windowsterminal`), the console host (`conhost`), File Explorer
(`explorer`), Total Commander (`totalcmd...`), Registry Editor (`regedit`),
Management Console (`mmc`), Task Manager (`taskmgr`), the elevation prompt
(`consent`), the Windows credential prompt (`credentialuibroker`), the sign-in
screen (`logonui`), apps running as `electron`, and ToolsEnabled apps
(`toolsenabled...`). Any other terminal program, for example mintty, ConEmu,
PuTTY or the terminal inside an editor, is listed like any other app and can
be read and operated when it is open.

`desktop.inspect`,
`desktop.capture`, `desktop.act` and `desktop.pointer` operate existing apps.
Add `--desktop-left-half` to place an action's target window on its monitor's
left half when foreground focus/keyboard input is required: the window is
restored if it was minimised or maximised, moved to the left edge and resized
to half the width and the full height of the work area. Inspection,
capture and UIA invocation/value replacement do not take over the pointer or
automatically reposition the window. Prefer background browser/API operations;
foreground desktop input is a fallback only when needed. Screenshot clicks use image coordinates, a 30-second single-action
frame, and unchanged window identity, title and geometry; a different window at the input point is refused. Pixels and page content are not compared, so a button can change meaning without being detected.
Refresh inspection after navigation. No global input loop runs in the background.

`desktop.pointer` moves the person's real mouse cursor and never moves a
window. With `--desktop-left-half` it refuses unless the window already lies
in the left half of its monitor's work area; `desktop.act` with kind `focus`
places it there, after which the window must be captured again. When the
Windows helper refuses a request for a reason of its own, such as "Window is
outside the left half of its monitor...", the assistant receives that sentence.
Errors that come from Windows or from the application are replaced by one
generic sentence, because they can carry window content. `desktop.act` reports
`completed` when the request was delivered; it does not verify the effect.

### The protected-page rule

The desktop tools carry one built-in rule that withholds windows and controls
by their title or label. It came with the adapter, from the ToolsEnabled
desktop app. By default the full rule below applies. An owner may start the
server with `--desktop-allow-sign-in` (requires `--desktop-profile-root`) to
permit the words "sign in" and "log in" in Chrome and Edge titles and labels.
This enables authorized account choosers and sign-in controls; it does not
log in automatically, import another browser's cookies, or disable the other
protected terms, password-field exclusions, account/session checks or stale
target checks. A tool call cannot enable this startup option.

The window inventory includes counts of excluded windows and inspection
errors, without their titles or content. If no eligible browser window exists,
it explains that a dedicated browser profile does not share everyday sign-ins.
An empty inventory is not proof that the browser is signed out.

**What it matches.** A window title or a control label matches when it
contains one of the following, in any letter case, anywhere in the text and
also inside a longer word:

| Word | Also matched, for example |
| --- | --- |
| password | "Passwords" |
| passcode | |
| credential | "Credentials" |
| api key | "apikey", "API_KEY", "api-key" |
| secret | "Secretary" |
| sign in | "signin", "sign-in", "Signing", "Designing" |
| log in | "login", "log-in", "Logging", "Blogging", "Catalog index" |
| permission | "Permissions" |
| confirm | "Confirmation" |
| approve | "Approved" |
| accessibility | |

The exact pattern is
`password|passcode|credential|api.?key|secret|sign.?in|log.?in|permission|confirm|approve|accessibility`,
where `.?` allows one optional character of any kind.

**What it does.** It blocks reading as well as acting.

- A Chrome or Edge window whose title matches (a browser window's title is the
  title of its active tab) is listed as "Restricted browser tabs". Its other
  tabs can be listed and one of them selected. Everything else is refused for
  that window: listing controls, reading text, capturing a picture, clicking,
  typing, scrolling, focus and pointer input. Tabs whose own title matches are
  not listed. After selecting a tab whose title does not match, inspect again;
  the window is then an ordinary window.
- A window of any other application whose title matches is not listed at all,
  so nothing can be read from it or done to it.
- In every inspected window, a control whose label matches (a button named
  "Confirm" or "Approve", a "Sign in" link, a "Password" field) is not listed,
  so `desktop.inspect` cannot read it and `desktop.act` cannot operate it.

**What it does not do.** It reads titles and labels, not content. A page that
shows a credential under an unmatched title is not recognised, and
`desktop.capture` then returns it as shown. The label filter applies to
`desktop.inspect` and `desktop.act`; `desktop.pointer` clicks by position in
any window that is not restricted, whatever the control under the point is
called.

**What the assistant is told.** Whenever the rule withholds something, the
result names the word that matched, one of the eleven above, with a flag
`insideLongerWord`. It never repeats the title or the label.

- Window list: `withheldByProtectedRule` gives the number of windows left out
  and their matched words. No title, handle or application name is included.
- Restricted browser window: `protectedTerm` and a `diagnostic` sentence, and
  the same sentence in every refusal for that window, for example: Protected
  browser page detected: the active tab title contains the protected word
  "confirm".
- Controls of an inspected window: `withheldByProtectedRule` gives the number
  of controls left out and their matched words.

Desktop access is a standalone MCP capability explicitly enabled by its owner.
It uses the Windows adapter of the ToolsEnabled desktop app with documented
bounded additions; it does not reuse or claim that app's grant, indicator and
stop-key protocol.
The client must authorize consequential actions. Closing the MCP stops access.
Linux browser, workspace and web tools remain supported. Linux native desktop
input is not included in this release; requesting Windows desktop there fails
clearly instead of silently claiming access.

Workspace paths are checked for containment, links and file bounds. Hidden
files are not treated specially: `workspace.list`, `workspace.read_file` and
`workspace.write_file` work on them like on any other file, so a `.env` kept
in the workspace can be read. `workspace.search` skips hidden folders, and
browser uploads refuse hidden files. Choose a workspace that holds nothing the
assistant should not read. Existing-file writes require the last-read SHA-256. These checks are
guardrails, not an OS sandbox or a guarantee against a hostile concurrent local
process changing filesystem objects between checks.

The CLI places browser temporary state under `.toolsengine-runtime/tmp` in the
selected workspace before loading Playwright. Browser artifacts go under
`artifacts/toolsengine` by default; explicit filenames resolve within the
workspace. A persistent profile holds its own login state.

An installed Chrome on Linux keeps two things outside its profile folder, and
so outside the temporary profile ToolsEngine gives it. Its crash-report
database (`Crash Reports`, with the upload-consent flag) goes under the
account's configuration folder, which it takes from `XDG_CONFIG_HOME`, not
from the profile option, and it opens that database with crash reporting
switched off as well: a browser started by ToolsEngine would share it with
your everyday Chrome, or create `~/.config/google-chrome` where there is
none. ToolsEngine therefore gives the browser process a configuration
folder of its own, `.toolsengine-runtime/xdg-config` in the workspace, and
nothing is written under `~/.config/google-chrome`. The same folder stands
in for the account's other settings under `~/.config` that the browser looks
for (fontconfig, user-dirs, dconf), which therefore do not apply to it. The
user NSS certificate
store (`~/.local/share/pki/nssdb`) is still opened by that browser, read and
write, so CA certificates and client certificates installed there apply in
ToolsEngine's browser too. This was observed with Google Chrome on Linux;
Microsoft Edge, Playwright's own Chromium, Windows and macOS were not checked
and may differ.

One exception, outside Windows: an installed Chrome or Edge opens a socket in
its temporary directory, and a socket path cannot be long. When the workspace
path is too long for it, the browser process alone is given a private
directory. On Linux that directory is under
`.toolsengine-runtime/tmp/browser-sockets-...` in the workspace; the browser
uses a short `/proc/<server-pid>/fd/<directory-fd>` spelling to reach it. It
is removed when the browser closes. Other Unix systems use a private
`/tmp/toolsengine-browser-...` directory. The browser profile stays in the
workspace. A server that is killed outright cannot remove its directory; its
name carries the server's process number, and the next server that needs
one removes those whose server is gone.

`web.fetch` only accepts public HTTPS destinations by default, revalidates DNS
and redirects, verifies the site's certificate, and caps time and response
size. The certificate check is asked for by name in every request, so it stays
on when `NODE_TLS_REJECT_UNAUTHORIZED=0` is in the environment the server was
started with; `NODE_EXTRA_CA_CERTS` still adds trusted certificates, as Node.js
documents. The startup-only
`--allow-local-network` option permits HTTPS intranet destinations for that
fetch tool. Browser HTTP(S) navigation has normal browser network access,
including local development apps; this flag does not restrict the browser.

No direct shell API, arbitrary JavaScript evaluation, cookie/storage dump, credential-store,
financial, consent-changing, remote-execution or agent-spawn tools are offered.
Standalone Firefox's explicit opaque credential handoff is described above.
UI input into eligible terminal-like applications can execute commands. The name denylist does not prevent all command execution. The same explicit tool map governs discovery and dispatch. Browser clicks and
typing can still send messages, submit forms or make purchases; the client and
user must authorize those actions. Webpages/files are untrusted content.

## Data, storage and stopping

Tool results go to the MCP client. File text, page snapshots, window text and
unredacted images may therefore be sent to the host/model provider and retained
in its conversation or logs. ToolsEngine cannot determine that provider's
retention or enforce its privacy settings. Choose a workspace and selected
pages/windows whose contents you intend to disclose.

Web requests disclose the requested URL and network metadata to their
destination. Browser traffic can disclose typed text, uploaded files and
cookies from the selected session, and reach private networks. Desktop input
can cause the selected application to transmit data. Installed browsers can
also contact their makers independently of ToolsEngine.

The installer retains installation records and its printed log beside each
installed version. Screenshots, PDFs and downloads remain in the workspace,
with the limits described above and no automatic retention sweep. Of the
page snapshots that browser calls write by themselves, the newest 64 remain;
ToolsEngine deletes the older ones. Dedicated profiles keep sign-ins; temporary profile state is discarded
when the owned browser closes, which an orderly stop of the server (the
client closing the connection, SIGTERM) includes. A server that is killed
outright cannot do that: the browser's temporary profile and artifacts
folders (`playwright_chromiumdev_profile-...` and `playwright-artifacts-...`
under `.toolsengine-runtime/tmp` in the workspace) then stay behind, with
that session's cookies in the profile, until you delete them; they carry no
mark of which server made them, so no later server removes them. Desktop
captures are returned over MCP without
a separate image-file log. Uninstall preserves the workspace and does not
erase retained profiles or the host's conversation or logs.

To remove saved browser output, delete the chosen artifacts and explicit output
files from the configured workspace. Their missing entries are pruned from
quota accounting at the next operation. Clear a dedicated ToolsEngine profile
only after closing its browser and reviewing which sign-ins will be lost.
Deleting these local files does not erase the host's conversation or logs.

A cancelling MCP client can revoke a queued or running request; shutdown
refuses pending calls and interrupts active browser/desktop work. Already
delivered input may have applied. This package has no package-provided on-screen
indicator or emergency stop key. Use a supported host's visible controls and
verify their behavior before enabling control. No per-action approval or
sensitive-entry takeover is enforced here. Security and support contact:
<support@toolsenabled.ai>; the security policy, with its safe harbor for
good-faith research, is <https://toolsenabled.ai/security/>, stated for this
package in `SECURITY.md`.

## Verification

From the source checkout (tests and development tools are not in the npm payload):

```sh
npm test
npm run audit:package
npm audit --omit=dev
```

`npm run audit:package` packs the package and refuses anything but its listed
files, scans them for internal material, and compares both tool catalogues
with the running server and with `reference/curation.json`, the record of
the decision taken for each of the 261 tools of the public ToolsEnabled
engine. In the source repository that record is kept beside the package, and
the copy in the package tree is checked against it.

npm writes each file's permissions into the package as the checkout has
them, and the audit refuses a file that other accounts could not read after
a normal installation. Run it in a checkout made with the usual umask 022.
A checkout made under umask 077 fails it with "File not readable after
normal shared installation"; `chmod -R a+rX .` in the checkout, or a new
clone after `umask 022`, fixes that.

The browser suite uses its own headless browser and local fixture pages. It
checks navigation, form entry, inline snapshots, screenshot/PDF files,
close/reopen, and preservation of tabs when detaching from a CDP fixture.
The browser tests run with the sandbox on, by default in the Chromium that
Playwright downloads. Where that browser cannot run, a plain `npm test` still
passes: the tests that open a page are skipped, and each skip says why and
what to set. That is the case on a Linux system where Playwright's Chromium
cannot set its sandbox up (Ubuntu 23.10 and later), and on a machine that
does not have the pinned Chromium build. Tests that need an installed Google
Chrome or Microsoft Edge are skipped in the same way where there is none
("needs an installed Google Chrome", "needs an installed Chrome or Edge").
To run them there:

```sh
TOOLSENGINE_TEST_BROWSER=/opt/google/chrome/chrome npm test    # an installed Chrome or Edge, sandbox on
TOOLSENGINE_TEST_NO_SANDBOX=1 npm test                         # Playwright's Chromium with --no-browser-sandbox
```

On Windows, set `TOOLSENGINE_TEST_BROWSER` to the path of the installed
Chrome or Edge in the same way.

`tests/browser-view.integration.test.js` checks `browser.show` and
`browser.hide` with the real programs, on two private Xvfb displays, one of
which stands in for the person's screen; it never uses the display the tests
were started from. It needs Xvfb, xdotool, xwininfo and TigerVNC;
`TOOLSENGINE_TEST_VNC_ROOT` may name an unpacked `usr` folder of the TigerVNC
packages. Its hidden-Firefox check also needs `TOOLSENGINE_FIREFOX_LIVE=1`. On
Linux the release build requires all three of its checks to pass.

`npm run build:release` runs the whole suite first and builds nothing unless
every test passes and the browser tests ran: a run in which they were skipped
does not count. The build has no option to leave the tests out.

An installed release can be checked from outside with two more tools from the
source checkout. `tools/verify-install.mjs --installed INSTALLED --cert C --key K`
starts the installed server over stdio and calls `system.status`,
`workspace.list`, `web.fetch` and the browser against pages it serves itself
on 127.0.0.1. `tools/no-network.cjs`, preloaded through `NODE_OPTIONS`, makes
a Node.js process refuse and log every use of the network; an install run
under it shows that installing needs none.

The Windows installer requires a fixed local NTFS volume. It checks drive type before opening each existing directory component and queries the actual opened handle's filesystem before creating any missing private directory. Mapped/network, removable and other filesystems refuse with no fallback. Native acceptance of this candidate remains pending; source parsing and Linux tests do not establish Windows support.

### Tested platforms and known limits

- Windows native regression environment: Windows 10 Pro 22H2 build 19045, Node.js 22.14.0 and Windows PowerShell 5.1.19041.6456. Inert desktop fixtures and source security checks are separate from owner GUI acceptance. Windows 11 and macOS are untested. Linux uses Node.js 22; browser tests use private headless Chromium.
- The Windows desktop tools exist on Windows only. There is no Linux or macOS
  desktop input.
- Browser tests are headless; where a headed window appears on screen is not
  automated or checked.
- `browser.show` and `browser.hide` are checked on private Xvfb displays
  without a window manager, with TigerVNC 1.13.1, Google Chrome and Firefox;
  not yet on a person's real desktop with a window manager, nor under XWayland.
- ToolsEngine ships no browser extension of its own. `--browser-extension`
  uses Microsoft's Playwright Extension, installed by the person from the
  Chrome Web Store, and its tests use stand-ins: a real signed-in Chrome or
  Edge extension workflow was not verified (see "Your everyday browser, with
  your approval").
- The filesystem checks do not defeat a hostile local process racing path
  components. Use an OS sandbox when that threat applies.
- Browser network access is ordinary browser access, private networks
  included. Only `web.fetch` has the public-address checks.
- `web.extract` is a bounded tokenizer, not a full HTML rendering engine.
- The Playwright dependency contains capabilities this server does not offer.
  The positive list limits what this MCP interface exposes; it does not remove
  code from the dependency.
- Queued calls are refused once shutdown starts; active browser/desktop work is interrupted.
  A browser action already delivered cannot be rolled back.
- There is no per-action confirmation, no on-screen "being controlled"
  indicator and no emergency stop key in this package. The MCP client's
  approval settings are the only check before an action.

The browser dependency is pinned to Playwright MCP 0.0.83 and its matching
Playwright 1.64.0-alpha build. Changing this pin requires rerunning schema,
lifecycle and browser tests; upstream tools never become public automatically.

## Changes in 0.2.0-alpha.4 (unreleased)

- Fixed, Linux: `--firefox-hidden` works with AT-SPI 2.62, which reports
  buttons with the role "button" instead of "push button". The Firefox helper
  reads both as "push button", so snapshots, clicks and `browser.find_control`
  (role "push button") behave the same on either version; the tool schema is
  unchanged. Before, `browser.find_control` could not find a button there.
- Fixed, Linux: two `--firefox-hidden` browsers started at the same moment no
  longer take the same private display number. The one whose Xvfb lost the
  number moves to the next, instead of starting a Firefox that never appeared.

- New, Linux: `browser.show`, `browser.hide` and `browser.visibility` show the
  hidden browser live in a window on the person's screen, where they can
  watch and use it, and hide it again, without restarting or reloading it.
  Offered with the new startup option `--private-display` (ToolsEngine's own
  Chromium, headed on a private authenticated Xvfb) and in `--firefox-hidden`.
  The default headless mode and its tool list are unchanged. See
  [docs/browser-show-hide.md](docs/browser-show-hide.md).
- Changed, Linux: `--firefox-hidden` keeps every dialog and notification in
  its hidden session. Firefox and its helper use a private session bus and
  accessibility bus instead of the person's, and the dedicated profile keeps
  the file chooser, print, notifications and downloads in Firefox on its
  private display, where `browser.file_upload` answers the chooser and
  `browser.show` shows them; links are not handed to other applications. See
  [docs/hidden-firefox.md](docs/hidden-firefox.md).

## Responsive layout checks (new in 0.1.3)

`browser.resize` sets the selected tab viewport, using integer CSS pixels: width 320–3840 and height 240–2160. For a narrow layout, use `{"width":390,"height":844}`; then inspect a fresh snapshot or screenshot. It preserves the page and other tabs. The selected tab in an explicitly attached browser is affected too. This is responsive viewport sizing, not phone, touch, user-agent or operating-system window emulation. No new browser connection, profile, arbitrary script, or credential access is added.

## Changes in 0.1.8 (Windows port candidate)

- New Windows program and workspace folders receive protected DACLs before
  files are copied. Existing program roots with untrusted owners or write
  permissions are refused; their ACLs are never rewritten. Existing workspace
  access is reported. Junction and nonlocal namespace paths are refused.
- Desktop focus raises only the confirmed window without moving/resizing it,
  rechecks foreground and window identity, and never asks a top-level UIA
  provider for keyboard focus. Selected fields receive a bounded exact-identity
  focus wait. Helper-owned stage diagnostics omit provider exception text.
- Control inspection prioritizes nested dialogs within fixed enumeration
  bounds, deduplicates runtime identities, and exposes text input only on
  writable ComboBoxes. Pointer refusals distinguish held input, obscured or
  changed targets and uncertain delivery without exposing provider text.
- Inert native regression fixtures and native DACL/junction tests accompany
  the changes. Windows interrupted-install recovery remains deliberately
  refused; use the matching archive's documented manual recovery route.

## Changes in 0.1.7 (2026-10-13)

A patch release of 0.1.6, from a fresh-user verification of 0.1.6. The
server offers the same 27 tools.

- A `--browser-executable` path that does not exist is refused at startup,
  as a missing channel browser already was. Before, the server started with
  that path, the client showed it as connected with every browser tool, and
  the first browser call failed with the browser library's own text
  ("browserType.launch: Failed to launch chromium because executable doesn't
  exist at ..."). Now the server does not start: it writes
  "--browser-executable names PATH, which does not exist." (or "... is not a
  file." for a folder, or "... must be an absolute path" for a relative one)
  with the ways out to its error output and exits 1, and Claude Code shows
  "Failed to connect" with the reason in its MCP log. A path that exists is
  taken as before.
- `INSTALL.txt` in the archives names `--home DIR` among its options and says
  that `~/ToolsEngine` (`C:\Users\YOU\ToolsEngine`) is the account's own
  profile even when `HOME` (`USERPROFILE`) points elsewhere; that the
  installer runs a client only when that home is the account's own profile
  and `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, if set, point inside it; and that
  otherwise it prints the two client commands and, with `--register`, ends
  with exit code 2. The installer's printed guidance in that case says that
  the install is complete, why the exit code is 2 and that `--home` plays no
  part in it; `--help` says the exit code too. (The README said all of this
  since 0.1.5; the archive's first file and the installer's own output did
  not.)
- The description of `workspace.write_file` says in so many words that it
  does not create folders and why: a mistyped or invented path must not grow
  a tree of folders in your workspace, and `workspace.list` shows the folders
  that exist. The behaviour is unchanged since 0.1.6, and the "Tools"
  section above explains the choice.

## Changes in 0.1.6 (2026-10-13)

A patch release of 0.1.5, from a code review of 0.1.5. The server offers the
same 27 tools.

- A browser call that had already clicked, typed or navigated was reported
  as an error ("Saved artifact size or number limit reached; nothing was
  saved." or "Another artifact writer is active ...") when the page-snapshot
  file written after it could not be saved. The page had changed, and the
  error invited the assistant to repeat the action: to place an order or
  send a message twice. Now the call's result stands, and it says that the
  action was carried out and only its snapshot file was not saved.
- Automatic page snapshots are no longer kept forever. Before, the 256-file
  limit filled after about 256 browser calls in a workspace that is kept,
  and from then on every browser call failed that way, `install.mjs check`
  included. Now the newest 64 (within 16 MiB) are kept and older ones are
  deleted, when a new one is written and when the server starts, so a
  workspace that 0.1.5 filled keeps only its newest 64 after the first
  start. Files saved under a name given to a tool, screenshots, PDFs, logs,
  downloads and files you put there are never deleted.
- A write waits up to 2 seconds for another ToolsEngine on the same
  workspace that holds the output lock, instead of being refused at once.
- `workspace.search` no longer fails as a whole when a file or folder in
  the tree has a name that Linux allows and Windows does not (a colon, as
  in `server-2026-10-13T10:00:00.log`, a trailing dot or space, a device
  name such as `aux.c`). It passes them by and counts them as
  `nonPortableNames`.
- Case-insensitive `workspace.search` reports the column in the line as
  written on lines that contain letters whose lower case is longer, such
  as the Turkish "İ".
- `web.extract` finds the end of a script or a style on pages that contain
  "İ": script source no longer comes out as text there, and the text after
  a style is no longer lost.
- `install.mjs uninstall` no longer stops with "ReferenceError: unexpected
  is not defined" after removing the files when a leftover folder cannot
  be read. It names the folder as unreadable and goes on to name the
  workspace and the commands that remove the client registrations.
- `workspace.write_file` writes names of up to 255 bytes (its temporary file
  has a short name of its own now; before, names of about 214 to 255 bytes
  failed), and a longer name is refused with "... has a name that is longer
  than this file system allows" instead of the system's `ENAMETOOLONG`
  error with the workspace's full path. `workspace.read_file` says the same.

## Changes in 0.1.5 (2026-10-13)

A patch release of 0.1.4, from what a second new-user check of 0.1.4 found.
The server offers the same 27 tools.

- `npm test` passes on a machine without Google Chrome and Microsoft Edge,
  as this README says it does. The tests that need an installed Chrome
  (four tests of the extension relay and one of the browser start options)
  are skipped there with the reason "needs an installed Google Chrome";
  before, one failed and four ran into their time limit.
- `workspace.write_file` into a folder that does not exist says so in plain
  words ("The folder notes does not exist in the workspace.
  workspace.write_file does not create folders: ...") instead of the
  system's `ENOENT ... lstat` error with the workspace's full path. Reading
  or listing a path that does not exist says "... does not exist in the
  workspace." in the same way.
- A `--workspace` that names an absolute folder that does not exist is
  refused with "--workspace must name an existing absolute directory. PATH
  does not exist: create the folder first, or name one that exists." instead
  of the system's `ENOENT` error.
- The README's npm section says to use `--no-browser` where Chrome and Edge
  are absent: without it the server exits at startup and Claude Code shows
  only "Failed to connect".
- When the installer does not run the clients because the terminal's home
  folder is not your own profile, it no longer suggests its own `register`
  command, which is refused for the same reason. It prints the clients'
  commands only.
- The README says that `npm run audit:package` needs a checkout that others
  can read (umask 022), and how to fix one made under umask 077.
- `browser.snapshot` and `browser.find` say in their descriptions why they
  are not marked read-only although they do not change the page: with
  `filename` they add a new file to the workspace, and their first call
  starts the browser or connects to it.

## Changes in 0.1.4 (2026-10-13)

A patch release of 0.1.3, from the defects a new user found installing it
from the release page. The server and its tools are unchanged.

- The README says that `@toolsenabled/toolsengine` is not on the npm
  registry yet and shows the route that works: `npm install -g` of the
  `toolsenabled-toolsengine-VERSION.tgz` file from the release, after
  checking it against its `.sha256` file.
- The README no longer says that this route installs the dependency
  versions listed in the package's `npm-shrinkwrap.json`: `npm install -g`
  of the 0.1.4 file with npm 10.9.3 on 2026-10-13 took 92 of the 97
  packages at those versions and 5 at newer ones. The release archives
  carry exactly the tested versions.
- The install steps check the archive against `SHA256SUMS` before
  extracting it: `sha256sum -c --ignore-missing SHA256SUMS` on Linux
  (without `--ignore-missing` the check also reports the Windows archive,
  which the file lists, and exits 1), `certutil -hashfile` on Windows.
- `SECURITY.md`, the security policy with its safe harbor, is a file of the
  package (22 files now) and sits at the top of each release archive beside
  LICENSE and NOTICE; INSTALL.txt lists it. The README names the security
  and support contact, <support@toolsenabled.ai>, and the policy page in
  place of the sentence that left them to "the distributor".
- The installer answers a bare `--version` on the install command with the
  same explanation as `--version VALUE` ("--version is for register, check,
  list and uninstall...") instead of "--version needs a value".

## Changes in 0.1.3

Compared with 0.1.3-rc.5, the first public release carries the version
number and these corrections from its release review:

- `web.fetch` asks for the certificate check in every request, so it stays
  on when `NODE_TLS_REJECT_UNAUTHORIZED=0` is in the server's environment,
  and reports an over-limit body sent without a Content-Length as
  `RESPONSE_TOO_LARGE` instead of `INVALID_RESPONSE`.
- On Linux the browser process is given its own `XDG_CONFIG_HOME` in the
  workspace's runtime folder, so an installed Chrome no longer keeps its
  crash-report database under `~/.config/google-chrome` (see "Boundaries").
- Startup refuses `--browser-executable` together with `--browser-channel`,
  checks the `--cdp-endpoint` address itself and refuses the options for a
  browser ToolsEngine would start alongside it, and refuses an overlapping
  `--profile-dir` before creating its folders. The installer refuses
  `--version` on the install command instead of ignoring it.
- A browser started before the downloads folder is found tampered with is
  closed with the refusal. On Linux, socket directories left by a killed
  server are removed by the next server that needs one, and what a killed
  server leaves behind is stated. Calls still queued when shutdown starts
  are refused as shutdown, not as cancelled.
- `browser.take_screenshot` no longer lists `scale` as required; its default
  `css` stays. The release build refuses a browser test that was skipped for
  a reason it does not know.
- Documentation: the registration commands shown are the ones the installer
  prints; the tested-platforms list says what ships for `--browser-extension`;
  `docs/clients.md` and NOTICE no longer call the package a candidate, and
  `docs/clients.md` is provider-neutral.
- The README describes the npm route ("From npm"), and `package.json` names
  the repository, the home page and where to report a problem.
- `npm run audit:package` reads the curation record from
  `reference/curation.json` in the package tree when the record beside the
  source is absent, so the check runs from the public repository as well.

The candidate history follows.

## Changes in 0.1.3-rc.5

Compared with 0.1.3-rc.4:

- `--browser-extension` acts in the person's everyday Chrome or Edge, with its
  sign-ins, through Microsoft's Playwright Extension installed there. By default
  nothing connects until the person chooses a tab and approves in that browser;
  until then browser calls say they are waiting. Approving every time is the
  default; a token the person gives the server skips it, and
  `system.status` says which. See "Your everyday browser, with your approval".
- `--desktop-allow-sign-in` (the owner's change of 2026-10-10): the desktop
  tools may show and operate Chrome and Edge windows whose titles or labels
  say sign in or log in. Other protected words, password-field exclusions
  and account checks still apply. The window inventory counts excluded windows
  and inspection errors, and says when no eligible browser window is open.

## Changes in 0.1.3-rc.4

Compared with 0.1.3-rc.3:

- Browser profiles cannot equal or contain the workspace, or overlap automatic
  output/runtime folders. Temporary runtime paths are protected through aliases.
  Unavailable or ambiguous file identities refuse separation-sensitive access.
- Installer recovery checks plain parents and singly linked records before
  reading or writing. Uncertain staging owners are preserved; Linux markers
  distinguish process instances. Windows recovery refuses unverifiable ownership.
- Browser selection ignores inherited cache/debug and Windows lookup locations;
  installer registrations pin the selected executable. Failed client restoration
  omits arbitrary previous arguments, missing requested clients return failure,
  and Windows paste instructions cover expansion and invocation.
- Calls have a bounded queue/rate and propagate MCP cancellation. Saved browser
  artifacts and downloads have quotas and unique output names; existing files
  are preserved. Linux socket directories stay within the workspace.
- Tool descriptions state sign-in, credential exposure, terminal input and
  screenshot-content freshness limits. Attached tab titles omit close.
- Release builds test one file at a time, require successful browser scenarios,
  fence the test-log path, and compare packed sources and dependencies with the
  exact byte snapshot tested.

These changes do not implement per-action human approval, site or application
allow-lists, protected secret-entry takeover, or authenticated release signing.
Those require owner choices. Windows runtime/elevation was not tested for rc.4.

## Changes in 0.1.3-rc.3

Compared with 0.1.3-rc.2:

- A browser attached with `--cdp-endpoint` keeps its own way with downloads.
  ToolsEngine no longer redirects them into its temporary folder, and copies
  nothing into the workspace.
- The sentence about downloads is on every tool that loads a page or gives
  the page input.
- The refusal for want of the sandbox names the browser that failed, and
  tells the assistant that switching the sandbox off is the person's decision.
  A server started with `--no-browser-sandbox` says so in its instructions.
- `system.status` has `browserSandboxVerified`, always `false`:
  `browserSandbox` is the setting asked for, not a check.
- The server does not start with `SELENIUM_REMOTE_URL` in its environment,
  unless it runs with `--no-browser`.
- The workspace and the program folder are also compared by what the file
  system says they are, not only as text.
- The file tools, uploads and output files stay out of the browser's own
  folders in the workspace: `.toolsengine-runtime`, and a `--profile-dir`
  folder that lies in the workspace.
- Installer: `--home` decides where ToolsEngine is installed and nothing
  else; a client is not run when `CLAUDE_CONFIG_DIR` or `CODEX_HOME` names a
  folder outside your profile; `--replace` that replaced nothing ends with
  exit code 2; the changes to uninstall, to finishing an interrupted install
  and to printed commands are described under "Install".
- A plain `npm test` skips the browser tests, with the reason, where the
  browser under test cannot run. The release build runs the tests first.

## Changes in 0.1.3-rc.2

Compared with 0.1.3-rc.1:

- The browser is started with Chromium's sandbox on. Where the sandbox cannot
  be set up, the browser tools refuse with one plain message.
  `--no-browser-sandbox` is the explicit way to start without it, with the
  risk described under "The browser's sandbox". `system.status` reports
  `browserSandbox`.
- `--workspace` is refused when the workspace and the program folder would
  contain one another.
- On Linux an installed Chrome or Edge starts whatever the length of the
  workspace path.
- Tool descriptions and the server's instructions are written for the mode
  the server runs in: temporary profile, dedicated profile, attached browser
  or no browser, with or without the desktop tools. Downloads are stated.
  `desktop.inspect` names the programs it leaves out, and the PowerShell ISE
  is now one of them.
- `web.fetch` sends the version as its user agent.
- Release archives with an installer: see "Install".

### Windows foreground refusals

See [Windows focus recovery](docs/windows-focus-recovery.md) for bounded activation, safe refusal diagnostics, and recovery when an application rejects focus. Activation remains dependent on Windows and the selected application.

## Native Windows release qualification

A Windows archive built by `tools/build-release.js` is a candidate until it passes native qualification. On a signed-in Windows desktop, run `node tools/qualify-windows.js EXTRACTED_RELEASE NEW_EVIDENCE_FOLDER` from the matching source checkout. The tool checks every release file, requires matching source runtime bytes, installs to an isolated private folder, drives dedicated native test windows through the installed MCP server, and removes the installation. Its receipt binds the release manifest hash, source commit and test hashes. Any skipped, cancelled, missing or failed desktop test prevents the receipt. Publish the receipt with the Windows archive only after the complete native test suite and browser tests also pass.

The OpenAI plugin profile excludes hidden state, credential paths and protected instruction/configuration files from its project file tools. These path rules are not a general detector for sensitive content placed in ordinary files. They do not change standalone MCP file access.
