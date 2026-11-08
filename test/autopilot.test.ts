// Autopilot decisions (pure): what is due, what stops a run, which leads a find step hands on, when the Operator runs,
// and how the feed reads. The database behaviour is in test/autopilot.integration.test.ts.
import { describe, expect, test } from "bun:test";
import { feedItem, shortWhy, type FeedRow } from "../src/services/activity.ts";
import { autopilotAvailable, autopilotSteps, gateRun, hasFindStep, isDue, operatorDue, pickForResearch, type RunGate } from "../src/services/autopilot.ts";
import { everyHoursOf } from "../src/services/workflow-defs.ts";
import type { Env } from "../src/env.ts";

const env = (over: Partial<Env> = {}): Env => ({ PUBLIC_URL: "https://x.test", ...over });

const open: RunGate = {
  autopilot: true,
  paused: false,
  enabled: true,
  activeRun: false,
  spend: { usd: 0, cap_usd: 5, period: "week" },
  dailySpentMicro: 0,
  dailyCapMicro: 5_000_000,
  hasCredits: true,
};

describe("schedules", () => {
  test("due at next_run_at; one that never ran is due now", () => {
    const now = Date.parse("2026-11-08T10:00:00Z");
    expect(isDue(null, now)).toBe(true);
    expect(isDue("2026-11-08T09:59:00Z", now)).toBe(true);
    expect(isDue("2026-11-08T10:00:00Z", now)).toBe(true);
    expect(isDue("2026-11-08T10:00:01Z", now)).toBe(false);
  });

  test("the interval comes from every_hours, else the label, else a day", () => {
    expect(everyHoursOf({ every_hours: 6, label: "Every other Monday" })).toBe(6);
    expect(everyHoursOf({ label: "Every 4 hours" })).toBe(4);
    expect(everyHoursOf({ label: "every 2 days" })).toBe(48);
    expect(everyHoursOf({ label: "Every hour" })).toBe(1);
    expect(everyHoursOf({ label: "Every other Monday" })).toBe(336);
    expect(everyHoursOf({ label: "Every Monday" })).toBe(168);
    expect(everyHoursOf({ label: "Sometime" })).toBe(24);
    expect(everyHoursOf({})).toBe(24);
  });

  test("the instance list decides who may run; unset is nobody", () => {
    expect(autopilotAvailable(env(), "ws_a")).toBe(false);
    expect(autopilotAvailable(env({ AUTOPILOT_WORKSPACES: "" }), "ws_a")).toBe(false);
    expect(autopilotAvailable(env({ AUTOPILOT_WORKSPACES: "ws_b, ws_a" }), "ws_a")).toBe(true);
    expect(autopilotAvailable(env({ AUTOPILOT_WORKSPACES: "ws_b" }), "ws_a")).toBe(false);
    expect(autopilotAvailable(env({ AUTOPILOT_WORKSPACES: "*" }), "ws_a")).toBe(true);
  });

  test("the default workflow finds, researches, drafts and stops at the owner's approval before a send", () => {
    const steps = autopilotSteps(6);
    expect(hasFindStep(steps)).toBe(true);
    const order = steps.map((s) => s.kind);
    expect(order.indexOf("find")).toBeLessThan(order.indexOf("research"));
    expect(order.indexOf("approval")).toBeLessThan(order.indexOf("send"));
    const ids = new Set(steps.map((s) => s.id));
    for (const s of steps) for (const n of s.next) expect(ids.has(n)).toBe(true);
  });
});

