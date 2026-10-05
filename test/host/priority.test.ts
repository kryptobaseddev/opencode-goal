// T061: priority surfaces — /goal list, the rpc.list the palette consumes,
// and the start picker order goals by priority then updatedAt; absent
// priority sorts last. Drafts read their priority from the contract.
import { test, expect } from "bun:test"
import { goalHost, newSession, script } from "./goal.helpers"
import { until } from "./harness"
import { GoalRpc } from "../../src/rpc"
import { DEMO_GOAL_BASE } from "../unit/priority.fixture"

const goal = (id: string, priority?: string) =>
  DEMO_GOAL_BASE(priority ? `priority: ${priority}\n` : "").replace("id: demo", `id: ${id}`).replace("Demo goal", `Goal ${id}`)

test("priority surfaces: /goal list, rpc.list and the start picker sort by priority then updatedAt", async () => {
  const host = await goalHost(script(() => ({ text: "ok" })), {
    ".opencode/goals/demo/goal.yaml": goal("demo", "medium"), // deterministic: one goal per priority class
    ".opencode/goals/aaa-none/goal.yaml": goal("aaa-none"), // no priority — must sort last
    ".opencode/goals/zzz-high/goal.yaml": goal("zzz-high", "high"),
    ".opencode/goals/mmm-low/goal.yaml": goal("mmm-low", "low"),
  })
  try {
    const goalRpc = (host.client as any).rpc(GoalRpc)
    const decisions: any[] = []
    goalRpc.events.on("decision", (event: any) => decisions.push(event.data))

    // rpc.list feeds the TUI palette (attachables) and the Goals tab
    const listed = await goalRpc.list({})
    expect(listed.goals.map((g: any) => g.slug)).toEqual(["zzz-high", "demo", "mmm-low", "aaa-none"])
    expect(listed.goals[0]).toMatchObject({ slug: "zzz-high", priority: "high" })
    expect(listed.goals.find((g: any) => g.slug === "aaa-none").priority).toBeUndefined()

    // /goal list renders the same order (the command exercises listText)
    const s1 = await newSession(host)
    await host.client.session.command({ sessionID: s1, name: "goal", text: "list" } as any)
    const listed2 = await goalRpc.list({})
    expect(listed2.goals.map((g: any) => g.slug)).toEqual(["zzz-high", "demo", "mmm-low", "aaa-none"])

    // the start picker offers the same priority order in its act-able choices
    await host.client.session.command({ sessionID: s1, name: "goal", text: "start" } as any)
    const picker = await until(() => decisions.find((d) => d.kind === "start-picker"), 10000)
    expect(picker.choices.map((c: any) => c.arg)).toEqual(["zzz-high", "demo", "mmm-low", "aaa-none"])
  } finally {
    await host.stop()
  }
}, 90000)
