---
name: write-goal
description: 'Interview the owner and write a goal contract (a goal.yaml under .opencode/goals) that an autonomous goal loop can run until the host proves it done — a "grill me" session through the ask tool that turns a rough intention into an end state, binary criteria with real checks, invariants, protected oracles, non-goals, an optional budget and stop rules, then launches it. Use when the user wants to set up, write, draft, refine or start a goal, run something "until it''s done", use goal mode or /goal, make an agent loop on a task unattended, or says "grill me on this", "turn this into a goal", "goal new", "write-goal". In OpenCode, a bare "/goal new" phrasing is command-routed: the plugin attaches this skill explicitly, so no description-based triggering is needed for that phrasing — trigger evals should measure prose phrasings only. Do NOT use for ordinary one-off requests the user did not ask to turn into a goal.'
license: MIT
metadata:
  version: "0.1.0"
  last_updated: "2026-10-02 23:59:00"
  author: kryptobaseddev
  tags: "opencode, goal, goal-mode, planning, interview, autonomous-agents"
---

# write-goal

Turn a rough intention into a **goal contract**: a structured `goal.yaml` that says what must become true, how the host proves it, where the work may reach, and when to stop — then launch it. A goal is a completion contract, not a task description. **Proof, not effort.**

## Rules (read first)

1. **Ask, don't narrate.** Every choice you put to the owner goes through the ask tool — `question` in OpenCode, `AskUserQuestion` in Claude Code — with 2-4 concrete options, the recommended option **first** and labelled `(Recommended)`, each description saying what happens and the trade-off. Never list options in prose and ask for a reply. Plain text is only for open-ended input ("what would prove this is done?"), or when no ask tool exists.
2. **Facts are your job; decisions are the owner's.** Find commands, files and current results yourself (read the repo, run the checks, use explore subagents). Ask only what the repository cannot tell you. Subagents never ask the owner.
3. **Only when asked.** Never wrap an ordinary request in a goal. If a task would suit goal mode, say so once and let the owner choose.
4. **The owner's words stay authoritative.** Record them verbatim in `intent.verbatim`. Write in the owner's language.
5. **Show the exact contract before launch** and get approval. If the owner wants a looser goal than you recommend, say why once, then write theirs.
6. **Budgets are opt-in.** Never invent a turn cap; the goal stops on its proof or an honest blocker. Offer a budget only for open-ended work, framed in tokens or cost.

## Workflow

### 0 · Seed
Capture the owner's words exactly. Pick a slug (kebab-case, ≤64 chars). Everything goes in `.opencode/goals/<slug>/`.

### 1 · Recon (no questions yet)
Inspect the project: package scripts, Makefile, CI config, test/lint/typecheck/bench commands, the files the intention touches, `git status`. Run the likely checks once to capture a **baseline** (a bug-fix goal should start red). Write the facts to `.opencode/goals/<slug>/context.md` — facts only, no decisions. **If the goal ships a new version of the tooling that will verify it** (a plugin, a harness, the goal engine itself), plan the reinstall of that new version into the release step — the completing verifier round runs the *installed* engine, not the one just built.

### 2 · Classify
bugfix · feature · refactor · migration · perf · research · ops · docs. The class suggests criteria:
- **bugfix**: the failing case captured before, the same case passing after, plus "the rest of the suite SHALL CONTINUE TO pass".
- **perf**: metric, threshold, method and run count ("p95 < 250ms across 3 runs").
- **refactor/migration**: behaviour unchanged (invariants), an `absent` check that the old pattern is gone, a `diff` check on what must not move.
- **feature**: observable behaviour per scenario (EARS: "WHEN … THE system SHALL …").
- **research/docs**: the decision or artifact it must produce, judged by a `verifier` question or `human` sign-off.

