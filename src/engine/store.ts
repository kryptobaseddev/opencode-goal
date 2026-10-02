// A goal is a folder: .opencode/goals/<slug>/ holds the owner's contract
// (goal.yaml) and the plugin's run.json, ledger.jsonl and evidence/.
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeSync } from "node:fs"
import { join } from "node:path"
import { parseContract, type ParseResult } from "../contract/parse"
import type { RunState } from "./state"

export type LedgerEvent = { t: number; type: string; [key: string]: unknown }

export class Store {
  readonly goalsDir: string
  constructor(readonly root: string) {
    this.goalsDir = join(root, ".opencode", "goals")
  }

  dir(slug: string) {
    return join(this.goalsDir, slug)
  }

  contractPath(slug: string) {
    return join(this.dir(slug), "goal.yaml")
  }

  slugs(): string[] {
    if (!existsSync(this.goalsDir)) return []
    return readdirSync(this.goalsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(this.goalsDir, d.name, "goal.yaml")))
      .map((d) => d.name)
      .sort()
  }

  readContract(slug: string): (ParseResult & { text: string }) | undefined {
    const path = this.contractPath(slug)
    if (!existsSync(path)) return undefined
    const text = readFileSync(path, "utf8")
    return { ...parseContract(text, { slug }), text }
  }

  readRun(slug: string): RunState | undefined {
    const path = join(this.dir(slug), "run.json")
    if (!existsSync(path)) return undefined
    try {
      const value = JSON.parse(readFileSync(path, "utf8"))
      return value?.version === 1 ? (value as RunState) : undefined
    } catch {
      return undefined
    }
  }

  writeRun(state: RunState) {
    const dir = this.dir(state.slug)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, "run.json")
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    const fd = openSync(tmp, "w", 0o600)
    try {
      writeSync(fd, `${JSON.stringify(state, null, 2)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  }

  ledger(slug: string, event: Omit<LedgerEvent, "t"> & { t?: number }) {
    const dir = this.dir(slug)
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, "ledger.jsonl"), `${JSON.stringify({ t: Date.now(), ...event })}\n`, { mode: 0o600 })
  }

  readLedger(slug: string, limit = 50): LedgerEvent[] {
    const path = join(this.dir(slug), "ledger.jsonl")
    if (!existsSync(path)) return []
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LedgerEvent]
        } catch {
          return []
        }
      })
  }

  evidence(slug: string, runId: string, name: string, data: unknown): string {
    const dir = join(this.dir(slug), "evidence", runId)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${name}.json`)
    const fd = openSync(file, "w", 0o600)
    try {
      writeSync(fd, `${JSON.stringify(data, null, 2)}\n`)
    } finally {
      closeSync(fd)
    }
    return file
  }
}
