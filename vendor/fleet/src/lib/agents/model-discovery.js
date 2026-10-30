'use strict';

/* THE MODELS AN AGENT CLI OFFERS, AS THAT CLI LISTS THEM.
 *
 * Fleet ships no model names, no cost classes, no prices and no per-model
 * reasoning depths. Like a sign-in, the models come from the agent's own
 * program: each descriptor says where that program keeps the list it was
 * served (`models.list`), and this module reads it and hands it on unchanged --
 * the provider's own ids, names, descriptions, order, default and depths.
 *
 * A list is kept either in a file (`models.list.path`, inside the agent's
 * profile folder) or behind the agent's own listing command
 * (`models.list.args`, run as `<command> <args>`, never through a shell). A
 * command is used where the file the program keeps would hold more than the
 * list: Grok's models_cache.json carries api_key fields, so Fleet runs
 * `grok models` and never opens that file.
 *
 * Where an agent keeps no such list, there is nothing to read: the agent's own
 * default runs, or the caller names an exact model id and the agent's program
 * accepts or refuses it. Fleet never substitutes a model.
 *
 * Three answers are kept apart, because they mean different things:
 *   listed      the agent's list was read
 *   no-list     the agent keeps no list Fleet can read before a session
 *   not-found   the agent keeps one, but there is none on this computer yet
 *               (it has not been signed in or started here)
 *   unreadable  a list is there and could not be read; nothing is guessed
 *
 * The program's own confidentiality markers are honoured: a model its catalog
 * marks confidential, or whose id it masks, is not listed here (a caller can
 * still name it exactly). Sign-in files are never read; the list paths are
 * checked against credential file names when a descriptor is loaded.
 *
 * Bounds: a list file (or a listing command's output) of at most
 * MAX_LIST_BYTES, a listing command given at most LIST_COMMAND_TIMEOUT_MS, at
 * most MAX_CATALOG_FILES catalog files considered, and at most MAX_MODELS
 * models; a list past a bound is reported unreadable rather than cut short. */

const nodeFs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const MAX_LIST_BYTES = 4 * 1024 * 1024;
const MAX_CATALOG_FILES = 64;
const MAX_MODELS = 256;
const LIST_COMMAND_TIMEOUT_MS = 10000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+[\]-]{0,199}$/;
const EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;
const FILE_LIST_FORMATS = Object.freeze(['codex-models-cache', 'claude-served-catalog']);
const COMMAND_LIST_FORMATS = Object.freeze(['grok-models-command']);
const LIST_FORMATS = Object.freeze([...FILE_LIST_FORMATS, ...COMMAND_LIST_FORMATS]);

class ListUnreadable extends Error {}

function text(value, max) {
  return typeof value === 'string' && value.trim() ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : null;
}

function efforts(values) {
  if (!Array.isArray(values)) return null;
  return Object.freeze(values.filter(value => typeof value === 'string' && EFFORT.test(value)));
}

function readJson(fs, file) {
  let stat;
  try { stat = fs.statSync(file); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
    throw new ListUnreadable(`${error.code || 'error'} reading the list`);
  }
  if (!stat.isFile()) throw new ListUnreadable('the list is not a file');
  if (stat.size > MAX_LIST_BYTES) throw new ListUnreadable(`the list is larger than ${MAX_LIST_BYTES} bytes`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    throw new ListUnreadable(error instanceof SyntaxError ? 'the list is not valid JSON' : `${error.code || 'error'} reading the list`);
  }
}

function capped(models) {
  if (models.length > MAX_MODELS) throw new ListUnreadable(`the list names more than ${MAX_MODELS} models`);
  const seen = new Set();
  return models.filter(model => MODEL_ID.test(model.id) && !seen.has(model.id) && seen.add(model.id));
}

/* Codex: the catalog the Codex CLI was served and keeps in its home as
   models_cache.json (the same catalog `codex debug models` prints and the
   app-server's model/list returns). Codex's own picker lists the models whose
   visibility is "list", in priority order; so does this. */
function codexModelsCache(fs, file) {
  const document = readJson(fs, file);
  if (document === undefined) return null;
  if (!document || !Array.isArray(document.models)) throw new ListUnreadable('the list has no models array');
  const rows = document.models.filter(model => model && typeof model.slug === 'string' && model.visibility === 'list')
    .map((model, index) => ({ model, index }))
    .sort((left, right) => (Number.isFinite(left.model.priority) ? left.model.priority : Infinity)
      - (Number.isFinite(right.model.priority) ? right.model.priority : Infinity) || left.index - right.index);
  return {
    models: capped(rows.map(({ model }) => ({
      id: model.slug, name: text(model.display_name, 120), description: text(model.description, 300),
      efforts: efforts((model.supported_reasoning_levels || []).map(level => level && level.effort)),
      defaultEffort: typeof model.default_reasoning_level === 'string' ? model.default_reasoning_level : null
    }))),
    defaultModel: null, aliases: {}, fetchedAt: typeof document.fetched_at === 'string' ? document.fetched_at : null
  };
}

