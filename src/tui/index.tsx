/** @jsxImportSource @opentui/solid */
// TUI plugin: a live goal card in the sidebar, a status pill under the prompt,
// a banner when the owner is needed, notices as toasts and desktop attention,
// and palette commands. Fed only by the server's GoalRpc (S6), never by files.
import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { GoalRpc, type GoalView } from "../rpc"
import { bannerText, pillText, statusText, type Tone } from "./format"
import { tracerLines } from "./tracer"
import { cardCompactLines, dashboardLines, decisionRows, dialogDigest, DASHBOARD_TABS, type DashboardTab } from "./dashboard"

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
    // T058: events are the fast path, not the only path. A subscription that
    // attaches before the plugin registers, a dropped stream, or a reconnect
    // must never freeze the dashboard at its first snapshot (the live defect:
    // stuck on S1, 0/N criteria for a whole run). Renders and a periodic
    // ticker re-fetch snapshots that went stale, so the view converges.
    const STALE_MS = 4000
    const fetchedAt = new Map<string, number>()
    const fetchView = async (sessionID: string) => {
      fetchedAt.set(sessionID, Date.now())
      try {
        const location = locationOf(sessionID)
        const result = await rpc.snapshot({ sessionID }, location ? { location } : undefined)
        setViews(sessionID, reconcile((result?.view ?? null) as GoalView | null))
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
    // T045: the post-goal summary lands as a dialog for the owner (headline
    // as the toast, full text — provenance caveats, scope audit, follow-ups —
    // in the dialog), only for the session the goal belongs to.
    // T065: dialogs are not scrollable — the full text once overflowed off
    // the screen; dialogs carry a screen-fit digest, the panel keeps the rest.
    // T066: sequencing state — dialogs stay FIRST at a transition; a summary
    // arriving while a decision dialog is open queues behind it and renders
    // as the screen-fit digest when the decision closes.
    const openDecisions = new Map<string, number>()
    const pendingSummaries = new Map<string, { headline: string; text: string; status: string }>()
    const flushSummary = (sessionID: string) => {
      const queued = pendingSummaries.get(sessionID)
      pendingSummaries.delete(sessionID)
      if (!queued) return
      void context.ui.dialog.alert({
        title: `Goal summary — ${queued.status}`,
        message: dialogDigest(queued.headline, queued.text),
      })
    }
    const offSummary = rpc.events.on("summary", (event: any) => {
      const data = event.data ?? {}
      const current = context.ui.router.current()
      if (current.type !== "session" || current.sessionID !== data.sessionID) {
        context.ui.toast.show({ title: "Goal summary", message: String(data.headline ?? data.text ?? ""), variant: "info", ...(data.sessionID ? { sessionID: data.sessionID } : {}) })
        return
      }
      // T066: at a transition the decision dialog renders FIRST — a summary
      // arriving while one is open queues behind it (headline as a toast so
      // nothing is silent) and renders as the digest when the decision closes.
      if (openDecisions.has(data.sessionID)) {
        pendingSummaries.set(data.sessionID, { headline: String(data.headline ?? "summary"), text: String(data.text ?? data.headline ?? ""), status: String(data.status ?? "") })
        context.ui.toast.show({ title: "Goal summary queued", message: String(data.headline ?? "the full summary opens after the decision"), variant: "info", ...(data.sessionID ? { sessionID: data.sessionID } : {}) })
        return
      }
      void context.ui.dialog.alert({
        title: `Goal summary — ${data.status ?? ""}`,
        message: dialogDigest(String(data.headline ?? "summary"), String(data.text ?? data.headline ?? "")),
      })
    })
    const offData = context.data.listen(({ details }: any) => {
      if (details?.type === "server.connected") for (const id of requested) void fetchView(id)
    })
    const refreshIfStale = (sessionID: string) => {
      if (Date.now() - (fetchedAt.get(sessionID) ?? 0) <= STALE_MS) return
      fetchedAt.set(sessionID, Date.now())
      void fetchView(sessionID)
    }
    const ticker = setInterval(() => {
      for (const id of Object.keys(views)) {
        const view = views[id]
        if (view && !["complete", "failed", "aborted", "superseded"].includes(view.status)) refreshIfStale(id)
      }
    }, STALE_MS)

    // T056: the panel opens ON DEMAND (the v0.2 auto-open displaced the
    // sidebar); the toggle command is keybindable beside OpenCode's
    // session.sidebar toggle.
    let panelOpen = false
    const openPanel = () => {
      panelOpen = true
      context.ui.panel.open(PANEL_NAME)
    }
    const togglePanel = () => {
      if (panelOpen || context.ui.panel.current()?.name === PANEL_NAME) {
        panelOpen = false
        context.ui.panel.close()
      } else openPanel()
    }
    const [tab, setTab] = createSignal<DashboardTab>("now")
    const [goalsList, setGoalsList] = createSignal<Array<{ slug: string; title: string; status: string; terminal?: boolean; attachable?: boolean }>>([])
    let goalsFetchedAt = 0
    const ensureGoals = async () => {
      if (Date.now() - goalsFetchedAt < 5000) return
      goalsFetchedAt = Date.now()
      try {
        const listed = await rpc.list({})
        setGoalsList((listed?.goals ?? []) as any)
      } catch {
        // list is optional decoration for the Goals tab
      }
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
          refreshIfStale(input.sessionID) // T058: focus renders refresh a stale card
          return (
            <Show when={views[input.sessionID]}>
              {(view) => (
                <box flexDirection="column" marginTop={1}>
                  <For each={cardCompactLines(view(), now(), SIDEBAR_WIDTH)}>
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
          const view = views[input.sessionID]
          const tracer = view ? tracerLines(view, now(), 80) : []
          const banner = view ? bannerText(view) : undefined
          if (!tracer.length && !banner) return null
          return (
            <box flexDirection="column" paddingLeft={1} paddingRight={1}>
              {tracer.map((line) => (
                <text fg={color(line.tone)} wrapMode="none" truncate>
                  {line.text}
                </text>
              ))}
              <Show when={banner}>
                {(b) => (
                  <text fg={color(b().tone)} wrapMode="none" truncate>
                    {b().text}
                  </text>
                )}
              </Show>
            </box>
          )
        },
      } as any),
    )

    disposers.push(
      context.ui.slot({
        append: "session.panel",
        render: (input: any) => {
          ensure(input.sessionID)
          const view = input.name === PANEL_NAME ? views[input.sessionID] : undefined
          const width = typeof input.width === "number" ? input.width : 46
          const rows = view && tab() === "decisions" ? decisionRows(view) : []
          if (tab() === "goals") void ensureGoals()
          return (
            <Show when={view}>
              {(v) => (
                <box flexDirection="column" paddingLeft={1} paddingRight={1}>
                  <For each={dashboardLines(v(), tab(), now(), width, goalsList() as any)}>
                    {(line) => (
                      <text fg={color(line.tone)} wrapMode="none" truncate>
                        {line.bold ? <b>{line.text}</b> : line.text}
                      </text>
                    )}
                  </For>
                  <Show when={rows.length}>
                    <select
                      options={rows.map((r) => ({ name: r.label, description: r.description, value: r }))}
                      showDescription
                      focused
                      onSelect={(_index: number, option: any) => {
                        const row = option?.value as { act?: string; arg?: string; label: string; description?: string } | undefined
                        if (row?.act) void act(row.act, row.arg)
                        else context.ui.toast.show({ title: "Goal", message: `Run: ${row?.description ?? row?.label ?? ""}`, variant: "info" })
                      }}
                    />
                  </Show>
                </box>
              )}
            </Show>
          )
        },
      } as any),
    )

    // Palette commands live in a keymap layer owned by the app slot's render
    // component (createComponent gives it a stable owner; T050). T064: the
    // layer MUST be mode:"global" — a layer without a mode defaults to
    // "base", and base-mode layers are unreachable whenever a modal is open
    // (the command palette itself registers mode:"modal",
    // packages/tui/src/ui/dialog-select.tsx), so the palette listed zero
    // Goal commands live. Proven by pty A/B: mode:"global" lists all 8,
    // mode-less lists none. Matches the host's own palette layer (app.tsx
    // Keymap.createLayer(() => ({ mode: "global", ... }))).
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
    // T050: decision dialogs. Every engine decision payload renders as a
    // selectable dialog wired to rpc.act — the owner picks instead of typing
    // commands. Choices without an act (guidance-only) fall back to an alert.
    // T066: the dialog stays open until answered; its close flushes any
    // queued summary digest for the same session.
    const offDecision = rpc.events.on("decision", (event: any) => {
      const data = event.data ?? {}
      const current = context.ui.router.current()
      const here = current.type === "session" && current.sessionID === data.sessionID
      const choices = (data.choices ?? []) as Array<{ label: string; act?: string; arg?: string; run?: string }>
      if (!here) {
        context.ui.toast.show({ title: "Goal decision", message: `${String(data.message ?? "").slice(0, 160)} (${choices.map((c) => c.run ?? c.label).slice(0, 3).join(" · ")})`, variant: "warning", ...(data.sessionID ? { sessionID: data.sessionID } : {}) })
        return
      }
      void (async () => {
        const actionable = choices.filter((c) => c.act)
        if (!actionable.length) {
          await context.ui.dialog.alert({ title: `Goal — ${data.kind ?? "decision"}`, message: `${data.message ?? ""}\n\n${choices.map((c) => `• ${c.run ?? c.label}`).join("\n")}` })
          return
        }
        openDecisions.set(data.sessionID, (openDecisions.get(data.sessionID) ?? 0) + 1)
        try {
          const pick = await context.ui.dialog.select({
            title: `Goal — ${data.kind ?? "decision"}`,
            options: actionable.map((c, i) => ({ title: c.label, value: String(i), description: c.run ?? "" })),
          })
          if (pick !== undefined && pick !== null) {
            const chosen = actionable[Number(pick)]
            if (chosen?.act) await act(chosen.act, chosen.arg)
          }
        } finally {
          const depth = (openDecisions.get(data.sessionID) ?? 1) - 1
          if (depth <= 0) openDecisions.delete(data.sessionID)
          else openDecisions.set(data.sessionID, depth)
          flushSummary(data.sessionID)
        }
      })()
    })

    // T049: goals are reachable from any session. When this session has no
    // goal, the palette still lists the project's goals so the owner can
    // attach one here instead of hunting for the session that started it.
    const attachables = async (): Promise<Array<{ slug: string; title: string; status: string }>> => {
      const sessionID = currentSession()
      if (!sessionID) return []
      const location = locationOf(sessionID)
      const listed = await rpc.list({}, location ? { location } : undefined)
      return ((listed?.goals ?? []) as Array<{ slug: string; title: string; status: string; attachable?: boolean }>).filter((g) => g.attachable)
    }
    disposers.push(
      context.ui.slot({
        append: "app",
        render: () => {
          context.keymap.layer(() => ({
            mode: "global" as const,
            commands: [
              {
                id: "goal.attach",
                title: "Goal: attach/switch to a goal",
                group: "Goal",
                palette: true,
                enabled: () => true,
                run: async () => {
                  try {
                    const goals = await attachables()
                    if (!goals.length) {
                      context.ui.toast.show({ title: "Goal", message: "No attachable goal in this project (none is live and stopped). /goal list shows everything.", variant: "info" })
                      return
                    }
                    const pick = await context.ui.dialog.select({
                      title: "Attach which goal to this session?",
                      options: goals.map((g) => ({ title: `${g.slug} — ${g.title}`, value: g.slug, description: g.status })),
                    })
                    if (pick) await act("attach", pick)
                  } catch (error) {
                    context.ui.toast.show({ title: "Goal", message: `Goal plugin unavailable: ${String(error)}`, variant: "error" })
                  }
                },
              },
              {
                id: "goal.panel",
                title: "Goal: toggle dashboard",
                group: "Goal",
                palette: true,
                // T056: beside OpenCode's session.sidebar toggle — bindable
                // and bound by default to leader+g
                bind: "leader+g",
                enabled: () => true,
                run: () => togglePanel(),
              },
              {
                id: "goal.dashboard.tab",
                title: "Goal: next dashboard tab",
                group: "Goal",
                palette: true,
                bind: "tab",
                enabled: hasGoal,
                run: () => {
                  const order = DASHBOARD_TABS
                  setTab(order[(order.indexOf(tab()) + 1) % order.length]!)
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
      clearInterval(ticker)
      offUpdated?.()
      offNotice?.()
      offSummary?.()
      offDecision?.()
      offData?.()
      for (const dispose of disposers.splice(0)) dispose()
    }
  },
}
