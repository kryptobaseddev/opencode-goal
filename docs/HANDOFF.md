# Handoff — opencode-goal

Written 2026-10-02, refreshed 2026-10-03 after v0.2.0 (the reworked dogfood goal, runs `0ffe5ac6e001` → `10388d06d001`). Read this first, then `AGENTS.md` (project guide below the CLEO block), then [design.md](design.md) (proposal + as-built for v0.1 and v0.2, including both council decision records).

## 1. Where things stand

| | |
|---|---|
| Repo | https://github.com/kryptobaseddev/opencode-goal (public, MIT), local `~/projects/opencode-goal` |
| Released | `v0.2.0` (commit `06d9bfc`) — tag on GitHub, no npm package |
| Installed | **Still `v0.1.0-alpha.1` in the owner's OpenCode** — the v0.2.0 reinstall is the pending owner action (§8); the dogfood run `10388d06d001` is one re-claim from completion once v0.2.0 is installed |
| Tests | 82 pass (`bun test`, ~70 s): unit + 31 host scenarios on a real `opencode serve` 2.0.22, incl. verifier-reliability (fallback), rehearsal, amend, archive, supersede, paths |
| Docs | [design.md](design.md) (as-built v0.1 + v0.2 with council records) · [dogfood-1.md](dogfood-1.md) · [dogfood-2.md](dogfood-2.md) · [spikes.md](spikes.md) · [opencode-store-probe.md](opencode-store-probe.md) · [cleo-evidence-repro.md](cleo-evidence-repro.md) |
| CLEO | Saga T001 › epics T002 (v0.1 + defects), T024 (v0.3 identity/surfaces), T035 (integrity model), T039 (hardening/release) — all tasks complete with evidence atoms except the four that close with the run itself (T012, T017/T018, T022). Council transcripts under `.cleo/council-runs/`. |

Important: the installed copy is the **pinned tag**, not this working tree. Editing the repo changes nothing in your OpenCode until you cut a new tag and reinstall it (§8). That is deliberate — the owner asked to install and iterate through versions like a real user.

## 2. What the owner asked for (intent)

1. Study two community goal plugins (william-ricchiuti/OpenCode-goal-plugin, martsallan/goal-opencode) and OpenCode's plugin system — especially OpenCode 2 — and "push the limits" to build our own, better OpenCode goal plugin.
2. A **goal mode**: persistent objectives, auto-continuation, completion detection, and an enhanced live TUI sidebar.
3. A **write-goal** skill: a "grill me" interview through the ask tool with selectable options, planning without an explicit plan mode, producing a structured, **non-prose** goal document plus supporting files, which then flows into the goal loop.
4. Use Kimi Code's write-goal skill, goal prompt and options as references; package it properly with `skill-forge` and `skill-creator`.

### Owner decisions (all through the ask tool, 2026-10-02)

| Question | Answer |
|---|---|
| Where the plugin lives | Standalone repo; include the write-goal skill in it; avoid npm if git install works (it does) |
| OpenCode versions | OpenCode 2 only |
| Default completion strictness | Host checks + read-only verifier |
| First step | Spikes, then MVP |
| Install scope | Global — then refined: **install from the GitHub repo like a real user**, iterate through versions |
| Repo visibility | Public |

Owner working rules that apply to every session (from `~/.claude/CLAUDE.md` and the CLEO block in AGENTS.md): every owner decision goes through the ask tool with concrete options, recommended first; no routine status chatter; subagents never ask the owner; every commit references a CLEO task (hooks enforce it); record verification evidence before `cleo complete`.

## 3. Where everything came from

Full reports are in [research/](research/README.md). The short version:

