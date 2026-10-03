# OpenCode store probe — project association tables

Read-only probe of the OpenCode 2.0.22 session store, run 2026-10-03 (council run
`20261003T162655Z-800c52ca`, condition 6: persist the provenance). This is the record the
goal-identity council cites for "OpenCode already associates projects with directories" —
future evidence packs should cite this file, not re-quote the live query.

Store: `~/.local/share/opencode/opencode.db` (SQLite, WAL). Queried with `sqlite3` in
read-only mode (`file:…?mode=ro`). Never written by us; treat the schema as internal to
OpenCode and re-verify before depending on it (CLEO T028 owns that decision).

## `project` — one row per known project/worktree

```
id TEXT pk · worktree TEXT · vcs TEXT · name TEXT · icon_url · icon_url_override ·
icon_color · time_created · time_updated · time_initialized · time_active ·
sandboxes TEXT · commands TEXT
```

- `select count(*) from project;` → **16** (2026-10-03)
- Sample: `bb7f7923…|/Users/keatonhoskins|…`, `713d5621…|/Users/keatonhoskins/.codex|…`,
  `ba2b9e33…|/Users/keatonhoskins/.config/opencode|…` — `worktree` holds the absolute path.

## `project_directory` — project ↔ directory association

```
project_id TEXT · directory TEXT · type TEXT · strategy TEXT · time_created
```

- Joins OpenCode's project identity to concrete directories; this is the join key a
  cross-project goal registry would use (`directory` ↔ a project root containing
  `.opencode/goals/`).

## Also present (not probed further)

`account`, `account_state`, `control_account`, `credential`, `event`, `event_sequence`,
`instruction_*`, `kv`, `permission`, `session_v2`, `session_message`, `session_inbox`,
`session_pending`, `migration`, `workspace`, `worktree`.

## Read for the v0.3 design

- The association we would otherwise build already exists (T028 owns whether we may depend
  on it read-only, and whether `kv` is a legitimate plugin write target — both unanswered).
- Our plugin keys everything by `ctx.location.directory` (`src/server/app.ts:83`), which is
  the same value `project_directory.directory` holds, so a join is trivial if T028's spike
  ever blesses it.
