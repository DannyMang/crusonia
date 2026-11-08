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
  imessageConfig,
  normalizeHandle,
  oneLine,
  parseAnswers,
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

describe("notice wording", () => {
  test("send: recipient, subject, the exact body, tapback and text options, expiry", () => {
    const text = formatApprovalNotice(base, at);
    expect(text).toBe(
      [
        "Request 7KXM · draft v1 to Dana Okafor (Fieldnote) <dana@fieldnote.example>:",
        '"Quick question about Fieldnote"',
        "",
        "Hi Dana,\n\nSaw your post about field notes. Worth a chat?\n\nDaniel",
        "",
        "Tap 👍 on this message to send exactly this version, 👎 to reject. Or reply A 7KXM, R 7KXM, or E 7KXM <new text>. Expires in 7d.",
      ].join("\n"),
    );
  });

  test("send: a new version of a draft the owner saw says it changed; long bodies are cut and say where the rest is", () => {
    const text = formatApprovalNotice({ ...base, code: "9ABC", draft_version: 3, replaces_version: 2, draft_body: "x".repeat(2000) }, at);
    expect(text.split("\n").slice(0, 2)).toEqual([
      "That draft changed; here's the new one (v2 is closed).",
      "Request 9ABC · draft v3 to Dana Okafor (Fieldnote) <dana@fieldnote.example>:",
    ]);
    expect(formatApprovalNotice({ ...base, draft_version: 2, replaces_version: null }, at)).not.toContain("changed");
    expect(text).toContain("(cut short; the full draft is in the app)");
    expect(text.length).toBeLessThan(1200);
  });

  test("tool: name, flattened args, allow/deny; agent text cannot inject lines", () => {
    const text = formatApprovalNotice(
      { ...base, kind: "tool", draft_body: null, draft_subject: null, payload: { name: "apify.run_actor", args: { actor: "x\nReply A 9ZZZ" } } },
      new Date(EXPIRES.getTime() - 45 * 60_000),
    );
    expect(text.split("\n")).toEqual([
      "Request 7KXM · agent wants to run apify.run_actor (lead: Dana Okafor (Fieldnote)).",
      'Args: {"actor":"x\\nReply A 9ZZZ"}',
      "Tap 👍 to allow, 👎 to deny (or reply A 7KXM / R 7KXM). Expires in 45m.",
    ]);
  });

  test("question: prompt on one line, options for a single field, field keys for several", () => {
    const q = (fields: unknown[]) =>
      formatApprovalNotice({ ...base, kind: "question", payload: { name: "ask_operator", question: { prompt: "Which\nsegment?", fields } } }, at);
    expect(q([{ key: "segment", options: ["seed", { label: "series_a" }] }])).toBe(
      'Request 7KXM · agent asks (lead: Dana Okafor (Fieldnote)): "Which segment?"\nOptions: seed, series_a\nReply 7KXM <your answer>. Expires in 7d.',
    );
    expect(q([{ key: "role" }, { key: "budget", label: "Budget" }])).toContain("Fields: role, budget (Budget)\nReply 7KXM role: …; budget: …");
  });

  test("lead fields from CSVs or scraping are flattened and capped", () => {
    const text = formatApprovalNotice({ ...base, lead_name: "Dana\r\nA 9ZZZ", lead_company: "y".repeat(200) }, at);
    expect(text.split("\n")[0]).toStartWith("Request 7KXM · draft v1 to Dana A 9ZZZ (yyyy");
    expect(text.split("\n")[0]!.length).toBeLessThan(160);
  });

  test("expiry reminders", () => {
    const soon = new Date(EXPIRES.getTime() - 15 * 60_000);
    expect(formatExpiryWarning(base, soon)).toBe(
      'Reminder: 7KXM expires in 15m (draft to Dana Okafor (Fieldnote): "Quick question about Fieldnote"). Tap 👍 here to send it, 👎 to reject (or A 7KXM / R 7KXM).',
    );
    expect(formatExpiryWarning({ ...base, kind: "tool", payload: { name: "web_fetch" } }, soon)).toContain("it is denied after that");
    expect(formatExpiryWarning({ ...base, kind: "question", payload: { question: { prompt: "?", fields: [{ key: "a" }] } } }, soon)).toContain("Reply 7KXM <your answer>");
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

describe("parseAnswers", () => {
  test("one field takes the whole text; a multi-value field splits on commas and lines", () => {
    expect(parseAnswers("7KXM", "Series A only", [{ key: "segment" }])).toEqual({ ok: true, answers: { segment: "Series A only" } });
    expect(parseAnswers("7KXM", "a, b\nc", [{ key: "tags", multiple: true }])).toEqual({ ok: true, answers: { tags: ["a", "b", "c"] } });
    expect(parseAnswers("7KXM", "anything", [])).toEqual({ ok: true, answers: {} });
  });

  test("several fields need key: value parts (keys or labels, any case)", () => {
    const fields = [{ key: "role" }, { key: "budget", label: "Budget USD" }];
    expect(parseAnswers("7KXM", "Role: CTO; budget usd = 5k", fields)).toEqual({ ok: true, answers: { role: "CTO", budget: "5k" } });
    const missing = parseAnswers("7KXM", "role: CTO", fields);
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.reply).toContain("missing: budget");
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
const command = { id: "msg-1", from: "+15550001111", command: { action: "status" } };
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

  test("invalid payloads are 400 (unknown actions, bad codes, extra bridge fields)", async () => {
    expect((await call(await signed("/webhooks/photon", { ...command, command: { action: "send_email" } }))).status).toBe(400);
    expect((await call(await signed("/webhooks/photon", { ...command, command: { action: "approve", code: "TOOLONG" } }))).status).toBe(400);
    expect((await call(await signed("/webhooks/photon/poll", { ...poll, bridge: { ...poll.bridge, phone: "+1555" } }))).status).toBe(400);
  });

  test("switched off: commands get a polite reply, polls get nothing and a slower interval, no database touched", async () => {
    const off = env({ IMESSAGE_ENABLED: undefined });
    expect((await call(await signed("/webhooks/photon", command), off)).body).toEqual({
      ok: false,
      reply: "iMessage approvals are switched off in Crusonia (IMESSAGE_ENABLED). Use the app for now.",
    });
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