/* Claude Code: the model catalog Claude Code is served for the signed-in
   account and keeps under <config dir>/cache/model-catalog, one file per
   sign-in. The most recently fetched Claude Code catalog is the one used. Its
   `state.model` is the account's current default; masked-ids.json and a
   model's `confidential` flag are Claude Code's own masking. */
function claudeServedCatalog(fs, dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw new ListUnreadable(`${error.code || 'error'} reading the catalog folder`);
  }
  const candidates = names.filter(name => name.endsWith('.json') && !name.startsWith('masked-ids') && !name.startsWith('published-')).sort();
  if (candidates.length > MAX_CATALOG_FILES) throw new ListUnreadable(`the catalog folder holds more than ${MAX_CATALOG_FILES} files`);
  let chosen = null;
  for (const name of candidates) {
    let document;
    try { document = readJson(fs, path.join(dir, name)); } catch { continue; }
    const catalog = document && document.catalog;
    if (!catalog || catalog.surface !== 'cc' || !catalog.config || !Array.isArray(catalog.config.models)) continue;
    const fetchedAt = Number.isFinite(document.fetchedAt) ? document.fetchedAt : 0;
    if (!chosen || fetchedAt > chosen.fetchedAt) chosen = { catalog, fetchedAt };
  }
  if (!chosen) {
    if (candidates.length) throw new ListUnreadable('no file in the catalog folder is a Claude Code catalog this build can read');
    return null;
  }
  let masked = [];
  const mask = readJson(fs, path.join(dir, 'masked-ids.json'));
  if (mask !== undefined) {
    if (!mask || !Array.isArray(mask.ids)) throw new ListUnreadable('masked-ids.json is not in a form this build can read, so the catalog is not shown');
    masked = mask.ids.filter(id => typeof id === 'string');
  }
  const hidden = model => model.confidential === true || masked.includes(model.id);
  const models = capped(chosen.catalog.config.models.filter(model => model && typeof model.id === 'string' && !hidden(model)).map(model => ({
    id: model.id, name: text(model.name, 120), description: text(model.description, 300),
    efforts: model.runtime ? efforts(model.runtime.effort_levels || []) : null,
    defaultEffort: model.runtime && typeof model.runtime.default_effort === 'string' ? model.runtime.default_effort : null
  })));
  const current = chosen.catalog.state && chosen.catalog.state.model;
  const aliases = {};
  for (const [alias, target] of Object.entries(chosen.catalog.config.provider_alias_targets || {})) {
    if (/^[a-z][a-z0-9-]{0,31}$/.test(alias) && target && typeof target.default === 'string' && !masked.includes(target.default)) aliases[alias] = target.default;
  }
  return {
    models, defaultModel: models.some(model => model.id === current) ? current : null,
    aliases, fetchedAt: chosen.fetchedAt ? new Date(chosen.fetchedAt).toISOString() : null
  };
}

/* Grok: what `grok models` prints (grok 1.0.60):
     Default model: <id>
     Available models:
       * <id> (default)
       - <id>
   Only the id lines of the "Available models:" section are read; a line there
   in any other form makes the list unreadable rather than guessed at. The
   output gives no names, descriptions or depths, so none are shown. */
function grokModelsCommand(stdout) {
  const lines = stdout.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === 'Available models:');
  if (start < 0) throw new ListUnreadable('its output has no "Available models:" section');
  const models = [];
  let marked = null;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) { if (models.length) break; continue; }
    const match = /^\s+([*-])\s+(\S+)(\s+\(default\))?\s*$/.exec(line);
    if (!match) throw new ListUnreadable('its "Available models:" section has a line this build cannot read');
    models.push({ id: match[2], name: null, description: null, efforts: null, defaultEffort: null });
    if (match[3]) marked = match[2];
  }
  const declared = lines.map(line => /^Default model:\s*(\S+)\s*$/.exec(line)).find(Boolean);
  const listedModels = capped(models);
  const current = declared ? declared[1] : marked;
  return { models: listedModels, defaultModel: listedModels.some(model => model.id === current) ? current : null, aliases: {}, fetchedAt: null };
}

/* Run the agent's own listing command: its own program, the descriptor's
   plain arguments, no shell, the caller's environment (so the agent's own home
   variable applies), bounded in time and output. Not installed reads as no
   list here yet; a failed run is unreadable, and its output is never shown. */
