# Showing the hidden browser (`browser.show`, `browser.hide`)

ToolsEngine's browser can run hidden while the assistant works, and be shown
to you on request: a window appears on your screen with that same browser,
live, and you can watch it and click and type in it. Hiding it again closes
the window. The browser itself never restarts, moves or reloads: its tabs,
pages, cookies and sign-ins stay as they are, and the browser tools go on
working in it while it is shown and after it is hidden.

This is useful when a person has to do something in the browser that the
assistant should not, or cannot: sign in, approve a payment, answer a
check, or just watch what the assistant is doing.

## Where it is offered

| Browser mode | Offered | How |
| --- | --- | --- |
| ToolsEngine's own Chromium, Chrome or Edge with `--private-display` (Linux) | yes | start ToolsEngine with `--private-display` |
| Hidden Firefox, `--firefox-hidden` (Linux) | yes | always, in that mode |
| Default headless Chromium | no | a headless browser has no window to show; use `--private-display` |
| `--headed` | no | the browser is already a window on your screen |
| `--cdp-endpoint`, `--browser-extension` | no | that browser keeps its own windows |
| Windows, macOS | no | see "Limits" below |

```sh
node /absolute/toolsengine/bin/toolsengine.js --workspace /absolute/project --private-display
# with an installed Chrome:
node /absolute/toolsengine/bin/toolsengine.js --workspace /absolute/project --private-display --browser-channel chrome
# with an installed Microsoft Edge:
node /absolute/toolsengine/bin/toolsengine.js --workspace /absolute/project --private-display --browser-channel msedge
```

`--private-display` works with the temporary profile and with `--profile-dir`.
It cannot be combined with `--headed`, `--cdp-endpoint`, `--browser-extension`,
`--firefox-hidden` or `--no-browser`, and the OpenAI plugin profile refuses it.
The installer does not add it; put it in the client's MCP registration.

## The tools

- `browser.show` `{ viewOnly?: boolean }` opens the window on your screen.
  With `viewOnly: true` you can watch, and your mouse and keyboard do not
  reach the browser. Showing a browser that is not running starts it first.
  Showing again changes nothing; showing with the other `viewOnly` replaces
  the window.
- `browser.hide` `{}` closes the window. Doing so when nothing is shown
  changes nothing.
- `browser.visibility` `{}` changes nothing and reports the state.

Each returns the state, for example:

```json
{ "visible": true, "viewOnly": false, "since": "2026-10-22T08:14:22.482Z", "personDisplay": ":0" }
{ "visible": false, "lastHidden": { "reason": "browser.hide", "at": "2026-10-22T08:14:23.297Z" } }
```

`lastHidden.reason` is `browser.hide`, `window-closed` (you closed the
window, or its display went away), `browser-closed` (the browser closed, for
example with `browser.close`, or a cancelled browser call closed it),
`view-server-stopped`, `shown-again` (shown again with the other `viewOnly`)
or `server-closed` (ToolsEngine stopped). `system.status` carries the same
state as `browserView`, and in `--private-display` mode reports
`browserWindowMode: "private-display"` and
`browserWindowVisibility: "hidden-until-shown"`.

You can close the window yourself at any time; that is a hide. To show it,
ask the assistant ("show me the browser"). The server's instructions tell
the assistant to show it only when you ask to see or use the browser, and
to take a fresh page snapshot before acting after you may have used it.

## How it works

The browser runs on a private X display, never on yours:

- **ToolsEngine's Chromium** (`--private-display`) runs with real windows on
  an Xvfb that ToolsEngine starts for it, at 1300x820. Only holders of a new
  random cookie, in a file only your account can read, can connect to that
  display; it has no TCP listener and no abstract socket; its display number
  is never yours; and it ends by itself when its last client has gone. The
  browser is given that display and nothing of your session: no Wayland
  compositor, no session bus (so a page cannot raise a desktop notification,
  and the browser does not reach your keyring or portals), and its sound is
  muted, as a headless browser's is. Nothing appears on your screen, nothing
  takes your focus, no taskbar entry appears.
- **Hidden Firefox** already runs on its own authenticated Xvfb
  ([private Firefox](hidden-firefox.md)); `browser.show` shows that display.

`browser.show` starts two programs, and nothing else:

1. TigerVNC's scraping server (`x0vncserver`), attached to the private
   display. It listens on a Unix socket in a new folder only your account can
   enter (mode 0700, the socket 0600) and on no TCP port (`-rfbport=-1`);
   ToolsEngine checks `/proc` after it starts and stops it if it has opened
   any TCP listening socket. It requires a VNC password: eight random
   characters, new for every showing, in a file in that folder (mode 0600).
   It takes one viewer: while one is connected, any other connection is
   refused, even with the password. It ends by itself 30 seconds after its
   viewer has gone, should ToolsEngine be killed.
