# OpenCode goal plugins — landscape and OpenCode 2 ground truth

Date: 2026-10-02 · Host checked: OpenCode **v2.0.22** (commit 527f0b9, the owner's installed build) · Repos examined at HEAD on that date.

Evidence tags: **[SRC]** read in source (path:line) · **[DOC]** official doc · **[RUN]** executed · **[READ]** my reading of code, not executed · **[INF]** inferred, unverified.

Supporting reports (full citations, verbatim prompts): `research/opencode-plugin-api.md` (1,155 lines), `research/wr-goal.md`, `research/prior-art.md` in the session scratchpad.

---

## 1. Verdict in one table

| | martsallan/goal-opencode 0.3.1 | william-ricchiuti/OpenCode-goal-plugin 0.11.0 | @bybrawe/opencode-goal 1.3.44 (strongest found) |
|---|---|---|---|
| Loads on OpenCode 2.0.22 | **No** — V1 function export + V1 `{id, tui}` TUI; the V2 loader rejects both [SRC core/src/plugin/module.ts:60-115] | Yes — `{id, server, setup}` dual export; V2 path is a 1,140-line bridge onto V1 hook contracts | Yes — native V2 plus a V1 loader |
| Size | ~1.1k LOC TS | 7,156-line core + bridge; 490 tests [RUN] | ~16k LOC TS |
| Goal definition | free text `/goal <objective>` | free text + flags (`--success`, `--constraints`, budgets) | free text + flags compiled into requirements (`--check`, `--contains`, `--file`) |
| Turn trigger | V1 `session.status` idle | V1 idle; V2 `session.execution.succeeded` mapped to idle | V2 `session.execution.*` generations |
| Completion | self-attested `update_goal` + `::GOAL_DONE::` marker | text markers `[goal:evidence]`+`[goal:complete]` (primary); structured `goal_complete` tool; **optional** read-only verifier | host-run checks → contracts → read-only verifier with `{path, quote}` → host re-reads quotes |
| Budgets | none (only 3 tool-free turns → pause) | turns 10 / 15 min / 200k *context* tokens / optional cost; resume resets all | turns, tokens, time; stall = no real worktree change |
| UI | sidebar: objective, status, elapsed; re-reads a JSON file every second | none on V2 (toasts silently no-op); opt-in session-title status line | read-only plain-text block in `sidebar.content` via RPC |
| Write-goal / interview | none | none | none (flags only) |

**Neither target repo is a usable base for an OpenCode 2 build.** martsallan's does not load on V2. william-ricchiuti's works, but it is a V1 design carried across by adapter, and it inherits V1 limits that V2 no longer has. Both are worth mining for mechanisms (§3, §4).

---

## 2. OpenCode 2 plugin system — what is true at 2.0.22

V2 is a new npm scope (`@opencode/cli`, `@opencode/plugin`, `@opencode/sdk`), tagged 2026-09-11; 1.x (`@opencode-ai/*`) still ships (1.18.34 on 2026-09-30). **https://opencode.ai/docs/plugins/ still documents V1**; V2 docs live at `opencode.ai/v2/docs/build/plugins` (+ `/rpc`, `/cli`, `/migrate-v1`) and contain errors noted below.

### 2.1 Shape and loading
- Server module: `export default { id, setup(ctx) => cleanup? }` (or `{id, effect}`) [SRC plugin/src/promise/plugin.ts; module.ts:60-73]. Anything else → `state: failed`; other plugins still load. **V1 plugins do not run on V2**; one package can carry both (`{...v2, server: v1}`) but hooks are not translated — two implementations.
- `setup` is awaited and plugins activate sequentially → never block inside `setup`.
- `ctx` = `app, location, options` + domains `agent aisdk command event generate integration mcp model permission plugin provider reference rpc session shell skill storage tool vcs websearch worktree` [SRC promise/plugin.ts]. **No raw client, no `$`, no log API, no `directory`** — use `ctx.location.directory`.
- Config key is `plugins` (V1 `plugin` is normalized). Local plugin files hot-reload; a change re-runs `setup` for that plugin and every later one. A project's plugins are evicted after **60 min without session activity** (running executions are interrupted with reason `inactivity`).
- One background server per user, one plugin instance per location. The service's cwd is `$HOME` and it has **its own environment** (PATH may differ from the terminal) [INF from report §13].

### 2.2 The loop signal
- Busy periods emit `session.execution.started` then exactly one of `succeeded`, `failed {error}`, `interrupted {reason: user|shutdown|superseded|inactivity}` [SRC schema/src/session-event.ts:243-261].
- **`session.idle` / `session.status` are declared but never emitted in 2.0.22** — the docs' example never fires; plugins that wait on it (e.g. @beremaran/opencode-goal) never continue.
- `ctx.event.subscribe({signal})` is an async iterable [SRC wr-goal v2-bridge.js:948]. Payload is in `event.data`. **Events are not filtered by location**: every instance sees every project's events — filter on `event.location.directory` and on owned sessions; skip sessions with `parentID` [SRC trace, report §5; runtime-unverified].
- Rich live events for a dashboard: `session.tool.called/success/failed/progress`, `session.step.*`, `session.usage.updated {cost, tokens}`, `session.compaction.started/ended`, `session.metadata.updated`, `session.agent.selected`, `form.created/replied/cancelled`, `permission.asked/replied`.

### 2.3 Driving a session
- `ctx.session.prompt({sessionID, id?, text, files?, agents?, skills?, metadata?, delivery?: "steer"|"queue", resume?})` returns on **admission**, not completion. `id` makes retries idempotent; `metadata` is stored on the message (tag continuations); `resume:false` ≈ V1 `noReply`; `skills:[{id}]` attaches a skill.
- **No agent/model field on prompt** — `switchAgent`/`switchModel` first, and the switch persists (this is why wr-goal flips the user's agent before every continuation).
- Esc → `interrupt({resume:true})` still runs pending *steer* prompts → admit a continuation only after `succeeded`; never pre-queue.
- No built-in doom-loop guard; agent `steps` resets on every input → **the plugin owns all budgets**.
- `ctx.session` also has `create({parentID})`, `get`, `remove`, `update({metadata})` (replaces whole object), `wait`, `context`, `synthetic({text, resume})`, `generate`, `compact`, `interrupt`. No list/status read.

### 2.4 Hooks that matter
- `session.hook("context", e => …)` runs before **every** model request with mutable `system`, `messages`, `tools`, `options`; never persisted → the compaction-proof place to keep a goal alive. The built-in Plan plugin uses exactly this, splicing near the tail "so the cached prefix stays warm" [SRC core/src/plugin/plan.ts:58-79].
- `session.hook("compaction")` (can supply the summary), `retry` (decide backoff), `title`, `model.request`, `http.*`.
- `tool.hook("execute.before"|"execute.after")` — can rewrite input/result → enforce protected paths, defer `question`.
- `permission.hook("evaluate")` — can change a permission effect.
- `agent.transform(e => e.update(id, fn))` **upserts** → a plugin can define hidden, permission-restricted agents.
- `skill.transform(e => e.add({name, description, content}))` → a plugin can ship a skill (a SKILL.md with the same id overrides it).
- `command.transform(e => e.add({name, description, execute({sessionID, prompt, delivery})}))` → the command runs **plugin code**; it is not forced through a model turn (V1's biggest UX tax). A config/markdown command with the same name shadows it.

### 2.5 Tools
- **Plugin tools default to Code Mode** (only reachable inside the built-in `execute` tool). Tools the model must call by name need `options: { namespace: "goal", codemode: false }` → native `goal_<name>` [SRC core/src/tool/plugin/question.ts uses `codemode:false`].
- Schema: JSON Schema, Effect Schema or Standard Schema (Zod 4). Result `{content?, output?, metadata?}`. Context `{sessionID, agent, messageID, id, signal, progress()}`; no permission-ask helper. Plugin tool calls render as a generic one-line row.
- **V2 has no todo tool** (built-ins: edit, file-diff, glob, grep, mcp-resource, patch, question, read, shell, skill, subagent, webfetch, websearch, write) → a goal's step checklist must be the plugin's own.

### 2.6 The `question` tool (the write-goal interview's ask tool)
`{questions:[{question, header ≤30, options:[{label, description}], multiple?}]}`; a "Type your own answer" option is added automatically; its description asks for the recommended option first with "(Recommended)" [SRC question.ts:12-21]. Backed by forms (`form.replied` carries `{id, sessionID, answer}` [SRC schema/src/form.ts:171]). Allowed for build/plan/custom agents; denied for `general`/`explore` subagents. Dismissal ends the step. Same contract as Claude Code's `AskUserQuestion` → one skill text can drive both.

### 2.7 TUI plugins (the sidebar)
- Separate module `@opencode/plugin/tui`: `Plugin.define({id, setup(context)})`; loaded from a `tui` entry beside the server entry (package export `./tui`), from subdirectories of `plugins/`, or `cli.json` `plugins`. `tui.json` is gone. Solid 1.9.15 / OpenTUI 0.5.14, provided by the host. Ship precompiled JS (bybrawe uses `createElement/insert/setProp` from `@opentui/solid` to avoid a runtime JSX compiler).
- **10 slots** [SRC plugin/src/tui/context.ts:191-202]: `app`, `home.footer`, `home.footer.status`, `prompt.footer`, `prompt.footer.status`, `prompt.footer.file`, `session.composer.top`, `session.panel` (named panels, `presentation: panel|fullscreen`, focus), `sidebar.content`, `sidebar.footer`. Claims: `prepend|append|before|after|replace`.
- Sidebar: 42 columns, auto-shown only above 120 columns, never for child sessions, toggled with `<leader>b` → **put a one-line status in `prompt.footer.status` too**.
- `context` surface: `client` (full SDK incl. `client.rpc(Def)`), `data` (reactive caches + `on(type)`/`listen`; `session.status(id)`, `session.cost(id)`, `session.form.*`), `storage.store()` (durable, live-synced across TUIs) / `memory()`, `ui.dialog` (alert/confirm/prompt/select), `ui.toast`, `ui.panel.open(name)`, `ui.router.register(page)`, `ui.tabs` (busy/attention), `keymap.layer()`, **`attention.notify({message, notification, sound: done|question|error…, when: blurred})`** (desktop notification + sound), `theme`, `markdown`.
- Server↔TUI: `ctx.rpc.register(Rpc.define({id, methods, events}), handlers)` + `registration.events.emit(...)`; TUI `context.client.rpc(Def)`. RPC events are live-only → re-sync on `server.connected`. Works when the server is remote; **web and desktop clients do not load TUI plugins** (server features still apply there).

### 2.8 Skills
Discovered from `skill/`/`skills/` under `~/.config/opencode` and project `.opencode/`, plus `~/.claude/skills`, `~/.agents/skills`, project `.claude/skills`, `.agents/skills`, and config `skills`. Id = directory name; only `name`, `description`, `metadata["opencode/autoinvoke"]` are read. Invoked by `skill({id})` or `@<id>`. → a skill in this repo symlinked to `~/.agents/skills` is visible to OpenCode, Claude Code and Codex alike.

### 2.9 V2 docs errors at 2.0.22
`ctx.session.command` takes `{name, text, …}` and returns nothing; `interrupt` takes `{resume}` not `{continue}`; the `session.idle` example never fires; the skills `slash` field is unimplemented. wr-goal's "no session delete on V2" note is stale: `session.remove` and `create({parentID})` exist in 2.0.22.

---

## 3. martsallan/goal-opencode — teardown

**Mechanics** [READ src/index.ts, src/tui.tsx, src/core.ts]
- One goal per session in `$XDG_STATE_HOME/goal-opencode/scope_<sha16(worktree)>/sessions.json`; status `active|paused|complete`, pause reason `interrupt|command`, elapsed time. On load, `active` goals are demoted to `paused(interrupt)`; the next user message auto-resumes.
- Loop: on `session.status: idle` it calls `client.session.prompt` with a tiny synthetic *ignored* trigger part; `chat.message` blanks it and `experimental.chat.messages.transform` swaps in the full continuation prompt at request time — the transcript stays clean while the model sees the full brief. (Good trick; V2's `context` hook does this natively.)
- Prompt: a near-verbatim port of Codex's continuation + completion-audit text, objective XML-escaped inside `<untrusted_objective>`.
- Stagnation: 2 tool-free continuations → "recovery" prompt; 3 → pause. Plan agent → skip continuation. Compaction hook pushes the objective into the summary.
- TUI: `sidebar_content` slot (V1 API) rendering objective (200 chars), status, ticking elapsed; it re-reads and parses the whole state file every second per sidebar instance. Command-palette dialog.

**Defects and limits**
1. **Dead on the owner's OpenCode**: both entrypoints use V1 shapes the 2.0.22 loader rejects; it also listens to `session.status`, which V2 never emits.
2. **Completion logic is inverted** [READ src/index.ts:652-684]: the `::GOAL_DONE::` auto-clear only runs while the goal is still `active`. After a legitimate `update_goal` the goal is already `complete`, so it is never cleared (the README says it is), and a model that prints the marker *without* calling the tool deletes the goal with no record. The tool gate is bypassable.
3. No budgets: a model that keeps calling tools loops forever (tool use resets the stagnation count).
4. Self-certified completion; the audit is prompt-only.
5. Installs `SIGINT/SIGTERM/SIGHUP` handlers in the host process and re-raises the signal — risky in someone else's process.
6. Every bare `/goal` subcommand is aborted by throwing a sentinel error out of `command.execute.before`.
7. Sidebar shows no progress, criteria, budget or last activity; polling a file every second.

**Worth keeping:** hidden trigger + request-time prompt swap; objective-as-untrusted-data; recovery-mode prompt; interrupt → pause with auto-resume on next message.

---

## 4. william-ricchiuti/OpenCode-goal-plugin — teardown

**Strengths** (tests 490/490, behaviour benchmark 100/100 [RUN in a scratch copy])
- **Durable continuation claim** persisted *before* prompting (`{runId, compactionEpoch, sourceAssistantMessageID}`) so duplicate idles, restarts or compaction never double-send [SRC GP:4876-5038].
- `goalId` / `runId` epochs re-checked after every `await`; objective edits rotate `runId` and invalidate stale approvals.
- Recover-paused after restart; ledger-first terminal writes (JSONL ledger beside each session shard).
- **Byte-stable system block** — learned from a volatile prompt that busted the prefix cache (~$12 in 8 min, 0.4.1); volatile budget numbers only in the continuation.
- Grace-window stall gates with counters that *decrement* on success (alternating good/bad turns can't dodge them).
- Plan-mode holds (goal recorded but not driven) at creation, every command, tool call and idle.
- Optional hidden `goal-verify` agent: default-deny, read/glob/grep only, fail-closed, 120 s timeout, cloned snapshot.
- Serious quality bar: 90-mutant mutation contract, generated lifecycle model test, deterministic localhost provider driving a real `opencode serve`, tarball contracts, CI on 3 OSes.

**Weaknesses**
1. Primary completion path is **text-marker parsing**; any non-empty line counts as a "concrete blocker" ("Done." is accepted [RUN]). Verifier is off by default and **cannot run tests**; a rejection pauses without feeding the reason back.
2. Budgets: defaults 10 turns / 15 min; the "token" budget is peak *context size* (resets on compaction), not spend; every resume resets every budget → no lifetime cap.
3. Every `/goal status|list|pause` is a **paid model turn** that may paraphrase the result.
4. **No real UI on V2** — the bridge client is `{app:{}}`, so lifecycle and audit notices silently no-op; only an opt-in session-title line.
5. V2 bridge side effects: calls `switchAgent` before every continuation (flips the user's agent); verifier child sessions were never deleted (fixable now).
6. Complexity: 7k-line monolith with Proxy/AsyncLocalStorage state; a hard-link lease with a 2038-dated guard file; filesystems without hard links disable goal features.
7. No plan/step model ("checkpoints" = first 280 chars of the last reply); default pause on every human message; live-provider evidence mostly from v0.6 on OC 1.17.15; V2 compaction/interrupt/blocker paths not live-verified.

**Most instructive bugs from its CHANGELOG:** volatile system prompt busting the cache (0.4.1); summing per-message tokens inflating budgets 5-10× (0.1.13) and replayed `message.updated` re-inflating them (0.4.2); compaction stalls and duplicate compaction events (0.8.x); Plan guard failing open on a session's first command (0.10.0); state following `process.cwd` and breaking daemon mode (0.5.0); tool path bypassing the auditor (0.4.3); tag injection via checkpoints (0.4.4); quoted markers producing false approvals (0.6.1); stale approvals surviving objective edits (0.11.0).

---

## 5. Prior art that should shape ours

1. **Self-declared completion is the dominant failure.** Codex `/goal` users report premature completion while the model itself says work remains (#44829, ~16.9M tokens) and objectives rewritten from the assistant's own recommendations (#35709). Research: false success is 45-76% of failures on some benchmarks; transcript-only judges anchor on confident closing language (arXiv 2606.09863); agents oversold success in 34.7% of 8,600 real sessions (Transluce, Aug 2026). Anthropic's harness work moved to a separate, skeptically tuned evaluator with a "sprint contract" agreed before code is written.
2. **Claude Code `/goal`** = Stop hook + small-model judge with three verdicts (not met / met / **impossible**) whose reason is fed back; it defers while subagents/background shells run (check-ins at 30 min, backed off, ≤3 idle check-ins); error taxonomy clear/retry/pause. Its judge has no tools, so it can only judge what was surfaced (#94041 stale re-fires); an `AskUserQuestion` blocked a goal overnight (#61337).
3. **Progress must be measured by state change, not activity.** Codex counted any assistant text as activity and looped ~288 turns after compaction (#47707). Good detectors: worktree change, criterion transitions, same-blocker key ×3.
4. **Waiting is the cost center.** Codex continues 20-50 ms after idle; 1.4% of goal sessions consumed 49% of input tokens, mostly polling (#44909). Fix: model-chosen waits with a stated reason (Claude Code `/loop` `ScheduleWakeup`) and deferral on background work.
5. **Compaction is where goals die** (Codex #32922, #49022). Fix: render the goal from disk into the request every turn; never rely on history.
6. **Strongest verifier pattern** (bybrawe, loopd, goalx): host-run checks → read-only verifier returning a verdict per requirement with `{path, quote}` → host re-reads quotes → failures returned to the worker as a structured **HOST VERDICT**.
7. **Goal authoring has converged** on: outcome (not activity), binary criteria each with a literal check and named evidence ("a criterion that cannot fail is not a criterion" — oh-my-openagent `define-goal.md`), invariants/negative space ("SHALL CONTINUE TO", "no other test file is modified"), ≥1 non-goal (BMAD), tagged vetoable assumptions, user-set budgets ("never invent a budget"), a stop line and escalation rules. User's verbatim words stay authoritative (js-goal removed model drafting because it distorted intent).
8. **Interview technique:** Pocock's `grilling` — design tree, ask the whole *frontier* (decisions whose prerequisites are settled) per round, recommended answer on every question, facts via subagents and decisions via the user, done when the frontier is empty; spec-kit `/clarify` — ≤5 questions ranked by impact × uncertainty, 2-5 options, rewrite the affected section after every answer; ImpossibleBench — an explicit "abort and flag" channel cut cheating from 54% to 9% (GPT-5).

## 6. Gaps nobody fills (our opening)

- A **structured goal contract written by an interview** before the loop (everyone takes free text or flags).
- **Host-verified, live criteria scoreboard** visible while the goal runs (bybrawe verifies only at claim time and shows plain text).
- A **rich V2 TUI**: sidebar card + footer pill + composer banner + full panel + desktop attention, all RPC-fed.
- **Zero-cost waiting** (`goal_wait`) and deferral on children, instead of polling turns.
- **Contract integrity**: lock the contract by hash; protect test/oracle paths; agents can propose amendments but never apply them.
- **Portability**: one goal document runnable by our OpenCode plugin and rendered into Claude Code `/goal` or Codex `/goal` conditions.
