// T056 — the dashboard rework. The v0.2 panel streamed raw ledger actions:
// a wall of text, programmatic, not designed for human use — and the sidebar
// was completely overtaken. Everything here is PURE: the compact card is
// capped at 12 lines, the panel is organized into Now / Progress / Decisions
// / Goals tabs with plain-language criteria and a C/I/S legend footer, and
// actionable rows become keyboard-selectable models the TUI renders as
// native Select components. The raw ledger timeline is gone from the UI (it
// stays in the file).
import type { GoalSummary, GoalView, TimelineEntry } from "../rpc"
import { bar, elapsed, endStateCopy, fit, fmtTokens, type Line, type Tone } from "./format"
import { tracerLines } from "./tracer"


export type DashboardTab = "now" | "progress" | "decisions" | "goals"
export const DASHBOARD_TABS: DashboardTab[] = ["now", "progress", "decisions", "goals"]

const STATUS: Record<string, { icon: string; label: string; tone: Tone }> = {
  running: { icon: "▶", label: "running", tone: "success" },
  waiting: { icon: "◷", label: "waiting", tone: "info" },
  verifying: { icon: "◐", label: "verifying", tone: "info" },
  paused: { icon: "⏸", label: "paused", tone: "warning" },
  blocked: { icon: "⛔", label: "blocked", tone: "error" },
  needs_review: { icon: "⚑", label: "needs review", tone: "warning" },
  budget_limited: { icon: "⊘", label: "budget used", tone: "warning" },
  complete: { icon: "✓", label: "complete", tone: "success" },
  failed: { icon: "✗", label: "failed", tone: "error" },
  aborted: { icon: "■", label: "aborted", tone: "muted" },
  superseded: { icon: "⇢", label: "superseded", tone: "muted" },
}
const statusOf = (s: string) => STATUS[s] ?? { icon: "·", label: s, tone: "muted" as Tone }

const provenCount = (view: GoalView) => view.criteria.filter((c) => c.status === "pass").length

/** (A) The sidebar card: hard-capped at 12 lines. Status, one progress bar,
 *  the current step, the next action, ONE action-required line — never a
 *  timeline. T073: rows that the width truncates carry a `tab` hint naming
 *  the panel tab that holds their full text, and the card always ends with
 *  an explicit expand affordance (F9 opens it). */
export function cardCompactLines(view: GoalView, now: number, width = 40): Line[] {
  const st = statusOf(view.status)
  const lines: Line[] = []
  const head = "◎ Goal"
  const right = `${st.icon} ${st.label}`
  lines.push({ text: `${head}${" ".repeat(Math.max(1, width - head.length - right.length))}${right}`, tone: st.tone, bold: true })
  if (view.actionRequired) lines.push({ text: fit(`⚑ ${view.actionRequired}`, width), tone: "error", bold: true, tab: "decisions" })
  lines.push({ text: fit(view.title, width), tone: "base", bold: true, tab: "now" })
  const total = view.criteria.length
  lines.push({ text: `criteria ${bar(provenCount(view), total)} ${provenCount(view)}/${total}`, tone: provenCount(view) === total && total ? "success" : "muted" })
  // the three criteria that need eyes: failing first, then unproven, then proven
  const focus = [...view.criteria].sort((a, b) => (a.status === "fail" ? -1 : b.status === "fail" ? 1 : a.status === "pass" ? 1 : b.status === "pass" ? -1 : 0)).slice(0, 3)
  for (const c of focus) {
    const mark = c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "·"
    const tone: Tone = c.status === "pass" ? "success" : c.status === "fail" ? "error" : "muted"
    lines.push({ text: fit(`${mark} ${c.id} ${c.statement}`, width), tone, tab: "progress" })
  }
  if (view.steps.length) {
    const current = view.steps.find((s) => s.status === "active") ?? view.steps.find((s) => s.status !== "done")
    if (current) lines.push({ text: fit(`▸ ${current.id} ${current.title}`, width), tone: "base", tab: "now" })
  }
  const tokens = view.usage.tokens ? ` · ${fmtTokens(view.usage.tokens)} tok` : ""
  lines.push({ text: fit(`turn ${view.turn}${tokens}`, width), tone: view.budgetRatio >= 0.8 ? "warning" : "muted" })
  // T071: at a terminal state the card says the loop stopped and where the
  // follow-ups live (the progress note is moot then). Compact form: the slug
  // path fits the sidebar; the full line lives in the banner and the panel.
  const stopped = endStateCopy(view.status, view.slug)
  if (stopped) lines.push({ text: fit(`■ loop stopped — follow-ups: .opencode/goals/${view.slug}/`, width), tone: stopped.tone })
  else if (view.progress) lines.push({ text: fit(`↻ ${view.progress.note}`, width), tone: "muted", tab: "now" })
  // T073: the expand affordance always occupies the card's last line — the
  // cap stays 12; the sections the width truncated name their panel tab so
  // the affordance is a click-through, not a dead hint. Short enough to stay
  // readable at the narrowest sidebar.
  const tabs = [...new Set(lines.filter((l) => l.tab && l.text.includes("…")).map((l) => l.tab!))]
  const affordance = tabs.length
    ? `↳ F9 → ${TAB_LABEL[tabs[0] as DashboardTab]}${tabs.length > 1 ? ` (+${tabs.length - 1})` : ""}`
    : "↳ full card — F9"
  lines.push({ text: fit(affordance, width), tone: "info" })
  return lines.slice(0, 12)
}

