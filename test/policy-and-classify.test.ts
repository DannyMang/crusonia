import { describe, expect, test } from "bun:test";
import { classifyReplyText, replyText, type ReplyLabel } from "../src/services/classify.ts";
import { DEFAULT_AUTO_CONFIRM_TOOLS, isToolAllowed, parseToolAllowlist } from "../src/services/policy.ts";
import { latestIdle, researchMessage, sessionStatus } from "../src/services/workflows.ts";

describe("tool allowlist", () => {
  const defaults = parseToolAllowlist(undefined);

  test("defaults to crusonia.*, the Apify page reader and get-* readers, web_search, web_fetch", () => {
    expect(defaults).toEqual(DEFAULT_AUTO_CONFIRM_TOOLS.split(","));
    expect(parseToolAllowlist("  ")).toEqual(defaults);
  });

  test("prefix wildcards match only their namespace", () => {
    expect(isToolAllowed("crusonia.get_lead", defaults)).toBe(true);
    expect(isToolAllowed("apify.apify--rag-web-browser", defaults)).toBe(true);
    expect(isToolAllowed("apify.get-dataset-items", defaults)).toBe(true);
    expect(isToolAllowed("apify.get-actor-run", defaults)).toBe(true);
    expect(isToolAllowed("crusonia_evil.get_lead", defaults)).toBe(false);
    expect(isToolAllowed("crusonia", defaults)).toBe(false);
    expect(isToolAllowed("xcrusonia.get_lead", defaults)).toBe(false);
  });

  test("Apify Actor runs are not auto-allowed: they reach the owner as approvals", () => {
    for (const tool of ["apify.call-actor", "apify.apify--website-content-crawler", "apify.apify--google-search-scraper", "apify.abort-actor-run", "apify.search-actors"]) {
      expect(isToolAllowed(tool, defaults)).toBe(false);
    }
  });

  test("exact names match exactly", () => {
    expect(isToolAllowed("web_search", defaults)).toBe(true);
    expect(isToolAllowed("web_search_v2", defaults)).toBe(false);
    expect(isToolAllowed("Web_Search", defaults)).toBe(false);
    expect(isToolAllowed("send_email", defaults)).toBe(false);
    expect(isToolAllowed("", defaults)).toBe(false);
  });

  test("custom lists, whitespace, `none` and a bare `*`", () => {
    const list = parseToolAllowlist(" crusonia.list_leads , gmail.read* ,");
    expect(list).toEqual(["crusonia.list_leads", "gmail.read*"]);
    expect(isToolAllowed("crusonia.list_leads", list)).toBe(true);
    expect(isToolAllowed("crusonia.create_draft", list)).toBe(false);
    expect(isToolAllowed("gmail.read_thread", list)).toBe(true);
    expect(parseToolAllowlist("none")).toEqual([]);
    expect(isToolAllowed("crusonia.get_lead", parseToolAllowlist("NONE"))).toBe(false);
    expect(isToolAllowed("anything", ["*"])).toBe(true);
  });
});

describe("reply classification", () => {
  const cases: [string, string, ReplyLabel][] = [
    ["Re: quick question", "Please unsubscribe me from this list.", "unsubscribe"],
    ["Re: hi", "Remove me. Stop emailing me.", "unsubscribe"],
    ["Re: hi", "I'm not interested, please opt-out.", "unsubscribe"],
    ["Automatic reply: Crusonia", "I am out of the office until Monday with limited access to email.", "out_of_office"],
    ["Re: hi", "I'm on vacation, back on the 12th. Interested to chat then!", "out_of_office"],
    ["Re: hi", "Thanks, but we're not interested at the moment.", "not_interested"],
    ["Re: hi", "No thanks, we're all set with our current tool.", "not_interested"],
    ["Re: hi", "Not a fit for us right now.", "not_interested"],
    ["Re: hi", "Interested! Let's chat next week.", "interested"],
    ["Re: hi", "Sounds great, can we book a call? Here is my calendly.com/ada link.", "interested"],
    ["Re: hi", "Tell me more about pricing.", "interested"],
    ["Re: hi", "Who are you and how did you get my address?", "other"],
    ["Re: hi", "", "other"],
  ];
  for (const [subject, text, label] of cases) {
    test(`${label}: ${text || "(empty)"}`, () => expect(classifyReplyText({ subject, text })).toBe(label));
  }

  test("curly apostrophes are normalised", () => {
    expect(classifyReplyText({ text: "We’re all set, thanks" })).toBe("not_interested");
  });

  test("replyText prefers extracted_text and strips quoted history otherwise", () => {
    expect(replyText({ extracted_text: "Yes please", text: "Yes please\n> old" })).toBe("Yes please");
    const text = "Sounds good!\n\nOn Tue, Nov 4, 2026 at 9:00 AM Crusonia <hi@agentmail.to> wrote:\n> Are you interested? unsubscribe here";
    expect(replyText({ text })).toBe("Sounds good!");
    expect(classifyReplyText({ text: replyText({ text }) })).toBe("interested");
    expect(replyText({ html: "<p>Not interested</p><blockquote>x</blockquote>" })).toContain("Not interested");
  });
});

describe("naive workflow helpers", () => {
  test("latestIdle returns the last idle unless the session resumed after it", () => {
    const idle = { seq: 3, type: "session.idle", data: { stop_reason: "awaiting_approval" } };
    expect(latestIdle([{ seq: 1, type: "session.running", data: {} }, idle])).toBe(idle);
    expect(latestIdle([idle, { seq: 4, type: "session.running", data: {} }])).toBeUndefined();
    expect(latestIdle([{ seq: 5, type: "tool.started", data: {} }])).toBeUndefined();
  });

  test("session status: waiting is idle, a finished turn is done (so research can run again)", () => {
    expect(sessionStatus("idle", "awaiting_approval")).toBe("idle");
    expect(sessionStatus("idle", "awaiting_answer")).toBe("idle");
    expect(sessionStatus("idle", "budget_paused")).toBe("idle");
    expect(sessionStatus("idle", "end_turn")).toBe("done");
    expect(sessionStatus(undefined, "end_turn")).toBe("done");
    expect(sessionStatus("idle", "max_iterations")).toBe("error");
    expect(sessionStatus("failed", "error")).toBe("error");
    expect(sessionStatus("running", null)).toBe("running");
  });

  test("the research prompt carries only the lead id, never lead data", () => {
    const msg = researchMessage("lead_abc");
    expect(msg).toContain("lead_abc");
    expect(msg).toContain("untrusted");
    expect(msg).toContain("cannot send");
  });
});
