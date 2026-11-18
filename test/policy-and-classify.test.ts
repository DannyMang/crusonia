import { describe, expect, test } from "bun:test";
import { classifyReplyText, replyText, type ReplyLabel } from "../src/services/classify.ts";
import { researchMessage } from "../src/services/workflows.ts";

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
    ["Re: hi", "Can we talk next week?", "interested"],
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

describe("research message", () => {
  test("the research prompt carries only the lead id, never lead data", () => {
    const msg = researchMessage("lead_abc");
    expect(msg).toContain("lead_abc");
    expect(msg).toContain("untrusted");
    expect(msg).toContain("cannot send");
  });
});
