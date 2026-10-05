// T025 — the /goal help surface: one pure builder producing an agent-forward
// guide (commands with arguments, the worker/owner permission split, storage
// layout, mid-run rules). Rendered by /goal help and pinned by a unit test so
// it cannot drift from the engine's real semantics.

export type HelpFacts = { version: string }

export function goalHelp({ version }: HelpFacts): string {
  return [
    `# opencode-goal ${version} — the goal loop, for agents and owners`,
    "",
    "## Commands (owner)",
    "- `/goal new <what you want done>` — the write-goal interview (skill attached; similar-goal probe runs first)",
    "- `/goal start <slug> [acknowledge-supersede]` — rehearse every command check, then lock and run",
    "- `/goal status` · `/goal pause` · `/goal resume` · `/goal verify` — status costs no model turn",
    "- `/goal abort` — end the run for good (ledger and evidence stay)",
    "- `/goal amend [confirm]` — propose/confirm a contract re-lock after editing goal.yaml out of band",
    "- `/goal archive` — demote a finished goal to .opencode/goals-archive/ (never deleted)",
    "- `/goal approve <C#>` · `/goal reject <C#> <why>` — owner sign-off for human criteria",
    "- `/goal validate <slug>` · `/goal list [all]` — validate a contract; list live (or +archived) goals",
    "",
    "## Worker tools (the agent in the loop)",
    "- `goal_progress` — record the step you are on, one line of change, the next action",
    "- `goal_claim` — claim completion with evidence per criterion; the HOST then verifies you",
    "- `goal_block` — stop for an owner-only blocker (missing credential, decision)",
    "- `goal_flag` — flag a criterion that is contradictory, impossible or unsafe as written",
    "- `goal_wait <seconds>` — pause cheaply while an external process runs",
    "- `goal_status` / `goal_validate` — read-only checks",
    "- `goal_verdict` — reserved for the read-only verifier child; never available to the worker",
    "",
    "All `goal_*` tools are called **directly by name** — they are not registered with Code Mode, so `search()`/`tools.*` inside `execute` will never find them (a routing attempt returns an unrelated Unknown-tool error).",
    "",
    "## Storage layout (per project)",
    "- `.opencode/goals/<slug>/goal.yaml` — the locked contract (sha256)",
    "- `.opencode/goals/<slug>/run.json` — live run state; `ledger.jsonl` — every event, append-only",
    "- `.opencode/goals/<slug>/evidence/<runId>/` — locked contract copy, rehearsal baseline, verify results, verifier transcripts, amendment records",
    "- `.opencode/goals-archive/<slug>/` — demoted goals; the machine registry still answers \"was this ever a goal here?\"",
    "",
    "## Mid-run rules (the contract is enforced, not advice)",
    "- The contract is rendered into every request; compaction cannot lose it.",
    "- Never edit `.opencode/goals/**` while a goal exists — the write guard blocks it, running or stopped.",
    "- Completion is proven, not declared: host checks run first, then an independent verifier child whose quotes are re-read. A rejected claim returns a HOST VERDICT turn — read it, fix the work, claim again.",
    "- Questions are deferred during a run: make the reversible choice, note it in goal_progress, or call goal_block.",
    "- Command checks live on ONE line and are rehearsed at start; a check that cannot run refuses the lock.",
    "- Supersession replaces a goal: `supersedes: <slug>@<lock>` in the new contract; live predecessors need your explicit acknowledgment.",
    "- Amendment re-locks the same goal through `/goal amend confirm` — generation-bound, audit-trailed.",
  ].join("\n")
}
