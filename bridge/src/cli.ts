// Operator CLI for the bridge's local server, run inside the container (`docker exec crusonia-bridge bun src/cli.ts ...`),
// where BRIDGE_SECRET and PORT are already in the environment.
//
//   bun src/cli.ts health
//   bun src/cli.ts notify <id> <text...>     text the owner once (the id dedupes retries)
//   bun src/cli.ts inbound <from> <text...>  SPECTRUM_MODE=mock bridges only: simulate an owner iMessage
import { signedHeaders } from "./hmac.ts";

const [cmd, ...args] = process.argv.slice(2);
const base = (process.env.BRIDGE_URL ?? `http://127.0.0.1:${process.env.PORT ?? "8080"}`).replace(/\/+$/, "");
const secret = process.env.BRIDGE_SECRET ?? "";

async function post(path: string, payload: unknown) {
  if (secret.length < 32) throw new Error("Set BRIDGE_SECRET (32+ characters) in the environment");
  const body = JSON.stringify(payload);
  const res = await fetch(`${base}${path}`, { method: "POST", headers: signedHeaders(secret, path, body), body, signal: AbortSignal.timeout(30_000) });
  console.log(res.status, await res.text());
  if (!res.ok) process.exitCode = 1;
}

if (cmd === "health") {
  const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(10_000) });
  console.log(res.status, await res.text());
} else if (cmd === "notify" && args.length >= 2) {
  await post("/notify", { id: args[0], type: "test", text: args.slice(1).join(" ") });
} else if (cmd === "inbound" && args.length >= 2) {
  await post("/mock/inbound", { from: args[0], text: args.slice(1).join(" ") });
} else {
  console.error("usage: bun src/cli.ts health | notify <id> <text...> | inbound <from> <text...>");
  process.exitCode = 2;
}
