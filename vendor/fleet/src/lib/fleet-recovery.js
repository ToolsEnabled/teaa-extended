'use strict';

// Keep the refusal's original code/reason and add a recovery instruction at
// Fleet's public boundaries, including errors propagated by adapters or policy.
// This changes no admission, identity, concurrency or permission decision.
const steps = {
  AGENT_WORKER_HELD: 'Choose another agent or a direct model for worker work; this held provider remains available only as the lead.',
  FLEET_METRICS_PAGE_INVALID: 'Use a nonnegative integer offset and an integer limit from 1 through 1000 on usage-read or metrics-read.',
  FLEET_METRICS_STALE_REVISION: 'Restart usage-read or metrics-read from offset 0 and carry the returned metrics revision as expectedMetricsRevision across pages.',
  FLEET_RULES_UNAVAILABLE: 'Read the retained diagnostic and have the lead repair the unreadable rules source; then explicitly resume with current rules. Do not run under missing rules.',
  FLEET_ASSIGNMENT_INVALID: 'Have the lead read the retained task and repair its task/rules revision through Fleet before resuming.',
  OPENSHELL_AGENT_EMPTY_SURFACE: 'Choose a role with tools permitted by the parent surface and workspace boundary; ask the lead for the required capability rather than widening your own permissions.',
  MC_TREE_COMMAND_NODE_NOT_FOUND: 'Read fleet.control for the current tree and choose an existing descendant nodeId.',
  TREE_CONFIGURATION_REFUSED: 'Read the current descendant worker identity and available configuration. Choose a target within your managed subtree; route other targets to their manager.',
  CONTINUATION_HOST_REQUIRED: 'Use agent.continue on a supported standalone host; this connection cannot run ledger continuation.',
  CONTINUATION_LEDGER_SURFACE_REQUIRED: 'Ask the lead to select a permitted worker role that already has ledger.read, t_ledger.progress and t_ledger.complete; then enroll only its assigned tasks.',
  CONTINUATION_RUN_CONFLICT: 'Keep the retained run unchanged; choose a new unique runId for a different assignment after settling the old run.',
  CONTINUATION_TASK_NOT_ASSIGNED: 'Use ledger.read to select tasks already assigned to this worker, or have the lead assign them before enrollment.',
  CONTINUATION_TASK_BUSY: 'Read the task and its current worker; let that worker finish or have its manager disable the old enrollment before assigning another.',
  CONTINUATION_RECONCILIATION_REQUIRED: 'Inspect the saved conversation and artifacts, record the actual result or a new task checkpoint, then enroll again.',
  CONTINUATION_PERSISTENCE_FAILED: 'Preserve retained state, have the lead/operator repair persistence, and reconcile the interrupted work before resuming continuation.',
  ACTION_PERMISSION_PROFILE_INVALID: 'Call permission-profiles-read, correct the named profile field to a supported value, then retry the profile edit.',

  FLEET_CONTROL_ID_INVALID: 'Use 1–64 lowercase letters, digits, hyphens or underscores, starting with a letter or digit; retry with a stable unique id.',
  FLEET_CONTROL_TEXT_INVALID: 'Supply the named field as nonempty text within the stated bound and retry.',
  FLEET_CONTROL_STALE_REVISION: 'Call fleet.control action read (view full) for the affected worker or shared records without expectedRevision, reconcile the change, then use the returned revision as expectedRevision. Restart paged reads from offset 0.',
  FLEET_TASK_STALE_REVISION: 'Call fleet.control action read with view full and reconcile your work with that assignment before reporting. Never relabel an old task report with a newer taskRevision. Lead assessments must name the exact retained taskRevision.',
  FLEET_TASK_AMENDED: 'Read the full assignment with fleet.control action read, finish the correction, then report against that taskRevision.',
  FLEET_CONTROL_REVISION_SCOPE_INVALID: 'Use revisionScope global for shared settings, rules or subtree actions; use target only on supported V3 worker, ask or job edits.',
  FLEET_CONTROL_ROOT_REQUIRED: 'Route the requested change to the lead in a durable ask or progress report; the lead uses its own fleet.control connection.',
  FLEET_CONTROL_WORKER_REQUIRED: 'File the ask from the active assigned worker connection; a lead coordinates through task edits and answers.',
  FLEET_CONTROL_SESSION_INVALID: 'Stop using this inactive connection. The lead must read the worker record, assign work if needed and resume it; continue through the newly bound worker connection.',
  FLEET_CONTROL_NODE_UNKNOWN: 'Read fleet.control to choose an existing nodeId, or use agent.spawn to create the intended worker before assigning it work.',
  FLEET_TASK_PAUSE_REQUIRED: 'For a completed/held plain follow-up, use task with keepConversation true. Otherwise call fleet.control action pause for this nodeId, read the returned revision, then retry the task edit and resume the worker.',
  FLEET_TASK_VERIFYING: 'Read the retained verification status and wait for the lead check commands. Repeat only the identical completion for its receipt; after checks finish, continue assigned rework or let the lead assign a completed/held follow-up with keepConversation true.',
  FLEET_CHECKS: 'Have the lead inspect requirements.checks and correct the named command or timeout using task/resume or the job work item; workers report evidence without changing lead-owned checks.',
  FLEET_VERIFICATION_RESULTS_INVALID: 'Have the host operator inspect the retained verification and restore one result per lead command in the original order; never fabricate passed results or overwrite the completion.',
  FLEET_VERIFICATION_RECOVERY_REQUIRED: 'Preserve the retained verifying task and diagnostics. Have the host operator repair the failed verification write, then restart the host to rerun its repeatable lead commands.',
  FLEET_JOB_SCHEDULE_INVALID: 'Read job-read for this job, then retry job-schedule with schedule null (off), {every: positive integer, unit: minutes|hours|days}, or {dailyUtc: HH:MM} in UTC. Existing queued tasks remain retained.',
  FLEET_TASK_REPORTED: 'Read the retained terminal report. For a correction, ask the lead to assign explicit follow-up work; do not overwrite this report.',
  FLEET_TASK_COMPLETED: 'Read the retained result. For a queued job, inspect job-read and explicitly resume its next item. For a plain assignment, assign the next task explicitly with task and keepConversation true to retain context; paused/stopped workers still require resume.',
  FLEET_ASK_REPLAY_CONFLICT: 'Keep the existing ask unchanged; file this different question with a new globally unique id for the current task.',
  FLEET_ASK_UNKNOWN: 'Read retained asks with fleet.control action read and use an existing ask id.',
  FLEET_ASK_ALREADY_ANSWERED: 'Read the retained answer. Send a correction through an explicit task edit; do not overwrite or replay a different answer.',
  FLEET_ASK_SUPERSEDED: 'Read the current task and its asks. Answer only a current question; archive the obsolete ask if no longer needed.',
  FLEET_ASK_NOT_ANSWERED: 'Read the ask status and current assignment; answer a current open ask or use an explicit task/resume action for further work.',
  FLEET_ANSWER_RESUME_RECORDED: 'Read the worker and retained resumeAttempt. After resolving any failed or unconfirmed attempt, use an explicit fleet.control action resume; do not replay the answer to dispatch again.',
  FLEET_WORKER_ACTIVE: 'Let the active worker read the retained answer; use fleet.control action read to inspect progress rather than starting another turn.',
  FLEET_RESULT_UNKNOWN: 'Read the worker with view full, including task history; assess only a taskRevision with a terminal result.',
  FLEET_RESULT_EVIDENCE_REQUIRED: 'Supply concrete evidence for the named passed/failed check, or report its actual status as not_run or unknown.',
  FLEET_RESULT_INPUT_INVALID: 'Correct the named field or option using the tool schema, preserve unique ids and nonempty evidence, then retry.',
  FLEET_CONTROL_RESUME_INVALID: 'Use boolean resume only with action answer; for a separate lifecycle change use action resume with nodeId and expectedRevision.',
  FLEET_CONTROL_ACTION_INVALID: 'Choose an action advertised in fleet.control; workers use read, ask, progress, complete or hold.',
  FLEET_CONTROL_INPUT_INVALID: 'Correct the named option to the stated type and range, then retry.',
  FLEET_CONTROL_PAGE_INVALID: 'Use offset 0 or the returned nextOffset and a positive integer limit; retain the read revision across pages.',
  FLEET_CONTROL_STORE_INVALID: 'Preserve the retained store and report this code to the lead/operator for recovery; do not edit or delete the state file to bypass validation.',
  FLEET_SETTINGS_UNAVAILABLE: 'Have the lead use a Fleet host with its settings writer configured; continue work that does not require this setting.',
  FLEET_SETTINGS_PAUSE_REQUIRED: 'Pause the affected live workers with fleet.control action pause, read the latest revision, then retry the shared edit.',
  FLEET_SETTINGS_INVALID: 'Call fleet.control action settings-read, correct the named setting value to its supported type/range, then retry.',
  FLEET_SETTING_EXCLUDED: 'Call fleet.control action settings-read and choose an exposed setting; route changes outside that catalogue to the person or host operator.',
  FLEET_SETTING_AUTHORITY_REFUSED: 'Keep the inherited permission boundary; route the required scope change to the person or host operator.',
  FLEET_RESOURCE_GATE_UNAVAILABLE: 'Have the lead/operator configure a supported native resource gate before submitting resource advice.',
  FLEET_RESOURCE_GATE_CLOSED: 'Read resources-read; have the lead/operator restore the host resource gate before launching new work.',
  FLEET_RESOURCE_POLICY_INVALID: 'Read resources-read, correct the named resource policy field and its CPU/interval relationships, then retry.',
  FLEET_RESOURCE_ADVICE_INVALID: 'Supply a unique advice id, supported provider, allow/hold decision, launch allowance and an expiry within 60 seconds, then retry.',
  FLEET_SUBTREE_STOP_UNAVAILABLE: 'Have the lead use a host supporting subtree stop; do not treat this as proof that descendants stopped.',
  FLEET_SUBTREE_DRAINING: 'Read the subtree stop state; let an active stop settle, or retry stop-subtree to finish retained incomplete cleanup before resuming descendants.',
  FLEET_QUIESCENCE_UNPROVEN: 'Inspect the worker adapter and retained cleanup evidence with the lead/operator; prove owned execution stopped before resuming or replacing it.',
  FLEET_FOLDER_TRANSITION: 'Wait for the current folder transition to quiesce workers, then read current state and retry.',
  FLEET_LANE_UNKNOWN: 'Read fleet.control to find the retained job id, then call job-read with that id.',
  FLEET_LANE_NOT_PAUSED: 'Call job-read for this id. Use job-resume only for a paused job; create a new job if the old one is closed.',
  FLEET_LANE_INPUT_INVALID: 'Correct the named job field using the schema; supply either tasks or workItems, valid ids and nonempty text, then retry.',
  FLEET_LANE_REQUIRED: 'Read job-read and report only on this worker’s current assigned item.',
  AGENT_SPAWN_TREE_BUSY: 'Wait for this caller’s pending spawn receipt before starting another worker; do not duplicate an unconfirmed launch.',
  AGENT_SPAWN_TREE_UNAVAILABLE: 'Use the agent tools from the application or Fleet host that owns this tree.',
  AGENT_TREE_COMMAND_UNAVAILABLE: 'Use the agent tools from the application or Fleet host that owns this tree.',
  AGENT_TREE_COMMAND_UNKNOWN: 'Choose an advertised agent action and provide its required fields.',
  AGENT_TREE_COMMAND_NO_NODE: 'Read fleet.control to find the intended worker and supply its nodeId.',
  AGENT_RESUME_ASSIGNMENT_REFUSED: 'Use agent.resume with nonempty assignment text, or omit assignment on other agent actions.',
  AGENT_WAIT_UNAVAILABLE: 'Read reports from the normal inbox on the next tool response; have the lead/operator update the host if waiting is required.',
  AGENT_WAIT_TREE_SESSION_REQUIRED: 'Use agent.wait through the current manager connection bound to this tree.',
  AGENT_WAIT_SESSION_CHANGED: 'End the old wait and read reports from the current manager session; do not reuse the old session or turn identity.',
  AGENT_WAIT_TIMEOUT_INVALID: 'Retry agent.wait with an integer timeoutSeconds from 1 through 60.',
  AGENT_REPORT_INVALID: 'Use the reportId returned by agent.wait, offset 0 or its nextOffset, and an integer limit from 2 through 4000.',
  AGENT_REPORT_UNAVAILABLE: 'Use a reportId returned within your own managed subtree; route another subtree’s report request through the lead.',
  AGENT_SPEED_CHOICE_REFUSED: 'Choose one of the adapter’s returned speed choices and retry agent.set_speed.',
  AGENT_SPEED_UNAVAILABLE: 'Keep the current speed or choose a supported adapter; inspect the worker’s speed choices before retrying.',
  AGENT_SPEED_PROVIDER_CHANGE_PENDING: 'Apply or cancel the pending provider change through the manager, then inspect supported speed choices.',
  AGENT_SPAWN_EFFORT_REFUSED: 'Omit effort for a generic model connection; otherwise choose an effort supported by the selected provider/model.',
  OPENSHELL_AGENT_BRIEF_REQUIRED: 'Retry agent.spawn with a nonempty brief stating the assigned work.',
  OPENSHELL_AGENT_NOT_RUNNING: 'Read the worker state and have its manager resume the saved worker before sending another turn.',
  MC_TREE_COMMAND_SESSION_CHANGED: 'Read the worker’s current session identity and reconcile the lifecycle change before retrying with that identity.',
  MC_TREE_COMMAND_STOP_UNAVAILABLE: 'Read the worker state; a worker without a live session needs no stop. Resume only when new work is intended.',
  MC_TREE_COMMAND_REMOVE_REFUSED: 'Stop a running target first; remove descendants before their parent only when deletion is authorized and their retained work is no longer needed.',
  OPENSHELL_TREE_LINK_REFUSED: 'Stop using the old worker connection; the lead must resume the worker and let Fleet supply its new authenticated connection.',
  OPENSHELL_TREE_LINK_INVALID: 'Use only operations advertised by this worker connection; report a broken Fleet link binding to the lead without reading or copying its credential.',
  FLEET_ACTION_STALE: 'Read the worker’s current assignment and lifecycle state, reconcile the change, then issue a new action if it is still needed.',
  AGENT_TURN_IDENTITY_UNAVAILABLE: 'Inspect retained work and the provider adapter with the lead; restore turn identity support before explicitly resuming.',
};
function nextStep(code = '', context = {}) {
  if (Object.hasOwn(steps, code)) return steps[code];
  if (/^FLEET_CHECKS(?:_|$)/.test(code)) return steps.FLEET_CHECKS;
  if (/^FLEET_VERIFICATION(?:_|$)/.test(code)) return steps.FLEET_VERIFICATION_RECOVERY_REQUIRED;
  if (/FLEET_(?:RESUME|LIFECYCLE)|PROVIDER.*RESUME/.test(code)) return 'Read fleet.control for this worker and inspect retained diagnostics and actual provider state. Resolve the failure, then use an explicit resume only if the worker is quiet; never blindly replay an unconfirmed dispatch.';
  if (/ACCOUNT/.test(code)) return 'Read fleet.control action account-read for the intended provider/account. Have the lead/operator repair the named route or select an available authorized account before retrying; never copy credential values.';
  if (/FLEET_LANE_(?:ACTIVE|EXISTS|NODE_BUSY|CLOSED|CONTINUATION_ACTIVE)/.test(code)) return 'Read job-read for the retained job. Append with job-add, or explicitly close/disable the conflicting job or continuation before assigning a replacement.';
  if (/MODEL|PROVIDER|TIER/.test(code)) return 'Choose an available provider/model/tier within the inherited project limits and the advertised choices; have the lead/operator repair unavailable configuration before retrying.';
  if (/EFFORT|SPEED|CONFIGURATION_CHOICE/.test(code)) return 'Choose a value advertised for this worker’s provider/model and retry the corresponding agent setting.';
  if (/SESSION|CALLER|NOT_A_TREE_AGENT|TREE_SENDER/.test(code)) return 'Use the current live manager/worker connection bound to this tree; have the lead resume it if inactive.';
  if (/TOOL_NOT_ENABLED|SCOPE|NOT_BELOW_CALLER|DIRECT|ROLE|AUTHORIZ|PERMISSION|DELEGATION_REFUSED/.test(code)) return 'Use the granted tools and managed subtree. Route the blocked action and this refusal to the lead/person who owns that scope; do not change identity or permissions to bypass it.';
  if (/UNSUPPORTED|UNAVAILABLE|DISABLED|HOST_INVALID|PROFILE|SECURITY_MODE|TREE_CLOSED/.test(code)) return 'Have the lead/operator restore the required supported host capability or configuration, then use the new live connection; continue independent authorized work meanwhile.';
  if (/INVALID|REQUIRED|NO_NODE|BOUNDARY|CHOICE|UNKNOWN|NOT_FOUND/.test(code)) return 'Correct the named field using the advertised tool schema and current worker identity, then retry only that action.';
  if (/TREE_SLOT_LIMIT/.test(code)) return 'Reuse an existing worker with fleet.control task/resume, or stop a finished worker to free a live slot; stay within the saved tree width/depth.';
  if (/RESUME_REFUSED/.test(code)) return 'Read the worker state. Pause a running worker before resuming; if no saved conversation exists, use agent.restart only when repeating its brief is intended.';
  if (/CONTINUATION/.test(code)) return 'Inspect the worker and its assigned tasks; disable the conflicting continuation or restore the stated prerequisites before enrolling it again.';
  if (/ABORT_ERR|CANCELLED/.test(code)) return 'Respect the cancellation and inspect retained state; start a new action only under the person’s applicable instruction.';
  return context.tool === 'fleet.control'
    ? 'Read fleet.control state and inspect the named failure or retained diagnostic with the lead/operator. Reconcile any partial change before retrying; do not replay an unconfirmed lifecycle dispatch.'
    : 'Inspect the target worker and the named failure with its manager; resolve the cause and reconcile retained work before retrying. Do not duplicate an unconfirmed launch or lifecycle dispatch.';
}
function message(code, reason, context) {
  const original = String(reason || code || 'Fleet operation refused.');
  return original.includes(' Next: ') ? original : `${original} Next: ${nextStep(code, context)}`;
}
function error(cause, context) {
  if (cause && typeof cause.message === 'string') cause.message = message(cause.code, cause.message, context);
  return cause;
}
function result(value, context) {
  if (!value || typeof value !== 'object') return value;
  if (value.ok === false || value.accepted === false || ['refused', 'unsupported', 'skipped'].includes(value.status)) {
    const code = value.code || 'FLEET_OPERATION_REFUSED';
    return { ...value, code, reason: message(code, value.reason || value.message || 'The host refused this operation.', context) };
  }
  return value;
}
module.exports = { message, error, result };
