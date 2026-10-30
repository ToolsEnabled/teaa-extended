# Fleet V4 — 4.0.2 (internal only)

Prepared from `hillclimb/v4` commit `7986eb9`. The owner said on 2026-10-26:
"no we are not open sourcing this right now" (board 183). These packages and the
source export are internal artifacts. Publication is not authorized;
`releaseVerified` remains false and guarded publish scripts remain unrun.

The only implementation change since 4.0.1 is resolved-path verification of an
attaching lead (`7986eb9`). The hub compares resolved runtime paths so a lead can
register once against a stable link such as
`~/.local/opt/fleetV4-current/runtime` and retain that registration across upgrades.
Another runtime copy, an unexpected command verb, or an unresolved path is still
refused. Setup and lead quickstart documentation describe the stable-link route.

4.0.1 was qualified with the Linux suite, byte-identical rebuilds and native
Windows qualification, but was never deployed. That qualification belongs to
4.0.1; it does not certify these new archives. See [4.0.1 notes](RELEASE-NOTES-4.0.1.md)
for wake context, lead scripting and earlier build history. The 4.0.2 build has its
own version and exact source/hash pins. Packaging checks do not establish new
native Windows execution or full live-provider parity.
