// T061: optional priority in goal/v1 and the registry.
//   - the validator accepts low|medium|high and rejects anything else
//   - absent priority is valid and sorts LAST (by updatedAt)
//   - the registry entry carries priority; list() orders priority → recency
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseContract } from "../../src/contract/parse"
import { Registry, byPriorityThenRecency } from "../../src/engine/registry"
import { DEMO_GOAL_BASE } from "./priority.fixture"

const contract = (extra: string) => parseContract(DEMO_GOAL_BASE(extra), { slug: "demo" })

describe("priority in the contract (T061)", () => {
  test("optional low|medium|high are valid; anything else is an error; absent is valid", () => {
    for (const priority of ["low", "medium", "high"]) {
      const read = contract(`priority: ${priority}\n`)
      expect(read.issues.filter((i) => i.level === "error")).toHaveLength(0)
      expect(read.contract?.priority).toBe(priority)
    }
    expect(contract("priority: urgent\n").issues.some((i) => i.level === "error" && i.path.includes("priority"))).toBe(true)
    expect(contract("priority: 1\n").issues.some((i) => i.level === "error" && i.path.includes("priority"))).toBe(true)
    const absent = contract("")
    expect(absent.issues.filter((i) => i.level === "error")).toHaveLength(0)
    expect(absent.contract?.priority).toBeUndefined()
  })
})

describe("priority ordering (T061)", () => {
  test("high > medium > low > absent, ties by updatedAt descending", () => {
    const items = [
      { slug: "none-new", updatedAt: 900 },
      { slug: "low-old", priority: "low" as const, updatedAt: 100 },
      { slug: "low-new", priority: "low" as const, updatedAt: 800 },
      { slug: "high", priority: "high" as const, updatedAt: 50 },
      { slug: "medium", priority: "medium" as const, updatedAt: 60 },
      { slug: "none-old", updatedAt: 10 },
    ]
    expect(items.sort(byPriorityThenRecency).map((i) => i.slug)).toEqual(["high", "medium", "low-new", "low-old", "none-new", "none-old"])
  })

  test("the registry entry carries priority and list() sorts priority then recency", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocgoal-prio-"))
    const registry = new Registry(join(dir, "registry.json"))
    registry.update("/p", "zed", { title: "Zed", status: "draft", updatedAt: 1000 })
    registry.update("/p", "alpha", { title: "Alpha", status: "draft", priority: "high", updatedAt: 5 })
    registry.update("/p", "mid", { title: "Mid", status: "draft", priority: "medium", updatedAt: 500 })
    const order = registry.list().map((g) => g.slug)
    expect(order).toEqual(["alpha", "mid", "zed"])
    expect(registry.list()[0]).toMatchObject({ slug: "alpha", priority: "high" })
    // parity: rebuild from run.json files reproduces the same order
    const project = join(dir, "project")
    for (const [slug, run] of [
      ["zed", { version: 1, title: "Zed", status: "draft", updatedAt: 1000 }],
      ["alpha", { version: 1, title: "Alpha", status: "draft", priority: "high", updatedAt: 5 }],
    ] as const) {
      mkdirSync(join(project, ".opencode", "goals", slug), { recursive: true })
      writeFileSync(join(project, ".opencode", "goals", slug, "run.json"), JSON.stringify(run))
    }
    registry.rebuild([project])
    const rebuilt = registry.list().filter((g) => g.project === project)
    expect(rebuilt.map((g) => g.slug)).toEqual(["alpha", "zed"])
    expect(rebuilt[0]).toMatchObject({ slug: "alpha", priority: "high" })
  })
})
