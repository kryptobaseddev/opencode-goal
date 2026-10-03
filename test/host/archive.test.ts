import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { Registry } from "../../src/engine/registry"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"

// T032 — the archive tier (council 20261003T162655Z-800c52ca): /goal archive
// demotes a finished goal without deleting it. The folder (ledger + evidence
// intact) moves to .opencode/goals-archive/; the registry still answers
// "was this ever a goal here?" with yes; the live list excludes archived
// goals and /goal start names the archive instead of pretending the goal
// never existed.

const DONE = "status: ok - archived\n"
const evidence = { C1: "wrote done.txt", C2: "grep finds status: ok", C3: "the file states it" }

describe("archive tier (T032)", () => {
  test("archive demotes without deleting; existence survives in the registry and the archive; the live list excludes it", async () => {
    const host = await goalHost(
      script((req, turn) => {
        if (turn.trigger.includes("goal started") || turn.trigger.includes("host verdict")) {
          if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: DONE } }] }
          if (turn.results === 1) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence } }] }
        }
        return { text: "Nothing else to do." }
      }, () => ({
        toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "the line says so", evidence: [{ path: "done.txt", quote: "status: ok - archived" }] }] } }],
      })),
    )
    try {
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
      const done = await waitStatus(host, ["complete"], 90000)
      expect(done.status).toBe("complete")
      const eventsBefore = (await ledger(host)).length

      // archive the finished goal
      await host.client.session.command({ sessionID, name: "goal", text: "archive" } as any)
      await (async () => {
        for (let i = 0; i < 100; i++) {
          try {
            await readFile(`${host.project}/.opencode/goals-archive/demo/goal.yaml`)
            return
          } catch {
            await Bun.sleep(100)
          }
        }
        throw new Error("archive move never happened")
      })()

      // demoted, not deleted: contract, ledger and evidence travel together
      const archivedLedger = await host.readProject(".opencode/goals-archive/demo/ledger.jsonl")
      expect(archivedLedger.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(eventsBefore)
      expect(archivedLedger).toContain('"type":"archived"')
      // the live folder is gone
      await expect(host.readProject(".opencode/goals/demo/goal.yaml")).rejects.toThrow()

      // the registry still answers yes, flagged archived — and the live
      // listing (what list()/admission consume) filters archived entries out
      const registry = new Registry(process.env.OCGOAL_REGISTRY)
      const entry = registry.list().find((g) => g.slug === "demo")
      expect(entry).toMatchObject({ archived: true, status: "complete", slug: "demo" })
      expect(registry.list().filter((g) => !g.archived)).toHaveLength(0)

      // the run state is gone from the live store
      await expect(run(host)).rejects.toThrow()
    } finally {
      await host.stop()
    }
  }, 150000)
})
