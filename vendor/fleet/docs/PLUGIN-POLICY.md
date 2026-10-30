# Vendor distribution boundaries

Reviewed October 20, 2026. This is a technical review record, not vendor approval or a guarantee of contractual compliance.

## Standalone MCP and OpenAI plugin

The standalone MCP retains its supported worker capabilities and strict inherited permissions. Its broader tool set is not automatically the plugin tool set. Using the MCP interface does not exempt software from a host's rules or from the terms of any provider it invokes.

The OpenAI plugin entry requires an explicitly selected canonical project, a matching saved Standard setup and workers off. `.codex-plugin/policy.json` fixes the reviewed tool ceiling at 27 named operations. The runtime applies that ceiling to both enumeration and execution, intersected with the existing permission and workspace restrictions. New standalone tools require a separate plugin review. There is no generic execute tool to reach excluded operations.

The plugin supports shared project tasks, ledger progress and questions, project memory, local search, and mediated project file edits. It does not start workers, change standing rules or settings, run shells, import browser credentials, read provider conversations, or offer account switching. The skill limits sensitive inputs; filesystem exclusions are not a general secret-content scanner.

Each tool carries explicit read-only, destructive and open-world annotations. Review these when behavior changes. Metadata and privacy descriptions must match the actual package. Repository installation does not mean OpenAI directory approval.

The policy basis is OpenAI's [plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines), particularly task scope, sensitive inputs, unofficial connectors, explicit tool exposure, annotations and privacy; and [plugin packaging](https://developers.openai.com/plugins/build/plugins). Remote-MCP submission requirements do not automatically apply to local stdio.

## Other vendors

The separate [Claude package](https://github.com/ToolsEnabled/toolsenabled-fleet-claude-plugin) has its own reviewed ceiling and policy record. Native CLI authentication is not permission to intermediate credentials, evade restrictions or resell access. Anthropic's [Claude Code terms guidance](https://code.claude.com/docs/en/legal-and-compliance) and [Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy) require separate review; preserve supported workers without claiming directory acceptance.

Google has an [Antigravity plugin marketplace](https://antigravity.google/docs/marketplace). The reviewed documentation does not establish an open third-party submission route. Antigravity as an MCP client is distinct from wrapping the personal Antigravity agent as a Fleet worker. Keep the latter disabled under its [FAQ restrictions](https://antigravity.google/docs/faq).

xAI has a public [Grok plugin marketplace](https://github.com/xai-org/plugin-marketplace). Its [contribution process](https://github.com/xai-org/plugin-marketplace/blob/main/CONTRIBUTING.md) requires reviewed manifests, network/credential disclosure and immutable source revisions. A future package needs its own tests and policy ceiling; no Google or Grok package or submission is included here.

## Publication gates

Source hardening can be reviewed independently of marketplace acceptance. Before directory submission, recheck current rules, metadata, privacy, test examples, host compatibility and any required developer agreements. Resolve ambiguity with the vendor rather than representing an unreviewed integration as approved. No marketplace submission, acceptance of legal terms, or provider authentication changes are performed by these source changes.
