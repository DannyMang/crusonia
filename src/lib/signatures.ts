// Webhook signature verification, on the raw request body. Pure: callers pass `now` (unix seconds).
//
// AgentMail signs with Svix: HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${body}`, keyed by the
// base64-decoded part of `whsec_<base64>`, sent as space-separated `v1,<base64>` entries.
// Naive (vetta.sh) signs HMAC-SHA256 over `${timestamp}.${body}` keyed by the endpoint secret as given,
// sent as `Vetta-Signature: v1=<hex>` (comma-separated while a key rotates) plus `Vetta-Timestamp`.
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
