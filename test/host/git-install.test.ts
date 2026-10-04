// Installs the plugin the way a user does: from a GitHub tag via OpenCode's
// own package installer. Set OCGOAL_GIT_SPEC to test another ref.
import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { startHost, until } from "./harness"

const SPEC = process.env.OCGOAL_GIT_SPEC ?? "github:kryptobaseddev/opencode-goal#v0.1.0-alpha.1"

describe.skipIf(!process.env.OCGOAL_GIT_INSTALL)("install from git", () => {
  test(`OpenCode installs ${SPEC} and registers /goal, the tools and the skill`, async () => {
    const host = await startHost({ plugins: [SPEC], git: true, script: () => ({ text: "ok" }) })
    try {
      const commands: any = await until(async () => {
        const list: any = await host.client.command.list({ location: host.location } as any)
        const items = Array.isArray(list) ? list : list?.data ?? []
        return items.some((c: any) => c.name === "goal") ? items : undefined
      }, 120000, 500)
      expect(commands.some((c: any) => c.name === "goal")).toBe(true)
      const skills: any = await host.client.skill.list({ location: host.location } as any)
      expect((Array.isArray(skills) ? skills : skills?.data ?? []).some((s: any) => s.id === "write-goal")).toBe(true)

      // T048: the TUI entry's runtime must resolve in the installed cache —
      // @opentui/solid lived in devDependencies once, so git installs (which
      // ship production deps only) silently broke the whole TUI side: no
      // palette commands, no sidebar, no panel, while the server side worked.
      const cacheRoot = join(homedir(), ".cache", "opencode", "npm")
      const dirs = readdirSync(cacheRoot).filter((d) => d.startsWith("git-opencode-goal-"))
      const newest = dirs.map((d) => {
        const base = join(cacheRoot, d)
        return readdirSync(base).map((ts) => join(base, ts)).filter((p) => p.includes("node_modules") === false)
      }).flat().sort().at(-1)
      const installed = join(newest!, "node_modules", "@opentui", "solid")
      expect(existsSync(installed)).toBe(true)
    } finally {
      await host.stop()
    }
  }, 180000)
})
