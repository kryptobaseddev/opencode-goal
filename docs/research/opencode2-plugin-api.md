# OpenCode plugin API: ground truth for a V2 "goal" plugin (as of 2026-10-02)

**Scope.** A reference for designing an OpenCode goal plugin (persistent objective, auto-continuation loop, completion
verification, live TUI sidebar) and a companion `write-goal` SKILL.md. Nothing was built and nothing was run on a live host.

**Sources**
- Canonical repo: `github.com/anomalyco/opencode`. The old `sst/opencode` URL resolves to the same repo; both HEADs were
  `108b988` on 2026-10-02.
- Primary source: a shallow clone at tag **v2.0.22** (commit `527f0b9`, 2026-10-02 04:22 UTC), the version installed at
  `~/.opencode/bin/opencode`. Paths are repo-relative at that tag unless marked `@v1.18.34`, which refers to a sparse
  clone of the V1 line at `scratchpad/repos/opencode-v1`.
- V2 docs source: `services/www/src/docs/content/` (abbreviated `docs/` below). It is served at
  **https://opencode.ai/v2/docs/...**, with base `/v2/` set in `services/www/astro.config.ts:7`.
  - Example: https://opencode.ai/v2/docs/build/plugins
  - The URL from the brief, **https://opencode.ai/docs/plugins/**, still documents the **V1** API (`@opencode-ai/plugin`,
    `plugin` array). It only carries a "New OpenCode v2 is now available →" banner. VERIFIED-DOCS (fetched 2026-10-02).
  - `packages/web/src/content/docs/` is that V1 site's source.

**Tags.** **VERIFIED-SOURCE** (VS) = read in code at the cited line. **VERIFIED-DOCS** (VD) = V2 docs source or a live page.
**INFERRED** (INF) = reasoning, not directly proven.

**Layout of this file**
- §0: the executive summary, design implications, docs-vs-source discrepancies, and open items.
- §01: core (Q1, Q2, Q13 reload and instances).
- §02: session (Q3, Q4, Q8, Q10, Q11, Q12).
- §03: TUI and tools (Q5, Q6, Q7, Q9, Q13 clients).

| Question | Where |
|---|---|
| Q1 What V2 is, V1 compatibility, dual packages | §01 §1 |
| Q2 Server plugin shape, ctx, hooks, loading | §01 §2 |
| Q3 Event bus | §02 Q3 |
| Q4 Driving a session | §02 Q4 |
| Q5 Custom tools | §03 Q5 |
| Q6 Slash commands | §03 Q6 |
| Q7 TUI plugins | §03 Q7 |
| Q8 Ask-the-user / question tool | §02 Q8 |
| Q9 Skills | §03 Q9 |
| Q10 Agents and subagents | §02 Q10 |
| Q11 Persistence | §02 Q11 + §01 §2.6 |
| Q12 Compaction | §02 Q12 |
| Q13 Gotchas | §01 §3 + §03 Q13 |

---

## 0.1 Executive summary (most decision-relevant first)

1. **Two release lines ship side by side.** VS.
   - V2 is a new npm scope: `@opencode/cli`, `@opencode/plugin`, `@opencode/sdk`. The `v2.0.0` tag is 2026-09-11; the latest
     is `v2.0.22` (2026-10-02).
   - V1 keeps `opencode-ai` / `@opencode-ai/plugin`, still releasing. The latest is **1.18.34** (2026-09-30).
   - V2 tags are not published as GitHub Releases, so the "latest release" on GitHub is still 1.18.34.
   - Bun 1.4.2 compiles the installed binary, so plugins run under **Bun**, not Node. A Node build exists only for
     non-latest channels.
   - §01 §1.1–1.2.
2. **V1 plugins do not run on V2.** VS + VD.
   - The V2 loader only accepts a default export `{id, setup}` (Promise) or `{id, effect}` (Effect). Anything else fails
     with "Plugin must export a default definition with an id and an effect or setup function."
   - The failure is recorded as `state: failed`, and the other plugins keep loading (`packages/core/src/plugin/module.ts:60-115`).
   - One package can serve both lines by default-exporting `{ ...Plugin.define({id, setup}), server() }`. V2 ignores
     `server`, and V1 ≥1.18.x calls it. Hooks are not translated, so you maintain two implementations.
   - §01 §1.4–1.6, which also lists the full V1 `Hooks` interface in case you want a V1 fallback.
3. **There is no `event`/`chat.*`/`config` hook in V2.** VS.
   - The ctx is a domain client: `app, location, options, agent, aisdk, command, event, experimental, integration, mcp,
     model, generate, permission, plugin, provider, reference, rpc, session, shell, skill, storage, tool, vcs, websearch,
     worktree`.
   - It has no `client`, no `$`, no log API, and no `directory`/`worktree` fields.
   - Hooks:
     - `ctx.session.hook`: `prompt`, `context`, `compaction`, `generate`, `title`, `model.request`, `http.*`,
       `experimental.ws.*`, `retry`
     - `ctx.tool.hook`: `execute.before`, `execute.after`
     - `ctx.permission.hook`: `evaluate`
     - `ctx.shell.hook`: `create.before`
     - `ctx.aisdk.hook`: `sdk`, `language`
   - §01 §2.2–2.3.
4. **The loop signal is `session.execution.succeeded`.** VS.
   - Events are `{id, created, type, data, location?, metadata?, durable?}`. The payload is in **`data`**, not `properties`.
   - Each busy period emits one `session.execution.started`, then exactly one of `succeeded`, `failed {error}`, or
     `interrupted {reason: "user"|"shutdown"|"inactivity"|"superseded"}`.
   - **`session.idle`/`session.status` are declared but never emitted on 2.0.22.** The docs' `session.idle` example never fires.
   - `message.updated`, `message.part.updated`, `session.error` and `session.compacted` are not in the public stream.
   - Esc in the TUI produces `interrupted {reason:"user"}`.
   - A rejected permission or a dismissed question probably produces `interrupted {reason:"shutdown"}` (INF). **Treat
     every `interrupted` as "pause the goal".**
   - Retryable provider errors are not terminal.
   - §02 Q3.
5. **Driving a session.** VS.
   - `ctx.session.prompt({sessionID, id?, text, files?, agents?, skills?, metadata?, delivery?: "steer"|"queue", resume?})`
     returns at admission; it does not wait for the turn.
   - There is **no agent/model field on a prompt**. Call `ctx.session.switchAgent`/`switchModel` first; the switch persists.
   - Pass `id` for idempotent retries. `resume:false` is V1's `noReply`. `metadata` persists on the message, so use it to
     tag continuation prompts.
   - **Gotcha:** Esc sends `interrupt({resume:true})`, which still runs *pending steer* items, while queued items stay
     parked until the next wake. Admit continuation prompts only after a terminal `succeeded`, and do not pre-queue them.
   - There is no doom-loop guard. Agent `steps` resets on every new input, so the plugin must own its budgets.
   - §02 Q4.
6. **Plugin event subscriptions are not location-filtered.** VS (traced), not runtime-tested.
   - The server is one shared background service per user. Each project, worktree or workspace (a "location") gets its own
     plugin instance, and **each instance's `ctx.event.subscribe()` sees every location's events**.
   - Hooks are per location but fire for child sessions too.
   - Filter on `event.location?.directory` and on root sessions the plugin owns. Children carry `parentID` on
     `session.created` and on `Session.Info`.
   - §01 §3, §02 Q3/Q10.
7. **Persistence.** VS.
   - `ctx.storage` is a JSON KV in the global SQLite DB (`~/.local/share/opencode/opencode.db`), scoped **only by plugin
     id**: shared across projects and processes, with no CAS. Key goal state by `projectID/sessionID`.
   - `ctx.session.update({sessionID, metadata})` replaces the session's whole metadata object and emits
     `session.metadata.updated`, which is a good low-friction channel for TUI state.
   - TUI storage (`context.storage`) is a separate per-client file store.
   - §02 Q11, §01 §2.6.
8. **Compaction.** VS.
   - Auto-compaction runs inside the step and the loop continues on its own. There is no autocontinue hook to manage.
   - Keep the goal alive by pushing it into `event.system` from `ctx.session.hook("context")`, which runs on every
     agent-loop request and is not persisted, so compaction cannot drop it.
   - Also push it from `ctx.session.hook("compaction")` so the summary's built-in `## Objective` section keeps it.
   - The built-in Plan plugin (`packages/core/src/plugin/plan.ts`) is a working reference.
   - §02 Q12.
9. **Tools are Code Mode by default.** VS.
   - Plugin tools default to `codemode: true`. They are then reachable only inside the built-in `execute` tool, and only
     appear in its catalog (~2,000-token budget) if pinned or found by search.
   - Goal tools the model must call by name should set `options: { namespace: "goal", codemode: false }`, which makes them
     native tools named `goal_<name>`.
   - Return shape is `{content?: string | Content[], output?, metadata?}`. There is no `title` and no `ask()`/permission
     helper. The context provides `sessionID, agent, messageID, id, signal, progress()`.
   - In the TUI, plugin tools render as a generic one-line row, and `metadata` is not shown.
   - §03 Q5.
10. **Commands.** VS.
    - Register `/goal` with `ctx.command.transform(e => e.add({name, description, execute({sessionID, prompt, delivery})}))`.
      The executor must call `ctx.session.prompt` itself and can attach `skills: [{id: "write-goal"}]`.
    - **Config/markdown commands with the same name override plugin commands**, because they load after user plugins.
    - `opencode run` sends `/goal …` as plain text (no command routing).
    - §03 Q6.
11. **TUI plugins are a different module.** VS.
    - Import `@opencode/plugin/tui` (injected at runtime) and default-export `Plugin.define({id, setup(context)})`.
    - Three ways it gets loaded:
      - automatically from a `tui` entry next to the server entry (dir `tui.tsx`, or package export `./tui`)
      - from a subdirectory of `plugins/` (loose files are ignored)
      - from `~/.config/opencode/cli.json` `plugins`
    - `tui.json` is gone in V2.
    - **There are 10 slots:** `app`, `home.footer`, `home.footer.status`, `prompt.footer`, `prompt.footer.status`,
      `prompt.footer.file`, `session.composer.top`, `session.panel`, `sidebar.content`, `sidebar.footer`.
    - The sidebar is 42 columns wide and auto-shows only above 120 columns. It is never shown for child sessions, and
      `<leader>b` toggles it. Use `session.panel` for a richer view.
    - The server↔TUI channel is **plugin RPC**: `ctx.rpc.register(Def, handlers)` plus `events.emit` on the server, and
      `context.client.rpc(Def)` plus `.events.on` in the TUI. Events are live-only, so re-sync on reconnect.
    - Web and desktop do not load TUI plugins, but server plugins still apply there.
    - Versions: OpenTUI 0.5.14, Solid 1.9.15.
    - §03 Q7.
12. **Ask-the-user tool.** VS.
    - A built-in native tool `question` exists. Input:
      `{questions: [{question, header (≤30 chars), options: [{label, description}], multiple?}]}`.
    - It adds a free-text "Type your own answer" option automatically. Its own description recommends putting the
      recommended option first with "(Recommended)".
    - It is backed by **forms** (`form.created/replied/cancelled` events) and gated by the `question` permission.
    - It is allowed for build, plan and custom agents, denied for the `general`/`explore` subagents, and works from a
      custom subagent. The form renders in the root session's composer.
    - A server plugin has **no form API**. A TUI plugin can call `context.client.session.form.*` (create is INF).
    - §02 Q8.
13. **Skills.** VS.
    - Discovered from:
      - `skill/` or `skills/` under `~/.config/opencode` and each project `.opencode/`
      - `~/.claude/skills`, `~/.agents/skills`, and the project `.claude/skills` / `.agents/skills`
      - config `skills` entries
    - The id is the directory name. Only `name`, `description` and `metadata["opencode/autoinvoke"]` are read from the
      frontmatter.
    - The tool is `skill({id})`. The user attaches a skill with `@<id>` in the composer.
    - Skill files override plugin-registered skills that use the same id.
    - §03 Q9.
14. **Lifecycle.** VS.
    - Local plugin files are hot-reloaded. A change re-runs `setup` for the changed plugin **and every plugin after it**.
    - `setup` is awaited and plugins activate sequentially, and prompt admission waits for activation. Never `await` a
      long-running loop in `setup`.
    - A location's plugins are evicted after 60 minutes without session events, and running executions there are
      interrupted with reason `inactivity`.
    - Locations load lazily after a service restart.
    - The service's cwd is `$HOME` and it has its own env. Use `ctx.location.directory`, never `process.cwd()`.
    - `--standalone` gives one server per TUI on the same DB with no execution lease, so a loop driver needs its own lease.
    - §01 §2.1, §3.

## 0.2 Design implications for the goal plugin (INFERRED from the facts above)

- **Package shape.**
  - Use one directory or package with an entry plus `tui.tsx` and `rpc.ts`. For a package that is `exports: {".", "./tui", "./rpc"}`.
  - Keep the V1 fallback optional, via the `server()` dual export.
  - In local plugins, avoid runtime imports of `@opencode/plugin`/`@opencode/plugin/rpc`. `Plugin.define` and
    `Rpc.define` are identity functions (`packages/plugin/src/promise/plugin.ts:56-65`,
    `packages/schema/src/rpc.ts:54-60`), so export plain objects and use `import type`.
- **Loop driver.**
  1. In `setup`, start a non-blocking `for await (ctx.event.subscribe({signal}))` with a resubscribe-on-error wrapper, and
     return a cleanup that aborts it.
  2. On `session.execution.succeeded` for a root session that owns an active goal, in the plugin's location, and not
     paused:
     - check budgets (iterations, time, tokens via `session.step.ended` cost/tokens)
     - run completion detection
     - `prompt({id: deterministic per iteration, text: continuation, delivery: "queue", metadata: {goal: {id, iteration}}})`
  3. Pause on any `interrupted` or `failed`.
  4. Rebuild state from `ctx.storage` and `Session.Info.outcome` in each `setup`, because reloads and evictions happen.
- **Completion verification.** `ctx.generate.text({model, prompt})` or `ctx.session.generate({sessionID, prompt})` gives
  an out-of-band judge that adds nothing to the transcript. A verifier subagent is the alternative: create it with
  `ctx.agent.transform` (`update` upserts) and run it in a child via `ctx.session.create({parentID})`, then `remove` it.
- **Goal persistence.** Push the goal block into the `context` hook (system, every request) and the `compaction` hook.
  Mirror a compact status into `Session.Info.metadata` for clients, and put the full state in `ctx.storage`.
- **Sidebar.** Read `context.data.session.get(id).metadata` plus `data.on("session.metadata.updated")`, or use RPC
  methods/events. Render `sidebar.content`, plus a `session.composer.top` banner and an optional `session.panel`.
- **`write-goal` skill.** Instruct the agent to call the built-in `question` tool (selectable options, recommended first),
  then the plugin's native `goal_*` tool (`codemode: false`). The `/goal` command executor can attach the skill.

## 0.3 Docs vs source discrepancies at 2.0.22 (VS, unless noted)

1. `docs/build/plugins/migrate-v1.mdx:305` uses `event.type === "session.idle"`, which is never emitted.
2. `docs/build/plugins/index.mdx:765` gives `ctx.session.command({sessionID, command, arguments})`. The real payload is
   `{sessionID, name, text, files?, agents?, skills?, delivery?}` and it returns no content
   (`packages/protocol/src/groups/session.ts:417-434`). The live page has the same bug.
3. `docs/build/plugins/index.mdx:773` gives `interrupt({sessionID, continue})`. The real key is `resume`, and the call
   returns `{interrupted: boolean}`.
4. `docs/skills.mdx:115-141` documents `slash`/`metadata.opencode/slash`, but nothing in the source parses them.
5. The CLI plugin docs suggest OpenTUI peers `>=0.5.8`, while `packages/plugin/package.json` declares `>=0.5.14`.
6. The Code Mode docs say `fetch` is unavailable, but the tool description says it is available
   (`packages/core/src/codemode/tool.ts:64`).
7. The docs give a 1.18.29 floor for the dual V1/V2 export. The V1 loader code is identical back to at least 1.18.10, so
   the floor is probably lower (INF).
8. Several community-plugin claims (wr-goal, written against 2.0.16) are outdated on 2.0.22:
   - `ctx.session.remove` exists.
   - `session.create` accepts `parentID`.
   - A configured local directory is loaded from disk, not installed from npm.
9. The user's Orca plugin comment ("loader rejects the module unless the default exposes `server()`") describes the
   **V1 1.18.x** loader (`must default export an object with server()`, `packages/opencode/src/plugin/shared.ts@v1.18.34`).
   It does not describe V2.

## 0.4 The user's local files (read-only; no secrets printed)

- **`~/.config/opencode/plugins/orca-opencode-status.js` and `orca-opencode2-status.js`** (VS).
  - They are not a V1-shape and a V2-shape pair. Both are the **same dual V1+V2 plugin** (1,204 lines each). `diff` shows
    exactly three changed lines:
    - the hook URL `/hook/opencode` vs `/hook/opencode2`
    - the `ORCA_OPENCODE_AGENT` gate value
    - the `id`
  - Each default-exports `{id, server, setup}`.
  - The V2 path (`setupOpenCode2Status`, around line 1103) is a useful real-world reference. It:
    - registers `ctx.session.hook("prompt")`
    - consumes `ctx.event.subscribe()`
    - maps V2 events back onto V1 names:
      - `session.execution.started` → busy
      - `session.execution.succeeded/failed/interrupted` → idle
      - `form.created` → `question.asked`
      - `permission.asked.data.action/resources` → V1 `permission/patterns`
    - wraps `ctx.session.get`'s unwrapped result back into `{data}`.
  - V2 auto-loads both files, because auto-discovery accepts loose `.js` files under `~/.config/opencode/plugins/`
    (`packages/core/src/plugin/source-directory.ts:7-33`).
  - INF: their `process.env.ORCA_OPENCODE_AGENT` gate reads the **background service's** environment, not the terminal's
    (§01 §3).
