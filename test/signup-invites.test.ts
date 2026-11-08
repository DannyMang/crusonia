import { describe, expect, test } from "bun:test";
import type { Env } from "../src/env.ts";
import { isInvitedUser, signupsOpen } from "../src/services/workspaces.ts";

describe("closed sign-ups with approved users", () => {
  const env = { SIGNUPS_OPEN: "false", SIGNUP_ALLOWED_USER_IDS: " user_a , user_b " } as unknown as Env;
  test("sign-ups are closed", () => expect(signupsOpen(env)).toBe(false));
  test("approved users may create a workspace", () => {
    expect(isInvitedUser(env, "user_a")).toBe(true);
    expect(isInvitedUser(env, "user_b")).toBe(true);
  });
  test("everyone else stays out", () => {
    expect(isInvitedUser(env, "user_c")).toBe(false);
    expect(isInvitedUser(env, "")).toBe(false);
    expect(isInvitedUser({ SIGNUPS_OPEN: "false" } as unknown as Env, "user_a")).toBe(false);
  });
});
