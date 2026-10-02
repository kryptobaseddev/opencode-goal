// OpenCode 2 server entry. A plain-object default export with type-only imports,
// so the plugin loads without @opencode/plugin installed at runtime.
import type { Plugin } from "@opencode/plugin"
import { GoalApp } from "./app"

// S6: setup can run more than once for a location; retire the old instance first.
const instances = new Map<string, GoalApp>()

export default {
  id: "opencode-goal",
  async setup(ctx: Plugin.Context) {
    const key = ctx.location.directory
    const previous = instances.get(key)
    if (previous) await previous.stop()
    const app = new GoalApp(ctx)
    instances.set(key, app)
    await app.start()
    return async () => {
      await app.stop()
      if (instances.get(key) === app) instances.delete(key)
    }
  },
}
