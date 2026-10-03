# CLEO evidence-atom friction — repro and upstream reports (2026-10-03)

During the `dogfood-buildout` goal we completed CLEO tasks with ADR-051 evidence atoms and hit
three frictions. Two are filed upstream with `cleo issue bug`; the third is an observation we
cannot yet attribute. One further failure was ours, not CLEO's — recorded here so it isn't
repeated. All transcripts are verbatim, captured 2026-10-03, CLEO v2026.10.3.

## Issue 1 (filed) — `test-run:<json>` schema is undocumented and the error doesn't name it

`cleo verify --help` documents the atom as `test-run:<json>` with no schema. Our first attempt
used semantically-correct fields (`total`, `passed`, `failed`, `skipped`):

```json
{"command":"bun test","exit":0,"total":43,"passed":42,"failed":0,"skipped":1}
```

```json
{"success":false,"error":{"code":1,
 "message":"test-run reports zero total tests (no tests were executed)",
 "codeName":"E_EVIDENCE_TESTS_FAILED"}}
```

The error gives no hint about the expected shape. We found the parser in
`@cleocode/core/dist/tasks/evidence.js`: it reads jest-style counters
(`numTotalTests`, `numPassedTests`, `numFailedTests`, `numPendingTests`, `numTodoTests`).
With those fields the same atom verifies. Cost: three attempts plus reading dist source.

**Ask:** document the schema in `cleo verify --help` (a one-line example suffices) and make
`E_EVIDENCE_TESTS_FAILED` for a 0-total report list the expected keys.

## Issue 2 (filed) — files under `.opencode/**` classify a change "workspace-wide", refusing targeted test-run evidence

After fixing the goal contract (`.opencode/goals/dogfood-buildout/goal.yaml`) — runtime state,
not source — a targeted `test-run` atom is refused:

```json
{"success":false,"error":{"code":1,"codeName":"E_EVIDENCE_INSUFFICIENT",
 "message":"The change is workspace-wide (outside every workspace package, so every package
 may be affected: .opencode/goals/dogfood-buildout/goal.yaml,
 .opencode/plugins/cleo-heavy-command.js), so only a full-suite run speaks for it, and a
 test-run report cannot show that it ran the whole suite (test configs exclude tracked test
 files, so file counts prove nothing). Record tool:test, which runs the full suite for a
 workspace-wide change, or ci:<pr> once the PR merges."}}
```

In a repo whose primary artifacts live under `.opencode/` (an OpenCode plugin), every evidence
recording is forced to a full `tool:test`. Two sub-problems: (a) `.opencode/` runtime state is
treated as package source for scoping; (b) the listed set included
`.opencode/plugins/cleo-heavy-command.js`, which this task did not touch — stray untracked
files appear to widen the classification.

**Ask:** let `.cleo/project-context.json` declare workspace roots and/or evidence-scope
excludes (e.g. ignore `.opencode/**` runtime state, or consider only files changed relative to
the task's base commit).

## Observation 3 (not filed) — first `tool:test` exceeded 300 s wall; direct `bun test` takes ~26 s

The first `cleo verify --gate testsPassed --evidence "tool:test"` produced no output for
300 s (our client timeout killed it); a direct `bun test` on the same tree takes ~26 s. A later
`tool:test` succeeded, and a repeat on the unchanged tree returned instantly from the ADR-061
cache — so the happy path works. We cannot distinguish cleo-side contention/coalescing from our
own client timeout, so this is recorded as an observation, not a bug.

## Our own mistake (lesson, not an issue)

We piped `cleo verify … | grep -o …; echo $?` — the `$?` was grep's exit code, masking a
failed verify as success. ADR-086 says never pipe cleo output; the correct pattern is
`--field /success`, which prints `true`/`false` alone. Rehearsed and adopted.
