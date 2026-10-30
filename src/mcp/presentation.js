// A compact two-line heading for people watching tool calls:
//   ⚡ Ledger
//   ✅ rule saved to Ledger
// The first line names the tool family. The second is a status marker and a short phrase.
// It is one text item marked for the user. Upstream content, structuredContent, isError
// and _meta are passed through untouched. The heading has no color codes. Protocol
// 2025-11-25 can also carry one inline SVG lightning mark.

const FAMILY = {
  ledger: { icon: '⚡', done: 'Ledger updated', action: 'update Ledger' },
  tasks: { icon: '📋', done: 'task step done', action: 'finish task step' },
  memory: { icon: '🧠', done: 'memory step done', action: 'finish memory step' },
  search: { icon: '🔎', done: 'search step done', action: 'finish search step' },
  files: { icon: '📁', done: 'file step done', action: 'finish file step' },
  web: { icon: '🌍', done: 'web step done', action: 'finish web step' },
  browser: { icon: '🧭', done: 'browser step done', action: 'finish browser step' },
  status: { icon: '🩺', done: 'status checked', action: 'check status' },
  tools: { icon: '🧩', done: 'matching tools listed', action: 'find tools' },
  agents: { icon: '🤖', done: 'worker step done', action: 'finish worker step' },
  messages: { icon: '💬', done: 'message step done', action: 'finish message step' },
  audit: { icon: '🧾', done: 'audit log checked', action: 'check audit log' },
  control: { icon: '🎛️', done: 'Fleet control answered', action: 'use Fleet control' },
  'teaa': { icon: '⚡', done: 'connections checked', action: 'check connections' },
  knowledge: { icon: '📚', done: 'knowledge step done', action: 'finish knowledge step' },
  // Fleet names. These are headings for the tool, not a claim about the result.
  result: { icon: '📌', done: 'result reported', action: 'report result' },
  assessment: { icon: '🏷️', done: 'assessment recorded', action: 'record assessment' },
  account: { icon: '🪪', done: 'account call answered', action: 'answer account call' },
  lifecycle: { icon: '🔁', done: 'lifecycle recorded', action: 'record lifecycle' },
};