function runListCommand(run, command, args, env) {
  const shown = `\`${[command, ...args].join(' ')}\``;
  const result = run(command, args, { env, encoding: 'utf8', timeout: LIST_COMMAND_TIMEOUT_MS, maxBuffer: MAX_LIST_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
  if (result.error) {
    if (result.error.code === 'ENOENT') return null;
    if (result.error.code === 'ETIMEDOUT') throw new ListUnreadable(`${shown} did not finish within ${LIST_COMMAND_TIMEOUT_MS / 1000} s`);
    if (result.error.code === 'ENOBUFS') throw new ListUnreadable(`${shown} printed more than ${MAX_LIST_BYTES} bytes`);
    throw new ListUnreadable(`${result.error.code || 'error'} running ${shown}`);
  }
  if (result.status !== 0) throw new ListUnreadable(`${shown} exited with ${result.status === null ? `signal ${result.signal}` : `status ${result.status}`}`);
  return String(result.stdout || '');
}

const READERS = Object.freeze({ 'codex-models-cache': codexModelsCache, 'claude-served-catalog': claudeServedCatalog });
const COMMAND_READERS = Object.freeze({ 'grok-models-command': grokModelsCommand });

function freezeModels(models) {
  return Object.freeze(models.map((model, order) => Object.freeze({ ...model, order })));
}

/** The models one agent's own program lists on this computer. Never throws. */
function discoverModels(descriptor, { env = process.env, fs = nodeFs, run = childProcess.spawnSync } = {}) {
  const list = descriptor.models && descriptor.models.list;
  const base = { provider: descriptor.id };
  if (!list) {
    return Object.freeze({ ...base, state: 'no-list', source: null, models: Object.freeze([]), defaultModel: null, aliases: Object.freeze({}),
      reason: `${descriptor.name} keeps no model list Fleet can read before a session. Its own default model runs, or name an exact model id and ${descriptor.name} accepts or refuses it.` });
  }
  if (COMMAND_LIST_FORMATS.includes(list.format)) {
    const source = [descriptor.command, ...list.args].join(' ');
    try {
      const stdout = runListCommand(run, descriptor.command, list.args, env);
      if (stdout === null) {
        return Object.freeze({ ...base, state: 'not-found', source, models: Object.freeze([]), defaultModel: null, aliases: Object.freeze({}),
          reason: `${descriptor.name} is not installed on this computer (\`${descriptor.command}\` was not found), so its own list could not be asked for. Once installed, its own default model runs, or name an exact model id.` });
      }
      const found = COMMAND_READERS[list.format](stdout);
      return Object.freeze({ ...base, state: 'listed', source, models: freezeModels(found.models), defaultModel: found.defaultModel,
        aliases: Object.freeze({ ...found.aliases }), fetchedAt: found.fetchedAt });
    } catch (error) {
      if (!(error instanceof ListUnreadable)) throw error;
      return Object.freeze({ ...base, state: 'unreadable', source, models: Object.freeze([]), defaultModel: null, aliases: Object.freeze({}),
        reason: `${descriptor.name}'s model list could not be read (${error.message}); no model was guessed.` });
    }
  }
  let source;
  try {
    source = path.join(require('./registration').profile(descriptor, env).root, ...list.path.split('/'));
  } catch (error) {
    return Object.freeze({ ...base, state: 'unreadable', source: null, models: Object.freeze([]), defaultModel: null, aliases: Object.freeze({}),
      reason: `${descriptor.name}'s profile folder could not be found: ${error.message}` });
  }
  try {
    const found = READERS[list.format](fs, source);
    if (!found) {
      return Object.freeze({ ...base, state: 'not-found', source, models: Object.freeze([]), defaultModel: null, aliases: Object.freeze({}),
        reason: `${descriptor.name} has not stored a model list on this computer yet; sign in and start ${descriptor.name} once. Until then its own default model runs, or name an exact model id.` });
    }
    return Object.freeze({ ...base, state: 'listed', source, models: freezeModels(found.models), defaultModel: found.defaultModel,
      aliases: Object.freeze({ ...found.aliases }), fetchedAt: found.fetchedAt });
  } catch (error) {
    if (!(error instanceof ListUnreadable)) throw error;
    return Object.freeze({ ...base, state: 'unreadable', source, models: Object.freeze([]), defaultModel: null, aliases: Object.freeze({}),
      reason: `${descriptor.name}'s model list could not be read (${error.message}); no model was guessed.` });
  }
}

/* The worker selections, keyed by the name a caller passes:
     "<agent>"             the agent's own default model; Fleet passes no model
     "<agent>/<model id>"  one model from the agent's own list, unchanged
   Each row carries the provider's own words for the model and the depths its
   list gives; a row with `efforts: null` has no listed depths. Generic model
   connections are the person's own saved rows and are added elsewhere. */
function workerChoices(registry, agentIds, { env = process.env, fs = nodeFs, run = childProcess.spawnSync } = {}) {
  const rows = {}, lists = {};
  for (const id of agentIds) {
    const descriptor = registry.get(id);
    const found = discoverModels(descriptor, { env, fs, run });
    lists[id] = found;
    // passThrough: with no list read, an exact model id goes to the agent
    // unchanged; with a list, an id the agent does not list is refused by name.
    rows[id] = Object.freeze({ provider: id, model: '', cliModel: '', providerDefault: true, passThrough: found.state !== 'listed',
      name: `${descriptor.name}'s own default model`, takesEffort: descriptor.models.effort, efforts: null });
    for (const model of found.models) {
      rows[`${id}/${model.id}`] = Object.freeze({ provider: id, model: model.id, cliModel: model.id, listed: true,
        name: model.name, description: model.description, order: model.order, takesEffort: descriptor.models.effort,
        efforts: descriptor.models.effort ? model.efforts : Object.freeze([]), defaultEffort: model.defaultEffort,
        // ACP session selection validates the live advertised values and confirms
        // the setting before openAcpSession can return or send a prompt. A CLI
        // listing without depths must not fabricate a list or prevent that check.
        ...(descriptor.models.effort && model.efforts === null
          && descriptor.worker?.driver === 'acp' && descriptor.worker.modelSelection === 'session'
          ? { effortVerification: 'acp-session-before-prompt' } : {}),
        ...(found.defaultModel === model.id ? { providerDefaultModel: true } : {}) });
    }
  }
  return Object.freeze({ rows: Object.freeze(rows), lists: Object.freeze(lists) });
}

/* Why an exact model id cannot run on an agent's own default, or null. An
   agent whose list was read offers exactly that list; one with no list read
   takes any exact id and accepts or refuses it itself. */
function modelRefusal(rows, defaultRow, model) {
  if (typeof model !== 'string' || !MODEL_ID.test(model)) return 'The model must be an exact model id.';
  if (defaultRow.passThrough) return null;
  const offered = Object.entries(rows).filter(([, row]) => row.listed && row.provider === defaultRow.provider).map(([, row]) => row.model);
  return `"${model}" is not in ${defaultRow.provider}'s own model list. It lists: ${offered.join(', ') || 'none'}.`;
}

/** The listed selection for an exact model id of one agent, or null. */
function listedSelection(rows, provider, model) {
  const key = `${provider}/${model}`;
  return typeof model === 'string' && Object.prototype.hasOwnProperty.call(rows, key) && rows[key].listed ? key : null;
}

/* Why a reasoning depth cannot be applied to a selection, or null when it can.
   A depth is applied only when the model's own list names it: an agent's
   program can ignore a depth it does not take and run its default instead
   (Claude Code 2.1.309 warns "Unknown --effort value ... ignoring it"), and a
   caller told one depth who got another has been told a thing that is not so. */
function effortRefusal(row, effort, selection) {
  if (!row) return `"${selection}" is not a selection this computer offers.`;
  if (row.adapter === 'model-api') return 'Generic model connections have no Fleet reasoning-effort setting. Omit effort; the saved connection fixes the model and its limits.';
  if (!row.takesEffort) return `"${selection}" runs on ${row.provider}, which has no reasoning-effort setting at all, so "${effort}" could not have been applied. Drop effort.`;
  if (!Array.isArray(row.efforts) && row.listed
      && row.effortVerification === 'acp-session-before-prompt') {
    return typeof effort === 'string' && EFFORT.test(effort)
      ? null : 'The requested reasoning effort is not a valid setting name.';
  }
  if (!Array.isArray(row.efforts) && row.listed) {
    return `${row.provider}'s own list names no depths for "${selection}", so Fleet cannot show that "${effort}" would apply. Drop effort to let the model use its own default.`;
  }
  if (!Array.isArray(row.efforts)) {
    return `"${selection}" has no depth list from ${row.provider}'s own model list, so Fleet cannot show that "${effort}" would apply. `
      + `Name a model from ${row.provider}'s list ("${row.provider}/<model id>"), or drop effort to let the model use its own default.`;
  }
  if (!row.efforts.includes(effort)) {
    return row.efforts.length
      ? `"${selection}" does not offer the depth "${effort}". Its own list offers: ${row.efforts.join(', ')}.`
      : `"${selection}" takes no reasoning depth, so "${effort}" could not have been applied. Drop effort.`;
  }
  return null;
}

module.exports = Object.freeze({ effortRefusal, modelRefusal, LIST_FORMATS, FILE_LIST_FORMATS, COMMAND_LIST_FORMATS, EFFORT, LIST_COMMAND_TIMEOUT_MS, MAX_LIST_BYTES, MAX_CATALOG_FILES, MAX_MODELS, MODEL_ID, discoverModels, workerChoices, listedSelection });
