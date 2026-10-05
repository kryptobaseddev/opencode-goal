// T053 — the live activity tracer. A pure formatter that renders what the
// engine is doing RIGHT NOW with elapsed time and countdowns — verifying,
// the verifier child running, goal_wait countdowns, turn cooldowns — for
// the composer-top slot and the panel. Fed by the view's activity field
// (updated on every persist); zero model cost. Snapshot-tested so the
// wording cannot drift silently.
import type { GoalView } from "../rpc"
import { fit, fmtDuration, type Line, type Tone } from "./format"

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/** Countdowns keep their seconds — "2m 10s", not "2m" — while the clock ticks. */
export const fmtCountdown = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${String(s % 60).padStart(2, "0")}s`
}

export type TracerTone = Tone

/** The animated frame for a running activity (ticks once per second via the TUI clock). */
export const spinFrame = (now: number) => SPINNER[Math.floor(now / 120) % SPINNER.length]!

export function tracerLines(view: GoalView, now: number, width = 40): Line[] {
  const a = view.activity
  // a tracer only shows while the engine is actively working — never a stale
  // line on stopped or terminal statuses
  if (!["running", "waiting", "verifying"].includes(view.status)) return []
  if (!a) {
    // active statuses without a recorded activity still deserve a pulse
    return [{ text: fit(`◎ goal ${view.status} · turn ${view.turn}`, width), tone: "muted" }]
  }
  const elapsed = Math.max(0, Math.floor((now - a.since) / 1000))
  const elapsedText = `${fmtDuration(elapsed * 1000)}`
  const left = a.until ? Math.max(0, a.until - now) : undefined
  const leftText = left !== undefined ? fmtCountdown(left) : undefined
  switch (a.kind) {
    case "verifier-child":
      return [{ text: fit(`${spinFrame(now)} verifier child running — ${elapsedText}${a.detail ? ` · ${a.detail}` : ""}`, width), tone: "info" }]
    case "verifying":
      return [{ text: fit(`${spinFrame(now)} verifying the claim — ${elapsedText} (host checks, then the verifier child)`, width), tone: "info" }]
    case "waiting":
      return [{ text: fit(`◷ waiting — ${leftText ?? elapsedText}${left !== undefined ? " left" : ""}${a.detail ? ` · ${a.detail}` : ""}`, width), tone: "info" }]
    case "cooldown":
      return [{ text: fit(`· cooldown — next turn in ${leftText ?? "…"}`, width), tone: "muted" }]
    case "turn":
    default:
      return [{ text: fit(`${spinFrame(now)} turn ${view.turn} in progress — ${elapsedText}${a.detail ? ` · ${a.detail}` : ""}`, width), tone: "success" }]
  }
}
