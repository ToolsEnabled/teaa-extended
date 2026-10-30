# Fleet V3 usage accounting

With `metrics.local_history` enabled, the lead can call `fleet.control`:

```json
{"action":"usage-read"}
```

The view covers retained worker attempts. It is not a whole-run bill. The
external lead's provider usage is not observed by this worker host, so `lead`
names that gap and `wholeRun.tokens` and `wholeRun.cost` remain null. No model
price, subscription quota or unreported cost is inferred.

Filter by `nodeId`, job `id`, or `expectedTaskRevision`. For attempt details use
`view: "full"`, `offset` and `limit` (1–1000). Continue with `page.nextOffset`
and carry the returned `revision` as `expectedMetricsRevision`. This revision
is independent of the control revision; usage reads do not mutate tasks.

Each token field contains its measured subtotal `known` (null if none),
`measuredAttempts`, `unknownAttempts` and `complete`. Only terminal attempts
with complete measurements can contribute complete coverage. A subtotal is
not a complete total when an attempted request lacks measurements. A numeric
zero is shown only when measured. Failed attempts count. Duplicate snapshots
replace the preceding snapshot rather than adding it again. Full records
retain attribution, status, sample coverage and accounting issues.

Codex can create native child agents inside a Fleet worker. Their usage is not
the parent thread's usage. When the adapter observes that activity, it records
`native-child-usage-unobserved` for the exact parent attempt; duplicate child
events do not add tokens or duplicate that issue. `coverage.nativeChildAttempts`
counts affected selected attempts. The parent's known subtotal remains visible,
but its fields cannot be marked complete. Child completion never completes or
changes the parent task. This gap survives storage/reconstruction and applies
only after the parent turn identity is confirmed.

This signal does not collect all native-child counters, establish coverage for
every provider, or repair histories recorded by earlier runtimes. Absence of a
signal is not proof that a provider exposed all delegated work. Reconcile native
children separately before claiming whole-run usage.

Provider semantics differ:

- Codex thread totals are cumulative. Fresh conversations start at zero;
  resumed conversations need an observed baseline. The first resumed sample
  without one is unknown, not the lifetime total charged to a new task.
  Unmeasured sends invalidate the baseline for the following task. `last`
  is not assumed to measure an entire multi-request turn. Counter resets
  remain visible as unknown deltas.
- Anthropic ordinary input, cache reads and cache creation are separate.
  Input totals require all three measurements; missing cache fields are not
  invented zeros.
- OpenAI-compatible input includes its cache breakdown. Reasoning and cache
  subsets are preserved without adding them to the token total twice.
- ACP prompt usage is retained as reported. Its context occupancy (`used` /
  `size`) is not consumed tokens. Session cost snapshots are retained by
  currency, with no conversion or job allocation; they can include earlier
  work. ACP's draft component semantics do not justify recomputing totals.
- API multi-request turns retain measured earlier rounds when a later request
  fails, times out, returns no usage, or returns an invalid tool response.
  Per-field coverage indicates partial measurement. Contradictory numeric
  reports remain inspectable evidence with incomplete coverage.

Lost writes, disabled recording and legacy unbound events make coverage
incomplete. The host attempts to record before each send and keeps uncertain
sends visible. It accepts usage only for the current provider turn; late
unbound events are not guessed onto a new task. A hard process crash can
leave an in-progress attempt unknown. A failed telemetry write followed by
process death can lose its in-memory gap count; this is not a lossless billing
ledger. Provider traces remain separate; numeric history excludes response
prose, request bodies and credentials.

For evaluation, collect lead usage independently from its actual provider,
retain every attempt, and report incomplete coverage. Combine only measured
values with compatible semantics. Neither synthetic fixtures nor this view
establish a cost advantage or correct model results.

Protocol references: [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
[OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[Codex cumulative accounting](https://github.com/openai/symphony/blob/main/elixir/docs/token_accounting.md),
and the [ACP end-turn usage draft](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/rfds/end-turn-token-usage.mdx).
