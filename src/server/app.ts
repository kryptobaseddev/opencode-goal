// The goal engine: owns run state for this location, drives continuations from
// session.execution.* events, injects the contract into every request, and runs
// verification. Spike findings referenced as S1-S9 live in docs/spikes.md.
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode/plugin"
import { formatIssues, parseContract } from "../contract/parse"
import { renderSystemBlock, renderTailNote, triggerText, type TailKind } from "../contract/render"
import type { Contract } from "../contract/types"
import { isHostCheck } from "../contract/types"
import { GoalRpc, type GoalSummary, type GoalView } from "../rpc"
import { account, budgetUse, initialRun, isActive, isTerminal, modelCan, ownerCan, setStatus, type PendingKind, type RunState, type Status } from "../engine/state"
import { Store } from "../engine/store"
import { Registry } from "../engine/registry"
import { admissionNote } from "../engine/similarity"
import { goalHelp } from "./help"
import { ascendingId, runId as newRunId } from "../util/ids"
import { fingerprint, headCommit } from "../util/git"
import { runHostCheck, verifyClaim, type VerifierVerdict } from "../verify/pipeline"

type Context = Plugin.Context

export const LAUNCH_LABEL = "Start goal now"

export type Options = {
  /** Hard ceiling on goal-driven turns when the contract sets no turn budget. */
  backstopTurns: number
  cooldownMs: number
  /** Consecutive turns without a worktree or criterion change before pausing. */
  stallTurns: number
  /** No-progress count at which the continuation switches to the recovery prompt. */
  recoveryAt: number
  blockerRepeats: number
  maxPromptFailures: number
  verifierAgent: string
  verifierTimeoutMs: number
  liveChecks: boolean
  launchApprovalMs: number
}

export const DEFAULTS: Options = {
  backstopTurns: 200,
  cooldownMs: 1500,
  stallTurns: 3,
  recoveryAt: 2,
  blockerRepeats: 3,
  maxPromptFailures: 3,
  verifierAgent: "goal-verifier",
  verifierTimeoutMs: 240_000,
  liveChecks: true,
  launchApprovalMs: 10 * 60_000,
}

type Loaded = { contract: Contract; lock: string; text: string }
type SessionFacts = { busy: boolean; forms: Set<string>; launchApprovedAt?: number; cancelledAt?: number }

const canonical = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

const json = (value: unknown) => JSON.stringify(value, null, 2)

export class GoalApp {
  readonly root: string
  readonly rootReal: string
  readonly store: Store
  readonly registry: Registry
  readonly options: Options
  private runs = new Map<string, RunState>()
  private loaded = new Map<string, Loaded>()
  private notes = new Map<string, string>()
  private facts = new Map<string, SessionFacts>()
  private verifierInbox = new Map<string, VerifierVerdict[]>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private registrations: Array<{ dispose: () => Promise<void> | void }> = []
  private rpc?: { events: { emit: (name: any, data: any) => Promise<void> } }
  private controller = new AbortController()
  private disposed = false
  private queue = Promise.resolve()

  constructor(private ctx: Context) {
    this.root = ctx.location.directory
    this.rootReal = canonical(this.root)
    this.store = new Store(this.root)
    this.registry = new Registry()
    this.options = { ...DEFAULTS, ...(ctx.options as Partial<Options>) }
  }

  // ───────────────────────────── lifecycle

  async start() {
    this.recover()
    await this.registerAgents()
    await this.registerSkill()
    await this.registerTools()
    await this.registerCommand()
    await this.registerHooks()
    await this.registerRpc()
    void this.eventLoop()
  }

  async stop() {
    this.disposed = true
    this.controller.abort()
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    for (const r of this.registrations.splice(0)) await Promise.resolve(r.dispose()).catch(() => {})
  }

  /** Running goals from a previous process come back paused (never resumed blindly). */
  private recover() {
    for (const slug of this.store.slugs()) {
      const state = this.store.readRun(slug)
      if (!state || isTerminal(state.status)) continue
      if (isActive(state.status)) {
        setStatus(state, "paused", "host restarted; resume when ready")
        this.store.ledger(slug, { type: "recovered", status: "paused" })
        this.store.writeRun(state)
      }
      this.runs.set(state.sessionID, state)
    }
  }

  /** Serialize state mutations so concurrent events cannot interleave writes. */
  private serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  // ───────────────────────────── contracts and state helpers

  private load(slug: string, fresh = false): Loaded | { error: string } {
    const cached = this.loaded.get(slug)
    if (cached && !fresh) return cached
    const read = this.store.readContract(slug)
    if (!read) return { error: `no goal named "${slug}" (expected .opencode/goals/${slug}/goal.yaml)` }
    if (!read.contract) return { error: `goal.yaml for "${slug}" is invalid:\n${formatIssues(read.issues)}` }
    const value = { contract: read.contract, lock: read.lock, text: read.text }
    this.loaded.set(slug, value)
    return value
  }

  private contractOf(state: RunState): Contract | undefined {
    const cached = this.loaded.get(state.slug)
    if (cached && cached.lock === state.lock) return cached.contract
    // The locked contract is the one the run started with; if the file changed,
    // keep using the locked copy from the evidence of the run start.
    const locked = this.store.readContract(state.slug)
    if (locked?.contract && locked.lock === state.lock) {
      this.loaded.set(state.slug, { contract: locked.contract, lock: locked.lock, text: locked.text })
      return locked.contract
    }
    const snapshot = join(this.store.dir(state.slug), "evidence", state.runId, "contract.yaml")
    if (existsSync(snapshot)) {
      const parsed = parseContract(readFileSync(snapshot, "utf8"), { slug: state.slug })
      if (parsed.contract) return parsed.contract
    }
    return cached?.contract
  }

  private persist(state: RunState) {
    account(state)
    this.store.writeRun(state)
    // T026: every persisted transition refreshes the derived machine-level
    // index (skipped when nothing changed, since usage bursts persist often).
    this.registry.update(this.rootReal, state.slug, { title: state.title, status: state.status, ...(state.runId ? { runId: state.runId } : {}), ...(state.lock ? { lock: state.lock } : {}), updatedAt: Date.now() })
    this.emitUpdate(state)
  }

  private factsOf(sessionID: string): SessionFacts {
    let f = this.facts.get(sessionID)
    if (!f) this.facts.set(sessionID, (f = { busy: false, forms: new Set() }))
    return f
  }

  /** Recent ledger events for the dashboard's Timeline section, oldest first. */
  private timelineOf(state: RunState) {
    return this.store
      .recent(state.slug, 30)
      .slice(-18)
      .map((e) => ({ t: e.t, kind: e.type, text: timelineText(e) }))
  }

  view(state: RunState): GoalView | undefined {
    const contract = this.contractOf(state)
    if (!contract) return undefined
    const use = budgetUse(state, contract)
    const all = [...contract.criteria.map((c) => ({ c, invariant: false })), ...contract.invariants.map((c) => ({ c, invariant: true }))]
    return {
      slug: state.slug,
      title: contract.title,
      outcome: contract.outcome,
      status: state.status,
      ...(state.reason ? { reason: state.reason } : {}),
      runId: state.runId,
      turn: state.turn,
      timeline: this.timelineOf(state),
      activeMs: state.activeMs,
      activeSince: state.activeSince,
      usage: { tokens: state.usage.tokens, cost: state.usage.cost },
      budget: use.parts,
      budgetRatio: use.ratio,
      criteria: all.map(({ c, invariant }) => {
        const s = state.criteria[c.id] ?? { status: "unknown" as const, rejections: 0 }
        return { id: c.id, statement: c.statement, essential: c.essential, invariant, kind: c.check.kind, status: s.status, ...(s.by ? { by: s.by } : {}), ...(s.detail ? { detail: s.detail.slice(0, 400) } : {}), ...(s.at ? { at: s.at } : {}) }
      }),
      steps: contract.plan.map((s) => ({ id: s.id, title: s.title, status: state.steps[s.id] ?? "pending" })),
      ...(state.progress ? { progress: state.progress } : {}),
      ...(state.verdict ? { verdict: { passed: state.verdict.passed, lines: state.verdict.lines.slice(0, 6), at: state.verdict.at, turn: state.verdict.turn } } : {}),
      ...(state.blocker ? { blocker: { key: state.blocker.key, count: state.blocker.count, reason: state.blocker.reason, ...(state.blocker.needs ? { needs: state.blocker.needs } : {}) } } : {}),
      ...(state.wait ? { wait: state.wait } : {}),
      awaitingUser: this.factsOf(state.sessionID).forms.size > 0,
      amendments: state.amendments.filter((a) => a.status === "proposed").length,
      flags: state.flags.length,
      updatedAt: state.updatedAt,
    }
  }

  private emitUpdate(state: RunState) {
    const view = this.view(state)
    void this.rpc?.events.emit("updated", { sessionID: state.sessionID, view: view ?? null }).catch(() => {})
  }

