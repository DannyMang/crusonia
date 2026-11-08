import { describe, expect, test } from "bun:test";
import { HELP_TEXT, parseCommand, tapbackDecision } from "../src/commands.ts";

const cmd = (text: string) => {
  const r = parseCommand(text);
  if (!r.ok) throw new Error(`expected a command for ${JSON.stringify(text)}, got reply: ${r.reply}`);
  return r.command;
};
const reply = (text: string) => {
  const r = parseCommand(text);
  if (r.ok) throw new Error(`expected a reply for ${JSON.stringify(text)}, got ${JSON.stringify(r.command)}`);
  return r.reply;
};

describe("parseCommand", () => {
  test("approve: A <code>, any case, trailing punctuation, uppercased code", () => {
    expect(cmd("A 7KXM")).toEqual({ action: "approve", code: "7KXM" });
    expect(cmd("a 7kxm")).toEqual({ action: "approve", code: "7KXM" });
    expect(cmd("  approve 7KXM. ")).toEqual({ action: "approve", code: "7KXM" });
    expect(cmd("A\u00A07KXM")).toEqual({ action: "approve", code: "7KXM" }); // iOS non-breaking space
  });

  test("approve refuses extra words: sending email needs the bare code", () => {
    expect(reply("A 7KXM and also the other one")).toBe("To approve, send exactly: A 7KXM");
  });

  test("reject: R <code> with an optional reason", () => {
    expect(cmd("R 7KXM")).toEqual({ action: "reject", code: "7KXM" });
    expect(cmd("reject 7kxm too pushy, rewrite")).toEqual({ action: "reject", code: "7KXM", reason: "too pushy, rewrite" });
  });

  test("edit: E <code> <text> keeps the text as typed, newlines included", () => {
    expect(cmd("E 7KXM Hi Dana,\n\nShort version: want a demo?")).toEqual({
      action: "edit",
      code: "7KXM",
      text: "Hi Dana,\n\nShort version: want a demo?",
    });
    expect(reply("E 7KXM")).toBe("Add the new email text: E 7KXM <new text>");
  });

  test("answer: <code> <text>, with optional colon", () => {
    expect(cmd("9PQR Series A teams only")).toEqual({ action: "answer", code: "9PQR", text: "Series A teams only" });
    expect(cmd("9pqr: yes")).toEqual({ action: "answer", code: "9PQR", text: "yes" });
  });

  test("a bare answer only matches the real code alphabet (no 0/1/I/L/O)", () => {
    expect(reply("I'm on it")).toContain("help");
    expect(reply("LOL ok")).toContain("help");
    expect(reply("1000 thanks")).toContain("help");
  });

  test("status, pause, resume, help", () => {
    expect(cmd("status")).toEqual({ action: "status" });
    expect(cmd("Status?")).toEqual({ action: "status" });
    expect(cmd("PAUSE")).toEqual({ action: "pause" });
    expect(cmd("resume")).toEqual({ action: "resume" });
    expect(cmd("help")).toEqual({ action: "help" });
    expect(cmd("?")).toEqual({ action: "help" });
    expect(HELP_TEXT).toContain("A <code>");
  });

  test("ambiguous messages never become decisions", () => {
    for (const text of ["yes", "ok", "approve", "go ahead", "👍", "A", "approved!"]) {
      expect(parseCommand(text).ok).toBe(false);
    }
    expect(reply("approve")).toContain("Add the code");
    // A sentence whose first word happens to fit the code alphabet is at most an *answer* to that exact code;
    // Crusonia replies "not found" unless an open question has it. It can never approve a send or a tool.
    expect(cmd("sure, send it")).toEqual({ action: "answer", code: "SURE", text: "send it" });
  });

  test("empty and oversized messages", () => {
    expect(reply("   ")).toContain("help");
    expect(reply(`E 7KXM ${"x".repeat(10_100)}`)).toContain("too long");
  });
});

describe("tapbackDecision", () => {
  test("👍 likes, 👎 dislikes, with or without variation selectors and skin tones; everything else is nothing", () => {
    expect(tapbackDecision("👍")).toBe("like");
    expect(tapbackDecision("👍\uFE0F")).toBe("like");
    expect(tapbackDecision("👍🏿")).toBe("like");
    expect(tapbackDecision("👎")).toBe("dislike");
    expect(tapbackDecision("👎🏻")).toBe("dislike");
    for (const e of ["❤️", "😂", "‼️", "❓", "", undefined, "👍👍"]) expect(tapbackDecision(e)).toBeUndefined();
  });
});
