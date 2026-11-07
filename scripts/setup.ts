// Registers Crusonia with its providers. Idempotent: safe to re-run.
//   bun run setup                 print the values to add to .dev.vars
//   bun run setup --write         also write them into .dev.vars
//   bun run setup --naive-credential   re-add the MCP credential to an existing Naive vault
//
// Needs: PUBLIC_URL (wrangler.jsonc, after the first deploy), MCP_TOKEN, and the API key of each
// provider to set up (AGENTMAIL_API_KEY, NAIVE_API_KEY). Providers without a key are skipped.
// Prints secrets to the terminal on purpose (some are shown only once by the provider).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { AgentMailClient } from "agentmail";
import { ROOT, getVar, requireVar } from "./lib/env.ts";

const args = new Set(process.argv.slice(2));
const results: Record<string, string> = {};
const notes: string[] = [];

// ---------- config ----------

function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      if (i === 0) break;
    } else {
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function publicUrl(): string {
  const fromEnv = getVar("PUBLIC_URL");
  const config = JSON.parse(stripJsonComments(readFileSync(`${ROOT}wrangler.jsonc`, "utf8")));
  const url = (fromEnv ?? config.vars?.PUBLIC_URL ?? "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(url)) {
    console.error("PUBLIC_URL is not set. Deploy first (`bun run deploy`), then put the workers.dev URL in wrangler.jsonc vars.PUBLIC_URL.");
    process.exit(1);
  }
  return url;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Same seed -> same UUID, so a re-run after a crash replays the provider's stored response
// instead of creating a duplicate (within the provider's idempotency window).
async function stableUuid(seed: string): Promise<string> {
  const h = (await sha256Hex(`crusonia-setup:${seed}`)).slice(0, 32).split("");
  h[12] = "5";
  h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

// ---------- AgentMail ----------

async function setupAgentMail(baseUrl: string) {
  const apiKey = getVar("AGENTMAIL_API_KEY");
  if (!apiKey) {
    notes.push("AgentMail skipped: AGENTMAIL_API_KEY not set.");
    return;
  }
  const client = new AgentMailClient({ apiKey });

  const username = getVar("AGENTMAIL_USERNAME") ?? "crusonia";
  const inbox = await client.inboxes.create({ username, displayName: "Crusonia", clientId: "crusonia-inbox" });
  results.AGENTMAIL_INBOX_ID = inbox.inboxId;
  console.log(`AgentMail inbox: ${inbox.email}`);

  const url = `${baseUrl}/webhooks/agentmail`;
  // Webhook URLs can't be updated, so the clientId is per URL: a new PUBLIC_URL gets a new webhook.
  const webhook = await client.webhooks.create({
    url,
    eventTypes: ["message.received", "message.bounced", "message.complained", "message.delivered"],
    inboxIds: [inbox.inboxId],
    clientId: `crusonia-webhook-${(await sha256Hex(url)).slice(0, 12)}`,
  });
  if (!webhook.enabled) await client.webhooks.update(webhook.webhookId, { enabled: true });
  results.AGENTMAIL_WEBHOOK_SECRET = webhook.secret;
  console.log(`AgentMail webhook: ${webhook.webhookId} -> ${url}`);
}

// ---------- Naive ----------

const NAIVE_BASE = "https://api.vetta.sh";

class NaiveError extends Error {}

function naiveClient(apiKey: string, redact: string[]) {
  return async function post<T>(path: string, body: unknown, idempotencySeed: string): Promise<T> {
    const res = await fetch(`${NAIVE_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": await stableUuid(idempotencySeed),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let safe = text.slice(0, 500);
      for (const secret of redact) safe = safe.replaceAll(secret, "[redacted]");
      throw new NaiveError(`Naive POST ${path} failed (${res.status}): ${safe}`);
    }
    return JSON.parse(text) as T;
  };
}

async function setupNaive(baseUrl: string) {
  const apiKey = getVar("NAIVE_API_KEY");
  if (!apiKey) {
    notes.push("Naive skipped: NAIVE_API_KEY not set.");
    return;
  }
  const mcpToken = requireVar("MCP_TOKEN", "Generate one with `openssl rand -hex 32` and add it to .dev.vars.");
  const post = naiveClient(apiKey, [apiKey, mcpToken]);

  // Webhook: the secret is shown once, so skip if we already have it.
  const webhookUrl = `${baseUrl}/webhooks/naive`;
  if (getVar("NAIVE_WEBHOOK_SECRET")) {
    notes.push("Naive webhook: already configured (NAIVE_WEBHOOK_SECRET set), skipped.");
  } else {
    const webhook = await post<{ id: string; secret: string }>(
      "/v1/webhooks",
      { url: webhookUrl, events: ["session.idle", "budget.exceeded"] },
      `naive-webhook:${webhookUrl}`,
    );
    results.NAIVE_WEBHOOK_SECRET = webhook.secret;
    console.log(`Naive webhook: ${webhook.id} -> ${webhookUrl}`);
  }

  // Vault + MCP credential. Naive injects it when the URL exactly matches an agent's mcp_servers[].url.
  const mcpUrl = `${baseUrl}/mcp`;
  let vaultId = getVar("NAIVE_VAULT_ID");
  let addCredential = args.has("--naive-credential");
  if (vaultId) {
    if (!addCredential) notes.push("Naive vault: already configured (NAIVE_VAULT_ID set), skipped. Use --naive-credential to re-add the MCP credential.");
  } else {
    const vault = await post<{ id: string }>("/v1/vaults", { display_name: "Crusonia" }, "naive-vault");
    vaultId = vault.id;
    results.NAIVE_VAULT_ID = vaultId;
    addCredential = true;
    console.log(`Naive vault: ${vaultId}`);
  }
  if (addCredential) {
    try {
      await post(
        `/v1/vaults/${vaultId}/credentials`,
        { kind: "static_bearer", key: "Crusonia MCP", mcp_server_url: mcpUrl, value: mcpToken },
        `naive-credential:${vaultId}:${mcpUrl}:${await sha256Hex(mcpToken)}`,
      );
      console.log(`Naive vault credential: Crusonia MCP -> ${mcpUrl}`);
    } catch (err) {
      notes.push(`Naive credential failed. Save NAIVE_VAULT_ID, then re-run with --naive-credential. ${(err as Error).message}`);
    }
  }

  // Agent creation waits for the playbook and MCP tools: see createNaiveAgent below.
  notes.push("Naive agent: not created yet (TODO in scripts/setup.ts, needs the playbook and MCP tools).");
}

// TODO(agent): create the Naive agent once the playbook (system prompt) and the MCP tools exist.
// Not called yet. Reference request (verified against the Naive REST API):
//   POST /v1/agents
//   { name, model: "vetta/auto", system,
//     mcp_servers: [{ type: "url", name: "crusonia", url: `${PUBLIC_URL}/mcp` }],
//     tools: { default_config: { permission: "ask" },
//              configs: { "crusonia.<tool>": { permission: "allow" } } },
//     budget: { cap_micro_usd, max_task_micro_usd, period: "day" } }
// The mcp_servers url must equal the vault credential's mcp_server_url exactly for the token to be injected.
// Store the returned agent id as NAIVE_AGENT_ID (add it to .dev.vars.example and src/env.ts then).
export async function createNaiveAgent(_baseUrl: string): Promise<never> {
  throw new Error("TODO: createNaiveAgent is not implemented yet");
}

// ---------- output ----------

function writeDevVars(values: Record<string, string>) {
  const path = `${ROOT}.dev.vars`;
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const idx = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    if (idx >= 0) lines[idx] = line;
    else lines.splice(lines.at(-1) === "" ? lines.length - 1 : lines.length, 0, line);
  }
  writeFileSync(path, lines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
}

const baseUrl = publicUrl();
console.log(`PUBLIC_URL: ${baseUrl}\n`);

let failed = false;
for (const [name, step] of [["AgentMail", setupAgentMail], ["Naive", setupNaive]] as const) {
  try {
    await step(baseUrl);
  } catch (err) {
    failed = true;
    console.error(`${name} setup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (notes.length) console.log(`\n${notes.map((n) => `- ${n}`).join("\n")}`);

if (Object.keys(results).length) {
  console.log("\nAdd to .dev.vars, then run `bun run secrets` to upload:\n");
  for (const [key, value] of Object.entries(results)) console.log(`${key}=${value}`);
  if (args.has("--write")) {
    writeDevVars(results);
    console.log("\nWrote these to .dev.vars.");
  }
}

if (failed) process.exit(1);
