import { describe, expect, test } from "bun:test"
import { relative } from "node:path"
import { toolNames } from "./harness"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"

// T044 — the verifier child's empty exchange. On the owner's main host the
// child's exchange came back entirely empty four times (no text, no tool
// call) with GLM via zai: the hidden agent's implicit model resolution
// produced nothing. This scenario pins the fix on a fixture that streams an
// EMPTY first response: the child request carries an explicitly resolved
// model (ledgered as verifier-model), the empty round is retried once, the
// verdict arrives on the retry, and the always-empty case is recorded as
// verifier-empty rounds in the ledger and the run's verdict lines — never a
// silent empty exchange.

const DONE = "status: ok - empty first reply\n"
const evidence = { C1: "wrote done.txt", C2: "grep finds status: ok", C3: "the file states it" }

const worker = (req: any, turn: { trigger: string; results: number }) => {
  if (turn.trigger.includes("goal started") || turn.trigger.includes("host verdict")) {
    if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: DONE } }] }
    if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "claim" } }] }
    if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence } }] }
  }
  return { text: "Nothing else to do." }
}

const verdict = () => ({
  toolCalls: [
    {
      name: "goal_verdict",
      args: {
        verdicts: [
          { id: "C3", verdict: "proven", reason: "the file states the status in a full line", evidence: [{ path: "done.txt", quote: "status: ok - empty first reply" }] },
        ],
      },
    },
  ],
})

describe("verifier empty exchange (T044)", () => {
  test("an empty first response is retried and resolved: the child request carries an explicit model, the empty round is ledgered, the verdict lands on round 2", async () => {
    let verifierCalls = 0
    const host = await goalHost(
      script(worker, () => {
        verifierCalls++
        // round 1: entirely empty — no text, no tool calls (the main-host failure mode)
        if (verifierCalls === 1) return {}
        return verdict()
      }),
    )
    try {
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
      const done = await waitStatus(host, ["complete", "paused", "needs_review", "blocked"], 90000)

      // the retry rescued the round: the run completes on the verifier's own verdict
      expect(done.status).toBe("complete")
      expect(done.criteria.C1).toMatchObject({ status: "pass", by: "host" })
      expect(done.criteria.C3).toMatchObject({ status: "pass", by: "verifier" })

      const events = await ledger(host)
      // T044: the model the child runs on was resolved explicitly and recorded
      const model = events.find((e) => e.type === "verifier-model")
      expect(model?.model).toMatch(/^fixture\/test/)
      // the empty round is recorded, never silent
      const empty = events.filter((e) => e.type === "verifier-empty")
      expect(empty).toHaveLength(1)
      expect(empty[0]).toMatchObject({ round: 1 })
      // and the transcript event shows the retry happened with the resolved model
      const transcriptEvent = events.find((e) => e.type === "verifier-transcript")
      expect(transcriptEvent).toMatchObject({ by: "verifier", rounds: 2, retried: true })
      expect(transcriptEvent?.model).toMatch(/^fixture\/test/)
      const transcript = JSON.parse(await host.readProject(relative(host.project, transcriptEvent!.file)))
      expect(transcript.rounds).toBe(2)
      expect(String(transcript.model)).toMatch(/^fixture\/test/)

      // the fixture saw both rounds: an empty reply, then the verdict call
      const verifierRequests = host.fixture.requests.filter((r) => JSON.stringify(r.messages).includes("independent completion verifier"))
      expect(verifierRequests.length).toBeGreaterThanOrEqual(2)
      // the retry nudge is explicit that emptiness is a failure
      const nudge = JSON.stringify(verifierRequests[1]!.messages)
      expect(nudge).toContain("Your previous reply was empty")
      // the goal_verdict tool stays verifier-only
      const workerRequests = host.fixture.requests.filter((r) => r.tools?.length && !JSON.stringify(r.messages).includes("independent completion verifier"))
      expect(workerRequests.some((r) => toolNames(r).includes("goal_verdict"))).toBe(false)
    } finally {
      await host.stop()
    }
  }, 150000)

  test("an always-empty verifier is recorded and reported, never a silent empty exchange", async () => {
    const host = await goalHost(
      script(worker, () => {
        return {} // every round comes back empty
      }),
    )
    try {
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
      // the claim is rejected and re-claimed until C3 hits max rejections → needs_review
      const done = await waitStatus(host, ["complete", "paused", "needs_review", "blocked"], 90000)

      // the verifier criterion is NOT credited: C3 fails on an explicit empty-exchange report
      expect(done.status).not.toBe("complete")
      expect(done.criteria.C3).toMatchObject({ status: "fail", by: "verifier" })
      expect(done.criteria.C3.detail).toContain("empty after 2 round(s)")

      // every verify round recorded both empty rounds — the failure is diagnosable, not silent
      const events = await ledger(host)
      const emptyRounds = new Set(events.filter((e) => e.type === "verifier-empty").map((e) => e.round))
      expect(emptyRounds.has(1)).toBe(true)
      expect(emptyRounds.has(2)).toBe(true)
      const lastTranscript = events.filter((e) => e.type === "verifier-transcript").at(-1)
      expect(lastTranscript).toMatchObject({ rounds: 2, retried: true })
      // the final host verdict line names the empty exchange
      const lastVerdict = events.filter((e) => e.type === "verdict").at(-1)
      expect(lastVerdict?.lines.join("\n")).toContain("empty after 2 round(s)")
      // the model was still resolved explicitly for the child
      expect(events.find((e) => e.type === "verifier-model")?.model).toMatch(/^fixture\/test/)
      expect((await run(host)).status).not.toBe("complete")
    } finally {
      await host.stop()
    }
  }, 150000)
})
