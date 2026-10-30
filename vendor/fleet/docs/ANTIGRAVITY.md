# Antigravity CLI as a Fleet MCP client

Lead role clarified October 26, 2026.

AGY can load Fleet as an MCP server. Fleet ships an agy descriptor for client discovery, transport-bound actor identity and official CLI MCP registration. In V4, AGY is a native lead using Fleet through MCP. Fleet does not launch AGY as a worker; that exclusion is intentional.

Create a fresh standalone configuration with the correct actor:

    node /absolute/runtime/bin/fleetV4.js setup --state-root /absolute/private/state --actor agy

Setup returns the server command and arguments. The status command retains that actor. Existing configurations without a saved client actor continue to print the Codex default; use status --actor agy to print an AGY entry.

Register that entry using the official client:

    agy mcp add toolsenabled-fleet-host -- /absolute/node /absolute/runtime/bin/fleetV4.js serve --state-root /absolute/private/state --actor agy

The agy mcp list command shows configured servers. The official global configuration is ~/.gemini/config/mcp_config.json; workspace configuration is .agents/mcp_config.json. Fleet registration never reads sign-in files or copies credentials. Setup prints an entry; it does not sign into AGY or start a model turn.

[Antigravity's MCP guide](https://antigravity.google/docs/mcp) documents local stdio clients and this configuration format. Its [headless guide](https://antigravity.google/docs/cli/headless/) separately documents ordinary CLI streaming. The [FAQ](https://antigravity.google/docs/faq) places limits on consumer third-party agent wrappers. MCP client support does not establish permission for every worker deployment, and this candidate does not enable AGY workers.

[Gemini issue #7](https://github.com/ToolsEnabled/toolsenabled-fleet-mcp/issues/7) concerns conflicting Gemini CLI sign-in guidance and a reporter's direct UNSUPPORTED_CLIENT result. Adding AGY MCP client support does not fix or reinterpret that account eligibility result. See [GEMINI-AUTH.md](GEMINI-AUTH.md).
