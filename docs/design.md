# Design — `write-goal` skill + OpenCode 2 goal plugin

Status: **v0.1.0-alpha.1 built** (see “As built” at the end for where the code differs from this proposal) · Target host: OpenCode **2.0.22+** (V2 plugin API only) · Companion: [research/landscape.md](research/landscape.md), [spikes.md](spikes.md), [HANDOFF.md](HANDOFF.md)

Names: skill **`write-goal`**, plugin **`opencode-goal`** (github.com/kryptobaseddev/opencode-goal, installed from git tags; no npm package).

---

## 1. What we are building

Three parts that share one artifact, the **goal contract**:

1. **`write-goal`** — a portable skill that interviews the owner ("grill me") with the runtime's ask tool and writes a structured, non-prose goal contract plus its supporting files. It ends by launching the goal.
2. **Server plugin** — executes a contract: persistent objective, auto-continuation, host-verified completion, budgets, stall and blocker detection, compaction-proof context.
3. **TUI plugin** — live sidebar card, footer pill, attention banner, full dashboard panel, desktop notifications.

Non-goals for v1: OpenCode 1.x support; web/desktop UI (they don't load TUI plugins, but the server side still works there); multi-machine state sync.

## 2. Design rules (each traced to a failure seen in the field)

| Rule | Because |
|---|---|
| R1 The contract is written and **locked before work**; agents may propose amendments, never apply them | Codex #35709 (objective rewritten from the assistant's own advice); "criteria added after implementation" |
| R2 The worker **claims**; the host **proves** | false success 45-76% of failures; transcript-only judges anchor on confident prose |
| R3 Progress = **authoritative state change**, not activity | Codex 288-turn post-compaction loop (#47707) |
| R4 **Waiting costs zero tokens** | Codex: 1.4% of goal sessions burned 49% of input tokens polling (#44909) |
| R5 The goal is **rendered from disk into every request**, never kept only in history | Codex goal lost on compaction (#32922, #49022) |
| R6 **Status is rendered by the UI**, never paraphrased by a paid model turn | wr-goal: every `/goal status` is a model turn |
| R7 **Questions happen before the loop**; during it they become deferred decisions | Claude Code goal blocked overnight on a question (#61337) |
| R8 **Cache-stable prompts**: stable system block, volatile data only near the tail | wr-goal 0.4.1: ~$12 in 8 min from a busted prefix cache |
| R9 The owner's **verbatim words stay authoritative**; structure is derived and confirmed | js-goal dropped model drafting because it distorted intent |
| R10 **Fail closed, feed back**: a rejected claim returns a structured HOST VERDICT and the loop keeps working | wr-goal pauses on rejection with no feedback |

## 3. System overview

```
 owner ──/goal new "<words>"──▶  write-goal skill  (question tool, frontier rounds, recon subagents)
                                     │ writes
                                     ▼
            .opencode/goals/<slug>/  goal.yaml        contract (locked by sha256 at start)
                                     context.md       facts found by recon (paths, commands, baseline)
                                     decisions.jsonl  interview Q→A log, append-only
                                     run.json         runtime snapshot      ┐ written only
                                     ledger.jsonl     runtime events        │ by the plugin
                                     evidence/        host check outputs    ┘
                                     │ goal_start (after an approved form) or /goal start <slug>
                                     ▼
 OpenCode 2 server ─ plugin "opencode-goal"
   contract loader/validator/lock · run store + ledger · loop engine (event.subscribe)
   context + compaction hooks · tool guard · goal_* tools · verification pipeline
   hidden goal-verifier agent · /goal command · GoalRpc (methods + events)
                                     │ RPC (works with a remote server)
                                     ▼
 OpenCode 2 TUI ─ plugin "opencode-goal/tui"
   sidebar.content card · prompt.footer.status pill · session.composer.top banner
   session.panel "goal" dashboard · keymap layer · dialogs · attention.notify
```

## 4. The goal contract — `goal.yaml` (schema `goal/v1`)

Structured YAML for humans, compiled to JSON state by the plugin. Every list item has a stable ID that is never reused.

```yaml
schema: goal/v1
id: checkout-latency                    # = directory slug
title: Checkout p95 under 250ms
intent:
  verbatim: "make checkout faster, it's killing conversion on mobile"   # owner's words, never edited
outcome: Checkout API p95 is below 250ms on the documented slow path    # one end state, not an activity
why: Mobile conversion drops when checkout exceeds 300ms (owner, 2026-10-02)

scope:
  in:  [src/checkout/**, src/db/queries/cart.ts]
  out: [client-side code, new caching layers]
non_goals:                              # at least one
  - Redesigning the cart schema
constraints:
  - No new runtime dependencies

criteria:                               # the contract: binary, each able to fail
  - id: C1
    statement: WHEN `npm run test:checkout` runs THE suite SHALL exit 0
    essential: true
    check: {kind: command, run: "npm run test:checkout", expect: {exit: 0}, timeout: 300, live: true}
  - id: C2
    statement: p95 latency of the slow path SHALL be < 250ms across 3 consecutive runs
    essential: true
    check: {kind: command, run: "node bench/checkout.mjs --json", runs: 3, expect: {json: "p95 < 250"}}
  - id: C3
    statement: The latency fix SHALL be explained in docs/perf.md under a "Checkout" heading
    essential: false
    check: {kind: verifier, ask: "Does docs/perf.md explain the checkout fix and its measured effect?"}

invariants:                             # must stay true the whole run ("SHALL CONTINUE TO")
  - id: I1
    statement: The full test suite SHALL CONTINUE TO pass
    check: {kind: command, run: "npm test", expect: {exit: 0}}
protect:                                # oracles the worker may not edit
  - "**/*.test.ts"
  - bench/**

assumptions:                            # silent defaults made explicit; owner can veto
  - {id: A1, text: "Measured locally against the seeded dev DB", rationale: "no staging access", reversible: true, status: assumed}

plan:                                   # optional; becomes the sidebar checklist (V2 has no todo tool)
  - {id: S1, title: Profile the slow path, proves: []}
  - {id: S2, title: Remove N+1 in loadCart, proves: [C1, C2], depends_on: [S1]}
  - {id: S3, title: Document the change, proves: [C3], depends_on: [S2]}

budget: {turns: 40, wall: 3h, tokens: 3M, cost_usd: 15}     # spend, not context size; owner-set
stop:
  when: All essential criteria are host-verified and invariants hold
  escalate_when:
    - A fix requires changing the public checkout API
    - The same blocker repeats for 3 consecutive turns
autonomy:
  questions: defer        # defer | allow
  on_user_message: steer  # steer | pause
  on_interrupt: pause     # pause | resume-on-message
verification:
  mode: host+verifier     # host | host+verifier | strict (strict = verifier must also confirm host-checked criteria)
  max_rejections: 3       # same criterion rejected N times → needs_review
execution:
  agent: build            # the plugin never switches agents mid-run
meta: {created: "2026-10-02T23:20:00Z", author: owner, source: write-goal@1.0.0, lock: null}
```

**Check kinds:** `command` (`run`, `expect: {exit | stdout_contains | stdout_regex | json}`, `timeout`, `runs`, `live`), `file` (exists / not exists), `contains` (path + text|regex), `absent` (pattern must match nothing — negative space such as "no `TODO(checkout)` remains"), `diff` (paths unchanged since start), `verifier` (semantic; judged by the read-only verifier with quotes), `human` (owner sign-off at the end, e.g. visual review).

**Validator** (`write-goal/scripts/validate_goal.py`, python + pyyaml — the repo's only dependency) rejects: no essential criterion; a criterion with no failable check; zero non-goals; vague adjectives without a metric ("fast", "robust", "clean", "properly"); unknown check kinds; `protect` globs matching nothing; missing budget; duplicate IDs. With `--probe` it dry-runs each command once and records the **baseline** (a bug-fix goal *should* start red).

## 5. `write-goal` skill

Lives in this repo as `skills/write-goal/` (portable SKILL.md; `references/schema.md`, `references/question-bank.md`, `assets/goal.template.yaml`, `scripts/validate_goal.py`, `evals/trigger_queries.json`). The ask tool is the runtime's own: `question` in OpenCode, `AskUserQuestion` in Claude Code. Recon subagents return facts and never ask the owner.

**Flow**

| Phase | What happens | Output |
|---|---|---|
| 0 Seed | Capture the owner's words verbatim (`/goal new <words>` or "write a goal for…") | `intent.verbatim` |
| 1 Recon | Parallel explore subagents find facts: test/build/lint/bench commands, relevant files, CI config, git state, and run the likely checks once for a baseline. Never ask what can be looked up | `context.md` |
| 2 Classify | bugfix · feature · refactor · migration · perf · research · ops · docs — selects criterion templates (bug fix = failing case captured before, same case green after; perf = metric + threshold + method + run count; refactor = behavior unchanged + named invariants) | criterion skeletons |
| 3 Grill | Design-tree **frontier rounds**: each round asks only decisions whose prerequisites are settled, ≤4 questions per ask call, 2-4 options each, recommended option first with "(Recommended)", every description states the consequence. Owner decisions only: outcome, done-when, evidence standard, protected oracles, scope and non-goals, irreversible or destructive actions, escalation, budget, autonomy. Everything else becomes an `assumed:` entry with a rationale. Rewrite the draft after every answer; stop when the frontier is empty (typically 2-3 rounds, ≤10 questions) | `decisions.jsonl` |
| 4 Draft | Generate `goal.yaml`; run the validator with `--probe`; fix and repeat until clean | valid contract |
| 5 Review | Show a compact criteria table; ask Approve / Revise criteria / Revise scope / Save as draft. Bar: an implementer agent could run this without asking a single question | approved contract |
| 6 Launch | Ask Start now (this session) / Start in a fresh session / Save for later. OpenCode + plugin → `goal_start({slug})`; otherwise print `/goal start <slug>`. Claude Code → render a `/goal` condition (≤4,000 chars: end state + stated check + constraints + turn clause). Codex → render a `/goal` objective | running goal |

**Question bank branches** (each question carries a recommendation computed from recon): Outcome → Done-when → Evidence standard ("minimum evidence before this is done?") → Invariants and protected files → Scope and non-goals → Risk and escalation → Budget → Autonomy (questions mid-run: defer or allow; user messages: steer or pause) → Plan granularity.

`/goal new` in OpenCode is a command that calls `ctx.session.prompt({text: words, skills: [{id: "write-goal"}]})`, so the interview starts inside the current session.

## 6. Server plugin

### 6.1 Module layout (no monolith)

```
src/server/index.ts        Plugin.define({id:"opencode-goal", setup}) — wiring only
src/contract/              schema, parse, validate, lock (sha256), render (system block, tail note)
src/store/                 run.json (atomic tmp+rename+fsync) · ledger.jsonl (append, terminal-first) · lease
src/engine/                state machine · turn collector · guards · scheduler (cooldown, waits, backoff)
src/verify/                host runner · invariants · protect diff · verifier session · quote re-read · verdict
src/hooks/                 context · compaction · tool.execute.before/after · retry
src/tools/                 goal_status · goal_progress · goal_claim · goal_block · goal_flag · goal_wait · goal_amend · goal_start
src/rpc/                   GoalRpc definition (shared with the TUI) + handlers + event emitter
src/tui/                   TUI plugin (separate entry, precompiled)
```

### 6.2 State machine

```
draft ─start─▶ running ⇄ waiting{children|timer|user|backoff}
                  │  claim
                  ▼
              verifying ──pass──▶ complete
                  │ fail (HOST VERDICT) → running
running ─▶ paused{interrupt|restart|stalled|plan-hold|error|user}   ─resume (owner only)─▶ running
running ─▶ blocked{blocker_key ×3} · needs_review{rejections ≥N | flag | amendment | human check}
running ─▶ budget_limited (after exactly one wrap-up turn) · usage_limited (provider quota) · failed · aborted
```

The model may only: report progress, claim, block, flag, wait, propose an amendment. It can never resume, edit the contract, extend a budget, or clear. Owner transitions come from `/goal …`, TUI keys, or dialogs.

### 6.3 Turn cycle

1. **Filter**: `session.execution.*` events whose `location.directory` matches, whose session owns a running goal and has no `parentID`; dedupe by event id.
2. **Collect turn facts** during the execution: tool calls/failures (`session.tool.*`), usage delta (`session.usage.updated` → spend, not context size), compaction, goal tool calls.
3. **On `succeeded`**: compute the worktree fingerprint (`git status --porcelain` + diff hash, excluding `.opencode/goals/`), re-run `live: true` criteria if files changed, then classify the turn host-side: **progress** (worktree changed, a criterion transitioned, or a step advanced) / **verified wait** / **no progress**. Counters decrement on progress rather than reset.
4. **Guards, in order**: ownership and run epoch → pending form or permission (`waiting:user`, attention) → running children or background shells (`waiting:children`, check-ins at 30/60/120 min, max 3) → pending `goal_wait` timer → pending claim (run verification, no model turn) → budgets (80%: warn in the tail note; 100%: one wrap-up turn, then `budget_limited`) → no-progress (2 → recovery prompt, 3 → `paused:stalled`) → same `blocker_key` 3 consecutive turns → `blocked` → restricted agent (plan) → `paused:plan-hold` → cooldown (≥1.5 s, exponential after failures).
5. **Admit**: persist the claim `{goalId, runId, turn, sourceExecution}` to `run.json`, then `ctx.session.prompt({sessionID, id: msgId(goalId, runId, turn), text: "↻ goal turn 7/40", metadata: {goal: {id, run, turn}}, resume: true})`. The deterministic `id` makes a retried admission idempotent.
6. **On `interrupted`**: `user` → `paused:interrupt`; `superseded` (owner typed while it ran) → record a steer and continue after that turn; `shutdown`/`inactivity` → `paused:restart`. **On `failed`**: transient → retry with backoff ×3; quota → `usage_limited`; auth/context overflow → `paused:error` with the reason.

Owner messages during a run (`autonomy.on_user_message: steer`) are logged as steers. They never alter the contract and they vanish when the goal ends (Codex #34602).

### 6.4 What the model sees

- **System block** (`context` hook → `event.system`): outcome, criteria IDs + statements, invariants, non-goals, constraints, protect list, tool protocol. Byte-identical for the whole run; changes only on an accepted amendment. Not persisted, so compaction cannot drop it.
- **Tail note** (`context` hook, spliced just before the last user message, goal turns only): turn and budget remaining, the criteria board (✓ host-verified / ✗ failing / · unknown), current step, the last HOST VERDICT, a no-progress or recovery directive, "re-read goal.yaml and the last 20 ledger entries" after a compaction. The ledger records the rendered note for audit.
- **Persisted trigger**: one line (`↻ goal turn 7/40`), keeping the transcript readable.
- **Compaction hook**: injects the run state so the summary's `## Objective` matches the contract.

The continuation directive keeps Codex's strongest text (keep the full objective; work from current evidence; no status-only turns; do not narrow success to what passes), but the audit becomes **"call `goal_claim` with evidence per criterion; the host will check it"** instead of an honor-system self-audit.

### 6.5 Tools (`namespace: "goal"`, `codemode: false`)

| Tool | Input (abridged) | Effect |
|---|---|---|
| `goal_status` | — | JSON: state, criteria board, step, budgets, last verdict |
| `goal_progress` | `{step?: {id, status}, note ≤280, next ≤280}` | checkpoint → ledger + sidebar; replaces scraping reply text |
| `goal_claim` | `{summary, criteria: [{id, evidence: [{kind: command\|file\|quote, ref, quote?}]}], limitations?}` | queues verification after the turn ends; returns "end your turn" |
| `goal_block` | `{blocker_key, reason, needs: decision\|credential\|access\|external, tried}` | counted; 3 consecutive → `blocked` |
| `goal_flag` | `{criterion, kind: contradictory\|impossible\|unsafe, reason}` | immediate `needs_review` — the honest "abort and flag" exit |
| `goal_wait` | `{seconds ≤ 3000, reason, handle?}` | `waiting:timer`; zero tokens until it fires (capped below the 60-min eviction) |
| `goal_amend` | `{change, rationale, evidence}` | proposal queued for the owner (dialog / panel); never auto-applied |
| `goal_start` | `{slug}` | accepted only if this session has a `form.replied` approving launch in the last 10 min, otherwise refuses and points to `/goal start` |

`tool.hook("execute.before")` enforces: edits to `protect` globs and to `.opencode/goals/**` are rejected with a message; `question` is converted into a deferred decision when `autonomy.questions: defer` (the agent is told to record an assumption or call `goal_block`/`goal_flag`).

### 6.6 Verification pipeline (on `goal_claim`, host-side, between turns)

1. **Integrity**: contract hash equals the lock; `protect` paths unchanged since the start commit; goal directory untouched except by the plugin.
2. **Host checks**: every deterministic criterion and invariant runs in the owner's login shell (`$SHELL -lc`, cwd `ctx.location.directory`, timeout, `runs`) → `evidence/<run>/<id>.json` with trust level `host`.
3. **Verifier** (`host+verifier`, `strict`): `ctx.session.create({parentID})` with a hidden `goal-verifier` agent (read/glob/grep allowed; edit/write/patch/shell/subagent/question denied), given the contract, the claim and host evidence. It must answer through a `goal_verdict` tool (only that agent may call it): per criterion `{id, verdict: proven|not_proven|contradicted, evidence: [{path, quote}]}`. The host re-reads every quote as an exact substring. Timeout, error or malformed verdict = rejection. The child session is removed afterwards.
4. **Human criteria** → `needs_review` with an approve/reject dialog.
5. **Decision**: all essential criteria proven by host or verified-quote evidence and invariants green → `complete` (ledger, sidebar ✅, attention "done"). Otherwise the next tail note carries a **HOST VERDICT** (criterion, command, exit code, output tail, verifier reason) and the loop continues; the same criterion rejected `max_rejections` times → `needs_review`.

### 6.7 Persistence, concurrency, restarts

- `run.json` (atomic tmp + rename + fsync) and `ledger.jsonl` (terminal events written before the snapshot) live in the goal folder; a session→goal index lives in `ctx.storage` (`idx:<dirHash>:<sessionID>`).
- Lease: `O_EXCL` lock file with a heartbeat; take over only after a stale heartbeat (> 2 min). Needed only for `--standalone` servers sharing a DB — far simpler than a hard-link guard.
- After a restart or plugin reload, running goals load as `paused:restart`; the composer banner offers one-key resume. Waits and check-ins are re-armed from `run.json`.

### 6.8 `/goal` command (plugin code, no model turn unless one is needed)

`/goal` and `/goal status` open the panel (RPC event to the TUI; without a TUI a `synthetic` status message, `resume:false`) · `/goal new <words>` starts write-goal · `/goal start <slug>` · `pause` · `resume` · `verify` (run the pipeline now) · `abort` · `edit` (write-goal in revise mode, re-lock) · `list` · `history` · `quick <words>` (Codex-style: verbatim objective, a single verifier criterion, default budget). At setup the plugin warns (toast) if a config/markdown command named `goal` shadows it.

## 7. TUI plugin

**Sidebar card** (`sidebar.content`, 42 columns, colors from `theme`):

```
◎ GOAL ───────────────────── ▶ RUNNING
Checkout p95 under 250ms
criteria ■■■□□ 3/5 proven
 ✓ C1 checkout tests green     host 2m
 ✓ C2 p95 231ms ×3             host 2m
 ◐ C3 docs/perf.md section     claim
 · I1 full suite (invariant)   live
step 2/3  Remove N+1 in loadCart
turn 7/40 · 42m/3h · 1.2M/3M · $4/$15
↻ ran bench: p95 231ms (−38%)
⚠ verdict: C3 heading missing
```

- **Footer pill** (`prompt.footer.status`): `◎ 3/5 · t7/40 · 42m` — visible below 120 columns when the sidebar is hidden.
- **Composer banner** (`session.composer.top`), shown only when the owner is needed: `⛔ blocked ×3: needs STRIPE_TEST_KEY · r resume · g panel`; also for `needs_review`, pending amendments, `paused:restart`.
- **Panel** (`session.panel` "goal", fullscreen toggle): Contract · Board (per-criterion evidence, trust level, last run) · Timeline (ledger) · Verdicts · Amendments (accept/reject).
- **Keymap layer**: `goal.panel`, `goal.pause`, `goal.resume`, `goal.verify`, `goal.abort` (confirm dialog), `goal.open-contract`.
- **Attention** (`attention.notify`, `when: blurred`): complete → sound `done`; blocked / needs_review / waiting:user → `question`; failed → `error`.
- **Data**: `GoalRpc = Rpc.define({id: "opencode-goal", methods: {snapshot, list, act}, events: {updated, ui}})`; the TUI subscribes to `updated`, re-syncs on `server.connected`, uses `data.on("session.usage.updated")` for live spend, and ticks clocks locally. No file polling, no transcript scraping. UI preferences (collapsed sections) live in `context.storage.store`.

## 8. Testing

- Unit: contract validator, state machine (generated command sequences, as wr-goal does), guard ordering, renderers (snapshot tests asserting the system block is byte-stable across turns).
- Host contract: a deterministic localhost OpenAI-compatible fixture provider driving a real `opencode serve` 2.0.22 (wr-goal's approach): start → continue → claim → reject → fix → complete; interrupt; restart; compaction; budget wrap-up; blocker ×3; `goal_wait`.
- Mutation contract on the safety rules (contract lock, protect, model-cannot-resume, fail-closed verifier).
- Skill: `trigger_queries.json` with near-misses; `validate_goal.py` golden files; the repo's `validate.py`, `audit_body.py`, `check_depth.py`.

## 9. Spikes to run first (unknowns that could change the design)

| # | Question | Why it matters |
|---|---|---|
| S1 | Do events from another project reach this instance (two projects open)? | ownership filter correctness |
| S2 | Does `prompt({id})` dedupe a retried admission; does `metadata` survive on the message? | idempotent continuation |
| S3 | Is an `event.system` addition in the `context` hook cache-stable across turns on Anthropic and OpenAI providers? | R8 cost |
| S4 | Which PATH/env does a plugin-spawned `$SHELL -lc` get inside the background service? | host checks must find `npm`, `bun`, … |
| S5 | `form.replied` answer shape for the launch question | `goal_start` authorization |
| S6 | Precompiled Solid/OpenTUI JS loads as a TUI plugin from a package `./tui` export and from a local plugins subdirectory; RPC events reach the TUI after reconnect | sidebar delivery |
| S7 | A plugin tool restricted to one agent via permissions (`goal_verdict` for `goal-verifier` only) | verifier isolation |
| S8 | Interrupt reason after a dismissed question or rejected permission | pause semantics |

## 10. Roadmap (sizes, no time estimates)

| Phase | Scope | Size |
|---|---|---|
| 0 Spikes | S1-S8 against 2.0.22 with a throwaway plugin | small |
| 1 MVP | contract schema + validator; `write-goal` v1 (interview, recon, validator, launch); server: lock, run store + ledger, loop on `execution.succeeded`, guards (ownership, interrupt, failure map, turns/wall/token/cost budgets with wrap-up, worktree-based stall, cooldown), context + compaction hooks, `goal_status/progress/claim/block/wait`, host-check verification with HOST VERDICT, `/goal new/start/pause/resume/status/abort`; TUI: sidebar card, footer pill, attention | large |
| 2 Trust + UX | read-only verifier with quote re-read, `human` criteria, `protect` enforcement, question deferral, children deferral with check-ins, live criteria, amendments, panel dashboard, composer banner, keymaps, restart UX, fixture-provider host tests, mutation contract | large |
| 3 Push the limits | relay mode (fresh session per plan step, seeded from contract + ledger + git log; the TUI follows via `ui.tabs.focus`), goal queues, a home-screen multi-goal board (`home.footer`), Claude Code and Codex launch adapters, headless runner | medium |

## 11. Open decisions for the owner

1. Where the plugin lives (new repo + npm package, inside this repo, or bundled in the skill with an installer).
2. V2-only (recommended) or V2 + V1 fallback.
3. Default verification mode (`host+verifier` recommended).
4. Whether to start with spikes + MVP, the skill alone, or design revisions.


---

## As built — v0.1.0-alpha.1 (2026-10-02)

Owner decisions that shaped the build: standalone public repo installed from git tags (no npm), write-goal skill bundled in it, OpenCode 2 only, `host+verifier` as the default verification mode, spikes before the MVP, and global install via `opencode plugin add github:…#<tag>` like a real user.

Where the code differs from the proposal above:

| Proposal | As built | Why |
|---|---|---|
| Budget required by the validator | **Budgets are optional**; a plugin-level backstop of 200 goal turns applies only when the contract sets no turn budget | Kimi write-goal and define-goal: never invent a budget; state-based stall and blocker guards are the real brakes |
| Session→goal index in `ctx.storage` | Run state lives only in the goal folder (`run.json`, `ledger.jsonl`, `evidence/`); the plugin scans `.opencode/goals/*/run.json` at setup | Simpler; `ctx.storage` is one global table shared across projects |
| `O_EXCL` lease for `--standalone` servers | **Not implemented** | One background server per user is the normal case; revisit if two servers drive one project |
| `goal_amend` tool | **Not implemented**; the owner edits goal.yaml and starts a new run | Scope for v0.1 |
| Continuation via `session.synthetic` or `prompt` | `ctx.session.prompt` with a persisted, native-format ascending message id (`msg_<12 hex><14 base62>`), `metadata.goal`, `resume: true` | S2 proved idempotency; native ids keep history ordering |
| Tail note "spliced just before the last user message" | Inserted before the **last user message of the turn** (the trigger), so it keeps one position for every step of the turn | Prefix cache stays warm across tool-call steps |
| Question deferral via `tool.hook` | `tool.execute.before` **throws** for `question` (when `autonomy.questions: defer`), for edits to `protect` globs, and for edits under `.opencode/goals/`; the model sees the message as the tool error | Verified in the host suite |
| Verifier with `goal_verdict` restricted to one agent | Hidden `goal-verifier` subagent (deny `*`, allow read/glob/grep/goal_verdict); `goal_verdict` carries `options.permission: "goal_verdict"`, every other agent gets a deny rule, and `execute` refuses any other agent; quotes are re-read with whitespace collapsed; child session removed after use | S7 |
| `/goal` output | Notices over RPC (toast / alert dialog in the TUI); **no transcript messages**, except one synthetic "Goal complete" message | A synthetic message landed inside the turn a command started |
| Session panel dashboard | **Not built yet**; `/goal status` and the palette open an alert dialog with the full status | Scope for v0.1 |
| Local plugin directory entry | Root files `server.ts`, `tui.tsx`, `rpc.ts` re-export `src/`; package `exports` point at the same files | OpenCode resolves `<dir>/server` for local directories and package exports only for installed packages |
| Verification of `human` criteria | `/goal approve C3` or the palette's "Goal: approve a criterion"; approving while `needs_review` re-runs verification | |

## As built — v0.2.0 (2026-10-03)

Built under the goal loop itself (runs `0ffe5ac6e001` and `10388d06d001`), with two council verdicts as decision records:

- **Contract integrity (council run `20261003T145323Z-a46b2ff9`, confidence high)** — extend the sha256 lock with **start-time rehearsal** (a check that cannot run refuses the lock; the unrunnable signature is shell exit 126/127 or a `zsh:`/`bash:` diagnostic — never a tool's stderr, so `grep missing-file` stays a legitimate red baseline) and an **owner-approved amendment path** (`/goal amend` propose → `/goal amend confirm` re-lock; generation-bound records under `evidence/`; prior evidence retained for unchanged criteria; the write guard covers stopped states; the integrity message names real paths). Both shipped.
- **Goal identity, versioning and lifecycle (council run `20261003T162655Z-800c52ca`, confidence high)** — **keep descriptive slug names** (hash/word names rejected 4-of-5: they sever the human's only identity channel permanently; identity is already bipartite — slug folder key + title in metadata); **supersession as append** (`supersedes: <slug>@<lock-prefix>`, predecessor flips terminal `superseded` and archives; approving a successor of a non-terminal predecessor is blocked without the owner's recorded acknowledgment); **archive is demote-never-delete** (`.opencode/goals-archive/`, registry keeps answering "was this ever a goal here?"); **admission-time existence + fuzzy similarity** before a new slug forms. All shipped. The scale benchmark (`spikes/scale-bench.ts`) forked the design: `slugs()` 13.8 ms and existence 12.2 ms at 5,000 goals (folders survive); full `list()` 157.6 ms (inconclusive band) — the derived machine-level registry (`~/.local/share/opencode/goal-registry.json`, `OCGOAL_REGISTRY` to override) is justified for status/list surfaces and existence must never route through full list builds.

| v0.2 change | As built | Why |
|---|---|---|
| Verifier reliability (T016) | Hardened prompt (exactly one `goal_verdict` call; sanctioned fenced-json fallback), `by:"verifier-fallback"` verdicts the host quote-re-reads identically, child transcripts persisted under `evidence/` | Run 0ffe5ac6e001's verifier died silently; a prose child can no longer kill a round |
| Live counters (T013) | `session.usage.updated` fires per message with cumulative totals on 2.0.22 (probed live); baseline = cumulative at goal start; persist+emit throttled to 1/s | The old handler updated memory only, freezing disk and TUI at the kickoff snapshot (`tokens: 1`) |
| Multi-line command warning (T021) | `parseContract` warns when a `command` check spans lines | The folded-scalar defect that made run 0ffe5ac6e001 C3 unrunnable |
| Registry (T026) | Machine-level derived index; update-on-persist with no-op skip; rebuild-by-scan parity is unit-pinned | Council 162655Z; existence survives archive and supersession |
| `/goal help` (T025) | Agent-forward guide from a pure builder (`src/server/help.ts`) | Commands with args, worker/owner split, storage, mid-run rules |
| CLEO link (T027) | Optional, CLI-first (`cleo doctor project-identity`, 2.5 s timeout) with `.cleo/project-context.json` fallback; ledgered as `cleo-linked` at start; absent CLEO records nothing | First-class for CLEO users, zero dependency otherwise; never reads `.cleo/*.db` |
| OpenCode DB reuse (T028) | **Spike verdict: read-only, not depended on.** The store's `project`/`project_directory` tables (16 projects, probed 2026-10-03, persisted in `docs/opencode-store-probe.md`) are the association layer we would join on, but the schema is internal to OpenCode — the registry stores its own file regardless | Council condition: don't reinvent, don't couple |
| Continuation notices (T041) | Continuations now `session.synthetic({id, description, resume:true})` — one notice row per turn in the transcript; prompt fallback retained | HANDOFF §9.5; all 8 original e2e scenarios pass unchanged |
| Untested paths (T040) | `test/host/paths.test.ts`: budget wrap-up, `goal_wait` timer, absent/diff e2e, human approval, compaction survival, `session.deleted`, provider degradation | HANDOFF §9.7; provider-error *injection* remains a harness gap (the protected harness has no failure capability) — recorded in dogfood-2 |
