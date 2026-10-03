# goal/v1 field reference

The plugin's parser (`src/contract/parse.ts` in opencode-goal) is the source of truth; this mirrors it.

## Top level

| Field | Required | Notes |
|---|---|---|
| `schema` | yes | exactly `goal/v1` |
| `id` | yes | kebab-case slug, ≤64 chars, equals the directory name |
| `title` | yes | ≤80 chars recommended (sidebar) |
| `intent.verbatim` | yes | the owner's words, never rewritten |
| `outcome` | yes | one end state; warned if it reads as an activity or uses vague words without a number |
| `why` | no | |
| `scope.in` / `scope.out` | no | globs or plain descriptions |
| `non_goals` | yes (≥1) | |
| `constraints` | no | |
| `criteria` | yes (≥1 essential) | ids `C1…` |
| `invariants` | no | ids `I1…`, host-checkable kinds only, always essential |
| `protect` | no | globs the worker may not edit; enforced before edits and re-checked at verification |
| `assumptions` | no | ids `A1…`; `status` assumed (default) / confirmed / vetoed |
| `plan` | no | ids `S1…`; `proves` must reference criteria; `depends_on` must reference steps; no cycles |
| `budget` | no | `turns` (int), `wall` ("90m", "3h", "1h30m"), `tokens` (400k, "3M"; spend across the run), `cost_usd` |
| `stop.when`, `stop.escalate_when` | no | shown to the worker; escalation means `goal_block` |
| `autonomy` | no | `questions` defer (default) / allow · `on_user_message` steer (default) / pause · `on_interrupt` pause (default) / resume-on-message |
| `verification` | no | `mode` host / host+verifier (default) / strict · `max_rejections` 1-10 (default 3) |
| `execution.agent` | no | informational in v0.1 |
| `meta` | no | free-form |

## Criterion

```yaml
- id: C1
  statement: WHEN … THE … SHALL …        # binary, specific
  essential: true                         # default true; optional criteria never block completion
  check: { kind: …, … }
```

| `check.kind` | Fields | Passes when |
|---|---|---|
| `command` | `run` (required), `expect.exit` (default 0), `expect.stdout_contains`, `expect.stdout_regex`, `timeout` seconds (default 300), `runs` (1-10, all must pass), `live` (re-run by the host after turns that changed files) | every run meets every expectation; runs in the owner's login shell at the project root |
| `file` | `path`, `exists` (default true) | the path exists (or not) |
| `contains` | `path`, `text` or `regex` | the file contains it |
| `absent` | `pattern` (extended regex), `paths` | `git grep` finds no match (goal state excluded) |
| `diff` | `paths` (globs) | none changed since the run started |
| `verifier` | `ask` | the read-only verifier answers proven with quotes the host finds verbatim in the files |
| `human` | `ask` | the owner approves it (`/goal approve C3`) |

## Validator messages

Errors: wrong schema · bad or mismatched id · missing title / intent.verbatim / outcome · no non-goals · no criteria · no essential criterion · criterion id not `C<n>` · missing statement · missing or unknown check kind · missing kind fields (run, path, pattern, paths, ask, text|regex) · invalid regex · non-positive timeout · invariant with a non-host kind · duplicate ids · plan id not `S<n>` · unknown `proves`/`depends_on` · dependency cycle · bad budget values · bad autonomy / verification values · invalid YAML (with a hint for unquoted `: `).

Warnings: title over 80 chars · outcome reads as an activity · vague words without a number (outcome and statements) · no host-checkable essential criterion.