- **`~/.config/opencode/opencode.jsonc`**: keys are `$schema` and `mcp.servers` (13 named servers). That is already the
  V2 `mcp.servers` shape. There is no `plugin`/`plugins` key, so plugins come only from auto-discovery.
- **`~/.config/opencode/cli.json`**: `$schema` and `theme.name` only, with no `plugins`.
- `service.json` exists and was not read.
- Skills directory: `~/.config/opencode/skills/` exists and is a V2 discovery path.

## 0.5 Could not verify (no live host was exercised)

- Runtime confirmation that plugin event subscriptions are unfiltered across locations. The source trace is strong; it
  needs a two-project smoke test.
- What `interrupted.reason` is after a permission rejection or a dismissed `question` (inferred `"shutdown"`).
- The exact model-visible error when a Promise plugin throws in `tool` `execute.before` or in a tool executor. A throw is
  a defect, so the model sees a generic failure.
- Whether a local server plugin can import `@opencode/plugin` at runtime without installing it (Bun auto-install might
  mask this). Avoid the runtime import.
- That a TUI plugin can create forms via `context.client.session.form.create`. The endpoint and client method exist, but
  it was not exercised.
- Headless `opencode run`: a continuation admitted on `execution.succeeded` races `run`'s exit. It may execute in the
  background service without being printed.
- When the V2 TUI plugin API first shipped, and the "1.16 keymap migration". Release notes show the
  `api.command` → `api.keymap` move at 1.14.42/1.14.45, and a V2 server-API preview (`@opencode-ai/plugin/v2/*`) at
  1.17.10. No 1.16-specific keymap note was found.
- Whether a plugin directory that both server and TUI discovery find (for example `.opencode/plugins/goal/` with a
  `tui.tsx`) is de-duplicated by id in the TUI (INF: probably yes, by plugin id).

---

## 0.6 Addendum: prior-art claims checked against v2.0.22 source (requested by the prior-art teammate)

1. **No `session.idle`/`session.status` on V2.** CONFIRMED (VS).
   - The only references are the schema declarations (`packages/schema/src/session-status-event.ts`,
     `event-manifest.ts`), the generated client types, and the V1 docs. Nothing in `packages/core` or
     `packages/server` publishes them.
   - Turn boundaries come only from `session.execution.started` plus one of `succeeded|failed|interrupted`.
2. **Continuation paths.**
   - **`ctx.session.synthetic({sessionID, id?, text, description?, metadata?, delivery?, resume?})`** (VS,
     `packages/core/src/session/session.ts:271-314`):
     - It wakes execution unless `resume === false` or a revert is staged.
     - The model sees `text` as a user-role message (`runner/to-llm-message.ts:284-285`).
     - The `prompt` hook does **not** run for it.
     - The **TUI renders it as one "◈ Notice" row showing only `description`**, never `text`
       (`packages/tui/src/routes/session/index.tsx:1947-1985`). So js-goal's "long prompt doesn't flood the
       transcript" rationale holds.
     - It is idempotent by `id` (`admission.admit` → `reconcile`).
   - **Two-phase `prompt`** (bybrawe): call `prompt({..., id, resume:false})`, then `prompt({..., id, resume:true})`. VALID (VS):
     - The first call runs the `prompt` hook and durably admits the item without waking.
     - The second call hits `admission.reconcile` on the same id and returns the existing item, so hooks do not
       re-run. Because `resume !== false` it then calls `execution.wake(sessionID)` (`session.ts:146-178`).
     - `reconcile` matches on `sessionID` + `type` only, so the second call's `delivery` does not cause a conflict
       (`inbox.ts:69-74, 155-167`).
     - A same id with a different type, or one used for a compaction, raises `PromptConflictError`.
   - **`ctx.session.generate({sessionID, prompt}) → {text}`** (VS): "transient text from the current session
     context without mutating session history". It is **not** a continuation mechanism, because it creates no
     turn and no message. Use it as an out-of-band judge or summarizer only.
3. **Sidebar fed by RPC.** VALID (VS + VD).
   - `context.ui.slot({append: "sidebar.content", render: ({sessionID}) => ...})` plus a server
     `ctx.rpc.register(Def, {read})` and a TUI `context.client.rpc(Def).read(input, {location})`.
   - `RpcCallOptions.location` selects the target location (`packages/client/src/promise/rpc.ts:8-10, 95-105`).
     Pass `context.location`, because server plugin instances (and their RPC registrations) are per location.
   - Client-side RPC events arrive from **every** location: filter on `event.location`. They are live-only, so
     re-`read` on reconnect.
   - `Rpc.define` is a validating identity function (`packages/schema/src/rpc.ts:54-60`), so a plain object
     also works.
4. **`ctx.storage` is a key-value store.** CONFIRMED, with caveats (VS):
   - JSON values
   - `get/set/remove/scan({prefix, after?, limit 1..1000})`
   - global SQLite `kv` table, scoped only by plugin id (shared across projects and processes; no CAS)
   - `packages/core/src/kv.ts:36-80`, `packages/core/src/plugin/host.ts:602-623`
5. **A `context` hook can restrict a (child) session's tools.** CONFIRMED and **enforced at execution**, not just
   hidden (VS).
   - `model-request.ts:262-269` builds `hooked` from the hook's surviving `event.tools`, and passes it as
     `definitions` to `tools.execute` (`model-request.ts:399`).
   - `packages/core/src/tool.ts:272-275` rejects a call to a direct tool or `execute` that the hook removed with
     `Tool.Error("Tool is not available for this request: <name>")`.
   - Caveats:
     - It applies only to the `context` request kind and is re-applied per request, so the plugin must recognize
       the child `sessionID` on every request. Hooks fire for child sessions at the same location.
     - Code Mode tools are not individually listed in `event.tools`. To exclude them, delete the single
       `execute` entry.
     - For a durable or authoritative restriction, prefer permission rules: an agent's `permissions`, or
       `ctx.session.create({parentID, permissions})` / `ctx.session.update({sessionID, permissions})`. A
       `deny` with resource `*` hides the tool from the catalog, and permissions are inherited by children.

---

<a id="s01"></a>

# §01 — OpenCode V2 core: what V2 is, server plugin shape, loading, reload, multi-instance

Source of truth: `github.com/anomalyco/opencode` (the old `sst/opencode` URL resolves to the same repo; both `HEAD`s were
`108b988` on 2026-10-02) at tag **v2.0.22**, commit `527f0b9` (2026-10-02 04:22 UTC). V1 comparisons use a sparse
clone of tag **v1.18.34** (`aec0b9a`, 2026-09-30) at `scratchpad/repos/opencode-v1`. Paths are repo-relative at
v2.0.22 unless marked `@v1.18.34`.

Tags: **VERIFIED-SOURCE** (read in code), **VERIFIED-DOCS** (repo docs at the tag, `services/www/src/docs/content/…`,
which is the V2 docs site; `packages/web/src/content/docs/` is the older V1 site), **INFERRED** (my reasoning, not
directly proven).

---

## 1. What "OpenCode 2" is

### 1.1 Releases and lines

| Fact | Tag |
|---|---|
| `v2.0.0` tag commit is dated **2026-09-11 23:46 UTC** (`fix(release): use V2 Docker artifact paths (#48571)`); `@opencode/cli@2.0.0` hit npm 2026-09-11 23:44 UTC, `@opencode/plugin@2.0.0` 2026-09-12 00:15 UTC. Latest is **v2.0.22** (2026-10-02). 23 tags v2.0.0–v2.0.22. | VERIFIED-SOURCE (GitHub API tag→commit dates; `npm view … time`) |
| V2 tags are **not** published as GitHub Releases. The newest GitHub Release is still **v1.18.34** (2026-09-30 22:39 UTC). | VERIFIED-SOURCE (`gh api repos/anomalyco/opencode/releases`) |
| The 1.x line is still maintained: v1.18.28 (09-04), .29 (09-04), .30 (09-09), .31 (09-14), .32 (09-21), .33 (09-28), **.34 (09-30)** — i.e. releasing in parallel with 2.0.x. | VERIFIED-SOURCE (GitHub Releases API) |
| npm: V2 packages are a **new scope** — `@opencode/cli`, `@opencode/plugin`, `@opencode/sdk` all `latest = 2.0.22` (scope created 2026-09-02). V1 packages keep the old scope: `opencode-ai` and `@opencode-ai/plugin` `latest = 1.18.34`. | VERIFIED-SOURCE (`npm view … dist-tags`) |
| The installed binary is `~/.opencode/bin/opencode` (Mach-O arm64, 180 MB) plus a 2-line `opencode2` shim that `exec`s it. | VERIFIED-SOURCE (local `file`/`cat`) |

### 1.2 Architecture changes visible in source

| Area | V2 reality | Tag / citation |
|---|---|---|
| Monorepo | New package set: `packages/core` (Effect services), `packages/server`, `packages/protocol` (HttpApi groups + OpenAPI), `packages/schema`, `packages/client` (generated Promise/Effect/Solid clients), `packages/plugin`, `packages/tui`, `packages/cli`, `packages/sdk`, `packages/app`/`desktop`/`web`. No `packages/opencode` (the V1 home). | VERIFIED-SOURCE (`packages/*/package.json`) |
| Runtime | Whole core is **Effect v4** (`effect` catalog). Promise plugins are adapted into Effect plugins (`packages/plugin/src/promise/adapter.ts:207-219`). | VERIFIED-SOURCE |
| Shipped binary runtime | **Bun 1.4.2** single-file executable (`Bun.build({compile…})`, `packages/cli/script/build.ts:124-140`; binary strings show `Bun v1.4.2 (744846f84) macOS Silicon`). A Node SEA build (`NODE_VERSION = "26.4.0"`, `packages/cli/script/build-node.ts:16`) exists but is only published as `@opencode/cli-node` for non-`latest` channels (`packages/cli/script/publish.ts:135-142`). So plugins run under **Bun** on the stable channel; the plugin loader has Bun and Node branches (`packages/plugin/package.json` `#plugin-source` → `source.bun.ts` / `source.node.ts`). | VERIFIED-SOURCE |
| Server process model | Default `opencode` TUI connects to a **managed background service** (one per user per channel; default port `0xc0de` = 49374, `packages/cli/src/services/service-config.ts:30-38`) via `Service.ensure` (`packages/cli/src/services/server-connection.ts:21-50`). `--standalone` (or `service.json` `disabled: true`) instead spawns a private `opencode serve --stdio --port 0` child per TUI (`packages/cli/src/services/standalone.ts:17-33`). `--server <url>` attaches to a remote server. The service `chdir`s to `$HOME` (`packages/cli/src/server-process.ts:63`). `opencode service restart` exists (VERIFIED-DOCS `plugins.mdx` "Reload"). | VERIFIED-SOURCE |
| Locations | Everything server-side is keyed by a **Location** = `{directory, workspaceID?}` with `project {id, directory, canonical}` (`packages/schema/src/location.ts:10-25`). Plugins, hooks, config are "location nodes" (`makeLocationNode`), i.e. **one plugin instance per location** inside the shared server process. | VERIFIED-SOURCE (`packages/core/src/plugin.ts:295-300`, `plugin/hooks.ts:108`, `plugin/supervisor.ts:258`) |
| Storage | One **SQLite** DB (WAL, `busy_timeout 5000`) at `$XDG_DATA_HOME/opencode/opencode.db` (`~/.local/share/opencode/opencode.db`; channel-suffixed for non-standard channels; `OPENCODE_DB` override) — `packages/cli/src/database-path.ts:4-13`, `packages/core/src/database/database.ts:40-79`, `packages/util/src/global-roots.ts`. The user's machine has a 33 MB `opencode.db`. Events are persisted durably per aggregate (`EventTable`/`EventSequenceTable`, `packages/core/src/bus.ts:20-48`). | VERIFIED-SOURCE |
| Session model | Prompts are admitted into a durable **inbox** with `delivery: "steer" \| "queue"` (`packages/plugin/src/promise/session.ts:14-20`, `packages/core/src/session/prompt.ts:40-50`); execution/step lifecycle events (`session.execution.*`) replace V1 `session.idle/status`. Details → section 02. | VERIFIED-SOURCE |
| Config shape | `opencode.json(c)` V2 keys (`packages/schema/src/config.ts:29-109`): `shell, model, default_agent, update, share, enterprise, username, permissions (ruleset), agents, snapshots, watcher, formatter, lsp, media, tool_output, mcp {timeout, servers}, compaction, skills, commands, instructions, references, websearch, plugins, worktree, warming, providers, experimental`. MCP is `mcp.servers.<name>` (`packages/schema/src/config/mcp.ts:19-22`) — matches the user's `opencode.jsonc` which already has `mcp.servers`. | VERIFIED-SOURCE |
| V1 config compatibility | V1 keys are **normalized on read**, not rejected: `plugin` (string or `[spec, options]` tuple) → `plugins` (`packages/core/src/config/normalize.ts:185-190`), `command` → `commands` (`subtask` → `subagent`), `mcp` → `mcp.servers`, `permission`/`tools` → ordered rules with renamed actions `write/patch→edit`, `task→subagent`, `bash→shell` (`packages/core/src/v1/config/migrate.ts:21-66, 114-121`). Unsupported V1 keys produce diagnostics (`normalize.ts:45-55`). | VERIFIED-SOURCE |
| TUI config | `~/.config/opencode/cli.json` (global only) replaces V1 `tui.json`; on first run V1 `tui.json` + `kv.json` are migrated into it, including `plugin`/`plugin_enabled` → `plugins` (`packages/cli/src/config/config.ts:31`, `packages/cli/src/config/migrate.ts:100-115, 160-195`). The user's `cli.json` currently holds only `theme`. | VERIFIED-SOURCE |
| HTTP API | `/api/...` routes defined in `packages/protocol` (139 endpoints audited in `V2_HTTP_API_AUDIT.md`); `/api/event` is an SSE stream "across all server locations. Volatile by contract: a slow consumer overflows and fails the stream, and events during disconnection are missed." (`packages/protocol/src/groups/event.ts:44-52`). | VERIFIED-SOURCE |

### 1.3 Is there a separate V2 plugin API? Yes — a different package, entrypoint, and contract

| Fact | Tag |
|---|---|
| V2 plugin package is **`@opencode/plugin`** (not `@opencode-ai/plugin`). Exports: `"."` → Promise API, `"./effect"` → Effect API, `"./tui"` → CLI/TUI plugin API, `"./host"`, `"./*"` (`packages/plugin/package.json` `exports`). | VERIFIED-SOURCE |
| Promise plugin: `export default Plugin.define({ id, setup(ctx) })`; Effect plugin: `export default Plugin.define({ id, effect: (ctx) => Effect<void, never, Scope> })` from `@opencode/plugin/effect`. | VERIFIED-SOURCE (`packages/plugin/src/promise/plugin.ts:56-65`, `packages/plugin/src/effect/plugin.ts:56-63`) |
| Curiosity: `@opencode-ai/plugin@1.18.34` also ships a `./v2/effect` and `./v2/promise` subpath (`packages/plugin/package.json@v1.18.34`), an earlier in-1.x preview of the V2 shapes. It is **not** the `@opencode/plugin` API; do not target it. | VERIFIED-SOURCE (@v1.18.34) / INFERRED (not the shipping V2 contract) |

### 1.4 Do V1 plugins load in 2.x? **No.**

The V2 loader decodes the module's **default export** against exactly two shapes (`packages/core/src/plugin/module.ts:60-73`):

```ts
const Module = Schema.Struct({
  default: Schema.Union([
    Schema.Struct({ id: Schema.String, effect: /* function */ }),
    Schema.Struct({ id: Schema.String, setup:  /* function */ }),
  ]),
})
```

and on mismatch fails with (`module.ts:107-115`):

```ts
new LoadError({ message: "Plugin must export a default definition with an id and an effect or setup function.", cause })
```

| Case | V2 behavior | Tag |
|---|---|---|
| V1 named function export (`export const X: Plugin = async (input) => ({…})`), no default | `LoadError` above → plugin appears in `ctx.plugin.list()` / `opencode plugin list` with `state: {status: "failed", error, ref}`; **other plugins keep loading** (`supervisor.ts:58-83`). | VERIFIED-SOURCE |
| Default export is a V1 function | Same `LoadError`. | VERIFIED-SOURCE |
| Default `{ id, server }` only (V1 object form) | Same `LoadError` (no `setup`/`effect`). | VERIFIED-SOURCE |
| Default `{ id, server, setup }` (dual) | Decodes as the `setup` branch; `server` is ignored. `"effect" in value` picks Effect if both exist (`module.ts:116`). | VERIFIED-SOURCE (union/branch selection) + INFERRED (excess `server` key tolerated: Effect `Schema.Struct` ignores excess properties by default; confirmed in practice by the user's dual `orca-opencode2-status.js` and by wr-goal's live 2.0.16 acceptance) |
| Docs | "V1 plugin implementations do not run in V2. Moving a file or renaming its config entry is not enough." | VERIFIED-DOCS `build/plugins/migrate-v1.mdx:9-11` |
| Config entries | V1 `"plugin": [...]` entries are still read (normalized to `plugins`), so the **package is fetched and imported**, then fails the shape check. | VERIFIED-SOURCE (`normalize.ts:185-190` + `module.ts`) |

### 1.5 One package for both lines (dual export)

V1 loader @v1.18.34 (`packages/opencode/src/plugin/index.ts:114-125`, `shared.ts:270-301`):

