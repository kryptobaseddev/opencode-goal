# Changelog

## 0.1.0-alpha.1 — 2026-10-02

First installable pre-release, for OpenCode 2.0.22+ only.

- Goal contract `goal/v1` (`.opencode/goals/<slug>/goal.yaml`): parser and validator with criteria, invariants, protected oracles, plan, assumptions, optional budgets, autonomy and verification settings.
- Engine: continuation on `session.execution.succeeded`, idempotent prompts with native-format ids, location filtering, stall detection by worktree change, blocker ×3, budget wrap-up, interrupt/error mapping, restart recovery (paused), contract rendered into every request (byte-stable system block + per-turn status note), compaction hook.
- Verification: host-run checks (command/file/contains/absent/diff) in the owner's login shell, integrity and protected-path checks, hidden read-only `goal-verifier` agent whose quotes the host re-reads, owner sign-off for `human` criteria; failures return a HOST VERDICT to the worker.
- Tools: `goal_status`, `goal_progress`, `goal_claim`, `goal_block`, `goal_flag`, `goal_wait`, `goal_validate`, `goal_start` (owner approval required), `goal_verdict` (verifier only).
- `/goal` command: `new`, `start`, `status`, `pause`, `resume`, `verify`, `abort`, `approve`, `reject`, `validate`, `list` — run as plugin code, no model turn.
- TUI: sidebar goal card, prompt-footer pill, composer banner when the owner is needed, toasts and desktop attention, palette commands.
- Bundled `write-goal` skill (v0.1, pending a skill-forge/skill-creator pass).
