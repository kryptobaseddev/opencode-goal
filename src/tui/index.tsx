/** @jsxImportSource @opentui/solid */
// TUI plugin: a live goal card in the sidebar, a status pill under the prompt,
// a banner when the owner is needed, notices as toasts and desktop attention,
// and palette commands. Fed only by the server's GoalRpc (S6), never by files.
import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createRoot, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { GoalRpc, type GoalView } from "../rpc"
import { bannerText, cardLines, panelLines, pillText, statusText, type Tone } from "./format"

type Context = Plugin.Context

const SIDEBAR_WIDTH = 40
/** The name this plugin opens and renders in the session.panel slot. */
const PANEL_NAME = "goal-dashboard"

export default {
  id: "opencode-goal",
  async setup(context: Context) {
    const rpc = context.client.rpc(GoalRpc as any) as any
    const [views, setViews] = createStore<Record<string, GoalView | null>>({})
    const [now, setNow] = createSignal(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    const requested = new Set<string>()

    const locationOf = (sessionID: string) => (context.data.session.get(sessionID) as any)?.location
    const fetchView = async (sessionID: string) => {
      try {
        const location = locationOf(sessionID)
        const result = await rpc.snapshot({ sessionID }, location ? { location } : undefined)
        setViews(sessionID, reconcile((result?.view ?? null) as GoalView | null))
        maybeOpen(sessionID)
      } catch {
        // the server plugin may not be loaded for this location; show nothing
      }
    }
    const ensure = (sessionID: string) => {
      if (requested.has(sessionID)) return
      requested.add(sessionID)
      void fetchView(sessionID)
    }

    const offUpdated = rpc.events.on("updated", (event: any) => {
      const { sessionID, view } = event.data ?? {}
      if (typeof sessionID === "string") {
        setViews(sessionID, reconcile((view ?? null) as GoalView | null))
        maybeOpen(sessionID)
      }
    })
    const offNotice = rpc.events.on("notice", (event: any) => {
      const data = event.data ?? {}
      const current = context.ui.router.current()
      const here = current.type === "session" && current.sessionID === data.sessionID
      if (data.panel && here) {
        const view = views[data.sessionID]
        void context.ui.dialog.alert({ title: "Goal", message: view ? statusText(view, Date.now()) : String(data.text) })
      } else {
        context.ui.toast.show({ title: "Goal", message: String(data.text ?? ""), variant: (data.level ?? "info") as any, duration: data.level === "error" ? 8000 : 5000, ...(data.sessionID ? { sessionID: data.sessionID } : {}) })
      }
      if (data.attention)
        void context.attention.notify({ title: "Goal", message: String(data.text ?? ""), notification: { when: "blurred" }, sound: { name: data.attention, when: "blurred" } })
    })
    const offData = context.data.listen(({ details }: any) => {
      if (details?.type === "server.connected") for (const id of requested) void fetchView(id)
    })

    // The dashboard panel is visible by default: open it once per run whenever
    // this session has a goal. An owner-closed panel stays closed for the rest
    // of the run; the palette command reopens and focuses it.
    const openedFor = new Set<string>()
    let lastPanelInput: { focus: () => void } | undefined
    const maybeOpen = (sessionID: string | undefined) => {
      const view = sessionID ? views[sessionID] : undefined
      if (!view || openedFor.has(view.runId)) return
      if (context.ui.router.current().type !== "session") return
      openedFor.add(view.runId)
      context.ui.panel.open(PANEL_NAME)
    }

    const color = (tone: Tone) => {
      const t = context.theme as any
      if (tone === "base") return t.text.base
      if (tone === "muted") return t.text.muted
      return t.text.feedback?.[tone]?.base ?? t.text.base
    }

    const disposers: Array<() => void> = []

    disposers.push(
      context.ui.slot({
        append: "sidebar.content",
        render: (input: { sessionID: string }) => {
          ensure(input.sessionID)
          return (
            <Show when={views[input.sessionID]}>
              {(view) => (
                <box flexDirection="column" marginTop={1}>
                  <For each={cardLines(view(), now(), SIDEBAR_WIDTH)}>
                    {(line) => (
                      <text fg={color(line.tone)} wrapMode="none" truncate>
                        {line.bold ? <b>{line.text}</b> : line.text}
                      </text>
                    )}
                  </For>
                </box>
              )}
            </Show>
          )
        },
      } as any),
    )

    disposers.push(
      context.ui.slot({
        append: "prompt.footer.status",
        render: (input: { sessionID?: string }) => {
          if (input.sessionID) ensure(input.sessionID)
          return (
            <Show when={input.sessionID ? views[input.sessionID] : undefined}>
              {(view) => <text fg={color(view().status === "running" ? "success" : "muted")}>{pillText(view(), now())}</text>}
            </Show>
          )
        },
      } as any),
    )

    disposers.push(
      context.ui.slot({
        append: "session.composer.top",
        render: (input: { sessionID: string }) => {
          ensure(input.sessionID)
          return (
            <Show when={views[input.sessionID] ? bannerText(views[input.sessionID]!) : undefined}>
              {(banner) => (
                <box paddingLeft={1} paddingRight={1}>
                  <text fg={color(banner().tone)} wrapMode="none" truncate>
                    {banner().text}
                  </text>
                </box>
              )}
            </Show>
          )
        },
      } as any),
    )

    disposers.push(
      context.ui.slot({
        append: "session.panel",
        render: (input: any) => {
          ensure(input.sessionID)
          lastPanelInput = input
          const view = input.name === PANEL_NAME ? views[input.sessionID] : undefined
          return (
            <Show when={view}>
              {(v) => (
                <box flexDirection="column" paddingLeft={1} paddingRight={1}>
                  <For each={panelLines(v(), now(), typeof input.width === "number" ? input.width : 46)}>
                    {(line) => (
                      <text fg={color(line.tone)} wrapMode="none" truncate>
                        {line.bold ? <b>{line.text}</b> : line.text}
                      </text>
                    )}
                  </For>
                </box>
              )}
            </Show>
          )
        },
      } as any),
    )

    // Palette commands live in a keymap layer. T050: the layer is "owned by
    // the calling component" — registering it from inside a slot render that
    // returns null leaves it with no live owner, so the palette never listed
    // our commands. createRoot gives the layer a stable owner we dispose at
    // teardown instead.
    const currentSession = () => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }
    const act = async (action: string, arg?: string) => {
      const sessionID = currentSession()
      if (!sessionID) return
      const location = locationOf(sessionID)
      try {
        const result = await rpc.act({ sessionID, action, ...(arg ? { arg } : {}) }, location ? { location } : undefined)
        context.ui.toast.show({ title: "Goal", message: result.message, variant: result.ok ? "success" : "warning" })
      } catch (error) {
        context.ui.toast.show({ title: "Goal", message: `Goal plugin unavailable: ${String(error)}`, variant: "error" })
      }
    }
    const hasGoal = () => {
      const id = currentSession()
      return !!(id && views[id])
    }
    disposers.push(
      context.ui.slot({
        append: "app",
        render: () => {
          context.keymap.layer(() => ({
            commands: [
              {
                id: "goal.panel",
                title: "Goal: focus dashboard",
                group: "Goal",
                palette: true,
                enabled: hasGoal,
                run: () => {
                  context.ui.panel.open(PANEL_NAME)
                  lastPanelInput?.focus()
                },
              },
              {
                id: "goal.status",
                title: "Goal: show status",
                group: "Goal",
                palette: true,
                enabled: hasGoal,
                run: () => {
                  const view = views[currentSession()!]
                  if (view) void context.ui.dialog.alert({ title: "Goal", message: statusText(view, Date.now()) })
                },
              },
              { id: "goal.pause", title: "Goal: pause", group: "Goal", palette: true, enabled: hasGoal, run: () => act("pause") },
              { id: "goal.resume", title: "Goal: resume", group: "Goal", palette: true, enabled: hasGoal, run: () => act("resume") },
              { id: "goal.verify", title: "Goal: verify now", group: "Goal", palette: true, enabled: hasGoal, run: () => act("verify") },
              {
                id: "goal.approve",
                title: "Goal: approve a criterion",
                group: "Goal",
                palette: true,
                enabled: hasGoal,
                run: async () => {
                  const view = views[currentSession()!]
                  if (!view) return
                  const pick = await context.ui.dialog.select({
                    title: "Approve which criterion?",
                    options: view.criteria.filter((c) => !c.invariant && c.status !== "pass").map((c) => ({ title: `${c.id} ${c.statement}`, value: c.id, description: c.kind })),
                  })
                  if (pick) await act("approve", pick)
                },
              },
              {
                id: "goal.abort",
                title: "Goal: abort",
                group: "Goal",
                palette: true,
                enabled: hasGoal,
                run: async () => {
                  const ok = await context.ui.dialog.confirm({ title: "Abort the goal?", message: "The run stops for good; its ledger and evidence stay on disk.", label: { confirm: "Abort", cancel: "Keep running" } })
                  if (ok) await act("abort")
                },
              },
            ],
          }))
          return null
        },
      } as any),
    )

    return () => {
      clearInterval(timer)
      offUpdated?.()
      offNotice?.()
      offData?.()
      for (const dispose of disposers.splice(0)) dispose()
    }
  },
}
