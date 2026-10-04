# Dogfood 2 — the reworked run (v0.2.0)

Run: `dogfood-buildout` (reworked contract, lock `b6e230508cb9`), run id `10388d06d001`, started 2026-10-03 by `goal_start` after the owner picked "Start goal now" (the old flagged run `0ffe5ac6e001` was aborted first — its ledger remains on disk as history). Provider: GLM via zai-coding-plan, real model throughout. 18 criteria, 3 invariants, every one proven by host-run checks in the owner's login shell.

This document grounds every claim in the run's own artifacts: `.opencode/goals/dogfood-buildout/ledger.jsonl`, `evidence/`, the git history, and the two council transcripts.

## 1 · Continuation behaviour

The run executed 16 plan steps across multiple executions; every continuation landed as a **single synthetic notice row** (`session.synthetic({id, description, resume:true})`, T041) — the transcript shows `↻ goal turn N` notices instead of user messages, with the deterministic-id idempotency retained. The ledger's `admit` events (kickoff → continue → verdict-feedback kinds) tick per execution exactly as in run 1; the TUI dashboard's Timeline section renders them live.

The round-1 finding "one execution = one turn" held: within a single execution the worker chained dozens of tool batches across multiple plan steps (S5+S6 were built inside one execution), and the goal's `turn` counter correctly counts executions, not tool calls. What changed for the better: `usage` counters now update **between usage events** (T013) — the exact defect that froze round 1 at `tokens: 1`.

## 2 · The verifier, made reliable

Round 1's verifier child died without calling `goal_verdict` (dogfood-1 §1). v0.2.0 hardens the round (T016):

- the prompt demands **exactly one** `goal_verdict` call and sanctions a fenced-json reply as the escape hatch;
- a prose child's final fenced verdict is parsed, normalized identically to the tool payload, and recorded as `by:"verifier-fallback"` — the host re-reads its quotes the same way, so a fallback cannot lower the bar;
- the **child transcript is persisted** under `evidence/<runId>/verifier-transcript-turn-*.json` (ledger event `verifier-transcript`), so a silent verifier is diagnosable, never a mystery.

Proven on a real host in `test/host/verifier-reliability.test.ts` (two scenarios): the prose child yields `C3 pass by:"verifier-fallback"` with the quote re-read from `done.txt`, the transcript lands on disk with the child's assistant prose, and the tool path remains primary (`by:"verifier"`, no fallback event). The goal_verdict payload shape both paths share: `{"verdicts":[{"id":"C3","verdict":"proven","reason":"…","evidence":[{"path":"done.txt","quote":"status: ok - proven via fallback"}]}]}`.

**This run's own verification round(s):** the turn-0 claim (2026-10-03) returned a HOST VERDICT with two failures — verbatim from `ledger.jsonl`:

```json
{"type":"verdict","passed":false,"lines":["C13 FAILED [host] design.md … lacks /(?=.*start-time rehearsal)(?=.*supersedes)(?=.*descriptive slug)/","C18 FAILED [verifier] … verifier failed: verifier did not call goal_verdict"]}
```

Two findings in that round, both instructive. **C13**: the contract's three-lookahead regex runs without dot-all, so all three phrases must appear on ONE line — an authoring lesson now folded into the same colon/class family (fixed with a one-line council decision record in `design.md`). **C18**: the live verifier child was silent again — and the diagnosis proves **it was running the v0.1.0-alpha.1 engine**: no `verifier-transcript` file exists under `evidence/10388d06d001/` (the transcript persistence is v0.2.0 code), and the error string is alpha.1's exact wording. The owner's OpenCode runs the *installed tag* (HANDOFF §1); v0.2.0's hardened prompt, fenced-json fallback and transcripts were never in this session's verification path because reinstalling the plugin is owner-only (a contract non-goal). The fix is the documented iteration loop itself: `opencode plugin remove …#v0.1.0-alpha.1` → `opencode plugin add …#v0.2.0` → `opencode reload` (the goal pauses by design) → `/goal resume` → re-claim, and the v0.2.0 verifier judges C18 with the fallback armed. **The owner executed exactly that** (installed `06d9bfc` = v0.2.0, confirmed via `opencode plugin list`; the goal resumed at turn 4 after three block reports) — the completing verification round below is the first this session has ever run under the engine it shipped. This is the sharpest dogfood observation of the run: **the tool that verifies goals must itself be versioned into the host that runs it — an engine fix cannot verify the goal that shipped it.**

**Update (turn 4, under v0.2.0):** the engine swap worked — the round ran with transcript persistence, and the captured transcript (`evidence/10388d06d001/verifier-transcript-turn-4-1791079844468.json`) redirects the root cause: the child's exchange is **entirely empty** (user, assistant, idle — no parts, no tools, no text) on the main host with GLM via zai. The fallback correctly refuses to invent a verdict from nothing. All four silent rounds share this one cause — the child's model request never produces output on the main host (the fixture host never reproduces it). Filed as **T044**; the owner approved C18 on review (the designed escape for a criterion the host cannot verify), and the fix ships in v0.2.1.

## 3 · Cost and prompt-cache observations

Round 1's numbers stand (97.4% cache share; one ~89k rebuild at goal start; median fresh input ≈600 tokens; `cacheWrite` unreported by the plan). This run added the rehearsal pass (each command check executes once at `/goal start` — a handful of shell commands, no model cost) and the registry write per persist (throttled to at most one JSON rewrite per second during usage bursts; no-op writes skipped). The plugin's per-request overhead is unchanged in kind: the contract system block (~9 KB for this contract) plus the nine `goal_*` tool schemas.

## 4 · Amendment and supersession — exercised live where applicable

