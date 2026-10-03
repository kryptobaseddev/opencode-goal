# Context — dogfood-buildout (facts only, no decisions)

Recon 2026-10-03. Owner words: "you need to dogfood yourself by building your goal system out and testing it fully in opencode 2 for our project".

## Repo state
- `main` at `8abf95f`, in sync with `origin/main`. Tag `v0.1.0-alpha.1` = `bb40a36` (installed globally in the owner's OpenCode 2.0.22). Tree is 2 docs-only commits ahead of the tag → the `src/` driving this session's plugin is behaviour-identical to the installed tag.
- `package.json` version `0.1.0-alpha.1`.
- Baseline checks (captured 2026-10-03): `bun run typecheck` clean; `bun test` 40 pass / 1 skip / 0 fail in ~25 s.

## Open CLEO tasks (under epic T002)
- **T012** (priority): first real-model dogfood run. AC1 "A real-model goal reaches complete or a correct stop state with ledger and evidence on disk"; AC2 "Findings and defects are recorded in docs/dogfood-1.md and as CLEO tasks".
- **T010**: write-goal skill pass. AC1 "Skill passes awesome-skills validate.py, audit_body.py and check_depth.py"; AC2 "Plugin registers the write-goal skill in an isolated host (skill list shows it)".
- **T009**: TUI. AC1 "Sidebar component snapshot test renders criteria board, step and budgets"; AC2 "Real OpenCode TUI run shows the sidebar card for a running goal". HANDOFF §9.4: remaining work is the `session.panel` "goal" dashboard (contract, per-criterion evidence, ledger timeline, verdicts) + keybindings; the card/pill/banner ACs are already met.

## Artifact shapes the criteria can cite
- Ledger: `.opencode/goals/<slug>/ledger.jsonl` — one JSON per line, `type` field. Observed types: `start` (with runId, lock, commit), `admit`, `admit-failed`, `recovered`, `compacted`, `paused`, `steer`, `resumed`, `aborted`, `verdict` (with passed + lines) — written at `src/server/app.ts:567` **after** the verifier child returns.
- Evidence: `evidence/<runId>/contract.yaml` (locked copy) + `verify-turn-<n>-<ts>.json` (claim + check results).
- Verifier child session is a real model; it must call `goal_verdict` with per-criterion verdicts and file quotes (app.ts:601-626).

## Skill-forge validators (T010 AC1)
- Located at `~/projects/awesome-skills/skills/skill-validator/scripts/{validate,audit_body,check_depth}.py`.
- Baseline on `skills/write-goal`: `audit_body.py` → **PASS** (0 errors, 0 warnings, 110 lines). `validate.py` and `check_depth.py` → fail to start: `ModuleNotFoundError: No module named 'yaml'` (PyYAML missing for python3 — environment fix needed, e.g. `python3 -m pip install pyyaml`).
- Skill currently has SKILL.md + references/{goal-schema,interview}.md + assets/goal.template.yaml + evals/trigger_queries.json. HANDOFF asks for: sharpened interview, `references/examples.md` with four complete goals, trigger evals run.

## TUI capture mechanism (for T009 proof)
- `bun scripts/tui-smoke.ts &` starts an isolated host with a paused demo goal and writes `.tmp/spikes/tui-host.json`; `python3 spikes/tui-capture.py <seconds>` runs the real TUI in a pty and writes `.tmp/spikes/tui-raw.txt` (ANSI stripped copy printed to stdout). No key injection — only the default screen is captured.

## Release loop (AGENTS.md §8 / HANDOFF §8)
bump version + CHANGELOG → commit → `git tag -a vX.Y.Z` → `git push origin main --follow-tags` → `OCGOAL_GIT_INSTALL=1 OCGOAL_GIT_SPEC="github:kryptobaseddev/opencode-goal#<tag>" bun test test/host/git-install.test.ts` → (owner reinstalls) `opencode plugin remove/add` + `opencode reload`. A plugin reload pauses any running goal (by design). Known: pushing the tag is required for the git-install test against a GitHub spec.

## Misc
- `.gitignore` currently lacks the goal runtime artifacts (HANDOFF §8.4 recommends `.opencode/goals/*/run.json`, `ledger.jsonl`, `evidence/`).
- No budget is active anywhere; budgets are opt-in.
- Verification default per owner decision 2026-10-02: host checks + read-only verifier (`verification.mode: host+verifier`).
