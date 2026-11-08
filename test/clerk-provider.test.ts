// What the app takes from Clerk's Backend API. Accepting an invite trusts only verified_emails, so an unverified address
// must never land there.
import { describe, expect, test } from "bun:test";
import type { Env } from "../src/env.ts";
import { clerkUser, clerkUsers } from "../src/providers/clerk.ts";

const env = { CLERK_SECRET_KEY: "sk_test_fake" } as Env;
const raw = {
  id: "user_1",
  first_name: "Dana",
  last_name: "Ito",
  primary_email_address_id: "e1",
  image_url: "https://img.clerk.com/placeholder",
  has_image: false,
  email_addresses: [
    { id: "e1", email_address: "Dana@Acme.com", verification: { status: "verified" } },
    { id: "e2", email_address: "claimed@other.com", verification: { status: "unverified" } },
    { id: "e3", email_address: "none@other.com", verification: null },
  ],
};
const respond = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

describe("clerkUser", () => {
  test("only verified addresses count, lowercased; the primary one is kept as written for display", async () => {
    const u = await clerkUser(env, "user_1", respond(raw));
    expect(u).toMatchObject({ id: "user_1", email: "Dana@Acme.com", name: "Dana Ito", verified_emails: ["dana@acme.com"] });
  });

  test("Clerk's generated placeholder isn't an image; a photo the person chose is", async () => {
    expect((await clerkUser(env, "user_1", respond(raw)))!.image_url).toBeUndefined();
    expect((await clerkUser(env, "user_1", respond({ ...raw, has_image: true })))!.image_url).toBe(raw.image_url);
  });

  test("null when Clerk can't say: not configured, an error, or no answer", async () => {
    expect(await clerkUser({} as Env, "user_1", respond(raw))).toBeNull();
    expect(await clerkUser(env, "user_1", respond({}, 500))).toBeNull();
    expect(
      await clerkUser(env, "user_1", async () => {
        throw new Error("network");
      }),
    ).toBeNull();
  });
});

describe("clerkUsers", () => {
  test("batches by id, and whoever Clerk doesn't return is just missing", async () => {
    const urls: string[] = [];
    const found = await clerkUsers(env, ["user_1", "user_gone"], async (url) => {
      urls.push(url);
      return new Response(JSON.stringify([raw]));
    });
    expect([...found.keys()]).toEqual(["user_1"]);
    expect(new URL(urls[0]!).searchParams.getAll("user_id")).toEqual(["user_1", "user_gone"]);
  });

  test("a failure leaves the list empty rather than failing the page", async () => {
    expect((await clerkUsers(env, ["user_1"], respond({}, 500))).size).toBe(0);
  });
});
