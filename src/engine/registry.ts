// T026 — the cross-project goal registry. A machine-level DERIVED index
// (council 20261003T162655Z-800c52ca): the per-project .opencode/goals/
// folders stay the source of truth; this file is a rebuildable cache that
// answers "which goals exist where, in what state" without scanning every
// project. Atomic writes (tmp + rename); OCGOAL_REGISTRY overrides the
// location so hosts and tests never pollute the real index.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"

export type RegistryEntry = { title: string; status: string; runId?: string; lock?: string; archived?: boolean; priority?: "low" | "medium" | "high"; updatedAt: number }
export type RegistryData = { version: 1; projects: Record<string, { goals: Record<string, RegistryEntry>; updatedAt: number }> }

/** T061: priority then recency — high > medium > low > absent, ties by updatedAt descending (missing updatedAt = 0). */
export const byPriorityThenRecency = <T extends { priority?: RegistryEntry["priority"]; updatedAt?: number }>(a: T, b: T): number => {
  const wa = a.priority === "high" ? 3 : a.priority === "medium" ? 2 : a.priority === "low" ? 1 : 0
  const wb = b.priority === "high" ? 3 : b.priority === "medium" ? 2 : b.priority === "low" ? 1 : 0
  return wb - wa || (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
}

export const DEFAULT_REGISTRY_PATH = join(homedir(), ".local", "share", "opencode", "goal-registry.json")

export class Registry {
  constructor(readonly path = process.env.OCGOAL_REGISTRY ?? DEFAULT_REGISTRY_PATH) {}

  read(): RegistryData {
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8"))
      if (value?.version === 1 && value.projects && typeof value.projects === "object") return value as RegistryData
    } catch {
      // missing or corrupt: the index is derived, so start empty
    }
    return { version: 1, projects: {} }
  }

  private write(data: RegistryData) {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = join(tmpdir(), `goal-registry-${process.pid}-${Date.now()}.json`)
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
    renameSync(tmp, this.path)
  }

  /** Upsert one goal; skips the write when nothing changed (persist is hot). */
  update(projectRoot: string, slug: string, entry: RegistryEntry): boolean {
    const data = this.read()
    const project = data.projects[projectRoot] ?? { goals: {}, updatedAt: 0 }
    const current = project.goals[slug]
    if (
      current &&
      current.title === entry.title &&
      current.status === entry.status &&
      current.runId === entry.runId &&
      current.lock === entry.lock &&
      current.archived === entry.archived &&
      current.priority === entry.priority
    )
      return false
    project.goals[slug] = entry
    project.updatedAt = entry.updatedAt
    data.projects[projectRoot] = project
    this.write(data)
    return true
  }

  remove(projectRoot: string, slug: string): boolean {
    const data = this.read()
    const project = data.projects[projectRoot]
    if (!project?.goals[slug]) return false
    delete project.goals[slug]
    project.updatedAt = Date.now()
    if (Object.keys(project.goals).length === 0) delete data.projects[projectRoot]
    this.write(data)
    return true
  }

  /** All goals across all known projects: [{project, slug, ...entry}], priority then recency. */
  list(): Array<{ project: string; slug: string } & RegistryEntry> {
    const out: Array<{ project: string; slug: string } & RegistryEntry> = []
    for (const [project, p] of Object.entries(this.read().projects))
      for (const [slug, entry] of Object.entries(p.goals)) out.push({ project, slug, ...entry })
    return out.sort(byPriorityThenRecency)
  }

  /**
   * Rebuild by scanning project roots; returns true when the rebuild changed
   * the index (the parity property tests rely on: update-driven and
   * scan-driven content must be identical for the same on-disk truth).
   */
  rebuild(roots: string[]): boolean {
    const data: RegistryData = { version: 1, projects: {} }
    for (const root of roots) {
      const goalsDir = join(root, ".opencode", "goals")
      if (!existsSync(goalsDir)) continue
      const project = { goals: {} as Record<string, RegistryEntry>, updatedAt: 0 }
      for (const dirent of readdirSync(goalsDir, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue
        const slug = dirent.name
        const runPath = join(goalsDir, slug, "run.json")
        let entry: RegistryEntry | undefined
        try {
          const run = JSON.parse(readFileSync(runPath, "utf8"))
          if (run?.version !== 1) continue
          entry = { title: run.title ?? slug, status: run.status ?? "draft", ...(run.runId ? { runId: run.runId } : {}), ...(run.lock ? { lock: run.lock } : {}), ...(run.priority ? { priority: run.priority } : {}), updatedAt: run.updatedAt ?? statSync(runPath).mtimeMs }
        } catch {
          // a goal folder without a readable run.json: still a draft goal
          const contract = join(goalsDir, slug, "goal.yaml")
          if (!existsSync(contract)) continue
          entry = { title: slug, status: "draft", updatedAt: statSync(contract).mtimeMs }
        }
        project.goals[slug] = entry
        project.updatedAt = Math.max(project.updatedAt, entry.updatedAt)
      }
      if (Object.keys(project.goals).length) data.projects[root] = project
    }
    const before = JSON.stringify(this.read())
    this.write(data)
    return JSON.stringify(this.read()) !== before
  }
}
