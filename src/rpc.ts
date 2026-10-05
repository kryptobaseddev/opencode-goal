// Shared server↔TUI contract. A plain object (Rpc.define is an identity
// function), so neither side needs @opencode/plugin at runtime.
const anyObject = { type: "object", additionalProperties: true } as const

export const GoalRpc = {
  id: "opencode-goal",
  methods: {
    snapshot: {
      input: { type: "object", properties: { sessionID: { type: "string", minLength: 1, maxLength: 256 } }, required: ["sessionID"], additionalProperties: false },
      output: anyObject,
    },
    list: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: anyObject,
    },
    act: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string", minLength: 1, maxLength: 256 },
          action: { type: "string", enum: ["pause", "resume", "abort", "verify", "approve", "reject", "amend", "archive", "attach"] },
          arg: { type: "string", maxLength: 2000 },
        },
        required: ["sessionID", "action"],
        additionalProperties: false,
      },
      output: anyObject,
    },
  },
  events: {
    updated: { schema: { type: "object", properties: { sessionID: { type: "string" }, view: anyObject }, required: ["sessionID"], additionalProperties: true } },
    notice: { schema: { type: "object", properties: { sessionID: { type: "string" }, level: { type: "string" }, text: { type: "string" }, attention: { type: "string" } }, required: ["text"], additionalProperties: true } },
    summary: { schema: { type: "object", properties: { sessionID: { type: "string" }, slug: { type: "string" }, status: { type: "string" }, headline: { type: "string" }, text: { type: "string" } }, required: ["sessionID", "text"], additionalProperties: true } },
    decision: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          slug: { type: "string" },
          kind: { type: "string", enum: ["needs_review", "paused-after-verdict", "blocked", "budget_limited", "amend-proposed", "supersede-ack", "complete"] },
          title: { type: "string" },
          message: { type: "string" },
          choices: { type: "array", items: { type: "object", properties: { label: { type: "string" }, act: { type: "string" }, arg: { type: "string" }, run: { type: "string" } }, required: ["label"], additionalProperties: true } },
        },
        required: ["sessionID", "kind", "message", "choices"],
        additionalProperties: true,
      },
    },
  },
} as const

export type CriterionView = {
  id: string
  statement: string
  essential: boolean
  invariant: boolean
  kind: string
  status: "unknown" | "pass" | "fail" | "claimed"
  by?: string
  detail?: string
  at?: number
}

export type TimelineEntry = { t: number; kind: string; text: string }

export type GoalView = {
  slug: string
  title: string
  outcome: string
  status: string
  reason?: string
  runId: string
  turn: number
  timeline: TimelineEntry[]
  activeMs: number
  activeSince: number | null
  usage: { tokens: number; cost: number }
  budget: Array<{ name: string; used: number; limit: number }>
  budgetRatio: number
  criteria: CriterionView[]
  steps: Array<{ id: string; title: string; status: string }>
  progress?: { note: string; next?: string; at: number; turn: number }
  verdict?: { passed: boolean; lines: string[]; at: number; turn: number }
  blocker?: { key: string; count: number; reason: string; needs?: string }
  wait?: { until: number; reason: string }
  awaitingUser: boolean
  /** T052: persistent owner-action-required state — stays until the status resolves. */
  actionRequired?: string
  amendments: number
  flags: number
  updatedAt: number
}

export type GoalSummary = { slug: string; title: string; status: string; sessionID?: string; proven: number; total: number; terminal?: boolean; attachable?: boolean }
