'use strict';

/* THE AGENTS FLEET CAN USE, AS DATA.
 *
 * Each agent CLI Fleet can work with is described by one JSON file: how to find
 * its program, how to ask it whether it is signed in, which protocol a worker
 * speaks, how to register Fleet's MCP server with it, and the models it can be
 * asked for. Fleet's code branches on those fields, never on an agent's name,
 * so adding an agent is a descriptor, not a code change.
 *
 * Bundled descriptors live in config/agents/. A person can add their own in
 * <state root>/agents/; they are validated the same way and cannot replace a
 * bundled one. Nothing here starts a program or reads a sign-in. */

const fs = require('node:fs');
const path = require('node:path');

const BUNDLED_DIR = path.resolve(__dirname, '..', '..', '..', 'config', 'agents');
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_DESCRIPTORS = 64;
const ID = /^[a-z][a-z0-9-]{0,30}$/;
const COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const ARG = /^[^\0\n]{1,200}$/;
const DRIVERS = Object.freeze(['stream-json', 'app-server', 'acp', 'pi-rpc']);
const SIGN_IN_RESULTS = Object.freeze(['json', 'exit-code', 'unknown']);
const REGISTER_KINDS = Object.freeze(['command', 'opencode-config', 'none']);

class AgentRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentRegistryError';
    this.code = code;
  }
}

function invalid(source, detail) {
  return new AgentRegistryError('AGENT_DESCRIPTOR_INVALID', `${source}: ${detail}`);
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function onlyKeys(value, allowed, source, where) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalid(source, `${where} has an unknown field "${key}".`);
  }
}

function argList(value, source, where, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 32
      || value.some(item => typeof item !== 'string' || !ARG.test(item))) {
    throw invalid(source, `${where} must be a list of plain arguments.`);
  }
  return Object.freeze([...value]);
}

function text(value, max, source, where) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid(source, `${where} must be text of at most ${max} characters.`);
  return value;
}