/** (T073) The expanded card: the same shape as the compact card but EVERY
 *  row rendered fully — statements wrap to the width instead of truncating
 *  with `…`, and nothing is dropped for line count. Rendered in the panel
 *  (the compact card's affordance opens it at the matching tab); pure and
 *  snapshot-tested alongside the compact card. */
export function cardExpandedLines(view: GoalView, now: number, width = 46): Line[] {
  const st = statusOf(view.status)
  const lines: Line[] = []
  const emit = (text: string, tone: Tone, opts: { bold?: boolean; tab?: DashboardTab } = {}) => {
    const [first, ...rest] = wrap(text, width)
    if (first === undefined) return
    lines.push({ text: first, tone, ...(opts.bold ? { bold: true } : {}), ...(opts.tab ? { tab: opts.tab } : {}) })
    for (const r of rest) lines.push({ text: r, tone })
  }
  emit(`◎ GOAL ${st.icon} ${st.label}${view.reason ? ` — ${view.reason}` : ""}`, st.tone, { bold: true })
  const stopped = endStateCopy(view.status, view.slug)
  if (stopped) emit(stopped.text, stopped.tone)
  emit(view.title, "base", { bold: true, tab: "now" })
  if (view.actionRequired) emit(`⚑ ${view.actionRequired}`, "error", { bold: true, tab: "decisions" })
  lines.push({ text: `criteria ${bar(provenCount(view), view.criteria.length)} ${provenCount(view)}/${view.criteria.length}`, tone: provenCount(view) === view.criteria.length && view.criteria.length ? "success" : "muted", tab: "progress" })
  // every criterion, failing first — the compact card's 3-row focus set
  // fully expanded here
  const ordered = [...view.criteria].sort((a, b) => (a.status === "fail" ? -1 : b.status === "fail" ? 1 : 0))
  for (const c of ordered) {
    const mark = c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : c.status === "claimed" ? "◐" : "·"
    const tone: Tone = c.status === "pass" ? "success" : c.status === "fail" ? "error" : "muted"
    emit(`${mark} ${c.invariant ? "I" : "C"} ${c.id} — ${c.statement}`, tone, { tab: "progress" })
    if (c.detail && c.status !== "pass") emit(`  ${c.detail}`, tone)
  }
  if (view.steps.length) {
    lines.push({ text: "plan", tone: "base", bold: true })
    for (const s of view.steps) emit(`S ${s.id} ${s.status === "done" ? "✓" : s.status === "active" ? "▸" : "·"} ${s.title}`, s.status === "active" ? "info" : s.status === "done" ? "success" : "muted", { tab: "now" })
  }
  const elapsedMs = elapsed(view, now)
  const tokens = view.usage.tokens ? ` · ${fmtTokens(view.usage.tokens)} tok` : ""
  const spend = view.usage.cost ? ` · $${view.usage.cost.toFixed(2)}` : ""
  lines.push({ text: `turn ${view.turn} · ${Math.floor(elapsedMs / 60000)}m${tokens}${spend}`, tone: view.budgetRatio >= 0.8 ? "warning" : "muted" })
  if (view.progress) emit(`↻ ${view.progress.note}${view.progress.next ? ` → ${view.progress.next}` : ""}`, "muted", { tab: "now" })
  if (view.verdict) {
    lines.push({ text: `last verdict — ${view.verdict.passed ? "passed" : "failed"}`, tone: view.verdict.passed ? "success" : "warning", bold: true })
    for (const l of view.verdict.lines.slice(0, 5)) emit(`  ${l.split("\n")[0]}`, view.verdict.passed ? "success" : "warning")
  }
  return lines
}

/** Word-wrap text to width: the expanded view's "every row fully" guarantee —
 *  long statements become multiple lines, never `…`. */
