# Windows focus recovery

The helper verifies the selected window, raises it without moving, resizing or making it topmost, then requests foreground activation. If Windows declines, the request is refused. It never invokes UI Automation focus on a top-level window: those providers need not be keyboard-focusable. For an explicitly selected field it requests field focus, then waits at most 500 milliseconds for that exact field identity while checking foreground. It rechecks foreground and window identity before input. A change to another foreground window refuses the request without typing.

A raise is not proof of foreground activation. Some providers still refuse focus. In that case, inspect and capture the confirmed window again. Where the screenshot shows a safe visible titlebar, an explicitly requested grounded titlebar click can activate it; inspect and retry focus afterward. The helper does not invent coordinates or click automatically. Pointer hit testing and current-window identity checks remain required. Do not retry text after an ambiguous input outcome.

Failures from these stages carry a bounded helper-owned code. Provider failures may include a numeric HRESULT, never provider exception text, window contents, paths or titles. Existing unrelated trusted refusal handling is preserved. Geometry failures require a new capture and new coordinates after positioning.

## Regression verification

`node --test tests/desktop-focus-native.test.js tests/desktop-native-regressions.test.js` runs inert PowerShell doubles on Windows (or with PowerShell installed elsewhere). The harness parses the actual native helper and loads only the tested functions. It makes no native UI calls. It covers activation, raise failures, native refusal without root-provider focus, identity changes, foreground races, field mismatch, diagnostics redaction, bounded nested-dialog traversal, writable ComboBoxes and pointer preconditions.

The separate opt-in live suite is `tests/desktop-live.windows.test.js`. Inert tests do not establish that every application will accept focus. Release package and browser gates remain unchanged.
