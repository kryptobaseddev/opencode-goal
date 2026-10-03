import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Registry } from "../../src/engine/registry"

// T026 — the derived machine-level goal registry (council 20261003T162655Z-800c52ca):
// update-driven and scan-driven content must be identical for the same
// on-disk truth, the index lists goals across projects, and it never holds
// anything the .opencode/goals/ folders do not.

const runJson = (slug: string, status: string, updatedAt: number, title = slug) =>
  JSON.stringify({ version: 1, slug, title, status, runId: "r-" + slug, lock: "lock-" + slug, updatedAt })

function projectWithGoals(name: string, goals: Array<[string, string, number]>) {
  const root = mkdtempSync(join(tmpdir(), `ocgoal-reg-${name}-`))
  for (const [slug, status, at] of goals) {
    const dir = join(root, ".opencode", "goals", slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "goal.yaml"), `schema: goal/v1\nid: ${slug}\n`)
    writeFileSync(join(dir, "run.json"), runJson(slug, status, at))
  }
  return root
}

describe("goal registry (T026)", () => {
  const registryPath = join(tmpdir(), `ocgoal-registry-test-${process.pid}.json`)
  const registry = new Registry(registryPath)
  const cleanup: string[] = [registryPath]
  afterAll(() => {
    for (const p of cleanup) rmSync(p, { recursive: true, force: true })
  })

  test("updates on transitions, skips no-op writes, and lists across projects", () => {
    rmSync(registryPath, { force: true })
    const a = projectWithGoals("a", [["alpha", "running", 1000]])
    const b = projectWithGoals("b", [["beta", "complete", 2000]])
    cleanup.push(a, b)

    expect(registry.update(a, "alpha", { title: "alpha", status: "running", runId: "r-alpha", lock: "lock-alpha", updatedAt: 1000 })).toBe(true)
    expect(registry.update(b, "beta", { title: "beta", status: "complete", runId: "r-beta", lock: "lock-beta", updatedAt: 2000 })).toBe(true)
    // a transition refreshes the entry
    expect(registry.update(a, "alpha", { title: "alpha", status: "paused", runId: "r-alpha", lock: "lock-alpha", updatedAt: 3000 })).toBe(true)
    // an unchanged update does not rewrite the file
    const before = JSON.stringify(registry.read())
    expect(registry.update(a, "alpha", { title: "alpha", status: "paused", runId: "r-alpha", lock: "lock-alpha", updatedAt: 3000 })).toBe(false)
    expect(JSON.stringify(registry.read())).toBe(before)

    const list = registry.list()
    expect(list.map((g) => `${g.project.endsWith("b") || g.slug === "beta" ? "beta" : "alpha"}:${g.status}`).sort()).toEqual(["alpha:paused", "beta:complete"])
    expect(list).toHaveLength(2)
    expect(new Set(list.map((g) => g.project)).size).toBe(2)
  })

  test("rebuild-by-scan reproduces the update-driven index exactly (parity)", () => {
    rmSync(registryPath, { force: true })
    const a = projectWithGoals("parity-a", [["one", "complete", 1000], ["two", "aborted", 1100]])
    const b = projectWithGoals("parity-b", [["three", "running", 1200]])
    cleanup.push(a, b)

    // drive the index through updates
    registry.update(a, "one", { title: "one", status: "complete", runId: "r-one", lock: "lock-one", updatedAt: 1000 })
    registry.update(a, "two", { title: "two", status: "aborted", runId: "r-two", lock: "lock-two", updatedAt: 1100 })
    registry.update(b, "three", { title: "three", status: "running", runId: "r-three", lock: "lock-three", updatedAt: 1200 })
    const driven = JSON.parse(JSON.stringify(registry.read()))

    // wipe and rebuild purely by scanning the same roots
    rmSync(registryPath, { force: true })
    expect(registry.rebuild([a, b])).toBe(true)
    const rebuilt = JSON.parse(JSON.stringify(registry.read()))
    expect(rebuilt).toEqual(driven)

    // rebuilding again is a no-op
    expect(registry.rebuild([a, b])).toBe(false)
  })

  test("a goal folder with an unreadable run.json indexes as a draft; removal prunes empty projects", () => {
    rmSync(registryPath, { force: true })
    const root = mkdtempSync(join(tmpdir(), "ocgoal-reg-draft-"))
    cleanup.push(root)
    const dir = join(root, ".opencode", "goals", "drafty")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "goal.yaml"), "schema: goal/v1\nid: drafty\n")

    expect(registry.rebuild([root])).toBe(true)
    const entry = registry.read().projects[root]!.goals["drafty"]!
    expect(entry.status).toBe("draft")

    registry.update(root, "drafty", { title: "drafty", status: "running", updatedAt: 1 })
    expect(registry.remove(root, "drafty")).toBe(true)
    expect(registry.read().projects[root]).toBeUndefined()
    expect(registry.list()).toHaveLength(0)
  })
})
