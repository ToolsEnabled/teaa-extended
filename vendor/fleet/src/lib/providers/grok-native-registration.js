'use strict';

// Use Grok's official MCP registration command. This is a launch recipe,
// not an independent MCP server and not a native-write interception hook.
function directRegistration({ entry, name = 'fleet-native' } = {}) {
  if (!entry || typeof entry.command !== 'string' || !Array.isArray(entry.args)
      || !/^[A-Za-z0-9_-]+$/.test(name)) {
    throw Object.assign(new Error('An existing Fleet server entry and a plain Grok MCP name are required.'), { code: 'GROK_ENTRY_REQUIRED' });
  }
  const serverArgs = [...entry.args];
  const actor = serverArgs.indexOf('--actor');
  if (actor >= 0) serverArgs[actor + 1] = 'grok';
  else serverArgs.push('--actor', 'grok');
  const envArgs = Object.entries(entry.env || {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
  return {
    command: 'grok',
    args: ['--no-auto-update', 'mcp', 'add', '--scope', 'user', name, ...envArgs, '--', entry.command, ...serverArgs],
    nativeToolsPreserved: true,
    mandatoryNativeMediation: false,
    byteAuthority: 'byte-coordination-host',
    note: 'Run using the intended Grok profile. Native file tools remain native; Fleet host tools mediate only their own reads and writes.'
  };
}
module.exports = { directRegistration };
