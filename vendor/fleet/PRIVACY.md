# ToolsEnabled Fleet MCP privacy

This statement covers this repository's standalone Fleet MCP and its narrower OpenAI plugin distribution. Reviewed October 20, 2026.

Fleet keeps its project binding, tasks, ledger entries, project memory, search index, settings, process records and optional audit records on your computer in the state root you selected. Submitted task text, file excerpts and tool results can appear in these records. Agents connected to that Fleet setup can access its shared work records. Do not submit passwords, tokens, API keys, payment card data, health information or government identifiers through Fleet.

Fleet sends no telemetry, crash reports or records to ToolsEnabled. Tool results go to the AI client that called Fleet and may be processed by that client's provider under your agreement with it. Search is local. The OpenAI plugin offers project coordination and mediated project files, requires Standard permissions and workers off, and has no worker launcher, browser, credential-transfer tool or provider-history reader.

Standalone MCP can start workers when the person enables them. Those native agent CLIs use their own authentication and communicate with their providers; task prompts, project content and reports may therefore leave the computer. Fleet is not a credential broker. Each user's provider plan, organization controls and usage limits still apply. Provider CLI session data and any worker records are separate from the OpenAI plugin's workers-off configuration.

State persists until you remove it; uninstalling the software does not remove records. Stop the Fleet processes using that setup before deleting its selected state folder. Project files and reports remain in your project; manage those separately. Provider-side retention and deletion are controlled by the provider. Fleet has no hosted copy to delete.

Known credential paths are refused by mediated file tools. These path checks cannot recognize every secret placed in an ordinary project file. Select only a project appropriate for sharing with your AI client and never use Fleet to inspect provider credential stores or reconstruct client conversations.

For private questions contact support@toolsenabled.ai. Report public product problems through [GitHub issues](https://github.com/ToolsEnabled/toolsenabled-fleet-mcp/issues); do not post sensitive records there.