- **OpenCode 2 is a different plugin API.** V2 (`@opencode/*`, tagged 2026-09-11) only loads `export default { id, setup(ctx) }`; V1 plugins do not load. `session.idle`/`session.status` are never emitted — the turn signal is `session.execution.succeeded|failed|interrupted`. Plugin tools are hidden in Code Mode unless `codemode: false`. V2 has no todo tool. The TUI has 10 named slots, dialogs, toasts, desktop attention and a server↔TUI RPC channel. The public docs page for plugins still describes V1.
- **martsallan/goal-opencode** — does not load on 2.x at all; completion logic inverted (marker clears only an unfinished goal); no budgets; file-polling sidebar. Kept: hidden trigger + request-time prompt, objective-as-untrusted-data, recovery prompt.
- **william-ricchiuti/OpenCode-goal-plugin** — strong engineering (durable continuation claims, epochs, cache-stable system block, recover-paused, read-only verifier, 490 tests) but text-marker completion, a verifier that cannot run tests, budgets that reset on resume, every `/goal status` a paid model turn, and no UI on V2. Kept: claims/epochs idea, cache discipline, recover paused, verifier lockdown, fixture-provider host testing.
- **Prior art** — Codex `/goal` (status machine, completion-audit prompt, but self-declared completion and spin-loop cost), Claude Code `/goal` (independent judge with met / not met / impossible, deferral while subagents run), Ralph (fresh context, backpressure via tests), oh-my-openagent (verification gates, define-goal guide), **@bybrawe/opencode-goal** (strongest V2 competitor: host-run checks + read-only verifier with re-read quotes; plain-text sidebar), research on false completion (45-76% of failures; transcript judges fooled by confident prose).
- **Kimi Code** — write-goal discipline (ask don't narrate, proof not effort, five-part contract, budgets opt-in), headless exit codes 0/3/6.

## 4. Design — the goal plugin

Full spec: [design.md](design.md) (proposal + an "As built" table of deviations). The ten rules it is built on:

1. The contract is written and **locked** (sha256) before work; the worker can never edit it.
2. The worker **claims**; the **host proves** (host-run checks, then a read-only verifier whose quotes the host re-reads).
3. Progress = **authoritative state change** (git worktree fingerprint, criterion transitions, plan steps), not activity.
4. **Waiting costs nothing** (`goal_wait`), and nothing polls.
5. The goal is **rendered from disk into every request** (system block via the `context` hook), so compaction cannot lose it.
6. **Status is rendered by the UI**, never by a paid model turn.
7. **Questions happen before the loop**; during it they are deferred.
8. **Cache-stable prompts**: byte-identical system block per run; volatile status in a per-turn note before the turn's prompt.
9. The owner's **verbatim words** stay authoritative.
10. **Fail closed, feed back**: a rejected claim returns a HOST VERDICT and the loop keeps working.

### How a goal runs

```
.opencode/goals/<slug>/goal.yaml  ──/goal start <slug> or goal_start──▶  run.json (running)
   kickoff prompt ─▶ worker turn ─▶ session.execution.succeeded
      ├─ claim pending?  → verify: integrity → host checks → verifier (child session) → complete | HOST VERDICT turn
      ├─ blocker ×3      → blocked
      ├─ budget ≥100%    → one wrap-up turn → budget_limited
      ├─ no change ×3    → paused (recovery prompt at ×2)
      ├─ goal_wait       → waiting → timer → continue
      └─ otherwise       → cooldown 1.5 s → continuation prompt (deterministic id)
   Esc → paused · question dismissed → paused · provider error → retry ×3 / paused · reload → paused
```

State machine: `running ⇄ waiting`, `running → verifying → complete | running`, stop states `paused · blocked · needs_review · budget_limited`, terminal `complete · failed · aborted`. The worker may only progress, claim, block, flag and wait; only the owner resumes, pauses, aborts, approves.

## 5. Design — the write-goal skill

`skills/write-goal/` (v0.1): SKILL.md + `references/goal-schema.md`, `references/interview.md`, `assets/goal.template.yaml`, `evals/trigger_queries.json`. The plugin registers it (`ctx.skill.transform`), and `/goal new <words>` sends the owner's words with the skill attached.

Flow: **Seed** (verbatim words, slug) → **Recon** (facts and a baseline run of the checks, written to `context.md`; ask nothing the repo can answer) → **Classify** (bugfix / feature / refactor / migration / perf / research / ops / docs → criterion templates) → **Grill in frontier rounds** (≤4 questions per ask call, recommended first, decisions logged to `decisions.jsonl`, everything unasked becomes a vetoable assumption) → **Draft** `goal.yaml` and validate with `goal_validate` → **Review** the exact contract → **Launch** with the option labelled exactly `Start goal now`, which is what makes `goal_start` accept.

The contract format is `goal/v1` — see the skill's SKILL.md for the essentials and `src/contract/parse.ts` for every rule.

## 6. What is built (file map)

```
server.ts · tui.tsx · rpc.ts      root entries (OpenCode resolves these for local dirs; package exports point here)
src/contract/types.ts             goal/v1 types; check kinds
src/contract/parse.ts             YAML (Bun.YAML) → Contract; every validation rule; YAML colon hint
src/contract/render.ts            system block (byte-stable), per-turn tail note, trigger text
src/engine/state.ts               RunState, status rules, owner/worker permissions, budget use
src/engine/store.ts               goal folder I/O: run.json (atomic+fsync), ledger.jsonl, evidence/
src/server/app.ts                 the engine: recovery, events, admission, guards, verification, tools, /goal, hooks, RPC
src/server/index.ts               V2 plugin definition; retires a previous instance (setup can run twice)
src/verify/pipeline.ts            host checks, quote re-read, verifyClaim()
src/util/{git,shell,ids}.ts       worktree fingerprint, login-shell runner, native ascending ids
src/rpc.ts                        GoalRpc (snapshot/list/act + updated/notice events), GoalView
src/tui/index.tsx · format.ts     sidebar card, footer pill, composer banner, notices, palette commands
skills/write-goal/                bundled skill
test/unit/                        contract rules, state permissions, store, TUI formatting (snapshot)
test/host/harness.ts              isolated `opencode serve` + scripted OpenAI-compatible fixture provider
test/host/goal.test.ts            8 end-to-end scenarios (see §7)
test/host/git-install.test.ts     opt-in: installs a git tag into an isolated OpenCode
spikes/                           S1-S9 probe plugin + pty TUI capture; results in docs/spikes.md
scripts/tui-smoke.ts              holds a paused goal for a real TUI to attach (with spikes/tui-capture.py)
```

## 7. Verification evidence

- **End to end on OpenCode 2.0.22 (fake model):**
  - false claim → HOST VERDICT → fix → host checks + verifier quote re-read → complete (the verifier saw only read/glob/grep/goal_verdict; the worker never saw `goal_verdict`; the owner's `/goal` text never reached the model);
  - status and pause cost zero model requests; resume sends exactly one continuation;
  - Esc pauses and nothing follows;
  - three talk-only turns stall the goal (`kickoff, continue, recovery`);
  - the same blocker three turns in a row blocks it;
  - questions are deferred and protected files cannot be written;
  - a reload brings a running goal back paused;
  - the plugin registers write-goal and `/goal new` attaches it.
- **Real TUI** (2.0.22 in a pty): goal card in the sidebar and the "Goal paused … /goal resume" banner rendered.
- **Git install**: an isolated OpenCode installed `github:kryptobaseddev/opencode-goal#v0.1.0-alpha.1` and registered `/goal` and the skill; then the same tag was installed for real.
- Spikes S1-S9: [spikes.md](spikes.md).

## 8. How to use it and how to ship a new version

Use (in any project, now that it is installed):

1. `/goal new <what you want done>` — the write-goal interview; it ends by asking to start (pick `Start goal now`).
2. Or write `.opencode/goals/<slug>/goal.yaml` by hand and run `/goal start <slug>`.
3. Watch the sidebar card (shown above 120 columns) or the pill under the prompt. `/goal status`, `/goal pause`, `/goal resume`, `/goal verify`, `/goal abort`, `/goal approve C3`, `/goal list`, `/goal validate <slug>`; the same actions are in the command palette under "Goal".
4. Everything a run did is in `.opencode/goals/<slug>/ledger.jsonl` and `evidence/<run>/`. Consider adding `.opencode/goals/*/run.json`, `ledger.jsonl` and `evidence/` to the project's `.gitignore`.

Ship a new version (the iteration loop the owner asked for):

```bash
bun test                                     # all green, incl. host suite
# bump package.json "version", add a CHANGELOG entry, commit with a task id
git tag -a v0.1.0-alpha.2 -m "opencode-goal 0.1.0-alpha.2" && git push origin main --follow-tags
OCGOAL_GIT_INSTALL=1 OCGOAL_GIT_SPEC="github:kryptobaseddev/opencode-goal#<new-tag>" bun test test/host/git-install.test.ts
# ENGINE-VERSION RULE (dogfood-2 §7): if any goal is running that verifies this
# plugin itself, reinstall BEFORE its completing claim — the verifier runs the
# INSTALLED engine, not the tree you just tagged.
opencode plugin remove "github:kryptobaseddev/opencode-goal#v0.1.0-alpha.1"
opencode plugin add "github:kryptobaseddev/opencode-goal#v0.1.0-alpha.2"
opencode reload && opencode plugin list      # expect opencode-goal at the new commit
```

Uninstall: `opencode plugin remove "github:kryptobaseddev/opencode-goal#<tag>"` and `opencode reload`.

## 9. What is left (2026-10-03, post-v0.2.0)

| # | Work | Where |
|---|---|---|
| 1 | **Install v0.2.0** (`opencode plugin remove …#v0.1.0-alpha.1` → `add …#v0.2.0` → `opencode reload`), then `/goal resume` and let run `10388d06d001` re-claim — it is one verifier round from complete, and the reinstall is the documented fix for its C18 (the installed engine judges the verifier round; see dogfood-2 §7). | owner |
| 2 | Close the run with the goal: CLEO T012, T017/T018, T022 complete with the final verdict as evidence. | worker, after #1 |
| 3 | Remaining backlog (small): provider-error *injection* in the harness (needs an owner-approved harness change — protected file); tui-smoke panel probes are in; consider awesome-skills publication of write-goal. | next session |
| 4 | Not built from the design (unchanged): standalone-server lease, relay mode, goal queues, home-screen board, Claude Code / Codex adapters, headless runner (§9.6 remainder). | backlog |

Known limitations unchanged: nine `goal_*` tools in every session's prompt; plugin reload pauses running goals (by design — and the paused recovery is now dogfood-verified); host checks run in the owner's login shell (contracts are owner-authored code).
## 10. Picking up in OpenCode

```bash
cd ~/projects/opencode-goal && opencode
```

Then, in the session: run `cleo briefing` and `cleo session start --scope global --name "opencode-goal: real-model dogfood"`, read this file and `AGENTS.md`, and start with §9 item 1. Run `bun test` before and after changes; ship through §8. The research and spike docs answer most "how does OpenCode 2 do X" questions — check `docs/research/opencode2-plugin-api.md` before reading OpenCode source, and trust `docs/spikes.md` over any doc.
