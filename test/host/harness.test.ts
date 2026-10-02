import { describe, expect, test } from "bun:test"
import { startHost, toolNames } from "./harness"

describe("host harness", () => {
  test("starts an isolated OpenCode 2 server, answers from the fixture, and tears down", async () => {
    const host = await startHost({ script: () => ({ text: "fixture says hi" }) })
    try {
      const info: any = await host.client.server.info()
      expect(info).toBeTruthy()
      const session: any = await host.client.session.create({ location: host.location, agent: "build", model: { providerID: "fixture", id: "test" } } as any)
      await host.client.session.prompt({ sessionID: session.id, text: "hello" } as any)
      await host.client.session.wait({ sessionID: session.id })
      expect(host.fixture.requests.length).toBeGreaterThan(0)
      expect(host.fixture.requests.some((r) => toolNames(r).includes("read"))).toBe(true)
      expect(host.root.startsWith("/")).toBe(true)
    } finally {
      await host.stop()
    }
  }, 120000)
})