  private notice(sessionID: string | undefined, text: string, level: "info" | "success" | "warning" | "error" = "info", attention?: "done" | "question" | "error") {
    void this.rpc?.events.emit("notice", { ...(sessionID ? { sessionID } : {}), level, text, ...(attention ? { attention } : {}) }).catch(() => {})
  }

  private async transcript(sessionID: string, text: string) {
    await this.ctx.session.synthetic({ sessionID, text, resume: false } as any).catch(() => {})
  }

  // ───────────────────────────── starting and admitting turns

  async startGoal(sessionID: string, slug: string, source: "command" | "tool", options: { acknowledgeSupersede?: boolean } = {}): Promise<string> {
    return this.serial(async () => {
      const current = this.runs.get(sessionID)
      if (current && !isTerminal(current.status)) return `This session already has goal "${current.slug}" (${current.status}). Abort it first with /goal abort.`
      for (const other of this.runs.values())
        if (other.slug === slug && !isTerminal(other.status) && other.sessionID !== sessionID) return `Goal "${slug}" is already ${other.status} in another session (${other.sessionID}).`
      const loaded = this.load(slug, true)
      if ("error" in loaded) return loaded.error
      const { contract, lock, text } = loaded
      // T031: the supersession admission rule — a supersedes pointer must
      // resolve, match the predecessor's lock, and the predecessor must be
      // terminal (or the owner explicitly acknowledges superseding mid-flight).
      if (contract.supersedes) {
        const [oldSlug, lockPrefix] = contract.supersedes.split("@") as [string, string]
        const predecessorRun = this.store.readRun(oldSlug)
        const predecessorArchived = !predecessorRun && this.store.archivedSlugs().includes(oldSlug)
        if (!predecessorRun && !predecessorArchived) return `Refused: supersedes points at "${oldSlug}", but no such goal exists here (live or archived).`
        const predecessorLock = predecessorRun?.lock ?? ""
        if (predecessorRun && !predecessorLock.startsWith(lockPrefix!)) return `Refused: supersedes references ${oldSlug}@${lockPrefix}, but its run lock is ${predecessorLock.slice(0, 12)}… — the predecessor changed since the pointer was written; update the pointer.`
        if (predecessorRun && !isTerminal(predecessorRun.status) && !options.acknowledgeSupersede)
          return `Refused: "${oldSlug}" is still ${predecessorRun.status}. Superseding a live predecessor forks the audit trail — abort it first, or start with /goal start ${slug} acknowledge-supersede to record your explicit acknowledgment.`
        // flip the predecessor terminal, archive it (demote never delete), ledger both sides
        if (predecessorRun) {
          const liveState = [...this.runs.values()].find((s) => s.slug === oldSlug)
          if (liveState) {
            clearTimeout(this.timers.get(liveState.sessionID))
            setStatus(liveState, "superseded", `superseded by ${slug}`)
            this.runs.delete(liveState.sessionID)
          } else setStatus(predecessorRun, "superseded", `superseded by ${slug}`)
          const finalState = liveState ?? predecessorRun
          this.store.writeRun(finalState)
          this.store.ledger(oldSlug, { type: "superseded-by", by: slug, atLock: lock, acknowledged: !!options.acknowledgeSupersede })
          this.registry.update(this.rootReal, oldSlug, { title: finalState.title, status: "superseded", ...(finalState.runId ? { runId: finalState.runId } : {}), archived: true, updatedAt: Date.now() })
          this.store.archive(oldSlug)
        } else {
          this.store.ledger(oldSlug, { type: "superseded-by", by: slug, atLock: lock, acknowledged: !!options.acknowledgeSupersede, note: "predecessor was already archived" })
        }
        this.store.ledger(slug, { type: "supersession", of: oldSlug, atLock: lockPrefix, acknowledged: !!options.acknowledgeSupersede })
      }
      // T036: start-time rehearsal — run every command check once BEFORE
      // locking. A check whose text cannot run at all refuses the start; a
      // legitimate red check is recorded as the baseline (a bug-fix goal
      // SHOULD start red). The unrunnable signature is the shell's own
      // failure (exit 126/127 or a zsh:/bash: diagnostic) — never a tool's
      // stderr, so `grep missing-file` stays a valid red baseline.
      const commandChecks = [...contract.criteria, ...contract.invariants].filter((c) => c.check.kind === "command")
      const rehearsal: Array<{ id: string; pass: boolean; unrunnable: boolean; ms: number; detail: string }> = []
      for (const c of commandChecks) {
        const started = Date.now()
        const result = await runHostCheck(c.check, this.root, headCommit(this.root))
        const last = Array.isArray(result.raw) ? (result.raw as unknown[]).at(-1) as { exit?: number; stderr?: string } | undefined : undefined
        const unrunnable = Number(last?.exit) === 126 || Number(last?.exit) === 127 || /\b(zsh|bash|sh|dash):(\d+:)?\s.*(permission denied|command not found|no such file or directory)/i.test(String(last?.stderr ?? ""))
        rehearsal.push({ id: c.id, pass: result.pass, unrunnable, ms: Date.now() - started, detail: result.detail.slice(0, 400) })
        if (unrunnable) {
          this.store.ledger(slug, { type: "rehearsal-refused", id: c.id, exit: last?.exit, detail: result.detail.split("\n").slice(0, 3).join(" | ").slice(0, 300) })
          const diagnostic = String(last?.stderr ?? "").split("\n").find((l) => /permission denied|command not found|no such file/i.test(l)) ?? `exit ${last?.exit}`
          return `Refused to start "${slug}": the check command for ${c.id} cannot run — ${diagnostic.trim()}. Command checks must be runnable from the project root; keep each on ONE line (YAML folded scalars keep newlines before indented lines) and rehearse the stored command. Fix goal.yaml and /goal start again.`
        }
      }
      const state = initialRun(contract, { sessionID, runId: newRunId(), lock, commit: headCommit(this.root) })
      state.fingerprint = fingerprint(this.root)
      if (rehearsal.length) {
        this.store.evidence(slug, state.runId, "rehearsal", { at: Date.now(), results: rehearsal })
        this.store.ledger(slug, { type: "rehearsal", turn: 0, baseline: rehearsal.map((r) => ({ id: r.id, pass: r.pass })) })
      }
      this.store.evidence(slug, state.runId, "contract", { lock, text })
      await Bun.write(join(this.store.dir(slug), "evidence", state.runId, "contract.yaml"), text)
      this.runs.set(sessionID, state)
      this.store.ledger(slug, { type: "start", runId: state.runId, sessionID, source, lock, commit: state.base.commit })
      this.persist(state)
      this.notice(sessionID, `Goal started: ${contract.title}`, "success")
      if (!this.factsOf(sessionID).busy) await this.admit(state, "kickoff")
      return `Goal "${contract.title}" started (run ${state.runId}). The host drives the loop from here: work toward the outcome, record progress with goal_progress, and call goal_claim when every criterion holds.`
    })
  }

  /**
   * T038: owner-approved amendment. The owner edits goal.yaml out-of-band, then
   * `/goal amend` proposes (diff summary) and `/goal amend confirm` re-locks:
   * atomic generation-bound records, ledger trail, and the explicit branch
   * decision — prior evidence is retained for criteria whose checks did not
   * change; changed or new criteria reset to unknown and re-verify.
   */
  private async amendGoal(state: RunState, confirmed: boolean): Promise<string> {
    const read = this.store.readContract(state.slug)
    if (!read) return `no contract on disk for ${state.slug}`
    if (!read.contract) return `goal.yaml for "${state.slug}" is invalid:\n${formatIssues(read.issues)}\nThe run keeps its current lock; fix goal.yaml and amend again.`
    const next = read.contract
    const nextLock = read.lock
    if (nextLock === state.lock) return "Nothing to amend: goal.yaml is byte-identical to the locked contract."

    const prior = this.contractOf(state)!
    const key = (c: { id: string; check: unknown }) => `${c.id}:${JSON.stringify(c.check)}`
    const before = new Map([...prior.criteria, ...prior.invariants].map((c) => [c.id, key(c)]))
    const after = new Map([...next.criteria, ...next.invariants].map((c) => [c.id, key(c)]))
    const unchanged = [...after.entries()].filter(([id, k]) => before.get(id) === k).map(([id]) => id)
    const changed = [...after.entries()].filter(([id, k]) => before.has(id) && before.get(id) !== k).map(([id]) => id)
    const added = [...after.keys()].filter((id) => !before.has(id))
    const removed = [...before.keys()].filter((id) => !after.has(id))
    const summary = [
      `outcome: ${prior.outcome === next.outcome ? "unchanged" : "CHANGED"}`,
      `criteria unchanged [${unchanged.join(", ") || "-"}] changed [${changed.join(", ") || "-"}] added [${added.join(", ") || "-"}] removed [${removed.join(", ") || "-"}]`,
    ].join(" · ")

    if (!confirmed) {
      state.amendments.push({ change: summary, rationale: "proposed; awaiting /goal amend confirm", at: Date.now(), status: "proposed" })
      this.store.ledger(state.slug, { type: "amend-proposed", turn: state.turn, summary })
      this.persist(state)
      return `Proposed amendment: ${summary}\nReview the diff, then run /goal amend confirm to re-lock (generation ${state.amendments.filter((a) => a.status === "accepted").length + 1}).`
    }

    const generation = state.amendments.filter((a) => a.status === "accepted").length + 1
    const at = Date.now()
    const oldLock = state.lock
    // atomic, generation-bound record + evidence snapshot
    state.amendments.push({ change: summary, rationale: "owner-confirmed via /goal amend confirm", at, status: "accepted" })
    this.store.evidence(state.slug, state.runId, `amendment-${generation}-${at}`, { generation, oldLock, newLock: nextLock, at, by: "owner", summary, changed, added, removed, unchanged, contract: read.text })
    state.lock = nextLock
    // branch decision (council 145323Z): retain evidence for unchanged oracles
    for (const id of changed.concat(added)) state.criteria[id] = { status: "unknown", rejections: 0 }
    for (const id of removed) delete state.criteria[id]
    const steps = new Set(next.plan.map((s) => s.id))
    for (const id of Object.keys(state.steps)) if (!steps.has(id)) delete state.steps[id]
    // the in-memory contract cache must serve the amended contract from the next request on
    this.loaded.set(state.slug, { contract: next, lock: nextLock, text: read.text })
    this.store.ledger(state.slug, { type: "amended", turn: state.turn, generation, oldLock, newLock: nextLock, summary })
    this.persist(state)
    this.emitUpdate(state)
    this.notice(state.sessionID, `Goal amended (generation ${generation}): ${summary}`, "success")
    return `Amended ${state.slug} (generation ${generation}): ${summary}. Changed criteria reset to unknown and re-verify on the next claim.`
  }

