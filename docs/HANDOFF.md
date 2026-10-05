# Handoff — opencode-goal

Written 2026-10-02, refreshed through **2026-10-05 (v0.3.0)** across four dogfood runs (`0ffe5ac6e001`, `10388d06d001`, `ship-v03-feedback-loop`, plus the T059–T061 triage). Read this first, then `AGENTS.md` (project guide below the CLEO block), then [design.md](design.md) (as-built v0.1 + v0.2 with both council decision records).

## 1. Where things stand

| | |
|---|---|
| Repo | https://github.com/kryptobaseddev/opencode-goal (public, MIT), local `~/projects/opencode-goal` |
| Released | **v0.3.0** (`604b756`, tagged, pushed, git-install-proven, **installed by the owner 2026-10-05T01:13:31Z**). The feedback-loop release: verifier child explicit model + empty/timeout rounds recorded (T044), post-goal summary with provenance caveats (T045), flagged scope audit (T046), owner-final vs host re-checks (T057), goals from any session + attach (T049), decision dialogs at 7 points (T050), actionable notices (T054), persistent transcript rows + action-required state (T052), live activity tracer with per-check progress (T053+T063), dashboard rework (T056), refresh fix (T058), version-prefix authoring rules (T055), direct-call tool hints (T062). Full entry in [CHANGELOG.md](CHANGELOG.md). |
| Installed | The owner's OpenCode pins `#v0.3.0` (verified via the npm install cache — see §6 detection trick). Post-tag fixes (T062/T063, d6380c1) are on `main` but NOT in a release yet — they ship in v0.3.1. |
| Dogfood run `ship-v03-feedback-loop` | **21/22 host-proven** (lock `2bff41e4a945`). C19 alone hit its rejection limit: one substantive verifier judgment (turn 4, quoted in dogfood-3 §6 — its two findings were fixed), then two provider-hang timeouts (`done: timeout, messages: 0` — recorded, never silent). Closed at `needs_review` with the owner holding the final decision (`/goal approve C19` is owner-final by T051/T057). Findings: [dogfood-3.md](dogfood-3.md). |
| Tests | **138 pass / 0 fail / 1 skip** (`bun test`, ~100 s) on `main` (592bf4c+). All twelve contract red-stubs became real suites. |
| CLEO | T044–T058 + T062/T063 completed with evidence. **T024** (v0.3 epic) has all 10 children done but needs evidence bindings for its own 18 v0.2-era ACs before `cleo complete` — next-session housekeeping. **T059/T060/T061/T064** filed under T002 as the v0.3.1 board. |
| Docs | [design.md](design.md) · [dogfood-1.md](dogfood-1.md) · [dogfood-2.md](dogfood-2.md) · **[dogfood-3.md](dogfood-3.md)** · [spikes.md](spikes.md) · [opencode-store-probe.md](opencode-store-probe.md) · [cleo-evidence-repro.md](cleo-evidence-repro.md) |

## 2. Owner intent (unchanged + the 2026-10-05 addition)

Goal mode + write-goal skill for OpenCode 2, host-verified completion, installed from git tags and iterated like a real user; CLEO as the decomposition source of truth; council reviews for design decisions. **New:** the next stage is a **production/launch-ready v0.3.1** — the owner wants everything 100% ready to push to a launch release, with this session fully wrapped and documented first.

## 3. The v0.3.1 board (launch experience — filed, none started)

| # | Task | What |
|---|---|---|
| 1 | T064 | **Palette shows no Goal commands on the owner's live TUI** (toasts/dialogs fire, so the plugin loads) — keymap layer from the app slot isn't surfacing; reproduce with `spikes/tui-capture.py` + `palette-probe.py` first |
| 2 | T059 | Clean start: launch ask offers "start clean — opens a new session owned by the goal" via `session.create` (mechanism proven by the verifier child + T049 attach); no clear-in-place API exists |
| 3 | T060 | `/goal start` with no argument becomes a startable-goal picker (reuse T050 dialog machinery); composer-completions spike; empty state offers `/goal new` |
| 4 | T061 | Optional `priority` in goal/v1 → registry → `/goal list` → palette → picker; interview asks only when a live goal exists |
| 5 | T065 | **Summary/decision dialogs overflow off-screen** (live find at needs_review): dialogs get a screen-fit digest; full text lives in the panel/evidence — digest helper landed post-v0.3.0 (see git log), needs a live pty check in v0.3.1 |
| 6 | housekeeping | T024's 18 AC evidence bindings; consider `verifierTimeoutMs` default (120 s/round hung twice at the provider on the main host — config override or a bump to the default) |

Backlog beyond v0.3.1: relay mode, goal queues, home-screen board, Claude Code / Codex adapters, headless runner, npm publishing.

## 4. Next-session checklist (everything prepped)

1. `cleo briefing`; `cleo session start --scope epic:T002 --name "v0.3.1 launch experience"`.
2. If `ship-v03-feedback-loop` is still `needs_review`: the owner decides C19 (`/goal approve C19` — owner-final — or reject with why), then `/goal verify` to complete and archive. Do not re-litigate; the evidence chain is in dogfood-3 §6.
3. Write the v0.3.1 contract via `/goal new` over T064+T059+T060+T061 (+ T024 housekeeping). Apply the T055 rule: the release criterion pins `startsWith('0.3.1.')`, never an exact needle. Keep the engine-version rule (single end release + owner reinstall gate) and the single-line command rule.
4. `bun test` before and after changes; ship through §8. The post-tag commits (d6380c1, 592bf4c, docs) are already on `main` — v0.3.1 includes them by construction.

## 5. Lessons from this run (all in dogfood-3)

- The engine-version gate worked exactly as designed: three blocker reports with independent work between them; reinstall detected via the npm cache without asking twice.
- The feedback loop closed itself: the verifier child caught its own evidence gap mid-flight (turn 4), the HOST VERDICT rows landed as persistent transcript notices (T052 live), and needs_review surfaced the decision dialog + summary (T045/T050 live).
- Provider hangs are real: both C19 timeouts were `messages: 0` at 120 s/round. Recorded, diagnosable, never silent — but consider a bigger verifier budget for slow providers.

## 6. Releasing (the owner's iteration loop — unchanged)

Bump `package.json` + `CHANGELOG.md` → commit `type(T###)` → `git tag -a vX.Y.Z` → `git push origin main --follow-tags` → git-install test against the tag → owner reinstalls (`plugin remove` old, `plugin add` new, `reload`) → verify with `opencode plugin list` or the npm cache (`~/.cache/opencode/npm/git-opencode-goal-<hash>/<epoch>/package.json` pins the spec; newest epoch wins). The owner's OpenCode runs the **installed tag**, not this working tree.