- If `mod.default` is an object that has `id`, `server`, or `tui` → V1 "module" form; requires `server()` for server plugins, else throws `Plugin ${spec} must default export an object with server()`; `server` and `tui` together throw `…either server() or tui(), not both`; path plugins must export `id`. — VERIFIED-SOURCE @v1.18.34
- Otherwise legacy mode: **every** export value must be a server function (or `{server}`), else `TypeError("Plugin export is not a function")`. — VERIFIED-SOURCE @v1.18.34
- Hence a pure V2 module (`default {id, setup}`) on V1 throws "must default export an object with server()" — the exact message quoted in the user's orca plugin comment. — VERIFIED-SOURCE @v1.18.34

Working dual shape (VERIFIED-DOCS `build/plugins/index.mdx:1732-1766`, `migrate-v1.mdx:328-357`; consistent with both loaders above):

```ts
import { Plugin } from "@opencode/plugin"
export default {
  ...Plugin.define({ id: "example", async setup(ctx) { /* V2 */ } }),
  async server(input, options) { return { /* V1 Hooks */ } },
}
```

Caveats:
- Docs say the V1 object form is supported from **1.18.29**. Source shows `readV1Plugin(..., "detect")` already present at v1.18.10, v1.18.20 and v1.18.28, and `plugin/index.ts`/`shared.ts` are byte-identical between 1.18.28 and 1.18.29. So the real floor is probably lower, but untested. — VERIFIED-DOCS (claim) / VERIFIED-SOURCE (presence) / INFERRED (floor)
- Do not add any other non-function named export to the module (V1 legacy mode would throw), and keep `tui` off the server default export on V1. — VERIFIED-SOURCE @v1.18.34
- Hooks are not translated; you maintain two implementations (wr-goal does this with an adapter, `src/v2-bridge.js`). — VERIFIED-DOCS

### 1.6 V1 hook surface (for an optional V1 fallback) — `@opencode-ai/plugin@1.18.34` `packages/plugin/src/index.ts`

```ts
export type PluginInput = {               // :56-66
  client: ReturnType<typeof createOpencodeClient>; project: Project; directory: string; worktree: string
  experimental_workspace: { register(type: string, adapter: WorkspaceAdapter): void }
  serverUrl: URL; $: BunShell
}
export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>   // :74
export type PluginModule = { id?: string; server: Plugin; tui?: never }                  // :76-80

export interface Hooks {                  // :222-335
  dispose?: () => Promise<void>
  event?: (input: { event: Event }) => Promise<void>
  config?: (input: Config) => Promise<void>
  tool?: { [key: string]: ToolDefinition }
  auth?: AuthHook
  provider?: ProviderHook
  "chat.message"?: (input: { sessionID; agent?; model?: {providerID; modelID}; messageID?; variant? },
                    output: { message: UserMessage; parts: Part[] }) => Promise<void>
  "chat.params"?: (input: { sessionID; agent; model; provider: ProviderContext; message: UserMessage },
                   output: { temperature; topP; topK; maxOutputTokens: number | undefined; options }) => Promise<void>
  "chat.headers"?: (input: {…same…}, output: { headers: Record<string,string> }) => Promise<void>
  "permission.ask"?: (input: Permission, output: { status: "ask" | "deny" | "allow" }) => Promise<void>
  "command.execute.before"?: (input: { command; sessionID; arguments }, output: { parts: Part[] }) => Promise<void>
  "tool.execute.before"?: (input: { tool; sessionID; callID }, output: { args: any }) => Promise<void>
  "shell.env"?: (input: { cwd; sessionID?; callID? }, output: { env: Record<string,string> }) => Promise<void>
  "tool.execute.after"?: (input: { tool; sessionID; callID; args }, output: { title; output; metadata }) => Promise<void>
  "experimental.chat.messages.transform"?: (input: {}, output: { messages: { info: Message; parts: Part[] }[] }) => Promise<void>
  "experimental.chat.system.transform"?: (input: { sessionID?; model }, output: { system: string[] }) => Promise<void>
  "experimental.provider.small_model"?: (input: { provider }, output: { model? }) => Promise<void>
  "experimental.session.compacting"?: (input: { sessionID }, output: { context: string[]; prompt?: string }) => Promise<void>
  "experimental.compaction.autocontinue"?: (input: { sessionID; agent; model; provider; message; overflow: boolean },
                                            output: { enabled: boolean }) => Promise<void>
  "experimental.text.complete"?: (input: { sessionID; messageID; partID }, output: { text }) => Promise<void>
  "tool.definition"?: (input: { toolID }, output: { description; parameters }) => Promise<void>
}
```

V1 `tool()` helper (`packages/plugin/src/tool.ts@v1.18.34:3-54`): `tool({ description, args: ZodRawShape, execute(args, ctx) })`, `tool.schema = z`; `ToolContext = { sessionID, messageID, agent, directory, worktree, abort: AbortSignal, metadata({title?, metadata?}), ask({permission, patterns, always, metadata}) }`; result `string | { title?, output, metadata?, attachments? }`. V1 auto-discovers `{plugin,plugins}/*.{ts,js}` in config dirs (`packages/opencode/src/config/plugin.ts@v1.18.34:21`). — all VERIFIED-SOURCE @v1.18.34

---

## 2. V2 server plugin shape

### 2.1 Definition and lifecycle

```ts
// packages/plugin/src/promise/plugin.ts:56-65
export type Cleanup = () => Promise<void> | void
export interface Plugin {
  readonly id: string
  readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void
}
export function define(plugin: Plugin) { return plugin }   // identity; types only
```

| Fact | Tag |
|---|---|
| `setup` is **awaited** inside `Effect.acquireRelease`; the returned cleanup runs when the plugin's scope closes (unload, reload, location eviction, shutdown) (`packages/plugin/src/promise/adapter.ts:604-607`). | VERIFIED-SOURCE |
| Plugins in a location are activated **sequentially** (`packages/core/src/plugin.ts:139-146`), and session entry points block on `Plugin.awaitActivation` (`packages/core/src/plugin/service.ts:29-34`; used at `packages/core/src/session/prompt.ts:38`). ⇒ a `setup` that never resolves (e.g. `await`ing an event loop) stalls later plugins **and prompt admission for that location**. Start long-lived loops with `void (async () => …)()` and stop them from cleanup. | VERIFIED-SOURCE (mechanism) / INFERRED (stall consequence) |
| Hook/transform registrations are bound to the plugin scope and auto-disposed on unload; `Registration = { dispose(): Promise<void> }` for early removal (`packages/plugin/src/promise/registration.ts:1-3`; `packages/core/src/plugin/hooks.ts:69-86`). | VERIFIED-SOURCE |
| Throwing (or rejecting) in `setup` → logged `failed to load plugin`, slot recorded `state: {status:"failed", error: Cause.pretty(...)}`; if an older revision of the same plugin was active it is **restored as fallback** (`packages/core/src/plugin.ts:81-86, 146-170`). | VERIFIED-SOURCE |
| Throwing inside a **transform** callback disables the plugin: `"Plugin disabled after ${state}.transform failed. Check server logs for details."` with an `err_xxxxxxxx` ref, and its scope is closed (`packages/core/src/plugin.ts:50-63, 182-236`). | VERIFIED-SOURCE |
| Duplicate plugin IDs: the first in boot order wins, later ones become `failed: "Duplicate plugin ID: <id>"` (`packages/core/src/plugin/supervisor.ts:96-111`). | VERIFIED-SOURCE |

### 2.2 The full `ctx` (Promise API) — `packages/plugin/src/promise/plugin.ts:26-54`

```ts
export interface Context {
  readonly app: App                 // { name, version, channel }  (src/app.ts:1-5)
  readonly location: Location.Info  // { directory, workspaceID?, project: { id, directory, canonical } }
  readonly options: PluginOptions   // Readonly<Record<string, any>> from config entry `options`
  readonly agent: AgentDomain
  readonly aisdk: AISDKDomain
  readonly command: CommandDomain
  readonly event: EventDomain
  readonly experimental: { readonly terminal: Pick<OpenCodeClient["experimental"]["persistentPty"], "read"> }
  readonly integration: IntegrationDomain
  readonly mcp: MCPDomain
  readonly model: ModelDomain
  readonly generate: GenerateApi           // generate.text({ model, prompt }) → { text }
  readonly permission: PermissionDomain
  readonly plugin: Pick<PluginApi, "list">
  readonly provider: ProviderDomain
  readonly reference: ReferenceDomain
  readonly rpc: RpcDomain
  readonly session: SessionDomain
  readonly shell: ShellDomain
  readonly skill: SkillDomain
  readonly storage: StorageDomain
  readonly tool: ToolDomain
  readonly vcs: VcsDomain
  readonly websearch: WebSearchDomain
  readonly worktree: WorktreeDomain
}
```

There is **no** `ctx.client` (raw SDK), **no** `$` shell helper, **no** `log`/`app.log` API, **no** `ctx.directory/worktree/project/serverUrl` top-level fields. Use `ctx.location`, `console.*`, and your own process APIs. — VERIFIED-SOURCE (interface above; adapter builds exactly these keys at `adapter.ts:291-602`)