  private async admit(state: RunState, kind: PendingKind) {
    if (this.disposed || !isActive(state.status)) return
    const contract = this.contractOf(state)
    if (!contract) {
      setStatus(state, "paused", "contract unavailable")
      this.persist(state)
      return
    }
    if (!state.pending || state.pending.kind !== kind) {
      state.turn += 1
      state.pending = { messageID: ascendingId("msg"), turn: state.turn, at: Date.now(), kind }
    }
    if (state.status !== "running") setStatus(state, "running")
    const note = renderTailNote(state, contract, kind as TailKind)
    this.notes.set(state.sessionID, note)
    state.compacted = false
    this.store.ledger(state.slug, { type: "admit", kind, turn: state.turn, messageID: state.pending.messageID })
    this.persist(state)
    try {
      // S2: a fixed id makes a retried admission idempotent.
      await this.ctx.session.prompt({
        sessionID: state.sessionID,
        id: state.pending.messageID,
        text: triggerText(state, contract, kind as TailKind),
        metadata: { goal: { slug: state.slug, run: state.runId, turn: state.turn, kind } },
        resume: true,
      } as any)
      state.counters.failures = Math.max(0, state.counters.failures - 1)
    } catch (error) {
      state.counters.failures += 1
      this.store.ledger(state.slug, { type: "admit-failed", turn: state.turn, error: String(error) })
      if (state.counters.failures >= this.options.maxPromptFailures) {
        setStatus(state, "paused", `could not send a continuation: ${String(error).slice(0, 200)}`)
        this.notice(state.sessionID, `Goal paused: ${state.reason}`, "error", "error")
      } else this.schedule(state, 2000 * 2 ** state.counters.failures, kind)
      this.persist(state)
    }
  }

