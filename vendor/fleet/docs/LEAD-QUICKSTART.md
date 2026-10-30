# Fleet lead quickstart

Give Fleet the objective, scope and executable checks. Reuse existing worker
context when available; follow the person's rules. This example assumes V4,
a signed-in `codex`, and Node.js in the current workspace. `call(name, args)`
means an MCP tool call; keep returned values for subsequent calls.

Register MCP and scripts through a stable link such as `~/.local/opt/fleetV4-current/runtime`; the [upgrade sequence](FLEET-V4-SETUP.md#stable-runtime-link) keeps lead registrations unchanged.

For scripts, `node fleetV4.js call --state-root ABS --actor local TOOL [JSON_ARGS | -]` attaches exactly like `serve --attach` and prints one structured JSON line; `--batch` reads a JSON array of `{ "tool", "arguments" }` on stdin in one attachment and stops at the first refusal. For scripts acting on one target, `expectedRevision: "latest"` reads `fleet.control` (scoped to `nodeId` when given) immediately before the call; first read and reconcile the target, then edit as below. Optional `--tree-key`, `--name` and `--timeout` (seconds, default 60 for the attachment and all calls) select the connection and deadline. Exit 0 means success, 2 prints refusal JSON (`code`, `message`, `nextAction`), and 3 means transport/deadline failure with an unknown outcome: read state before any retry. Calls are never replayed. Unnamed calls choose a distinct automatic attachment name beside a live MCP connection; `--name` is used exactly. Wait for workers from one background command with `node fleetV4.js hub inbox --state-root ABS --actor local --since SEQ --wait 60`: it returns entries after SEQ immediately or waits on the hub for a new report, Ask or assignment notice, without moving lead cursors; deadline JSON includes `timedOut: true` and the current `head`, with exit 5.

```sh
node fleetV4.js call --state-root ABS --actor local fleet.control '{"action":"read","nodeId":"worker-id"}'
node fleetV4.js call --state-root ABS --actor local fleet.control '{"action":"task","nodeId":"worker-id","text":"Corrected scope","expectedRevision":"latest"}'
```

**Delegate.** One worker creates a website in `.`. Lead checks independently
inspect pages/links and run the delivered check script.

```js
// example: delegate
const edit = async args => call('fleet.control', {
  ...args, expectedRevision: (await call('fleet.control', {action: 'read'})).revision
});
const worker = await call('agent.spawn', {
  tier: 'codex',
  contract: `CONTRACT/1
role IMPLEMENTER
target .
do Create index.html and about.html with a title element and reciprocal relative links; write check-site.cjs to check both pages and links, and REPORT.md with the result.
because The person requested "a small website with pages, links and a check script".
done Both requirements checks exit 0; report the site artifact and check evidence through fleet.control complete.
report REPORT.md`,
  requirements: {
    scope: 'Create only index.html, about.html, check-site.cjs and REPORT.md.',
    outputs: [{id: 'site', path: 'index.html', description: 'Website entry page'}],
    checks: [
      {id: 'pages-links', description: 'Both pages have headings and reciprocal links.',
       command: `node -e "const f=require('fs');for(const [p,q] of [['index.html','about.html'],['about.html','index.html']]){const s=f.readFileSync(p,'utf8');if(!s.includes('<title>')||!s.includes('href='+JSON.stringify(q)))process.exit(1)}"`},
      {id: 'site-check', description: 'The delivered check script passes.', command: 'node check-site.cjs'}
    ]
  }
});
```

Checks run in a shell, so a `pgrep -f PATTERN` inside a check also matches the
check's own command line; bracket one character (`pgrep -f 'run --state-root /home/YOU/[.]fleet'`)
or check for files instead.

**Wait and read.** A turn report or `verifying` can arrive before checks finish.
Delivery requires `completed`, `verification.status: "passed"` and
`verification.verifiedBy: "Fleet"`; inspect check exits/output and `outcome`.
A script can repeat this pair until terminal; waiting spends no worker turn.

```js
// example: result
const notices = await call('agent.wait', {timeoutSeconds: 60});
const delivery = await call('fleet.control', {action: 'read', nodeId: worker.nodeId});
const verified = delivery.tasks[worker.nodeId];
```

**Intervene when needed.** After verification, follow up; while it runs, correct
it. `edit` reads the revision before writing. Follow a refusal's `Next:` guidance.

```js
// example: follow-up
await edit({action: 'task', nodeId: worker.nodeId, keepConversation: true,
  text: 'Add a contact footer to both pages. Ask which contact address to use.'});
```

```js
// example: correction
await edit({action: 'task', nodeId: worker.nodeId,
  text: 'Add a contact footer to both pages, including about.html. Ask which contact address to use; retain the existing pages, links and check script.'});
```

Correction needs no pause: the worker must read the amendment before finishing.
Paused/stopped follow-ups still need resume.
Check receipt `waitsFor` and `nextAction` for pending verification or the next explicit action that unblocks recorded work.
Once an open ask appears:

```js
// example: answer
const questions = await call('fleet.control', {action: 'read', nodeId: worker.nodeId});
const [askId] = Object.entries(questions.asks).find(([, ask]) => ask.status === 'open');
const answer = await edit({action: 'answer', id: askId, answer: 'Use contact@example.com.'});
```

Answer resumes by default; check `answer.resume.resumed` and its reason.
`resume: false` keeps the asker paused. Pause suspends execution; hold records
that this task cannot finish, retaining context. A held job item can advance.

```js
// example: hold
await edit({action: 'pause', nodeId: worker.nodeId});
await edit({action: 'hold', nodeId: worker.nodeId,
  text: 'Contact details need replacement. Retain the files; assign a follow-up when the replacement is available.'});
```

**Recurring business work.** Reuse the paused worker. Supply `orders.csv` with
one header and one order per row, no blank rows. Resume runs the job immediately;
then it runs daily at 09:00 UTC without sending messages.

```js
// example: recurring
await edit({action: 'job', id: 'orders', nodeId: worker.nodeId, workItems: [{
  text: 'ROLE: WORKER working in . -- Read orders.csv and write summary.md containing Orders: N, where N is the number of data rows. Do not send messages.',
  requirements: {outputs: [{id: 'summary', path: 'summary.md', description: 'Order count'}],
    checks: [{id: 'count', description: 'Summary agrees with the input row count.',
      command: `node -e "const f=require('fs');const n=f.readFileSync('orders.csv','utf8').trim().split(/\\r?\\n/).length-1;if(f.readFileSync('summary.md','utf8').trim()!=='Orders: '+n)process.exit(1)"`}]
  }
}]});
await edit({action: 'job-schedule', id: 'orders', schedule: {dailyUtc: '09:00'}});
await edit({action: 'resume', nodeId: worker.nodeId});
const job = await call('fleet.control', {action: 'job-read', id: 'orders'});
```

Due work waits for an idle boundary. Busy/paused jobs skip with reasons;
downtime creates no backlog. Schedules survive restart and never resume workers.
Disable future runs while keeping queued work:

```js
// example: unschedule
await edit({action: 'job-schedule', id: 'orders', schedule: null});
```

**No lead action:** unfinished work continues; failed checks send rework with
output. **Three failed verifications hold with evidence** (first failure when
continuation is off). Three automatic turns without new recorded progress
instead stop continuation, notify the lead and leave the task assigned.
Open asks and failed provider turns stop automatic turns. Short unfinished
turns back off from 30 seconds to 15 minutes. Waiting workers can defer for
1–2592000 seconds (30 days) on **their own connection**, then end the turn:

```js
// example: worker-wait
await call('fleet.control', {action: 'progress',
  text: 'Waiting for the input feed; check again in one minute.', waitSeconds: 60});
```

Checks run in the contract folder with inherited host permissions/environment.
Use repeatable commands: restart reruns in-flight checks. Passing proves these
commands passed; the lead remains responsible for the person's contract/rules.
See the [lead manual](LEAD-MANUAL.md) for details.
