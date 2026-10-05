// Pure formatting for the TUI: everything the sidebar, pill, banner and
// dashboard panel show is computed here from a GoalView, so it can be tested
// without a terminal.
import type { GoalView } from "../rpc"
import { tracerLines } from "./tracer"

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

const clock = (t: number) => new Date(t).toTimeString().slice(0, 8)

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
