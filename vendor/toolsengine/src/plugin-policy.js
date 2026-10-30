// Vendor distribution is an explicit ceiling; standalone MCP keeps its own modes.
export const OPENAI_PLUGIN_TOOLS = Object.freeze([
  'workspace.list', 'workspace.read_file', 'workspace.write_file', 'workspace.search',
  'web.fetch', 'web.extract', 'system.status', 'capability.find',
]);
export function assertPluginProfile(config) {
  if (config.pluginProfile === undefined) return;
  if (config.pluginProfile !== 'openai') throw new Error('Unknown ToolsEngine plugin profile.');
  if (config.browser !== false || config.desktopProfileRoot || config.desktopAllowSignIn
      || config.profileDir || config.cdpEndpoint || config.browserExtension || config.firefoxDesktop
      || config.chromeHidden || config.browserExecutable || config.browserChannel || config.browserSandbox === false
      || config.allowLocalNetwork || config.desktopLeftHalf || config.privateDisplay || config.browserViewRuntime)
    throw new Error('The OpenAI plugin profile permits only scoped files and public web; browser, desktop, sign-in and private-network options are refused.');
}
export function restrictPluginTools(tools, profile) {
  if (profile === undefined) return tools;
  if (profile !== 'openai') throw new Error('Unknown ToolsEngine plugin profile.');
  return tools.filter(tool => OPENAI_PLUGIN_TOOLS.includes(tool.name));
}

// The directory package does not expose hidden state, authentication stores,
// agent instructions or configuration through its otherwise scoped file tools.
// This is a path boundary, not a claim to classify all sensitive document text.
export function restrictedPluginPath(value) {
  return String(value).replaceAll('\\', '/').split('/').some(part =>
    (part.startsWith('.') && part !== '.' && part !== '..')
    || /^(?:appdata|library|credentials|secrets|auth\.json|cookies|login data|local state|agents(?:\.override)?\.md|claude\.md|gemini\.md|id_(?:rsa|dsa|ecdsa|ed25519))(?:$|\.)/i.test(part)
    || /^(?:logins(?:-backup)?\.json|key[34]\.db|signons\.sqlite|cookies\.sqlite|login data|cookies)(?:$|[.-](?:bak|backup|old|corrupt|journal|wal|shm)(?:[.-].*)?$)/i.test(part)
    || /\.(?:pem|key|p12|pfx|kdbx)$/i.test(part));
}
