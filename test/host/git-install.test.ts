// Installs the plugin the way a user does: from a GitHub tag via OpenCode's
// own package installer. Set OCGOAL_GIT_SPEC to test another ref.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
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
      // Installs land in the harness's shared package cache (XDG_CACHE_HOME).
      const cacheRoot = join(import.meta.dir, "..", "..", ".tmp", "host-cache", "opencode", "npm")
      const dirs = readdirSync(cacheRoot).filter((d) => d.startsWith("git-opencode-goal-"))
      const stamps = dirs.flatMap((d) => readdirSync(join(cacheRoot, d)).map((ts) => join(cacheRoot, d, ts)))
      const newest = stamps.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).at(0)!
      expect(existsSync(join(newest, "node_modules", "@opentui", "solid"))).toBe(true)
      const manifest = JSON.parse(readFileSync(join(newest, "node_modules", "opencode-goal", "package.json"), "utf8"))
      expect(manifest.dependencies?.["@opentui/solid"]).toBeDefined()
    } finally {
      await host.stop()
    }
  }, 180000)
})
