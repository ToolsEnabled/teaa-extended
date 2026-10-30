'use strict';
const base = require('./host-descriptions');

function v5ContractLeadText(allowedNames, requestedAllowedNames) {
  const { CONTRACT_TOOLS } = require('./fleet-v5-surface');
  const requested = Array.isArray(requestedAllowedNames) ? requestedAllowedNames : [];
  if (!requested.length || requested.some(name => !CONTRACT_TOOLS.includes(name))) return null;
  const available = CONTRACT_TOOLS.filter(name => allowedNames.includes(name));
  if (!available.length) return null;
  const lines = [
    `Fleet V5 ordinary lead surface. Advertised contract tools: ${available.join(', ')}.`,
    'Describe work with its objective, authorized scope, applicable rules, definition of done, outputs and checks. Include only requirements and limits the contract schema supports.',
    'Use only contract tools listed above; this initialize note is narrowed to the current advertised capability set.'
  ];
  if (available.includes('fleet.contract.options')) lines.push('fleet.contract.options lists configurations currently supported by the resolver; inspect its results and choose an available configuration.');
  if (available.includes('fleet.contract.review')) lines.push('fleet.contract.review shows what a draft contract leaves open before you submit it; submit runs the same review, returns it, and never refuses a contract because of it. Declare expectations, variance and checks[].covers to close open points; pass resolves on answer and amend to link them to open points. For task snippets the review lists each task: a task without a completion contract is open (no-completion), and so is a choice in its text that none of its intentions names (no-intention).');
  if (available.includes('fleet.contract.library')) lines.push('fleet.contract.library lists the contract snippets (built-in and from earlier contracts) with their digests and the ambiguity each one cost across jobs; write a contract as compose (snippet refs) to make each requirement exact. Write the job as task snippets (catalog atoms with role task), one per piece of work: give each its completion contract (completion.done and completion.checks, how we know that piece is done) and state an intention ({about, intent}: what you want and why) for every decision the task leaves to the worker. Fleet sends each task as its own work item in order and verifies it on its own; docs/CONTRACT-SNIPPETS.md has a worked example.');
  if (available.includes('fleet.contract.submit')) lines.push('fleet.contract.submit records the complete contract, selection evidence and resulting Fleet job. Supply a stable idempotency key for that contract. If the outcome is uncertain, inspect the retained contract before considering any retry; ambiguous work is not replayed automatically.');
  if (available.includes('fleet.contract.inspect')) lines.push('fleet.contract.inspect reads retained execution state and the existing Fleet job outcome; distinguish reported work from checks verified by Fleet.');
  if (available.includes('fleet.contract.answer')) lines.push('Use fleet.contract.answer only for an Ask exposed by this contract, then inspect the receipt if the answer or normal resume result is unknown.');
  if (available.includes('fleet.contract.amend')) lines.push('Use fleet.contract.amend for supported changes to the retained contract, including objective, scope, rules, outputs and checks; prior scope and checks remain recorded when a follow-up is appended.');
  if (available.includes('fleet.contract.determinacy')) lines.push('fleet.contract.determinacy runs a finished contract\'s omission mutants (determinacy.mutants: a list of {id, omits, why, files}, or "worker" to have the worker write them to .fleet/mutants) in throwaway copies of its workspace and shows which requirements the checks really observe; a surviving mutant is a weak check. It is feedback only.');
  if (available.includes('fleet.contract.cancel')) lines.push('Use fleet.contract.cancel to close the existing contract job. Running work follows Fleet close semantics; cancellation does not claim forced rollback.');
  return lines.join('\n');
}

// Loading the document module can itself fail in a partial installation.
// Keep the coordination and rules instructions and report the missing manual.
function leadManualLines() {
  try { return [require('./lead-manual').leadManualText()]; }
  catch { return ['The Fleet lead manual (docs/LEAD-MANUAL.md in the Fleet runtime) could not be read; report this to the person.']; }
}

// The rules ledger, for the agent the person talks to. A lead is told to read
// it, to set agent rules in its own words, and to refine or replace them with
// the R.x.x ids. The person's authority stays in their own files and briefs.
// The active global rules are listed here
// so a lead has them from the first turn. Workers receive the same rules in
// their task text at spawn and resume (standing-rules-brief.js), so they are
// not handed these lines.
function workerManualText() {
  try { return require('./worker-manual').workerManualText(); }
  catch { return 'The Fleet interior manual (docs/WORKER-MANUAL.md in the Fleet runtime) could not be read; report this to the lead through fleet.control. Never message peers directly.'; }
}

