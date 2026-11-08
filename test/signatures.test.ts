import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { signNaive, signSvix, verifyNaive, verifySvix } from "../src/lib/signatures.ts";

// Svix's published example (docs.svix.com, "Verifying payloads"): computed by Svix, not by us.
const SVIX = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: "1614265330",
  body: '{"test": 2432232314}',
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};

describe("verifySvix (AgentMail)", () => {
  const base = { secret: SVIX.secret, id: SVIX.id, timestamp: SVIX.timestamp, signature: SVIX.signature, body: SVIX.body, now: 1614265330 };

  test("accepts Svix's published vector", async () => {
    expect(await verifySvix(base)).toEqual({ ok: true });
  });

  test("signSvix reproduces the published signature and matches node:crypto", async () => {
    expect(await signSvix(SVIX.secret, SVIX.id, SVIX.timestamp, SVIX.body)).toBe(SVIX.signature);
    const key = Buffer.from(SVIX.secret.slice(6), "base64");
    const node = createHmac("sha256", key).update(`${SVIX.id}.${SVIX.timestamp}.${SVIX.body}`).digest("base64");
    expect(SVIX.signature).toBe(`v1,${node}`);
  });

  test("accepts when one of several space-separated signatures matches, ignoring other versions", async () => {
    const signature = `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= v2,whatever ${SVIX.signature}`;
    expect(await verifySvix({ ...base, signature })).toEqual({ ok: true });
  });

  test("rejects a tampered body, id or timestamp", async () => {
    expect((await verifySvix({ ...base, body: '{"test": 2432232315}' })).ok).toBe(false);
    expect((await verifySvix({ ...base, id: "msg_other" })).ok).toBe(false);
    expect((await verifySvix({ ...base, timestamp: "1614265331", now: 1614265331 })).ok).toBe(false);
  });

  test("rejects timestamps outside 5 minutes, in either direction", async () => {
    expect(await verifySvix({ ...base, now: 1614265330 + 301 })).toEqual({ ok: false, reason: "timestamp outside the tolerance window" });
    expect((await verifySvix({ ...base, now: 1614265330 - 301 })).ok).toBe(false);
    expect((await verifySvix({ ...base, now: 1614265330 + 299 })).ok).toBe(true);
  });

  test("rejects missing headers, wrong secret and malformed input", async () => {
    expect((await verifySvix({ ...base, signature: undefined })).ok).toBe(false);
    expect((await verifySvix({ ...base, id: undefined })).ok).toBe(false);
    expect((await verifySvix({ ...base, timestamp: "abc" })).ok).toBe(false);
    expect((await verifySvix({ ...base, secret: "whsec_c2VjcmV0" })).ok).toBe(false);
    expect((await verifySvix({ ...base, signature: "v1,not base64!!" })).ok).toBe(false);
    expect((await verifySvix({ ...base, secret: "whsec_%%%" })).ok).toBe(false);
  });
});

// Computed with: openssl dgst -sha256 -hmac whsec_naive_test_secret -hex <file holding "<ts>.<body>">
const NAIVE = {
  secret: "whsec_naive_test_secret",
  timestamp: "1762560000",
  body: '{"id":"evt_01TEST","type":"session.idle","created_at":"2026-11-08T00:00:00Z","data":{"session_id":"ses_01TEST","stop_reason":"awaiting_approval"}}',
  hex: "bf96b36ee4efbfc0ce3a3c03912bbc30a9daa2d2a05a6446b005196d3567dc21",
};

describe("verifyNaive (Vetta-Signature)", () => {
  const base = { secret: NAIVE.secret, signature: `v1=${NAIVE.hex}`, timestamp: NAIVE.timestamp, body: NAIVE.body, now: 1762560000 };

  test("accepts the openssl-computed vector", async () => {
    expect(await verifyNaive(base)).toEqual({ ok: true });
  });

  test("signNaive matches openssl and node:crypto", async () => {
    expect(await signNaive(NAIVE.secret, NAIVE.timestamp, NAIVE.body)).toBe(`v1=${NAIVE.hex}`);
    const node = createHmac("sha256", NAIVE.secret).update(`${NAIVE.timestamp}.${NAIVE.body}`).digest("hex");
    expect(node).toBe(NAIVE.hex);
  });

  test("accepts during key rotation (comma-separated) and is case-insensitive on hex", async () => {
    expect((await verifyNaive({ ...base, signature: `v1=${"0".repeat(64)},v1=${NAIVE.hex}` })).ok).toBe(true);
    expect((await verifyNaive({ ...base, signature: `v1=${NAIVE.hex.toUpperCase()}` })).ok).toBe(true);
    expect((await verifyNaive({ ...base, signature: `v1=${"0".repeat(64)}, v1=${NAIVE.hex}` })).ok).toBe(true);
  });

  test("rejects tampering, the wrong secret and other schemes", async () => {
    expect((await verifyNaive({ ...base, body: NAIVE.body.replace("awaiting_approval", "end_turn") })).ok).toBe(false);
    expect((await verifyNaive({ ...base, secret: "whsec_other" })).ok).toBe(false);
    expect((await verifyNaive({ ...base, signature: `v0=${NAIVE.hex}` })).ok).toBe(false);
    expect((await verifyNaive({ ...base, signature: NAIVE.hex })).ok).toBe(false);
  });

  test("rejects stale or future timestamps and missing headers", async () => {
    expect((await verifyNaive({ ...base, now: 1762560000 + 301 })).ok).toBe(false);
    expect((await verifyNaive({ ...base, now: 1762560000 - 301 })).ok).toBe(false);
    expect((await verifyNaive({ ...base, signature: undefined })).ok).toBe(false);
    expect((await verifyNaive({ ...base, timestamp: undefined })).ok).toBe(false);
  });
});