The mechanics are host-proven end to end (`test/host/amend.test.ts`, `test/host/supersede.test.ts`): a stopped-state tamper attempt is blocked by the write guard; `/goal amend` + `confirm` re-locks a contract whose C4 was added out of band (generation 1, both locks ledgered, `amendment-1-*.json` under evidence, prior C1/C2 evidence retained, C4 proven at the next claim); supersession refuses a live predecessor without `acknowledge-supersede` and flips it terminal `superseded` + archived with both ledgers recording the handoff. On this run itself neither was needed — the contract held — which is the correct outcome for a contract that was rewritten *between* runs rather than during one.

## 5 · Defects found during this run, filed as CLEO tasks

- **T013/T014/T015/T016** (round-1 backlog) — all closed by this run's S1–S3, S13/S14.
- **The colon class struck three times.** (a) Round 1's C3 folded-scalar newline; (b) the rehearsal test's unquoted statement (`done2.txt SHALL contain the line "status: ok"` — `": "` again); (c) a `": "` inside the *skill frontmatter description* that broke plugin loading in every spawned host and mimicked a cleo-environment bug for an hour. The class now has three defenses: the parse warning (T021), start-time rehearsal (T036), and the skill's own one-line-command rule. The misdiagnosis it caused was retracted upstream in kryptobaseddev/cleo#1833 — the file's frontmatter, not the tool runner, was at fault.
- **Host-harness gap (upstream, owner-acknowledged):** provider-error *injection* is impossible through the protected harness (no failure capability; a throwing script escapes as an unhandled rejection). `paths.test.ts` pins the observable contract (the run degrades to a clean stop, never a zombie); a fixture failure-injection capability needs an owner-approved harness change (I3-protected file).
- **Upstream CLEO reports from this run:** #1804 (`test-run` schema undocumented; the error does not name the expected jest-style counters), #1805 (`.opencode/**` runtime state classifies changes workspace-wide, forcing full-suite evidence), #1833 (retraction + thanks — critical gates resisting owner-override notes is correct design and caught my misdiagnosis).

## 6 · Live recovery (unrehearsed)

Mid-run (turn 2), the server restarted under the goal. The ledger records `{"type":"admit","kind":"continue","turn":2}` then `{"type":"recovered","status":"paused"}` with reason "host restarted; resume when ready" — the run came back **paused, never blindly resumed**, with `run.json`, ledger and evidence intact, and the continuation resumed cleanly afterward. The v0.1 recovery contract firing in production, not in a scenario. Also: the verdict-feedback turn (turn 1) executed **381 tool calls** in a single execution — the largest turn of the run, a concrete measure of how much work one "fix the findings" turn absorbs under the loop.

## 7 · The engine-version lesson (for every future goal that ships its own verifier)

The sharpest structural finding of the run: **the verifier that judges a goal is the engine installed in the host, not the engine the goal just built.** A goal that ships a new version of its own tooling must plan the reinstall into its release step — otherwise the final verifier round runs the old engine and inherits exactly the defects the goal fixed. v0.2.0 shipped the verifier fallback on 2026-10-03, but this run's C18 round was still judged by v0.1.0-alpha.1 (installed tag `bb40a36`) — silent child, no transcript, by construction. Folded into the write-goal skill's recon checklist and this project's release loop: the release sequence now ends with the reinstall *before* the completing claim, not after the goal.

## 8 · The completion gap the owner caught (2026-10-04)

Post-run review surfaced two system-level design gaps, now tracked as T045/T046: **completion is criteria-scoped, not discussion-scoped** (anything discussed but never captured as a criterion can never block `complete` — the interview is the intended capture, but the engine never audits scope items with no criterion behind them), and **terminal states render no wrap-up** (no summary of proven-vs-deferred-vs-found-but-unfixed, no provenance labels — an owner-approved criterion should never look identical to a host-proven one — and no follow-up prompts for what's next). The fix ships as the post-goal summary: per-criterion outcomes with `by:` provenance as caveats, a scope audit, non-goals restated, mid-run findings from the ledger, and follow-up prompts including the CLEO-install suggestion when `.cleo` is absent (reusing the cleoFacts probe). For the record: the run itself never falsely completed — C18 failed three times and the engine stopped in `needs_review` for the owner's decision; the gaps are about what the system *surfaces* at the end, not what it verifies.

## 8b · The feedback-loop directive (owner, 2026-10-04)

Two more live findings closed the evening: **C15 contract drift** — the locked check pins the exact string `"version": "0.2.0"` and failed after the legitimate v0.2.1/v0.2.2 patch releases (intent satisfied, needle stale; filed T055, closed by a live `/goal amend` — the amendment feature doing exactly what the council designed it for), and **owner approval is final** (T051, shipped v0.2.2): the first approve had been stomped by a re-verification running the broken verifier child over an explicitly owner-approved criterion. The owner's consolidated directive — every decision point, verdict, block, amendment and completion must render a persistent, actionable, option-based surface in the terminal (dialogs, transcript notice rows, an activity tracer while the engine works), never an ephemeral toast alone — is tracked as T050 (decision dialogs), T052 (persistent terminal feedback + agent visibility of owner actions), T053 (live activity indicator), T054 (actionable message content), alongside T045/T046/T049. That set is the v0.3 feedback-loop goal.

## 9 · What shipped

v0.2.0 (commit `06d9bfc`, tag pushed 2026-10-03): verifier reliability, live counters, rehearsal, amendment, supersession, archive, registry, admission probe, `/goal help`, CLEO link, synthetic notices, path coverage — 82 tests green (31 of them host scenarios on a real `opencode serve`), the tag installs from git in an isolated OpenCode (`git-install` test, 1 pass), and the full transcript of this run is `ledger.jsonl`.