  private schedule(state: RunState, delayMs: number, kind: PendingKind) {
    const key = state.sessionID
    clearTimeout(this.timers.get(key))
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key)
        void this.serial(async () => {
          const live = this.runs.get(key)
          if (!live || live.runId !== state.runId || !isActive(live.status) || this.factsOf(key).busy) return
          if (live.status === "waiting") {
            live.wait = undefined
            setStatus(live, "running")
          }
          await this.admit(live, kind)
        })
      }, delayMs),
    )
  }

  // ───────────────────────────── events (S1: filter to this location)

  private async eventLoop() {
    while (!this.disposed) {
      try {
        for await (const event of this.ctx.event.subscribe({ signal: this.controller.signal } as any) as AsyncIterable<any>) {
          if (this.disposed) return
          const dir = event?.location?.directory
          if (dir && dir !== this.root && canonical(dir) !== this.rootReal) continue
          // Never await slow work (verification) here: state changes are already
          // serialized by `serial`, and the stream must keep flowing.
          void this.onEvent(event).catch((error) => this.store.ledger("_errors", { type: "event-error", event: event?.type, error: String(error) }))
        }
      } catch (error) {
        if (this.disposed) return
        await Bun.sleep(1000)
      }
    }
  }

  private async onEvent(event: any) {
    const type: string = event.type
    const data = event.data ?? {}
    switch (type) {
      case "form.created": {
        const sid = data.form?.sessionID
        if (!sid) return
        this.factsOf(sid).forms.add(data.form.id)
        const state = this.runs.get(sid)
        if (state && isActive(state.status)) {
          this.notice(sid, "The goal is waiting for your answer.", "warning", "question")
          this.emitUpdate(state)
        }
        return
      }
      case "form.replied": {
        const f = this.factsOf(data.sessionID)
        f.forms.delete(data.id)
        const answers = Object.values(data.answer ?? {}).flatMap((v) => (Array.isArray(v) ? v : [v])).map(String)
        if (answers.includes(LAUNCH_LABEL)) f.launchApprovedAt = Date.now()
        const state = this.runs.get(data.sessionID)
        if (state) this.emitUpdate(state)
        return
      }
      case "form.cancelled": {
        const f = this.factsOf(data.sessionID)
        f.forms.delete(data.id)
        f.cancelledAt = Date.now()
        return
      }
    }
    const sid: string | undefined = data.sessionID
    if (!sid) return
    if (type === "session.execution.started") this.factsOf(sid).busy = true
    if (type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.execution.interrupted") this.factsOf(sid).busy = false
    const state = this.runs.get(sid)
    if (!state) return
    switch (type) {
      case "session.inbox.enqueued":
        return this.serial(() => this.onEnqueued(state, data))
      case "session.tool.called":
        state.turnFacts.tools += 1
        return
      case "session.usage.updated": {
        // T013: this event fires per message with cumulative session totals
        // (probed live on 2.0.22 — see docs/dogfood-1.md). The old handler
        // updated memory only, so run.json and the TUI froze at the values
        // captured at goal start (the sentinel 1) for the whole kickoff
        // execution of run 0ffe5ac6e001. Baseline = the cumulative total at
        // goal start; persist and re-render throttled so counters stay live.
        const total = (data.tokens?.input ?? 0) + (data.tokens?.output ?? 0) + (data.tokens?.reasoning ?? 0)
        if (state.usage.baseTokens === null) {
          state.usage.baseTokens = total
          state.usage.baseCost = data.cost ?? 0
        }
        state.usage.tokens = Math.max(0, total - (state.usage.baseTokens ?? 0))
        state.usage.cost = Math.max(0, (data.cost ?? 0) - (state.usage.baseCost ?? 0))
        const now = Date.now()
        if (state.lastUsageEmit === undefined || now - state.lastUsageEmit > 1000) {
          state.lastUsageEmit = now
          this.persist(state)
          this.emitUpdate(state)
        }
        return
      }
      case "session.compaction.ended":
        state.compacted = true
        this.store.ledger(state.slug, { type: "compacted", turn: state.turn })
        return
      case "session.execution.succeeded":
        return this.serial(() => this.onTurnEnd(state))
      case "session.execution.failed":
        return this.serial(() => this.onFailed(state, data.error))
      case "session.execution.interrupted":
        return this.serial(() => this.onInterrupted(state, data.reason))
      case "session.deleted":
        return this.serial(() => {
          if (isTerminal(state.status)) return
          setStatus(state, "aborted", "session deleted")
          this.store.ledger(state.slug, { type: "aborted", reason: "session deleted" })
          this.persist(state)
        })
    }
  }

  /** A prompt entered the session: ours (tagged) or the owner's (a steer). */
  private async onEnqueued(state: RunState, data: any) {
    const meta = data.item?.payload?.metadata?.goal
    if (meta) return
    if (data.item?.type !== "user") return
    const contract = this.contractOf(state)
    if (isActive(state.status)) {
      if (contract?.autonomy.on_user_message === "pause") {
        setStatus(state, "paused", "owner sent a message")
        this.store.ledger(state.slug, { type: "paused", reason: "owner message" })
        this.notice(state.sessionID, "Goal paused because you sent a message. /goal resume to continue.", "info")
      } else {
        state.steers += 1
        this.store.ledger(state.slug, { type: "steer", text: String(data.item?.payload?.text ?? "").slice(0, 280) })
      }
      this.persist(state)
    } else if (state.status === "paused" && state.reason?.startsWith("interrupted") && contract?.autonomy.on_interrupt === "resume-on-message") {
      setStatus(state, "running")
      this.store.ledger(state.slug, { type: "resumed", by: "owner message" })
      this.persist(state)
    }
  }

  private async onTurnEnd(state: RunState) {
    if (state.status !== "running") return
    const contract = this.contractOf(state)
    if (!contract) return
    const kind = state.pending?.kind
    state.pending = undefined
    this.notes.delete(state.sessionID)

    if (state.claim) return this.verify(state, contract, "claim")
    // Started from a tool call while the session was busy: kick off now.
    if (state.turn === 0) return this.admit(state, "kickoff")

    if (kind === "wrapup") {
      setStatus(state, "budget_limited", "budget used; wrap-up turn done")
      this.store.ledger(state.slug, { type: "budget_limited" })
      this.notice(state.sessionID, `Goal stopped at its budget: ${contract.title}`, "warning", "question")
      return this.persist(state)
    }

    // Progress is authoritative state change, not activity (R3).
    const fp = fingerprint(this.root)
    const changed = fp !== undefined && fp !== state.fingerprint
    state.fingerprint = fp
    let progress = changed || state.turnFacts.stepsChanged
    if (changed && this.options.liveChecks) progress = (await this.liveChecks(state, contract)) || progress
    state.counters.noProgress = progress ? 0 : state.counters.noProgress + 1
    this.store.ledger(state.slug, { type: "turn", turn: state.turn, kind, tools: state.turnFacts.tools, changed, progress, noProgress: state.counters.noProgress })
    state.turnFacts = { tools: 0, goalCalls: 0, stepsChanged: false }

    if (state.blocker && state.blocker.count >= this.options.blockerRepeats) {
      setStatus(state, "blocked", `${state.blocker.key}: ${state.blocker.reason}`)
      this.store.ledger(state.slug, { type: "blocked", blocker: state.blocker })
      this.notice(state.sessionID, `Goal blocked: ${state.blocker.reason}`, "warning", "question")
      return this.persist(state)
    }

    const use = budgetUse(state, contract)
    const backstop = !contract.budget.turns && state.turn >= this.options.backstopTurns
    if (use.ratio >= 1 || backstop) {
      if (!state.wrapup) {
        state.wrapup = true
        this.store.ledger(state.slug, { type: "wrapup", ratio: use.ratio, backstop })
        return this.admit(state, "wrapup")
      }
      setStatus(state, "budget_limited", backstop ? `backstop of ${this.options.backstopTurns} turns reached` : "budget used")
      this.notice(state.sessionID, `Goal stopped at its budget: ${contract.title}`, "warning", "question")
      return this.persist(state)
    }

    if (state.counters.noProgress >= this.options.stallTurns) {
      setStatus(state, "paused", `stalled: no change the host could see for ${state.counters.noProgress} turns`)
      this.store.ledger(state.slug, { type: "paused", reason: state.reason })
      this.notice(state.sessionID, `Goal paused — ${state.reason}`, "warning", "question")
      return this.persist(state)
    }

    if (state.wait && state.wait.until > Date.now()) {
      setStatus(state, "waiting", state.wait.reason)
      this.persist(state)
      return this.schedule(state, state.wait.until - Date.now(), "continue")
    }
    state.wait = undefined

    const next: PendingKind = state.counters.noProgress >= this.options.recoveryAt ? "recovery" : "continue"
    this.persist(state)
    this.schedule(state, this.options.cooldownMs, next)
  }

  /** Re-run cheap `live: true` command checks after a turn that changed files. */
  private async liveChecks(state: RunState, contract: Contract): Promise<boolean> {
    let transitioned = false
    for (const c of [...contract.criteria, ...contract.invariants]) {
      if (c.check.kind !== "command" || !c.check.live) continue
      const r = await runHostCheck({ ...c.check, runs: 1 }, this.root, state.base.commit)
      const prev = state.criteria[c.id]
      const status = r.pass ? "pass" : "fail"
      if (prev?.status !== status) transitioned = true
      state.criteria[c.id] = { status, by: "host", at: Date.now(), detail: r.detail.slice(0, 600), rejections: prev?.rejections ?? 0 }
    }
    return transitioned
  }

  private async onFailed(state: RunState, error: any) {
    if (!isActive(state.status)) return
    const message = String(error?.message ?? error?.type ?? error ?? "unknown error")
    state.pending = undefined
    let reason: string | undefined
    if (/quota|insufficient|billing|credit|usage limit/i.test(message)) reason = `provider usage limit: ${message}`
    else if (/context|too long|maximum.*tokens/i.test(message)) reason = `context overflow: ${message}`
    else if (/auth|unauthorized|forbidden|api key/i.test(message)) reason = `provider auth error: ${message}`
    else {
      state.counters.failures += 1
      this.store.ledger(state.slug, { type: "turn-failed", error: message, failures: state.counters.failures })
      if (state.counters.failures < this.options.maxPromptFailures) {
        this.persist(state)
        return this.schedule(state, 5000 * 2 ** state.counters.failures, "continue")
      }
      reason = `repeated errors: ${message}`
    }
    setStatus(state, "paused", reason.slice(0, 300))
    this.store.ledger(state.slug, { type: "paused", reason })
    this.notice(state.sessionID, `Goal paused — ${reason}`, "error", "error")
    this.persist(state)
  }

  /** S8: Esc → reason "user"; a dismissed question → form.cancelled then "shutdown". */
  private async onInterrupted(state: RunState, reason: string) {
    if (!isActive(state.status)) return
    if (reason === "superseded") return
    const f = this.factsOf(state.sessionID)
    const why =
      reason === "user"
        ? "interrupted by you (Esc)"
        : reason === "shutdown" && f.cancelledAt && Date.now() - f.cancelledAt < 10_000
          ? "interrupted: a question was dismissed"
          : reason === "inactivity"
            ? "interrupted: host evicted the idle project"
            : `interrupted: ${reason}`
    clearTimeout(this.timers.get(state.sessionID))
    setStatus(state, "paused", why)
    this.store.ledger(state.slug, { type: "paused", reason: why })
    this.notice(state.sessionID, `Goal paused — ${why}. /goal resume to continue.`, "info")
    this.persist(state)
  }

  // ───────────────────────────── verification

  private async verify(state: RunState, contract: Contract, source: "claim" | "owner") {
    setStatus(state, "verifying", source === "claim" ? "checking your claim" : "owner requested verification")
    this.store.ledger(state.slug, { type: "verify-start", source, turn: state.turn })
    this.persist(state)
    this.notice(state.sessionID, "Verifying the goal…", "info")
    const text = existsSync(this.store.contractPath(state.slug)) ? readFileSync(this.store.contractPath(state.slug), "utf8") : ""
    const outcome = await verifyClaim(contract, state, { root: this.root, contractText: text, verifier: (input) => this.runVerifier(input) })
    const now = Date.now()
    for (const r of outcome.results) {
      const prev = state.criteria[r.id] ?? { status: "unknown" as const, rejections: 0 }
      const claimed = source === "claim" && !r.pass && r.by !== "human"
      state.criteria[r.id] = { status: r.pass ? "pass" : r.by === "human" ? prev.status : "fail", by: r.by, at: now, detail: r.detail.slice(0, 600), rejections: r.pass ? 0 : prev.rejections + (claimed ? 1 : 0) }
    }
    this.store.evidence(state.slug, state.runId, `verify-turn-${state.turn}-${now}`, { source, claim: state.claim ?? null, outcome: { ...outcome, results: outcome.results.map((r) => ({ ...r, raw: undefined })) } })
    state.verdict = { at: now, turn: state.turn, passed: outcome.passed, lines: outcome.lines }
    state.claim = undefined
    this.store.ledger(state.slug, { type: "verdict", passed: outcome.passed, lines: outcome.lines.slice(0, 10) })

    if (outcome.passed) {
      setStatus(state, "complete", "all required criteria verified")
      this.store.ledger(state.slug, { type: "complete", turn: state.turn })
      this.notice(state.sessionID, `Goal complete: ${contract.title}`, "success", "done")
      await this.transcript(state.sessionID, `◎ Goal complete — "${contract.title}". Every required criterion was verified by the host${contract.verification.mode !== "host" ? " and the independent verifier" : ""}.`)
      return this.persist(state)
    }
    const onlyHuman = outcome.integrity.length === 0 && outcome.results.every((r) => r.pass || r.by === "human" || !this.required(contract).has(r.id))
    if (onlyHuman && outcome.needsHuman.length) {
      setStatus(state, "needs_review", `owner sign-off needed: ${outcome.needsHuman.join(", ")}`)
      this.notice(state.sessionID, `Goal needs your sign-off on ${outcome.needsHuman.join(", ")} (/goal approve <id>)`, "warning", "question")
      return this.persist(state)
    }
    const stuck = Object.entries(state.criteria).filter(([, s]) => s.rejections >= contract.verification.max_rejections).map(([id]) => id)
    if (stuck.length) {
      setStatus(state, "needs_review", `${stuck.join(", ")} rejected ${contract.verification.max_rejections} times`)
      this.notice(state.sessionID, `Goal needs review: ${state.reason}`, "warning", "question")
      return this.persist(state)
    }
    if (source === "owner") {
      setStatus(state, "paused", "verification did not pass; resume to keep working")
      return this.persist(state)
    }
    setStatus(state, "running")
    this.notice(state.sessionID, "Claim rejected by the host; the verdict goes back to the agent.", "warning")
    await this.admit(state, "verdict")
  }

  private required(contract: Contract) {
    return new Set([...contract.criteria.filter((c) => c.essential).map((c) => c.id), ...contract.invariants.map((c) => c.id)])
  }

  /** S7: a hidden read-only agent in a child session; its only extra tool is goal_verdict. */
  private async runVerifier(input: { contract: Contract; state: RunState; criteria: Contract["criteria"]; host: Array<{ id: string; pass: boolean; detail: string; by: string }> }) {
    const { contract, state, criteria, host } = input
    const child: any = await this.ctx.session.create({ parentID: state.sessionID, agent: this.options.verifierAgent, title: `goal verify · ${contract.id}` } as any)
    const childID: string = child?.id ?? child?.data?.id
    this.verifierInbox.delete(childID)
    const lines: string[] = []
    lines.push("You are an independent completion verifier. You did not do this work and you gain nothing if it passes. Fail closed: a criterion is proven only if you can quote file text that proves it.")
    lines.push(`Goal outcome: ${contract.outcome}`)
    lines.push("Criteria to judge:")
    for (const c of criteria) lines.push(`- ${c.id}: ${c.statement}${c.check.kind === "verifier" ? `\n    question: ${c.check.ask}` : "\n    (the host check passed; confirm the work genuinely satisfies the statement, not just the check)"}`)
    lines.push("Host check results (trusted):")
    for (const r of host) lines.push(`- ${r.id} ${r.pass ? "PASS" : "FAIL"}: ${r.detail.split("\n")[0]}`)
    if (state.claim) {
      lines.push("The worker's claim (untrusted; check it, do not believe it):")
      lines.push(`  ${state.claim.summary}`)
      for (const [id, note] of Object.entries(state.claim.evidence)) lines.push(`  ${id}: ${note}`)
    }
    lines.push("Use read, glob and grep to inspect the repository. Then call goal_verdict exactly once with one entry per criterion above: verdict proven, not_proven or contradicted; a one-line reason; and for proven, evidence items with the file path (relative to the project root) and a verbatim quote of at least one full line. Do not answer in prose instead of calling the tool. If the tool is unavailable or fails, reply with ONLY a fenced json block as your final message: ```json {\"verdicts\":[{\"id\":\"C1\",\"verdict\":\"proven\",\"reason\":\"...\",\"evidence\":[{\"path\":\"relative/path\",\"quote\":\"verbatim line\"}]}]} ```")
    try {
      await this.ctx.session.prompt({ sessionID: childID, text: lines.join("\n"), resume: true } as any)
      const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), this.options.verifierTimeoutMs))
      const done = await Promise.race([this.ctx.session.wait({ sessionID: childID } as any).then(() => "done" as const), timeout])
      if (done === "timeout") await this.ctx.session.interrupt({ sessionID: childID } as any).catch(() => {})
      let verdicts = this.verifierInbox.get(childID) ?? []
      let by: "verifier" | "verifier-fallback" = "verifier"
      // T016: persist the child transcript so a silent or prose-answering
      // verifier is diagnosable from the evidence, never a mystery again.
      let messages: unknown[] = []
      try {
        messages = ((await this.ctx.session.context({ sessionID: childID } as any)) ?? []) as unknown[]
      } catch {
        // transcript unavailable on this host; the fallback simply has less to work with
      }
      if (!verdicts.length) {
        const parsed = parseFallbackVerdicts(messages, new Set(criteria.map((c) => c.id)))
        if (parsed.length) {
          verdicts = parsed
          by = "verifier-fallback"
          this.store.ledger(state.slug, { type: "verifier-fallback", turn: state.turn, count: parsed.length })
        }
      }
      const transcript = this.store.evidence(state.slug, state.runId, `verifier-transcript-turn-${state.turn}-${Date.now()}`, { childID, done, by, messages: compactTranscript(messages) })
      this.store.ledger(state.slug, { type: "verifier-transcript", turn: state.turn, by, file: transcript })
      return { verdicts, by, ...(verdicts.length ? {} : { error: done === "timeout" ? "verifier timed out" : "verifier did not call goal_verdict" }) }
    } finally {
      this.verifierInbox.delete(childID)
      await this.ctx.session.remove({ sessionID: childID } as any).catch(() => {})
    }
  }

  // ───────────────────────────── owner actions (command, RPC)

  async ownerAct(sessionID: string, action: "pause" | "resume" | "abort" | "verify" | "approve" | "reject" | "amend" | "archive", arg?: string): Promise<{ ok: boolean; message: string }> {
    return this.serial(async () => {
      const state = this.runs.get(sessionID)
      if (!state) return { ok: false, message: "No goal in this session. Start one with /goal start <slug> or write one with /goal new <what you want>." }
      const why = ownerCan(state, action)
      if (why) return { ok: false, message: why }
      const contract = this.contractOf(state)
      switch (action) {
        case "pause":
          clearTimeout(this.timers.get(sessionID))
          setStatus(state, "paused", "paused by you")
          this.store.ledger(state.slug, { type: "paused", reason: "owner" })
          this.persist(state)
          return { ok: true, message: `Goal paused: ${state.title}` }
        case "resume": {
          state.counters = { noProgress: 0, failures: 0 }
          state.blocker = undefined
          state.wrapup = false
          if (state.status === "budget_limited") return { ok: false, message: "The goal used its budget. Raise budget in goal.yaml and start a new run, or abort it." }
          setStatus(state, "running")
          state.fingerprint = fingerprint(this.root)
          this.store.ledger(state.slug, { type: "resumed", by: "owner" })
          this.persist(state)
          if (!this.factsOf(sessionID).busy) await this.admit(state, "resume")
          return { ok: true, message: `Goal resumed: ${state.title}` }
        }
        case "abort":
          clearTimeout(this.timers.get(sessionID))
          setStatus(state, "aborted", "aborted by you")
          this.store.ledger(state.slug, { type: "aborted", reason: "owner" })
          this.persist(state)
          return { ok: true, message: `Goal aborted: ${state.title}` }
        case "amend": {
          if (!contract) return { ok: false, message: "contract unavailable" }
          const confirmed = (arg?.split(/\s+/) ?? []).includes("confirm")
          const message = await this.amendGoal(state, confirmed)
          return { ok: message.startsWith("Amended") || message.startsWith("Proposed"), message }
        }
        case "archive": {
          // T032: demote, never delete — the folder moves to goals-archive/
          // with ledger and evidence intact; the registry keeps answering yes.
          clearTimeout(this.timers.get(sessionID))
          const finalStatus = state.status
          this.store.ledger(state.slug, { type: "archived", from: finalStatus })
          this.registry.update(this.rootReal, state.slug, { title: state.title, status: finalStatus, ...(state.runId ? { runId: state.runId } : {}), ...(state.lock ? { lock: state.lock } : {}), archived: true, updatedAt: Date.now() })
          this.store.archive(state.slug)
          this.loaded.delete(state.slug)
          this.runs.delete(sessionID)
          this.notice(sessionID, `Goal archived: ${state.title} (history intact under .opencode/goals-archive/${state.slug}/)`, "success")
          return { ok: true, message: `Goal archived: ${state.title}` }
        }
        case "verify":
          if (!contract) return { ok: false, message: "contract unavailable" }
          await this.verify(state, contract, "owner")
          return { ok: true, message: `Verification ${state.status === "complete" ? "passed" : "did not pass"}: ${state.verdict?.lines[0] ?? ""}` }
        case "approve":
        case "reject": {
          const id = (arg ?? "").trim().split(/\s+/)[0]?.toUpperCase()
          const criterion = contract?.criteria.find((c) => c.id === id)
          if (!criterion) return { ok: false, message: `Unknown criterion "${id}".` }
          state.criteria[criterion.id] = { status: action === "approve" ? "pass" : "fail", by: "human", at: Date.now(), detail: action === "approve" ? "approved by the owner" : `rejected by the owner: ${(arg ?? "").slice(id.length).trim() || "no reason given"}`, rejections: 0 }
          this.store.ledger(state.slug, { type: action, criterion: criterion.id })
          if (state.status === "needs_review" && action === "approve" && contract) {
            this.persist(state)
            await this.verify(state, contract, "owner")
            return { ok: true, message: `${criterion.id} approved; goal is ${state.status}.` }
          }
          this.persist(state)
          return { ok: true, message: `${criterion.id} ${action === "approve" ? "approved" : "rejected"}.` }
        }
      }
    })
  }

  // ───────────────────────────── registrations

  private async registerAgents() {
    const name = this.options.verifierAgent
    this.registrations.push(
      await this.ctx.agent.transform((editor: any) => {
        editor.update(name, (agent: any) => {
          agent.name = "Goal verifier"
          agent.description = "Independent read-only verifier for goal completion claims."
          agent.mode = "subagent"
          agent.hidden = true
          agent.permissions.push(
            { action: "*", resource: "*", effect: "deny" },
            { action: "read", resource: "*", effect: "allow" },
            { action: "glob", resource: "*", effect: "allow" },
            { action: "grep", resource: "*", effect: "allow" },
            { action: "goal_verdict", resource: "*", effect: "allow" },
          )
        })
        for (const agent of editor.list()) {
          if (String(agent.id) === name) continue
          editor.update(String(agent.id), (item: any) => item.permissions.push({ action: "goal_verdict", resource: "*", effect: "deny" }))
        }
      }),
    )
  }

  private async registerSkill() {
    const path = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "write-goal", "SKILL.md")
    if (!existsSync(path)) return
    const raw = readFileSync(path, "utf8")
    const front = /^---\n([\s\S]*?)\n---\n?/.exec(raw)
    const meta = front ? ((Bun as any).YAML.parse(front[1]) ?? {}) : {}
    const content = front ? raw.slice(front[0].length) : raw
    this.registrations.push(
      await this.ctx.skill.transform((editor: any) => {
        if (editor.get("write-goal")) return
        editor.add({ id: "write-goal", name: String(meta.name ?? "write-goal"), description: String(meta.description ?? "Write a goal contract for goal mode."), path, content })
      }),
    )
  }

  private async registerCommand() {
    this.registrations.push(
      await this.ctx.command.transform((editor: any) => {
        editor.add({
          name: "goal",
          description: "Goal mode: /goal new <what you want> · start <slug> · status · pause · resume · verify · abort · approve <C#> · list",
          execute: async ({ sessionID, prompt }: any) => {
            const text = String(prompt?.text ?? "").trim()
            await this.command(sessionID, text)
          },
        })
      }),
    )
  }

  async command(sessionID: string, text: string) {
    const [head = "", ...rest] = text.split(/\s+/)
    const arg = rest.join(" ").trim()
    const sub = head.toLowerCase()
    // Results go to the TUI as notices, never into the transcript: a synthetic
    // message here would land inside the turn the command just started.
    const say = async (message: string, level: "info" | "success" | "warning" | "error" = "info") => this.notice(sessionID, message, level)
    switch (sub) {
      case "":
      case "status": {
        const state = this.runs.get(sessionID)
        if (!state) return say(this.listText() || "No goal in this session. /goal new <what you want> writes one; /goal start <slug> runs an existing one.")
        void this.rpc?.events.emit("notice", { sessionID, level: "info", text: this.statusText(state), panel: true }).catch(() => {})
        return
      }
      case "list": {
        const archived = this.registry.list().filter((g) => g.project === this.rootReal && g.archived)
        const live = this.listText() || "No live goals in .opencode/goals/."
        const all = arg.toLowerCase() === "all"
        const archivedText = all
          ? archived.map((g) => `${g.slug} — archived (${g.status})`).join("\n")
          : archived.length
            ? `${archived.length} archived goal(s): ${archived.map((g) => g.slug).join(", ")} (/goal list all)`
            : ""
        return say([live, archivedText].filter(Boolean).join("\n"))
      }
      case "new":
      case "write": {
        if (!arg) return say("Usage: /goal new <what you want done>", "warning")
        // T033: admission probe before the interview — exact existence and
        // ranked similarity over live + archived goals, prepended for the
        // write-goal interview to surface as owner options.
        const candidates = [
          ...this.store.slugs().map((slug) => {
            const runState = this.store.readRun(slug)
            const read = this.store.readContract(slug)
            return { slug, title: runState?.title ?? read?.contract?.title ?? slug, ...(runState ? { status: runState.status } : {}) }
          }),
          ...this.store.archivedSlugs().map((slug) => {
            const read = this.store.readContract(slug)
            return { slug, title: read?.contract?.title ?? slug, status: "archived", archived: true as const }
          }),
          ...this.registry.list().filter((g) => g.project === this.rootReal).map((g) => ({ slug: g.slug, title: g.title, ...(g.status ? { status: g.status } : {}), ...(g.archived ? { archived: true as const } : {}) })),
        ]
        const deduped = [...new Map(candidates.map((c) => [c.slug, c])).values()]
        const slugHint = arg.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64)
        const note = admissionNote(arg, slugHint, deduped)
        const first = note ? `${arg}\n\n${note}` : arg
        await this.ctx.session.prompt({ sessionID, text: first, skills: [{ id: "write-goal" }] } as any)
        return
      }
      case "start": {
        if (!arg) return say(`Usage: /goal start <slug>. Goals here: ${this.store.slugs().join(", ") || "none"}`, "warning")
        const tokens = arg.split(/\s+/)
        const slug0 = tokens[0]!
        const acknowledgeSupersede = tokens.includes("acknowledge-supersede")
        if (!this.store.slugs().includes(slug0) && this.store.archivedSlugs().includes(slug0))
          return say(`"${slug0}" exists, archived at .opencode/goals-archive/${slug0}/ (history intact; it WAS a goal here). Move it back or write a superseding goal.`, "warning")
        const message = await this.startGoal(sessionID, slug0, "command", { acknowledgeSupersede })
        return say(message, message.startsWith("Goal \"") ? "success" : "error")
      }
      case "validate": {
        const slug = arg.split(/\s+/)[0]
        if (!slug) return say("Usage: /goal validate <slug>", "warning")
        const read = this.store.readContract(slug)
        return say(read ? formatIssues(read.issues) : `no goal named ${slug}`, read?.contract ? "success" : "error")
      }
      case "pause":
      case "resume":
      case "abort":
      case "verify":
      case "approve":
      case "reject":
      case "amend":
      case "archive": {
        const result = await this.ownerAct(sessionID, sub as any, arg)
        return say(result.message, result.ok ? "success" : "error")
      }
      case "help":
        return say(goalHelp({ version: (this.ctx.options as any)?.version ?? "v0.2.0" }), "info")
      default:
        // Anything else is a request to write a goal from these words.
        await this.ctx.session.prompt({ sessionID, text, skills: [{ id: "write-goal" }] } as any)
    }
  }

  private statusText(state: RunState): string {
    const v = this.view(state)
    if (!v) return `${state.slug}: ${state.status}`
    const proven = v.criteria.filter((c) => c.status === "pass").length
    return [`◎ ${v.title} — ${v.status}${v.reason ? ` (${v.reason})` : ""}`, `criteria ${proven}/${v.criteria.length} · turn ${v.turn}`, ...v.criteria.map((c) => `${c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "·"} ${c.id} ${c.statement}`)].join("\n")
  }

  private listText(): string {
    return this.list()
      .map((g) => `${g.slug} — ${g.status}${g.total ? ` (${g.proven}/${g.total})` : ""}`)
      .join("\n")
  }

  list(): GoalSummary[] {
    const bySlug = new Map([...this.runs.values()].map((r) => [r.slug, r]))
    return this.store.slugs().map((slug) => {
      const run = bySlug.get(slug) ?? this.store.readRun(slug)
      const states = run ? Object.values(run.criteria) : []
      return { slug, title: run?.title ?? slug, status: run?.status ?? "draft", ...(run ? { sessionID: run.sessionID } : {}), proven: states.filter((s) => s.status === "pass").length, total: states.length }
    })
  }

  private async registerHooks() {
    // R5 + S3: render the contract into every request for sessions with a live goal.
    this.registrations.push(
      await this.ctx.session.hook("context", (event: any) => {
        const state = this.runs.get(event.sessionID)
        if (!state || isTerminal(state.status) || state.status === "aborted") return
        const contract = this.contractOf(state)
        if (!contract) return
        event.system.push({ type: "text", text: renderSystemBlock(contract, state.lock) })
        const note = this.notes.get(event.sessionID)
        if (!note || !isActive(state.status)) return
        // Just before the turn's own prompt, so the note keeps one position for
        // every step of the turn and the cached prefix before it stays warm.
        let at = event.messages.length
        for (let i = event.messages.length - 1; i >= 0; i--)
          if (event.messages[i]?.role === "user") {
            at = i
            break
          }
        event.messages.splice(at, 0, makeUserMessage(event.messages, note))
      }),
    )
    this.registrations.push(
      await this.ctx.session.hook("compaction", (event: any) => {
        const state = this.runs.get(event.sessionID)
        const contract = state && this.contractOf(state)
        if (!state || !contract || isTerminal(state.status)) return
        event.system.push({ type: "text", text: `${renderSystemBlock(contract, state.lock)}\n\nPreserve in the summary: the goal "${contract.title}" is ${state.status}; progress so far: ${state.progress?.note ?? "none recorded"}; next: ${state.progress?.next ?? "continue the plan"}.` })
      }),
    )
    this.registrations.push(
      await this.ctx.tool.hook("execute.before", (event: any) => {
        const state = this.runs.get(event.sessionID)
        if (!state) return
        const contract = this.contractOf(state)
        if (contract && isActive(state.status) && event.tool === "question" && contract.autonomy.questions === "defer")
          throw new Error("Goal mode defers questions to the owner during a run. Make the most reasonable reversible choice and note it as an assumption in goal_progress, or call goal_block if this truly needs the owner.")
        const paths = targetPaths(event.tool, event.input)
        for (const p of paths) {
          const rel = p.startsWith(this.root) ? p.slice(this.root.length + 1) : p.replace(/^\.\//, "")
          // T037: the goal folder stays untouchable for the whole life of the
          // run — including stopped states (paused/needs_review/budget_limited),
          // the unguarded amendment window the council flagged. Terminal runs
          // release the folder so the next contract can be written.
          if (!isTerminal(state.status) && rel.startsWith(".opencode/goals/"))
            throw new Error("The goal contract and run state are owned by the owner and the host. Do not edit .opencode/goals/ while the goal exists — the owner amends via /goal amend (re-lock with audit trail) or aborts and edits before a fresh /goal start.")
          if (isActive(state.status) && contract) {
            if (contract.protect.some((g) => globMatch(rel, g))) throw new Error(`${rel} is protected by the goal contract (an oracle the worker may not change). If it is wrong, call goal_flag.`)
          }
        }
      }),
    )
  }

  private async registerRpc() {
    try {
      const registration: any = await (this.ctx.rpc as any).register(GoalRpc, {
        snapshot: async (input: { sessionID: string }) => {
          const state = this.runs.get(input.sessionID)
          return { view: state ? (this.view(state) ?? null) : null }
        },
        list: async () => ({ goals: this.list() }),
        act: async (input: { sessionID: string; action: any; arg?: string }) => this.ownerAct(input.sessionID, input.action, input.arg),
      })
      this.rpc = registration
      this.registrations.push(registration)
    } catch {
      // RPC is optional: without it the server still runs goals; the TUI shows nothing.
    }
  }

  // ───────────────────────────── worker tools (S7: native names, codemode off)

  private async registerTools() {
    const tool = (name: string, description: string, input: Record<string, unknown>, execute: (args: any, context: any) => Promise<string | Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
      name,
      description,
      options: { namespace: "goal", codemode: false, ...extra },
      input: { type: "object", additionalProperties: false, ...input },
      execute: async (args: any, context: any) => {
        const out = await execute(args ?? {}, context)
        return typeof out === "string" ? { content: out } : { content: json(out), metadata: out }
      },
    })
    const forSession = (context: any) => this.runs.get(context.sessionID)
    const guard = (context: any, action: Parameters<typeof modelCan>[1]) => {
      const state = forSession(context)
      const why = modelCan(state, action)
      if (why) throw new Error(why)
      return state!
    }

    const tools = [
      tool("status", "Show the active goal: status, criteria board, plan, budget, last verdict. Cheap; use it after a compaction or when unsure what remains.", { properties: {} }, async (_args, context) => {
        const state = forSession(context)
        if (!state) return "No goal is running in this session."
        return this.view(state) ?? { status: state.status }
      }),
      tool(
        "progress",
        "Record progress on the goal: the plan step you are on (and whether it is done), one line on what changed, and the next concrete action. Feeds the owner's sidebar and the ledger.",
        {
          properties: {
            step: { type: "string", description: "Plan step id, e.g. S2" },
            step_done: { type: "boolean", description: "true when the step is finished" },
            note: { type: "string", maxLength: 400, description: "What changed this turn (one line)" },
            next: { type: "string", maxLength: 400, description: "The next concrete action" },
          },
          required: ["note"],
        },
        async (args, context) =>
          this.serial(() => {
            const state = guard(context, "progress")
            const contract = this.contractOf(state)
            if (args.step) {
              const id = String(args.step).toUpperCase()
              if (!contract?.plan.some((s) => s.id === id)) throw new Error(`unknown plan step ${id}`)
              const before = state.steps[id]
              state.steps[id] = args.step_done ? "done" : "active"
              if (args.step_done) {
                const nextStep = contract!.plan.find((s) => state.steps[s.id] === "pending" && s.depends_on.every((d) => state.steps[d] === "done"))
                if (nextStep) state.steps[nextStep.id] = "active"
              }
              if (before !== state.steps[id]) state.turnFacts.stepsChanged = true
            }
            state.progress = { note: String(args.note).slice(0, 400), ...(args.next ? { next: String(args.next).slice(0, 400) } : {}), at: Date.now(), turn: state.turn }
            state.turnFacts.goalCalls += 1
            this.store.ledger(state.slug, { type: "progress", turn: state.turn, step: args.step, done: !!args.step_done, note: state.progress.note, next: state.progress.next })
            this.persist(state)
            return "Recorded."
          }),
      ),
      tool(
        "claim",
        "Claim the goal is complete. Give evidence per criterion (what you ran or inspected and what it showed). Then END YOUR TURN: the host runs every check itself and an independent verifier reviews the rest. Never claim to escape the loop.",
        {
          properties: {
            summary: { type: "string", maxLength: 2000 },
            evidence: { type: "object", description: "Map of criterion id → evidence note, e.g. {\"C1\": \"npm test: 84 passed\"}", additionalProperties: { type: "string", maxLength: 1000 } },
          },
          required: ["summary", "evidence"],
        },
        async (args, context) =>
          this.serial(() => {
            const state = guard(context, "claim")
            const contract = this.contractOf(state)!
            const evidence = Object.fromEntries(Object.entries(args.evidence ?? {}).map(([k, v]) => [k.toUpperCase(), String(v).slice(0, 1000)]))
            const missing = contract.criteria.filter((c) => c.essential && !evidence[c.id]).map((c) => c.id)
            if (missing.length) throw new Error(`Give evidence for every essential criterion; missing: ${missing.join(", ")}`)
            state.claim = { at: Date.now(), turn: state.turn, summary: String(args.summary).slice(0, 2000), evidence }
            for (const id of Object.keys(evidence)) if (state.criteria[id] && state.criteria[id]!.status !== "pass") state.criteria[id]!.status = "claimed"
            this.store.ledger(state.slug, { type: "claim", turn: state.turn, summary: state.claim.summary })
            this.persist(state)
            return "Claim recorded. End your turn now; the host will verify it and either complete the goal or return a verdict."
          }),
      ),
      tool(
        "block",
        "Report a blocker that only the owner can resolve (a missing credential, an access grant, a product decision). Use a short stable key so repeats are counted; after 3 consecutive reports the goal stops and asks the owner. Hard or slow work is not a blocker.",
        {
          properties: {
            key: { type: "string", maxLength: 80, description: "Stable key, e.g. missing-stripe-key" },
            reason: { type: "string", maxLength: 500 },
            needs: { type: "string", enum: ["decision", "credential", "access", "external"] },
          },
          required: ["key", "reason"],
        },
        async (args, context) =>
          this.serial(() => {
            const state = guard(context, "block")
            const key = String(args.key).toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 80)
            const same = state.blocker?.key === key && state.blocker.lastTurn >= state.turn - 1
            state.blocker = { key, count: same ? state.blocker!.count + (state.blocker!.lastTurn === state.turn ? 0 : 1) : 1, reason: String(args.reason).slice(0, 500), ...(args.needs ? { needs: String(args.needs) } : {}), lastTurn: state.turn }
            this.store.ledger(state.slug, { type: "block", key, count: state.blocker.count, reason: state.blocker.reason })
            this.persist(state)
            return state.blocker.count >= this.options.blockerRepeats
              ? "Blocker confirmed. The goal will stop and ask the owner when this turn ends."
              : `Blocker noted (${state.blocker.count}/${this.options.blockerRepeats}). Continue with any work that does not depend on it.`
          }),
      ),
      tool(
        "flag",
        "Flag a criterion that is contradictory, impossible or unsafe as written. The goal stops for the owner to review. Use this instead of gaming a check.",
        {
          properties: {
            criterion: { type: "string" },
            kind: { type: "string", enum: ["contradictory", "impossible", "unsafe"] },
            reason: { type: "string", maxLength: 800 },
          },
          required: ["kind", "reason"],
        },
        async (args, context) =>
          this.serial(() => {
            const state = guard(context, "flag")
            state.flags.push({ ...(args.criterion ? { criterion: String(args.criterion).toUpperCase() } : {}), kind: String(args.kind), reason: String(args.reason).slice(0, 800), at: Date.now() })
            setStatus(state, "needs_review", `${args.criterion ? `${String(args.criterion).toUpperCase()} ` : ""}flagged ${args.kind}: ${String(args.reason).slice(0, 160)}`)
            this.store.ledger(state.slug, { type: "flag", ...state.flags.at(-1) })
            this.notice(state.sessionID, `Goal needs review — ${state.reason}`, "warning", "question")
            this.persist(state)
            return "Flag recorded; the goal is stopped for the owner's review. End your turn."
          }),
      ),
      tool(
        "wait",
        "Pause the loop without spending tokens while an external process runs (a build, a deploy, CI). The host resumes the goal after the given seconds.",
        {
          properties: {
            seconds: { type: "number", minimum: 10, maximum: 3000 },
            reason: { type: "string", maxLength: 300 },
          },
          required: ["seconds", "reason"],
        },
        async (args, context) =>
          this.serial(() => {
            const state = guard(context, "wait")
            const seconds = Math.max(10, Math.min(3000, Number(args.seconds) || 60))
            state.wait = { until: Date.now() + seconds * 1000, reason: String(args.reason).slice(0, 300) }
            this.store.ledger(state.slug, { type: "wait", seconds, reason: state.wait.reason })
            this.persist(state)
            return `The goal will resume in ${seconds}s. End your turn now.`
          }),
      ),
      tool(
        "validate",
        "Validate a goal contract at .opencode/goals/<slug>/goal.yaml and report every problem. Use while writing a goal.",
        { properties: { slug: { type: "string", maxLength: 64 } }, required: ["slug"] },
        async (args) => {
          const read = this.store.readContract(String(args.slug))
          if (!read) return `No file at .opencode/goals/${args.slug}/goal.yaml`
          return `${formatIssues(read.issues)}${read.contract ? `\nlock ${read.lock.slice(0, 12)} · ${read.contract.criteria.length} criteria (${read.contract.criteria.filter((c) => isHostCheck(c.check)).length} host-checked), ${read.contract.invariants.length} invariants` : ""}`
        },
      ),
      tool(
        "start",
        `Start a validated goal in this session. Only after the owner approved launching it by choosing "${LAUNCH_LABEL}" in a question, or ran /goal start themselves.`,
        { properties: { slug: { type: "string", maxLength: 64 } }, required: ["slug"] },
        async (args, context) => {
          const approved = this.factsOf(context.sessionID).launchApprovedAt
          if (!approved || Date.now() - approved > this.options.launchApprovalMs)
            throw new Error(`Launching a goal needs the owner's explicit approval: ask with the question tool and an option labelled exactly "${LAUNCH_LABEL}", or ask them to run /goal start ${args.slug}.`)
          this.factsOf(context.sessionID).launchApprovedAt = undefined
          return this.startGoal(context.sessionID, String(args.slug), "tool")
        },
      ),
      tool(
        "verdict",
        "Verifier only: record your verdict for every criterion you were asked to judge.",
        {
          properties: {
            verdicts: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string" },
                  verdict: { type: "string", enum: ["proven", "not_proven", "contradicted"] },
                  reason: { type: "string", maxLength: 600 },
                  evidence: { type: "array", items: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, quote: { type: "string", maxLength: 2000 } }, required: ["path", "quote"] } },
                },
                required: ["id", "verdict"],
              },
            },
          },
          required: ["verdicts"],
        },
        async (args, context) => {
          if (String(context.agent) !== this.options.verifierAgent) throw new Error("goal_verdict is reserved for the goal verifier.")
          const verdicts: VerifierVerdict[] = (args.verdicts ?? []).map((v: any) => ({ id: String(v.id).toUpperCase(), verdict: v.verdict, ...(v.reason ? { reason: String(v.reason) } : {}), evidence: Array.isArray(v.evidence) ? v.evidence.map((e: any) => ({ path: String(e.path), quote: String(e.quote) })) : [] }))
          this.verifierInbox.set(String(context.sessionID), verdicts)
          return "Verdict recorded. You are done; end your turn."
        },
        { permission: "goal_verdict" },
      ),
    ]

    this.registrations.push(
      await this.ctx.tool.transform((editor: any) => {
        for (const t of tools) editor.add(t)
      }),
    )
  }
}

