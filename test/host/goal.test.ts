import { describe, expect, test } from "bun:test"
import { toolNames, until } from "./harness"
import { goalHost, ledger, newSession, run, script, text, waitStatus } from "./goal.helpers"

const evidence = { C1: "wrote done.txt", C2: "grep finds status: ok", C3: "the file states it" }

describe("goal loop on a real OpenCode 2 host", () => {
  test("a false claim gets a HOST VERDICT; the fix completes only after host checks and the verifier pass", async () => {
    const host = await goalHost(
      script(
        (req, turn) => {
          if (turn.trigger.includes("goal started")) {
            if (turn.results === 0) return { toolCalls: [{ name: "goal_claim", args: { summary: "Already done.", evidence } }] }
            return { text: "Claimed." }
          }
          if (turn.trigger.includes("host verdict")) {
            if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: "status: ok - every check passes\n" } }] }
            if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "claim" } }] }
            if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence } }] }
            return { text: "Claimed again." }
          }
          return { text: "Nothing else to do." }
        },
        () => ({ toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "the line says so", evidence: [{ path: "done.txt", quote: "status: ok - every check passes" }] }] } }] }),
      ),
    )
    try {
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
      const done = await waitStatus(host, ["complete", "paused", "needs_review", "blocked"], 90000)
      expect(done.status).toBe("complete")
      expect(done.criteria.C1.status).toBe("pass")
      expect(done.criteria.C2.status).toBe("pass")
      expect(done.criteria.C3).toMatchObject({ status: "pass", by: "verifier" })
      expect(done.steps.S1).toBe("done")

      const events = await ledger(host)
      const verdicts = events.filter((e) => e.type === "verdict")
      expect(verdicts.map((v) => v.passed)).toEqual([false, true])
      expect(verdicts[0].lines.join("\n")).toMatch(/C1 FAILED \[host\]/)
      expect(verdicts[0].lines.join("\n")).toMatch(/C3 FAILED \[verifier\].*\n.*(does not exist|not found)/)

      const workerRequests = host.fixture.requests.filter((r) => r.tools?.length && !JSON.stringify(r.messages).includes("independent completion verifier"))
      const sees = (needle: string) => workerRequests.some((r) => JSON.stringify(r.messages).includes(needle))
      expect(sees("<goal_contract id=\\\"demo\\\"")).toBe(true)
      expect(sees("HOST VERDICT")).toBe(true)
      expect(workerRequests.every((r) => toolNames(r).includes("goal_claim"))).toBe(true)
      expect(workerRequests.some((r) => toolNames(r).includes("goal_verdict"))).toBe(false)
      const verifierRequests = host.fixture.requests.filter((r) => JSON.stringify(r.messages).includes("independent completion verifier"))
      expect(verifierRequests.length).toBeGreaterThan(0)
      expect(toolNames(verifierRequests[0]!).sort()).toEqual(["glob", "goal_verdict", "grep", "read"])
      // the owner's command text never reached the model
      expect(workerRequests.some((r) => r.messages.some((m) => m.role === "user" && text(m).includes("start demo")))).toBe(false)
    } finally {
      await host.stop()
    }
  }, 150000)

  test("status and pause run without a model turn; resume sends exactly one continuation", async () => {
    const host = await goalHost(script(() => ({ delayMs: 1500, text: "thinking about it" })))
    try {
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
      await until(async () => (await run(host)).turn >= 1, 20000)
      await host.client.session.command({ sessionID, name: "goal", text: "pause" } as any)
      await waitStatus(host, ["paused"], 20000)
      await host.client.session.wait({ sessionID })
      await Bun.sleep(3000)
      const before = host.fixture.requests.length
      await host.client.session.command({ sessionID, name: "goal", text: "status" } as any)
      await Bun.sleep(2500)
      expect(host.fixture.requests.length).toBe(before)
      expect((await run(host)).status).toBe("paused")

      await host.client.session.command({ sessionID, name: "goal", text: "resume" } as any)
      await until(async () => host.fixture.requests.length > before, 20000)
      await host.client.session.command({ sessionID, name: "goal", text: "pause" } as any)
      await host.client.session.wait({ sessionID })
      const resumed = host.fixture.requests.slice(before).filter((r) => r.tools?.length)
      expect(resumed.some((r) => JSON.stringify(r.messages).includes("resumed"))).toBe(true)
    } finally {
      await host.stop()
    }
  }, 120000)

  test("Esc pauses the goal and no continuation follows", async () => {
    const host = await goalHost(script(() => ({ delayMs: 6000, text: "slow work" })))
    try {
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
      await until(async () => host.fixture.requests.some((r) => r.tools?.length), 20000)
      await Bun.sleep(500)
      await host.client.session.interrupt({ sessionID } as any)
      const paused = await waitStatus(host, ["paused"], 20000)
      expect(paused.reason).toMatch(/interrupted by you/)
      const count = host.fixture.requests.length
      await Bun.sleep(4000)
      expect(host.fixture.requests.length).toBe(count)
    } finally {
      await host.stop()
    }
  }, 60000)

  test("talk-only turns stall the goal after three turns", async () => {
    const host = await goalHost(script(() => ({ text: "I will get to it." })))
    try {
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
      const stalled = await waitStatus(host, ["paused"], 60000)
      expect(stalled.reason).toMatch(/stalled/)
      const turns = (await ledger(host)).filter((e) => e.type === "admit").map((e) => e.kind)
      expect(turns).toEqual(["kickoff", "continue", "recovery"])
    } finally {
      await host.stop()
    }
  }, 90000)

  test("the same blocker three turns in a row blocks the goal", async () => {
    const host = await goalHost(
      script((_req, turn) => {
        if (turn.results === 0) return { toolCalls: [{ name: "goal_block", args: { key: "missing-token", reason: "need the API token", needs: "credential" } }] }
        return { text: "Blocked." }
      }),
    )
    try {
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
      const blocked = await waitStatus(host, ["blocked", "paused"], 60000)
      expect(blocked.status).toBe("blocked")
      expect(blocked.blocker).toMatchObject({ key: "missing-token", count: 3 })
    } finally {
      await host.stop()
    }
  }, 90000)

  test("questions are deferred and protected files cannot be edited", async () => {
    const host = await goalHost(
      script((req, turn) => {
        if (turn.results === 0) return { toolCalls: [{ name: "question", args: { questions: [{ question: "Which file?", header: "File", options: [{ label: "done.txt", description: "x" }] }] } }] }
        if (turn.results === 1) return { toolCalls: [{ name: "write", args: { path: "oracle.txt", content: "changed\n" } }] }
        return { text: "ok" }
      }),
    )
    try {
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
      await until(async () => host.fixture.requests.filter((r) => r.messages.at(-1)?.role === "tool").length >= 2, 30000)
      await host.client.session.command({ sessionID, name: "goal", text: "abort" } as any)
      const toolResults = host.fixture.requests.flatMap((r) => r.messages.filter((m) => m.role === "tool").map(text))
      expect(toolResults.some((t) => t.includes("defers questions"))).toBe(true)
      expect(toolResults.some((t) => t.includes("protected by the goal contract"))).toBe(true)
      expect(await host.readProject("oracle.txt")).toBe("do not edit\n")
    } finally {
      await host.stop()
    }
  }, 60000)

  test("a reload brings a running goal back paused", async () => {
    const host = await goalHost(script(() => ({ delayMs: 1500, text: "working" })))
    try {
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
      await until(async () => (await run(host)).turn >= 1, 20000)
      await host.client.location.reload()
      await host.client.plugin.list({ location: host.location } as any)
      const recovered = await waitStatus(host, ["paused"], 20000)
      expect(recovered.reason).toMatch(/restarted/)
    } finally {
      await host.stop()
    }
  }, 60000)
})

describe("bundled write-goal skill", () => {
  test("the plugin registers write-goal and /goal new attaches it", async () => {
    const host = await goalHost(script(() => ({ text: "Let me look at the repository first." })))
    try {
      const skills: any = await until(async () => {
        const list: any = await host.client.skill.list({ location: host.location } as any)
        const items = Array.isArray(list) ? list : list?.data ?? []
        return items.some((s: any) => s.id === "write-goal" || s.name === "write-goal") ? items : undefined
      }, 20000)
      const skill = skills.find((s: any) => s.id === "write-goal" || s.name === "write-goal")
      expect(skill.description).toMatch(/goal contract/)
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "new make the build pass" } as any)
      await host.client.session.wait({ sessionID })
      const worker = host.fixture.requests.filter((r) => r.tools?.length)
      expect(worker.some((r) => JSON.stringify(r.messages).includes("Ask, don't narrate"))).toBe(true)
      expect(worker.some((r) => r.messages.some((m) => m.role === "user" && text(m).includes("make the build pass")))).toBe(true)
    } finally {
      await host.stop()
    }
  }, 60000)
})