2. TigerVNC's viewer (`vncviewer`), on your display, connected to that socket
   with that password. Its window is titled "ToolsEngine browser - TigerVNC".
   It shares no clipboard in either direction: what you copy elsewhere does
   not reach the browser, and nothing the browser copies reaches you. It runs
   with a private home folder, so it reads none of your VNC settings and
   writes no connection history.

By default both programs are taken from `/usr/bin`, `/usr/local/bin` or
`/bin`, never from `PATH`, and only if their help text says they are TigerVNC's.
An explicit `--browser-view-runtime` selects a local package prefix instead,
as described below.
Each is given a small environment of its own with only the display it needs.
`browser.hide` stops both by the process numbers ToolsEngine started and
removes the folder. Your display is the one ToolsEngine was started with
(`DISPLAY`, with `XAUTHORITY` or `~/.Xauthority`): a local display, or one
forwarded by `ssh -X` to this computer's loopback. A display on another host
is refused, because it would carry the browser's pixels and your keys over
the network unencrypted.

## Requirements

Linux with an X11 desktop, or Wayland with XWayland (the viewer is an X11
program), and:

```sh
sudo apt install xvfb tigervnc-scraping-server tigervnc-viewer   # Debian, Ubuntu
```

Other distributions package TigerVNC's `x0vncserver` and `vncviewer` under
other names. Without them `browser.show` says which program is missing and
shows nothing; the browser keeps running hidden. Installing software is your
decision; the assistant is told not to do it for you.

When administrator installation is unavailable, `--browser-view-runtime
/absolute/unpacked/usr` selects a local copy of the distribution packages.
That prefix must contain `bin/X0tigervnc` (or `bin/x0vncserver`) and
`bin/xtigervncviewer` (or `bin/vncviewer`). Optional `lib/x86_64-linux-gnu`
or `lib/aarch64-linux-gnu` libraries are used only by those two programs.
The prefix, directories and programs must belong to the current account or
root, must not be symlinks or writable by other accounts, and the programs
must identify themselves as TigerVNC. This explicit option never downloads
packages or searches PATH. It is available only with the two private browser
modes; the OpenAI plugin profile continues to refuse browser configuration.

For a launcher invoked over SSH, pass the graphical session's `DISPLAY` and
`XAUTHORITY` to ToolsEngine. On GNOME Wayland these are available from
`systemctl --user show-environment`; the viewer uses XWayland. A missing or
stale authority file can prevent the visible window from opening even when
the browser itself is running correctly on its private display.

## Limits

- Linux only. On Windows and macOS `--private-display` is refused at startup
  and `--firefox-hidden` is Linux-only already. Windows would need a
  separate hidden desktop and a viewer for it; neither exists here.
- Wayland without XWayland, and a ToolsEngine started without your screen
  (no `DISPLAY`, for example as a background worker), cannot show the
  browser; `browser.show` says so.
- The window shows the whole private display. ToolsEngine's Chromium opens
  each tab in its own window there, one above another; a new tab opens in
  front, and selecting a tab with `browser.tabs` asks the browser to bring
  its window to the front. There is no window
  manager on the private display, so its windows cannot be moved or resized
  from the viewer. A page viewport made larger than the display with
  `browser.resize` is cut off in the window.
- While the window is shown, your input reaches the same pages the assistant
  acts on. Neither of you can stop the other; agree who acts.
- The VNC password guards the socket in addition to its file permissions. It
  is not a boundary against your own account: any program running as you can
  read it, and could equally use the browser's display cookie or its profile.
- If ToolsEngine is killed while the window is shown, the window stays until
  you close it; the browser behind it is gone (Chromium) or stays for the
  next connection (hidden Firefox, as before).
- Audio is not carried to the window; ToolsEngine's Chromium is muted.

## Checking it

Development checks use only private Xvfb displays, one of which stands in for
the person's screen:

```sh
TOOLSENGINE_TEST_BROWSER=/opt/google/chrome/chrome node --test tests/browser-view.test.js tests/browser-view.integration.test.js
TOOLSENGINE_FIREFOX_LIVE=1 node --test tests/browser-view.integration.test.js
```

`TOOLSENGINE_TEST_VNC_ROOT` may name an unpacked `usr` folder of the two
TigerVNC packages when they are not installed. The Linux release gate
requires the three live checks of `tests/browser-view.integration.test.js`
to pass.
