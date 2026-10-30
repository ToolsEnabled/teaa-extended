# Writing Fleet V5 contracts as task snippets

A lead writes a Fleet V5 contract as **task snippets**: one snippet per piece
of work. Each task has its own **completion contract** (how we know that piece
is done), and states an **intention** for every decision it leaves to the
worker (what you want and why, not a list of allowed values). The tasks compose
into the job, in the order they are done.

The tools are `fleet.contract.review` (try a draft), `fleet.contract.submit`,
`fleet.contract.inspect` and `fleet.contract.library`. The worked example below
is in [`examples/contract-tasks.json`](examples/contract-tasks.json).

## Snippets and compose

A snippet is a TEBench bundle: `{id, version, kind, role, text, parameters?,
parameterSchema?, semantics}`. An `atom` is one requirement; a `template` has
`{{slot:name}}` places for other snippets. A contract's `compose` is a list of
refs `{use, params?, slots?}`. Fleet compiles them in order under an implicit
root, so every composed piece has a requirement id `root/part-N/...#bundle-id`
(for example `root/part-2#write-docs`). The compiled text is exactly what
TEBench compiles.

Your own snippets go in the contract's `catalog`, next to the built-ins that
`fleet.contract.library` lists (`tests-pass`, `committed`, `no-dependencies`,
`file-exists`, `scope-only`, `no-secrets`, ...). A built-in check snippet is a
requirement with a command; it applies to the whole job.

Parameters are written `{{name}}` in the text and in commands. Declare them in
`parameterSchema`, and give every parameter that reaches a shell command a
pattern in `fieldPatterns`: a value that does not match is refused before
anything is sent to Fleet.

## A task snippet

A task snippet is an atom with `role: "task"` whose semantics are:

```json
{ "kind": "task",
  "completion": {
    "done": "One sentence: what is true when this piece is done.",
    "checks": [{ "id": "tests", "description": "What the check shows", "command": "node --test test/" }],
    "fieldPatterns": { "dir": "^[A-Za-z0-9._/-]+$" } },
  "intention": [{ "about": "the choice, named", "intent": "What you want and why." }] }
```

- **text** is the instruction the worker reads. Write one piece of work, the
  way you would say it to a colleague.
- **completion** is the task's completion contract. `done` is the sentence the
  worker sees as "Done when: ...". Each check is a command Fleet runs when the
  worker reports the task finished; its id becomes `<bundle-id>-<check-id>`
  (`<bundle-id>-<N>-<check-id>` when the same snippet is used more than once).
  A check that needs longer than Fleet's 600 s default gives `timeoutSeconds`,
  an integer from 1 to 3600; any other value makes the composition invalid.
  A task without completion checks is reported as an open point
  (`no-completion`): nothing shows that piece is done.