// ───────────────────────────── helpers

/** Reduce a child session's messages to a storable, human-readable transcript. */
function compactTranscript(messages: unknown[]): unknown[] {
  return messages.map((m) => {
    const message = m as { type?: string; role?: string; parts?: any[]; content?: any }
    const parts = message.parts ?? (Array.isArray(message.content) ? message.content : [])
    return {
      type: message.type,
      role: message.role,
      parts: parts.map((p) => ({
        type: p?.type,
        ...(p?.text !== undefined ? { text: String(p.text).slice(0, 4000) } : {}),
        ...(p?.tool !== undefined ? { tool: String(p.tool) } : {}),
        ...(p?.state !== undefined ? { state: String(p.state) } : {}),
      })),
    }
  })
}

/**
 * T016 fallback: when the verifier child ends without calling goal_verdict,
 * accept a fenced ```json block from its final assistant message as the
 * verdict. Same shape and normalization as the tool handler; recorded
 * distinctly as by:"verifier-fallback" so the audit trail never lies about
 * how the verdict arrived. Guards: only assistant messages (the prompt itself
 * demonstrates a fenced example), and at least one verdict id must belong to
 * the criteria this round asked about.
 */
function parseFallbackVerdicts(messages: unknown[], ids: Set<string>): VerifierVerdict[] {
  const valid = new Set(["proven", "not_proven", "contradicted"])
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { type?: string; role?: string; parts?: any[]; content?: any }
    if (message?.type !== "assistant" && message?.role !== "assistant") continue
    const parts = message.parts ?? (Array.isArray(message.content) ? message.content : [])
    const body = parts.map((p) => String(p?.text ?? "")).join("\n")
    if (body.includes("independent completion verifier")) continue // our own prompt's example fence
    const fence = [...body.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]!)
    for (const block of fence.reverse()) {
      try {
        const parsed = JSON.parse(block)
        const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.verdicts) ? parsed.verdicts : []
        const verdicts = list
          .filter((v: any) => v && typeof v.id === "string" && valid.has(v.verdict) && ids.has(String(v.id).toUpperCase()))
          .map((v: any) => ({
            id: String(v.id).toUpperCase(),
            verdict: v.verdict as VerifierVerdict["verdict"],
            ...(v.reason ? { reason: String(v.reason) } : {}),
            evidence: Array.isArray(v.evidence) ? v.evidence.filter((e: any) => e?.path && e?.quote).map((e: any) => ({ path: String(e.path), quote: String(e.quote) })) : [],
          }))
        if (verdicts.length) return verdicts
      } catch {
        // not json; try the next fence
      }
    }
  }
  return []
}

