// T059: start clean — /goal start <slug> fresh opens a NEW session owned by
// the goal, pins the run to that session (T049: the run map keys the new
// session, not the invoking one) and prompts the kickoff there; the invoking
// session stays untouched (no clear-in-place API exists — none is pretended).
import { test, expect } from "bun:test"
import { goalHost, newSession, ledger, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

test("clean start: a fresh goal-owned session gets the run and the kickoff; the original stays untouched", async () => {
  const host = await goalHost(script(() => ({ text: "Working under a clean start." })))
  try {
    const original = await newSession(host)
    const sessionCount = async () => {
      const resp: any = await (host.client as any).session.list({})
      return ((resp?.data ?? resp) as any[])?.length ?? 0
    }
    const before = await sessionCount()
    await host.client.session.command({ sessionID: original, name: "goal", text: "start demo fresh" } as any)

    // The run is pinned to a NEWLY CREATED session, not the invoking one.
    const state = await waitStatus(host, ["running"], 30000)
    expect(state.sessionID).not.toBe(original)
    expect(await sessionCount()).toBe(before + 1)

    // The kickoff landed in the new session: its transcript carries the goal
    // contract block, the original's carries none of it.
    const kickoffRows = async (sessionID: string) => {
      const messages: any[] = ((await (host.client as any).session.context({ sessionID }).catch(() => [])) ?? []) as any[]
      return messages.map((m) => `${m.text ?? ""}`).join("\n")
    }
    await until(async () => (await kickoffRows(state.sessionID)).includes("Demo file says ok"), 30000)
    const freshRows = await kickoffRows(state.sessionID)
    expect(freshRows.length).toBeGreaterThan(0)
    const originalRows = await kickoffRows(original)
    expect(originalRows).not.toContain("Demo file says ok")

    // The engine records the hand-off in the ledger (from → to).
    const events = await ledger(host)
    const cleanStart = events.find((e) => e.type === "clean-start")
    expect(cleanStart).toMatchObject({ from: original, to: state.sessionID })
  } finally {
    await host.stop()
  }
}, 90000)
