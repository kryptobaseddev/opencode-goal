# Changelog

## 0.3.0 — 2026-10-05

The feedback-loop release: every decision persistent, actionable, visible. Built and proven under the goal loop itself (dogfood-3).

- **Fixed: the verifier child's silent empty exchange (T044)** — the root cause of all four dead verifier rounds on the main host. The child request now carries an explicitly resolved model (the parent session's live model, then the location default; recorded as a `verifier-model` ledger event), and an entirely empty exchange is retried once with an explicit last-chance prompt and always recorded (`verifier-empty` rounds, `empty after N round(s)` verdict detail) — never silent.
- **Post-goal summary (T045)** — on complete / needs_review / budget_limited the engine builds a summary from data the run already has: per-criterion outcomes with provenance (owner-approved and fallback-passed carry explicit caveats), the scope audit, restated non-goals, mid-run findings from the ledger, and follow-up prompts including the CLEO-install suggestion when the project has no `.cleo` workspace. Rendered as a `summary` rpc event + TUI dialog, a `goal.summary` transcript row, and a persisted evidence document.
- **Flagged completion scope audit (T046, owner decision)** — plan steps with `proves: []` and no recorded work, and `scope.in` lines mapping to no criterion, surface in the summary as *discussed but unproven*. Completion is never blocked by them (deliberately loose plans must not deadlock).
- **Owner-final beats host re-checks too (T057)** — the T051 fix covered the verifier only; the live C15 stomp came from a HOST re-check failing a stale needle after the owner approved it. Criteria passed `by: human` are now skipped by host re-verification as well and recorded as *approved by the owner (final)*.
- **Goals escape their session (T049)** — owner actions fall back to the project's unique non-terminal goal from any session (`/goal approve C4 [slug]`), and `/goal attach <slug>` moves a stopped goal into the current session (live goals wait for their turn to end). The RPC list carries attachable flags; the palette gains "Goal: attach/switch to a goal".
- **Decision dialogs at every decision point (T050)** — needs_review, paused-after-verdict, blocked, budget_limited, amend-proposed, supersede-ack and complete each emit a decision payload (kind, cause, structured choices); the TUI renders it as a selectable dialog wired to `rpc.act`. Nobody types an approval by hand.
- **Actionable message content (T054)** — one message registry: every engine notice carries the cause plus concrete choices, rendered inline for toasts and attached as structured choices for dialogs. A unit suite pins that no notice is actionless.
- **Persistent terminal feedback (T052)** — verdicts, owner actions, amendments, blocks, budget stops and completions land as transcript notice rows the agent sees next turn (queued rows deliver on the session's next turn), and an action-required state rides the sidebar view until the status resolves.
- **Live activity tracer (T053)** — the engine records what it is doing (turn, verifying, verifier child with its model, waits with countdowns, cooldowns); a pure formatter renders it with elapsed time above the composer and in the panel. Snapshot-tested; zero model cost.
- **Dashboard rework (T056)** — the sidebar card is capped at 12 lines (status, one bar, current step, next action, one action-required line — never a timeline); the panel is organized into Now / Progress / Decisions / Goals tabs with plain-language criteria and a C/I/S legend footer; decision rows are native Select components dispatching `rpc.act`; the panel opens on demand (`leader+g`, `tab` cycles) instead of displacing the sidebar; the raw ledger timeline is gone from the UI (it stays in the file).
- **Fixed: the dashboard freeze (T058)** — a dropped or late-attaching event stream could freeze the card at its first snapshot for a whole run (seen live). The TUI now re-fetches stale snapshots on renders and on a 4-second ticker for live goals; events remain the fast path.
- **Authoring rules against contract drift (T055)** — the write-goal skill forbids exact version-string needles and teaches prefix/semantic version checks, with a worked release-goal example (`startsWith`, changelog anchored on major.minor).

## 0.2.2 — 2026-10-04

- **Fixed: an owner-approved criterion is final.** Re-verification no longer re-runs the verifier child on a criterion the owner explicitly approved (`pass · by: human`) — previously a broken verifier could stomp the owner's sign-off, which is exactly what blocked the dogfood run's completion. The owner outranks the verifier.
- Filed from live dogfooding: T049 (goals are session-pinned — owner actions and palette commands dead outside the goal's session), T050 (human-in-the-loop dialogs at every decision point), and the palette/keymap investigation notes.


## 0.2.1 — 2026-10-04

- **Fixed: the TUI entry never loaded from git installs** (all versions). `@opentui/solid` and `solid-js` lived in devDependencies, and OpenCode's git installer ships production dependencies only — so the installed TUI entry crashed at load ("Cannot find package '@opentui/solid'"), killing the palette commands, the sidebar card, the dashboard panel and the footer pill while the server side kept working. Both are now regular dependencies; the server entry remains zero-dependency (types-only imports, unchanged). The git-install test now asserts the TUI runtime resolves in the installed cache. Found live by the owner after v0.2.0: dead palette and dead `/goal` dispatch (T047/T048).

## 0.2.0 — 2026-10-03

Built under the goal loop itself, with two council verdicts as decision records (`.cleo/council-runs/20261003T145323Z-a46b2ff9` and `…162655Z-800c52ca`).

- **Verifier reliability**: hardened prompt (exactly one `goal_verdict` call) with a sanctioned fenced-json fallback recorded as `by:"verifier-fallback"` and quote-re-read identically; child transcripts persisted under `evidence/` — a prose-answering or silent verifier can no longer kill a round.
- **Live counters**: `session.usage.updated` is per-message cumulative on 2.0.22; baselined at goal start with throttled persist+emit — `run.json` and the TUI no longer freeze at the kickoff snapshot.
- **Start-time rehearsal**: `/goal start` executes every command check once before locking, records the baseline, and refuses unrunnable check text (shell exit 126/127 or a `zsh:`/`bash:` diagnostic — never a tool's own stderr, so red bug-fix baselines stay legal).
- **Amendment**: `/goal amend` propose + `/goal amend confirm` re-locks an owner-edited contract with generation-bound records under `evidence/`, retaining prior evidence for unchanged criteria; the goal-folder write guard now covers stopped states; the integrity message names real paths.
- **Identity at scale**: descriptive slugs kept (hash/word names rejected by council); **supersession** (`supersedes: <slug>@<lock-prefix>`, terminal predecessor, archived, mid-flight admission rule requiring recorded owner acknowledgment); **archive tier** (`/goal archive` → `.opencode/goals-archive/`, demote-never-delete, registry keeps answering "was this ever a goal here?"); **admission probe** (exact existence + ranked title/intent similarity over live and archived goals, surfaced as owner options in `/goal new`).
- **Registry**: machine-level derived index (`~/.local/share/opencode/goal-registry.json`, `OCGOAL_REGISTRY` override), updated on persist with no-op skip and rebuild-by-scan parity; the scale benchmark (`spikes/scale-bench.ts`) shows folders stay fast at 5,000 goals (13.8 ms) while full list builds justify the index (157.6 ms).
- **Surfaces**: `/goal help` agent-forward guide from a pure builder; optional first-class CLEO linkage (CLI-only, `cleo-linked` ledger event, absent CLEO records nothing); TUI probes target the dashboard panel.
- **Coverage**: continuation notices are single synthetic rows; host scenarios for budget wrap-up, `goal_wait`, absent/diff, human approval, compaction survival, `session.deleted` and provider degradation; `parseContract` warns on multi-line command checks.
- Provenance: OpenCode store probe persisted (`docs/opencode-store-probe.md`); upstream CLEO reports #1804/#1805 (evidence-atom DX) and #1833 (a retraction with thanks).

## 0.1.0-alpha.2 — 2026-10-03

Second pre-release, dogfooded: built and shipped from inside the first real-model goal run (`docs/dogfood-1.md`).

- TUI: `session.panel` goal dashboard — contract title/status, budget cells, criteria board with per-criterion evidence, plan steps, latest verdict with its lines, and a ledger Timeline section. Opens automatically (once per run) whenever the session has a goal; `Goal: focus dashboard` palette command; re-render driven by GoalRpc `updated` events.
- RPC: `GoalView.timeline` — the last ledger events, summarized server-side (`src/server/app.ts` `timelineOf`), so the dashboard shows the run's history without file access.
- write-goal skill: `references/examples.md` with four complete goal/v1 contracts (bugfix, perf, migration, feature), each verified against `parseContract`; trigger evals run against a real agent (15/16, see `evals/trigger-eval-2026-10-03.json`); skill passes awesome-skills `validate.py`, `audit_body.py` and `check_depth.py`.
- Storage: `.opencode/goals/*/run.json`, `ledger.jsonl`, `evidence/` are gitignore candidates (HANDOFF §8.4).
- Dogfood findings: `docs/dogfood-1.md`; defects filed as CLEO T013–T015.

## 0.1.0-alpha.1 — 2026-10-02

First installable pre-release, for OpenCode 2.0.22+ only.

- Goal contract `goal/v1` (`.opencode/goals/<slug>/goal.yaml`): parser and validator with criteria, invariants, protected oracles, plan, assumptions, optional budgets, autonomy and verification settings.
- Engine: continuation on `session.execution.succeeded`, idempotent prompts with native-format ids, location filtering, stall detection by worktree change, blocker ×3, budget wrap-up, interrupt/error mapping, restart recovery (paused), contract rendered into every request (byte-stable system block + per-turn status note), compaction hook.
- Verification: host-run checks (command/file/contains/absent/diff) in the owner's login shell, integrity and protected-path checks, hidden read-only `goal-verifier` agent whose quotes the host re-reads, owner sign-off for `human` criteria; failures return a HOST VERDICT to the worker.
- Tools: `goal_status`, `goal_progress`, `goal_claim`, `goal_block`, `goal_flag`, `goal_wait`, `goal_validate`, `goal_start` (owner approval required), `goal_verdict` (verifier only).
- `/goal` command: `new`, `start`, `status`, `pause`, `resume`, `verify`, `abort`, `approve`, `reject`, `validate`, `list` — run as plugin code, no model turn.
- TUI: sidebar goal card, prompt-footer pill, composer banner when the owner is needed, toasts and desktop attention, palette commands.
- Bundled `write-goal` skill (v0.1, pending a skill-forge/skill-creator pass).