/** One-line summary of a ledger event for the dashboard's Timeline section. */
function timelineText(e: Record<string, unknown>): string {
  const str = (v: unknown, max = 70) => String(v ?? "").slice(0, max)
  switch (e.type) {
    case "start":
      return `run started via ${str(e.source, 20)}`
    case "admit":
      return `turn ${e.turn} admitted (${str(e.kind, 30)})`
    case "admit-failed":
      return `turn ${e.turn} admission failed: ${str(e.error)}`
    case "claim":
      return `completion claimed at turn ${e.turn}`
    case "verdict":
      return `verdict ${e.passed ? "passed" : "failed"}${Array.isArray(e.lines) && e.lines[0] ? ` — ${str(e.lines[0], 90)}` : ""}`
    case "complete":
      return "goal complete"
    case "paused":
      return `paused: ${str(e.reason, 60)}`
    case "resumed":
      return `resumed (${str(e.by, 40)})`
    case "waiting":
      return `waiting ${e.seconds ? `${e.seconds}s` : ""}: ${str(e.reason, 50)}`
    case "blocked":
      return `blocked: ${str(e.reason, 60)}`
    case "steer":
      return `owner steered: ${str(e.text, 60)}`
    default: {
      const extra = e.reason ?? e.error ?? e.note ?? e.text ?? ""
      return `${str(e.type, 24)}${extra ? `: ${str(extra, 60)}` : ""}`
    }
  }
}

/** Build a user message for the context hook from the host's own Message class. */
function makeUserMessage(messages: any[], text: string): any {
  const sample = messages.find((m) => m?.role === "user") ?? messages[0]
  const Ctor = sample?.constructor
  if (Ctor && typeof Ctor.user === "function") return Ctor.user(text)
  return { role: "user", content: [{ type: "text", text }] }
}

function targetPaths(tool: string, input: any): string[] {
  if (!input || typeof input !== "object") return []
  if ((tool === "edit" || tool === "write") && typeof input.path === "string") return [input.path]
  if (tool === "patch" && typeof input.patchText === "string") return [...input.patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]!.trim())
  return []
}

function globMatch(file: string, glob: string): boolean {
  let re = ""
  const g = glob.replace(/^\.\//, "")
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += g[i + 2] === "/" ? "(?:.*/)?" : ".*"
        i += g[i + 2] === "/" ? 2 : 1
      } else re += "[^/]*"
    } else if (c === "?") re += "[^/]"
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${re}$`).test(file)
}

export type { Status }
