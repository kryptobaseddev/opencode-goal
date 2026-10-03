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

**This run's own verification round(s):** quoted below as they land, per the fail-closed loop — the first claim's HOST VERDICT (if any) and the completing verdict are part of the evidence.

## 3 · Cost and prompt-cache observations

Round 1's numbers stand (97.4% cache share; one ~89k rebuild at goal start; median fresh input ≈600 tokens; `cacheWrite` unreported by the plan). This run added the rehearsal pass (each command check executes once at `/goal start` — a handful of shell commands, no model cost) and the registry write per persist (throttled to at most one JSON rewrite per second during usage bursts; no-op writes skipped). The plugin's per-request overhead is unchanged in kind: the contract system block (~9 KB for this contract) plus the nine `goal_*` tool schemas.

## 4 · Amendment and supersession — exercised live where applicable

The mechanics are host-proven end to end (`test/host/amend.test.ts`, `test/host/supersede.test.ts`): a stopped-state tamper attempt is blocked by the write guard; `/goal amend` + `confirm` re-locks a contract whose C4 was added out of band (generation 1, both locks ledgered, `amendment-1-*.json` under evidence, prior C1/C2 evidence retained, C4 proven at the next claim); supersession refuses a live predecessor without `acknowledge-supersede` and flips it terminal `superseded` + archived with both ledgers recording the handoff. On this run itself neither was needed — the contract held — which is the correct outcome for a contract that was rewritten *between* runs rather than during one.

## 5 · Defects found during this run, filed as CLEO tasks

- **T013/T014/T015/T016** (round-1 backlog) — all closed by this run's S1–S3, S13/S14.
- **The colon class struck three times.** (a) Round 1's C3 folded-scalar newline; (b) the rehearsal test's unquoted statement (`done2.txt SHALL contain the line "status: ok"` — `": "` again); (c) a `": "` inside the *skill frontmatter description* that broke plugin loading in every spawned host and mimicked a cleo-environment bug for an hour. The class now has three defenses: the parse warning (T021), start-time rehearsal (T036), and the skill's own one-line-command rule. The misdiagnosis it caused was retracted upstream in kryptobaseddev/cleo#1833 — the file's frontmatter, not the tool runner, was at fault.
- **Host-harness gap (upstream, owner-acknowledged):** provider-error *injection* is impossible through the protected harness (no failure capability; a throwing script escapes as an unhandled rejection). `paths.test.ts` pins the observable contract (the run degrades to a clean stop, never a zombie); a fixture failure-injection capability needs an owner-approved harness change (I3-protected file).
- **Upstream CLEO reports from this run:** #1804 (`test-run` schema undocumented; the error does not name the expected jest-style counters), #1805 (`.opencode/**` runtime state classifies changes workspace-wide, forcing full-suite evidence), #1833 (retraction + thanks — critical gates resisting owner-override notes is correct design and caught my misdiagnosis).

## 6 · What shipped

v0.2.0 (commit `06d9bfc`, tag pushed 2026-10-03): verifier reliability, live counters, rehearsal, amendment, supersession, archive, registry, admission probe, `/goal help`, CLEO link, synthetic notices, path coverage — 82 tests green (31 of them host scenarios on a real `opencode serve`), the tag installs from git in an isolated OpenCode (`git-install` test, 1 pass), and the full transcript of this run is `ledger.jsonl`.
