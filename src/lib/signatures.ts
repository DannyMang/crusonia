// Webhook signature verification, on the raw request body. Pure: callers pass `now` (unix seconds).
//
// AgentMail signs with Svix: HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${body}`, keyed by the
// base64-decoded part of `whsec_<base64>`, sent as space-separated `v1,<base64>` entries.
// Naive (vetta.sh) signs HMAC-SHA256 over `${timestamp}.${body}` keyed by the endpoint secret as given,
// sent as `Vetta-Signature: v1=<hex>` (comma-separated while a key rotates) plus `Vetta-Timestamp`.
// Stripe signs HMAC-SHA256 over `${t}.${body}` keyed by the endpoint secret as given (whsec_...), sent as
// `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>...]` (several v1 while a secret rolls; v0 is ignored).
import { bytesEqual, fromBase64, hmacSha256, toBase64, toHex, utf8 } from "./crypto.ts";

export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export type VerifyResult = { ok: true } | { ok: false; reason: string };

function checkTimestamp(raw: string | undefined, now: number, tolerance: number): VerifyResult {
  if (!raw || !/^\d{1,12}$/.test(raw)) return { ok: false, reason: "missing or malformed timestamp" };
  const ts = Number(raw);
  if (Math.abs(now - ts) > tolerance) return { ok: false, reason: "timestamp outside the tolerance window" };
  return { ok: true };
}

function svixKey(secret: string): Uint8Array<ArrayBuffer> | undefined {
  return fromBase64(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret);
}

export async function signSvix(secret: string, id: string, timestamp: string | number, body: string): Promise<string> {
  const key = svixKey(secret);
  if (!key) throw new Error("Svix secret is not valid base64");
  return `v1,${toBase64(await hmacSha256(key, `${id}.${timestamp}.${body}`))}`;
}

export async function verifySvix(input: {
  secret: string;
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  body: string;
  now: number;
  tolerance?: number;
}): Promise<VerifyResult> {
  if (!input.id || !input.signature) return { ok: false, reason: "missing svix-id or svix-signature" };
  const time = checkTimestamp(input.timestamp, input.now, input.tolerance ?? SIGNATURE_TOLERANCE_SECONDS);
  if (!time.ok) return time;
  const key = svixKey(input.secret);
  if (!key) return { ok: false, reason: "webhook secret is not valid base64" };
  const expected = await hmacSha256(key, `${input.id}.${input.timestamp}.${input.body}`);
  for (const entry of input.signature.split(" ")) {
    const [version, sig] = entry.split(",", 2);
    if (version !== "v1" || !sig) continue;
    const given = fromBase64(sig);
    if (given && bytesEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "no matching v1 signature" };
}

export async function signNaive(secret: string, timestamp: string | number, body: string): Promise<string> {
  return `v1=${toHex(await hmacSha256(utf8(secret), `${timestamp}.${body}`))}`;
}

export async function verifyNaive(input: {
  secret: string;
  signature: string | undefined;
  timestamp: string | undefined;
  body: string;
  now: number;
  tolerance?: number;
}): Promise<VerifyResult> {
  if (!input.signature) return { ok: false, reason: "missing Vetta-Signature" };
  const time = checkTimestamp(input.timestamp, input.now, input.tolerance ?? SIGNATURE_TOLERANCE_SECONDS);
  if (!time.ok) return time;
  const expected = utf8(toHex(await hmacSha256(utf8(input.secret), `${input.timestamp}.${input.body}`)));
  for (const entry of input.signature.split(",")) {
    const eq = entry.indexOf("=");
    if (eq < 0) continue;
    const scheme = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1).trim().toLowerCase();
    if (scheme === "v1" && bytesEqual(utf8(value), expected)) return { ok: true };
  }
  return { ok: false, reason: "no matching v1 signature" };
}

// The iMessage bridge (bridge/src/hmac.ts implements the same scheme with node:crypto): HMAC-SHA256 keyed by
// BRIDGE_SECRET over `${timestamp}.${path}.${body}`, sent as `X-Crusonia-Signature: v1=<hex>` plus
// `X-Crusonia-Timestamp`. The path ("/notify" or "/webhooks/photon") is signed so a request cannot be replayed
// in the other direction.
export const BRIDGE_SIGNATURE_HEADER = "x-crusonia-signature";
export const BRIDGE_TIMESTAMP_HEADER = "x-crusonia-timestamp";

export async function signBridge(secret: string, timestamp: string | number, path: string, body: string): Promise<string> {
  return `v1=${toHex(await hmacSha256(utf8(secret), `${timestamp}.${path}.${body}`))}`;
}

export async function verifyBridge(input: {
  secret: string;
  path: string;
  signature: string | undefined;
  timestamp: string | undefined;
  body: string;
  now: number;
  tolerance?: number;
}): Promise<VerifyResult> {
  if (!input.signature) return { ok: false, reason: "missing X-Crusonia-Signature" };
  const time = checkTimestamp(input.timestamp, input.now, input.tolerance ?? SIGNATURE_TOLERANCE_SECONDS);
  if (!time.ok) return time;
  const expected = utf8(toHex(await hmacSha256(utf8(input.secret), `${input.timestamp}.${input.path}.${input.body}`)));
  for (const entry of input.signature.split(",")) {
    const eq = entry.indexOf("=");
    if (eq < 0 || entry.slice(0, eq).trim() !== "v1") continue;
    if (bytesEqual(utf8(entry.slice(eq + 1).trim().toLowerCase()), expected)) return { ok: true };
  }
  return { ok: false, reason: "no matching v1 signature" };
}

export async function signStripe(secret: string, timestamp: string | number, body: string): Promise<string> {
  return `t=${timestamp},v1=${toHex(await hmacSha256(utf8(secret), `${timestamp}.${body}`))}`;
}

export async function verifyStripe(input: {
  secret: string;
  header: string | undefined;
  body: string;
  now: number;
  tolerance?: number;
}): Promise<VerifyResult> {
  if (!input.secret) return { ok: false, reason: "no webhook secret configured" };
  if (!input.header) return { ok: false, reason: "missing Stripe-Signature" };
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of input.header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1" && value) signatures.push(value.toLowerCase());
  }
  if (!signatures.length) return { ok: false, reason: "no v1 signature" };
  const time = checkTimestamp(timestamp, input.now, input.tolerance ?? SIGNATURE_TOLERANCE_SECONDS);
  if (!time.ok) return time;
  const expected = utf8(toHex(await hmacSha256(utf8(input.secret), `${timestamp}.${input.body}`)));
  for (const sig of signatures) if (bytesEqual(utf8(sig), expected)) return { ok: true };
  return { ok: false, reason: "no matching v1 signature" };
}
