// Council Executor action (run 20261003T162655Z-800c52ca): time the Store's real
// operations at 100 / 1,000 / 5,000 synthetic goals and classify each cell with
// the three-branch rule: <50ms slugs survive · >250ms derived index mandatory ·
// in between = inconclusive (defer to the T026–T028 design review).
//
// Run: bun spikes/scale-bench.ts
//
// RECORDED RESULT (2026-10-03, 10 iterations per cell, median/p95 ms):
// | goals | operation      | median | p95   | branch        |
// | 100   | slugs()        | 0.2    | 3.2   | slugs survive |
// | 100   | list() mirror  | 2.7    | 4.2   | slugs survive |
// | 100   | exists(dir)    | 0.3    | 1.6   | slugs survive |
// | 1000  | slugs()        | 2.6    | 3.2   | slugs survive |
// | 1000  | list() mirror  | 33.8   | 38.0  | slugs survive |
// | 1000  | exists(dir)    | 3.2    | 4.1   | slugs survive |
// | 5000  | slugs()        | 13.8   | 14.8  | slugs survive |
// | 5000  | list() mirror  | 157.6  | 167.7 | inconclusive  |
// | 5000  | exists(dir)    | 12.2   | 14.1  | slugs survive |
// Read: identity/GC/existence decisions are safe on slugs+folders; the derived
// registry (CLEO T026) is justified for status/list surfaces at scale, and
// existence checks must NOT route through full list builds.
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Store } from "../src/engine/store"

const ROOT = join(import.meta.dir, "..", ".tmp", "scale-bench")
const SIZES = [100, 1_000, 5_000]
const ITERATIONS = 10

// Minimal shapes the real Store reads: goal.yaml (a contract parse needs the
// frontmatter; slugs() only checks existence, readRun needs version:1).
const goalYaml = (i: number) => `---
name: scale-goal-${i}
description: Synthetic goal ${i} for the scale benchmark (council 20261003T162655Z-800c52ca).
metadata:
  version: "1.0.0"
  last_updated: "2026-10-03 00:00:00"
  author: bench
---

# scale-goal-${i}
Outcome: synthetic outcome ${i}.
`
const runJson = (slug: string) =>
  JSON.stringify({
    version: 1,
    slug,
    title: `Scale goal ${slug}`,
    status: "complete",
    runId: `bench-${slug}`,
    turn: 1,
    timeline: [],
    activeMs: 0,
    activeSince: null,
    usage: { tokens: 0, cost: 0, baseTokens: null, baseCost: null },
    budget: [],
    budgetRatio: 0,
    criteria: { C1: { status: "pass", rejections: 0 } },
    steps: [],
    awaitingUser: false,
    amendments: 0,
    flags: 0,
    updatedAt: 0,
  })

function synthesize(n: number) {
  rmSync(ROOT, { recursive: true, force: true })
  const store = new Store(ROOT)
  for (let i = 0; i < n; i++) {
    const slug = `scale-goal-${String(i).padStart(5, "0")}`
    const dir = store.dir(slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(store.contractPath(slug), goalYaml(i))
    writeFileSync(join(dir, "run.json"), runJson(slug))
  }
  return store
}

const time = (fn: () => unknown): number => {
  const t0 = performance.now()
  fn()
  return performance.now() - t0
}
const stats = (ms: number[]) => {
  const sorted = [...ms].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]!
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!
  return { median, p95 }
}
const branch = (median: number) => (median < 50 ? "slugs survive" : median > 250 ? "index mandatory" : "inconclusive")

console.log(`# scale bench — root ${ROOT}, ${ITERATIONS} iterations per cell`)
console.log("| goals | operation | median ms | p95 ms | branch |")
console.log("|---|---|---|---|---|")
for (const n of SIZES) {
  const store = synthesize(n)
  const ops: Record<string, () => unknown> = {
    "slugs()": () => store.slugs(),
    "list() mirror": () =>
      store.slugs().map((slug) => {
        const run = store.readRun(slug)
        const states = run ? Object.values(run.criteria) : []
        return { slug, title: run?.title ?? slug, status: run?.status ?? "draft", proven: states.filter((s: any) => s.status === "pass").length, total: states.length }
      }),
    "exists(dir)": () => existsSyncSafe(store, store.slugs()[0] ?? "none"),
  }
  for (const [name, op] of Object.entries(ops)) {
    const ms = Array.from({ length: ITERATIONS }, () => time(op))
    const { median, p95 } = stats(ms)
    console.log(`| ${n} | ${name} | ${median.toFixed(1)} | ${p95.toFixed(1)} | ${branch(median)} |`)
  }
}
rmSync(ROOT, { recursive: true, force: true })

function existsSyncSafe(store: Store, slug: string) {
  // mirrors the existence check an admission-time probe would use
  return require("node:fs").existsSync(store.dir(slug))
}
