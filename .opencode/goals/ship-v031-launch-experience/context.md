# Recon — ship-v031-launch-experience

Facts only, captured 2026-10-05 (~02:05Z). No decisions here — those live in decisions.jsonl and the contract.

## Baseline

- `bun test`: **138 pass / 1 skip / 0 fail** (~100 s) on `main` @ d012047. Matches HANDOFF §1.
- `bun run typecheck`: not yet re-run this session; green at last release.
- `package.json` version: `0.3.0`. `node -e "...startsWith('0.3.1')..."` → exit 1 (red baseline).
- Installed engine (owner's OpenCode): npm cache `git-opencode-goal-fed718a4335e/1791162811567` pins `github:kryptobaseddev/opencode-goal#v0.3.0`, package version 0.3.0. The engine-version gate applies to v0.3.1.
- Post-tag commits on `main` (d6380c1 tool hints + live check progress, 592bf4c + docs): ship in v0.3.1 by construction.

## Board (CLEO, children of T002)

Pending: **T064** (palette dead on live TUI, medium), **T066** (decision dialogs unusable live, medium), **T067** (complete decision shows only Archive, medium), **T059** (clean start, low), **T060** (start picker, low), **T061** (priority, low). Done since filing: **T065** (screen-fit digest landed in 8f541af with unit tests — its *live pty check* is still outstanding and folds into this run's pty gate). **T024** (v0.3 epic): pending — 18 v0.2-era ACs need evidence bindings before `cleo complete`.

## Code surfaces (as observed)

- `src/server/app.ts:1241` — `/goal start` with no arg returns the usage warning (`Usage: /goal start <slug>. Goals here: …`) — T060's target.
- `session.create` is engine-proven for children (verifier child, app.ts:884) — the mechanism for T059's fresh start; no clear-in-place API exists (spikes S1–S24).
- `priority`: zero occurrences in `src/contract/` and `src/engine/` — T061 is greenfield.
- `scripts/tui-smoke.ts` exists: boots an isolated host into `paused`, writes `.tmp/spikes/tui-host.json`, holds for `spikes/tui-capture.py`. No assert mode — the deterministic gate is this run's scaffolding.
- `spikes/palette-probe.py` and `spikes/tui-capture.py` exist; neither has ever gated a criterion.
- Registry entry today: `{title, status, runId?, lock?, archived?, updatedAt}` — no ordering field.

## Needle rehearsals (red baselines, checked verbatim)

- `cleo show T024 --field /data/task/status` → `pending` (raw scalar; `done` absent → red).
- `grep -c "Start clean" skills/write-goal/SKILL.md` → 0.
- `grep -ci "priority" skills/write-goal/references/interview.md` → 0 (needle `Priority` red).
- `grep -c "composer-completions" docs/spikes.md` → 0.
- `grep -c "## 0.3.1" CHANGELOG.md` → 0. **Trap:** bare `0.3.1` already appears once (inside a council-run path string on line 32) — the needle must be the heading `## 0.3.1`, not `0.3.1`.
- `.opencode/goals-archive/dogfood-buildout/` → does not exist. `dogfood-buildout` run.json status = `complete` (run 10388d06d001) — archivable.
- `docs/dogfood-4.md` → does not exist.

## Uncommitted work-tree state

- `.opencode/goals/ship-v03-feedback-loop/*` deleted (moved) + untracked `.opencode/goals-archive/ship-v03-feedback-loop/` — the archive already happened on disk (2026-10-04 18:49), not yet committed. Folded into this run's housekeeping step.

## Carried precedent (not re-asked; logged as assumptions)

- Single end release + owner-reinstall-before-claim gate (owner decisions 2026-10-03, 2026-10-04).
- T055 version-prefix rule (handoff §4.3 directs it for this release).
- Autonomy defer/steer/pause; verification host+verifier, max_rejections 3 (both prior contracts).
- CLEO as decomposition source of truth (owner directive 2026-10-03).
- dogfood-N doc + verifier-grounding criterion pattern (dogfood-2 C18, dogfood-3 C19).
- Red-stub convention: new command-check targets exist as committed failing stubs before `/goal start`, so rehearsal records honest reds (vacuous-green lesson, v0.3.0 A1).

## Correlation: plan step → CLEO task

| Step | Task(s) |
|---|---|
| S1 palette + pty gate | T064 (+T065 live check) |
| S2 clean start | T059 |
| S3 start picker | T060 |
| S4 priority | T061 |
| S5 decision ledger + sequencing | T066 |
| S6 complete-decision choices | T067 |
| S7 verifier timeout | housekeeping row 8 |
| S8 T024 bindings + archives | T024 (+ archive housekeeping) |
| S9 release | T024 release ACs |
| S10 dogfood-4 + closes | T059–T067 completes |
