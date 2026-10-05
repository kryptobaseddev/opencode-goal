// Pure formatting for the TUI: everything the sidebar, pill, banner and
// dashboard panel show is computed here from a GoalView, so it can be tested
// without a terminal.
import type { GoalView } from "../rpc"

export type Tone = "base" | "muted" | "success" | "warning" | "error" | "info"
export type Line = { text: string; tone: Tone; bold?: boolean }

export const STATUS: Record<string, { icon: string; label: string; tone: Tone }> = {
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

export const fit = (text: string, width: number) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= width ? flat : `${flat.slice(0, Math.max(1, width - 1))}…`
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60 ? ` ${String(m % 60).padStart(2, "0")}m` : ""}`
}

export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))

export const elapsed = (view: GoalView, now: number) => view.activeMs + (view.activeSince !== null ? Math.max(0, now - view.activeSince) : 0)

export function bar(done: number, total: number, width = 10): string {
  if (total <= 0) return ""
  const filled = Math.round((done / total) * width)
  return "■".repeat(filled) + "□".repeat(width - filled)
}

const proven = (view: GoalView) => view.criteria.filter((c) => c.status === "pass").length

function usageParts(view: GoalView, now: number): { time: string; spend?: string } {
  const limit = (name: string) => view.budget.find((b) => b.name === name)?.limit
  const time = `turn ${view.turn}${limit("turns") ? `/${limit("turns")}` : ""} · ${fmtDuration(elapsed(view, now))}${limit("wall") ? `/${fmtDuration(limit("wall")!)}` : ""}`
  const spend: string[] = []
  if (view.usage.tokens || limit("tokens")) spend.push(`${fmtTokens(view.usage.tokens)}${limit("tokens") ? `/${fmtTokens(limit("tokens")!)}` : ""} tok`)
  if (view.usage.cost || limit("cost")) spend.push(`$${view.usage.cost.toFixed(2)}${limit("cost") ? `/$${limit("cost")}` : ""}`)
  return { time, ...(spend.length ? { spend: spend.join(" · ") } : {}) }
}

const usageLine = (view: GoalView, now: number) => {
  const u = usageParts(view, now)
  return u.spend ? `${u.time} · ${u.spend}` : u.time
}

export function cardLines(view: GoalView, now: number, width = 40, maxCriteria = 8): Line[] {
  const st = statusOf(view.status)
  const lines: Line[] = []
  const head = "◎ Goal"
  const right = `${st.icon} ${st.label}`
  lines.push({ text: `${head}${" ".repeat(Math.max(1, width - head.length - right.length))}${right}`, tone: st.tone, bold: true })
  // T052: the action-required line persists until the status resolves.
  if (view.actionRequired) lines.push({ text: fit(`⚑ ACTION: ${view.actionRequired}`, width), tone: "error", bold: true })
  lines.push({ text: fit(view.title, width), tone: "base", bold: true })
  const total = view.criteria.length
  lines.push({ text: `criteria ${bar(proven(view), total)} ${proven(view)}/${total}`, tone: proven(view) === total && total ? "success" : "muted" })
  for (const c of view.criteria.slice(0, maxCriteria)) {
    const mark = c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : c.status === "claimed" ? "◐" : "·"
    const tone: Tone = c.status === "pass" ? "success" : c.status === "fail" ? "error" : c.status === "claimed" ? "info" : "muted"
    const tag = c.by ? c.by : c.invariant ? "inv" : ""
    lines.push({ text: `${fit(`${mark} ${c.id} ${c.statement}`, width - tag.length - 1).padEnd(width - tag.length)}${tag}`.trimEnd(), tone })
  }
  if (view.criteria.length > maxCriteria) lines.push({ text: `  +${view.criteria.length - maxCriteria} more`, tone: "muted" })
  if (view.steps.length) {
    const index = view.steps.findIndex((s) => s.status === "active")
    const done = view.steps.filter((s) => s.status === "done").length
    const current = view.steps[index] ?? view.steps.find((s) => s.status !== "done")
    lines.push({ text: fit(current ? `step ${index >= 0 ? index + 1 : done}/${view.steps.length} ${current.id} ${current.title}` : `steps ${done}/${view.steps.length} done`, width), tone: "base" })
  }
  const usage = usageParts(view, now)
  const tone: Tone = view.budgetRatio >= 0.8 ? "warning" : "muted"
  lines.push({ text: fit(usage.time, width), tone })
  if (usage.spend) lines.push({ text: fit(usage.spend, width), tone })
  if (view.progress) lines.push({ text: fit(`↻ ${view.progress.note}`, width), tone: "muted" })
  if (view.verdict && !view.verdict.passed && view.status !== "complete") lines.push({ text: fit(`⚠ ${view.verdict.lines[0] ?? "verdict failed"}`, width), tone: "warning" })
  if (view.wait && view.status === "waiting") lines.push({ text: fit(`◷ resumes in ${fmtDuration(view.wait.until - now)}: ${view.wait.reason}`, width), tone: "info" })
  if (view.reason && ["paused", "blocked", "needs_review", "budget_limited", "failed"].includes(view.status)) lines.push({ text: fit(`${st.icon} ${view.reason}`, width), tone: st.tone })
  if (view.awaitingUser) lines.push({ text: fit("? waiting for your answer", width), tone: "warning" })
  return lines
}

const clock = (t: number) => new Date(t).toTimeString().slice(0, 8)

const budgetCell = (b: { name: string; used: number; limit: number }) => {
  if (b.name === "cost") return `$${b.used.toFixed(2)}/$${b.limit.toFixed(2)}`
  if (b.name === "wall") return `${fmtDuration(b.used)}/${fmtDuration(b.limit)}`
  if (b.name === "tokens") return `${fmtTokens(b.used)}/${fmtTokens(b.limit)} tok`
  return `${b.used}/${b.limit}`
}

/**
 * The session.panel goal dashboard: the contract's criteria board with
 * per-criterion evidence, the plan, the latest verdict and the ledger
 * timeline. Pure so the snapshot test can pin it.
 */
export function panelLines(view: GoalView, now: number, width = 46): Line[] {
  const st = statusOf(view.status)
  const lines: Line[] = []
  lines.push({ text: fit(`◎ GOAL ${st.icon} ${st.label}`, width), tone: st.tone, bold: true })
  lines.push({ text: fit(view.title, width), tone: "base", bold: true })
  lines.push({ text: fit(usageLine(view, now), width), tone: view.budgetRatio >= 0.8 ? "warning" : "muted" })
  const limits = view.budget.filter((b) => b.limit > 0)
  if (limits.length) lines.push({ text: fit(limits.map(budgetCell).join(" · "), width), tone: view.budgetRatio >= 0.8 ? "warning" : "muted" })
  lines.push({ text: fit(`Outcome ${view.outcome}`, width), tone: "muted" })

  lines.push({ text: `Criteria ${bar(proven(view), view.criteria.length)} ${proven(view)}/${view.criteria.length}`, tone: proven(view) === view.criteria.length && view.criteria.length ? "success" : "base", bold: true })
  for (const c of view.criteria) {
    const mark = c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : c.status === "claimed" ? "◐" : "·"
    const tone: Tone = c.status === "pass" ? "success" : c.status === "fail" ? "error" : c.status === "claimed" ? "info" : "muted"
    const tag = c.by ? ` [${c.by}]` : c.invariant ? " [invariant]" : ""
    lines.push({ text: fit(`${mark} ${c.id} ${c.statement}${tag}`, width), tone })
    const evidence = c.detail?.split("\n")[0]
    if (evidence) lines.push({ text: fit(`    ${evidence}`, width), tone: "muted" })
  }

  if (view.steps.length) {
    lines.push({ text: "Plan", tone: "base", bold: true })
    for (const s of view.steps)
      lines.push({ text: fit(`${s.status === "done" ? "✓" : s.status === "active" ? "▸" : "·"} ${s.id} ${s.title}`, width), tone: s.status === "active" ? "info" : s.status === "done" ? "success" : "muted" })
  }

  if (view.verdict) {
    lines.push({ text: `Verdict — turn ${view.verdict.turn}: ${view.verdict.passed ? "passed" : "failed"}`, tone: view.verdict.passed ? "success" : "warning", bold: true })
    for (const l of view.verdict.lines.slice(0, 4)) lines.push({ text: fit(`  ${l.split("\n")[0]}`, width), tone: view.verdict.passed ? "success" : "warning" })
  }

  lines.push({ text: "Timeline", tone: "base", bold: true })
  if (!view.timeline.length) lines.push({ text: "  (no events yet)", tone: "muted" })
  for (const e of view.timeline.slice(-10)) lines.push({ text: fit(`${clock(e.t)} ${e.text}`, width), tone: "muted" })
  return lines
}

export function pillText(view: GoalView, now: number): string {
  const st = statusOf(view.status)
  return `◎ ${st.icon} ${proven(view)}/${view.criteria.length} · t${view.turn} · ${fmtDuration(elapsed(view, now))}`
}

const RESUME = "/goal resume"

/** Shown above the composer only when the owner is needed. */
export function bannerText(view: GoalView): { text: string; tone: Tone } | undefined {
  const st = statusOf(view.status)
  if (view.awaitingUser && ["running", "waiting", "verifying"].includes(view.status)) return { text: "◎ The goal is waiting for your answer.", tone: "warning" }
  switch (view.status) {
    case "paused":
      return { text: `◎ ${st.icon} Goal paused — ${view.reason ?? ""} · ${RESUME}`, tone: "warning" }
    case "blocked":
      return { text: `◎ ${st.icon} Goal blocked — ${view.blocker?.reason ?? view.reason ?? ""} · fix it, then ${RESUME}`, tone: "error" }
    case "needs_review":
      return { text: `◎ ${st.icon} Goal needs review — ${view.reason ?? ""} · /goal approve <id> or ${RESUME}`, tone: "warning" }
    case "budget_limited":
      return { text: `◎ ${st.icon} Goal stopped at its budget — raise budget in goal.yaml and /goal start, or /goal abort`, tone: "warning" }
    default:
      return undefined
  }
}

export function statusText(view: GoalView, now: number): string {
  const st = statusOf(view.status)
  const lines = [`${view.title} — ${st.icon} ${st.label}${view.reason ? ` (${view.reason})` : ""}`, `Outcome: ${view.outcome}`, usageLine(view, now), ""]
  for (const c of view.criteria) lines.push(`${c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : c.status === "claimed" ? "◐" : "·"} ${c.id}${c.invariant ? " (invariant)" : ""} ${c.statement}${c.detail && c.status !== "pass" ? `\n    ${c.detail.split("\n")[0]}` : ""}`)
  if (view.steps.length) {
    lines.push("")
    for (const s of view.steps) lines.push(`${s.status === "done" ? "✓" : s.status === "active" ? "▸" : "·"} ${s.id} ${s.title}`)
  }
  if (view.progress) lines.push("", `Last progress: ${view.progress.note}${view.progress.next ? ` → ${view.progress.next}` : ""}`)
  if (view.verdict) lines.push("", `Last verdict (turn ${view.verdict.turn}): ${view.verdict.passed ? "passed" : "failed"}`, ...view.verdict.lines.map((l) => `  ${l.split("\n")[0]}`))
  return lines.join("\n")
}
