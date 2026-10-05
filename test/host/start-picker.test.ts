// T060: no-arg /goal start used to print a dead usage line; it now opens the
// startable-goal picker — a keyboard-selectable dialog (the T050 decision
// machinery: kind + message + structured choices wired to rpc.act). Startable
// = contract in this project, not archived, no live run anywhere. With no
// startable goal the empty state offers /goal new instead.
import { test, expect } from "bun:test"
import { goalHost, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"
import { GoalRpc } from "../../src/rpc"

test("start picker: no-arg /goal start lists startable goals as an act-able dialog and drives a real start; empty state offers /goal new", async () => {
  const host = await goalHost(script(() => ({ text: "Working under a picker start." })))
  try {
    const goalRpc = (host.client as any).rpc(GoalRpc)
    const decisions: any[] = []
    goalRpc.events.on("decision", (event: any) => decisions.push(event.data))

    // --- the picker: demo exists, unstarted → selectable, act-able choices
    const s1 = await newSession(host)
    await host.client.session.command({ sessionID: s1, name: "goal", text: "start" } as any)
    const picker = await until(() => decisions.find((d) => d.kind === "start-picker"), 10000)
    expect(picker.message).toContain("Start which goal?")
    const demo = picker.choices.find((c: any) => c.arg === "demo")
    expect(demo).toMatchObject({ act: "start", label: expect.stringContaining("Demo file says ok") })

    // --- driving the dialog's own wiring (what the TUI dispatches) starts it
    const result = await goalRpc.act({ sessionID: s1, action: demo.act, arg: demo.arg })
    expect(result.ok).toBe(true)
    const state = await waitStatus(host, ["running"], 30000)
    expect(state.sessionID).toBe(s1)

    // --- empty state: with demo live, a second session has nothing startable
    const s2 = await newSession(host)
    decisions.length = 0
    await host.client.session.command({ sessionID: s2, name: "goal", text: "start" } as any)
    const empty = await until(() => decisions.find((d) => d.kind === "start-picker"), 10000)
    expect(empty.message).toContain("No startable goal")
    expect(empty.choices[0]).toMatchObject({ run: "/goal new <what you want done>" })
  } finally {
    await host.stop()
  }
}, 90000)