// [family, done phrase, action phrase]. The action phrase also becomes the human title.
const LINES = {
  'fleet:r_ledger.file': ['ledger', 'rule saved to Ledger', 'save rule to Ledger'],
  'fleet:t_ledger.file': ['ledger', 'task filed in Ledger', 'file task in Ledger'],
  'fleet:t_ledger.progress': ['ledger', 'task progress noted in Ledger', 'note task progress in Ledger'],
  'fleet:t_ledger.complete': ['ledger', 'Ledger task completed', 'complete Ledger task'],
  'fleet:a_ledger.file': ['ledger', 'question filed in Ledger', 'file question in Ledger'],
  'fleet:ledger.read': ['ledger', 'Ledger read', 'read Ledger'],
  'fleet:task.submit': ['tasks', 'task submitted', 'submit task'],
  'fleet:task.list': ['tasks', 'tasks listed', 'list tasks'],
  'fleet:task.get': ['tasks', 'task loaded', 'load task'],
  'fleet:task.claim': ['tasks', 'task claim answered', 'claim a task'],
  'fleet:task.start': ['tasks', 'task started', 'start task'],
  'fleet:task.heartbeat': ['tasks', 'task lease renewed', 'renew task lease'],
  'fleet:task.checkpoint': ['tasks', 'checkpoint saved', 'save checkpoint'],
  'fleet:task.complete': ['tasks', 'task completed', 'complete task'],
  'fleet:task.fail': ['tasks', 'task outcome recorded', 'record task outcome'],
  'fleet:task.cancel': ['tasks', 'cancellation requested', 'request cancellation'],
  'fleet:memory.get': ['memory', 'memory read', 'read memory'],
  'fleet:memory.search': ['memory', 'memory searched', 'search memory'],
  'fleet:memory.set': ['memory', 'memory saved', 'save memory'],
  'fleet:search.index': ['search', 'files indexed', 'index files'],
  'fleet:search.query': ['search', 'index searched', 'search index'],
  'fleet:search.status': ['search', 'search index checked', 'check search index'],
  'fleet:host.list_dir': ['files', 'folder listed', 'list folder'],
  'fleet:host.read_file': ['files', 'file read', 'read file'],
  'fleet:host.write_file': ['files', 'file written', 'write file'],
  'fleet:host.patch_file': ['files', 'file patched', 'patch file'],
  'fleet:settings.read': ['status', 'settings read', 'read settings'],
  'fleet:system.status': ['status', 'Fleet status checked', 'check Fleet status'],
  'fleet:system.doctor': ['status', 'Fleet checkup done', 'run Fleet checkup'],
  'fleet:capability.find': ['tools', 'matching tools listed', 'find tools'],
  'fleet:audit.status': ['audit', 'audit log checked', 'check audit log'],
  'fleet:audit.tail': ['audit', 'audit entries read', 'read audit entries'],
  'fleet:audit.verify': ['audit', 'audit log verified', 'verify audit log'],
  'fleet:agent.spawn': ['agents', 'worker started', 'start worker'],
  'fleet:agent.wait': ['agents', 'worker reports collected', 'collect worker reports'],
  'fleet:agent.stop': ['agents', 'worker stopped', 'stop worker'],
  'fleet:agent.restart': ['agents', 'worker restarted', 'restart worker'],
  'fleet:agent.remove': ['agents', 'worker removed', 'remove worker'],
  'fleet:agent.resume': ['agents', 'worker resumed', 'resume worker'],
  'fleet:agent.continue': ['agents', 'worker continued', 'continue worker'],
  'fleet:agent.set_model': ['agents', 'worker model set', 'set worker model'],
  'fleet:agent.set_effort': ['agents', 'worker effort set', 'set worker effort'],
  'fleet:agent.set_speed': ['agents', 'worker speed set', 'set worker speed'],
  'fleet:agent.set_provider': ['agents', 'worker provider set', 'set worker provider'],
  'fleet:agent.set_role': ['agents', 'worker role set', 'set worker role'],
  'fleet:agent_comms.send_local': ['messages', 'message sent', 'send message'],
  'fleet:agent_comms.local_roster': ['messages', 'team roster listed', 'list team roster'],
  'fleet:fleet.control': ['control', 'Fleet control answered', 'use Fleet control'],
  'knowledge:project_list': ['knowledge', 'projects listed', 'list projects'],
  'knowledge:project_find': ['knowledge', 'projects found', 'find projects'],
  'knowledge:project_brief': ['knowledge', 'project brief read', 'read project brief'],
  'knowledge:project_update': ['knowledge', 'project brief updated', 'update project brief'],
  'knowledge:knowledge_status': ['status', 'knowledge status checked', 'check knowledge status'],
  'engine:capability.find': ['tools', 'matching tools listed', 'find tools'],
  'engine:system.status': ['status', 'ToolsEngine status checked', 'check ToolsEngine status'],
  'engine:web.fetch': ['web', 'page fetched', 'fetch page'],
  'engine:web.extract': ['web', 'text extracted', 'extract text'],
  'engine:workspace.list': ['files', 'folder listed', 'list folder'],
  'engine:workspace.read_file': ['files', 'file read', 'read file'],
  'engine:workspace.write_file': ['files', 'file saved', 'save file'],
  'engine:workspace.search': ['files', 'files searched', 'search files'],
  'engine:browser.windows': ['browser', 'browser windows listed', 'list browser windows'],
  'engine:browser.tabs': ['browser', 'browser tabs handled', 'handle browser tabs'],
  'engine:browser.navigate': ['browser', 'page opened', 'open page'],
  'engine:browser.navigate_back': ['browser', 'went back a page', 'go back a page'],
  'engine:browser.snapshot': ['browser', 'page snapshot taken', 'take page snapshot'],
  'engine:browser.take_screenshot': ['browser', 'screenshot taken', 'take screenshot'],
  'engine:browser.click': ['browser', 'clicked', 'click'],
  'engine:browser.type': ['browser', 'text typed', 'type text'],
  'engine:browser.select_option': ['browser', 'option selected', 'select option'],
  'engine:browser.press_key': ['browser', 'key pressed', 'press key'],
  'engine:browser.file_upload': ['browser', 'file uploaded', 'upload file'],
  'engine:browser.close': ['browser', 'browser closed', 'close browser'],
  'engine:browser.transfer_firefox_profile': ['browser', 'browser profile transferred', 'transfer browser profile'],
  'teaa:status': ['teaa', 'connections checked', 'check connections'],
};

