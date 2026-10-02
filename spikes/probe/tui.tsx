/** @jsxImportSource @opentui/solid */
import type { Context } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { ProbeRpc } from "./rpc"
import { appendFileSync } from "node:fs"
const tlog = (dir: string, kind: string, data: unknown) => { try { appendFileSync(dir + "/.probe/tui.log", JSON.stringify({ t: Date.now(), kind, data }) + "\n") } catch {} }

export default {
  id: "probe",
  async setup(context: Context) {
    const dir = (context.location as any)?.directory ?? process.cwd()
    tlog(dir, "setup", { location: context.location, cwd: process.cwd(), version: context.app.version })
    const rpc = context.client.rpc(ProbeRpc as any) as any
    const [tick, setTick] = createSignal(0)
    const [pong, setPong] = createSignal("…")
    const off = rpc.events.on("tick", (event: any) => { tlog(dir, "tick", event.data); setTick(event.data.n) })
    const offAll = context.data.listen(({ details }: any) => { if (String(details?.type).startsWith("rpc.") || String(details?.type).startsWith("server.")) tlog(dir, "data.listen", details.type) })
    const unSidebar = context.ui.slot({
      append: "sidebar.content",
      render: (input: { sessionID: string }) => {
        rpc.ping({ sessionID: input.sessionID }).then((r: any) => setPong(r.text)).catch((e: unknown) => setPong(`ERR ${e}`))
        return (
          <box flexDirection="column">
            <text fg={context.theme.text.base as any}>PROBE-SIDEBAR tick={tick()}</text>
            <text>PONG {pong()}</text>
          </box>
        )
      },
    } as any)
    const unPill = context.ui.slot({ append: "prompt.footer.status", render: () => <text>PROBE-PILL {tick()}</text> } as any)
    return () => {
      off()
      offAll()
      unSidebar()
      unPill()
    }
  },
}
