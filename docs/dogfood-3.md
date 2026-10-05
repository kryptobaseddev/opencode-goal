# Dogfood run 3 — v0.3.0: every decision persistent, actionable, visible

Run `ship-v03-feedback-loop` (lock `2bff41e4a945`), started 2026-10-04 under
the **installed v0.2.2** engine, completed under the reinstalled **v0.3.0**
after the engine-version gate. This document is written from the run's own
ledger (`ledger.jsonl`) and evidence folder; every claim below cites where it
came from. The completing verifier round's quote is in §6.

## 1. What this run proved live, before any test ran

- **The v0.2.2 dashboard freeze was real and live.** Mid-run the owner
  steered (ledger `steer` event, recorded in full at 280 chars — the ledger
  truncated the rest): *"the dashboard has not updated at all… nothing in
  the dashboard is updating or tracking your progress."* The owner's fuller
  message (session transcript, beyond the ledger's truncation) added that it
  still showed 0/22 criteria and step S1. Root cause found in the same
  session: the engine *did* emit `updated` on every persist (verified event
  flow in a clean process), but the TUI trusted a single event subscription
  and a one-shot snapshot — a dropped stream or a subscription that attached
  before the plugin registered froze the card at its first render forever.
  Fixed as T058 (d0f1183): defensive stale-snapshot re-fetch on renders + a
  4-second ticker for live goals. The stale numbers were also half-correct
  by design: criteria outcomes only populate at verification time (proven,
  not claimed) — but the plan steps and status were genuinely frozen.
- **The engine-version rule bit exactly as designed.** The owner's dashboard
  stayed stale even after the fix because the installed tag is what runs the
  session — nothing in the working tree changes the owner's OpenCode until
  `plugin remove` / `plugin add #v0.3.0` / `reload`. The run blocked on
  `owner-reinstall-v030` before the completing claim (ledger: the `block`
  event) precisely so the final verifier round runs the released engine.

## 2. The loop under the loop: how the work actually went

Twelve plan steps (S1–S12) landed in order in a single session turn, each
with its own commit and CLEO gates recorded (ledger: the `progress` events,
one per step, each naming its commit):

| Step | Task | Commit | What landed |
|---|---|---|---|
| S1 | T044 | c36ef35 | verifier child carries an explicitly resolved model; empty exchanges retried once, always recorded |
| S2 | T057 | 6dced5f | owner-final skips HOST re-checks too |
| S3 | T049 | 681b9a5 | owner actions from any session; `/goal attach`; palette lists goals |
| S4+S5 | T045/T046 | f524101 | post-goal summary + flagged scope audit |
| S6 | T054 | 34cbb1d | every notice = cause + concrete choices |
| S7 | T050 | 996b0cc | decision payloads → selectable dialogs wired to `rpc.act` |
| S8 | T052 | 049961d | persistent transcript rows + action-required state |
| S10 (pulled forward) | T058 | d0f1183 | dashboard freeze fix |
| S9 | T053 | c08924a | live activity tracer |
| S11 | T056 | 117e3e7 | dashboard rework (tabs, ≤12-line card, on-demand panel) |
| S12 | T055 | c0ef2b4 | version-prefix authoring rules + worked example |
| S13 | T024 | 604b756 | v0.3.0 tagged, pushed, git-install proven |

Two engine `recovered` events (session restarts) and one owner steer are in
the ledger; the loop resumed each time without losing state — the run's turn
counter and step map survived across host restarts.

## 3. Defects found during the run, filed with ids

- **T058 (filed live, fixed this run)** — sidebar/panel stale after state
  changes; reproduced from the owner's steer, fixed by defensive re-fetch
  (d0f1183).
- **T062 (filed from this run's live mistake, fixed the same turn)** — the
  worker routed `goal_claim` through Code Mode (`execute`) and got
  "Unknown tool 'goal.claim'. Did you mean
  tools.cloudflare.get_zones_api_gateway_configuration?" — goal tools are
  registered `codemode:false` and never exist in Code Mode's catalog. Fix:
  every `goal_*` tool description now says it is called directly by name,
  and `/goal help` documents the rule.
- **T063 (filed from the owner's steer at the first verdict, fixed the same
  turn)** — during the multi-minute host verification the owner saw nothing
  until the verdict toast. Fix: the verifying tracer line carries live
  per-criterion progress (`verifying the claim — 41s · check C7 · 7/22`), and
  steer events now record up to 1000 chars (the dashboard-freeze steer had
  lost its specifics to a 280-char truncation).
- **cleo#1832-adjacent environment note (observed, not a plugin defect)** —
  under `bun test`, a tight synchronous poll loop starves the SSE event
  reader (~4.5 s per iteration) and can kill the test client's event socket
  with ECONNRESET; scenarios that poll must await something async (snapshot
  reads) per iteration. Recorded as a CLEO observation ("T058 dashboard
  freeze: event-trust + scenario claim-timing").
- **T024 stays open on purpose** — its three low-priority backlog children
  (T059 launch-surface clean start, T060 `/goal start` picker, T061 priority
  field) are filed future work, not this goal's scope; closing the epic would
  have required archiving filed backlog tasks, so it remains the next board.

## 4. The honest red baseline (contract assumption A1) held

The twelve new test files were committed as red stubs at the contract commit
(fe3a86a) before any work: every command criterion started failing. At the
v0.3.0 tag the full suite is **137 pass / 0 fail / 1 skip** (`bun test`,
~100 s) — including the two tests that went green only after the owner's
dashboard steer redirected the plan (S10 before S9/S11).

## 5. The reinstall gate (engine-version rule)

Sequence, all in the ledger: `block` (owner-reinstall-v030, reported three
times with independent work between reports) → owner runs
`opencode plugin remove "github:kryptobaseddev/opencode-goal#v0.2.2"` →
`opencode plugin add "github:kryptobaseddev/opencode-goal#v0.3.0"` →
`opencode reload` → `/goal resume`. The git-install test had already proven
the pushed tag installs in an isolated OpenCode (C17:
`OCGOAL_GIT_INSTALL=1 OCGOAL_GIT_SPEC="github:kryptobaseddev/opencode-goal#v0.3.0"
bun test ./test/host/git-install.test.ts` → 1 pass). The reinstall was
detected without asking the owner twice: the git-install cache
(`~/.cache/opencode/npm/git-opencode-goal-<hash>/<epoch>/package.json`)
showed a new `#v0.3.0` entry at 2026-10-05T01:13:31Z.

## 6. The completing verifier round (this run's own evidence)

The first claim's verifier round ran under the reinstalled v0.3.0 on the
main host — the ledger shows `verifier-model` resolving
`zai-coding-plan/glm-5.3#high` before the child started, and the round
completed **first try**: one round, no retry, no empty exchange (the T044
live proof). Its transcript is persisted at
`.opencode/goals/ship-v03-feedback-loop/evidence/109159956001/verifier-transcript-turn-4-1791163212560.json`
(ledger `verifier-transcript` event: `by: verifier, rounds: 1, retried:
false, model: zai-coding-plan/glm-5.3#high`).

The child judged C19 by actually reading this document, the ledger and the
evidence folder — its own words from the transcript, quoted verbatim:

> "The glob for `.opencode/goals/ship-v03-feedback-loop/**` returned no
> files. That's odd. […] glob has `hidden` parameter default false. Let me
> retry with hidden: true."
>
> "The ledger ends at line 38 with a `verifier-model` event. There is no
> `verifier-transcript` ledger event, no `verifier-empty` event […] run.json
> status: 'verifying', activity kind 'verifier-child' […] — that's me, right
> now."
>
> "Verdict recorded for C19: **not_proven** — the dogfood-3 doc grounds its
> step/commit table, reinstall gate, and defect ids (T058, T024/T059–T061)
> in the run's ledger, but §6's verifier-verdict evidence is still a
> placeholder with no corresponding ledger event or evidence file, and one
> steer-quote fragment not in the ledger."

That verdict was correct: this section was a placeholder at claim time (the
transcript it cites is written only after the child finishes), and the steer
quote borrowed words the ledger's 280-char truncation never recorded. Both
are fixed in this revision — the quotes above are read back from the
transcript file, and §1 now quotes only what the ledger carries. The
verifier child catching its own round's evidence gap, in flight, is the
feedback loop working end to end.

The second claim's round (turn 5) timed out with zero messages —
`verifier-transcript-turn-5-*.json` records `done: timeout, rounds: 1,
messages: 0` (provider hang, not an empty parse): the failure mode T044
made visible and diagnosable instead of silent. C1's live proof remains the
healthy turn-4 round above.

## 7. What the next board should look at

T059–T061 (launch surface, start picker, priority field) plus the standing
backlog: relay mode, goal queues, home-screen board, Claude Code / Codex
adapters, headless runner, npm publishing.
