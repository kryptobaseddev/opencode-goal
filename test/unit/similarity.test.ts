import { describe, expect, test } from "bun:test"
import { admissionNote, exactExists, similarity, similarGoals, tokenize } from "../../src/engine/similarity"

// T033 — the admission probe: existence (slug or verbatim title), ranked
// title/intent similarity above a threshold, archived goals still surfaced,
// and distinct intents produce no noise.

const candidates = [
  { slug: "fix-login-timeout", title: "Login no longer times out", status: "complete" },
  { slug: "checkout-latency", title: "Checkout p95 under 250ms", status: "running" },
  { slug: "login-timeout-v2", title: "Login no longer times out on slow networks", status: "superseded", archived: true },
  { slug: "drop-legacy-client", title: "Every call site uses the new API client", status: "complete" },
]

describe("admission similarity probe (T033)", () => {
  test("tokenize drops stopwords and short tokens", () => {
    expect(tokenize("Make the login work for our users on the go")).toEqual(["login", "work", "users"])
  })

  test("similarity is symmetric Jaccard and zero on disjoint sets", () => {
    expect(similarity("login timeout slow networks", "login timeout on slow networks")).toBeGreaterThan(0.6)
    expect(similarity("login timeout", "login timeout")).toBe(1)
    expect(similarity("login timeout", "checkout latency budget")).toBe(0)
  })

  test("exactExists matches by slug and by verbatim title, case-insensitively", () => {
    expect(exactExists("anything", "checkout-latency", candidates)?.slug).toBe("checkout-latency")
    expect(exactExists("login no longer times out", "new-slug", candidates)?.slug).toBe("fix-login-timeout")
    expect(exactExists("LOGIN NO LONGER TIMES OUT", "x", candidates)?.slug).toBe("fix-login-timeout")
    expect(exactExists("something else entirely", "nope", candidates)).toBeUndefined()
  })

  test("similarGoals ranks a re-skin of an attempted goal first, archived included", () => {
    const ranked = similarGoals("fix the login timing out on slow networks again", candidates)
    expect(ranked.length).toBeGreaterThan(0)
    expect(["fix-login-timeout", "login-timeout-v2"]).toContain(ranked[0]!.slug)
    const archived = ranked.find((m) => m.slug === "login-timeout-v2")
    expect(archived).toBeDefined()
    expect(archived!.matched).toContain("networks")
    // distinct intents stay out
    expect(ranked.some((m) => m.slug === "drop-legacy-client")).toBe(false)
  })

  test("admissionNote surfaces existence, ranked similarities and the owner options", () => {
    const note = admissionNote("login no longer times out", "fresh-slug", candidates)
    expect(note).toContain("[goal admission probe]")
    expect(note).toContain("EXISTS already: fix-login-timeout")
    expect(note).toContain("supersed")
    expect(note).toContain("start fresh")
    expect(admissionNote("something completely different", "brand-new", candidates)).toBeUndefined()
  })

  test("an archived goal is surfaced for existence even when nothing else matches", () => {
    const note = admissionNote("Login no longer times out on slow networks", "v3", candidates)
    expect(note).toContain("login-timeout-v2")
    expect(note).toContain("archived")
  })
})
