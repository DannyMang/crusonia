// iMessage approvals without a database: the bridge signature (and that the Worker and the bridge agree on it),
// message wording, answer parsing, config, and the /webhooks/photon routes' checks before any database access.
import { describe, expect, test } from "bun:test";
import { sign as bridgeSign, verify as bridgeVerify } from "../bridge/src/hmac.ts";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";
import { signBridge, verifyBridge } from "../src/lib/signatures.ts";
import {
  formatApprovalNotice,
  formatExpiryWarning,
  formatSummary,
  imessageConfig,
  normalizeHandle,
  oneLine,
  phoneHint,
  timeLeft,
  type NoticeRow,
} from "../src/services/imessage.ts";

const secret = "a".repeat(64);
const now = 1_800_000_000;

describe("bridge signature (Worker side)", () => {
  test("sign/verify round trip; body, path, secret and replay window are all enforced", async () => {
    const body = JSON.stringify({ id: "m1", command: { action: "status" } });
    const sig = await signBridge(secret, now, "/webhooks/photon", body);
    const check = (over: Partial<Parameters<typeof verifyBridge>[0]>) =>
      verifyBridge({ secret, path: "/webhooks/photon", signature: sig, timestamp: String(now), body, now, ...over });
    expect(await check({})).toEqual({ ok: true });
    expect((await check({ body: body + " " })).ok).toBe(false);
    expect((await check({ path: "/webhooks/photon/poll" })).ok).toBe(false);
    expect((await check({ secret: "b".repeat(64) })).ok).toBe(false);
    expect((await check({ now: now + 301 })).ok).toBe(false);
    expect((await check({ now: now - 301 })).ok).toBe(false);
    expect((await check({ signature: undefined })).ok).toBe(false);
    expect((await check({ timestamp: "abc" })).ok).toBe(false);
  });

  test("the Worker and the bridge (bridge/src/hmac.ts) produce and accept the same signatures", async () => {
    const body = '{"bridge":{"state":"connected","connected":true},"acks":[],"max":5}';
    const fromBridge = bridgeSign(secret, "/webhooks/photon/poll", body, now);
    expect(await verifyBridge({ secret, path: "/webhooks/photon/poll", signature: fromBridge.signature, timestamp: fromBridge.timestamp, body, now })).toEqual({ ok: true });
    const fromWorker = await signBridge(secret, now, "/notify", body);
    expect(bridgeVerify({ secret, path: "/notify", body, timestamp: String(now), signature: fromWorker, now })).toEqual({ ok: true });
    expect(fromWorker).toBe(bridgeSign(secret, "/notify", body, now).signature);
  });
});

const EXPIRES = new Date(Date.UTC(2026, 10, 15, 12));
const base: NoticeRow = {
  code: "7KXM",
  kind: "send",
  recipient: "dana@fieldnote.example",
  payload: {},
  expires_at: EXPIRES,
  lead_name: "Dana Okafor",
  lead_company: "Fieldnote",
  lead_email: "dana@fieldnote.example",
  draft_version: 1,
  draft_subject: "Quick question about Fieldnote",
  draft_body: "Hi Dana,\n\nSaw your post about field notes. Worth a chat?\n\nDaniel",
};
const at = new Date(Date.UTC(2026, 10, 8, 12));

