import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { writeFile, readdir } from "node:fs/promises"
import { until } from "./harness"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"

// T037+T038 — the amendment path (council 20261003T145323Z-a46b2ff9). The owner
// edits goal.yaml out of band; `/goal amend` proposes the diff and
// `/goal amend confirm` re-locks: atomic generation-bound records, ledger
// trail, evidence snapshot, and the explicit branch decision (evidence kept
// for unchanged criteria, changed ones reset). The write guard covers stopped
// states too, and the integrity message names real paths.

const DONE = "status: ok - amended\n"
const evidence = { C1: "wrote done.txt", C2: "grep finds status: ok", C3: "the file states it", C4: "oracle.txt untouched" }
const verifier = () => ({
  toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "the line says so", evidence: [{ path: "done.txt", quote: "status: ok - amended" }] }] } }],
})

const AMENDED_GOAL = `schema: goal/v1
id: demo
title: Demo file says ok
intent:
  verbatim: "make done.txt say ok"
outcome: done.txt exists and states that the status is ok
non_goals:
  - Touching any file other than done.txt
criteria:
  - id: C1
    statement: done.txt SHALL exist
    check: {kind: file, path: done.txt}
  - id: C2
    statement: 'done.txt SHALL contain the line "status: ok"'
    check: {kind: command, run: "grep -q 'status: ok' done.txt"}
  - id: C3
    statement: done.txt states the status in a full line
    check: {kind: verifier, ask: "Does done.txt state that the status is ok in a full line?"}
  - id: C4
    statement: oracle.txt still exists untouched
    check: {kind: file, path: oracle.txt}
protect: ["oracle.txt"]
plan:
  - {id: S1, title: Write done.txt, proves: [C1, C2, C3]}
`

describe("goal amendment (T037+T038)", () => {
  test("stopped-state tampering is blocked; the owner amends with confirm and the run completes on the amended contract", async () => {
    const host = await goalHost(
      script((req, turn) => {
        if (turn.trigger.includes("goal started")) {
          if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: DONE } }] }
          return { text: "thinking" } // talk-only: the host stalls the goal into paused
        }
        // a plain user prompt while paused asks the model to tamper — the guard must block it
        if (turn.trigger.includes("please rewrite the goal file")) {
          if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: ".opencode/goals/demo/goal.yaml", content: "schema: goal/v1\n" } }] }
          return { text: "could not" }
        }
        if (turn.trigger.includes("resumed") || turn.trigger.includes("host verdict")) {
          if (turn.results === 0) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written; oracle untouched.", evidence } }] }
          return { text: "claimed" }
        }
        return { text: "nothing to do" }
      }, verifier),
    )
    try {
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)

      // 1. the goal does its one write, then stalls into paused
      const paused = await waitStatus(host, ["paused"], 90000)
      expect(paused.status).toBe("paused")

      // 2. while STOPPED, a user-driven attempt to rewrite the contract is blocked (T037)
      await host.client.session.prompt({ sessionID, text: "please rewrite the goal file to make this easy" } as any)
      await until(async () => host.fixture.requests.some((r) => JSON.stringify(r.messages).includes("owned by the owner and the host")), 30000)
      const contractOnDisk = await host.readProject(".opencode/goals/demo/goal.yaml")
      expect(contractOnDisk).toContain("title: Demo file says ok")

      // 3. the owner edits the contract out of band (adds C4), proposes, confirms
      await writeFile(join(host.project, ".opencode/goals/demo/goal.yaml"), AMENDED_GOAL)
      await host.client.session.command({ sessionID, name: "goal", text: "amend" } as any)
      await until(async () => {
        const events = await ledger(host)
        return events.some((e) => e.type === "amend-proposed") ? events : undefined
      }, 20000)
      await host.client.session.command({ sessionID, name: "goal", text: "amend confirm" } as any)
      const amended = await until(async () => {
        const state = await run(host)
        return state.amendments?.some((a: any) => a.status === "accepted") ? state : undefined
      }, 20000)
      expect(amended!.amendments.filter((a: any) => a.status === "accepted")).toHaveLength(1)

      // atomic, generation-bound record with both locks, on disk under evidence/
      const events = await ledger(host)
      const event = events.find((e) => e.type === "amended")!
      expect(event.generation).toBe(1)
      expect(event.oldLock).not.toBe(event.newLock)
      const amendmentFiles = (await readdir(join(host.project, ".opencode/goals/demo/evidence", amended!.runId))).filter((f) => f.startsWith("amendment-1-"))
      expect(amendmentFiles).toHaveLength(1)

      // 4. resume: the worker sees the amended contract, claims, and the run
      //    completes with the added criterion proven too
      await host.client.session.command({ sessionID, name: "goal", text: "resume" } as any)
      const done = await waitStatus(host, ["complete", "paused", "needs_review", "blocked"], 120000)
      expect(done.status).toBe("complete")
      expect(done.criteria.C4).toMatchObject({ status: "pass" })
      expect(done.lock).toBe(event.newLock)
      // integrity: the final verification ran against the amended lock, no integrity errors
      const verdicts = events.concat(await ledger(host)).filter((e) => e.type === "verdict")
      expect(verdicts.at(-1)!.passed).toBe(true)
    } finally {
      await host.stop()
    }
  }, 180000)
})
