# Interview: frontier rounds

## Protocol
1. After recon, write every open decision as a node; note which decisions depend on which.
2. A round asks the **frontier**: the decisions whose prerequisites are settled. One ask call, ≤4 questions, 2-4 options each, recommended option first with "(Recommended)", every option describing what happens and its trade-off.
3. After the answers, update the draft contract and `decisions.jsonl`, then compute the next frontier.
4. Stop when the frontier is empty: an implementer agent could run the contract without asking a single question.
5. Anything not worth the owner's time becomes an assumption: `{id, text, rationale, reversible}`.

`decisions.jsonl` line: `{"t":"2026-10-02T23:00:00Z","q":"What proves it is done?","options":["npm test exits 0","…"],"a":"npm test exits 0","by":"owner"}`

## Question bank (recommendation heuristics in brackets)

**Outcome** — "Which end state should be true when this goal finishes?" [the narrowest state that satisfies the owner's words; offer one broader and one narrower alternative]

**Done when** — "What proves it?" [existing commands from recon first: the failing test, the suite, the build, a bench; a new check only if none exists]

**Evidence standard** — "How strict is completion?" [host checks + independent verifier (Recommended) · host checks only (cheapest; semantic criteria need owner sign-off) · strict (verifier re-confirms host checks)]

**Oracles** — "Which files must the worker never change?" [the tests and benchmarks named in Done-when]

**Invariants** — "What must keep working the whole time?" [the full test suite, the build, typecheck]

**Scope / non-goals** — "Where may the work reach, and what is explicitly out?" [the module recon found; non-goal = the most tempting adjacent change]

**Escalation** — "When should it stop and ask instead of pushing on?" [irreversible data changes, public API changes, new dependencies, credentials]

**Budget** (only for open-ended goals) — "Cap the spend?" [no cap (Recommended for well-proven goals) · a token cap sized to the work · a wall-clock cap]

**Autonomy** — "If you type while it runs?" [steer: your message guides the next turn (Recommended) · pause]

## Launch question

Options, in this order: `Start goal now` (Recommended; the exact label `goal_start` checks) · Start in a fresh session · Save for later.