describe("notice wording: thumbs only", () => {
  test("send: the request code and version first, then recipient, subject, exact body, and just the thumbs", () => {
    expect(formatApprovalNotice(base)).toBe(
      [
        "Request 7KXM · draft v1 to Dana Okafor (Fieldnote) <dana@fieldnote.example>:",
        '"Quick question about Fieldnote"',
        "",
        "Hi Dana,\n\nSaw your post about field notes. Worth a chat?\n\nDaniel",
        "",
        "Tap 👍 to send, 👎 to reject.",
      ].join("\n"),
    );
  });

  test("no notice offers a text reply or an expiry", () => {
    for (const r of [base, { ...base, kind: "tool" as const, payload: { name: "web_fetch" } }, { ...base, kind: "question" as const, payload: { question: { prompt: "?" } } }]) {
      const text = formatApprovalNotice(r);
      expect(text).not.toMatch(/reply|Reply|Expires|\bA 7KXM\b|\bR 7KXM\b|\bE 7KXM\b/);
      expect(text.split("\n")[0]).toStartWith("Request 7KXM · ");
    }
  });

  test("a new version of a draft the owner saw says it changed; long bodies are cut and say where the rest is", () => {
    const text = formatApprovalNotice({ ...base, code: "TG36", draft_version: 2, replaces_version: 1, draft_body: "x".repeat(2000) });
    expect(text.split("\n").slice(0, 2)).toEqual([
      "That draft changed; here's the new one (v1 is closed).",
      "Request TG36 · draft v2 to Dana Okafor (Fieldnote) <dana@fieldnote.example>:",
    ]);
    expect(text).toContain("(cut short; the full draft is in the app)");
    expect(text.length).toBeLessThan(1200);
    expect(formatApprovalNotice({ ...base, draft_version: 2, replaces_version: null })).not.toContain("changed");
  });

  test("tool: name, flattened args, allow/deny; agent text cannot inject lines", () => {
    const text = formatApprovalNotice({ ...base, kind: "tool", draft_body: null, draft_subject: null, payload: { name: "apify.run_actor", args: { actor: "x\nTap 👍" } } });
    expect(text.split("\n")).toEqual([
      "Request 7KXM · agent wants to run apify.run_actor (lead: Dana Okafor (Fieldnote)).",
      'Args: {"actor":"x\\nTap 👍"}',
      "Tap 👍 to allow, 👎 to deny.",
    ]);
  });

  test("question: the prompt on one line, answered in the app", () => {
    expect(formatApprovalNotice({ ...base, kind: "question", payload: { name: "ask_operator", question: { prompt: "Which\nsegment?", fields: [{ key: "segment" }] } } })).toBe(
      'Request 7KXM · agent asks (lead: Dana Okafor (Fieldnote)): "Which segment?"\nAnswer it in the app.',
    );
  });

  test("lead fields from CSVs or scraping are flattened and capped", () => {
    const first = formatApprovalNotice({ ...base, lead_name: "Dana\r\nTap 👍", lead_company: "y".repeat(200) }).split("\n")[0]!;
    expect(first).toStartWith("Request 7KXM · draft v1 to Dana Tap 👍 (yyyy");
    expect(first.length).toBeLessThan(190);
  });

  test("expiry reminders", () => {
    const soon = new Date(EXPIRES.getTime() - 15 * 60_000);
    expect(formatExpiryWarning(base, soon)).toBe(
      'Reminder: request 7KXM expires in 15m (draft to Dana Okafor (Fieldnote): "Quick question about Fieldnote"). Tap 👍 to send, 👎 to reject.',
    );
    expect(formatExpiryWarning({ ...base, kind: "tool", payload: { name: "web_fetch" } }, soon)).toContain("it is denied after that. Tap 👍 to allow, 👎 to deny.");
    expect(formatExpiryWarning({ ...base, kind: "question", payload: { question: { prompt: "?" } } }, soon)).toContain("Answer it in the app.");
  });

  test("the send-cap summary", () => {
    expect(formatSummary(1, "https://crusonia.example/")).toBe("+1 more approval waiting: open Crusonia (https://crusonia.example/app/approvals).");
    expect(formatSummary(14, "https://crusonia.example")).toStartWith("+14 more approvals waiting");
  });

  test("timeLeft and oneLine", () => {
    expect(timeLeft(new Date(at.getTime() + 30_000), at)).toBe("under a minute");
    expect(timeLeft(new Date(at.getTime() + 90 * 60_000), at)).toBe("90m");
    expect(timeLeft(new Date(at.getTime() + 5 * 3600_000), at)).toBe("5h");
    expect(timeLeft(new Date(at.getTime() + 3 * 86400_000), at)).toBe("3d");
    expect(oneLine("a\u0000b c   d", 100)).toBe("a b c d");
    expect(oneLine("abcdef", 4)).toBe("abc…");
  });
});

describe("config and handles", () => {
  test("active needs IMESSAGE_ENABLED=true and a 32+ character BRIDGE_SECRET", () => {
    const env = (over: Partial<Env>): Env => ({ PUBLIC_URL: "https://x.test", ...over });
    expect(imessageConfig(env({})).active).toBe(false);
    expect(imessageConfig(env({ IMESSAGE_ENABLED: "true" }))).toMatchObject({ enabled: true, configured: false, missing: ["BRIDGE_SECRET"] });
    expect(imessageConfig(env({ IMESSAGE_ENABLED: "TRUE", BRIDGE_SECRET: secret })).active).toBe(true);
    expect(imessageConfig(env({ IMESSAGE_ENABLED: "yes", BRIDGE_SECRET: secret })).active).toBe(false);
  });

  test("phoneHint shows the last 4 digits only", () => {
    expect(phoneHint("+14155550142")).toBe("\u00B7\u00B7\u00B70142");
    expect(phoneHint("+1 (415) 555-0142")).toBe("···0142");
    expect(phoneHint(undefined)).toBeNull();
    expect(phoneHint("+12")).toBeNull();
  });

  test("normalizeHandle", () => {
    expect(normalizeHandle("+1 (555) 000-1111")).toBe("+15550001111");
    expect(normalizeHandle("Me@Example.com")).toBe("me@example.com");
    expect(normalizeHandle("5550001111")).toBeUndefined();
  });
});