describe("a run's gates", () => {
  test("all clear starts", () => expect(gateRun(open)).toBeNull());
  test("autopilot off", () => expect(gateRun({ ...open, autopilot: false })).toBe("autopilot_off"));
  test("the global pause", () => expect(gateRun({ ...open, paused: true })).toBe("paused"));
  test("a workflow that is turned off", () => expect(gateRun({ ...open, enabled: false })).toBe("disabled"));
  test("one active run per workflow", () => expect(gateRun({ ...open, activeRun: true })).toBe("active_run"));
  test("the weekly cap", () => {
    expect(gateRun({ ...open, spend: { usd: 5, cap_usd: 5, period: "week" } })).toBe("spend_cap_reached");
    expect(gateRun({ ...open, spend: { usd: 4.99, cap_usd: 5, period: "week" } })).toBeNull();
    expect(gateRun({ ...open, spend: { usd: 500, cap_usd: null, period: "week" } })).toBeNull();
  });
  test("a per-run cap limits one run, not the next one", () => expect(gateRun({ ...open, spend: { usd: 5, cap_usd: 1, period: "run" } })).toBeNull());
  test("the workspace's daily cap", () => expect(gateRun({ ...open, dailySpentMicro: 5_000_000 })).toBe("daily_cap_reached"));
  test("credits", () => expect(gateRun({ ...open, hasCredits: false })).toBe("no_credits"));
  test("autopilot off wins over everything", () => expect(gateRun({ ...open, autopilot: false, paused: true, activeRun: true, hasCredits: false })).toBe("autopilot_off"));
});

describe("what a find step hands to research", () => {
  const lead = (id: string, over: Record<string, unknown> = {}) => ({ id, find_status: "created", stage: "qualified", score: 50, qualified: true, ...over });

  test("best score first, up to the limit; the rest stay found", () => {
    const { research, found } = pickForResearch([lead("a", { score: 40 }), lead("b", { score: 90 }), lead("c", { score: 70 }), lead("d", { score: 10 })], 2);
    expect(research.map((l) => l.id)).toEqual(["b", "c"]);
    expect(found.map((l) => l.id).sort()).toEqual(["a", "d"]);
  });

  test("not researched: judged out, excluded, unsubscribed, or already known", () => {
    const { research, found } = pickForResearch(
      [
        lead("out", { qualified: false, stage: "disqualified" }),
        lead("gone", { excluded_at: "2026-11-01" }),
        lead("unsub", { stage: "unsubscribed" }),
        lead("known", { find_status: "known" }),
        lead("sent", { stage: "sent" }),
        lead("ok"),
      ],
      5,
    );
    expect(research.map((l) => l.id)).toEqual(["ok"]);
    expect(found.map((l) => l.id).sort()).toEqual(["out", "sent"]);
  });

  test("a known company already looked at isn't researched again; one nobody looked at is", () => {
    const { research, found } = pickForResearch([lead("seen", { find_status: "merged", stage: "qualified" }), lead("fresh", { find_status: "merged", stage: "no_consent", score: null, qualified: null })], 5);
    expect(research.map((l) => l.id)).toEqual(["fresh"]);
    expect(found.map((l) => l.id)).toEqual(["seen"]);
  });

  test("an unscored lead still goes, after the scored ones", () => {
    const { research } = pickForResearch([lead("none", { score: null, qualified: null, stage: "no_consent" }), lead("low", { score: 1 })], 5);
    expect(research.map((l) => l.id)).toEqual(["low", "none"]);
  });

  test("research: 0 finds without researching", () => expect(pickForResearch([lead("a")], 0).research).toEqual([]));
});

describe("when the Operator runs", () => {
  const now = Date.parse("2026-11-08T10:00:00Z");
  const base = { now, nextAt: "2026-11-08T12:00:00Z", lastStartedAt: "2026-11-08T08:00:00Z", changed: false, openSession: false, activeRun: false, cyclesToday: 1, maxPerDay: 8, minGapMs: 20 * 60_000 };

  test("by the clock", () => {
    expect(operatorDue(base)).toBe(false);
    expect(operatorDue({ ...base, nextAt: "2026-11-08T09:00:00Z" })).toBe(true);
    expect(operatorDue({ ...base, nextAt: null })).toBe(true);
  });
  test("sooner when something changed", () => expect(operatorDue({ ...base, changed: true })).toBe(true));
  test("never two at once", () => expect(operatorDue({ ...base, changed: true, openSession: true })).toBe(false));
  test("not while a run is going", () => expect(operatorDue({ ...base, changed: true, activeRun: true })).toBe(false));
  test("not too soon after the last cycle", () => expect(operatorDue({ ...base, changed: true, lastStartedAt: "2026-11-08T09:50:00Z" })).toBe(false));
  test("at most so many a day", () => expect(operatorDue({ ...base, changed: true, cyclesToday: 8 })).toBe(false));
});