// fleet.control does many things; its action names what happened. [done, action]
const CONTROL = {
  read: ['assignment read', 'read assignment'],
  ask: ['question filed', 'file question'],
  progress: ['progress reported', 'report progress'],
  complete: ['task completion reported', 'report task completion'],
  task: ['assignment saved', 'save assignment'],
  rule: ['rule saved', 'save rule'],
  answer: ['answer saved', 'save answer'],
  'archive-ask': ['question archived', 'archive question'],
  pause: ['worker paused', 'pause worker'],
  resume: ['worker resumed', 'resume worker'],
  stop: ['worker stopped', 'stop worker'],
  remove: ['worker removed', 'remove worker'],
  settings: ['Fleet settings saved', 'save Fleet settings'],
  'settings-read': ['Fleet settings read', 'read Fleet settings'],
  hold: ['task held', 'hold task'],
  assess: ['assessment recorded', 'record assessment'],
  'stop-subtree': ['subtree stop recorded', 'stop a subtree'],
  'import-settings': ['settings imported', 'import settings'],
  resources: ['resources saved', 'save resources'],
  'resources-read': ['resources read', 'read resources'],
  'resource-advice': ['resource advice recorded', 'record resource advice'],
  'permission-profiles': ['permission profiles saved', 'save permission profiles'],
  'permission-profiles-read': ['permission profiles read', 'read permission profiles'],
  'metrics-read': ['metrics read', 'read metrics'],
  lane: ['lane saved', 'save lane'],
  'lane-add': ['lane tasks added', 'add lane tasks'],
  'lane-read': ['lane read', 'read lane'],
  'lane-rule': ['lane rule saved', 'save lane rule'],
  'lane-resume': ['lane resumed', 'resume lane'],
  'lane-close': ['lane closed', 'close lane'],
  job: ['job saved', 'save job'],
  'job-add': ['job tasks added', 'add job tasks'],
  'job-read': ['job read', 'read job'],
  'job-rule': ['job rule saved', 'save job rule'],
  'job-resume': ['job resumed', 'resume job'],
  'job-close': ['job closed', 'close job'],
};

// Some agents read tool names with underscores (task_list for task.list). Map those back.
const UNDERSCORED = new Map(Object.keys(LINES).map((id) => [id.replace(/\./g, '_'), id]));
function canonical(key, name) {
  const id = `${key}:${name}`;
  return LINES[id] ? id : UNDERSCORED.get(id) ?? id;
}

function family(key, name) {
  const raw = String(name);
  const head = raw.split('.')[0];
  if (head === 'ledger' || head.endsWith('_ledger')) return 'ledger';
  if (head === 'agent') return 'agents';
  if (head === 'agent_comms') return 'messages';
  if (head === 'audit') return 'audit';
  if (head === 'fleet') return 'control';
  if (head === 'task') return 'tasks';
  if (head === 'memory') return 'memory';
  if (head === 'search') return 'search';
  if (head === 'host' || head === 'workspace') return 'files';
  if (head === 'web') return 'web';
  if (head === 'browser') return 'browser';
  if (head === 'system' || head === 'settings') return 'status';
  if (head === 'capability') return 'tools';
  if (head === 'result' || head === 'results' || raw.startsWith('result_') || raw.startsWith('results_')) return 'result';
  if (head === 'assessment' || head === 'assessments' || raw.startsWith('assessment_')) return 'assessment';
  if (head === 'account' || head === 'accounts' || raw.startsWith('account_') || raw.startsWith('accounts_')) return 'account';
  if (head === 'lifecycle' || raw.startsWith('lifecycle_')) return 'lifecycle';
  if (key === 'knowledge') return name === 'knowledge_status' ? 'status' : 'knowledge';
  return key === 'teaa' ? 'teaa' : null;
}