export const wrap = (text: string, width: number): string[] => {
  const flat = text.replace(/\s+/g, " ").trim()
  if (!flat) return []
  if (flat.length <= width) return [flat]
  const out: string[] = []
  let line = ""
  for (const word of flat.split(" ")) {
    if (!line.length) line = word
    else if (line.length + 1 + word.length <= width) line += ` ${word}`
    else {
      out.push(line)
      line = word
    }
  }
  if (line.length) out.push(line)
  // a single word longer than the width still has to land somewhere
  return out.flatMap((l) => (l.length <= width ? [l] : (l.match(new RegExp(`.{1,${width}}`, "g")) ?? [l])))
}

const TAB_LABEL: Record<DashboardTab, string> = { now: "Now", progress: "Progress", decisions: "Decisions", goals: "Goals" }

/** T073: the panel tab the compact card's expand affordance opens on — the
 *  highest-priority section the sidebar width truncated (decisions first,
 *  then criteria, then step/progress). Undefined when nothing truncated:
 *  F9 opens the panel where it was. */
export function cardAffordanceTab(view: GoalView, now: number, width = 40): DashboardTab | undefined {
  const order: DashboardTab[] = ["decisions", "progress", "now"]
  const truncated = new Set(cardCompactLines(view, now, width).filter((l) => l.tab && l.text.includes("…")).map((l) => l.tab!))
  return order.find((t) => truncated.has(t))
}

const humanKinds = new Set(["verdict", "approve", "reject", "amend-proposed", "amended", "blocked", "complete", "summary", "flag", "attached", "paused", "resumed", "aborted", "budget_limited", "superseded-by", "approve ", "reject "])

/** (E) only human-relevant events surface in the UI — raw turn/admit noise stays in the ledger file. */
export const humanizedEvents = (view: GoalView, n: number): TimelineEntry[] => {
  const relevant = view.timeline.filter((e) => humanKinds.has(e.kind) || /^(owner|verdict|goal complete|summary|blocked|amended|flag)/i.test(e.text))
  return relevant.slice(-n).reverse()
}

/** (C) actionable rows: keyboard-selectable models dispatching rpc.act. */
export type ActionRow = { label: string; description: string; act?: string; arg?: string }

export function decisionRows(view: GoalView): ActionRow[] {
  const rows: ActionRow[] = []
  if (view.actionRequired) {
    if (view.status === "needs_review") {
      const unproven = view.criteria.filter((c) => !c.invariant && c.status !== "pass")
      for (const c of unproven) rows.push({ label: `Approve ${c.id} (final)`, description: c.statement, act: "approve", arg: c.id })
      rows.push({ label: "Reject a criterion", description: "/goal reject <C#> <why>", act: "reject" })
    } else if (view.status === "blocked") {
      rows.push({ label: "Resolved — resume", description: view.blocker?.reason ?? "the blocker is fixed", act: "resume" })
      rows.push({ label: "Abort the goal", description: "stop for good; history stays", act: "abort" })
    } else if (view.status === "budget_limited") {
      rows.push({ label: "Raise budget and amend", description: "edit goal.yaml, then confirm" })
      rows.push({ label: "Abort the goal", description: "stop at the budget", act: "abort" })
    }
  }
  if (view.status === "paused") rows.push({ label: "Resume the goal", description: view.reason ?? "", act: "resume" })
  if (view.status === "complete") rows.push({ label: "Archive the goal", description: "demote to goals-archive/ (history intact)", act: "archive" })
  if (view.amendments) rows.push({ label: "Confirm proposed amendment", description: "/goal amend confirm", act: "amend", arg: "confirm" })
  return rows
}

/** (T065) Dialogs are not scrollable on the real TUI: a full post-goal
 *  summary (~50 lines) overflowed off the owner's screen. Everything shown
 *  in a dialog goes through this digest: headline, the first lines, and a
 *  pointer to where the rest lives. */
export function dialogDigest(title: string, text: string, maxLines = 14, maxCols = 100): string {
  const lines = text.split("\n").map((l) => (l.length > maxCols ? `${l.slice(0, maxCols - 1)}…` : l))
  const head = lines.slice(0, maxLines)
  const rest = lines.length - head.length
  return [title, ...head, ...(rest > 0 ? [`… +${rest} more lines — full text: the Goal panel (F9) or .opencode/goals/ evidence` ] : [])].join("\n")
}

/** (B) the tabbed panel body. Pure; snapshot-tested. T073: the panel is the
 *  expanded view of the compact card — every row wraps to the width instead
 *  of truncating with `…`, so nothing the card cut off is unreadable here at
 *  any width (the TUI passes the panel's real width). */
