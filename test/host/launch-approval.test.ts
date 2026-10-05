// T068 (live defect starting ship-v031-launch-experience): goal_start refused
// an owner-approved launch. Three root causes fixed and proven here:
//   1. label matching — answers.includes("Start goal now") rejected the
//      skill's own "Start goal now (Recommended)"; matching is now prefix-based
//   2. durability — launchApprovedAt was in-memory only; approvals now persist
//      to .opencode/goals/.launch-approvals.json and survive a server reload
//      inside the 10-minute TTL
//   3. diagnosis — the refusal names what was observed (no approval seen vs
//      label mismatch vs expired) instead of one generic message
import { test, expect } from "bun:test"
import { goalHost, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

/** Drive one turn whose model calls goal_start, and collect its tool result. */
async function goalStartTurn(host: Awaited<ReturnType<typeof goalHost>>, sessionID: string, trigger: string) {
  await host.client.session.prompt({ sessionID, text: trigger } as any)
  let results: string[] = []
  await until(async () => {
    const req = host.fixture.requests.filter((r) => JSON.stringify(r.messages).includes(trigger)).at(-1)
    results = (req?.messages ?? []).filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    return results.some((t) => t.includes("goal") || t.includes("Launching"))
  }, 30000)
  return results.join("\n")
}

const LAUNCH_FORM = (label: string) => ({
  title: "Launch this goal?",
  fields: [{ key: "q0", type: "string" as const, custom: true, options: [{ value: label, label }] }],
})

test("launch approval: prefix labels accepted, restart-durable, diagnosable refusals", async () => {
  const host = await goalHost(
    script((_req, turn) => {
      if (turn.results === 0 && /GOALSTART/.test(turn.trigger)) {
        return { toolCalls: [{ name: "goal_start", args: { slug: "demo" } }] }
      }
      return { text: "ok" }
    }),
  )
  try {
    // --- 1. No approval seen: the refusal says so.
    const s1 = await newSession(host)
    let out = await goalStartTurn(host, s1, "GOALSTART unapproved")
    expect(out).toMatch(/no launch approval was seen in this session/)

    // --- 2. A non-matching label is named in the refusal.
    const form2 = await (host.client.session.form as any).create({ sessionID: s1, ...LAUNCH_FORM("Save for later") })
    await (host.client.session.form as any).reply({ sessionID: s1, formID: form2.id, answer: { q0: "Save for later" } })
    out = await goalStartTurn(host, s1, "GOALSTART wrong-label")
    expect(out).toMatch(/does not start with/)
    expect(out).toMatch(/Save for later/)

    // --- 3. The skill's own "(Recommended)" suffix approves, and the goal starts.
    const form3 = await (host.client.session.form as any).create({ sessionID: s1, ...LAUNCH_FORM("Start goal now (Recommended)") })
    await (host.client.session.form as any).reply({ sessionID: s1, formID: form3.id, answer: { q0: "Start goal now (Recommended)" } })
    await goalStartTurn(host, s1, "GOALSTART approved")
    await waitStatus(host, ["running"], 30000)
    const started = await run(host)
    expect(started.sessionID).toBe(s1)
    // The approval was consumed: a second start attempt reports no approval.
    await host.client.session.command({ sessionID: s1, name: "goal", text: "abort" } as any)
    await waitStatus(host, ["aborted"], 30000)
    out = await goalStartTurn(host, s1, "GOALSTART consumed")
    expect(out).toMatch(/no launch approval was seen in this session/)

    // --- 4. Durability: an approval survives a server reload inside the TTL.
    const s2 = await newSession(host)
    const form4 = await (host.client.session.form as any).create({ sessionID: s2, ...LAUNCH_FORM("Start goal now") })
    await (host.client.session.form as any).reply({ sessionID: s2, formID: form4.id, answer: { q0: "Start goal now" } })
    await host.client.location.reload()
    await until(async () => {
      try {
        await host.client.plugin.list({ location: host.location } as any)
        return true
      } catch {
        return false
      }
    }, 30000)
    await goalStartTurn(host, s2, "GOALSTART after-reload")
    const reloaded = await waitStatus(host, ["running"], 30000)
    expect(reloaded.sessionID).toBe(s2)
    await host.client.session.command({ sessionID: s2, name: "goal", text: "abort" } as any)
    await waitStatus(host, ["aborted"], 30000)

    // --- 5. An expired on-disk approval is reported as expired (the disk path
    //     is genuinely read, not just the in-memory fast path).
    const s3 = await newSession(host)
    const approvalsFile = `${host.project}/.opencode/goals/.launch-approvals.json`
    const stale = { [s3]: { at: Date.now() - 11 * 60_000, label: "Start goal now" } }
    await Bun.write(approvalsFile, JSON.stringify(stale))
    out = await goalStartTurn(host, s3, "GOALSTART expired")
    expect(out).toMatch(/expired/)
  } finally {
    await host.stop()
  }
}, 120000)
