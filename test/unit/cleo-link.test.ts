import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleoFacts, cleoLinkEvent, type Runner } from "../../src/engine/cleo-link"

// T027 — the CLEO link is optional and CLI-first: the CLI is authoritative
// when it answers in time, the project-context.json config is the fallback,
// a project without .cleo yields nothing (zero behavioural change), and no
// path ever touches .cleo/*.db.

const cliOk: Runner = async () => ({ stdout: JSON.stringify({ data: { projectId: "5f4ab735-ef8e" } }), exit: 0 })
const cliFails: Runner = async () => ({ stdout: "", exit: 1 })
const cliHangs: Runner = () => new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 50))

function withProject(setup: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "ocgoal-cleo-"))
  setup(root)
  return root
}

describe("CLEO link (T027)", () => {
  const dirs: string[] = []
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

  test("a project without .cleo has no linkage — nothing is recorded", async () => {
    const root = withProject(() => {})
    dirs.push(root)
    expect(await cleoFacts(root, cliOk)).toBeUndefined()
    expect(cleoLinkEvent(undefined)).toBeUndefined()
  })

  test("the CLI is authoritative when it answers", async () => {
    const root = withProject((r) => mkdirSync(join(r, ".cleo"), { recursive: true }))
    dirs.push(root)
    const facts = await cleoFacts(root, cliOk)
    expect(facts).toMatchObject({ source: "cli", projectId: "5f4ab735-ef8e" })
    expect(cleoLinkEvent(facts)).toMatchObject({ type: "cleo-linked", via: "cli", projectId: "5f4ab735-ef8e" })
  })

  test("a failing or hanging CLI degrades to the project-context.json signal", async () => {
    const root = withProject((r) => {
      mkdirSync(join(r, ".cleo"), { recursive: true })
      writeFileSync(join(r, ".cleo", "project-context.json"), JSON.stringify({ schemaVersion: "1.0.0", detectedAt: "2026-10-02T23:22:33.004Z", projectTypes: ["unknown"] }))
    })
    dirs.push(root)
    for (const runner of [cliFails, cliHangs]) {
      const facts = await cleoFacts(root, runner, 100)
      expect(facts).toMatchObject({ source: "config", projectTypes: ["unknown"] })
      expect(cleoLinkEvent(facts)).toMatchObject({ type: "cleo-linked", via: "config", projectTypes: ["unknown"] })
    }
  })

  test("no path reads the CLEO database — only the CLI and the config file", async () => {
    const root = withProject((r) => {
      mkdirSync(join(r, ".cleo"), { recursive: true })
      writeFileSync(join(r, ".cleo", "project-context.json"), "{}")
    })
    dirs.push(root)
    const seen: Array<[string, string[]]> = []
    const recorder: Runner = async (command, args) => {
      seen.push([command, args])
      return { stdout: "", exit: 1 }
    }
    await cleoFacts(root, recorder)
    expect(seen).toEqual([["cleo", ["doctor", "project-identity"]]])
  })
})