// Tools TEAA has no phrase for (new upstream tools) still get their family icon and a plain line.
export function describe(key, name, label = key, args) {
  const id = canonical(key, name);
  const step = id === 'fleet:fleet.control' && typeof args?.action === 'string' && Object.hasOwn(CONTROL, args.action) ? CONTROL[args.action] : null;
  if (step) return { family: 'control', icon: FAMILY.control.icon, done: step[0], action: step[1] };
  const known = LINES[id];
  if (known) { const [f, done, action] = known; return { family: f, icon: FAMILY[f].icon, done, action }; }
  const f = family(key, name);
  if (f) return { family: f, icon: FAMILY[f].icon, done: FAMILY[f].done, action: FAMILY[f].action };
  return { family: 'other', icon: '⚡', done: `${label} ${name} done`, action: `run ${label} ${name}` };
}

export function humanTitle(key, name, label) {
  const { action } = describe(key, name, label);
  return action.charAt(0).toUpperCase() + action.slice(1);
}

const FAIL = new Set(['failed', 'failure', 'error', 'refused', 'rejected', 'denied', 'cancelled', 'canceled']);
const WAIT = new Set(['pending', 'waiting', 'timeout', 'timed_out', 'timedout']);
const BLUE = '#245eb5';
const GOLD = '#e0b33a';
const CATEGORY = {
  ledger: 'Ledger', tasks: 'Tasks', memory: 'Memory', search: 'Search', files: 'Files', web: 'Web', browser: 'Browser',
  status: 'Status', tools: 'Tools', agents: 'Workers', messages: 'Messages', audit: 'Audit', control: 'Control', 'teaa': 'TEAA',
  result: 'Result', assessment: 'Assessment', account: 'Account', lifecycle: 'Lifecycle', knowledge: 'Knowledge', other: 'Tool',
};
// Colored emoji are the portable status marks. Terminals that ignore SVG still show them. No ANSI.
const MARK = {
  info: '🔵', success: '✅', waiting: '⏳', queued: '📥', held: '⏸️', error: '❌', noop: '⚪',
  reported: '🟨', accepted: '✅', rework: '🔁', unaccepted: '🚫',
};

function normToken(value) {
  if (typeof value !== 'string' || value.length > 80) return '';
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

// Status lives on the result or its structuredContent, not in free text and not in arguments.
function pick(result, read) {
  const structured = result.structuredContent;
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    const value = read(structured);
    if (value !== undefined) return value;
  }
  return read(result);
}

// A string, or an object with a code or message, is a failed call. An empty
// object is not. The code and message are never copied into the heading.
function callError(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.message === 'string' && value.message.trim()) return true;
  if (typeof value.code === 'string' && value.code.trim()) return true;
  if (typeof value.code === 'number' && Number.isFinite(value.code)) return true;
  return false;
}

// What the call's own result says. isError, ok:false and an error value are
// call failures. queued, pending, held, timeout, a no-op stop, a reported
// completion and an accepted assessment are read from those fields.
// task.fail records a failure; that status is the outcome it stored, not a
// failed call. An error object on that same call is a failed call.
// status completed by itself is the queue finishing, not a lead assessment.
export function callState(result, { isError = false, name = '' } = {}) {
  if (isError || result?.isError === true) return 'error';
  if (!result || typeof result !== 'object') return 'ok';
  if (pick(result, (obj) => obj.ok) === false) return 'error';
  if (callError(pick(result, (obj) => obj.error))) return 'error';
  if (pick(result, (obj) => obj.timedOut) === true) return 'waiting';
  const status = normToken(pick(result, (obj) => obj.status ?? obj.state ?? obj.outcome));
  const decision = normToken(pick(result, (obj) => obj.assessment?.decision ?? obj.decision));
  const recordsFailure = name === 'task.fail' || name === 'task_fail';
  if (!recordsFailure && FAIL.has(status)) return 'error';
  if (status === 'held') return 'held';
  if (status === 'queued') return 'queued';
  if (WAIT.has(status)) return 'waiting';
  const stopped = pick(result, (obj) => obj.stopped);
  const already = pick(result, (obj) => obj.alreadyStopped) === true;
  const lifecycle = pick(result, (obj) => obj.lifecycle);
  const lifecycleNoop = lifecycle && typeof lifecycle === 'object' && (lifecycle.noop === true || lifecycle.changed === false);
  if ((stopped === false && already) || status === 'noop' || status === 'no_op' || status === 'already_stopped' || lifecycleNoop) return 'noop';
  if (decision === 'accepted') return 'accepted';
  if (decision === 'rework') return 'rework';
  if (decision === 'rejected') return 'unaccepted';
  if (decision === 'unassessed' || status === 'reported' || status === 'unassessed' || status === 'submitted') return 'reported';
  return 'ok';
}

