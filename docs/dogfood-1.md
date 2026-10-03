# Dogfood 1 — the first real-model goal run

Run: `dogfood-buildout`, run id `0ffe5ac6e001`, session `ses_f004d6e62ffeR2rs3E9wNMHmv9`, started 2026-10-02 20:53:57 PDT by `goal_start` inside the owner's OpenCode 2.0.22. Provider: **GLM via zai-coding-plan — a real model**; no fixture anywhere in this run. The driving plugin is the installed `v0.1.0-alpha.1` tag (`bb40a36`); this tree's `src/` is byte-identical to the tag (only docs commits on top), so the run exercises the shipped engine.

Everything below cites this run's artifacts: `.opencode/goals/dogfood-buildout/ledger.jsonl`, `run.json`, `evidence/0ffe5ac6e001/` (the locked contract), and the OpenCode session store (`~/.local/share/opencode/opencode.db`, read-only).

## 1 · Continuation behaviour on a real model

The loop's turn unit is the OpenCode **execution** (one user prompt → final assistant reply with no pending tool calls), not the individual model request. Within the kickoff execution the worker chains dozens of tool batches, so the whole S1+part-of-S2 build (skill validators, `references/examples.md`, the `session.panel` dashboard, two commits) happened inside `turn: 0`:

```json
{"t":1790999637151,"type":"start","runId":"0ffe5ac6e001","sessionID":"ses_f004d6e62ffeR2rs3E9wNMHmv9","source":"tool","lock":"d6334bb7…","commit":"8abf95fa…"}
{"t":1790999649322,"type":"progress","turn":0,"step":"S1","done":false,"note":"Contract approved and launched…","next":"Create .tmp/venv, install pyyaml…"}
```

- **`goal_progress` lands immediately** (the `progress` event was written 12 s after start, mid-execution), but `turn` and `usage` only move at execution boundaries — during the 20-minute kickoff execution the TUI kept showing `turn 0`. The engine counts no admits until the first end-of-reply; the first `admit` (`kind: "continue"`) was expected the moment this document's draft reply ended. See the ledger tail for the events that accumulated afterwards — continuation, further admits and any verdict rounds append there live.
- The **full continuation cycle is proven with the fixture host** (real TUI, real plugin, scripted model): `turn 1 admitted (kickoff) → turn 2 (continue) → turn 3 (recovery) → paused: stalled: no change the host could see for 3 turns` — visible in the session.panel Timeline captured at `.tmp/spikes/tui-raw.txt` (2026-10-02 21:09). The real-model run adds its own admit/verdict events to the same ledger as it goes.
- The **verifier** is a hidden child session (read tools + `goal_verdict` only) that runs after host checks at claim time; its verdict lines are ledgered as a `verdict` event and stored under `evidence/<runId>/verify-turn-*.json`.

### The first verification round (turn 0 claim, 2026-10-03 21:08–21:10 PDT)

The claim at turn 0 ran the full pipeline end to end on the real model — integrity → 9 host checks → verifier child — and returned a HOST VERDICT that the loop fed back as turn 1 (`admit kind:"verdict"`). Verbatim from `ledger.jsonl`:

```json
{"t":1791001686843,"type":"claim","turn":0,"summary":"v0.2 dogfood complete: …"}
{"t":1791001699139,"type":"verify-start","source":"claim","turn":0}
{"t":1791001789349,"type":"verdict","passed":false,"lines":["C3 FAILED [host] … exit 1, expected 0 …","C2 FAILED [verifier] … verifier failed: verifier did not call goal_verdict"]}
{"t":1791001789354,"type":"admit","kind":"verdict","turn":1,"messageID":"msg_1000683a90014NIMZpHVZdOvYp"}
```

Seven of nine host checks passed on the first round (C1, C4–C9) plus all three invariants; the full claim evidence and per-check results are in `evidence/0ffe5ac6e001/verify-turn-0-1791001789349.json`.

**`goal_verdict` was never called: the verifier child (GLM flash) spent ~90 s and ended without calling the tool** — `verifier failed: verifier did not call goal_verdict`. The child session's transcript is not persisted, so the root cause (prose answer vs. dropped tool call vs. turn limit) is unobservable from the artifacts; filed as T016. The practical consequence: until a verifier round actually calls `goal_verdict`, this run has no tool-produced quotes to quote — the flow above is quoted from the host's ledger instead.

## 2 · Request/token cost

Sampled from the session store after ~20 minutes of goal work (83 assistant messages, session-wide since the dogfood prompt at 19:58:08):

| | tokens |
|---|---|
| fresh input (uncached, per request) | 244,132 |
| cache reads | 9,232,000 |
| output | 20,718 |
| **total touched** | **9,496,850** |

