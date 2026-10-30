# Fleet V4 — 4.0.1 (internal only)

Prepared from `hillclimb/v4` commit `1b8272d`. The owner said on 2026-10-26:
"no we are not open sourcing this right now" (board 183). These packages and the
source export are internal artifacts. Publication is not authorized;
`releaseVerified` remains false and guarded publish scripts remain unrun.

Since the `57ec462` build that ran internally from 2026-10-26 21:01 UTC:

- Every Fleet-started worker turn states the current UTC time and why it started
  (`648e8b7`, integrated by `46f8caa`).
- Lead scripts can use `fleetV4.js call` for one-shot calls and
  `hub inbox --wait` for event-driven inbox waits (`c0def6c`, integrated by
  `902265a`). The lead quickstart includes the process-check correction in
  `1b8272d`.

Version `4.0.1` distinguishes this build from both earlier 4.0.0 builds.
`01cb0bb1` is withdrawn; `57ec462` is the historical internal build. See
[4.0.0 history](RELEASE-NOTES-4.0.0.md) for their checksums and earlier evidence.
Provider/platform qualification retains its recorded scope; packaging checks do
not establish new native Windows execution or full live-provider parity.
