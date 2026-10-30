'use strict';

const { phraseChanges, applyChange, sandboxHome, pluginCommandWording } = require('./openshell-descriptions');

// Reuse the reviewed phrase substitutions, replacing their environmental
// claims with host facts. Existing registry descriptions remain the source.
function changes(home = sandboxHome(), { plugin = false } = {}) {
  return phraseChanges(home).map(change => ({ ...change,
    to: change.to.replaceAll("this sandbox's home folder", 'your account home folder')
      .replaceAll("this sandbox's agent tree", 'this host agent tree')
      .replaceAll('inside this sandbox', 'on this host') }))
    .map(change => {
      if (!['host.read_file', 'host.write_file', 'host.patch_file', 'host.list_dir'].includes(change.tool)) return change;
      if (change.from === 'the owner profile tree') return { ...change,
        to: plugin ? 'the saved Fleet workspace' : 'the folders permitted by this session' };
      if (change.from === 'inside the owner profile tree, or a path relative to the owner profile root.') {
        return { ...change, to: plugin
          ? 'inside the saved Fleet workspace, or a path relative to the workspace root.'
          : 'permitted by this session, or a path relative to the saved project folder. Standalone unrestricted sessions can use paths on other local drives; confined sessions retain their workspace limits.' };
      }
      if (change.from === 'Omit for the profile root.') return { ...change, to: 'Omit for the saved workspace root.' };
      return change;
    }).concat([
      { tool: 'host.read_file', from: 'are always refused.', to: 'are refused by name; this is not a classifier for secrets in arbitrary files.' },
      // Sandbox-only limits and the absolute-path advice do not apply here:
      // a relative path is relative to the workspace root.
      { tool: 'host.read_file', from: ' Inside an OpenShell sandbox one read returns at most 32 KiB; a longer file comes back truncated with nextStartByte to read next.', to: '' },
      ...['host.read_file', 'host.write_file', 'host.patch_file'].map(tool => ({ tool, schemaOnly: true,
        from: ' For a file in the agent workspace, pass its absolute path.', to: '' })),
      { tool: 'host.list_dir', schemaOnly: true, from: ' For the agent workspace, pass its absolute path.', to: '' },
      { tool: 'host.write_file', from: 'Credential locations are always refused.',
        to: 'Known credential locations and executable control paths are refused.' },
    ]);
}

function hostWording(tools, { plugin = false } = {}) {
  const offered = new Set(tools.map(tool => tool.name));
  return tools.map(tool => {
    const worded = changes(undefined, { plugin }).filter(change => change.tool === tool.name
    && !(change.unless && offered.has(change.unless)) && !(change.when && !offered.has(change.when)))
      .reduce((current, change) => applyChange(current, change) || current, tool);
    return plugin ? { ...worded, description: pluginCommandWording(worded.description) } : worded;
  });
}

function recallRewrite(offered, descriptionOf, { plugin = false } = {}) {
  return document => {
    const original = descriptionOf(document.id);
    if (typeof original !== 'string') return document;
    const tool = changes(undefined, { plugin }).filter(change => change.tool === document.id && !change.schemaOnly
      && !(change.unless && offered.has(change.unless)) && !(change.when && !offered.has(change.when)))
      .reduce((current, change) => applyChange(current, change) || current, { description: original, inputSchema: {} });
    const line = (plugin ? pluginCommandWording(tool.description) : tool.description).split('\n')[0];
    const clip = limit => line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
    return { ...document, clause: clip(120), summary: clip(300) };
  };
}

function briefToolSummary({ tier, allowedNames, setupKind } = {}) {
  const workers = allowedNames.includes('agent.spawn');
  return { enabled: true, text: [
    `ToolsEnabled Fleet host mode offers ${allowedNames.length} tools for this session (${tier} surface, narrowed by the optional setup cap). Use their exact Function IDs.`,
    'This server runs with your own permissions and network. ToolsEnabled does not supply a sandbox, network confinement or credential custody for your CLIs.',
    `Subagents: ${workers ? 'explicitly enabled; workers default to level 4 (bypassed), lowered by administrator settings, caps and role limits; new permission requests are declined' : 'off'}. Native tools depend on the agent and session.`,
    `Tool families here: ${[...new Set(allowedNames.map(name => name.split('.')[0]))].sort().join(', ')}.`,
    'Use task.* for the shared work record and memory.* for durable notes.',
    ...(allowedNames.includes('host.read_file')
      ? ['Use host.read_file before host.write_file or host.patch_file for coordinated edits. Byte mediation covers permitted paths across folders; unrestricted standalone sessions can reach other local drives. Confined and plugin sessions retain their workspace limits. Shell and native file edits do not participate in byte mediation.']
      : []),
    setupKind === 'plugin'
      ? 'If a tool is absent, say so. The person configures this package from its installed folder with node bin/toolsenabled-host.js setup --plugin and the workspace, state-root and tier options in its setup guide (CODEX.md for the Codex package). Use settings.read and ledger.read to inspect its saved settings and ledger records.'
      : 'If a tool is absent, say so. The person manages this installation using the installed toolsenabled command: toolsenabled status, toolsenabled settings and toolsenabled ledger.'
  ].join('\n') };
}

module.exports = { hostWording, recallRewrite, briefToolSummary };
