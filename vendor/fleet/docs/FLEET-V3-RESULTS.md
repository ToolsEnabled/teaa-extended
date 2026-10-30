# Fleet V3 assignments and results

A strong lead supplies the objective, the inputs to use, ownership boundaries,
the desired artifact and checks that would establish success. A worker reports
what it produced and checked. Fleet retains both, with the task revision, and
keeps the lead's assessment separate from the worker's claim.

`requirements` is optional on `agent.spawn` and `fleet.control` task or resume
with a new task text. It is retained before the first provider turn. Existing
plain-text assignments continue to work. For example, a lead can assign an
existing paused worker using:

```json
{
  "action": "task",
  "nodeId": "worker-1",
  "expectedRevision": 12,
  "text": "Implement the CSV reader described in the pinned specification.",
  "requirements": {
    "scope": "Own src/csv.js and tests/csv.test.js; coordinate shared interfaces through the lead.",
    "inputs": [{"id": "spec", "reference": "inputs/csv-spec.md"}],
    "outputs": [{"id": "patch", "description": "Reader and regression tests"}],
    "checks": [{"id": "tests", "description": "Run the CSV regression suite and retain its output."}]
  }
}
```

A fresh worker can receive the same `requirements` alongside its existing
`CONTRACT/1` spawn contract. For a job, choose either `tasks` (text strings) or
`workItems` (objects with `text` and optional `requirements`), never both.
`job-add` accepts either form. Every item retains its own requirements.

Read the actual assignment revision before reporting. In this example, if its
`taskRevision` is 4, the worker could report:

```json
{
  "action": "complete",
  "expectedTaskRevision": 4,
  "text": "Implemented the reader; the regression suite passed.",
  "result": {
    "artifacts": [{"id": "patch", "reference": "commit:example-change-id"}],
    "checks": [{"id": "tests", "status": "passed", "evidence": "logs/csv-tests.txt: 24 passed, 0 failed"}]
  }
}
```

These example references are placeholders, not actual validation evidence.
Check status is `passed`, `failed`, `not_run` or `unknown`. Passed/failed claims
need evidence text or a reference. Optional `remaining` and `blockers` are text.
Use the specified output/check IDs so missing evidence is visible. Unlisted
checks are retained too. Fleet does not read these references or run commands
merely because a report names them.

Completing an item allows its queue to proceed. It leaves the result
`unassessed`. After inspecting the actual artifacts and relevant checks, the
lead may record:

```json
{
  "action": "assess",
  "nodeId": "worker-1",
  "expectedRevision": 18,
  "expectedTaskRevision": 4,
  "assessment": {
    "decision": "accepted",
    "note": "Inspected the patch and independently confirmed the required CSV cases.",
    "evidence": [{"id": "readback", "reference": "lead/csv-validation.txt"}]
  }
}
```

Use live revisions, not the illustrative numbers above. The assessment may
name an earlier retained task after the worker advances. `rework` or `rejected`
records a different judgment; it does not pause or resume anything. An explicit
next assignment carries corrections. Fleet retains earlier assessments when
the judgment changes. Repeating the same assessment or identical terminal
report is idempotent on the current shared revision. A conflicting terminal
report is refused; the first submission is preserved.

Lead compact reads expose outcome counts without evidence bodies. Request
`view: full` on a scoped task read or paged job read to retrieve exact
requirements, submissions and assessments. A check reported as passed is still
a worker claim; `accepted` is a lead judgment, not an independent certification
by Fleet. Missing or unrun checks remain visible even if the lead accepts a
result with an explained exception.
