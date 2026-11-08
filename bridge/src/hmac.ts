// Request signing between the Worker and the bridge, both directions, with one shared BRIDGE_SECRET.
//
//   X-Crusonia-Timestamp: <unix seconds>
//   X-Crusonia-Signature: v1=<hex HMAC-SHA256(BRIDGE_SECRET, "<timestamp>.<path>.<raw body>")>
//
// The path ("/notify" or "/webhooks/photon") is signed so a request captured in one direction cannot be replayed
// in the other. Requests older or newer than 5 minutes are refused; inside the window, receivers dedupe by event id.
// The Worker implements the same scheme in src/lib/signatures.ts (signBridge / verifyBridge); tests check both agree.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-crusonia-signature";
export const TIMESTAMP_HEADER = "x-crusonia-timestamp";
export const TOLERANCE_SECONDS = 5 * 60;

export type VerifyResult = { ok: true } | { ok: false; reason: string };

const nowSeconds = () => Math.floor(Date.now() / 1000);

function digest(secret: string, timestamp: string, path: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${path}.${body}`).digest("hex");
}

export function sign(secret: string, path: string, body: string, timestamp: number = nowSeconds()) {
  const ts = String(timestamp);
  return { timestamp: ts, signature: `v1=${digest(secret, ts, path, body)}` };
}

/** Headers for a signed JSON POST. */
export function signedHeaders(secret: string, path: string, body: string, timestamp?: number): Record<string, string> {
  const { timestamp: ts, signature } = sign(secret, path, body, timestamp);
  return { "content-type": "application/json", [TIMESTAMP_HEADER]: ts, [SIGNATURE_HEADER]: signature };
}

export function verify(input: {
  secret: string;
  path: string;
  body: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  now?: number;
  tolerance?: number;
}): VerifyResult {
  const { timestamp, signature } = input;
  if (!signature) return { ok: false, reason: "missing signature" };
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "missing or malformed timestamp" };
  const skew = Math.abs((input.now ?? nowSeconds()) - Number(timestamp));
  if (skew > (input.tolerance ?? TOLERANCE_SECONDS)) return { ok: false, reason: "timestamp outside the replay window" };
  const expected = Buffer.from(digest(input.secret, timestamp, input.path, input.body), "utf8");
  for (const entry of signature.split(",")) {
    const eq = entry.indexOf("=");
    if (eq < 0 || entry.slice(0, eq).trim() !== "v1") continue;
    const given = Buffer.from(entry.slice(eq + 1).trim().toLowerCase(), "utf8");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "no matching v1 signature" };
}

/** Remembers ids for a while so a replayed request inside the signature window is answered without acting twice. */
export class SeenIds {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  constructor(ttlMs: number = 2 * TOLERANCE_SECONDS * 1000) {
    this.ttlMs = ttlMs;
  }

  /** True the first time an id is claimed (until it expires or is released). */
  claim(id: string, now = Date.now()): boolean {
    for (const [key, expires] of this.seen) if (expires <= now) this.seen.delete(key);
    if (this.seen.has(id)) return false;
    this.seen.set(id, now + this.ttlMs);
    return true;
  }

  release(id: string): void {
    this.seen.delete(id);
  }
}