- Median fresh input per request ≈ **600 tokens**; a heavy request (tool-result-heavy or post-interrupt) is 3–7k; the two full-context requests are 52k and 89k.
- Reported `cost` is `0.0000` on every message — the zai-coding-plan provider does not report per-request prices, so the goal's `usage.cost` stays 0 on this plan; tokens are the only observable.
- Plugin overhead per request: the rendered system block for this contract is **9,048 bytes ≈ 2.4k tokens**, present in every request of the run (that is the design: the contract is re-rendered from disk each time so compaction cannot lose it). The nine `goal_*` tool schemas add a fixed cost on top.

## 3 · Prompt-cache behaviour

The cache-stable design (byte-identical system block per run; volatile status in a per-turn tail note inserted just before the turn's own message, `src/server/app.ts:829-839`) shows up exactly as intended in the provider's numbers:

- **Exactly one cache rebuild, precisely at goal start.** Assistant message #15 at **20:53:57** — the same second as `run.json`'s `createdAt` — reports `input=88,848, cacheRead=0` right after a steady `cacheRead≈86k`: the kickoff's rendered system block rewrote the prompt prefix and the provider re-read the whole context once (~89k tokens).
- **From the next message on, the new prefix caches cleanly**: `cacheRead` climbs 88,832 → 154,944 across the run while fresh input stays in the hundreds. Over the whole session, **97.4% of all tokens touched were cache reads**.
- Session start (19:58:08) shows the same shape: one full 52k read, then instant caching — so the plugin's marginal cache cost is **one prefix rebuild per goal start**, nothing per turn.
- `cacheWrite` is 0 on every message: the provider does not itemize cache-write tokens on this plan (reads only).

## 4 · Defects and follow-ups found during the run

Filed as CLEO tasks under epic T002:

1. **T013 — Counters stall inside a long execution.** `turn`, `usage.tokens` and the TUI pill/card freeze at their kickoff values for the whole multi-tool execution (`turn: 0`, `usage.tokens: 1` after 20 minutes of real work). Root cause: `session.usage.updated` events are only sampled at execution boundaries, and `baseTokens = total - 1` makes the first sample show exactly `1` (`src/server/app.ts:381-389`).
2. **T014 — Spike probe scripts assume the sidebar.** `scripts/tui-smoke.ts` / `spikes/tui-capture.py` probe for the sidebar card (`PROBE-SIDEBAR missing` in the capture) — with the dashboard panel open (default now), the panel takes the right pane and the card is hidden by design.
3. **T015 — Trigger-eval miss on `/goal new …` phrasing.** The behavioural trigger eval (real `claude` CLI sessions, 17 queries × 1 run, `skills/write-goal/evals/trigger-eval-2026-10-03.json`) scored 15/16; the miss is the bare `/goal new make the build pass on node 24` query. In OpenCode that phrasing is command-routed (the `/goal new` command attaches the skill explicitly), so the description path is not implicated — but the eval should cover the command route instead of penalizing it.
4. **T016 — Verifier child ended without calling `goal_verdict`.** First real verification round: ~90 s of child activity, no tool call, no persisted transcript to diagnose. Needs a repro (host test with a model that answers in prose) and a verifier prompt/tool-call hardening fix (e.g., a final-turn reminder or accepting a fenced JSON answer as a fallback), plus transcript persistence for diagnosability.
5. **C3's own check command is unrunnable as contracted** — a YAML folded-scalar (`>-`) pitfall: the more-indented lines inside the `for` loop kept literal newlines, so the host's zsh executed the skill *directory* as a command (see the C3 stderr in `verify-turn-0-1791001789349.json`). The criterion's substance is proven (the validators exit 0 when run with the two paths on one line); the command text itself needs a contract fix, which only the owner can make. Fixed on 2026-10-03 (commit `e742f2e`); the run restarts with a fresh lock.
6. **CLEO evidence-atom friction during completion tracking** — the `test-run` atom's undocumented schema and the workspace-wide classification of `.opencode/**` files forced a full-suite `tool:test`; repro and upstream reports in [`docs/cleo-evidence-repro.md`](cleo-evidence-repro.md). A council review of the contract-lock design (amendment path vs abort-and-restart) is ingested at `.cleo/council-runs/20261003T145323Z-a46b2ff9/` (verdict: build both rehearsal and an owner-approved amendment path; confidence high).

## 5 · What ran in this goal (summary at draft time)

- S1: skill-forge validators green (venv + PyYAML), `references/examples.md` (4 contracts, each parsed with `parseContract`), trigger evals recorded — commit `a3768d2`.
- S2: `session.panel` dashboard (criteria board with per-criterion evidence, plan, verdict, ledger timeline), auto-open per run, focus command, snapshot test; real-TUI capture shows it by default — commit `dace4f0`.
- S3: this document. S4 (release `v0.1.0-alpha.2`) and the first claim→verdict cycle follow.
