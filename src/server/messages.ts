// T054 — actionable message content. Owner directive: "treat users like
// they need everything spelled out — actionable, option-based." Every
// engine notice carries the CAUSE plus CONCRETE CHOICES: what to run, what
// to approve, what to read. This module owns the wording of every notice
// the engine emits; app.ts renders nothing raw. The choices render inline
// (a plain toast stays actionable) and ride the rpc payload as structured
// choices the T050 dialogs wire to rpc.act.
export type Choice = {
  /** short imperative label for a dialog button, e.g. "Resume goal" */
  label: string
  /** the owner command or worker action to run, e.g. "/goal resume" */
  run: string
  /** rpc.act action for dialog wiring (optional; commands run as commands) */
  act?: string
  arg?: string
}

export type EngineMessage = {
  id: string
  text: string
  choices: Choice[]
  level: "info" | "success" | "warning" | "error"
  attention?: "done" | "question" | "error"
}

const msg = (id: string, level: EngineMessage["level"], text: string, choices: Choice[], attention?: EngineMessage["attention"]): EngineMessage => ({
  id,
  level,
  text,
  choices,
  ...(attention ? { attention } : {}),
})

/** Inline rendering: cause + explicit choices, one line, toast-safe. */
export function renderMessage(m: EngineMessage): string {
  return `${m.text} — ${m.choices.map((c) => c.run).join(" · ")}`
}

const resume = { label: "Resume goal", run: "/goal resume", act: "resume" }
const abort = { label: "Abort goal", run: "/goal abort", act: "abort" }
const status = { label: "Show status", run: "/goal status" }
const verify = { label: "Verify now", run: "/goal verify", act: "verify" }
const archive = { label: "Archive goal", run: "/goal archive", act: "archive" }

