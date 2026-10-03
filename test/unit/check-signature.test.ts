import { describe, expect, test } from "bun:test"
import { runHostCheck } from "../../src/verify/pipeline"

// Provenance: the mangled C3 `run:` text exactly as locked in
// .opencode/goals/dogfood-buildout/evidence/0ffe5ac6e001/contract.yaml
// (authored via a YAML folded scalar, `>-`, whose more-indented `for`-body
// kept literal newlines). It made the host execute the skill directory as a
// command during run 0ffe5ac6e001 (see docs/dogfood-1.md §4.5).
const MANGLED = `[ -x .tmp/venv/bin/python ] || python3 -m venv .tmp/venv; .tmp/venv/bin/pip install -q pyyaml; for s in validate audit_body check_depth; do
  .tmp/venv/bin/python "$HOME/projects/awesome-skills/skills/skill-validator/scripts/$s.py"
  /Users/keatonhoskins/projects/opencode-goal/skills/write-goal || exit 1;
done`

// Council Executor action (run 20261003T145323Z-a46b2ff9): prove the two
// failure classes are distinguishable from the outside — a check whose text
// can never run (shell-level error, non-empty stderr) vs a legitimate
// check that is simply not satisfied yet (exit 1, empty stderr). This is the
// deciding datum for start-time rehearsal: if unrunnable commands have a
// stable signature, /goal start can refuse to lock them.
describe("command-check failure signatures (start-time rehearsal feasibility)", () => {
  test("an unrunnable check fails with a shell-level stderr signature", async () => {
    const result = await runHostCheck({ kind: "command", run: MANGLED, expect: { exit: 0 } }, "/tmp", undefined)
    expect(result.pass).toBe(false)
    expect(result.detail).toContain("exit 1, expected 0")
    expect(result.detail).toMatch(/\[stderr\]/)
    expect(result.detail).toMatch(/permission denied|command not found|no such file/i)
  })

  test("a legitimate-but-undone check fails with exit 1 and an empty stderr", async () => {
    const result = await runHostCheck({ kind: "command", run: "exit 1", expect: { exit: 0 } }, "/tmp", undefined)
    expect(result.pass).toBe(false)
    expect(result.detail).toContain("exit 1, expected 0")
    expect(result.detail).not.toMatch(/\[stderr\]\s*\S/)
  })

  test("the two failure classes are distinguishable by stderr presence", async () => {
    const mangled = await runHostCheck({ kind: "command", run: MANGLED, expect: { exit: 0 } }, "/tmp", undefined)
    const undone = await runHostCheck({ kind: "command", run: "exit 1", expect: { exit: 0 } }, "/tmp", undefined)
    const stderrOf = (r: { detail: string }) => (r.detail.split("[stderr]")[1] ?? "").trim()
    expect(stderrOf(mangled).length).toBeGreaterThan(0)
    expect(stderrOf(undone).length).toBe(0)
  })
})