describe("the feed", () => {
  const row = (kind: string, data: Record<string, unknown> = {}, over: Partial<FeedRow> = {}): FeedRow => ({
    id: "1",
    kind,
    data,
    created_at: "2026-11-08T10:00:00Z",
    lead_id: "lead_1",
    who: "Weave",
    score: null,
    why: null,
    ...over,
  });
  const text = (r: FeedRow) => feedItem(r)?.text;

  test("why-summaries become one short line without citations", () => {
    expect(shortWhy("Hiring a founding AE [1] after a seed round [2]. Fits the ICP.")).toBe("Hiring a founding AE after a seed round");
    expect(shortWhy(null)).toBeNull();
    expect(shortWhy("x".repeat(200))!.length).toBeLessThanOrEqual(70);
  });

  test("reads the way the owner would say it", () => {
    expect(text(row("lead_added", { via: "mcp" }, { why: "Hiring a founding AE [1]." }))).toBe("Found Weave · Hiring a founding AE");
    expect(text(row("lead_scored", { score: 90, qualified: true }, { who: "Nessie" }))).toBe("Researched Nessie · fit 90");
    expect(text(row("draft_created", { channel: "intro", task: true }))).toBe("Drafted intro for Weave");
    expect(text(row("draft_created", { channel: "linkedin", task: true }))).toBe("Drafted LinkedIn note for Weave");
    expect(text(row("draft_created", { channel: "email", approval_code: "B5S7" }))).toBe("Waiting for your 👍 on the email to Weave");
    expect(text(row("lead_needs_review", { question: "Which one?" }))).toBe("Waiting for your answer on Weave");
    expect(text(row("operator_cycle", { did: "Looked for 5 more like Weave", why: "You liked it" }))).toBe("Looked for 5 more like Weave");
  });

  test("the Operator's reason comes with its row, and what waits for the owner is marked", () => {
    expect(feedItem(row("operator_cycle", { did: "Did it", why: "You liked it" }))).toMatchObject({ text: "Did it", detail: "You liked it" });
    expect(feedItem(row("draft_created", { channel: "email" }))?.waiting).toBe(true);
    expect(feedItem(row("lead_scored", { score: 1 }))?.waiting).toBeUndefined();
  });

  test("says who did it", () => {
    expect(feedItem(row("lead_scored", { score: 1 }))?.by).toBe("agent");
    expect(feedItem(row("approval_approved", { via: "imessage" }))).toMatchObject({ by: "you", text: "You approved the email to Weave by iMessage" });
    expect(feedItem(row("note_added", { author: "user:u1", kind: "thumbs_up" }))).toMatchObject({ by: "you", text: "You liked Weave" });
    expect(feedItem(row("research_started", { actor: "autopilot:wfr_1" }))?.by).toBe("agent");
    expect(feedItem(row("research_started", { actor: "clerk:u1" }))?.by).toBe("you");
    expect(feedItem(row("draft_created", { via: "api", channel: "email", actor: "clerk:u1" }))?.by).toBe("you");
    expect(feedItem(row("draft_created", { via: "api", channel: "email", actor: "agent:operator" }))?.by).toBe("agent");
  });

  test("agent notes and imported rows are left out", () => {
    expect(feedItem(row("note_added", { author: "agent:ses_1" }))).toBeNull();
    expect(feedItem(row("lead_added", { via: "import" }))).toBeNull();
    expect(feedItem(row("something_else"))).toBeNull();
  });

  test("no row recommends or predicts anything", () => {
    const kinds = ["lead_added", "find_leads_started", "research_started", "lead_scored", "lead_needs_review", "draft_created", "company_summary_updated", "operate_started", "workflow_run_finished", "workflow_skipped", "email_sent", "email_received"];
    for (const kind of kinds) {
      const t = feedItem(row(kind, { via: "mcp", score: 5, reason: "active_run" }))?.text ?? "";
      expect(t).not.toMatch(/recommend|should|likely|probab|win|chance|%/i);
    }
  });
});
