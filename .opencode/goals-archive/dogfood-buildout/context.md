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

---

# Replan — 2026-10-03 (round 2, full scope)

Owner words: "rework and replan out the full dogfood-buildout goal ... include EVERYTHING we have discussed ... the full scope."

## Inventory of everything discussed (facts)

Done and green (HEAD 2a90353, 46 tests, typecheck clean):
- v0.2-alpha work shipped as v0.1.0-alpha.2 (panel, timeline rpc, skill pass, examples, trigger evals 15/16, dogfood-1.md, defects T013-T016 filed).
- Council run 20261003T145323Z-a46b2ff9 (validated, high confidence): start-time rehearsal + owner-approved amendment; feasibility proven by test/unit/check-signature.test.ts (shell-stderr signature distinguishes unrunnable checks).
- Council run 20261003T162655Z-800c52ca (validated, high confidence): keep descriptive slugs; supersession as append (supersedes pointer, terminal predecessor, mid-flight admission rule); demote-never-delete archive with existence surviving; admission-time existence + fuzzy search; registry justified for list/status (scale-bench: slugs 13.8ms / exists 12.2ms / list 157.6ms @5k, spikes/scale-bench.ts).
- Provenance: docs/opencode-store-probe.md (16 projects, project_directory join). CLEO upstream issues #1804/#1805 filed with docs/cleo-evidence-repro.md.
- CLEO bookkeeping fixed this round: T020 (skill lesson) completed with correct evidence; T021 (parse.ts multi-line warning) REOPENED — never implemented.

Open (the reworked scope):
- T012/T017/T018/T022: the dogfood run itself (old run 0ffe5ac6e001 still needs_review; contract file already carries the fixed C3 one-liner).
- T013 counters stall mid-execution; T014 tui-smoke probes assume sidebar; T015 trigger-eval command route; T016 verifier reliability (owner chose: harden + fenced-JSON fallback + persisted transcripts).
- T021 parse.ts multi-line command warning.
- Council 1 build: start-time rehearsal at /goal start; write-guard across stopped states; goal_amend (owner-approved re-lock, generation-bound records); fix stale "/goal edit" integrity message.
- Council 2 build: registry (T026), archive tier (T032), supersession (T031), admission-time existence+fuzzy search (T033).
- Surfaces: /goal help LLM-forward (T025); CLEO optional CLI-only link (T027); OpenCode DB spike verdict recorded (T028); design fold-in (T029, acceptance extended with both council decisions + naming verdict).
- HANDOFF §9.5 synthetic continuation notices; §9.7 untested paths (budget wrap-up, goal_wait timer, diff/absent e2e, human approval, compaction hook, session.deleted, provider errors).

Owner decisions (this round): single end release v0.2.0 · build all three mechanisms · verifier harden+fallback+transcripts · no budget.

## CLEO ↔ goal-step correlation (single source of truth for decomposition)

| Goal step | CLEO task | Epic |
|---|---|---|
| S1 verifier reliability | T016 | T002 |
| S2 live counters | T013 | T002 |
| S3 parse multi-line warning | T021 | T002 |
| S4 start-time rehearsal | T036 | T035 |
| S5 write-guard + message fix | T037 | T035 |
| S6 goal_amend | T038 | T035 |
| S7 registry | T026 | T024 |
| S8 archive tier | T032 | T024 |
| S9 supersession | T031 | T024 |
| S10 admission search | T033 | T024 |
| S11 /goal help | T025 | T024 |
| S12 CLEO link (+T028 verdict into design) | T027 | T024 |
| S13 untested paths · S13b synthetic notices | T040 · T041 | T039 |
| S14 design fold-in (+T014, T015 closeout) | T029 · T014 · T015 | T024/T002 |
| S15 release v0.2.0 | T043 | T039 |
| S16 dogfood-2 + CLEO closes (T012, T017/T018, T022) | T042 | T039/T002 |

Saga T001 → epics T002 (v0.1 + dogfood defects), T024 (v0.3 identity/surfaces), T035 (integrity model), T039 (hardening/release).