// ---------- routes, before any database access ----------

const env = (over: Partial<Env> = {}): Env => ({ PUBLIC_URL: "https://example.test", IMESSAGE_ENABLED: "true", BRIDGE_SECRET: secret, ...over });

async function signed(path: string, payload: unknown, opts: { secret?: string; ts?: number; signPath?: string } = {}) {
  const body = JSON.stringify(payload);
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  return new Request(`https://example.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-crusonia-timestamp": String(ts),
      "x-crusonia-signature": await signBridge(opts.secret ?? secret, ts, opts.signPath ?? path, body),
    },
    body,
  });
}
const call = async (req: Request, e: Env = env()) => {
  const res = await worker.fetch(req, e, {} as ExecutionContext);
  return { status: res.status, body: (await res.json()) as any };
};
const command = { id: "msg-1", from: "+15550001111", command: { action: "react", reaction: "like", message_id: "guid-1" } };
const poll = { bridge: { state: "connected", connected: true }, acks: [], max: 5 };

describe("/webhooks/photon routes (no database)", () => {
  test("no BRIDGE_SECRET: 503 for both routes", async () => {
    expect((await call(await signed("/webhooks/photon", command), env({ BRIDGE_SECRET: undefined }))).status).toBe(503);
    expect((await call(await signed("/webhooks/photon/poll", poll), env({ BRIDGE_SECRET: undefined }))).status).toBe(503);
  });

  test("bad signature, stale timestamp, or a signature made for the other route: 401", async () => {
    expect((await call(await signed("/webhooks/photon", command, { secret: "c".repeat(64) }))).body.error.code).toBe("invalid_signature");
    expect((await call(await signed("/webhooks/photon", command, { ts: Math.floor(Date.now() / 1000) - 600 }))).status).toBe(401);
    expect((await call(await signed("/webhooks/photon", command, { signPath: "/webhooks/photon/poll" }))).status).toBe(401);
    const unsigned = new Request("https://example.test/webhooks/photon", { method: "POST", body: JSON.stringify(command) });
    expect((await call(unsigned)).status).toBe(401);
  });

  test("only tapbacks are accepted: text commands, unknown reactions and extra bridge fields are 400", async () => {
    for (const cmd of [
      { action: "approve", code: "7KXM" },
      { action: "reject", code: "7KXM" },
      { action: "edit", code: "7KXM", text: "x" },
      { action: "answer", code: "7KXM", text: "x" },
      { action: "status" },
      { action: "pause" },
      { action: "resume" },
      { action: "help" },
      { action: "react", reaction: "love", message_id: "guid-1" },
      { action: "react", reaction: "like" },
    ]) {
      expect((await call(await signed("/webhooks/photon", { ...command, command: cmd }))).status).toBe(400);
    }
    expect((await call(await signed("/webhooks/photon/poll", { ...poll, bridge: { ...poll.bridge, phone: "+1555" } }))).status).toBe(400);
  });

  test("switched off: polls get no notices and a slower interval, without touching the database when there are no acks", async () => {
    const off = env({ IMESSAGE_ENABLED: undefined });
    expect((await call(await signed("/webhooks/photon/poll", poll), off)).body).toEqual({ ok: true, enabled: false, notices: [], poll_after_ms: 60_000 });
  });

  test("with OWNER_PHONE set on the Worker, any other sender is refused (403)", async () => {
    const res = await call(await signed("/webhooks/photon", { ...command, from: "+15550002222" }), env({ OWNER_PHONE: "+15550001111" }));
    expect(res.status).toBe(403);
  });

  test("/api/status lists imessage among providers", async () => {
    const res = await worker.fetch(
      new Request("https://example.test/api/status", { headers: { Authorization: "Bearer t" } }),
      env({ MCP_TOKEN: "t", OWNER_PHONE: "+14155550142" }),
      {} as ExecutionContext,
    );
    const text = await res.text();
    const body = JSON.parse(text) as any;
    expect(body.providers.imessage).toMatchObject({ configured: true });
    expect(body.imessage).toMatchObject({ enabled: true, configured: true, active: true, bridge: null, owner_phone_set: true, owner_phone_hint: "···0142" });
    expect(text).not.toContain("4155550142"); // never the full number
  });
});