function validateDescriptor(input, source = 'agent descriptor', { retiredModelFields = 'refuse' } = {}) {
  if (!plain(input)) throw invalid(source, 'it must be a JSON object.');
  onlyKeys(input, ['schemaVersion', 'id', 'name', 'command', 'entryPoints', 'binaryPaths', 'worker', 'signIn', 'register', 'models', 'mcp', 'permissions'], source, 'the descriptor');
  if (input.schemaVersion !== 1) throw invalid(source, 'schemaVersion must be 1.');
  if (typeof input.id !== 'string' || !ID.test(input.id)) throw invalid(source, 'id must be lowercase letters, digits and dashes.');
  const name = text(input.name, 60, source, 'name');
  if (typeof input.command !== 'string' || !COMMAND.test(input.command)) throw invalid(source, 'command must be a program name, not a path.');

  // Package-relative script paths identify interpreted CLI installs without
  // treating every cli.js (or an arbitrary later argument) as an agent.
  let entryPoints;
  if (input.entryPoints !== undefined) {
    if (!Array.isArray(input.entryPoints) || input.entryPoints.some(value =>
      typeof value !== 'string' || /[\r\n]/.test(value) || !/^(?:@?[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)+[A-Za-z0-9_-][A-Za-z0-9_.-]*\.js$/.test(value))) {
      throw invalid(source, 'entryPoints must be package-relative JavaScript paths without traversal.');
    }
    entryPoints = Object.freeze([...input.entryPoints]);
  }

  // Package-relative native executable locations, independent of launcher names.
  let binaryPaths;
  if (input.binaryPaths !== undefined) {
    if (!Array.isArray(input.binaryPaths) || input.binaryPaths.some(value =>
      typeof value !== 'string' || /[\r\n]/.test(value)
      || !/^(?:@?[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)+[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(value))) {
      throw invalid(source, 'binaryPaths must be package-relative executable paths without traversal.');
    }
    binaryPaths = Object.freeze([...input.binaryPaths]);
  }

  if (!plain(input.worker)) throw invalid(source, 'worker must be an object.');
  onlyKeys(input.worker, ['driver', 'args', 'modelSelection', 'held'], source, 'worker');
  if (!DRIVERS.includes(input.worker.driver)) throw invalid(source, `worker.driver must be one of ${DRIVERS.join(', ')}.`);
  if (input.worker.driver === 'acp' && !Array.isArray(input.worker.args)) throw invalid(source, 'an ACP worker needs the arguments that start ACP mode.');
  if (input.worker.modelSelection !== undefined && (input.worker.driver !== 'acp' || input.worker.modelSelection !== 'session')) {
    throw invalid(source, 'worker.modelSelection may only select models through an ACP session.');
  }
  if (input.worker.held !== undefined) {
    text(input.worker.held, 300, source, 'worker.held');
    if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(input.worker.held)) throw invalid(source, 'worker.held must be plain text on one line.');
  }
  const worker = Object.freeze({ ...(input.worker.held === undefined ? {} : { held: input.worker.held }), driver: input.worker.driver,
    ...(input.worker.modelSelection ? { modelSelection: input.worker.modelSelection } : {}),
    args: input.worker.args === undefined ? Object.freeze([]) : argList(input.worker.args, source, 'worker.args') });

  if (!plain(input.signIn)) throw invalid(source, 'signIn must be an object.');
  onlyKeys(input.signIn, ['statusArgs', 'result', 'signedInField', 'methodField', 'how'], source, 'signIn');
  if (!SIGN_IN_RESULTS.includes(input.signIn.result)) throw invalid(source, `signIn.result must be one of ${SIGN_IN_RESULTS.join(', ')}.`);
  if (input.signIn.result !== 'unknown') argList(input.signIn.statusArgs, source, 'signIn.statusArgs', { allowEmpty: false });
  if (input.signIn.result === 'json' && (typeof input.signIn.signedInField !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(input.signIn.signedInField))) {
    throw invalid(source, 'a JSON sign-in status needs the name of its signed-in field.');
  }
  if (input.signIn.methodField !== undefined && (typeof input.signIn.methodField !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(input.signIn.methodField))) {
    throw invalid(source, 'signIn.methodField must be a field name.');
  }
  const signIn = Object.freeze({
    result: input.signIn.result,
    statusArgs: input.signIn.result === 'unknown' ? Object.freeze([]) : Object.freeze([...input.signIn.statusArgs]),
    signedInField: input.signIn.signedInField || null,
    methodField: input.signIn.methodField || null,
    how: text(input.signIn.how, 300, source, 'signIn.how')
  });

  const register = validateRegistration(input.register, source);

  // The models come from the agent's own program, never from this file: a
  // descriptor names only the flag that selects a model, where the program
  // keeps the list it was served (src/lib/agents/model-discovery.js), and
  // whether the program takes a reasoning depth at all. Model ids, cost
  // classes and depth lists are refused by name.
  if (!plain(input.models)) throw invalid(source, 'models must be an object.');
  // A person's own descriptor written for an older build may still carry the
  // retired fields; they are ignored and named (`ignoredModelFields`), so the
  // agent keeps working on its own default and exact model ids.
  const retired = ['choices', 'defaults', 'efforts', 'effortAliases'].filter(name => plain(input.models) && Object.hasOwn(input.models, name));
  if (retired.length && retiredModelFields !== 'ignore') {
    throw invalid(source, `models.${retired[0]} is not read: Fleet ships no model names, cost classes or depths and takes them from the agent's own list. Remove it, and name the list with models.list.`);
  }
  onlyKeys(input.models, ['flag', 'list', 'effort', ...retired], source, 'models');
  if (typeof input.models.flag !== 'string' || !/^--?[a-z][a-z0-9-]{0,30}$/.test(input.models.flag)) throw invalid(source, 'models.flag must be a command-line flag.');
  let list = null;
  if (input.models.list !== undefined) {
    const value = input.models.list;
    if (!plain(value)) throw invalid(source, 'models.list must be an object.');
    const { LIST_FORMATS, COMMAND_LIST_FORMATS } = require('./model-discovery');
    if (!LIST_FORMATS.includes(value.format)) throw invalid(source, `models.list.format must be one of ${LIST_FORMATS.join(', ')}.`);
    // A command list runs the agent's own program with plain arguments, never
    // a shell and never another program; a file list names a file in its profile.
    if (COMMAND_LIST_FORMATS.includes(value.format)) {
      onlyKeys(value, ['format', 'args'], source, 'models.list');
      const args = argList(value.args, source, 'models.list.args', { allowEmpty: false });
      if (args.some(arg => /[{}]/.test(arg))) throw invalid(source, 'models.list.args takes plain arguments only.');
      list = Object.freeze({ format: value.format, args });
    }
  }
  if (input.models.list !== undefined && !list) {
    const value = input.models.list;
    onlyKeys(value, ['format', 'path'], source, 'models.list');
    if (typeof value.path !== 'string' || value.path.length > 200
        || !value.path.split('/').every(part => /^[a-zA-Z0-9_.-]+$/.test(part) && !['.', '..'].includes(part))) {
      throw invalid(source, 'models.list.path must be a relative path inside the agent\'s profile folder.');
    }
    if (/(?:^|\/)(?:auth|credentials|tokens?|oauth|session|\.netrc)(?:[.-]|$)/i.test(value.path)) throw invalid(source, 'models.list.path cannot name a credential file.');
    if (!plain(input.register) || !plain(input.register.profile)) throw invalid(source, 'models.list needs register.profile, the folder the list is kept in.');
    list = Object.freeze({ format: value.format, path: value.path });
  }
  if (input.models.effort !== undefined && typeof input.models.effort !== 'boolean') throw invalid(source, 'models.effort must be true or false.');

  // How the agent reads MCP tool names: some cannot use dotted names, and are
  // shown each tool with dots as underscores (dispatch and audit keep the real name).
  let mcp = Object.freeze({ toolNames: 'dotted' });
  if (input.mcp !== undefined) {
    if (!plain(input.mcp)) throw invalid(source, 'mcp must be an object.');
    onlyKeys(input.mcp, ['toolNames', 'listJson'], source, 'mcp');
    if (!['dotted', 'underscore'].includes(input.mcp.toolNames)) throw invalid(source, 'mcp.toolNames must be dotted or underscore.');
    // listJson: the agent's own command (after `command`) that prints every MCP
    // server it would load, as a JSON array of { name, command, args, enabled }.
    // An ACP worker uses it to replace the person's own Fleet registration
    // with the worker's server, so a worker never holds a lead's Fleet surface.
    let listJson;
    if (input.mcp.listJson !== undefined) {
      if (input.worker?.driver !== 'acp') throw invalid(source, 'mcp.listJson applies to ACP workers only.');
      listJson = argList(input.mcp.listJson, source, 'mcp.listJson', { allowEmpty: false });
      if (listJson.some(arg => /[{}]/.test(arg))) throw invalid(source, 'mcp.listJson takes plain arguments only.');
    }
    mcp = Object.freeze({ toolNames: input.mcp.toolNames, ...(listJson ? { listJson } : {}) });
  }

  const permissions = validatePermissions(input.permissions, worker.driver, source);

  return Object.freeze({
    id: input.id, name, command: input.command, worker, signIn, register, mcp,
    ...(entryPoints ? { entryPoints } : {}),
    ...(binaryPaths ? { binaryPaths } : {}),
    models: Object.freeze({ flag: input.models.flag, list, effort: input.models.effort === true,
      ...(retired.length ? { ignoredModelFields: Object.freeze(retired.map(name => `models.${name}`)) } : {}) }),
    permissions
  });
}

// HTTP templates describe syntax, never credentials, environment values or
// shell fragments. Header expansion belongs to the agent, not to Fleet.
function validateHttpRegistration(input, register, source) {
  if (!plain(input)) throw invalid(source, 'register.http must be an object.');
  onlyKeys(input, ['kind', 'add', 'header', 'envSyntax', 'config'], source, 'register.http');
  if (!['command', 'config'].includes(input.kind) || input.header !== 'Authorization'
    || !['dollar-braces', 'env-braces', 'bearer-token-env'].includes(input.envSyntax)) {
    throw invalid(source, 'register.http needs a known bearer header environment syntax.');
  }
  const result = { kind: input.kind, header: input.header, envSyntax: input.envSyntax };
  if (input.kind === 'command') {
    if (input.config !== undefined || input.envSyntax === 'env-braces') throw invalid(source, 'an HTTP command needs argv syntax only.');
    const args = argList(input.add, source, 'register.http.add', { allowEmpty: false });
    if (args[0] !== 'mcp' || args[1] !== 'add') throw invalid(source, 'an HTTP command must use mcp add.');
    const values = { '--scope': ['user', 'project'], '--transport': ['http'],
      '--url': ['{url}'], '--bearer-token-env-var': ['{tokenEnv}'], '--header': ['{header}'], '-H': ['{header}'] };
    const seen = new Set();
    for (let at = 2; at < args.length; at++) {
      const arg = args[at];
      if (Object.hasOwn(values, arg)) {
        if (seen.has(arg) || !values[arg].includes(args[++at])) throw invalid(source, 'HTTP option values must use their exact documented placeholder.');
        seen.add(arg);
      } else if (!['{name}', '{url}'].includes(arg)) throw invalid(source, 'HTTP argv may contain only MCP registration options and whole placeholders.');
    }
    const auth = input.envSyntax === 'bearer-token-env' ? '{tokenEnv}' : '{header}';
    for (const placeholder of ['{name}', '{url}', auth]) {
      if (args.filter(arg => arg === placeholder).length !== 1) throw invalid(source, 'HTTP argv needs one name, URL and environment header placeholder.');
    }
    if (args.includes(auth === '{tokenEnv}' ? '{header}' : '{tokenEnv}')) throw invalid(source, 'HTTP header syntax and argv must agree.');
    if (auth === '{header}' && !seen.has('--transport')) throw invalid(source, 'a header command must explicitly select HTTP transport.');
    if (auth === '{tokenEnv}' && !seen.has('--url')) throw invalid(source, 'a bearer variable command must use its URL option.');
    result.add = args;
  } else {
    if (input.add !== undefined || !plain(input.config) || !register.profile) throw invalid(source, 'an HTTP config needs a described profile and config shape.');
    onlyKeys(input.config, ['format', 'container', 'entryType'], source, 'register.http.config');
    if (input.config.format !== 'json' || input.config.container !== 'mcp' || input.config.entryType !== 'remote'
      || input.envSyntax !== 'env-braces' || register.config?.container !== 'mcp') throw invalid(source, 'unsupported HTTP configuration dialect.');
    result.config = Object.freeze({ ...input.config });
  }
  return Object.freeze(result);
}

// Registration metadata is deliberately limited to argv, profile paths and
// MCP configuration. It cannot express permission grants or a login action.
function validateRegistration(input, source) {
  if (!plain(input)) throw invalid(source, 'register must be an object.');
  onlyKeys(input, ['kind', 'add', 'remove', 'list', 'replace', 'envFlag', 'envValueEncoding', 'profile', 'config', 'settings', 'inspection', 'http', 'forwardEnv'], source, 'register');
  if (!REGISTER_KINDS.includes(input.kind)) throw invalid(source, 'register.kind is unsupported.');
  const result = { kind: input.kind };
  for (const operation of ['add', 'remove', 'list']) {
    if (input[operation] === undefined && (input.kind !== 'command' || operation === 'list')) continue;
    const args = argList(input[operation], source, `register.${operation}`, { allowEmpty: false });
    if (args.some(arg => /[{}]/.test(arg) && !['{name}', '{serverJson}', '{command}', '{args...}', '{env...}'].includes(arg))) {
      throw invalid(source, 'registration placeholders must occupy a whole argument and use a known name.');
    }
    if (operation !== 'add' && args.some(arg => arg.includes('{') && arg !== '{name}')) throw invalid(source, 'only add may contain server arguments.');
    result[operation] = args;
  }
  // Some agents' add refuses an existing entry. "remove-first" removes Fleet's
  // own named entry with the agent's documented remove before adding again.
  if (input.replace !== undefined) {
    if (input.replace !== 'remove-first' || !result.remove) throw invalid(source, 'register.replace must be "remove-first" and needs register.remove.');
    result.replace = input.replace;
  }
  if (input.envFlag !== undefined) {
    if (typeof input.envFlag !== 'string' || !/^--?[a-z][a-z-]{0,30}$/.test(input.envFlag)) throw invalid(source, 'register.envFlag must be a flag.');
    if (!result.add?.includes('{env...}')) throw invalid(source, 'register.envFlag needs an env placeholder.');
    result.envFlag = input.envFlag;
  }
  if (result.add?.includes('{env...}') && !result.envFlag) throw invalid(source, 'the env placeholder needs register.envFlag.');
  const relative = value => typeof value === 'string' && value.length < 200 && value.split('/').every(part => /^[a-zA-Z0-9_.-]+$/.test(part) && !['.', '..'].includes(part));
  if (input.profile !== undefined) {
    const value = input.profile;
    if (!plain(value)) throw invalid(source, 'register.profile must be an object.');
    // envSubdir: the variable names a home that contains the profile folder
    // (for example GEMINI_CLI_HOME holds .gemini), not the profile folder itself.
    // relatedEnv: other folder variables the agent itself reads beside its home
    // (for example CODEX_SQLITE_HOME); forwarded like env, never a secret.
    onlyKeys(value, ['env', 'envSubdir', 'relatedEnv', 'default', 'file', 'defaultFile', 'legacyContext'], source, 'register.profile');
    const folderVariable = name => typeof name === 'string' && /^[A-Z][A-Z0-9_]{0,50}(?:_HOME|_CONFIG_DIR)$/.test(name)
      && !/KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|SESSION/.test(name);
    if (value.relatedEnv !== undefined && (value.env === undefined || !Array.isArray(value.relatedEnv) || value.relatedEnv.length > 4
      || !value.relatedEnv.every(folderVariable) || new Set(value.relatedEnv).size !== value.relatedEnv.length || value.relatedEnv.includes(value.env))) {
      throw invalid(source, 'register.profile.relatedEnv must list up to four other nonsecret folder variables.');
    }
    if (value.envSubdir !== undefined && (value.env === undefined || !relative(value.envSubdir))) throw invalid(source, 'register.profile.envSubdir needs env and a relative folder.');
    if (!relative(value.default) || !relative(value.file) || value.defaultFile !== undefined && !relative(value.defaultFile)
      || value.env !== undefined && (!/^[A-Z][A-Z0-9_]{0,50}(?:_HOME|_CONFIG_DIR)$/.test(value.env) || /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|SESSION/.test(value.env))
      || value.legacyContext !== undefined && typeof value.legacyContext !== 'boolean') throw invalid(source, 'register.profile needs nonsecret paths and a config directory variable.');
    if ([value.file, value.defaultFile].filter(Boolean).some(file => /(?:^|\/)(?:auth|credentials|tokens?|oauth|session|\.netrc)(?:[.-]|$)/i.test(file))) throw invalid(source, 'registration cannot inspect a credential file.');
    result.profile = Object.freeze({ ...value, ...(value.relatedEnv ? { relatedEnv: Object.freeze([...value.relatedEnv]) } : {}) });
  }
  if (input.config !== undefined) {
    const value = input.config;
    if (!plain(value)) throw invalid(source, 'register.config must be an object.');
    onlyKeys(value, ['format', 'container', 'entryType'], source, 'register.config');
    if (!['json', 'toml'].includes(value.format) || !['mcpServers', 'mcp_servers', 'mcp'].includes(value.container)
      || !['stdio', 'command', 'local'].includes(value.entryType) || !result.profile) throw invalid(source, 'register.config must describe an MCP configuration.');
    if (value.format === 'toml' && (value.container !== 'mcp_servers' || value.entryType !== 'command')
      || value.entryType === 'local' && (value.format !== 'json' || value.container !== 'mcp')
      || value.entryType === 'stdio' && (value.format !== 'json' || value.container !== 'mcpServers')) throw invalid(source, 'the MCP container and entry dialect must match their format.');
    result.config = Object.freeze({ ...value });
  }
  // Forwarding describes names/references, never values. Checked documentation:
  // Codex: https://learn.chatgpt.com/docs/extend/mcp?surface=cli (env_vars).
  // Gemini CLI: https://geminicli.com/docs/tools/mcp-server/ ($NAME opts in).
  // Claude Code: https://code.claude.com/docs/en/env-vars (inherits the shell
  // unless the person enables CLAUDE_CODE_MCP_ALLOWLIST_ENV; leave that choice).
  // OpenCode: https://opencode.ai/v2/docs/mcp-servers/ (environment extends the
  // inherited process environment; no forwarding field is needed).
  if (input.forwardEnv !== undefined) {
    const value = input.forwardEnv;
    if (!plain(value)) throw invalid(source, 'register.forwardEnv must describe environment names.');
    if (value.kind === 'toml-list') {
      onlyKeys(value, ['kind', 'table', 'key'], source, 'register.forwardEnv');
      if (result.config?.format !== 'toml' || JSON.stringify(value.table) !== JSON.stringify(['mcp_servers', '{name}'])
        || value.key !== 'env_vars') throw invalid(source, 'register.forwardEnv must name the MCP environment allowlist.');
      result.forwardEnv = Object.freeze({ ...value, table: Object.freeze([...value.table]) });
    } else if (value.kind === 'entry-env-reference') {
      onlyKeys(value, ['kind', 'syntax'], source, 'register.forwardEnv');
      if (value.syntax !== '$NAME' || result.config?.format !== 'json' || result.config?.container !== 'mcpServers') {
        throw invalid(source, 'register.forwardEnv needs the supported MCP environment reference syntax.');
      }
      result.forwardEnv = Object.freeze({ ...value });
    } else throw invalid(source, 'register.forwardEnv has an unsupported kind.');
  }
  if (input.envValueEncoding !== undefined) {
    if (input.envValueEncoding !== 'nonempty-no-equals' || !result.envFlag || result.config?.format !== 'json') throw invalid(source, 'an env encoding limit needs an env flag and a JSON config fallback.');
    result.envValueEncoding = input.envValueEncoding;
  }
  if (input.kind === 'opencode-config' && (result.config?.format !== 'json' || result.config?.entryType !== 'local')) throw invalid(source, 'a config writer needs its local MCP configuration.');
  if (input.http !== undefined) result.http = validateHttpRegistration(input.http, result, source);
  if (input.settings !== undefined) {
    if (!Array.isArray(input.settings) || input.settings.length > 16 || result.config?.format !== 'toml') throw invalid(source, 'register.settings needs a bounded TOML settings list.');
    result.settings = Object.freeze(input.settings.map(value => {
      if (!plain(value)) throw invalid(source, 'a registration setting must be an object.');
      onlyKeys(value, ['table', 'key', 'value', 'sandboxOnly'], source, 'register.settings');
      // These are tool exposure/startup options, never authority settings.
      const supported = { omit_tools_from: ['mcp_servers', '{name}'], required: ['mcp_servers', '{name}'], daemon_auto_start: ['features'] };
      if (!Object.hasOwn(supported, value.key) || JSON.stringify(value.table) !== JSON.stringify(supported[value.key])
        || (value.key === 'omit_tools_from' ? JSON.stringify(value.value) !== '["deferred"]' : typeof value.value !== 'boolean')) throw invalid(source, 'registration settings may only control MCP exposure and startup.');
      // A setting outside Fleet's own server entry changes the agent for every
      // session, so it must be limited to the OpenShell sandbox that needs it.
      if (value.sandboxOnly !== undefined && typeof value.sandboxOnly !== 'boolean'
        || value.table[0] !== 'mcp_servers' && value.sandboxOnly !== true) throw invalid(source, 'a registration setting outside Fleet\'s own server entry must be sandboxOnly.');
      return Object.freeze({ table: Object.freeze([...value.table]), key: value.key, value: Array.isArray(value.value) ? Object.freeze([...value.value]) : value.value,
        ...(value.sandboxOnly ? { sandboxOnly: true } : {}) });
    }));
  }
  if (input.inspection !== undefined) {
    const value = input.inspection;
    if (!plain(value)) throw invalid(source, 'register.inspection must be an object.');
    // qualified: the CLI versions whose exact outputs were measured for these
    // nonconnecting checks; any other version is refused, never guessed.
    onlyKeys(value, ['kind', 'version', 'versionOutput', 'qualified', 'args', 'absentStderr', 'storePrefix'], source, 'register.inspection');
    if (!['command-absence', 'remove-absence', 'json-config'].includes(value.kind)) throw invalid(source, 'register.inspection.kind is unsupported.');
    if (value.kind !== 'json-config') {
      const bounded = item => typeof item === 'string' && item.length <= 200 && !item.includes('\0');
      if (!bounded(value.absentStderr)) throw invalid(source, 'register.inspection.absentStderr must be bounded text.');
      const rows = value.qualified !== undefined ? value.qualified : [{ version: value.version, versionOutput: value.versionOutput }];
      if (!Array.isArray(rows) || rows.length < 1 || rows.length > 16
        || rows.some(row => !plain(row) || Object.keys(row).some(key => !['version', 'versionOutput'].includes(key)) || !bounded(row.version) || !bounded(row.versionOutput))) {
        throw invalid(source, 'register.inspection needs qualified versions with their exact version output.');
      }
      value.qualified = rows.map(row => Object.freeze({ version: row.version, versionOutput: row.versionOutput }));
    } else if (result.config?.format !== 'json') throw invalid(source, 'JSON inspection needs a JSON MCP configuration.');
    if (value.storePrefix !== undefined && !relative(value.storePrefix)) throw invalid(source, 'inspection storePrefix must be a file name.');
    const { version: _version, versionOutput: _versionOutput, ...kept } = value;
    result.inspection = Object.freeze({ ...kept, ...(value.qualified ? { qualified: Object.freeze(value.qualified) } : {}),
      ...(value.args ? { args: argList(value.args, source, 'register.inspection.args') } : {}) });
  }
  return Object.freeze(result);
}

/* HOW AN AGENT'S OWN FLAGS MAP TO FLEET'S FOUR LEVELS, AND BACK.
 *
 *   1 read only   2 asks (a worker cannot ask, so anything that would is declined)
 *   3 edits on its own   4 everything (no prompts, no limits)
 *
 * `lead` retains legacy CLI diagnostic rules; they do not set Fleet permission.
 * `worker` says how to start this agent at each explicitly configured worker
 * level, in its protocol's own terms. Administrator and role ceilings apply. */
const LEVELS = Object.freeze([1, 2, 3, 4]);
const OPTION = /^--?[A-Za-z][A-Za-z0-9-]{0,40}$/;
const WORKER_SHAPES = Object.freeze({
  'stream-json': { permissionMode: /^[A-Za-z]{1,30}$/ },
  'app-server': { sandbox: ['read-only', 'workspace-write', 'danger-full-access'], approvalPolicy: ['never', 'on-request', 'on-failure', 'untrusted'] },
  acp: { args: 'args', allow: ['none', 'edits', 'all'] },
  'pi-rpc': { args: 'args' }
});

function validatePermissions(input, driver, source) {
  if (input === undefined) {
    throw invalid(source, 'permissions must say how the lead\'s flags map to levels and how a worker starts at each level.');
  }
  if (!plain(input)) throw invalid(source, 'permissions must be an object.');
  onlyKeys(input, ['aliases', 'argv', 'lead', 'openShellMinimumLevel', 'workerMinimum', 'worker', 'remove', 'workerAgent'], source, 'permissions');
  let argv;
  if (input.argv !== undefined) {
    const row = input.argv;
    if (!plain(row)) throw invalid(source, 'permissions.argv must be an object.');
    onlyKeys(row, ['booleanNegation', 'attachedValueOptions', 'readOnlyConfig'], source, 'permissions.argv');
    if (row.booleanNegation !== undefined && typeof row.booleanNegation !== 'boolean')
      throw invalid(source, 'permissions.argv.booleanNegation must be boolean.');
    const attached = row.attachedValueOptions === undefined ? [] : row.attachedValueOptions;
    if (!Array.isArray(attached) || attached.length > 16 || attached.some(name => typeof name !== 'string' || !/^-[A-Za-z]$/.test(name)))
      throw invalid(source, 'permissions.argv.attachedValueOptions needs short value options.');
    let readOnlyConfig;
    if (row.readOnlyConfig !== undefined) {
      const config = row.readOnlyConfig;
      if (!plain(config)) throw invalid(source, 'permissions.argv.readOnlyConfig must be an object.');
      onlyKeys(config, ['options', 'key', 'value'], source, 'permissions.argv.readOnlyConfig');
      if (!Array.isArray(config.options) || !config.options.length || config.options.length > 8
          || config.options.some(name => typeof name !== 'string' || !OPTION.test(name))
          || typeof config.key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(config.key))
        throw invalid(source, 'permissions.argv.readOnlyConfig needs options and a plain configuration key.');
      readOnlyConfig = Object.freeze({ options: Object.freeze([...new Set(config.options)]),
        key: config.key, value: text(config.value, 64, source, 'permissions.argv.readOnlyConfig.value') });
    }
    argv = Object.freeze({ booleanNegation: row.booleanNegation === true,
      attachedValueOptions: Object.freeze([...new Set(attached)]), ...(readOnlyConfig ? { readOnlyConfig } : {}) });
  }
  let workerAgent;
  if (input.workerAgent !== undefined) {
    const row = input.workerAgent;
    if (driver !== 'acp' || !plain(row)) throw invalid(source, 'a worker agent needs an ACP inline configuration mechanism.');
    onlyKeys(row, ['kind', 'name'], source, 'permissions.workerAgent');
    if (row.kind !== 'inline-primary-agent' || typeof row.name !== 'string'
        || !/^toolsenabled-[a-z][a-z0-9-]{0,47}$/.test(row.name)) {
      throw invalid(source, 'a worker agent must use a supported mechanism and a Fleet-owned name.');
    }
    workerAgent = Object.freeze({ kind: row.kind, name: row.name });
  }
  // Some agents enforce lower levels with an OS sandbox of their own, which
  // cannot start inside an OpenShell sandbox. Below this level such an agent
  // cannot be a worker there, because its level could not be enforced.
  const openShellMinimumLevel = input.openShellMinimumLevel === undefined ? 1 : input.openShellMinimumLevel;
  if (!LEVELS.includes(openShellMinimumLevel)) throw invalid(source, 'permissions.openShellMinimumLevel must be 1 to 4.');
  // Below this level a worker of this agent could start but not do its work
  // (for example every tool call would need a prompt it cannot show), so it
  // is refused with the descriptor's plain reason instead.
  let workerMinimum;
  if (input.workerMinimum !== undefined) {
    const row = input.workerMinimum;
    if (!plain(row)) throw invalid(source, 'permissions.workerMinimum must be an object.');
    onlyKeys(row, ['level', 'reason'], source, 'permissions.workerMinimum');
    if (!LEVELS.includes(row.level)) throw invalid(source, 'permissions.workerMinimum.level must be 1 to 4.');
    workerMinimum = Object.freeze({ level: row.level, reason: text(row.reason, 300, source, 'permissions.workerMinimum.reason') });
  }
  const aliases = {};
  for (const [alias, option] of Object.entries(input.aliases || {})) {
    if (!OPTION.test(alias) || typeof option !== 'string' || !OPTION.test(option)) throw invalid(source, `permissions.aliases.${alias} must name an option.`);
    aliases[alias] = option;
  }
  if (!Array.isArray(input.lead) || input.lead.length > 32) throw invalid(source, 'permissions.lead must be a list of rules.');
  const lead = input.lead.map((rule, index) => {
    if (!plain(rule)) throw invalid(source, `permissions.lead[${index}] must be an object.`);
    onlyKeys(rule, ['when', 'level'], source, `permissions.lead[${index}]`);
    if (!LEVELS.includes(rule.level)) throw invalid(source, `permissions.lead[${index}].level must be 1 to 4.`);
    if (!plain(rule.when) || Object.keys(rule.when).length === 0) throw invalid(source, `permissions.lead[${index}].when must name at least one option.`);
    for (const [option, value] of Object.entries(rule.when)) {
      if (!OPTION.test(option) || !(value === true || (typeof value === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(value)))) {
        throw invalid(source, `permissions.lead[${index}].when.${option} must be true or a plain value.`);
      }
    }
    return Object.freeze({ when: Object.freeze({ ...rule.when }), level: rule.level });
  });
  if (!plain(input.worker)) throw invalid(source, 'permissions.worker must map each level to how a worker starts.');
  const shape = WORKER_SHAPES[driver];
  const worker = {};
  for (const level of LEVELS) {
    const row = input.worker[String(level)];
    if (!plain(row)) throw invalid(source, `permissions.worker.${level} is missing.`);
    onlyKeys(row, Object.keys(shape), source, `permissions.worker.${level}`);
    const out = {};
    for (const [field, rule] of Object.entries(shape)) {
      const value = row[field];
      if (value === undefined) continue;
      if (rule === 'args') out[field] = argList(value, source, `permissions.worker.${level}.${field}`);
      else if (Array.isArray(rule)) {
        if (!rule.includes(value)) throw invalid(source, `permissions.worker.${level}.${field} must be one of ${rule.join(', ')}.`);
        out[field] = value;
      } else {
        if (typeof value !== 'string' || !rule.test(value)) throw invalid(source, `permissions.worker.${level}.${field} is not valid.`);
        out[field] = value;
      }
    }
    if (driver === 'stream-json' && !out.permissionMode) throw invalid(source, `permissions.worker.${level} needs a permissionMode.`);
    if (driver === 'app-server' && !out.approvalPolicy) throw invalid(source, `permissions.worker.${level} needs an approvalPolicy.`);
    if (driver === 'acp' && (!out.allow || !out.args)) throw invalid(source, `permissions.worker.${level} needs args and allow.`);
    worker[level] = Object.freeze(out);
  }
  const remove = {};
  if (input.remove !== undefined) {
    if (!plain(input.remove)) throw invalid(source, 'permissions.remove must be an object.');
    onlyKeys(input.remove, require('./permission-level').NATIVE_TOOL_CATEGORIES, source, 'permissions.remove');
    const field = { 'stream-json': 'args', 'app-server': 'overrides', acp: 'rejectKinds', 'pi-rpc': 'args' }[driver];
    for (const [category, row] of Object.entries(input.remove)) {
      if (!plain(row)) throw invalid(source, `permissions.remove.${category} must be an object.`);
      onlyKeys(row, [field, 'env', 'settings', 'unavailable'], source, `permissions.remove.${category}`);
      const out = {};
      if (row.unavailable !== undefined) out.unavailable = text(row.unavailable, 300, source, 'native removal explanation');
      if (row.env !== undefined) {
        if (!plain(row.env) || !Object.keys(row.env).length || Object.keys(row.env).length > 16
            || Object.entries(row.env).some(([name, value]) => !require('./native-removal-environment').validRemovalEnv(name, value))) {
          throw invalid(source, `permissions.remove.${category}.env must contain literal disable switches or JSON tool denials, without secrets or paths.`);
        }
        out.env = Object.freeze({ ...row.env });
      }
      if (row.settings !== undefined) {
        const settings = row.settings;
        if (driver !== 'acp' || !plain(settings)) throw invalid(source, 'native settings removals need an ACP settings mechanism.');
        onlyKeys(settings, ['kind', 'exclude'], source, 'native settings removal');
        if (settings.kind !== 'system-settings-overlay' || !Array.isArray(settings.exclude) || !settings.exclude.length
            || settings.exclude.length > 32 || settings.exclude.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(name))) {
          throw invalid(source, 'native settings removals must name a supported settings mechanism and excluded tools.');
        }
        out.settings = Object.freeze({ kind: settings.kind, exclude: Object.freeze([...settings.exclude]) });
      }
      if (category === 'subagents' && row.rejectKinds !== undefined) {
        throw invalid(source, 'native subagents cannot be disabled by optional ACP permission requests.');
      }
      if (row[field] === undefined) {
        if (!Object.keys(out).length) throw invalid(source, 'a native removal must name a mechanism or explain why it is unavailable.');
        remove[category] = Object.freeze(out);
        continue;
      }
      let value;
      if (field === 'overrides') {
        value = row.overrides;
        if (!plain(value) || !Object.keys(value).length || Object.entries(value).some(([key, item]) =>
          !/^[a-zA-Z][a-zA-Z0-9_.-]{0,120}$/.test(key) || !['string', 'boolean', 'number'].includes(typeof item)
          || typeof item === 'string' && (item.length > 200 || /[\x00-\x1f]/.test(item))
          || typeof item === 'number' && !Number.isFinite(item))) {
          throw invalid(source, `permissions.remove.${category}.overrides must contain configuration values.`);
        }
        value = Object.freeze({ ...value });
      } else {
        value = argList(row[field], source, `permissions.remove.${category}.${field}`);
        if (!value.length || field === 'rejectKinds' && value.some(kind =>
          !['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'].includes(kind))) {
          throw invalid(source, `permissions.remove.${category}.${field} must name supported removals.`);
        }
      }
      remove[category] = Object.freeze({ ...out, [field]: value });
    }
  }
  return Object.freeze({ aliases: Object.freeze(aliases), lead: Object.freeze(lead), openShellMinimumLevel,
    ...(argv ? { argv } : {}),
    ...(workerMinimum ? { workerMinimum } : {}),
    ...(workerAgent ? { workerAgent } : {}),
    worker: Object.freeze(worker), remove: Object.freeze(remove) });
}

function readDescriptorFile(file, options) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { throw invalid(file, `it could not be read (${error.code || 'error'}).`); }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_DESCRIPTOR_BYTES) throw invalid(file, 'it must be a small regular file, not a link.');
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw invalid(file, 'it is not valid JSON.'); }
  const descriptor = validateDescriptor(parsed, file, options);
  if (path.basename(file) !== `${descriptor.id}.json`) throw invalid(file, `its file name must be ${descriptor.id}.json.`);
  return descriptor;
}

