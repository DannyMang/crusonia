// Clerk session tokens for integration tests, signed with a key generated here (networkless verification: pass `pem`
// as CLERK_JWT_KEY).
export async function testClerk(): Promise<{ pem: string; token: (sub: string) => Promise<string> }> {
  const params = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  const keys = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  const spki = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64");
  const b64url = (d: Uint8Array | string) => Buffer.from(typeof d === "string" ? new TextEncoder().encode(d) : d).toString("base64url");
  return {
    pem: `-----BEGIN PUBLIC KEY-----\n${spki.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----`,
    token: async (sub) => {
      const now = Math.floor(Date.now() / 1000);
      const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "ins_test" }));
      const body = b64url(JSON.stringify({ sub, sid: "sess_it", iss: "https://clerk.crusonia.dev", iat: now - 10, nbf: now - 10, exp: now + 300 }));
      const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
      return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
    },
  };
}
