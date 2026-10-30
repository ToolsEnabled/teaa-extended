# Client configuration

The installer in the release archive connects Claude Code and Codex for you
when it is run with `--register`, and prints the exact command for each when
it is not; see "Install" in the README. This page is for writing a client's
configuration by hand.

Choose one workspace directory that already exists. Replace every example
path with the Node and package paths on that same operating system. In an
installed release the package is the `app` folder of the installed version,
for example `C:/Users/you/ToolsEngine/VERSION/app/bin/toolsengine.js`. The
package itself never changes a client's configuration; the installer does so
only when asked, and only through the client's own command.

## Claude Code stdio JSON (`.mcp.json`)

```json
{
  "mcpServers": {
    "toolsengine": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": ["C:/Tools/toolsengine/bin/toolsengine.js", "--workspace", "C:/Work/project"]
    }
  }
}
```

On Linux use, for example, `/usr/bin/node`,
`/opt/toolsengine/bin/toolsengine.js` and `/home/you/project`.
Claude Code accepts this project-scoped `.mcp.json` structure; the client asks
to trust new project servers. Claude Desktop has its own MCP configuration;
the installer does not register it.
For CLI registration, `claude mcp add-json` accepts the inner server object.
PowerShell wrapper argument handling can consume a bare `--`; JSON registration
was verified on the Windows test installation.

Reference: [Claude MCP documentation](https://code.claude.com/docs/en/mcp).

## Codex

Add a server entry to your selected Codex configuration:

```toml
[mcp_servers.toolsengine]
command = "C:/Program Files/nodejs/node.exe"
args = ["C:/Tools/toolsengine/bin/toolsengine.js", "--workspace", "C:/Work/project"]
startup_timeout_sec = 30
tool_timeout_sec = 90
```

Linux uses the same keys with Linux absolute paths. Start a fresh client session
after changing configuration. Use `system.status` and `capability.find` to
confirm which tools and startup mode the MCP offers. `browserEnabled` is not a
browser-connection or sign-in check: inspect `browserSession`,
`browserLaunchState`, `browserWindowVisibility`, `browserConnectionVerified` and
`browserAuthenticationVerified` before relying on browser state.
`browserSandbox` is the setting the server asks for when it starts a browser,
not a check of a running one. Preserve your client approval and sandbox
settings.

Reference: [OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Distribution boundary

ToolsEngine is a local stdio package. It has no hosted endpoint, OAuth
service, public directory listing, or auto-update mechanism. Browser and
desktop access stay on the person's machine.
