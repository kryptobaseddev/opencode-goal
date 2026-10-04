# Handoff — opencode-goal

Written 2026-10-02, refreshed through **2026-10-04 (v0.2.2)** across three dogfood runs (`0ffe5ac6e001`, `10388d06d001` + the v0.2.1/v0.2.2 patch cycle). Read this first, then `AGENTS.md` (project guide below the CLEO block), then [design.md](design.md) (as-built v0.1 + v0.2 with both council decision records).

## 1. Where things stand

| | |
|---|---|
| Repo | https://github.com/kryptobaseddev/opencode-goal (public, MIT), local `~/projects/opencode-goal` |
| Released | **v0.2.2** (`d0bcbe3`, tagged, git-install-proven). v0.2.0 = the big build (verifier fallback, rehearsal, amendment, supersession, archive, registry, help, CLEO link); **v0.2.1** = the installed TUI entry had *never* loaded — `@opentui/solid` was a devDependency and git installs ship production deps only (T048); **v0.2.2** = an owner-approved criterion is final — re-verification can no longer stomp `pass · by: human` (T051). |
| Installed | The owner's OpenCode pins `#v0.2.2` (verified live: the "(final)" wording ran in this session's engine). Two binaries exist — `~/.opencode/bin/opencode` and `opencode2`; plugin commands target whichever runs them. |
| Dogfood run `10388d06d001` | **20/21 green**: C1–C17 + I1–I3 host-proven this run; C18 owner-approved (final) after the verifier child produced four empty exchanges (T044); **C15 fails only on a stale needle** — the locked check pins `"version": "0.2.0"` while package.json correctly reads `0.2.2` after the patch releases (T055, contract-drift class). Clean close: `/goal approve C15` → `/goal verify` → complete. Findings: [dogfood-1.md](dogfood-1.md), [dogfood-2.md](dogfood-2.md) §1–8b. |
| Tests | 83 pass (`bun test`, ~73 s): unit + host scenarios on a real `opencode serve` 2.0.22; the git-install test now asserts the TUI runtime resolves in the installed cache (the T048 regression guard). |
| CLEO | Saga T001 › epics T002 / T024 / T035 / T039 — every task closed with evidence **except the v0.3 board (§9) and the four run-closure tasks** (T012, T017/T018, T022) that complete with the goal. Upstream CLEO reports: #1804, #1805, #1833 (a retraction). Council transcripts under `.cleo/council-runs/`. |
| Docs | [design.md](design.md) · [dogfood-1.md](dogfood-1.md) · [dogfood-2.md](dogfood-2.md) · [spikes.md](spikes.md) · [opencode-store-probe.md](opencode-store-probe.md) · [cleo-evidence-repro.md](cleo-evidence-repro.md) |

Important: the installed copy is the **pinned tag**, not this working tree. Editing the repo changes nothing in the owner's OpenCode until a new tag ships and the owner reinstalls it (§8) — deliberate, per the owner's iterate-like-a-real-user decision.

## 2. Owner intent (unchanged)

Goal mode + write-goal skill for OpenCode 2, host-verified completion, installed from git tags and iterated like a real user. The 2026-10-03/04 sessions added: run goals under the loop itself (dogfood), CLEO as the decomposition source of truth, council reviews for design decisions, and the **v0.3 feedback-loop directive** — every decision point, verdict, block, amendment and completion must render a persistent, actionable, option-based surface in the terminal; never a toast alone; the agent must see owner actions; an activity tracer must show work in flight; the dashboard must be human-designed (tabs/cards, not a raw stream).

## 9. What is left — the v0.3 board (all filed, none started)

| # | Task | What |
|---|---|---|
| 1 | T044 | Verifier child's empty exchange on the real host (agent model resolution vs GLM/zai) — root-causes all four silent rounds; fix + v0.3 tag |
| 2 | T045 | Post-goal summary: provenance-labeled outcomes (host/verifier/fallback/human as caveats), scope audit, non-goals, follow-up prompts incl. the CLEO-install suggestion |
| 3 | T046 | Completion scope audit: plan steps / scope.in items with no criterion outcome get flagged |
| 4 | T049 | Goals are session-pinned — owner actions + palette dead outside the goal's session; fallback + palette lists goals |
| 5 | T050 | Human-in-the-loop dialogs at every decision point (needs_review, paused, blocked, budget_limited, amend-proposed, supersede-ack, complete) |
| 6 | T052 | Persistent terminal feedback: transcript notice rows, action-required sidebar state, agent visibility of owner actions |
| 7 | T053 | Live activity tracer (above composer / panel): "verifying (23s)…", cooldowns, goal_wait countdowns — zero model cost |
| 8 | T054 | Actionable message content: every notice carries why + choices |
| 9 | T055 | Contract drift: exact-string version checks go stale — authoring rules for prefix/semantic version checks (skill + examples) |
| 10 | T056 | Dashboard rework: TabSelect tabs (Now/Progress/Decisions/Goals), compact ≤12-line sidebar card, on-demand panel, Select-row actions, legend for C/I/S, native Box borders |

Backlog beyond v0.3 (deliberate non-goals unless the owner revives them): relay mode, goal queues, home-screen board, Claude Code / Codex adapters, headless runner, npm publishing. Known limitations: provider-error injection needs an owner-approved harness change (protected file); web/desktop surfaces untested beyond the RPC contract.

## 10. Picking up (next session)

```bash
cd ~/projects/opencode-goal && opencode
```

1. `cleo briefing`; `cleo session start --scope epic:T024 --name "v0.3 feedback loop"`.
2. If the dogfood run `10388d06d001` is still paused: the close is `/goal approve C15` → `/goal verify` (then complete T012/T017/T018/T022 with the final verdict as evidence). If it already completed, the ledger has the verdict.
3. The next goal is the v0.3 feedback-loop contract over T044–T056: run `/goal new ship the v0.3 feedback loop…` — the interview now knows the engine-version rule (reinstall before the completing claim), the single-line command rule, and the version-prefix rule.
4. `bun test` before and after changes; ship through §8 (bump → CHANGELOG → commit `type(T###)` → tag → push --follow-tags → git-install test → owner reinstalls).