### 3 · Grill in frontier rounds
Map the decisions as a tree. Each round, ask the **frontier** — every decision whose prerequisites are already settled — in one ask call (≤4 questions), each with your recommended option derived from recon. Fold each answer into the draft before the next round. Typical: 2-3 rounds, ≤10 questions. Stop when the frontier is empty. Branches, in order:
1. **Outcome** — the one end state that becomes true.
2. **Done when** — which checks prove it (prefer commands that already exist).
3. **Evidence standard** — host checks only, or also the independent verifier / owner sign-off.
4. **Invariants and oracles** — what must keep passing; which tests/benchmarks the worker may never edit (`protect`).
5. **Scope and non-goals** — at least one non-goal.
6. **Risk and escalation** — irreversible or destructive actions; when to stop and ask.
7. **Budget** (opt-in) and **autonomy** (questions mid-run deferred; owner messages steer or pause).

Log every question and answer to `decisions.jsonl` (one JSON object per line: `{"t","q","options","a","by":"owner"|"assumed"}`). Anything you decide without asking becomes an `assumptions` entry with a rationale and `reversible` — never a silent default.

### 4 · Draft `goal.yaml`
Start from `assets/goal.template.yaml` (or the shape below). Then validate: call `goal_validate({slug})` when the opencode-goal plugin is present and fix every error; otherwise self-check against the rules below. Repeat until clean.

### 5 · Review
Show the owner the contract compactly: outcome, a table of criteria (id · statement · check), invariants, protected paths, non-goals, budget. Ask: **Approve** (Recommended) / Revise criteria / Revise scope / Save as draft.

### 6 · Launch
Ask with these options: **`Start goal now`** (Recommended) / Start in a fresh session / **Start clean** / Save for later. The first option's label must **start with** `Start goal now` — a `(Recommended)` suffix is expected and fine (T068: the engine matches on the prefix, never byte-exact).
- OpenCode with the plugin: on "Start goal now", call `goal_start({slug})`. On "Start clean", call `goal_start({slug, fresh: true})` — the engine opens a **new session owned by the goal**, prompts the kickoff there and leaves the current session untouched (it never clears the current one). On "Start in a fresh session", tell the owner to open a new session and run `/goal start <slug>` there themselves. The plugin accepts all of these right after the owner picked a matching option — within 10 minutes, surviving server restarts. If it refuses, its message names what was observed (no approval seen vs label mismatch vs expired); follow that, or tell the owner to run `/goal start <slug>` (plain, or `fresh` for a clean start).
- Fresh session: tell the owner to open a new session and run `/goal start <slug>`.
- Claude Code (no plugin): offer a `/goal` condition rendered from the contract (≤4,000 chars: the end state, the stated check, the constraints that matter).
- Codex: offer `/goal <end state>. Done when <check>. Scope: <in/out>. If <blocker>, stop and report.`

## The contract (`goal/v1`) — essentials

```yaml
schema: goal/v1
id: fix-login-timeout              # = directory slug
title: Login no longer times out   # ≤80 chars, shown in the sidebar
intent:
  verbatim: "login keeps timing out on slow networks, fix it"
outcome: Login completes on a 3G-throttled connection without a timeout error
non_goals: [Redesigning the login page]
criteria:                          # binary; each must be able to fail
  - id: C1
    statement: WHEN the login e2e test runs under 3G throttling THE login SHALL succeed
    check: {kind: command, run: "npm run test:e2e -- login-slow", expect: {exit: 0}, live: true}
  - id: C2
    statement: 'No hard-coded 5s timeout remains in src/auth'
    check: {kind: absent, pattern: "timeout:\\s*5000", paths: [src/auth]}
invariants:                        # must stay true all run; host-checkable kinds only
  - id: I1
    statement: The unit suite SHALL CONTINUE TO pass
    check: {kind: command, run: "npm test"}
protect: ["test/e2e/**"]           # oracles the worker may not edit
plan:                              # optional; becomes the sidebar checklist
  - {id: S1, title: Reproduce under throttling, proves: []}
  - {id: S2, title: Fix the timeout handling, proves: [C1, C2], depends_on: [S1]}
assumptions:
  - {id: A1, text: 3G profile = 400ms RTT / 400kbps, rationale: Chrome DevTools preset, reversible: true}
stop:
  escalate_when: ["The fix needs a backend API change"]
```