export function dashboardLines(view: GoalView, tab: DashboardTab, now: number, width = 46, goals: GoalSummary[] = []): Line[] {
  const st = statusOf(view.status)
  const lines: Line[] = []
  const emit = (text: string, tone: Tone, bold = false) => {
    for (const part of wrap(text, width)) lines.push({ text: part, tone, ...(bold ? { bold: true } : {}) })
  }
  const tabsHeader = DASHBOARD_TABS.map((t) => (t === tab ? `▸${TAB_LABEL[t]}` : ` ${TAB_LABEL[t]} `)).join("│")
  lines.push({ text: fit(`◎ GOAL ${st.icon} ${st.label}`, width), tone: st.tone, bold: true })
  lines.push({ text: fit(tabsHeader, width), tone: "base" })
  lines.push({ text: "", tone: "base" })

  if (tab === "now") {
    emit(view.title, "base", true)
    emit(view.outcome, "muted")
    lines.push(...tracerLines(view, now, width))
    const current = view.steps.find((s) => s.status === "active") ?? view.steps.find((s) => s.status !== "done")
    if (current) emit(`▸ step ${current.id} ${current.title}`, "base")
    if (view.progress?.next) emit(`next: ${view.progress.next}`, "muted")
    if (view.actionRequired) emit(`⚑ ${view.actionRequired}`, "error", true)
    else if (["running", "waiting", "verifying"].includes(view.status)) emit("✓ nothing needed from you — the loop is working", "success")
    const events = humanizedEvents(view, 3)
    if (events.length) {
      lines.push({ text: "recent", tone: "base", bold: true })
      for (const e of events) emit(`· ${e.text}`, "muted")
    }
  } else if (tab === "progress") {
    const groups: Array<[string, typeof view.criteria, Tone]> = [
      ["Failed", view.criteria.filter((c) => c.status === "fail"), "error"],
      ["In progress", view.criteria.filter((c) => c.status !== "pass" && c.status !== "fail"), "muted"],
      ["Proven", view.criteria.filter((c) => c.status === "pass"), "success"],
    ]
    emit(`criteria ${bar(provenCount(view), view.criteria.length)} ${provenCount(view)}/${view.criteria.length}`, "base", true)
    for (const [label, items, tone] of groups) {
      if (!items.length) continue
      lines.push({ text: label, tone, bold: true })
      for (const c of items) emit(`${c.invariant ? "I" : "C"} ${c.id} — ${c.statement}${c.by ? ` (${c.by})` : ""}`, tone)
    }
    if (view.steps.length) {
      lines.push({ text: "plan", tone: "base", bold: true })
      for (const s of view.steps) emit(`S ${s.id} ${s.status === "done" ? "✓" : s.status === "active" ? "▸" : "·"} ${s.title}`, s.status === "active" ? "info" : s.status === "done" ? "success" : "muted")
    }
    if (view.verdict) {
      lines.push({ text: `last verdict — ${view.verdict.passed ? "passed" : "failed"}`, tone: view.verdict.passed ? "success" : "warning", bold: true })
      for (const l of view.verdict.lines.slice(0, 3)) emit(l.split("\n")[0]!, view.verdict.passed ? "success" : "warning")
    }
  } else if (tab === "decisions") {
    const rows = decisionRows(view)
    if (rows.length) {
      lines.push({ text: "act on a row (↑↓ · enter)", tone: "base", bold: true })
      for (const r of rows) emit(`▸ ${r.label}${r.description ? ` — ${r.description}` : ""}`, r.act ? "info" : "muted")
    } else lines.push({ text: "no open decisions", tone: "success" })
    const events = humanizedEvents(view, 8)
    if (events.length) {
      lines.push({ text: "history", tone: "base", bold: true })
      for (const e of events) emit(`· ${e.text}`, "muted")
    }
  } else {
    const others = goals.filter((g) => g.slug !== view.slug)
    emit(`this goal: ${view.title} (${st.label})`, "base", true)
    if (others.length) {
      lines.push({ text: "other goals", tone: "base", bold: true })
      for (const g of others) emit(`· ${g.slug} — ${g.title} (${g.status})${g.attachable ? " · attachable" : ""}`, g.terminal ? "muted" : "info")
    } else lines.push({ text: "no other goals in this project", tone: "muted" })
    if (view.steps.length) {
      lines.push({ text: "upcoming steps", tone: "base", bold: true })
      for (const s of view.steps.filter((s) => s.status !== "done")) emit(`S ${s.id} · ${s.title}`, "muted")
    }
  }

  lines.push({ text: "", tone: "base" })
  // T073: the legend wraps to two short lines so it never truncates at the
  // panel's narrowest width
  lines.push({ text: fit("C criterion · I invariant · S plan step", width), tone: "muted" })
  lines.push({ text: fit("↑↓/tab/enter to act", width), tone: "muted" })
  return lines
}
