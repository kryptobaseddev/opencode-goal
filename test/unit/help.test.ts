import { describe, expect, test } from "bun:test"
import { goalHelp } from "../../src/server/help"

// T025 — /goal help is an agent-forward guide rendered from a pure builder:
// commands with arguments, the worker/owner tool split, storage layout and
// mid-run rules — including the v0.2.0 lifecycle (rehearsal, amendment,
// archive, supersession).

describe("goal help (T025)", () => {
  const text = goalHelp({ version: "test" })

  test("covers every command with its arguments", () => {
    for (const needle of [
      "/goal new <what you want done>",
      "/goal start <slug> [acknowledge-supersede]",
      "/goal amend [confirm]",
      "/goal archive",
      "/goal approve <C#>",
      "/goal validate <slug>",
      "/goal list [all]",
    ])
      expect(text).toContain(needle)
  })

  test("states the worker/owner tool split explicitly", () => {
    expect(text).toContain("## Worker tools")
    for (const tool of ["goal_progress", "goal_claim", "goal_block", "goal_flag", "goal_wait <seconds>", "goal_status", "goal_validate"])
      expect(text).toContain(`\`${tool}\``)
    expect(text).toMatch(/`goal_verdict`.*never available to the worker/)
  })

  test("documents the storage layout including the archive tier and registry", () => {
    expect(text).toContain(".opencode/goals/<slug>/goal.yaml")
    expect(text).toContain("ledger.jsonl")
    expect(text).toContain("evidence/<runId>/")
    expect(text).toContain(".opencode/goals-archive/<slug>/")
    expect(text).toContain("was this ever a goal here?")
  })

  test("spells the mid-run rules: guard, proof over prose, deferred questions, lifecycle", () => {
    expect(text).toContain("Never edit `.opencode/goals/**`")
    expect(text).toContain("HOST VERDICT")
    expect(text).toContain("Questions are deferred")
    expect(text).toContain("rehearsed at start")
    expect(text).toContain("supersedes: <slug>@<lock>")
    expect(text).toContain("generation-bound, audit-trailed")
  })
})
