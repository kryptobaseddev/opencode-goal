import { describe, expect, test } from "bun:test"
import { lockOf } from "../../src/contract/parse"
import { join } from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"

// T031 — supersession (council 20261003T162655Z-800c52ca): a new goal carries
// `supersedes: <slug>@<lock-prefix>`; /goal start enforces the admission rule
// (pointer resolves, lock matches, predecessor terminal or the owner's
// explicit acknowledgment is recorded), flips the predecessor terminal
// `superseded`, archives it (demote never delete) and ledgers both sides.

const goalYaml = (id: string, supersedes?: string) => `schema: goal/v1
id: ${id}
title: ${id} probe
${supersedes ? `supersedes: ${supersedes}\n` : ""}intent:
  verbatim: "probe"
outcome: ${id}.txt exists and says ok
non_goals: [x]
criteria:
  - id: C1
    statement: '${id}.txt SHALL contain the line "status: ok"' 
    check:
      kind: command
      run: "grep -q 'status: ok' ${id}.txt"
      expect: {exit: 0}
  - id: C2
    statement: ${id}.txt SHALL exist
    check: {kind: file, path: ${id}.txt}
plan:
  - {id: S1, title: Write ${id}.txt, proves: [C1, C2]}
`

const doer = () => (req: any, turn: any) => {
  if (turn.trigger.includes("goal started") || turn.trigger.includes("host verdict")) {
    // whichever goal this turn serves, write the file named in its own trigger
    const id = /goal started: (\S+?) probe/.exec(turn.trigger)?.[1] ?? /goal "?(\S+?)"?/.exec(turn.trigger)?.[1]
    if (!id) return { text: "orienting" }
    if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: `${id}.txt`, content: "status: ok\n" } }] }
    if (turn.results === 1) return { toolCalls: [{ name: "goal_claim", args: { summary: `wrote ${id}.txt`, evidence: { C1: "w", C2: "e" } } }] }
  }
  return { text: "nothing to do" }
}

describe("supersession (T031)", () => {
  test("a terminal predecessor is superseded: pointer, ledger on both sides, archive, and the successor completes", async () => {
    const host = await goalHost(script(doer()), {
      ".opencode/goals/sup-a/goal.yaml": goalYaml("sup-a"),
    })
    try {
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start sup-a" } as any)
      const first = await waitStatus(host, ["complete"], 90000, "sup-a")
      expect(first.status).toBe("complete")

      // the successor references the predecessor's exact lock
      const predecessor = await run(host, "sup-a")
      const pointer = `sup-a@${predecessor.lock.slice(0, 12)}`
      await mkdir(join(host.project, ".opencode/goals/sup-b"), { recursive: true })
      await writeFile(join(host.project, ".opencode/goals/sup-b/goal.yaml"), goalYaml("sup-b", pointer))

      const session2 = await newSession(host)
      await host.client.session.command({ sessionID: session2, name: "goal", text: "start sup-b" } as any)
      const second = await waitStatus(host, ["complete"], 90000, "sup-b")
      expect(second.status).toBe("complete")

      // the predecessor is terminal-superseded, archived, ledgered on both sides
      const bEvents = await ledger(host, "sup-b")
      expect(bEvents.some((e) => e.type === "supersession" && e.of === "sup-a")).toBe(true)
      const aEvents = JSON.parse(await host.readProject(".opencode/goals-archive/sup-a/ledger.jsonl").then((t: string) => `[${t.trim().split("\n").join(",")}]`))
      expect(aEvents.some((e: any) => e.type === "superseded-by" && e.by === "sup-b")).toBe(true)
      const archivedRun = JSON.parse(await host.readProject(".opencode/goals-archive/sup-a/run.json"))
      expect(archivedRun.status).toBe("superseded")
    } finally {
      await host.stop()
    }
  }, 180000)

  test("superseding a live predecessor is refused without explicit acknowledgment, allowed with it", async () => {
    const host = await goalHost(script((req: any, turn: any) => {
      // sup-c stalls (talk-only) so it stays live/paused
      return { text: "thinking" }
    }), {
      ".opencode/goals/sup-c/goal.yaml": goalYaml("sup-c"),
    })
    try {
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start sup-c" } as any)
      const paused = await waitStatus(host, ["paused", "running", "waiting", "verifying"], 90000, "sup-c")
      const live = await run(host, "sup-c")

      const pointer = `sup-c@${live.lock.slice(0, 12)}`
      await mkdir(join(host.project, ".opencode/goals/sup-d"), { recursive: true })
      await writeFile(join(host.project, ".opencode/goals/sup-d/goal.yaml"), goalYaml("sup-d", pointer))

      // without acknowledgment: refused, predecessor untouched
      const session2 = await newSession(host)
      await host.client.session.command({ sessionID: session2, name: "goal", text: "start sup-d" } as any)
      await Bun.sleep(2500)
      expect((await run(host, "sup-c")).status).not.toBe("superseded")
      expect((await run(host, "sup-d").catch(() => undefined))).toBeUndefined()

      // with acknowledgment: proceeds; the predecessor flips terminal and archives
      await host.client.session.command({ sessionID: session2, name: "goal", text: "start sup-d acknowledge-supersede" } as any)
      const eventually = await (async () => {
        for (let i = 0; i < 100; i++) {
          const r = await run(host, "sup-d").catch(() => undefined)
          if (r) return r
          await Bun.sleep(100)
        }
        throw new Error("successor never started")
      })()
      expect(eventually.status).toBeDefined()
      const archivedRun = JSON.parse(await host.readProject(".opencode/goals-archive/sup-c/run.json"))
      expect(archivedRun.status).toBe("superseded")
      const dEvents = await ledger(host, "sup-d")
      expect(dEvents.find((e) => e.type === "supersession")).toMatchObject({ of: "sup-c", acknowledged: true })
    } finally {
      await host.stop()
    }
  }, 180000)
})
