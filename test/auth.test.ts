// /api auth: MCP_TOKEN bypass and networkless Clerk session verification (CLERK_JWT_KEY), using a real
// RS256 key pair generated here, so no Clerk account or network is needed.
import { beforeAll, describe, expect, test } from "bun:test";
import { authenticate } from "../src/api/auth.ts";
import type { Env } from "../src/env.ts";
import { ApiError } from "../src/lib/errors.ts";

const b64url = (data: Uint8Array | string) =>
  Buffer.from(typeof data === "string" ? new TextEncoder().encode(data) : data).toString("base64url");

let keys: CryptoKeyPair;
let pem: string;
let otherKeys: CryptoKeyPair;

async function sign(payload: Record<string, unknown>, key = keys.privateKey) {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "ins_test" }));
  const body = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

const nowS = () => Math.floor(Date.now() / 1000);
const claims = (over: Record<string, unknown> = {}) => ({
  sub: "user_owner",
  sid: "sess_1",
  azp: "https://app.crusonia.dev",
  iss: "https://clerk.crusonia.dev",
  iat: nowS() - 10,
  nbf: nowS() - 10,
  exp: nowS() + 60,
  ...over,
});

beforeAll(async () => {
  const params = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  keys = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  otherKeys = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  const spki = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64");
  pem = `-----BEGIN PUBLIC KEY-----\n${spki.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----`;
});

const env = (over: Partial<Env> = {}): Env => ({
  PUBLIC_URL: "https://example.test",
  MCP_TOKEN: "owner-token-123",
  CLERK_JWT_KEY: pem,
  CLERK_AUTHORIZED_PARTIES: "https://app.crusonia.dev",
  ...over,
});

async function failure(promise: Promise<unknown>) {
  const err = await promise.then(() => undefined, (e) => e);
  expect(err).toBeInstanceOf(ApiError);
  return `${(err as ApiError).status} ${(err as ApiError).code}`;
}

describe("authenticate", () => {
  test("missing or non-Bearer Authorization is a 401", async () => {
    expect(await failure(authenticate(env(), undefined))).toBe("401 unauthorized");
    expect(await failure(authenticate(env(), "Basic abc"))).toBe("401 unauthorized");
    expect(await failure(authenticate(env(), "Bearer"))).toBe("401 unauthorized");
  });

  test("MCP_TOKEN is the owner bypass", async () => {
    expect(await authenticate(env(), "Bearer owner-token-123")).toEqual({ kind: "owner_token" });
    expect(await failure(authenticate(env(), "Bearer owner-token-124"))).toBe("401 invalid_token");
  });

  test("with nothing configured every token is refused", async () => {
    const bare = env({ MCP_TOKEN: undefined, CLERK_JWT_KEY: undefined });
    expect(await failure(authenticate(bare, "Bearer anything"))).toBe("401 invalid_token");
  });

  test("a valid Clerk session is accepted (networkless); there is no allow list, sign-up is open", async () => {
    const principal = await authenticate(env(), `Bearer ${await sign(claims())}`);
    expect(principal).toEqual({ kind: "clerk", userId: "user_owner", sessionId: "sess_1" });
  });

  test("expired, not-yet-valid, wrongly signed and wrong-azp tokens are 401", async () => {
    expect(await failure(authenticate(env(), `Bearer ${await sign(claims({ exp: nowS() - 120 }))}`))).toBe("401 invalid_token");
    expect(await failure(authenticate(env(), `Bearer ${await sign(claims({ nbf: nowS() + 600 }))}`))).toBe("401 invalid_token");
    expect(await failure(authenticate(env(), `Bearer ${await sign(claims(), otherKeys.privateKey)}`))).toBe("401 invalid_token");
    expect(await failure(authenticate(env(), `Bearer ${await sign(claims({ azp: "https://evil.example" }))}`))).toBe("401 invalid_token");
  });

  test("any verified user is authenticated (their workspace is resolved next); a token without a subject is 401", async () => {
    expect(await authenticate(env(), `Bearer ${await sign(claims({ sub: "user_stranger" }))}`)).toMatchObject({ kind: "clerk", userId: "user_stranger" });
    expect(await failure(authenticate(env(), `Bearer ${await sign(claims({ sub: "" }))}`))).toBe("401 invalid_token");
  });
});