function ledgerLines(allowedNames) {
  const read = allowedNames.includes('ledger.read');
  const file = allowedNames.includes('r_ledger.file');
  if (!read && !file) return [];
  const lines = [
    ...(read ? ['At session start, read the standing rules with ledger.read (kinds ["R"]) and follow them; system.status reports whether the rules ledger exists and how many rules are active.'] : []),
    file
      ? 'Fleet rules are agent rules filed and maintained by leads. File with r_ledger.file in your own clear words; ownerQuote is optional provenance only. Refine with parent "R3" (R3.1), or replace with supersedes "R3". Fix a blocking rule in the same turn. The person\'s authority lives outside Fleet in their own Markdown files and knowledge briefs. Report any filing warnings.'
      : 'This connection does not offer r_ledger.file. Keep the person\'s own instructions in their Markdown files and knowledge briefs; report needed Fleet rule changes to the lead.'
  ];
  if (allowedNames.includes('r_ledger.withdraw')) lines.push('Leads maintain the rules ledger: withdraw a stale or mistaken rule with r_ledger.withdraw using its exact scope/key, current ledger.read revision and a reason. Withdrawal retains history and removes the rule and its refinements from future delivery.');
  let listed = null;
  try { listed = require('./standing-rules-brief').standingRulesLines(); } catch { /* reported below */ }
  if (!listed) lines.push('The rules ledger could not be read just now; call ledger.read before relying on any rule.');
  else if (!listed.total) lines.push('There are no standing rules in the ledger yet.');
  else lines.push(['Active standing rules (global):', ...listed.shown, ...(listed.more > 0 ? [`(${listed.more} more; read them with ledger.read)`] : [])].join('\n'));
  return lines;
}

function briefToolSummary({ allowedNames = [], requestedAllowedNames, generation } = {}) {
  const ambient = process.env.TOOLSENABLED_FLEET_SECURITY === 'inherited-environment';
  const workers = allowedNames.includes('agent.spawn');
  // Tool narrowing never changes a connection's role. Restricted workers can
  // lack peer messaging, and restricted leads can lack lifecycle tools.
  const host = require('./tree-host-registry').treeSpawnHost();
  // Coordination-only roots have no tree host. configureHost establishes this
  // marker from the saved worker opt-in; serveHost refuses linked workers in
  // that mode. An installed worker host always takes precedence over it.
  const lead = host ? host.fleetOrchestrator === true
    : process.env.TOOLSENABLED_RUNTIME_MODE === 'host'
      && process.env.TOOLSENABLED_FLEET_PROFILE === 'fleetV2'
      && process.env.TOOLSENABLED_HOST_WORKERS === '0'
      && !process.env.TOOLSENABLED_HOST_NODE
      && !process.env.TOOLSENABLED_HOST_TREE_SOCKET
      && !process.env.TOOLSENABLED_HOST_SESSION;
  if (!lead) return host?.workerManualInTask === true
    ? { enabled: false, text: '' }
    : { enabled: true, text: workerManualText() };
  const contractGuidance = generation === 5
    ? v5ContractLeadText(allowedNames, requestedAllowedNames)
    : null;
  if (contractGuidance) return { enabled: true, text: contractGuidance };
  // The ordinary V5 contract lead advertises neither name. The manual and the
  // fleet.control sentence teach tools that connection does not have.
  const delegationAdvertised = allowedNames.includes('fleet.control') || workers;
  return { enabled: true, text: [
    `fleetV2 standalone MCP offers ${allowedNames.length} tools. Use the exact advertised Function IDs and schemas.`,
    workers ? (ambient ? 'Workers use provider bypass with approval prompts disabled and inherit this process environment and OS access restrictions. Fleet does not install a worker sandbox or elevate its permissions.' : 'Workers use provider bypass with approval prompts disabled. The saved explicit read/write policy constrains native worker processes and Fleet file tools.') : 'Worker launching is disabled for this connection.',
    ambient ? 'This session starts in the terminal working directory. Relative host file paths resolve there; absolute paths use existing OS access. The user supplies any external sandbox. Tasks, rules and Asks do not grant OS permissions.' : 'The configured folder policy is an operator declaration, not automatic detection of an arbitrary parent client. Do not infer folder authority from Ask, bypass, a task, a rule, or an answered Ask.',
    ...(delegationAdvertised ? ['Coordinate workers through fleet.control assignments, rules and durable Asks. Do not send workers direct messages. Pause a worker, edit its assignment or rules, then resume it on the current revision. Use the advertised lifecycle tools to monitor, stop or remove workers. To stack several tasks on one worker, create a lane (fleet.control lane) and check it with lane-read.'] : []),
    ...ledgerLines(allowedNames),
    ...(delegationAdvertised ? leadManualLines() : []),
    ...(ambient ? [] : ['Folder policy changes require the local operator entry point. Active workers must quiesce and acquire the new revision before resuming; stale sessions cannot continue.']),
    'Use host.read_file before host.write_file or host.patch_file for byte-coordinated edits. Native and shell edits inherit OS restrictions but do not participate in byte mediation.',
    'ToolsEngine is a separate MCP. Its shared Fleet settings file can disable Chrome session transfer; transfer still requires explicit user authorization.',
    ambient ? 'If a tool or native provider path is unavailable, report that limitation. Fleet does not provide filesystem or network isolation in inherited-environment mode.' : 'If a tool or native provider path is unavailable, report that limitation. The person can inspect fleetV2 status or update the declared folder scope with the installed fleetV2 CLI.'
  ].join('\n') };
}
module.exports = { ...base, briefToolSummary, workerManualText };
