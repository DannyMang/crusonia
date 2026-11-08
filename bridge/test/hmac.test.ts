import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { SeenIds, sign, signedHeaders, verify } from "../src/hmac.ts";

const secret = "s".repeat(64);
const body = JSON.stringify({ id: "approval:7KXM", type: "approval", text: "hi" });
const now = 1_800_000_000;

describe("HMAC signing", () => {
  test("a signature verifies for the same secret, path, body and a fresh timestamp", () => {
    const { timestamp, signature } = sign(secret, "/notify", body, now);
    expect(signature).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(verify({ secret, path: "/notify", body, timestamp, signature, now })).toEqual({ ok: true });
  });

  test("the signed string is <timestamp>.<path>.<body>", () => {
    const { signature } = sign(secret, "/notify", body, now);
    const expected = createHmac("sha256", secret).update(`${now}./notify.${body}`).digest("hex");
    expect(signature).toBe(`v1=${expected}`);
  });

  test("a changed body, path or secret fails", () => {
    const { timestamp, signature } = sign(secret, "/notify", body, now);
    expect(verify({ secret, path: "/notify", body: body.replace("hi", "ho"), timestamp, signature, now }).ok).toBe(false);
    // Cross-direction replay: a /notify signature is not valid for /webhooks/photon.
    expect(verify({ secret, path: "/webhooks/photon", body, timestamp, signature, now }).ok).toBe(false);
    expect(verify({ secret: "t".repeat(64), path: "/notify", body, timestamp, signature, now }).ok).toBe(false);
  });

  test("replays outside the 5 minute window are rejected, both directions of clock skew", () => {
    const { timestamp, signature } = sign(secret, "/notify", body, now);
    expect(verify({ secret, path: "/notify", body, timestamp, signature, now: now + 299 }).ok).toBe(true);
    expect(verify({ secret, path: "/notify", body, timestamp, signature, now: now + 301 })).toEqual({ ok: false, reason: "timestamp outside the replay window" });
    expect(verify({ secret, path: "/notify", body, timestamp, signature, now: now - 301 }).ok).toBe(false);
  });

  test("missing or malformed headers are rejected", () => {
    const { timestamp, signature } = sign(secret, "/notify", body, now);
    expect(verify({ secret, path: "/notify", body, timestamp, signature: undefined, now }).ok).toBe(false);
    expect(verify({ secret, path: "/notify", body, timestamp: undefined, signature, now }).ok).toBe(false);
    expect(verify({ secret, path: "/notify", body, timestamp: "12abc", signature, now }).ok).toBe(false);
    expect(verify({ secret, path: "/notify", body, timestamp, signature: "v0=" + signature.slice(3), now }).ok).toBe(false);
  });

  test("several comma-separated signatures (secret rotation): any v1 match passes", () => {
    const { timestamp, signature } = sign(secret, "/notify", body, now);
    expect(verify({ secret, path: "/notify", body, timestamp, signature: `v1=${"0".repeat(64)}, ${signature}`, now }).ok).toBe(true);
  });

  test("signedHeaders carries content type, timestamp and signature", () => {
    const h = signedHeaders(secret, "/notify", body, now);
    expect(h).toMatchObject({ "content-type": "application/json", "x-crusonia-timestamp": String(now) });
    expect(verify({ secret, path: "/notify", body, timestamp: h["x-crusonia-timestamp"], signature: h["x-crusonia-signature"], now }).ok).toBe(true);
  });
});

describe("SeenIds", () => {
  test("claims once, again after release or expiry", () => {
    const seen = new SeenIds(1_000);
    expect(seen.claim("a", 0)).toBe(true);
    expect(seen.claim("a", 500)).toBe(false);
    seen.release("a");
    expect(seen.claim("a", 600)).toBe(true);
    expect(seen.claim("a", 1_700)).toBe(true); // expired at 1600
  });
});
