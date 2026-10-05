# Handoff — opencode-goal

Written 2026-10-02, refreshed through **2026-10-06 (v0.3.1 complete)** across five dogfood runs.
Read this first, then `AGENTS.md`, then [design.md](design.md). Observed OpenCode behaviour:
[spikes.md](spikes.md) (trust it over any doc).

## 1. Where things stand

| | |
|---|---|
| Repo | https://github.com/kryptobaseddev/opencode-goal (public, MIT) |
| Released | **v0.3.1** (`496f8b5`, tagged, pushed, git-install-proven, **installed by the owner 2026-10-06**). The launch-experience release — see [CHANGELOG.md](CHANGELOG.md). |
| Run `ship-v031-launch-experience` | **COMPLETE — 22/22 criteria proven** (host + verifier; C18 took three verifier children judging "proven" before one landed a byte-exact citation — the lesson is in dogfood-4 §7). Not yet archived. Findings: [dogfood-4.md](dogfood-4.md). |
| Tests | 150 pass / 0 fail / 1 skip at the release line; the summary scenario's status-vs-summary race is fixed with grace-waits (`2b4be04`). |
| CLEO | T024 (v0.3 epic) done, 18 child-ACs bound; T059–T068 all complete. **v0.3.2 board filed: T069–T075** (§3). |
| Docs | design · dogfood-1..4 · spikes (S25 keymap modes, S26 pty input starvation, S27 composer-completions) · HANDOFF |

## 2. The v0.3.2 board — "trust the card" (owner-reported, live)

| # | Task | What the owner saw |
|---|---|---|
| T072 | Sidebar freezes at a stale snapshot across restarts | Card showed paused/20-of-22/turn-7 after the run completed 22/22 — the stream dropped around the reinstall reloads and never converged to disk truth |
| T073 | Sidebar card UX: truncation, no expand | Rows cut off unreadable; needs show-more / clickable details, width scaling |
| T074 | Validate the T056 dashboard live | The owner has never seen the tabs/panel; needs a live walkthrough + fixes |
| T075 | Decisions should ALSO use OpenCode's native in-composer ask tool | Owner directive: native selectable options, not command-palette/slash guidance |
| T070 | "Decompose with CLEO" is a dead-end guidance row | Picked it at completion; nothing happened but a toast |
| T071 | Completion surfaces must state the loop stopped | Silence after complete read as broken |
| T069 | /goal commands queue silently behind an active turn | "I sent it but nothing happened" |

Backlog beyond: relay mode, goal queues, home-screen board, Claude Code / Codex adapters,
headless runner, npm publishing.

## 3. The roadmap (owner decision 2026-10-06)

**v0.3.2 — trust the card (LIVE, run `10d4b515b001`, lock `13d4fc71`)**: T069–T076 — snapshot
convergence, card readability + expand, dashboard live validation, native in-composer forms at
every decision point, decompose-as-act, end-state copy, deferred-command acks, start-clean
hand-off via tabs.open+focus. The contract is locked with 13 criteria; the run lives in session
`ses_ef2b88fa…` ("goal kickoff · ship-v032-trust-the-card").

**v0.3.3 — the goal manager (next)**: T077+T078+T079 — every active goal across all sessions in
the sidebar, the primary session as mission control (goals × sessions × agents, one surface,
act on any goal from there), click-to-expand + tabs.focus navigation. Builds directly on
v0.3.2's foundations (T073's expand affordance, T074's validated panel, T076's tab hand-off).
The plugin tabs API is confirmed rich (open/focus/list with busy/attention state).

Backlog beyond: relay mode, goal queues, home-screen board, adapters, headless runner, npm.

## 3a. Session hygiene

- The v0.3.1 run is complete — `/goal archive ship-v031-launch-experience` whenever ready.
- The v0.3.2 run is live in its own session; this primary session is the goal manager's future
  home (T078).

## 4. Lessons from the v0.3.1 run (all in dogfood-4)

- The palette defect was keymap-layer mode-scoping (S25); keystroke-driven checks must target
  an idle TUI (S26); pty captures need a real VT screen model, not flat text.
- Launch approvals: prefix labels, disk-durable approvals, diagnosable refusals (T068) — this
  run's own start was the bug report.
- Verifier evidence discipline: three children judged the doc proven; two were voided for
  embedding quotes inside commentary. Byte-exact anchors in the artifact (fenced ledger lines)
  made the third land. Teach this in the skill if it recurs.
- CLEO evidence: workspace-wide change sets demand full-suite `tool:test` — batch task
  completions at suite-green. Never discard typecheck output.

## 5. Releasing (unchanged)

Bump `package.json` + `CHANGELOG.md` → commit `type(T###)` → `git tag -a vX.Y.Z` →
`git push origin main --follow-tags` → git-install test against the tag → owner reinstalls
(`plugin remove` old, `plugin add` new, `reload`) → verify via `opencode plugin list` or the
npm cache (newest epoch wins). The owner's OpenCode runs the **installed tag**, not this tree.