Per-domain surface (all VERIFIED-SOURCE, `packages/plugin/src/promise/*.ts`; read methods are the generated client's methods with the same inputs/outputs):

| Domain | Reads / actions | Plugin-only | File |
|---|---|---|---|
| `agent` | `list`, `get({agentID})` | `transform(editor)`, `reload()`; editor: `list/get/default(id\|undefined)/update(id, fn)/remove(id)` (no `add`) | `agent.ts:6-17` |
| `aisdk` | — | `hook("sdk"\|"language", cb, {providerID?})` | `aisdk.ts:5-22` |
| `command` | `list` | `transform(editor)`; editor: `add({name, description?, execute({sessionID, prompt, delivery}) => Promise<void>})`; `reload()` | `command.ts:7-26` |
| `event` | `subscribe({signal?}) → AsyncIterable<OpenCodeEvent>` | — | `event.ts:1-3`, adapter `:324-333` |
| `generate` | `text({model, prompt})` | — | `plugin.ts:40` |
| `integration` | `list, get, connect.key, oauth.{connect,status,complete,cancel}, command.{connect,status,cancel}` | `transform`, `reload`, `connection.{active,resolve,status}` | `integration.ts:85-98` |
| `mcp` | `list` | `transform` (editor `list/get/set/update/remove` of `Mcp.ServerConfig`), `reload` | `mcp.ts:6-17` |
| `model` | `list`, `default` | `transform` (editor `list/get/update/remove/default.{get,set}/provider.{list,get}`), `reload` | `model.ts:7-28` |
| `permission` | `list`, `get`, `reply` | `hook("evaluate", cb)` | `permission.ts:7-24` |
| `plugin` | `list` | — | `plugin.ts:42` |
| `provider` | `list`, `get` | `transform` (editor `list/get/add/update/remove/models.{set,update,remove}`), `reload` | `provider.ts:9-33` |
| `reference` | `list` | `transform`, `reload` | `reference.ts:5-15` |
| `rpc` | typed client for any `Rpc.PortableDefinition` (methods + `events.subscribe/on`) | `register(definition, handlers) → { dispose, events.emit }` | `rpc.ts:7-31`, adapter `:77-162` |
| `session` | `create, get, remove, switchAgent, switchModel, prompt, generate, command, compact, synthetic, interrupt, update, move, wait, context` | `hook(name, cb, {providerID?})` | `session.ts:153-172` |
| `shell` | — | `hook("create.before", cb)` | `shell.ts:3-17` |
| `skill` | `list` | `transform` (editor `list/get/add/update/remove`), `reload` | `skill.ts:6-17` |
| `storage` | `get(key)`, `set(key, Json)`, `remove(key)`, `scan({prefix, after?, limit?}) → {entries, next?}` | — | `storage.ts:4-9` |
| `tool` | `list()` | `transform` (editor `list/get/namespace/add/update/remove`), `reload`, `hook("execute.before"\|"execute.after", cb)` | `tool.ts:26-72` |
| `vcs` | `get, base, branch.list, status, diff` | `transform` (add a VCS backend, `default.{get,set}`), `reload` | `vcs.ts:35-46` |
| `websearch` | `providers, query` | `transform` (add provider, `default`), `reload` | `websearch.ts:5-25` |
| `worktree` | `list, create, remove, refresh` | `transform` (add strategy), `reload` | `worktree.ts:5-23` |

Session domain **lacks** (vs the full client `packages/client/src/promise/generated/client.ts:533-1095`): `list`, `stats`, `active`, `fork`, `skill`, `shell`, `revert`, `diff`, `inbox.*`, `instructions.*`, `log`, `background`, `message.*`, `form.*`, `environment`, `view`, `import/export`. So a plugin **cannot list sessions, read children, or read the inbox** through `ctx`; it must track sessions from events (or via its own RPC/HTTP). `remove` **is** present at 2.0.22 (wr-goal reported it missing at 2.0.16). — VERIFIED-SOURCE

Adapter quirk: for endpoints whose success schema is a single-property `{ data }` object, the Promise adapter returns the **unwrapped** value (e.g. `ctx.session.get()` resolves to the bare `Session.Info`, not `{data}`) (`adapter.ts:185-197`). Other endpoints return the full response (e.g. `ctx.model.list()` → `{location, data}` per host `response()` at `packages/core/src/plugin/host.ts:93-94`). Check each method's actual output type. — VERIFIED-SOURCE (mechanism) / INFERRED (which endpoints fall in which bucket)

### 2.3 Every hook, with event types

Registration signatures (`packages/plugin/src/promise/registration.ts:10-21`):

```ts
type Hooks<Spec> = <N extends keyof Spec>(name: N, cb: (input: Spec[N]) => Promise<void> | void) => Promise<Registration>
type ModelHooks<Spec> = <N extends keyof Spec>(name: N, cb: (input: Spec[N]) => Promise<void> | void,
  options?: Spec[N] extends { readonly model: unknown } ? { readonly providerID?: string } : never) => Promise<Registration>
type Transform<Input> = (callback: (input: Input) => void) => Promise<Registration>   // callback MUST be sync
```

**Session hooks** (`packages/plugin/src/promise/session.ts:14-151`, all mutate the event object in place):

| Hook | Event (mutable fields **bold**) | When |
|---|---|---|
| `prompt` | `{ sessionID, messageID, **prompt** (text, files, agents, skills), **metadata?**, **delivery**: "steer"\|"queue" }` | once at durable prompt admission, before attachment/skill resolution (`packages/core/src/session/prompt.ts:38-50`); not for synthetic/shell/compaction/move |
| `context` | `{ sessionID, model, agent, **system**: SystemPart[], **messages**: Message[], **options**, **tools**: Record<name,{description,input}> }` | every agent-loop model request incl. tool continuations |
| `compaction` | `context` fields + **`result?`: `{summary, providerState?, metadata?, tokens?}`** (set to skip the model) | checkpoint summaries |
| `generate` | same as `context` | `ctx.session.generate` |
| `title` | `{ sessionID, model, system, messages, options, **result?: string** }` | title generation |
| `model.request` | `{ sessionID, agent, model, kind, **baseURL?**, **headers** }` | per model call |
| `http.request` / `http.response` | `{ …, kind, **request** }` / `{ …, request, **response** }` | native HTTP |
| `experimental.ws.handshake` / `.send` / `.receive` | `{ …, kind, **url**, **headers** }` / `{ …, **frame** }` | WebSocket providers |
| `retry` | `{ sessionID, agent, model, error: SessionError.Error, attempt, **decision**: {retry:false}\|{retry:true, delay} }` | before a provider retry is scheduled |

`kind: "primary" | "compaction" | "title" | "generate"` (`session.ts:61`).

**Tool hooks** (`packages/plugin/src/promise/tool.ts:38-64`):

```ts
"execute.before": { tool: string /*mutable*/; sessionID; agent; messageID; id: Tool.CallID; input: unknown /*mutable*/ }
"execute.after":  { tool; sessionID; agent; messageID; id; input } &
                  ({ status: "completed"; result: Tool.Result /*mutable*/ } | { status: "error"; error: Tool.Error /*mutable*/ })
```
Only `execute.before` has a failure channel (a `Tool.Error` rejects the call) — `packages/plugin/src/effect/tool.ts:48-52`, `packages/core/src/plugin/hooks.ts:23-30`. From a Promise plugin, a throw becomes an Effect defect via `Effect.promise` (`adapter.ts:504-505`); docs say throwing blocks the tool (`migrate-v1.mdx:125-130`). — VERIFIED-SOURCE (channel) / VERIFIED-DOCS (throw blocks) / INFERRED (exact error text shown to the model)

**Permission hook** (`permission.ts:7-20`): `"evaluate": { sessionID, agent?, action, resources, metadata?, source?, **effect**: "allow"|"ask"|"deny", **message?** }`; runs for allow/ask, not for configured deny (VERIFIED-DOCS `build/plugins/index.mdx:1620-1625`).

**Shell hook** (`shell.ts:3-13`): `"create.before": { command, cwd, timeout, shell, env }` (all mutable).

**AI SDK hooks** (`aisdk.ts:5-18`): `"sdk": { model, package, options, **sdk?** }`, `"language": { model, sdk, options, **language?: LanguageModelV3** }`.

There is **no** generic `event` hook, `config` hook, `chat.*`, `command.execute.before`, `tool.definition`, `experimental.compaction.autocontinue`, `experimental.text.complete`, or `experimental.provider.small_model` in V2 (migration table: `migrate-v1.mdx:142-175`). — VERIFIED-SOURCE (hook specs) + VERIFIED-DOCS

Hook execution semantics: callbacks for a name are kept in registration order per **location** and run **sequentially and inline** (`packages/core/src/plugin/hooks.ts:63-108`) — a slow hook directly delays the operation (e.g. a slow `context` hook delays every model call). Plugin order = boot order (2.4). — VERIFIED-SOURCE

### 2.4 Effect variant

`@opencode/plugin/effect`: `Plugin.define({ id, effect: (ctx) => Effect.Effect<void, never, Scope.Scope> })` (`packages/plugin/src/effect/plugin.ts:56-63`); same domains but every method returns `Effect`, hooks are `(event) => Effect<void, E>`, registrations attach to the plugin `Scope`. The Promise API is literally converted to this (`fromPromise`, `adapter.ts:216-610`). Choose Promise unless you already use Effect. — VERIFIED-SOURCE

### 2.5 How plugins are found and loaded

**Config entries** (`packages/schema/src/config/plugin.ts:6-14`; parser `packages/core/src/config/plugin/source.ts:113-120`):

```jsonc
"plugins": [
  "opencode-acme",                 // npm name (with optional @version/tag/range) or npm-compatible git spec
  "./plugins/local",               // relative → resolved against the config file's directory
  "/abs/dir", "file:///abs/dir",
  { "package": "@acme/x", "options": { "strict": true } },
  "-acme.reviewer", "*", "-opencode.provider.*"   // "-" disables by plugin ID / wildcard
]
```

| Rule | Tag |
|---|---|
| **Auto-discovery dirs**: every config *directory* entry gets `plugin/` and `plugins/` scanned (`packages/core/src/plugin/source-directory.ts:7-33`). Directory entries are the global config dir (`$XDG_CONFIG_HOME/opencode` = `~/.config/opencode`, or `OPENCODE_CONFIG_DIR`) and every present `.opencode/` from the location directory up to the filesystem root (`packages/core/src/config.ts:185-191, 219-237`; `config/discovery.ts:23-83`). Accepted children: direct `*.ts`/`*.js` files, directories, and symlinks to either; sorted by path. A `plugins/` folder next to a project-root `opencode.json` is **not** scanned (VERIFIED-DOCS `plugins.mdx:61-63`). `.claude/` and `.agents/` dirs are only used for skills compatibility, not plugins. | VERIFIED-SOURCE |
| The user's `~/.config/opencode/plugins/orca-opencode-status.js` and `orca-opencode2-status.js` are therefore auto-loaded by V2 as two single-file plugins. | INFERRED (from the rule above) |
| **Configured local paths must be directories**: a configured path to a *file* is dropped with warning `configured plugin path must be a directory` (`source.ts:150-155`). Only auto-discovered single files are allowed. | VERIFIED-SOURCE |
| **Entrypoint resolution** (`packages/plugin/src/host.ts:17-44`): for a directory, try `<dir>/server` then `<dir>/index` (extension inferred: `.ts .tsx .js .jsx .mts .mjs .cts .cjs` on Node; Bun resolver on Bun); also detect `<dir>/tui` and `<dir>/rpc`. For a package, try `<name>/server` then `<name>` (package `exports`), plus `<name>/tui`, `<name>/rpc`. `features.tui/rpc` are reported in `Plugin.Info` (`module.ts:117-122`). A directory's resolved server file must stay inside the directory (`source.ts:168-172`). | VERIFIED-SOURCE |
| Local absolute/relative targets are loaded **directly from disk** (`module.ts:85-106`); wr-goal's note that a configured local dir containing `package.json` gets installed from the registry does not match 2.0.22 source. | VERIFIED-SOURCE (2.0.22) / INFERRED (wr-goal note was about 2.0.16 or misread) |
| **npm packages** are installed by OpenCode's own npm service into `$XDG_CACHE_HOME/opencode/npm/<key>/<generation>/node_modules/<name>` (`packages/util/src/npm.ts:138-141, 270-320`). Startup activates cached/local plugins first, then installs missing packages and activates again (`supervisor.ts:153-173`). Unpinned packages are checked for updates every 24 h and only flagged `outdated` (no auto-update) (`packages/core/src/plugin/update.ts:9, 34-49`; VERIFIED-DOCS `plugins.mdx:115-120`). CLI: `opencode plugin add|list [--builtin]|check|update|remove` (VERIFIED-DOCS `plugins.mdx:84-113`). | VERIFIED-SOURCE |
| **Local plugin dependencies are not auto-installed** (no install call for local targets; the only `npm.add` call sites are packages and providers). Missing bare imports are watched so the plugin reloads once you install them (`packages/plugin/src/source.package.ts`, `source.bun.ts:41-48`). | VERIFIED-SOURCE (call sites) / INFERRED (no other install path) |
| **`@opencode/plugin` at runtime**: the TUI injects `@opencode/plugin/tui` as a runtime virtual module (`packages/tui/src/plugin/runtime-plugin-support.bun.ts:1-8`), but nothing equivalent exists for the server `@opencode/plugin` import. A local server plugin with `import { Plugin } from "@opencode/plugin"` therefore needs that package resolvable from its directory (e.g. `npm i @opencode/plugin` in `.opencode/`), **or** should use `import type` only and `export default { id, setup }` (`define` is the identity function). wr-goal and orca both export plain objects with no runtime `@opencode/*` import. | VERIFIED-SOURCE (TUI shim exists; no server shim found) / INFERRED (failure without it) |
| **Ordering** (`supervisor.ts:138-152, 91-95`; `packages/core/src/plugin/internal.ts:213-267`): internal "pre" built-ins (tools incl. `question`, `subagent`, `skill`; agent/plan/command/skill registries; identity) → SDK-host plugins → instance plugins → **user plugins** (auto-discovered first, then configured, in scan order, `source.ts:158-159`) → internal "post" config plugins (`opencode.config.agent`, `…command`, `…compaction`, `…skill`, …). Consequence: **config `agents`/`commands` transforms run after user plugins and override them** on name clashes. | VERIFIED-SOURCE |
| `-<id>` removals cannot disable `opencode.config.policy` or `opencode.provider.opencode` (`internal.ts:269-271`). | VERIFIED-SOURCE |
| Status surface: `Plugin.Info = { id?, source: builtin\|package{target,version?,outdated?,updating?}\|local{path}\|sdk, features: {server?,tui?,rpc?}, state: {status:"active"} \| {status:"failed", error, ref?} }`; changes publish `plugin.updated` (`packages/schema/src/plugin.ts:10-49`). | VERIFIED-SOURCE |
| **Options**: `ctx.options` is the config entry's `options` object (`module.ts:131`); a later same-spec entry replaces an earlier one by target in `packages` map (`supervisor.ts:84-88`). | VERIFIED-SOURCE |

### 2.6 Plugin storage (`ctx.storage`)

- Backed by the **global** `KV` service (SQLite `KVTable` in `opencode.db`, `packages/core/src/kv.ts:36-60`, `makeGlobalNode`), namespaced `plugin:<hex(id)>:` (`packages/core/src/plugin/host.ts:602-614`). — VERIFIED-SOURCE
- ⇒ Scoped **per plugin ID only, shared across every project/location and every plugin instance in every process using that DB**. Keys must include project/session identity (e.g. `goal/<projectID>/<sessionID>`). Values are JSON (`Schema.Json`). — VERIFIED-SOURCE (scope) / INFERRED (key-design advice)

---

## 3. Hot reload, location lifecycle, multiple instances (Q13 part)

| Fact | Tag |
|---|---|
| **Local plugin hot reload**: every file in a local plugin's import graph (excluding `node_modules`) is fingerprinted (sha256) and file-watched; a change re-imports a fresh module (Bun: `require.cache` invalidation; Node: `?__opencode_reload=<gen>` URLs) and re-activates (`packages/plugin/src/source.ts:8-46`, `source.bun.ts:9-68`, `source.node.ts:8-52`, `packages/core/src/plugin/module.ts:16-46`). | VERIFIED-SOURCE |
| Re-activation triggers (debounced 100 ms): config changes touching plugin sources, watched module changes, `config.updated`/SDK plugin updates, package update status, a 24 h timer (`packages/core/src/plugin/supervisor.ts:196-237`). | VERIFIED-SOURCE |
| **Reload granularity**: registrations are order-dependent, so on any change OpenCode keeps only the **unchanged prefix** of the plugin list alive and tears down + re-runs `setup` for the first changed plugin **and every plugin after it** (`packages/core/src/plugin.ts:107-175`). Your plugin can be restarted because an *earlier* plugin changed. In-memory loop state must be reconstructible from storage. | VERIFIED-SOURCE |
| Docs caveat: "Changes to unwatched local dependencies may still require restarting OpenCode" (`opencode service restart`). | VERIFIED-DOCS `plugins.mdx:115-125` |
| **Location eviction**: the server evicts a location's services (including its plugin instances → cleanup runs) after **60 minutes** without durable session events; active executions in that location are first interrupted with `reason: "inactivity"` (`packages/core/src/location-activity.ts:16-85`; wired with defaults at `packages/server/src/routes.ts:74`). Locations are created lazily on first request, so after a service restart a plugin does **not** run for a project until some client touches that directory. A goal loop must persist state and resume on the next `setup`, not rely on timers alone. | VERIFIED-SOURCE (TTL, interrupt, lazy RcMap) / INFERRED (practical consequence) |
| **Events are process-wide**: `/api/event` is documented as "across all server locations"; the plugin's `ctx.event.subscribe()` wraps the same global `Bus` (`packages/core/src/bus.ts:183`, `plugin/host.ts:255-264`), whose location filter applies only when a `Location.Service` is in the running fiber's context — and plugin activation replaces the context with just `Scope` + loggers (`packages/core/src/plugin.ts:69-74`). Events carry an optional `location: {directory}` (`packages/protocol/src/groups/event.ts:8-12`). ⇒ With N active locations there are N instances of your plugin, **each receiving every location's events**. Filter on `event.location?.directory === ctx.location.directory` (or on sessions you own) or you will drive the loop N times. Lead cross-check: the Promise adapter runs the subscription with the context captured in `makeStreams` (`packages/plugin/src/promise/adapter.ts:45-52`), and the filter (`bus.ts:726-746`) reads `Location.Service` from that context at run time, so it takes the unfiltered branch. | VERIFIED-SOURCE (global bus, doc string, context replacement, adapter context capture) / not runtime-tested — **confirm with a 2-project smoke test** |
| In-process bus pubsub is unbounded (`bus.ts:194`); the "slow consumer overflows and fails the stream" contract is on the HTTP SSE route. Still, wrap `for await` in a resubscribe loop and keep per-event work async/off the iterator. | VERIFIED-SOURCE / INFERRED |
| **Multiple TUIs on one project (default)**: all attach to the one background service ⇒ one plugin instance per location, shared by all TUIs. With `--standalone`, each TUI spawns its own server process, all sharing the same `opencode.db` (WAL + `busy_timeout`) ⇒ **two plugin instances for the same project, both seeing the same sessions' hooks for sessions they execute, and sharing `ctx.storage`**. I found no cross-process lease on session execution (the `owner_id` in `EventSequenceTable` is for replay/sync, `bus.ts:290-411, 717-724`). A loop driver needs its own lease (e.g. a storage key with heartbeat), as wr-goal implements. | VERIFIED-SOURCE (connection modes, DB sharing) / INFERRED (no execution lease) |
| **Process environment**: in service mode the server is a long-lived background process with cwd `$HOME` (`server-process.ts:63`) and its own env (`service.json` may carry `env`, `service-config.ts:14-21`); `process.env` in a plugin is the service's, not the launching terminal's. Use `ctx.location.directory`, never `process.cwd()`. | VERIFIED-SOURCE (chdir, env field) / INFERRED (env inheritance) |
| `ctx.location` is the plugin instance's location, not necessarily the event's/session's (`migrate-v1.mdx:93-94`). Worktrees/workspaces are distinct locations ⇒ separate plugin instances with separate hook registries (`hooks.ts:108`). | VERIFIED-DOCS / VERIFIED-SOURCE |

---

## 4. Could not verify / open items

- Exact runtime behavior of a Promise-plugin **throw in `tool` `execute.before`** (defect vs `Tool.Error`) and of throws in session hooks (likely fail the admission/request as a defect). Needs a live test.
- Whether events reaching a plugin are truly **unfiltered across locations** (strong static inference; confirm with two projects open in one service).
- Whether a local server plugin can `import { Plugin } from "@opencode/plugin"` without a local install (Bun auto-install might mask it). Avoid the runtime import.
- The 1.18.29 floor for dual (V1 object + V2) exports is a docs claim; source suggests earlier 1.18.x already accepted it.
- Effect `Schema.Struct` excess-key tolerance (`server` alongside `setup`) is inferred from Effect defaults and field reports, not from a line in this repo.

---

# §02 — Events, session driving, ask-the-user, agents, persistence, compaction (OpenCode v2.0.22)

Source: `github.com/anomalyco/opencode` @ tag `v2.0.22` (commit 527f0b9). Paths are repo-relative.
Tags: **VS** = VERIFIED-SOURCE, **VD** = VERIFIED-DOCS, **INF** = INFERRED.

---

## Q3. Event bus

### Envelope (what `ctx.event.subscribe()` yields)

- **VS** Every event is `{ id: "evt_…", created: number, type, data, location?, metadata?, durable? }`; durable events add `durable: { aggregateID, seq, version }`. `packages/schema/src/event.ts:60-71` (Payload), `:101-109` (durable struct), `:126-133` (ephemeral struct).
- **VS** The payload lives under **`data`**, not V1's `properties`. RPC events are `type: "rpc.<…>"` with `data: Record<string, unknown>`. `packages/protocol/src/groups/event.ts:14-21`.
- **VS** Promise plugin `ctx.event.subscribe({ signal? })` returns an `AsyncIterable` of events encoded with the public `OpenCodeEvent` schema. `packages/plugin/src/promise/adapter.ts:324-333`, `packages/plugin/src/promise/event.ts:1-3`.
- **VS** In-process, the host filters the global bus down to the public manifest (`EventManifest.isServer`) plus `rpc.*`. `packages/core/src/plugin/host.ts:255-265`.

### The public event list (`EventManifest.ServerDefinitions`)

**VS** `packages/schema/src/event-manifest.ts:71-84`. The 94-member union `V2Event` in `packages/client/src/promise/generated/types.ts:2417` resolves to these types:

```
location.shutdown  models-dev.refreshed  credential.updated  credential.switched  integration.updated
provider.updated  model.updated  agent.updated
session.created  session.agent.selected  session.model.selected  session.moved  session.renamed
session.metadata.updated  session.permissions  session.viewed  session.usage.updated  session.deleted  session.forked
session.inbox.delivered  session.inbox.enqueued  session.inbox.cancelled  session.inbox.delivery.changed
session.execution.started  session.execution.succeeded  session.execution.failed  session.execution.interrupted
session.instructions.updated  session.synthetic  session.skill.activated  session.shell.started  session.shell.ended
session.step.started  session.step.streamed  session.step.ended  session.step.failed
session.text.started  session.text.delta  session.text.ended
session.reasoning.started  session.reasoning.delta  session.reasoning.ended
session.tool.input.started  session.tool.input.delta  session.tool.input.ended
session.tool.called  session.tool.progress  session.tool.success  session.tool.failed
session.retry.scheduled
session.compaction.started  session.compaction.delta  session.compaction.ended  session.compaction.failed
session.revert.staged  session.revert.cleared  session.revert.committed
filesystem.changed  reference.updated  permission.asked  permission.replied  plugin.updated  project.updated
worktree.updated  worktree.resolved  command.updated  config.updated  skill.updated
pty.created  pty.updated  pty.exited  pty.deleted  persistent-pty.added  persistent-pty.removed
shell.created  shell.exited  shell.deleted  form.created  form.replied  form.cancelled  websearch.updated
session.status  session.idle            <- schema only, see below
tui.prompt.append  tui.command.execute  tui.toast.show  tui.session.select
installation.updated  installation.update-available  vcs.branch.updated  mcp.status.changed  mcp.resources.changed
server.connected  rpc.*
```

### Loop-relevant payloads (`data`), from `packages/schema/src/session-event.ts`

| type | `data` | cite |
|---|---|---|
| `session.created` | `{ sessionID, projectID, location, subpath?, parentID?, slug, title?, agent?, model?, metadata?, permissions?, version }` | :51-69 VS |
| `session.renamed` / `session.metadata.updated` | `{ sessionID, title }` / `{ sessionID, metadata }` | :104-122 VS |
| `session.deleted` | `{ sessionID }` | :180-188 VS |
| `session.inbox.enqueued` | `{ sessionID, inboxID, item: { type: "user"\|"synthetic"\|"compaction"\|"move", payload, delivery } }` (user payload carries `metadata`) | :218-226; `packages/schema/src/session-inbox.ts:15-49` VS |
| `session.inbox.delivered` | `{ sessionID, inboxID }` | :211-216 VS |
| `session.execution.started` | `{ sessionID }` | :243 VS |
| `session.execution.succeeded` | `{ sessionID }` | :246 VS |
| `session.execution.failed` | `{ sessionID, error: { type, message, status?, response? } }` | :249-254; `session-error.ts:7-12` VS |
| `session.execution.interrupted` | `{ sessionID, reason: "user" \| "shutdown" \| "superseded" \| "inactivity" }` | :256-260 VS |
| `session.synthetic` | `{ sessionID, text, description?, metadata? }` | :282-291 VS |
| `session.step.started` | `{ sessionID, assistantMessageID, agent, model, snapshot?, started }` | :332-345 VS |
| `session.step.ended` | `{ sessionID, assistantMessageID, finish, rawFinish?, providerState?, cost, tokens, snapshot?, files? }` | :358-373 VS |
| `session.step.failed` | `{ …, error, finish?: "content-filter", cost?, tokens? }` | :375-391 VS |
| `session.text.ended` | `{ sessionID, assistantMessageID, ordinal, text, state? }` (`delta` is live-only) | :406-429 VS |
| `session.tool.called` | `{ sessionID, assistantMessageID, id, input, executed, state? }` | :510-519 VS |
| `session.tool.success` | `{ …, id, content: NonEmpty<Content>, metadata?, executed, resultState? }` | :533-546 VS |
| `session.tool.failed` | `{ …, id, error, content?, metadata?, executed }` | :554-568 VS |
| `session.retry.scheduled` | `{ sessionID, assistantMessageID, attempt, at, error }` | :572-582 VS |
| `session.compaction.started` | `{ sessionID, reason: "auto"\|"manual", recent, inputID? }` | :586-595 VS |
| `session.compaction.ended` | `{ sessionID, reason, model, providerState, providerContext, text, recent, cost, tokens }` | :607-623 VS |
| `session.compaction.failed` | `{ sessionID, reason, error, inputID?, cost, tokens }` | :626-637 VS |
| `permission.asked` | `{ id, sessionID, action, resources[], save?, metadata?, source?: {type:"tool",messageID,id}, message? }` | `packages/schema/src/permission.ts:25-44` VS |
| `permission.replied` | `{ sessionID, requestID, reply: "once"\|"always"\|"reject" }` | `permission.ts:41-52` VS |
| `form.created` | `{ form: Form.Info }` | `packages/schema/src/form.ts:170` VS |
| `form.replied` | `{ id, sessionID, answer: Record<string, string\|number\|boolean\|string[]> }` | `form.ts:171` VS |
| `form.cancelled` | `{ id, sessionID }` | `form.ts:172` VS |
| `command.updated` | `{}` (registry changed; not "command executed") | `event-manifest.ts:61` VS |

### V1 names in V2

- **VS** `session.status` and `session.idle` are still declared in the public manifest. The schema marks `session.idle` `// deprecated`. `packages/schema/src/session-status-event.ts:35-51`, `event-manifest.ts:75`.
- **VS** **Nothing in v2.0.22 publishes them.** A grep across `packages/` finds `SessionStatusEvent` only in `packages/schema/src/event-manifest.ts` and `session-status-event.ts`, and `"session.idle"` only in schema and generated types. The TUI and app derive "running/idle" from the `session.execution.*` events. `packages/client/src/solid/data.ts:1009-1044`.
- **VS → doc bug** The V2 migration doc example `if (event.type === "session.idle")` (`services/www/src/docs/content/build/plugins/migrate-v1.mdx:305`) will never fire on 2.0.22.
- **VS** `message.updated`, `message.part.updated`, `session.error`, `session.updated`, `command.executed` and `session.compacted` exist only in the full/legacy manifest (`LegacyEventV1`, `SessionCompactionEvent`), **not** in `ServerDefinitions`, so plugins never see them. `event-manifest.ts:86-101` vs `:71-81`; `packages/schema/src/v1/session.ts:573-652`; `session-compaction-event.ts:6-13`.
- **VS** **There are no todo events and no todo tool in V2.** V1 `todowrite` is listed in `REMOVED_TOOLS`. `packages/core/src/database/v1-migration.bun.ts:899-901`. The built-in tool set is in `packages/core/src/tool/plugin/` (edit, file-diff, glob, grep, mcp-resource, opencode, patch, question, read, shell, skill, subagent, webfetch, websearch, write).
- **VS** There is no `session.prompt.admitted` event. Admission surfaces as `session.inbox.enqueued` and then `session.inbox.delivered`. The orca plugin synthesizes `session.next.prompt.admitted` from the `prompt` hook (user's `~/.config/opencode/plugins/orca-opencode2-status.js:1121-1123`).

### Turn-finished signal and interrupt/error discrimination

- **VS** A "busy period" is one execution: one `session.execution.started`, then exactly one terminal event of `succeeded | failed | interrupted` after **all** coalesced work has drained (steered and queued inputs admitted while busy included). See the comment "One terminal observation per busy period, covering every coalesced drain" at `packages/core/src/session/execution.ts:118-147` and the doorbell loop at `packages/core/src/session/run-coordinator.ts:33-42, 70-82, 136-145`.
- **VS** The terminal event is chosen by `terminal(exit, reason)`. Success gives `succeeded`. An interrupt cause gives `interrupted` with `reason ?? "shutdown"`. Anything else gives `failed` with a `SessionError`. `execution.ts:50-54`.
- **Reliable "turn finished" = `session.execution.succeeded`** (VS). Treat `failed` and `interrupted` as the non-success terminals.
- **User Esc** VS: the TUI prompt sends `client.api.session.interrupt({ sessionID, resume: true })` on the second Esc (`packages/tui/src/component/prompt/index.tsx:519-531`). The server's interrupt defaults the reason to `"user"` (`execution.ts:153-156`), so the plugin sees `session.execution.interrupted { reason: "user" }`.
- **Other reasons** VS: `"inactivity"` comes from location eviction (`packages/core/src/location-activity.ts:65`). `"shutdown"` comes from process teardown. Shutdown keeps the write-ahead claim, so the next server boot **auto-resumes** the turn (`execution.ts:75-86, 129-137`; `packages/core/src/session/execution/restart.ts:14-31`, at most 10 resumes per turn). `"superseded"` is declared but has no producer in core (grep).
- **Declines** INF, from a code path, not observed live: a user **rejecting a permission** or **dismissing a `question` form** without a message makes the step `Effect.interrupt` (`packages/core/src/session/runner/step.ts:198-206, 262-265`; the test at `packages/core/test/session-runner.test.ts:4871-4915` expects an interrupt-only exit). No interrupt reason is recorded on the coordinator in that path, so `terminal()` falls back to `reason: "shutdown"` (`execution.ts:52`). **Treat any `interrupted` as "stop the loop / pause"**, not just `reason === "user"`. Verify on a live host.
- **Provider errors** VS: retryable errors emit `session.retry.scheduled` and `session.step.failed` and are **not** terminal. Only an unrecoverable error ends in `session.execution.failed` (`packages/core/src/session/runner/llm.ts:248-276`). The retry policy hook is `ctx.session.hook("retry")`.
- **Session row** VS: on every terminal except shutdown, `Session.Info.outcome` (`"succeeded"|"failed"|"interrupted"`) and `time.idle` are projected (`packages/schema/src/session.ts:43-48`; `packages/core/src/session/projector.ts:412-425`). After a restart, `ctx.session.get()` can tell the plugin how the last run ended.
- **Idle marker message** VS: projected history gets `{ type: "idle", outcome }` messages (`packages/schema/src/session-message.ts:284-293`). It is visible through `ctx.session.context()`.

### Delivery guarantees

- **VS** The HTTP SSE route (`GET /api/event`) is "Volatile by contract: a slow consumer overflows and fails the stream, and events during disconnection are missed" (`packages/protocol/src/groups/event.ts:44-51`).
- **VS** In-process plugin subscriptions read the global bus `PubSub.unbounded` (`packages/core/src/bus.ts:194`). A slow plugin consumer does not drop events, but **there is no replay**: anything published before `subscribe()` (or while the plugin was unloaded) is missed.
- **VS (corrected by the lead after cross-checking with section 01)** The bus's location filter (`local()`, `packages/core/src/bus.ts:726-746`) is resolved from `Effect.serviceOption(Location.Service)` **at stream run time**. A Promise plugin's `ctx.event.subscribe()` runs the stream with the context captured in `makeStreams` (`packages/plugin/src/promise/adapter.ts:45-52`, `Stream.toAsyncIterableWith(stream, context)`), and that context is the activation context, which `packages/core/src/plugin.ts:69-74` replaces with only `Scope` + logger references (no `Location.Service`). So the filter takes the `onNone` branch: **plugin event subscriptions are not location-filtered**, and every plugin instance in the server process sees every location's events. Not runtime-tested; the docs' warning that `ctx.location` "is not the location of every session or event the plugin may observe" (`migrate-v1.mdx:93-94`) agrees. Filter on `event.location?.directory` and on sessions the plugin owns.
- **VS** Durable replay exists only as the experimental HTTP `GET /api/experimental/session/:id/log?after=&follow=` (`packages/protocol/src/groups/session.ts` endpoint `session.log`), which is **not exposed on the plugin ctx**.

### Status read APIs

- **VS** The plugin ctx has **no** `session.active` / `session.list` / `session.status`. The `SessionDomain` picks exactly `create, get, remove, switchAgent, switchModel, prompt, generate, command, compact, synthetic, interrupt, update, move, wait, context` + `hook` (`packages/plugin/src/promise/session.ts:153-172`; wiring `adapter.ts:577-597`).
- **VS** The full HTTP client does have `session.active()` ("foreground Session drains currently owned by this OpenCode process"), `list({parentID})`, `inbox.list`, `message.get`, `log` (`packages/client/src/promise/generated/client.ts:533-1065`; `protocol/src/groups/session.ts` `session.active`). These are reachable from a **TUI** plugin via `context.client`, not from a server plugin.
- **INF** Server plugins should track busy/idle themselves from `execution.started` / terminal events, and use `ctx.session.wait({sessionID})` (resolves immediately when idle; `packages/core/src/session/session.ts:266-269`, `run-coordinator.ts:171-176`).

---

## Q4. Driving a session from a plugin

### Exact inputs (flattened; `adaptApiMethod` decodes them with the HTTP endpoint schemas, `adapter.ts:262-278`)

**VS** Generated keys (`packages/client/src/promise/generated/types.ts`):

```ts
SessionPromptInput    = { sessionID, id?, text, files?, agents?, skills?, metadata?, delivery?: "steer"|"queue", resume? }   // :4126
SessionSyntheticInput = { sessionID, id?, text, description?, metadata?, delivery?, resume? }                                 // :4428
SessionCommandInput   = { sessionID, name, text, files?, agents?, skills?, delivery? }                                          // :4300
SessionCreateInput    = { id?, parentID?, title?, agent?, model?: {providerID,id,variant?}, location?, metadata?, permissions? } // :2918
SessionUpdateInput    = { sessionID, title?, metadata?, permissions? }                                                         // :4091
SessionInterruptInput = { sessionID, resume? }   -> { interrupted: boolean }                                                   // :4599
SessionCompactInput   = { sessionID, id?, delivery? } -> SessionInbox.Compaction                                               // :4490
SessionGenerateInput  = { sessionID, prompt }    -> { text }                                                                    // :4584
SessionWaitInput / SessionContextInput / SessionRemoveInput = { sessionID }
```

- **VS → doc bugs** In `services/www/src/docs/content/build/plugins/index.mdx`, line 765 shows `ctx.session.command({ sessionID, command: "review", arguments: "--staged" })`. The real schema requires `name` + `text` (`packages/protocol/src/groups/session.ts` `session.command` payload: `name: Schema.String, ...PromptInput.Prompt.fields, delivery`). Line 773 shows `interrupt({ sessionID, continue: false })`. The real key is `resume` (query `resume`, `SessionInterruptInput` above; host `packages/core/src/plugin/host.ts` session.interrupt passes `{ resume: input.resume }`).
- **VS** **No `agent` or `model` field on prompt.** `agents[]` are @-mentions that "do not switch the session's active agent" (`index.mdx:1311`). To change the agent for subsequent turns, call `ctx.session.switchAgent({sessionID, agent})` / `switchModel({sessionID, model:{providerID,id,variant?}})` (`protocol/src/groups/session.ts` `session.switchAgent`: "Switch the agent used by subsequent provider turns"). Each emits `session.agent.selected` / `session.model.selected`.
- **VS** `prompt` **returns immediately** with the admitted inbox item (`SessionInbox.User`); it does not wait for the turn. It "Durably admit[s] one session input and schedule[s] agent-loop execution unless resume is false." (`protocol/src/groups/session.ts` `session.prompt` description; `packages/core/src/session/session.ts:146-178`.)

### steer vs queue (inbox semantics)

- **VS** `delivery` defaults to `"steer"` for prompt, synthetic and compact (`session.ts:156, 258, 297`; `prompt.ts:47`).
- **VS** "`steer` promotes steers only (a step boundary mid-work), while `input` also allows one queued input when no steers are waiting (the idle boundary)". `packages/core/src/session/inbox.ts:43-48`.
  - **steer while busy**: injected at the next step boundary of the **current** turn. The model sees it mid-run and no new turn starts.
  - **queue while busy**: parked until the current turn ends. It is then promoted as the next turn **within the same execution** (the doorbell keeps the busy period alive). `execution.succeeded` therefore fires only after queued work drains too (`run-coordinator.ts:70-82`; `runner/llm.ts:61-66, 79-110, 159-161`).
  - **while idle**: either mode starts a new execution.
- **VS** Delivery can be changed later via HTTP `session.inbox.update` (steer "wakes session execution"), and pending items can be cancelled via `session.inbox.cancel`. **Neither is on the plugin ctx.**
- **VS** Interrupt with `resume: true` (what the TUI's Esc does) resumes **pending steer items and control items**, while "Queued next-turn prompts stay parked" (`execution.ts:153-170`; endpoint description in `protocol/src/groups/session.ts` `session.interrupt`). **Gotcha for a loop driver:** a continuation prompt admitted as `steer` just before the user presses Esc **will run anyway**. Use `delivery: "queue"` for continuation prompts, or cancel/avoid admitting until idle.

### Idempotency, synthetic, resume

- **VS** Passing `id` (`msg_…`) makes admission idempotent: `admission.reconcile` returns the existing item for the same id/type/session (`session.ts:150-158`). Docs: "Retrying an ID already pending or delivered returns the original admission without rerunning hooks" (`index.mdx:1326`). Use a deterministic id per goal iteration to make retries after a crash safe.
- **VS** `resume: false` admits **without waking** execution. This is the V2 equivalent of V1 `noReply` (`session.ts:175, 311`). The item stays pending until something else wakes the session.
- **VS** `ctx.session.synthetic({ sessionID, text, resume: false })` records a durable synthetic message. The model sees it as a **user-role** message on the next request (`packages/core/src/session/runner/to-llm-message.ts:284-285`). With the default `resume`, it wakes execution and **does** trigger a turn. The built-in Plan plugin uses `synthetic(..., resume:false)` to persist mode reminders (`packages/core/src/plugin/plan.ts:58-74, 76-95`).
- **VS** The `prompt` hook does **not** run for synthetic messages, shell messages, compaction or move controls (`index.mdx:1313-1318`). In source the hook is triggered only from `SessionPrompt.prepare` (`packages/core/src/session/prompt.ts:38-50`).
- **VS** `ctx.session.generate({sessionID, prompt})` is "transient text from the current session context without mutating session history" (`protocol/src/groups/session.ts` `session.generate`). `ctx.generate.text({ model, prompt })` uses no session at all (`index.mdx:712-721`). Both are useful for an out-of-band completion judge.
- **VS** `ctx.session.context({sessionID})` returns "the active context messages for a session (all messages after the last compaction)". This is the `Session.Message.Info` union `agent-switched | model-switched | location-switched | user | synthetic | system | skill | shell | assistant | compaction | idle`, each with `id, metadata?, time` (`packages/schema/src/session-message.ts:32-36, 295-307`). Assistant messages hold `content: (text|reasoning|tool)[]`, `finish?`, `error?`, `tokens?`, `cost?` (`:212-236`).
- **VS** `ctx.session.wait({sessionID})` resolves when this process owns no active execution for the session. It "returns immediately when idle and never starts work" (`run-coordinator.ts:27-29, 171-176`).
- **VS** `ctx.session.remove` **is** available in 2.0.22 (deletes the session and its children) (`adapter.ts:584`; `protocol/src/groups/session.ts` `session.remove`). wr-goal's note that 2.0.16 lacked it is outdated.
- **VS** `ctx.session.create({ parentID, ... })` **does** accept `parentID` in 2.0.22. With a parent, the location is inherited and `location` is ignored (`packages/core/src/plugin/host.ts:529-544`).

### Distinguishing plugin-admitted prompts

- **VS** `metadata` passed to `prompt`/`synthetic` is persisted on the inbox item and then on the projected `user`/`synthetic` message (`session-inbox.ts:15-25`; `projector.ts:609-640`). It is visible in `session.inbox.enqueued.data.item.payload.metadata`, in `ctx.session.context()` messages, and in the `prompt` hook as `event.metadata` (`prompt.ts:48, 86`). Tag continuation prompts, e.g. `metadata: { goal: { id, iteration } }`.

### Built-in loop guards

- **VS** Agent `steps` (optional `PositiveInt`): when reached, OpenCode appends `MAX_STEPS_PROMPT` and sets `toolChoice: "none"` (`packages/core/src/session/runner/llm.ts:223-240`; `runner/max-steps.ts`). The counter **resets to 1 whenever new input is promoted** (`llm.ts:172-180`; docs agents.mdx:280-288 "New user input resets the allowance"). It is per-input, not per-goal.
- **VS** Subagent nesting: depth limit `experimental.subagent_depth`, default 1 (`packages/core/src/tool/plugin/subagent.ts:129-133`).
- **VS** Restart resume is capped at 10 attempts per turn (`execution/restart.ts:18-34`).
- **VS** Retries are capped by a built-in max-attempt count that hooks cannot exceed (`index.mdx:1500`).
- **VS** There is **no** doom-loop detector and no guard against a plugin re-prompting forever (grep for doom/repeat in `packages/core/src/session` finds nothing relevant). The goal plugin must implement its own iteration/time/token budget.

---

## Q8. Ask-the-user: the `question` tool, backed by "forms"

- **VS** There is a built-in tool named **`question`** (`packages/core/src/tool/plugin/question.ts:10`). It is registered by an internal plugin `opencode.tool.question` with `options: { codemode: false }`, so it is exposed directly to the model rather than through Code Mode (`:48-58`).
- **VS** Its input schema (`packages/schema/src/question.ts:6-19`, `question.ts:23-25`):
  ```ts
  { questions: NonEmptyArray<{ question: string; header: string /* <=30 chars */; options: { label: string /* 1-5 words */; description: string }[]; multiple?: boolean }> }
  ```
  Output: `{ answers: string[][] }`. The model sees `User has answered your questions: "<q>"="<a, b>", ... You can now continue with the user's answers in mind.` (`question.ts:27-46, 98-110`).
- **VS** Tool description (`question.ts:12-21`): a **"Type your own answer" option is added automatically**; `multiple: true` allows multi-select; recommended option first with "(Recommended)".
- **VS** Each question becomes a **Form field**: key `q<i>`, `type: multiple ? "multiselect" : "string"`, `options` = labels, `custom: true` (free-text "other"). Answers are read back from `state.answer["q<i>"]` (`question.ts:119-132, 99-105`).
- **VS** Permission: it asserts `action: "question", resources: ["*"]` before asking (`question.ts:63-72`). The base policy is `*` allow, so it is **allowed by default** for build/plan/custom agents. Build and plan explicitly push `question: allow`. The **`general` subagent denies `question`** and `explore` denies everything but read tools (`packages/core/src/plugin/agent.ts:87-131`; docs permissions.mdx:197-221). A **custom subagent** (base policy) **can** ask. Forms from descendant sessions are rendered in the root session's composer (`packages/tui/src/routes/session/index.tsx:192-209`).
- **VS** Dismissal: cancel without a message dies with `QuestionTool.CancelledError` and **ends the step** (as an interruption; see Q3). Cancel *with* a message ("e.g. a non-interactive client") is returned to the model as a tool failure and the step continues (`question.ts:89-97`; `form.ts:152-153`).
- **VS** Forms are a general primitive. `Form.Info = { id: "frm_…", sessionID: string, title, metadata?, fields: NonEmpty<Field> }`. Field kinds: `string` (with `options?`, `custom?`, format/length/pattern), `number`, `integer`, `boolean`, `multiselect` (`options`, min/maxItems, `custom?`), `external` (url). Fields support `required`, `hidden`, `when` conditions. State: `pending | answered{answer} | cancelled{message?}` (`packages/schema/src/form.ts:18-163`). The `sessionID` may be `"global"` for MCP elicitations (`form.ts:124-128`).
- **VS** TUI rendering: `FormPrompt` replaces the composer while any form is pending (tabs per field, option list plus a custom-text row, multiselect toggles, external links) (`packages/tui/src/routes/session/form.tsx:1-60, 163-205`; `routes/session/index.tsx:228, 1489-1493`). A system notification "Input needs response" fires on `form.created` (`packages/tui/src/feature-plugins/system/notifications.ts:48`).
- **Programmatic use**
  - **VS** The **server plugin ctx has no `form` domain** and no ask/question API (grep in `packages/plugin/src`). `ctx.app` is only `{ name, version, channel }` (`packages/plugin/src/app.ts:1-5`), so there is no server URL to build a full client from.
  - **VS** The HTTP API has `POST /api/session/:sessionID/form` (`session.form.create`, payload `{ id?, title, metadata?, fields }`), plus `list/get/reply/cancel` (`packages/protocol/src/groups/session.ts` form endpoints). The generated client exposes `client.session.form.create/list/get/reply/cancel` (`packages/client/src/promise/generated/client.ts:1010-1065`).
  - **VS** A **TUI plugin** has `context.data.session.form.list/sync/reply/cancel/invalidate` (`packages/plugin/src/tui/context.ts:94-99`) and the full generated `context.client`. INF: it can create forms via `context.client.session.form.create(...)` and await `form.replied` / `form.cancelled`.
  - **INF** For a server plugin, the practical path is to **let the agent call `question`** (e.g. from a SKILL.md instruction), or have a TUI companion create the form.
- **V1 contrast** VS: V1 emitted `question.asked` / `question.replied` / `question.rejected` (`packages/schema/src/v1/question.ts:58-60`). V2 replaces them with `form.created` / `form.replied` / `form.cancelled`. The orca plugin maps them back (`orca-opencode2-status.js:1138-1157`).

---

## Q10. Agents and subagents

- **VS** `Agent.Info` (`packages/schema/src/agent.ts:22-55`):
  ```ts
  { id, name, model?: {providerID,id,variant?}, request: {settings,headers,body}, system?: string, description?: string,
    mode: "subagent"|"primary"|"all", hidden: boolean, color?, steps?: PositiveInt,
    permissions: { action: string; resource: string; effect: "allow"|"deny"|"ask" }[] }
  ```
  `Info.default(id)` = primary, not hidden, base ruleset `[*:* allow, external_directory:* ask, read:*.env ask, read:*.env.* ask, read:*.env.example allow]`.
- **VS** The **V1 `tools` map is gone.** Tools are gated only by permission rules, and the last matching rule wins (`packages/schema/src/session.ts:56-57`; docs permissions.mdx). Action vocabulary: `read, edit (edit/write/patch), glob, grep, shell, subagent, skill, question, webfetch, websearch, external_directory, <server>_<tool>` (MCP), `execute` (Code Mode) (permissions.mdx:104-123). V1 renames: `bash→shell`, `task→subagent`, `apply_patch→patch` (`v1-migration.bun.ts:899`).
- **VS** Built-ins (`packages/core/src/plugin/agent.ts:84-153`, `plugin/plan.ts:30-41`; docs agents.mdx:131-156):
  - `build` (default, primary)
  - `plan` (primary; edits denied except `~/.opencode/plan/*`)
  - `general` (subagent; no question, no subagent)
  - `explore` (subagent; read-only)
  - hidden primaries `compaction`, `title`, `summary`
  - `Agent.defaultID = "build"` (`packages/core/src/agent.ts:18`). "V2 has no built-in `scout` agent."
- **VS** `ctx.agent.transform(editor => editor.update(id, fn))` **upserts**. A missing id is created from `Info.default(id)` plus the global permission extras, then `fn` mutates it (`packages/core/src/agent.ts:74-85`). Other editor methods: `list/get/default(id)/remove`. A plugin can therefore define new primary or subagent agents with a `system` prompt and permissions.
- **VS** Agent per prompt: there is no prompt-level agent. Call `ctx.session.switchAgent` before prompting. The switch is persistent for later turns and emits `session.agent.selected`.
- **VS** Subagents run through the `subagent` tool. Input: `{ agent, description, prompt, model?, sessionID?, background? }` (`packages/core/src/tool/plugin/subagent.ts:29-49`). It creates a **child session with `parentID: <caller session>`** (`:186-191`). Primary-mode agents are rejected as subagents (`:136-137`). Children inherit the parent's current metadata unless the creator supplies its own (`packages/schema/src/session-metadata.ts:3-7`).
- **Ignoring child sessions**
  - **VS** `session.created.data.parentID` is set for children (`session-event.ts:59`).
  - **VS** `ctx.session.get({sessionID}).parentID` (`packages/schema/src/session.ts:31-33`).
  - **VS** The TUI context has `data.session.root(id)` / `family(id)` (`packages/plugin/src/tui/context.ts:72-75`; impl `packages/client/src/solid/data.ts:1356-1361`).
  - **VS** Session hooks (`prompt`, `context`, `compaction`, `retry`, …) fire for **every** session at the location, children included (each carries `sessionID` and `agent`).
  - **INF** A goal plugin should cache `sessionID → parentID` from `session.created` (plus `ctx.session.get` on miss) and only drive or inject into root sessions it owns.
- **VS** Session-scoped permission rules: `ctx.session.update({sessionID, permissions})` replaces the session ruleset. It is evaluated after agent rules and inherited by children at creation (`index.mdx:733-741`; `packages/core/src/plugin/host.ts:556-563`). A `permission.hook("evaluate")` can change `allow`/`ask` to anything. An explicit configured `deny` is final (`index.mdx:1620-1625`).

---

## Q11. Persistence

- **VS** `ctx.storage` is backed by the core `KV` service: a single SQLite table `kv` in the global OpenCode database (`packages/core/src/kv.ts:36-80`; `packages/core/src/kv/sql.ts:5`).
- **VS** Keys are namespaced `plugin:<hex(pluginID)>:`. They are **per plugin id only, NOT per project/location/session** (`packages/core/src/plugin/host.ts:602-623`). Values are any JSON. `scan` limit is 1..1000 (default 100) with an exclusive `after` cursor (`kv.ts:61-79`).
- **INF** Key goal state as `goal/<projectID>/<sessionID>`. Writes are last-write-wins with no CAS, so two OpenCode processes sharing the DB can race.
- **VS** Database file: `$XDG_DATA_HOME/opencode/opencode.db` (default `~/.local/share/opencode/opencode.db`). Non-prod channels use `opencode-<channel>.db`. The path can be overridden with `OPENCODE_DB` (`packages/cli/src/database-path.ts:4-13`; `packages/util/src/global-roots.ts:4-19`). Confirmed on this machine: `~/.local/share/opencode/opencode.db` exists.
- **VS** Session metadata: `Session.Info.metadata?: Record<string, Json>` is durable and opaque to core (`packages/schema/src/session-metadata.ts:3-10`; `session.ts:55`). It is writable via `ctx.session.update({ sessionID, metadata })` and **replaces the whole object** (projector sets the column, `projector.ts:576-583`). It emits `session.metadata.updated` (visible to the TUI plugin and other clients). It can be set at create (`metadata`), and children inherit it. This is a good place for a small goal pointer or status (e.g. `{ goal: { id, status, iteration } }`) that a TUI sidebar can read from `data.session.get(id).metadata`.
- **VS** Message metadata: `metadata` on `prompt`/`synthetic` persists on the message (`session-message.ts:32-36`; Q4).
- **VS** Title: `ctx.session.update({ sessionID, title })` emits `session.renamed`. Via the HTTP handler an empty title triggers regeneration (`packages/server/src/handlers/session.ts:258-270`). The plugin host calls `rename` directly (`host.ts:556-558`).
- **VS** Sharing: "OpenCode V2 does not support session sharing yet." (`services/www/src/docs/content/sharing.mdx:5`)
- **VS** Durable instruction entries: `PUT /api/experimental/session/:id/instructions/entries/:key` attaches durable per-session instruction values announced to the model at the next step boundary (`protocol/src/groups/session.ts` `session.instructions.entry.put`). They are **not on the plugin ctx**. INF: a TUI plugin could use them via `context.client`, and they survive compaction (instructions are re-baselined after compaction per `compaction.mdx:147-148`).
- **VS** No other plugin storage API exists on the server ctx. The TUI side has `context.storage.store/memory` (covered in 03).

---

## Q12. Compaction

- **VS** Settings `{ auto: true, keep: { tokens: 15000 }, buffer?: number }` (`packages/core/src/session/compaction.ts:38-44, 191`; docs `compaction.mdx:25-87`).
- **VS** Auto trigger: before **every** model step the runner calls `compaction.compact({ reason: "auto" })` (`runner/llm.ts:217-222`). It fires when the estimated context reaches the ceiling `window - (buffer ?? max(10% of window, RESERVE_MIN))` (`compaction.ts:205-206, 227-236, 893-900`). An unknown window never auto-triggers.
- **VS** Overflow recovery: one compaction plus retry when the provider rejects as too long (`llm.ts:262-270`).
- **VS** Manual compaction: `ctx.session.compact({sessionID, id?, delivery?})`. It returns the admitted inbox item and runs at the next step boundary (steer default).
- **VS** **Post-compaction continuation is built in.** Auto/overflow compaction happens *inside* the running step and the loop `continue`s with the rebuilt context (`llm.ts:217-222, 262-277`). A manual steer compaction during a busy run lets the run continue (`llm.ts:79-160`). A manual compaction at idle runs and then the execution completes (`execution.succeeded`) with no new turn.
- **VS** V2 has no `experimental.compaction.autocontinue` equivalent (`migrate-v1.mdx:169-171`).
- **VS** Events: `session.compaction.started` (`reason: "auto"|"manual"`), `.delta` (live), `.ended` (with summary `text`, `recent`), `.failed`.
- **VS** The summary uses a fixed template with `## Objective`, `## Requirements`, `## Decisions`, `## Work State` (Completed/Active/Blocked), `## Next Move`, `## Relevant Files`, `## Important Context` (`compaction.ts:101-133`). A reply missing the headings gets one nudge, then fails (`:272-290`).
- **VS** Hook `ctx.session.hook("compaction", (e) => …)`. The event is `SessionCompaction extends SessionContext`: `{ sessionID, model, agent, system: SystemPart[], messages: Message[] /* the older part being summarized */, tools, options, result? }` (`packages/plugin/src/promise/session.ts:25-48`). The summary prompt is appended **after** hooks run (`compaction.ts:272-276`; `index.mdx:1337-1339`).
  - Setting `event.result = { summary, providerState?, metadata?, tokens? }` skips the model call (`compaction.ts:581-597`).
  - **Caveat** VS: when a previous summary exists it is rebuilt from storage, "which drops a compaction hook's edits to that message" (`compaction.ts:459-460`).
- **Keeping a goal alive** (recommendation; mechanism VS, design INF):
  1. Primary: `ctx.session.hook("context", e => { if (isGoalSession(e.sessionID)) e.system.push({ type: "text", text: goalBlock }) })`. `context` runs before **every** agent-loop request, including tool continuations. System edits are not persisted, so they cannot be compacted away (`index.mdx:1336, 1356`; `session.ts:33-36`).
  2. Also register the same injection on `compaction` (push to `event.system`, e.g. "Preserve the active goal verbatim under ## Objective") so the summary keeps it.
  3. Optional persisted reminder: follow the built-in Plan plugin pattern. It reconciles per request, re-inserting a reminder into `event.messages` near the tail when compaction stripped it, and persists it once with `ctx.session.synthetic({ ..., resume: false })` (`packages/core/src/plugin/plan.ts:56-74`).
  4. Do not rely on `session.compacted`: it is not in the public stream.
- **V1 contrast** VD (in-context `migrate-v1.mdx:163`; types in section 01): V1 `experimental.session.compacting(input:{sessionID}, output:{context: string[], prompt?: string})` appended context strings or replaced the compaction prompt. V2 replaces it with the `compaction` request hook (system/messages/result).

---

## Discrepancies found (docs vs source at v2.0.22)

1. `session.idle` is used in the migration example but **never emitted** (no producer in `packages/`).
2. `ctx.session.command({ command, arguments })` is wrong in the docs. The schema is `{ name, text, files?, agents?, skills?, delivery? }`. The endpoint's success is `HttpApiSchema.NoContent` (`packages/protocol/src/groups/session.ts:417-434`), so the docs' `Promise<SessionInboxUser>` return type is also wrong. The live V2 page (https://opencode.ai/v2/docs/build/plugins, fetched 2026-10-02) shows the same wrong `command`/`interrupt` examples.
3. `ctx.session.interrupt({ continue })` is wrong in the docs. The key is `resume`, and the call returns `{ interrupted }`.
4. wr-goal's claims (2.0.16) that the ctx lacks `session.remove` and that `session.create` lacks `parentID` are **outdated** on 2.0.22.
5. INF (verify live): permission rejection or question dismissal likely ends the run as `session.execution.interrupted` with `reason: "shutdown"` (fallback reason), not `"user"`.

## Not verified

- Live behavior was not exercised; everything above is from reading source and docs at the tag.
- Location filtering of in-process plugin event subscriptions: traced in source as **unfiltered** (see Delivery guarantees), not tested with two projects open.
- Whether a plugin's continuation prompt admitted in the `execution.succeeded` handler is always picked up: by code reading, `wake` either rings the doorbell or a late doorbell starts a successor (`run-coordinator.ts:116-121, 136-145`), but this was not run.

---

# §03 — Custom tools, commands, TUI ("CLI") plugins, skills, client surfaces

Source: `anomalyco/opencode` @ tag `v2.0.22` (commit 527f0b9). Paths are repo-relative. Docs paths are the V2 docs
site source under `services/www/src/docs/content/` (published under opencode.ai docs; the older
`packages/web/src/content/docs/` tree is the V1 site).

Tags: **VERIFIED-SOURCE** (code read at the cited line), **VERIFIED-DOCS** (V2 docs source), **INFERRED**.

---

## Q5 — Custom tools

### 5.1 Definition type (Promise API, `@opencode/plugin`)

VERIFIED-SOURCE `packages/plugin/src/promise/tool.ts:11-36`

```ts
export interface ToolContext extends Omit<Tool.Context, "progress"> {
  readonly signal: AbortSignal
  readonly progress: (update: Tool.Metadata) => Promise<void>
}
export type Info<Input, Output> = Omit<Tool.Info<Input, Output>, "execute"> & {
  readonly execute: (input: <decoded Input>, context: ToolContext) => Promise<Tool.Result<Output>>
}
export interface ToolEditor {
  list(); get(id); namespace(namespace: Tool.Namespace): void
  add(tool: Info<Input, Output>): void
  update(id: string, update: (tool: Types.Mutable<Info>) => void): void   // missing IDs ignored
  remove(id: string): void
}
export interface ToolDomain { transform; reload(): Promise<void>; list(); hook: Hooks<ToolHooks> }
```

Underlying schema — VERIFIED-SOURCE `packages/schema/src/tool.ts:14-102`:

```ts
export interface Context {            // :14-20
  readonly sessionID: Session.ID; readonly agent: Agent.ID
  readonly messageID: SessionMessage.ID; readonly id: CallID
  readonly progress: (update: Metadata) => Effect.Effect<void>
}
interface BaseOptions { readonly namespace?: string; readonly permission?: string }   // :27-30
export type Options = BaseOptions & ( { codemode?: true; pinned?: boolean } | { codemode: boolean; pinned?: never } )  // :32-42
export type ValueSchema<A> = Schema.Codec<A, any> | StandardSchemaV1<any, A> | JsonSchema.JsonSchema   // :44
export class Error extends Schema.TaggedError<Error>()("Tool.Error", { message, error?, metadata? })   // :61-65
TextContent { type: "text"; text }  FileContent { type: "file"; uri; mime; name? }                    // :67-84
export interface Result<Output> { output?: <Output>; content?: string | ReadonlyArray<Content>; metadata?: Metadata }  // :86-90
export type Info = { name; input; description; execute; output?; options? }                          // :92-102
```

- **Input schema**: JSON Schema object, an Effect `Schema`, or any Standard Schema validator (Zod 4, Valibot, ArkType) — all accepted. VERIFIED-SOURCE `packages/schema/src/tool.ts:44`; runtime validation dispatches on `isStandardSchema` vs Effect vs JSON Schema in `packages/core/src/tool/runtime.ts:70-80`. With JSON Schema the TS input type is `unknown` (cast it). VERIFIED-SOURCE `packages/schema/src/tool.ts:46-52`.
- **Output schema** (`output`) is optional. If declared, `execute` MUST return `output` (else `Tool.Error("Tool did not return its declared output")`); if NOT declared, returning `output` is a defect (`Effect.die("Tool result declared output without an output schema")`). VERIFIED-SOURCE `packages/core/src/tool/runtime.ts:45-58`.
- **Return shape**: `{ content?: string | Content[], output?, metadata? }`. No `title` field (V1's `{title, output, metadata}` is gone). `metadata` is surfaced as JSON on `session.tool.success`/`session.tool.failed` events (`metadata: Schema.Record(Schema.String, Schema.Json)`). VERIFIED-SOURCE `packages/schema/src/session-event.ts:533-566`.
- **Execute context**: `sessionID`, `agent`, `messageID`, `id` (call ID), `signal`, `progress(metadata)`. **No `ask()` / permission helper and no `metadata()` setter** in the tool context. VERIFIED-SOURCE `packages/schema/src/tool.ts:14-20`, `packages/plugin/src/promise/tool.ts:11-14`, adapter `packages/plugin/src/promise/adapter.ts:618-625`. `progress()` publishes ephemeral `session.tool.progress { ...ToolBase, metadata: Record<string, Json> }` ("live replacement metadata for a running tool"). VERIFIED-SOURCE `packages/schema/src/session-event.ts:522-530`.
- **Errors**: Promise executors are wrapped in `Effect.promise` (`adapter.ts:618-625`), so a rejected promise is a *defect*, not a typed `Tool.Error`. The step runner catches `Tool.Error` per tool (`packages/core/src/session/runner/step.ts:121-126`) and marks remaining defected tools failed via `failUnsettledTools(toSessionError(...))`, then still completes the step with `needsContinuation` (`step.ts:209-216, 271-273`). So a throwing plugin tool shows as a failed tool call and the model continues. VERIFIED-SOURCE. INFERRED: returning `{ content: "error: …" }` gives you control of the model-visible text; a throw gives a generic error message.
- **Registration semantics** (VERIFIED-SOURCE `packages/core/src/tool/AGENTS.md:31-45`): transforms replay in registration order; latest valid registration for an effective name wins; disposal reveals the earlier definition; each model request captures a stable snapshot (later changes affect later requests only).
- **Effect variant** `packages/plugin/src/effect/tool.ts:8-60`: same editor; `execute` returns `Effect<Result, Tool.Error>`; only `execute.before` may fail (a `Tool.Error` rejects the call) — `ToolFailures` at `effect/tool.ts:48-52`.

### 5.2 Naming, namespaces, and Code Mode (critical for a SKILL.md)

- Effective/native name = `normalizedName` (`[^a-zA-Z0-9_-]` → `_`), prefixed `<namespace with . → _>_` when `options.namespace` is set. VERIFIED-SOURCE `packages/core/src/tool/runtime.ts:274-279`.
- **`codemode` defaults to TRUE.** Only tools with `options.codemode === false` go on the provider's native tool list; every other tool (plugin tools included) is reachable ONLY inside the single native `execute` tool (JavaScript Code Mode). VERIFIED-SOURCE `packages/core/src/tool.ts:234-260`; `packages/core/src/tool/AGENTS.md:33` ("`codemode` defaults true; `codemode: false` keeps the tool on the provider's native tool list").
- Inside Code Mode the model calls `tools.<namespace>.<name>(input)` (bracket notation for odd names) — `qualifiedName` = `namespace.name` (`packages/core/src/codemode/tool.ts:296-300`); model guidance text at `codemode/tool.ts:62-69`.
- The Code Mode catalog shown to the model has an inline budget of ~2,000 tokens (`INLINE_BUDGET = 2_000`, `packages/core/src/codemode/catalog.ts:50`). If tools do not fit, the catalog is "partial" and the model must call `search(...)` inside `execute` (`packages/core/src/codemode/instructions.ts:9-17`). `pinned: true` (only allowed with codemode true) forces a listing into the inline catalog (`catalog.ts:79-90`; the built-in `opencode` namespace uses `{ namespace: "opencode", codemode: true, pinned: true }` at `packages/core/src/tool/plugin/opencode.ts:115`). VERIFIED-SOURCE.
- Code Mode availability is the permission `execute` with resource `*`; denying it removes Code Mode entirely. VERIFIED-SOURCE `packages/core/src/tool.ts:238` (`codeModeEnabled = !whollyDisabled("execute", rules)`); VERIFIED-DOCS `tools.mdx:205-218`. Docs say the runtime has no `fetch`, but the source description says `fetch` IS available (`codemode/tool.ts:64`) — docs/source drift.
- **Design implication (INFERRED)**: goal-control tools that a skill or the continuation prompt tells the model to call by name should use `options: { codemode: false }` so they appear as native tools named e.g. `goal_complete` (with `namespace: "goal"`), or `codemode: true, pinned: true` so they are always in the inline catalog as `tools.goal.complete(...)`. Never rely on unpinned Code Mode tools being visible.

### 5.3 Permission gating

- The registry performs no authorization; `options.permission` only names the action used for whole-tool catalog filtering (default: the effective name). A tool is hidden when the last matching rule for that action is `deny` with resource `*`. VERIFIED-SOURCE `packages/core/src/tool/AGENTS.md:47-51`, `packages/core/src/tool.ts:229-231,281-284`.
- Execution-time prompts are the tool's own job (built-ins call `Permission.assert`); plugins get no assert API — only `ctx.permission.hook("evaluate")`, `list/get/reply` and session-scoped `rules`. VERIFIED-SOURCE `packages/plugin/src/promise/permission.ts:7-24`.

### 5.4 TUI rendering of tool results

- The session view switches on canonical tool name; built-ins (`shell, glob, read, grep, webfetch, websearch, write, edit, subagent, execute, patch, question, skill`) have bespoke renderers; everything else uses `GenericTool`. VERIFIED-SOURCE `packages/tui/src/routes/session/index.tsx:2392-2470`, `routes/session/message-parts.tsx:37-40`.
- `GenericTool`: one line `✓|✗ <tool> <primitive input summary>` with spinner while running; click expands `key: value` input rows and the text `output` (text content joined). `metadata` is NOT displayed. VERIFIED-SOURCE `routes/session/index.tsx:2551-2604`.
- Code Mode calls render inside the `execute` row as `› tool …` sub-rows (from progress metadata `toolCalls`); output shown only on error. VERIFIED-SOURCE `routes/session/index.tsx:3163-3230`.
- There is **no plugin API to register a custom tool renderer** in V2 TUI plugins (the context exposes only `markdown.registerCodeBlockRenderer`). VERIFIED-SOURCE `packages/plugin/src/tui/context.ts:516-532`. INFERRED workaround: return Markdown with a fenced block of a custom language and register a code-block renderer for it — but tool output in GenericTool is plain text, so this only applies to assistant Markdown, not tool rows.

### 5.5 No file-based custom tools / `tool()` helper in V2

- V2 has no `.opencode/tool(s)/*.ts` discovery and no `tool()` helper; the only way to add a tool is `ctx.tool.transform`. VERIFIED-SOURCE: no tool-directory scan in `packages/core/src/config/plugin/*` (only `command`/`commands`, `skill`/`skills` dirs are scanned) and `tools` in config is only a boolean enable map (`packages/core/src/config/normalize.ts:486-490`). VERIFIED-DOCS `build/plugins/migrate-v1.mdx:220-264` ("V1 returns a `tool` map built with the old `tool()` helper. V2 registers tool definitions through a synchronous `ctx.tool.transform` editor").

---

## Q6 — Slash commands

### 6.1 Server commands (work in every client)

VERIFIED-SOURCE `packages/plugin/src/promise/command.ts:7-26`:

```ts
export interface CommandInvocation { sessionID: Session.ID; prompt: PromptInput.Prompt; delivery: SessionInbox.Delivery }
export interface CommandDefinition { name: string; description?: string; execute: (input: CommandInvocation) => Promise<void> }
export interface CommandEditor { add(definition: CommandDefinition): void }
export interface CommandDomain extends Pick<CommandApi, "list"> { transform; reload(): Promise<void> }
```

- `prompt.text` is the text AFTER `/name` (the arguments); `prompt` also carries `files`, `agents`, `skills` from the composer. `delivery` defaults to `"steer"`. VERIFIED-SOURCE `packages/core/src/session/command.ts:11-35`.
- A command does nothing by itself: the executor must call `ctx.session.prompt(...)` (or anything else). Errors are logged and mapped to `Command.ExecutionError`. VERIFIED-SOURCE `packages/core/src/command.ts:81-89`.
- `PromptInput.Prompt = { text; files?; agents?; skills?: { id: Skill.ID; mention? }[] }` — a command executor can force-attach a skill (e.g. `skills: [{ id: "write-goal" }]`). VERIFIED-SOURCE `packages/schema/src/prompt-input.ts:22-35`.
- Registry is a `Map` keyed by name; later `add` overwrites (`editor.set`). VERIFIED-SOURCE `packages/core/src/command.ts:57-62`.
- **Precedence**: activation order is internal `pre` plugins (incl. built-in `init`, `review`, MCP prompt commands — `packages/core/src/plugin/command.ts:30-64`) → SDK plugins → user/instance plugins → internal `post` plugins, and `ConfigCommandPlugin` (markdown/JSON commands) is in `post`. VERIFIED-SOURCE `packages/core/src/plugin/internal.ts:212-266`, `packages/core/src/plugin/supervisor.ts:139-151`. ⇒ **A config/markdown command with the same name overrides a plugin's command.** (Matches wr-goal's observation.)

### 6.2 Config-file commands

- Markdown files `{command,commands}/**/*.md` under every config "directory" entry (global config dir `~/.config/opencode` and each project `.opencode/` from project root to cwd); nested paths become `/team/review`. VERIFIED-SOURCE `packages/core/src/config/plugin/command.ts:143-187`; directory entries come only from global + project `.opencode` dirs (`packages/core/src/config.ts:185-238`). `.claude/commands` is NOT loaded (INFERRED from the same: `.claude`/`.agents` roots feed only skills, `config/plugin/compatibility.ts:40-41`).
- JSON: `commands: { <name>: {...} }` in any `opencode.json(c)`. VERIFIED-DOCS `commands.mdx:49-64`.
- Fields — VERIFIED-SOURCE `packages/schema/src/config/command.ts:7-14`: `template` (markdown body), `description?`, `agent?`, `model?` (`provider/model#variant`), `subagent?`, `subtask?` (deprecated alias; `subagent` wins).
- Template semantics — VERIFIED-SOURCE `config/plugin/command.ts:189-250`: `$1..$N` positional (last placeholder swallows the rest), `$ARGUMENTS` = raw input, if neither appears the input is appended after a blank line; `` !`cmd` `` runs a shell command at evaluation time (outside tool permissions) and splices its output.
- Execution — `config/plugin/command.ts:79-135`: `subagent: true` (or agent `mode: subagent`) creates a child session (`parentID`) with "You are a subagent spawned by another session." prefix and backgrounds it; otherwise switches agent/model on the current session and calls `ctx.session.prompt({...prompt, text, delivery})`.

### 6.3 TUI keymap slash commands (client-local)

- `KeymapCommand.slash = { name, aliases?, arguments?: true }`; `run(input?, event?)`. VERIFIED-SOURCE `packages/plugin/src/tui/context.ts:384-410`.
- `/` autocomplete merges BOTH keymap slash commands and the server command list (`data.location.command.list`), sorted, not de-duplicated. VERIFIED-SOURCE `packages/tui/src/component/prompt/autocomplete.tsx:473-503`. Skills are offered under `@` (not `/`): `display: "@" + skill.id`, inserted as a `skills` attachment. VERIFIED-SOURCE `autocomplete.tsx:427-440`.
- On submit, a keymap slash command with `arguments: true` matching the head wins and runs client-side; otherwise an exact server-command name is sent via `client.api.session.command({ sessionID, name, text, files, agents, skills, delivery })`; otherwise the text is a normal prompt. Keymap slash commands cannot be queued. VERIFIED-SOURCE `packages/tui/src/component/prompt/index.tsx:176-186, 1137-1155, 1314-1330`.
- INFERRED recommendation: register `/goal` as a **server** command (`ctx.command.transform`) so it works in the TUI, web, desktop and any API client; use TUI keymap commands only for UI-only actions (open panel, toggle sidebar section).

---

## Q7 — TUI ("CLI") plugins in 2.x

### 7.1 Module shape

VERIFIED-SOURCE `packages/plugin/src/tui/plugin.ts:1-14`, `tui/index.ts:1-2`, `tui/solid.ts:1-19`:

```ts
import { Plugin, usePlugin, PluginContextProvider } from "@opencode/plugin/tui"
export type Cleanup = () => Promise<void> | void
export interface Definition { readonly id: string; readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void }
export default Plugin.define({ id: "acme.goal.tui", setup(context) { /* … */ return () => {} } })
```

- Loader requires `default` export with non-empty string `id` and function `setup`, else `Invalid V2 TUI plugin module: <spec>`. VERIFIED-SOURCE `packages/tui/src/plugin/context.tsx:694-695, 739-750`. A V1 TUI module `{ id, tui(api, options, meta) }` (as in ms-goal `src/tui.tsx:223-228`) is therefore rejected by V2. VERIFIED-SOURCE.
- `@opencode/plugin/tui` is injected at runtime (OpenTUI `ensureRuntimePluginSupport({ additional: { "@opencode/plugin/tui": {...} } })`), so local plugins need no install of it. VERIFIED-SOURCE `packages/tui/src/plugin/runtime-plugin-support.bun.ts:1-8`. That runtime TSX transform exists only on Bun; on Node "loads precompiled plugins" (`runtime-plugin-support.node.ts:1`). The installed binary is a Bun-compiled Mach-O (`/Users/keatonhoskins/.opencode/bin/opencode`, 180 MB; `packages/cli/script/build.ts:124-139` uses `Bun.build({ compile })`), so TSX works locally. INFERRED: npm/Node installs (`build:node`) need precompiled JS.
- Versions (root catalog, VERIFIED-SOURCE `package.json` catalog): `@opentui/core` 0.5.14, `@opentui/solid` 0.5.14, `solid-js` 1.9.15, `effect` 4.0.0-rc.112, `zod` 4.1.8. Plugin peer deps `@opentui/* >=0.5.14`, `solid-js >=1.9.0` (`packages/plugin/package.json`); docs example says `>=0.5.8` (`build/plugins/cli.mdx:555-558`).

### 7.2 Configuration and loading

Three sources are merged in order (VERIFIED-SOURCE `packages/tui/src/plugin/context.tsx:288-307`):

1. **Discovery**: every *subdirectory* (or symlink to a dir) of `<global-config>/plugins/` and of `.opencode/plugins/` in each dir from the VCS project root down to cwd, sorted by name. Loose files are ignored. VERIFIED-SOURCE `packages/tui/src/plugin/discovery.ts:8-53`, `packages/tui/src/util/config-directories.ts:8-29`.
2. **Server inventory**: every active server plugin whose `features.tui === true` (package or local source) — the TUI loads that package's/directory's `tui` entrypoint automatically. VERIFIED-SOURCE `context.tsx:95-104, 297-301`. `features.tui` is set when `Host.resolve()` finds a `tui` entry next to the server entry (`packages/core/src/plugin/module.ts:117-121`).
3. **`cli.json` `plugins`** (global only: `~/.config/opencode/cli.json` or `$XDG_CONFIG_HOME/opencode/cli.json`): strings or `{ package, options }`; `-id` / `-team.*` disables, `*`/`opencode.*` enable built-ins. Explicit entries are non-optional (a missing `tui` entry is reported). Entries that point to a *file* are silently skipped. VERIFIED-SOURCE `context.tsx:315-345, 362-366`; VERIFIED-DOCS `cli/plugins.mdx:5-58`, `cli/config.mdx:13-31, 357-385`.

- Entrypoint resolution (`Host.resolve`): server = `<dir>/server` then `<dir>/index`; tui = `<dir>/tui`; rpc = `<dir>/rpc` (extension inferred), or `<pkg>/server|<pkg>`, `<pkg>/tui`, `<pkg>/rpc` via package `exports`. VERIFIED-SOURCE `packages/plugin/src/host.ts:17-44`, `packages/util/src/runtime/import.node.ts:20-53`.
- **Recommended layout (VERIFIED-DOCS `cli/plugins.mdx:50-58`, `build/plugins/cli.mdx:542-563`)**: one directory `.opencode/plugins/goal/{index.ts, tui.tsx, rpc.ts}` or a package exporting `.`, `./tui`, `./rpc`.
- **`tui.json` is gone in V2**: replaced by one global `cli.json`; first V2 start migrates supported global `tui.json` settings; project-local client config is not migrated. VERIFIED-DOCS `migrate-v1.mdx:14, 517-528`; VERIFIED-SOURCE `packages/cli/src/config/migrate.ts:100-111`.
- Failures: a plugin that fails to import keeps its previous generation running; failures surface as a toast "Plugin failed: … Run /plugins to view details." VERIFIED-SOURCE `context.tsx:367-385, 472-485, 552-559`.

### 7.3 Slots — complete list (VERIFIED-SOURCE `packages/plugin/src/tui/context.ts:191-202`; host mount points verified)

| Slot path | Render input | Host location |
|---|---|---|
| `app` | `{}` | `packages/tui/src/app.tsx:1386` |
| `home.footer` | `{}` | `routes/home.tsx:107` |
| `home.footer.status` | `{}` | `feature-plugins/home/footer.tsx:95` |
| `prompt.footer` | `{ sessionID?, mode: "normal"\|"shell", showDetails }` | `component/prompt/index.tsx:1886` |
| `prompt.footer.status` | same | `component/prompt/index.tsx:1887` |
| `prompt.footer.file` | same | `component/prompt/index.tsx:1954` |
| `session.composer.top` | `{ sessionID }` | `routes/session/index.tsx:1462` |
| `session.panel` | `PanelInput { name, sessionID, width, presentation, focused, focus(), close(), toggleFullscreen() }` | `component/panel-host.tsx:37` |
| `sidebar.content` | `{ sessionID }` | `routes/session/sidebar.tsx:70` |
| `sidebar.footer` | `{ sessionID }` | `routes/session/sidebar.tsx:75` |

There are no undocumented slots beyond these ten. Claim placements: `prepend | append | before | after | replace` (exactly one; type-enforced); `replace` at an ancestor beats descendants; claims at the same anchor coexist in plugin enable order; claims at a vanished path degrade to nearest ancestor. VERIFIED-SOURCE `context.ts:180-262`. `ui.slot(claim)` returns an unregister function (`context.ts:512-513`).

Sidebar facts (VERIFIED-SOURCE `packages/tui/src/component/session-frame.tsx:105-128`, `routes/session/sidebar.tsx:13-80`, `ui/layout.ts:1`, `config/keybind.ts:95`):
- Width 42 columns; scrollable `sidebar.content`, fixed `sidebar.footer`, session title at top.
- Auto-shown only when terminal width (minus vertical tabs) > 120 cols and `cli.json` `session.sidebar` is `"auto"` (default); **never shown for child sessions** (`parentID`); toggle `session.sidebar.toggle` = `<leader>b`; an open `session.panel` or terminal pane takes the right pane.
- Built-in sidebar contributions are themselves V2 TUI plugins (`feature-plugins/sidebar/context.tsx:44-52`, `mcp.tsx`, `footer.tsx`), registered in `packages/tui/src/plugin/builtins.ts:15-31` — a good reference implementation.

INFERRED: for a richer goal UI than the 42-col sidebar, use `session.panel` (host-managed side panel / fullscreen, opened via `context.ui.panel.open("goal.panel")`) plus a compact `sidebar.content` summary and `session.composer.top` banner.

### 7.4 Context API surface (VERIFIED-SOURCE `packages/plugin/src/tui/context.ts:516-532`)

```ts
interface Context {
  options: Readonly<Record<string, any>>; location: LocationRef | undefined; app: { version; channel }
  renderer: CliRenderer; client: OpenCodeClient; data: Data; attention: Attention
  theme: ResolvedTheme; themeMode: "dark" | "light"
  markdown: { registerCodeBlockRenderer(language, render): () => void }
  keymap: Keymap; storage: Storage; ui: UI
}
```

- `data` (`context.ts:63-140`): `on(type, handler)` typed per server event type, `listen(handler)` for all; `session.{list,get,root,family,cost,status(): "idle"|"running", sync, invalidate, pending.*, message.{list,get,sync,invalidate}, permission.*, form.{list,sync,invalidate,reply,cancel}}`; `project.*`, `shell.*`, `location.{default, sync, invalidate, vcs.*, agent|command|integration|mcp.server|mcp.resource|model|provider|reference|skill: {list,sync,invalidate}}`. `session.root(id)`/`family(id)` are the way to collapse subagent sessions.
- `ui` (`context.ts:462-514`): `dialog.{show,set,clear,alert,confirm,prompt,select}`, `toast.show({title?, message, variant?, duration?, sessionID?})`, `format.path`, `router.{register(page), navigate(dest), current()}`, `panel.{open(name,{presentation?}), close(), current()}`, `tabs.{enabled,list,open,focus,move,close}`, `model.{current(), variant.{list,set}}`, `slot(claim)`.
- `keymap` (`context.ts:384-460`): `layer(() => KeymapLayer)`, `dispatch(id, input?)`, `shortcuts(id)`, `commands()`, `pending()`, `active()`, `mode.{current, push}`. `KeymapCommand { id?, title?, description?, group?, enabled?, bind?: false|string, palette?: true, slash?: {name, aliases?, arguments?: true}, suggested?, run(input?, event?) }`.
- `attention.notify({ title?, message, notification?, sound?: { name?: "default"|"question"|"permission"|"error"|"done"|"subagent_done", volume?, when? } })`. `context.ts:284-325`.
- `storage` (`context.ts:31-53`): `store(key, {initial})` → `[Store, async update]` durable JSON, survives restarts and live-syncs across TUI instances; `memory(key, {initial})` survives hot reloads only. Backed by files `<XDG_STATE_HOME or ~/.local/state>/opencode/<channel>/tui/plugin.<id>.<key>.json` (VERIFIED-SOURCE `packages/tui/src/context/storage.tsx:41-57,146`; `packages/util/src/global-roots.ts:8-16`; app name `opencode` INFERRED). **Keys and plugin IDs must match `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`** or it throws (`storage.tsx:41-45` with `plugin.${id}.${key}` at `packages/tui/src/plugin/api.tsx:172-174`). This is TUI-local and separate from server `ctx.storage`.
- `context.client` is the full generated `OpenCodeClient` (`host.client.api`, `api.tsx:143`) and includes `client.rpc(Def)` (`packages/client/src/promise/client.ts:10-15`) and the experimental `client.session.skill({sessionID, id, resume})` (`packages/client/src/promise/generated/client.ts:751-760`).

### 7.5 Lifecycle and hot reload

- `setup` may return a cleanup; on setup failure owned registrations are disposed and the error is reported (`context.tsx:636-643`). Slots/routes/keymap layers/markdown renderers registered through the context are cleaned up with the plugin.
- Local plugin sources are watched (parent-directory watches, dependency graph tracked); a save re-imports only changed graphs and restarts only changed plugins; `storage.memory` state is shared across generations. VERIFIED-SOURCE `packages/tui/src/plugin/watch.ts:5-60`, `packages/plugin/src/source.ts:8-46`, `context.tsx:270-280, 506-513`. Package plugins are not re-resolved within a session (`context.tsx:659-661`).
- Only the full TUI app mounts `PluginProvider` (`packages/tui/src/app.tsx:217`); `opencode mini` and `opencode run` do not (INFERRED from grep: no other mount).

### 7.6 TUI ↔ server plugin communication

- **Shared event stream**: `context.data.on(type, …)` / `listen` receive every public server event; server plugins cannot publish arbitrary events (`ctx.event` is subscribe-only). VERIFIED-SOURCE `context.ts:63-68`; `packages/plugin/src/promise/event.ts` (subscribe only per docs `build/plugins/index.mdx:1261-1269`).
- **Plugin RPC (the supported channel)**: define `Rpc.define({ id, methods: { name: { input?, output?, errors? } }, events: { name: { schema } } })` with JSON Schema or Standard Schema; server registers `ctx.rpc.register(Def, handlers)` → returns `{ dispose(), events.emit(name, data) }`; TUI calls `context.client.rpc(Def).method(input)` and subscribes `context.client.rpc(Def).events.on(name, cb)` (or `data.on("rpc.<id>.<name>")`). Event data must be an object; events are live-only (missed while disconnected); each event carries `location`. VERIFIED-DOCS `build/plugins/rpc.mdx:1-231`; VERIFIED-SOURCE `packages/plugin/src/promise/rpc.ts:7-31`, `packages/client/src/promise/rpc.ts:6,23-46,58-146` (`type: rpc.${id}.${name}`).
- **Legacy `tui.*` events** (`tui.prompt.append`, `tui.command.execute`, `tui.toast.show`, `tui.session.select`) still exist in the schema and the TUI still listens (`packages/schema/src/tui-event.ts:11-60`, `packages/tui/src/app.tsx:1265`, `component/prompt/index.tsx:342`), but no V2 server endpoint or plugin API publishes them (grep of `packages/server`, `packages/core`: no publisher). VERIFIED-SOURCE (absence by grep) — do not rely on them.
- **Storage is not shared**: server `ctx.storage` (server-side, per plugin id) vs TUI `context.storage` (client-side files). INFERRED: the TUI should read goal state via an RPC method + RPC change events, and re-sync on reconnect because events are live-only.

### 7.7 Version history

From GitHub release notes (`gh api repos/anomalyco/opencode/releases`, saved to `scratchpad/research/releases.jsonl`; VERIFIED-DOCS = release notes):
- v1.3.4 (2026-03-29): "Add TUI plugins support", "Add prompt slot feature", "Add single target plugin entrypoints".
- v1.3.11 (2026-03-31): plugins without a matching server or TUI entrypoint are skipped with a warning.
- v1.14.42 (2026-05-09): "Simplified TUI keybinding config into a flat keybind format."
- v1.14.45 (2026-05-10): "TUI plugins using the deprecated `api.command` API keep working while you migrate to `api.keymap`." (This is the keymap migration; I found no 1.16-specific keymap note. ms-goal's comment claims `api.keymap.registerLayer` for ">= 1.16" — UNVERIFIED.)
- v1.15.11 (2026-05-27): "Added a `dispose` hook for plugins."
- v1.17.10 (2026-06-24): "Added namespaced plugin hook APIs." and "Added the V2 plugin API for Effect and Promise plugins." (so the V2 server API shape predates 2.0).
- Latest GitHub release is v1.18.34 (2026-09-30); **no v2.x entries exist on the GitHub releases list** even though tags v2.0.0–v2.0.22 exist. VERIFIED (release list).
- V1 TUI API (from ms-goal, `@opencode-ai/plugin/tui` ^1.17.3): default export `{ id, tui: async (api, options, meta) => {} }`; `api.slots.register({ order, slots: { sidebar_content(ctx, props) {…} } })` with snake_case slot names and `props.session_id`; `api.keymap.registerLayer({ commands: [{ name, title, category, namespace: "palette", enabled, run }] })` or deprecated `api.command.register(() => [...])`; `api.lifecycle.onDispose`; `api.route.current` (`name`, `params.sessionID`); `api.ui.toast({...})`, `api.ui.dialog.{setSize,replace,clear}`; `api.theme.current.{primary,textMuted}`; `api.state.path.{worktree,directory}`. VERIFIED-SOURCE `scratchpad/repos/ms-goal/src/tui.tsx:1-228`. V2 renamed/reshaped all of this (`setup(context)`, dotted slot paths, `context.keymap.layer`, `context.ui.toast.show`, `context.theme.text.base`, cleanup return). INFERRED: a single package can carry both only by exporting an object with `id`, `tui` (V1) and `setup` (V2) from its tui entry — undocumented for TUI, and the V2 entry imports `@opencode/plugin/tui`, which V1 does not provide at runtime, so keep separate entrypoints/versions.

---

## Q9 — Skills

- **Discovery** (VERIFIED-SOURCE `packages/core/src/config/plugin/skill.ts:77-147`, `config/plugin/compatibility.ts:37-60`, `config/discovery.ts:23-83`; VERIFIED-DOCS `skills.mdx:39-62,161-179`):
  - `<dir>/skill/` and `<dir>/skills/` for every config directory entry: global `~/.config/opencode` and each project `.opencode/` (root → cwd).
  - Compatibility: `~/.claude/skills`, `~/.agents/skills`, and project `.claude/skills`, `.agents/skills` at every ancestor level.
  - Extra `skills: [...]` config entries: relative (to working dir), `~/`, absolute, or `http(s)://` catalog with `index.json`.
  - Scan pattern `{*.md,**/SKILL.md}`: root-level `*.md` files AND `SKILL.md` at any depth; symlinks followed; watched with 100 ms debounce, reloaded on change and on `config.updated`.
  - Precedence (later wins, by ID): built-ins → `.claude/skills` → `.agents/skills` → `~/.config/opencode/skills` → project `.opencode/skills` → explicit `skills` entries. Config skill plugins are in the internal `post` list, so **file skills override plugin-registered skills with the same ID** (`plugin/internal.ts:249-266`).
- **ID** = directory name for `SKILL.md` (or file stem for root `*.md`); frontmatter `name` is only a display label; IDs are case-sensitive and not validated against the agentskills.io pattern. VERIFIED-SOURCE `config/plugin/skill-file.ts:40-43`; VERIFIED-DOCS `skills.mdx:143-159`.
- **Frontmatter actually parsed**: `name?`, `description?`, `metadata?` — and from metadata only `opencode/autoinvoke` (boolean or "true"/"false"). VERIFIED-SOURCE `skill-file.ts:9-13, 44`. Other keys (`license`, `compatibility`, `allowed-tools`, …) are ignored. Docs also describe `slash: false` and `metadata.opencode/slash` (`skills.mdx:115-141`) but **no source parses them** (grep for `opencode/slash` finds nothing) — docs/source drift.
- `Skill.Info = { id, name, description?, autoinvoke?, path: AbsolutePath, content }`. VERIFIED-SOURCE `packages/schema/src/skill.ts:26-34`.
- **Tool**: native tool `skill` (`codemode: false`), input `{ id }`, permission action `skill` with the skill ID as resource; output wraps the body in `<skill_content name=…>`, appends "Base directory for this skill: <dir>" and up to 10 sampled sibling files (only for `SKILL.md` skills). VERIFIED-SOURCE `packages/core/src/tool/plugin/skill.ts:10-72`, `packages/core/src/skill.ts:36-68`.
- **Advertising**: each model step lists permitted skills that have a `description` and `autoinvoke !== false` (ID, name, description only). VERIFIED-DOCS `skills.mdx:181-200`.
- **User invocation**: `@<skill-id>` in the TUI composer attaches `prompt.skills`; a server command executor can attach skills to the prompt it submits; `client.session.skill({ sessionID, id, resume })` (experimental endpoint `/api/experimental/session/:id/skill`) activates a skill directly and publishes `SessionEvent.Skill.Activated`. VERIFIED-SOURCE `autocomplete.tsx:427-440`, `packages/schema/src/prompt-input.ts:22-35`, `packages/core/src/session/session.ts:224-245`, `packages/client/src/promise/generated/client.ts:751-760`. Note the plugin `ctx.session` domain does **not** include `skill` (`packages/plugin/src/promise/session.ts:153-172`); a TUI plugin can call it via `context.client`.
- **Plugins can ship skills**: `ctx.skill.transform(editor => editor.add({ id, name, description, path, content }))`. VERIFIED-DOCS `build/plugins/index.mdx:815-868`. `path` drives the "base directory" shown to the model (`skill.ts:55-67`), so point it at a real directory if the skill references bundled files.
- **Telling the agent to call a plugin tool from a SKILL.md** (INFERRED from 5.2): name the exact native tool when the tool is `codemode: false` (e.g. "call the `goal_create` tool"), or give the exact Code Mode path when it is a pinned Code Mode tool ("inside `execute`, call `await tools.goal.create({...})`"). Unpinned Code Mode tools may be absent from the inline catalog, so the skill would have to tell the model to `search(...)` first. The built-in `question` tool (selectable options) is a native tool usable from a skill body; see the session section for its schema.

---

## Q13 (client-surface part)

- **Topology**: by default every local client (TUI, `run`, web, desktop) connects to one shared background server per user account, which owns sessions, config, permissions and tool execution; `--standalone` runs a private server; `--server <url>` connects to a remote one. VERIFIED-DOCS `cli/index.mdx:46-69`; VERIFIED-SOURCE `packages/cli/src/services/server-connection.ts:21-50`, detached spawn `packages/client/src/service-contender.ts:19-41`. ⇒ **Server plugins run in that long-lived service process (once per location), not in the TUI**; TUI plugins run inside each TUI process (N TUIs ⇒ N instances). INFERRED: a server-side continuation loop keeps running after the TUI closes, unless it checks for attached clients.
- **Web / desktop**: they do not load `@opencode/plugin/tui` plugins. The app uses built-in GUI extensions (`packages/gui-extensions/AGENTS.md`: "`src/renderer.ts` and `src/main.ts` are the only files that list the built-ins"); third-party `.ocdx` desktop extensions are "groundwork … the renderer loads built-ins until that format ships renderer bundles, and packaged builds refuse the manager" (`packages/desktop/src/main/extension/manager.ts:10-14`). VERIFIED-SOURCE. Server plugins (tools, commands, hooks, RPC) DO apply to web/desktop sessions because they run in the server. INFERRED: the goal UI in web/desktop is limited to what server-side surfaces show (commands in the composer, session title, tool rows).
- **Headless `opencode run`** (VERIFIED-SOURCE `packages/cli/src/run/noninteractive.ts`):
  - Submits the message as a plain `session.prompt({ text, files, delivery: "steer" })` — **no slash-command routing and no `--command` flag** in V2 (`noninteractive.ts:716-726`; `opencode run --help` on the installed v2.0.22 lists no `--command`). A plugin can still intercept `/goal …` text via `ctx.session.hook("prompt")`.
  - The event consumer returns on the first `session.execution.succeeded`/`failed`/`interrupted` for the session after promotion (`noninteractive.ts:524-546`); the main path awaits `client.session.wait({ sessionID })` racing that consumer, then finalizes and exits (`noninteractive.ts:762-787`). `Session.wait` = `awaitIdle`, which re-checks for a successor execution started by a "late doorbell" (`packages/core/src/session/run-coordinator.ts:169-176`). INFERRED: a server plugin that re-prompts asynchronously on `session.execution.succeeded` races `run`'s exit; follow-up turns may still execute in the background service after `run` exits, but their output will not be printed. Headless auto-continue is therefore unreliable unless the plugin admits the follow-up before the execution settles (e.g. from inside the turn) or the caller uses `--session` repeatedly.
  - Permissions: without `--auto`, permission requests are auto-rejected with model-visible feedback; `question` forms are cancelled with feedback so the model continues. VERIFIED-SOURCE `noninteractive.ts:160-206`.

## Could not verify

- Exact V2 release date for v2.0.0 and when `@opencode/plugin/tui` (V2 TUI API) first shipped — GitHub releases list has no v2 entries.
- The "1.16 keymap migration" claim (only the 1.14.42/1.14.45 notes were found).
- Runtime behavior (no live host run): sidebar rendering of a third-party slot, RPC event delivery latency, headless race outcome.