- **intention** answers the decisions the task leaves to the worker. Any
  instruction that offers alternatives ("a table or a list", "you may use any
  heading style") is a choice. Write one intention per choice; its `about`
  names the choice in the task's own words ("table or list"), and its `intent`
  says what you want and why ("Either; pick what reads best on GitHub."). A
  choice no intention of the same task names is an open point (`no-intention`).
  Intentions are declared variance, so they do not count as open.

Keep forbidding sentences negative ("Do not rename or delete files"): they
leave nothing open and are not choices.

## How Fleet runs it

`fleet.contract.submit` turns a composition with tasks into one Fleet work item
per task, in compose order, so Fleet tracks and verifies each task on its own:

- the first item carries the objective and the list of all tasks, then task 1;
- every item states its task, `Done when: <done>`, the checks Fleet runs for
  it and its intentions, and carries that task's completion checks;
- the last item also carries the composed text that is not a task (built-in
  check snippets, templates around tasks), the contract's own `checks` and
  `outputs`, and the contract-level open points;
- each item lists the open points on its own task, with the request for a
  Decisions section.

Write the objective as the purpose of the job ("The accounting team needs
CSV export ..."): the tasks are its requirements and their completion
contracts its definition of done. An objective written as one more instruction
("Add CSV export.") has no check of its own and is reported as an open point.

A contract without task snippets is one work item, as before. An invalid
composition (an unknown snippet, a missing parameter, a field pattern a value
breaks, a check id that collides with one of the contract's own) is refused
with `FLEET_V5_COMPOSITION_INVALID` before any Fleet request.

If an earlier task is held and a later task completes, the contract follows the
latest task; the hold stays in the item history. A hold on the last task holds
the contract.

## Review before you submit

`fleet.contract.review` returns `tasks`, one row per task:

```json
{ "requirementId": "root/part-1#add-export", "bundleId": "add-export", "completionChecks": 2, "intentions": 1, "open": 0 }
```

The review reads a task's text one sentence at a time (each clause of a
semicolon list counts as its own sentence):

- The first sentence is the task's statement. Its completion checks cover it
  (`coverage` basis `completion`).
- A later sentence that states a result is a requirement of the task. Examples:
  "The service must stay reachable", "finish the import within two days",
  "keep the error rate below 1%". It is an open point (`no-check`) unless a check
  covers it. The task's own checks are tried first, then any other check of the
  job.
- A later sentence that says how to work is a step. Examples: "Copy with
  rsync", "Never run two imports at once". A step is a trust-only constraint of
  the task unless a check observes it.
- A choice sentence is answered by the task's intentions.

Every unit, open point and trust-only entry from a task carries `task`, the
task's requirement id. Its open points go on that task's work item. A
completion check also covers the prose it observes, such as a definition of
done line or an output, the same way a contract check does.

Aim for `open: 0` on every task:

- for `no-completion`, add completion checks;
- for `no-intention`, add an intention whose `about` names the choice;
- for a `no-check` sentence, add a completion check that observes it, or make
  it the task's statement.

Alternatives count as a choice only in an instruction ("Use a table or a
list"). A statement ("A cron job or a timer runs the cleanup"), a condition ("only
when X or Y") or a restriction ("only in A or B") leaves nothing to choose.
Vague wording ("good", "should", "etc.") is reported per sentence.

## After the work

`fleet.contract.inspect` shows each work item. When the job is finished,
`review.after.tasks` lists `{requirementId, bundleId, item, status,
verification}` per task. When you answer an Ask or amend with `resolves` naming
a task's requirement id (or an open point on that task), the event counts
against that task's snippet in `review.after.cost.byBundle` and in
`fleet.contract.library`, so the snippet that cost asks is the one to rewrite.

## Worked example

The job: add CSV export to an invoice CLI and document it. Two tasks, each with
its completion contract, plus two built-in check snippets for the whole job.

```json
{
  "objective": "The accounting team needs CSV export from the invoice CLI, documented in the README.",
  "scope": "The invoice-cli repository: src/, test/ and README.md.",
  "catalog": [
    { "id": "add-csv-export", "version": "1", "kind": "atom", "role": "task",
      "text": "Add a --csv flag to {{cli}} that prints the invoices as CSV with the header id,customer,amount,due. Quote every field that contains a comma. Put the CSV encoder in its own module or inside the CLI file.",
      "parameterSchema": { "cli": { "type": "string", "required": true } },
      "semantics": { "kind": "task",
        "completion": { "done": "node {{cli}} --csv prints the header and one line per invoice, and the export tests pass.",
          "checks": [
            { "id": "tests", "description": "The CSV export tests pass", "command": "node --test test/export.test.js" },
            { "id": "header", "description": "The CSV output starts with the header line", "command": "node {{cli}} --csv --input test/fixtures/invoices.json | head -n 1 | grep -qx 'id,customer,amount,due'" }],
          "fieldPatterns": { "cli": "^[A-Za-z0-9._/-]+$" } },
        "intention": [
          { "about": "encoder in its own module or inside the CLI file", "intent": "Either is fine. A separate module is better if it stays under 80 lines with no dependencies; the next change adds TSV export." }] } },
    { "id": "document-csv-export", "version": "1", "kind": "atom", "role": "task",
      "text": "Document the --csv flag in {{readme}} under a heading CSV export, with one example command and its output. Show the output as a code block or a table.",
      "parameterSchema": { "readme": { "type": "string", "required": true } },
      "semantics": { "kind": "task",
        "completion": { "done": "{{readme}} has a CSV export section with an example command and its output.",
          "checks": [
            { "id": "section", "description": "The readme has a CSV export section", "command": "grep -q '^## CSV export' {{readme}}" },
            { "id": "example", "description": "The readme shows the example command", "command": "grep -q -- '--csv' {{readme}}" }],
          "fieldPatterns": { "readme": "^[A-Za-z0-9._/-]+$" } },
        "intention": [
          { "about": "code block or table", "intent": "Use whichever reads better on GitHub for three invoices; readers copy the command, so keep it in a code block." }] } }
  ],
  "compose": [
    { "use": "add-csv-export", "params": { "cli": "src/cli.js" } },
    { "use": "document-csv-export", "params": { "readme": "README.md" } },
    { "use": "no-dependencies" },
    { "use": "committed" }
  ]
}
```

What review shows for it:

- `tasks`: `root/part-1#add-csv-export` with 2 completion checks, 1 intention,
  `open: 0`; `root/part-2#document-csv-export` with 2 completion checks,
  1 intention, `open: 0`.
- The two built-in snippets are check snippets, covered by their own commands.
- No open point at all: the objective states the purpose (context), and the
  tasks and check snippets are the requirements. `structure` notes that the two lead
  snippets have no review record yet (`snippet-unreviewed`); add `reviews`
  records bound to their digests once someone has read them.

What submit sends: two work items. Item 1 starts with the objective and the list
of both tasks, then "Task 1 of 2: Add a --csv flag to src/cli.js ...",
"Done when: ..." and the intention about the encoder, with the checks
`add-csv-export-tests` and `add-csv-export-header`. Item 2 is task 2 with
`document-csv-export-section` and `document-csv-export-example`, plus the
whole-job checks `no-dependencies` and `committed` and their text under "Also
part of this job".

## Checklist

1. One task snippet per piece of work, in the order it is done.
2. Each task: a `done` sentence and at least one completion check that shows it.
3. Each choice in a task's text: an intention whose `about` names it, saying
   what you want and why.
4. Every parameter used in a command: a `fieldPatterns` entry.
5. Whole-job requirements: built-in check snippets or the contract's `checks`.
   The objective states the purpose.
6. Run `fleet.contract.review` and make every task `open: 0` before submitting.