export const M = {
  goalStarted: (title: string) =>
    msg("goal.started", "success", `Goal started: ${title}. The contract is locked and rendered into every request.`, [status, resume]),
  goalSummary: (headline: string, caveats: number, status2: string) =>
    msg(`goal.summary.${status2}`, status2 === "complete" ? "success" : "warning", `goal.summary — ${headline}${caveats ? ` (${caveats} caveat${caveats > 1 ? "s" : ""}: provenance and unproven scope flagged in the dialog/evidence)` : ""}`, [
      { label: "Show status", run: "/goal status" },
      ...(status2 === "complete" ? [{ label: "Archive", run: "/goal archive", act: "archive" }, { label: "Start the next goal", run: "/goal new <what you want next>" }] : [{ label: "Resolve review", run: "/goal approve <C#>" }]),
    ]),
  amended: (generation: number, summary: string) =>
    msg("goal.amended", "success", `Goal amended (generation ${generation}): ${summary}. The contract re-locked; the next turn renders the new text.`, [verify, status]),
  pausedAdmissionError: (reason: string) =>
    msg("goal.paused.admission", "error", `Goal paused: the host could not send the next turn (${reason}).`, [resume, abort], "error"),
  awaitingAnswer: (question: string) =>
    msg("goal.awaiting-answer", "warning", `The goal is waiting for your answer: ${question}. The loop is idle until you reply.`, [
      { label: "Answer in the session", run: "reply in the session" },
      abort,
    ], "question"),
  pausedUserMessage: () =>
    msg("goal.paused.user-message", "info", `Goal paused because you sent a message — reply to steer the run, or resume to hand control back.`, [
      { label: "Resume goal", run: "/goal resume", act: "resume" },
      { label: "Keep steering", run: "keep replying in the session" },
      abort,
    ]),
  budgetStopped: (title: string) =>
    msg("goal.budget.stopped", "warning", `Goal stopped at its budget: ${title}. Raise the budget to continue, or wrap up.`, [
      { label: "Raise budget (amend)", run: "edit budget in goal.yaml, then /goal amend confirm" },
      abort,
      archive,
    ], "question"),
  blocked: (key: string, reason: string, needs?: string) =>
    msg("goal.blocked", "warning", `Goal blocked on ${key}: ${reason}${needs ? ` — it needs: ${needs}` : " — only the owner can resolve this"}.`, [
      { label: "Resolve, then resume", run: "/goal resume", act: "resume" },
      { label: "Flag the criterion (worker)", run: "goal_flag it as contradictory/impossible/unsafe" },
      abort,
    ], "question"),
  pausedInterrupted: (why: string) =>
    msg("goal.paused.interrupted", "error", `Goal paused — ${why}.`, [
      { label: "Resume goal", run: "/goal resume", act: "resume" },
      { label: "Keep steering", run: "keep replying in the session" },
      abort,
    ], "error"),
  pausedStalled: (why: string) =>
    msg("goal.paused.stalled", "info", `Goal paused — ${why}. /goal resume to continue.`, [resume, abort]),
  verifying: () => msg("goal.verifying", "info", `Verifying the goal: host checks run first, then the independent verifier child. Nothing to do until goal.summary lands.`, [{ label: "Show status", run: "/goal status" }]),
  complete: (title: string, caveats: number) =>
    msg("goal.complete", "success", `Goal complete: ${title}.${caveats ? ` ${caveats} caveat${caveats > 1 ? "s" : ""} in the summary (provenance/unproven scope).` : ""} Every required criterion was verified.`, [
      { label: "Archive goal", run: "/goal archive", act: "archive" },
      { label: "Start the next goal", run: "/goal new <what you want next>" },
    ], "done"),
  needsSignOff: (ids: string[]) =>
    msg("goal.needs-review.signoff", "warning", `Goal needs your sign-off on ${ids.join(", ")} — a human criterion only you can prove.`, [
      { label: "Approve", run: `/goal approve ${ids[0] ?? "<id>"}`, act: "approve", arg: ids[0] },
      { label: "Reject with a reason", run: `/goal reject ${ids[0] ?? "<id>"} <why>`, act: "reject" },
      status,
    ], "question"),
  needsReview: (reason: string) =>
    msg("goal.needs-review.rejected", "warning", `Goal needs review: ${reason}. A criterion failed verification repeatedly — decide it, change the work, or change the check.`, [
      { label: "Approve as-is (final)", run: "/goal approve <C#>", act: "approve" },
      { label: "Amend the check", run: "/goal amend confirm after editing goal.yaml" },
      abort,
    ], "question"),
  claimRejected: (firstLine: string) =>
    msg("goal.claim.rejected", "warning", `Claim rejected by the host — the verdict goes back to the agent: ${firstLine}`, [
      { label: "Agent: fix and re-claim", run: "read the HOST VERDICT lines, fix the work, then goal_claim again" },
      { label: "Owner: verify again", run: "/goal verify", act: "verify" },
    ]),
  attached: (title: string, status2: string) =>
    msg("goal.attached", "success", `Goal attached here: ${title} (${status2}). Every /goal command and palette action now acts on it from this session.`, [
      { label: "Resume goal", run: "/goal resume", act: "resume" },
      status,
    ]),
  archived: (title: string, slug: string) =>
    msg("goal.archived", "success", `Goal archived: ${title} (history intact under .opencode/goals-archive/${slug}/; the registry still answers "was this ever a goal here?").`, [
      { label: "Start the next goal", run: "/goal new <what you want next>" },
      { label: "List everything", run: "/goal list all" },
    ]),
  goalWait: (seconds: number, reason: string) =>
    msg("goal.waiting", "info", `Goal waiting ${seconds}s: ${reason}. The loop resumes itself; the tracer counts down.`, [
      { label: "Show status", run: "/goal status" },
      { label: "Owner: keep steering", run: "reply in the session (it pauses the wait)" },
    ]),
  amendProposed: (summary: string) =>
    msg("goal.amend.proposed", "warning", `Amendment proposed: ${summary}. Review the diff; confirming re-locks the contract with a new generation.`, [
      { label: "Confirm re-lock", run: "/goal amend confirm", act: "amend", arg: "confirm" },
      { label: "Keep editing goal.yaml", run: "edit goal.yaml further; the proposal waits" },
    ], "question"),
  supersedeAck: (slug: string, predecessor: string, status: string) =>
    msg("goal.supersede.ack", "warning", `Refused to start "${slug}": predecessor "${predecessor}" is still ${status}. Superseding a live predecessor forks the audit trail.`, [
      { label: "Acknowledge and supersede", run: `/goal start ${slug} acknowledge-supersede` },
      { label: "Abort predecessor first", run: "/goal abort", act: "abort" },
    ], "question"),
  pausedAfterVerdict: (firstLine: string) =>
    msg("goal.paused.verdict", "warning", `Verification did not pass while the goal is stopped — ${firstLine} Decide with the verdict in hand.`, [
      resume,
      { label: "Amend the check", run: "edit goal.yaml, then /goal amend confirm", act: "amend", arg: "confirm" },
      abort,
    ], "question"),
  completeDecision: (title: string, cleoPresent: boolean, unproven: number) =>
    msg("goal.complete.decision", "success", `Goal complete: ${title}.${unproven ? ` ${unproven} discussed-but-unproven item(s) are flagged in the summary.` : ""} What next?`, [
      archive,
      { label: "Start a new goal", run: "/goal new <what you want next>" },
      cleoPresent
        ? { label: "Decompose with CLEO", run: "cleo add --type task (this project is linked)" }
        : { label: "Install CLEO for tracking", run: "install CLEO — no .cleo workspace in this project yet" },
    ], "done"),
}

/** Every engine notice comes from M — the unit suite pins none is actionless. */
export const MESSAGE_BUILDERS = Object.keys(M)