Check kinds: `command` (`run`, `expect: {exit | stdout_contains | stdout_regex}`, `timeout` s, `runs`, `live`) · `file` (`path`, `exists`) · `contains` (`path`, `text`|`regex`) · `absent` (`pattern`, `paths`) · `diff` (`paths` unchanged since start) · `verifier` (`ask`: judged by a read-only verifier that must quote files) · `human` (`ask`: owner sign-off).

Optional blocks: `why`, `scope {in, out}`, `constraints`, `budget {turns, wall: "3h", tokens: "3M", cost_usd}`, `autonomy {questions: defer|allow, on_user_message: steer|pause, on_interrupt: pause|resume-on-message}`, `verification {mode: host|host+verifier|strict, max_rejections}` (default `host+verifier`, 3).

Rules the validator enforces: `schema: goal/v1`; `id` equals the directory; `intent.verbatim`, `outcome`, ≥1 `non_goals` and ≥1 essential criterion are required; ids are `C1…`, `I1…`, `S1…`, `A1…` and unique; every criterion has a check of a known kind with its required fields; invariants are host-checkable; plan references exist and have no cycles; budgets parse. Warnings: an outcome that reads as an activity ("keep improving…"), vague words without a number ("fast", "robust", "clean"), no host-checkable essential criterion. **Quote any value containing `: `** with single quotes. Keep every `command` check on a **single line**: YAML folded scalars (`>-`) fold equally-indented lines but keep literal newlines before more-indented ones, so a loop body written on its own line becomes a separate shell command at verify time. Rehearse each command check exactly as stored (extract it from the parsed YAML, run it through the login shell) before claiming.

**Version-release criteria never pin an exact version string.** A `contains`/`stdout_contains` needle like `"version": "1.2.0"` goes stale the moment a patch ships mid-run and turns a proven criterion red for no reason (contract drift — the live v0.2 case). Check the semantic prefix instead: a one-line command such as `node -e "process.exit(require('./package.json').version.startsWith('1.2.')?0:1)"`, or a `contains` regex anchored on the major.minor pair.

Full field reference: `references/goal-schema.md`. Question bank and recommendation heuristics: `references/interview.md`. Four complete contracts (bugfix, perf, migration, feature): `references/examples.md`.

## Weak → strong

- "Find all bugs" → `outcome: Every test in test/auth passes` · C1 `npm test -- test/auth` exits 0 · protect `test/**` · non-goal: no new features · escalate: a fix needs a schema change.
- "Make it faster" → C1 `node bench/render.mjs` prints `speedup=3` or more across 3 runs (`stdout_regex`) · I1 suite passes · non-goal: no new dependencies.
- "Clean up the old API" → C1 `absent` pattern `legacyClient\.` in `src/` · I1 build and tests pass · C2 `verifier`: "Does MIGRATION.md list every replaced call?".

## Common mistakes

| Mistake | Instead |
|---|---|
| Asking in prose, or one question per message | One ask call per frontier round with recommended options |
| Asking what the repo can answer | Recon first; ask only owner decisions |
| Effort instead of proof ("keep improving X") | An end state plus a check that can fail |
| A check the worker can edit | Put the oracle under `protect` |
| No non-goal | At least one, so the loop does not fill the vacuum |
| Inventing a budget or turn cap | Leave it out unless the owner wants one |
| A `command` check spread over indented lines | One line — folded scalars keep newlines before indented lines; rehearse the stored command before claiming |
| A multi-lookahead `regex` in a `contains` check | The engine matches without dot-all — every `(?=.*phrase)` must be satisfiable on ONE line of the file; prefer one needle per criterion, or a single alternation |
| Pinning a release with an exact version string (`contains "version": "1.2.0"` or `stdout_contains "1.2.0"`) | A prefix or semantic check — `node -e "process.exit(require('./package.json').version.startsWith('1.2.')?0:1)"` for a command, or a `contains` regex like `"version": "1\.2\.` — patch releases must not turn a passing criterion red (contract drift; the live v0.2 case) |
| Launching before the owner saw the exact contract | Review step, then the `Start goal now` question |