function informational(name, action) {
  if (/^(read|list|check|verify|search|load|find|collect|fetch|extract|take)\b/.test(action)) return true;
  const tail = String(name).split(/[._]/).pop();
  return tail === 'read' || tail === 'list' || tail === 'status' || tail === 'get' || tail === 'search' || tail === 'verify' || tail === 'tail';
}

function visibleState(state, described, name) {
  if (state !== 'ok') return state;
  if (described.action === 'report task completion') return 'reported';
  if (informational(name, described.action)) return 'info';
  return 'success';
}

function phraseFor(state, described) {
  if (state === 'error') return `couldn't ${described.action}`;
  if (state === 'waiting') return `still waiting to ${described.action}`;
  if (state === 'held') return 'held, not finished';
  if (state === 'queued') return 'queued, not finished';
  if (state === 'noop') return `no change from ${described.action}`;
  if (state === 'accepted') return 'assessment accepted';
  if (state === 'rework') return 'assessment needs rework';
  if (state === 'unaccepted') return 'assessment not accepted';
  if (state === 'reported' && /\baccepted\b/i.test(described.done)) return 'result reported';
  return described.done;
}

export function presentationLine(key, name, { isError = false, label, args, result } = {}) {
  const described = describe(key, name, label, args);
  const state = visibleState(callState(result, { isError, name }), described, name);
  const category = CATEGORY[described.family] || CATEGORY.other;
  const marker = MARK[state] || MARK.success;
  return `${described.icon} ${category}\n${marker} ${phraseFor(state, described)}`;
}

// One blue tile and one gold bolt for every family. The heading names the family.
export function lightningSvg(family = 'teaa') {
  void family;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="${BLUE}"/><path fill="${GOLD}" d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>`;
}

function iconFor() {
  const svg = lightningSvg();
  return { src: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, mimeType: 'image/svg+xml', sizes: ['any'] };
}

export function toolIcons(family = 'teaa') {
  void family;
  return [iconFor()];
}

export function serverIcons() {
  return [iconFor('teaa')];
}

// audience ["user"] is the protocol's own marker for content meant for the person, not the model.
// It is valid on text content in every protocol version TEAA negotiates.
export function isPresentationItem(item) {
  return item?.type === 'text' && Array.isArray(item.annotations?.audience) && item.annotations.audience.length === 1 && item.annotations.audience[0] === 'user';
}

export function present(result, key, name, label, args) {
  if (!result || typeof result !== 'object') return result;
  const line = { type: 'text', text: presentationLine(key, name, { isError: result.isError === true, label, args, result }), annotations: { audience: ['user'] } };
  return { ...result, content: [line, ...(Array.isArray(result.content) ? result.content : [])] };
}

const OFF = new Set(['0', 'off', 'false', 'no']);
const ON = new Set(['', '1', 'on', 'true', 'yes']);
// TEAA_PRESENTATION=off removes the line; unset means on. Anything else is refused by name.
export function presentationEnabled(env = process.env) {
  const raw = env.TEAA_PRESENTATION;
  if (raw === undefined) return true;
  const v = String(raw).trim().toLowerCase();
  if (OFF.has(v)) return false;
  if (ON.has(v)) return true;
  throw new Error(`TEAA_PRESENTATION must be on or off (got ${JSON.stringify(String(raw).slice(0, 40))})`);
}