function readDirectory(dir, options) {
  let names;
  try { names = fs.readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.filter(name => name.endsWith('.json') && !options?.excludeIds?.has(name.slice(0, -5))).sort().map(name => readDescriptorFile(path.join(dir, name), options));
}

function userDirectory(env = process.env) {
  const root = env.TOOLSENABLED_STATE_ROOT;
  return typeof root === 'string' && path.isAbsolute(root) ? path.join(root, 'agents') : null;
}

/** Every agent descriptor: bundled first, then the person's own. */
function loadRegistry({ env = process.env, bundledDir = BUNDLED_DIR, userDir = userDirectory(env) } = {}) {
  const bundled = readDirectory(bundledDir);
  // Bundled providers are authoritative. Exclude redundant local paths before
  // parsing them; one stale grok.json must not discard every custom provider.
  const own = userDir ? readDirectory(userDir, { retiredModelFields: 'ignore', excludeIds: new Set(bundled.map(agent => agent.id)) }) : [];
  const all = [...bundled, ...own];
  if (all.length > MAX_DESCRIPTORS) throw new AgentRegistryError('AGENT_REGISTRY_TOO_LARGE', `At most ${MAX_DESCRIPTORS} agents can be described.`);
  const byId = new Map();
  for (const descriptor of all) {
    if (byId.has(descriptor.id)) {
      throw new AgentRegistryError('AGENT_DESCRIPTOR_DUPLICATE', `Two descriptors use the id "${descriptor.id}". A person's own descriptor cannot replace a bundled one.`);
    }
    byId.set(descriptor.id, descriptor);
  }
  return Object.freeze({
    agents: Object.freeze([...byId.values()]),
    ids: Object.freeze([...byId.keys()]),
    get: id => byId.get(id) || null,
    has: id => byId.has(id),
    /* The agent a model selection names: "<agent>" (that agent's own default
       model) or "<agent>/<model id from its own list>". Null for anything else. */
    providerOf: selection => {
      if (typeof selection !== 'string') return null;
      const id = selection.includes('/') ? selection.slice(0, selection.indexOf('/')) : selection;
      return byId.has(id) ? id : null;
    }
  });
}

/* The worker protocols this build can drive. An agent whose protocol is not
   listed is discovered and shown, but never offered as a worker. */
const WORKER_DRIVERS = Object.freeze(['stream-json', 'app-server', 'acp', 'pi-rpc']);

/** Agents that can run as tree workers in this build, in registry order. */
function workerAgentIds(loaded) {
  return Object.freeze(loaded.agents.filter(agent => !agent.worker.held && WORKER_DRIVERS.includes(agent.worker.driver)).map(agent => agent.id));
}

/** A held descriptor stays available to leads, but can never start a worker. */
function assertWorkerAvailable(loaded, id) {
  const agent = loaded.get(id);
  if (agent?.worker.held) throw new AgentRegistryError('AGENT_WORKER_HELD', agent.worker.held);
}

/** The qualified version whose exact `--version` output this is, or null. */
function qualifiedVersion(inspection, stdout) {
  const row = (inspection?.qualified || []).find(item => item.versionOutput === stdout);
  return row ? row.version : null;
}

/** The worker protocol of an agent id, or null when the id is not a described agent. */
function driverOf(loaded, id) {
  const agent = loaded.get(id);
  return agent ? agent.worker.driver : null;
}

/** Every name an agent session may identify itself with: each described agent, and `local`. */
function actorNames(loaded) {
  return Object.freeze([...loaded.ids, 'local']);
}

/** Whether an actor reads tool names with underscores instead of dots. */
function usesUnderscoreToolNames(loaded, actor) {
  const agent = typeof actor === 'string' ? loaded.get(actor) : null;
  return Boolean(agent && agent.mcp.toolNames === 'underscore');
}

let cached = null;
/** The bundled descriptors only, loaded once per process. */
function bundledRegistry() {
  if (!cached) cached = loadRegistry({ userDir: null });
  return cached;
}

const active = new Map();
/** The bundled descriptors plus the person's own, for this process's state root.
 *  A person's descriptor that does not validate never stops Fleet: it is
 *  reported once on stderr and the bundled agents are used. `toolsenabled
 *  agents` reads loadRegistry() directly, so it shows the error in full. */
function activeRegistry(env = process.env) {
  const key = userDirectory(env) || '';
  if (!active.has(key)) {
    let loaded;
    try { loaded = loadRegistry({ env }); } catch (error) {
      process.stderr.write(`ToolsEnabled Fleet ignored your own agent descriptors: ${error.message}\n`);
      loaded = bundledRegistry();
    }
    for (const agent of loaded.agents) {
      if (agent.models.ignoredModelFields) {
        process.stderr.write(`ToolsEnabled Fleet ignored ${agent.models.ignoredModelFields.join(', ')} in your own ${agent.id} descriptor: Fleet takes models from the agent's own list. ${agent.name} runs its own default model, or the exact model id a caller names.\n`);
      }
    }
    active.set(key, loaded);
  }
  return active.get(key);
}

/** Every described agent's profile folder variables: its home and any related folders. */
function profileEnvNames(registry = activeRegistry()) {
  return Object.freeze([...new Set(registry.agents.flatMap(agent => [agent.register.profile?.env, ...(agent.register.profile?.relatedEnv || [])]).filter(Boolean))]);
}

function defaultForwardEnvNames(registry = activeRegistry()) {
  return Object.freeze([...new Set([...profileEnvNames(registry),
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS'])].sort());
}

module.exports = Object.freeze({
  defaultForwardEnvNames, profileEnvNames,
  qualifiedVersion,
  AgentRegistryError, BUNDLED_DIR, DRIVERS, WORKER_DRIVERS, LEVELS,
  validateDescriptor, loadRegistry, bundledRegistry, activeRegistry, userDirectory,
  workerAgentIds, assertWorkerAvailable, driverOf, actorNames, usesUnderscoreToolNames
});
