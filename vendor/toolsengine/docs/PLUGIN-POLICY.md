# Vendor distribution boundaries

Reviewed October 20, 2026. This records technical controls and remaining publication decisions; it is not vendor approval.

## OpenAI package

The fixed launcher uses `--plugin-profile openai --no-browser`. The server validates that profile before initializing browser or desktop components and exposes exactly eight reviewed tools: `workspace.list`, `workspace.read_file`, `workspace.write_file`, `workspace.search`, `web.fetch`, `web.extract`, `system.status`, and `capability.find`.

The same selected registry controls listing, discovery and execution. Direct calls to excluded operations fail. The profile refuses private-network access, browser/profile options, desktop sign-in and desktop control. Future standalone tools cannot silently enter the plugin. The launcher also verifies the installed runtime files against its packaged source, including the policy module.

Project tools remain confined to the selected workspace with the existing protected-path checks. Public web tools use the existing URL, DNS and redirect checks; fetched content is untrusted data. These controls are not a promise that arbitrary content contains no sensitive information. Do not use plugin tools to collect credentials, reconstruct AI-client history, bypass site access controls or act beyond the user's task.

The policy basis is OpenAI's [plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines), including task scope, sensitive inputs, unofficial connectors, explicit callable tools, annotations and privacy. Generic public-page fetches still require truthful product positioning and respect for source-site terms. This repository's installation metadata is not directory approval.

## Standalone MCP

Standalone browser and desktop modes remain separate explicit configurations. Their authorization, login/profile-transfer controls and network boundaries continue to apply. A person asking for Firefox profile transfer in standalone MCP does not enable it inside the OpenAI plugin. MCP is an interface, not an exemption from provider or website terms.

## Claude, Google and Grok

There is no Claude, Google or Grok ToolsEngine plugin in this change. Do not relabel the full browser MCP as a directory-ready package.

Before submitting a Claude package to Anthropic's directory, resolve [Anthropic's directory policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy), especially §1F on Claude context and files and §3F on external resources. Browser/profile features need their own applicability decision; native MCP compatibility alone does not settle directory eligibility. [Claude Code's distribution guidance](https://code.claude.com/docs/en/plugins/publish) separately supports self-hosted marketplaces and direct folder/ZIP distribution. Those routes still require applicable product terms, user authorization and accurate capability descriptions; directory conditions are not a blanket ban on local MCP capabilities.

Google documents an [Antigravity marketplace](https://antigravity.google/docs/marketplace), but the reviewed pages do not establish a public third-party submission route. xAI provides an open [Grok plugin marketplace](https://github.com/xai-org/plugin-marketplace) with [contribution requirements](https://github.com/xai-org/plugin-marketplace/blob/main/CONTRIBUTING.md), including immutable source revisions and disclosure of network and credential behavior. Assess a scoped package for each before submission.

The broader ToolsEngine consolidation has separate release qualification. Passing these plugin-boundary tests does not clear unrelated browser, cancellation or download tests, and this patch does not publish a release or submit to a marketplace.
