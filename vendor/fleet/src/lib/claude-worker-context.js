'use strict';

const os = require('node:os');
const path = require('node:path');

// claudeMdExcludes is a per-launch setting, merged with the user's settings.
// It covers CLAUDE.md, AGENTS.md and .claude/rules without changing auth,
// plugins, MCP configuration, hooks or permission rules. Managed policy stays
// under the official client's control. No instruction files are opened here.
function workerContextSettings(workspaceRoot, env = process.env) {
  const workspace = path.resolve(workspaceRoot);
  const withinTask = value => {
    const relative = path.relative(workspace, value);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  // Escape glob metacharacters in literal folder names. Forward slashes also
  // make the emitted patterns portable to Claude's Windows path matcher.
  const literal = value => value.replace(/\\/g, '/').replace(/[?*\[\]{}()!+@]/g, char => `[${char}]`);
  const excluded = new Set();
  const add = (directory, name) => {
    const file = path.resolve(directory, name);
    if (!withinTask(file)) excluded.add(literal(file));
  };
  const rules = directory => {
    const folder = path.resolve(directory, 'rules');
    if (!withinTask(folder)) excluded.add(literal(folder) + '/**');
  };
  let directory = path.dirname(workspace);
  while (directory !== workspace) {
    for (const name of ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.claude/CLAUDE.md', '.claude/AGENTS.md']) add(directory, name);
    rules(path.join(directory, '.claude'));
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const config = path.resolve(workspace, env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'));
  for (const name of ['CLAUDE.md', 'AGENTS.md']) add(config, name);
  rules(config);
  return { claudeMdExcludes: [...excluded] };
}

module.exports = { workerContextSettings };
