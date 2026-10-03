import { describe, expect, test } from "bun:test"
import { relative } from "node:path"
import { toolNames } from "./harness"
import { goalHost, ledger, newSession, run, script, text, waitStatus } from "./goal.helpers"

// T016 — verifier reliability. The first real-model dogfood run died with
// "verifier did not call goal_verdict": a prose-answering child produced no
// tool call, no transcript, and no diagnosis. This scenario pins the fix:
// the hardened prompt (exactly-one-call + sanctioned fenced-json fallback),
// the fallback parser that turns a prose child's final fenced verdict into a
// real verdict recorded as by:"verifier-fallback", and the persisted child
// transcript under evidence/.

const DONE = "status: ok - proven via fallback\n"
const evidence = { C1: "wrote done.txt", C2: "grep finds status: ok", C3: "the file states it" }

const proseVerifier = () => ({
  text:
    "I cannot call tools in this session, so here is my verdict as instructed.\n" +
    "```json\n" +
    JSON.stringify({
      verdicts: [
        {
          id: "C3",
          verdict: "proven",
          reason: "the file states the status in a full line",
          evidence: [{ path: "done.txt", quote: "status: ok - proven via fallback" }],
        },
      ],
    }) +
    "\n```\n",
})

const worker = (req: any, turn: { trigger: string; results: number }) => {
  if (turn.trigger.includes("goal started") || turn.trigger.includes("host verdict")) {
    if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: DONE } }] }
    if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "claim" } }] }
    if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence } }] }
  }
  return { text: "Nothing else to do." }
}

describe("verifier reliability (T016)", () => {
  test("a prose-answering verifier child still yields a parsed fallback verdict, a hardened prompt and a persisted transcript", async () => {
    const host = await goalHost(script(worker, proseVerifier))
    try {
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
      const done = await waitStatus(host, ["complete", "paused", "needs_review", "blocked"], 90000)

      // the run completes and the verifier criterion is credited to the fallback
      expect(done.status).toBe("complete")
      expect(done.criteria.C1).toMatchObject({ status: "pass", by: "host" })
      expect(done.criteria.C3).toMatchObject({ status: "pass", by: "verifier-fallback" })

      // the ledger records the fallback round and the transcript location
      const events = await ledger(host)
      const fallback = events.find((e) => e.type === "verifier-fallback")
      expect(fallback).toMatchObject({ turn: expect.any(Number), count: 1 })
      const transcriptEvent = events.find((e) => e.type === "verifier-transcript")
      expect(transcriptEvent?.by).toBe("verifier-fallback")
      expect(typeof transcriptEvent?.file).toBe("string")

      // the transcript itself is on disk and contains the child's assistant prose
      const rel = relative(host.project, transcriptEvent!.file)
      const transcript = JSON.parse(await host.readProject(rel))
      expect(transcript.by).toBe("verifier-fallback")
      const assistantText = JSON.stringify(transcript.messages.filter((m: any) => m.type === "assistant" || m.role === "assistant"))
      expect(assistantText).toContain("verdicts")
      expect(assistantText).toContain("proven")

      // the prompt the child received demands exactly one call and names the fallback
      const verifierRequests = host.fixture.requests.filter((r) => JSON.stringify(r.messages).includes("independent completion verifier"))
      expect(verifierRequests.length).toBeGreaterThan(0)
      const prompt = JSON.stringify(verifierRequests[0]!.messages)
      expect(prompt).toContain("call goal_verdict exactly once")
      expect(prompt).toContain("fenced json block")
      // the fallback tool remains verifier-only: the worker never sees it
      const workerRequests = host.fixture.requests.filter((r) => r.tools?.length && !JSON.stringify(r.messages).includes("independent completion verifier"))
      expect(workerRequests.some((r) => toolNames(r).includes("goal_verdict"))).toBe(false)
      // and the prose answer never leaked into the worker transcript
      expect(workerRequests.some((r) => r.messages.some((m) => text(m).includes("verifier-fallback")))).toBe(false)
    } finally {
      await host.stop()
    }
  }, 150000)

  test("a tool-calling verifier is still the primary path (no fallback recorded)", async () => {
    const toolVerifier = () => ({
      toolCalls: [
        {
          name: "goal_verdict",
          args: {
            verdicts: [
              { id: "C3", verdict: "proven", reason: "the file states it in a full line", evidence: [{ path: "done.txt", quote: "status: ok - proven via fallback" }] },
            ],
          },
        },
      ],
    })
    const host = await goalHost(script(worker, toolVerifier))
    try {
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
      const done = await waitStatus(host, ["complete", "paused", "needs_review", "blocked"], 90000)
      expect(done.status).toBe("complete")
      expect(done.criteria.C3).toMatchObject({ status: "pass", by: "verifier" })
      const events = await ledger(host)
      expect(events.some((e) => e.type === "verifier-fallback")).toBe(false)
      const transcriptEvent = events.find((e) => e.type === "verifier-transcript")
      expect(transcriptEvent?.by).toBe("verifier")
      expect((await run(host)).status).toBe("complete")
    } finally {
      await host.stop()
    }
  }, 150000)
})
