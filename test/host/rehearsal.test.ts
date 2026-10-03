import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { until } from "./harness"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"

// T036 — start-time rehearsal (council 20261003T145323Z-a46b2ff9). /goal start
// executes every command check once BEFORE locking: an unrunnable check text
// (shell exit 126/127 or a zsh:/bash: diagnostic — the folded-scalar defect
// class from run 0ffe5ac6e001) refuses the start and names the criterion; a
// legitimate red check is recorded as the baseline in evidence/ and the ledger.

const BAD_GOAL = `schema: goal/v1
id: rehearse-bad
title: Rehearsal refusal probe
intent:
  verbatim: "probe"
outcome: the check can never run so the goal must refuse to start
non_goals: [x]
criteria:
  - id: C1
    statement: a check whose text cannot run
    check:
      kind: command
      run: |
        for s in a b; do
          .tmp/venv/bin/python "$HOME/nope/scripts/$s.py"
          /definitely/not/a/real/path || exit 1;
        done
      expect: {exit: 0}
`

const RED_GOAL = `schema: goal/v1
id: rehearse-red
title: Rehearsal baseline probe
intent:
  verbatim: "probe"
outcome: done2.txt exists and says ok
non_goals: [x]
criteria:
  - id: C1
    statement: 'done2.txt SHALL contain the line "status: ok"'
    check:
      kind: command
      run: "grep -q 'status: ok' done2.txt"
      expect: {exit: 0}
  - id: C2
    statement: done2.txt SHALL exist
    check: {kind: file, path: done2.txt}
plan:
  - {id: S1, title: Write done2.txt, proves: [C1, C2]}
`

describe("start-time rehearsal (T036)", () => {
  test("an unrunnable command check refuses the lock, names the criterion and writes no run", async () => {
    const host = await goalHost(script(() => ({ text: "Nothing." })), {
      ".opencode/goals/rehearse-bad/goal.yaml": BAD_GOAL,
    })
    try {
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start rehearse-bad" } as any)
      // the refusal is ledgered and no run state is ever created
      const refused = await until(async () => {
        const events = await ledger(host, "rehearse-bad").catch(() => undefined)
        return events?.some((e) => e.type === "rehearsal-refused") ? events : undefined
      }, 20000, 200)
      expect(refused).toBeDefined()
      const event = refused!.find((e) => e.type === "rehearsal-refused")!
      expect(event.id).toBe("C1")
      const state = await run(host, "rehearse-bad").catch(() => undefined)
      expect(state).toBeUndefined()
      // and no kickoff ever reached the model
      expect(host.fixture.requests.some((r) => JSON.stringify(r.messages).includes('id="rehearse-bad"') || JSON.stringify(r.messages).includes("rehearse-bad"))).toBe(false)
    } finally {
      await host.stop()
    }
  }, 60000)

  test("a runnable-but-red check starts anyway and records the baseline", async () => {
    const host = await goalHost(
      script((req, turn) => {
        if (turn.trigger.includes("goal started")) {
          if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done2.txt", content: "status: ok - rehearsed\n" } }] }
          if (turn.results === 1) return { toolCalls: [{ name: "goal_claim", args: { summary: "done2.txt written.", evidence: { C1: "wrote it", C2: "it exists" } } }] }
        }
        return { text: "Nothing." }
      }),
      { ".opencode/goals/rehearse-red/goal.yaml": RED_GOAL },
    )
    try {
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start rehearse-red" } as any)
      const done = await waitStatus(host, ["complete", "paused", "needs_review", "blocked"], 90000, "rehearse-red")
      // the run started despite the red baseline and completed the work
      expect(done.status).toBe("complete")

      // the baseline was recorded: red command check, green file-absence is honest too
      const events = await ledger(host, "rehearse-red")
      const rehearsal = events.find((e) => e.type === "rehearsal")
      expect(rehearsal).toBeDefined()
      const baseline = new Map((rehearsal!.baseline as Array<{ id: string; pass: boolean }>).map((b) => [b.id, b.pass]))
      expect(baseline.get("C1")).toBe(false) // grep red at start — legitimate

      // the evidence file exists under this run's evidence directory
      const state = await run(host, "rehearse-red")
      const evidence = JSON.parse(await host.readProject(join(".opencode/goals/rehearse-red/evidence", state.runId, "rehearsal.json")))
      expect(evidence.results.map((r: any) => r.id).sort()).toEqual(["C1"])
      expect(evidence.results.every((r: any) => r.unrunnable === false)).toBe(true)
    } finally {
      await host.stop()
    }
  }, 150000)
})
