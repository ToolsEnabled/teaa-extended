# TEAA MCP host entry

Run `teaa config --server-json --actor YOUR-ACTOR` after setup to obtain a command and argument array. Add it explicitly under `mcpServers["teaa"]` (or the equivalent servers map in your host). The MCP server reports name `teaa` and title `TEAA`. Configuration is never written to an MCP host automatically.

The gateway exposes `fleet_*`, `engine_*`, `knowledge_*` and read-only `teaa_status`. Tools retain upstream policy/annotations and result bytes; optional result headings are text, not native host UI. `TEAA_PRESENTATION=off` removes those headings. Initialize, notifications/initialized and tools/list use the negotiated MCP protocol.

Use one edition per MCP connection. Actors identify ownership rather than a provider login. Enable workers or browser use only explicitly; no provider sign-in or service deployment occurs. Extended uses one explicitly selected FRA Hub profile or its local Fleet upstream; credentials and remote admission are separate decisions.
