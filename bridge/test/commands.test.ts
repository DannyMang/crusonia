import { describe, expect, test } from "bun:test";
import { tapbackDecision } from "../src/commands.ts";

describe("tapbackDecision", () => {
  test("👍 likes, 👎 dislikes, with or without variation selectors and skin tones; everything else is nothing", () => {
    expect(tapbackDecision("👍")).toBe("like");
    expect(tapbackDecision("👍️")).toBe("like");
    expect(tapbackDecision("👍🏿")).toBe("like");
    expect(tapbackDecision("👎")).toBe("dislike");
    expect(tapbackDecision("👎🏻")).toBe("dislike");
    for (const e of ["❤️", "😂", "‼️", "❓", "", undefined, "👍👍"]) expect(tapbackDecision(e)).toBeUndefined();
  });
});
