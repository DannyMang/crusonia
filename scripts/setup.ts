// Registers Crusonia with its providers. Idempotent: safe to re-run.
//   bun run setup                 print the values to add to .dev.vars
//   bun run setup --write         also write them into .dev.vars
//   bun run setup --naive-credential   re-add the MCP credentials to an existing Naive vault
//   bun run setup --agent         only create or update the Naive agent (e.g. after editing playbooks/)
//   bun run setup --stripe        only Stripe billing: products/prices from src/billing/plans.ts, the Customer
//                                 Portal and the webhook endpoint (test key; --live for a live key,
//                                 --rotate-webhook-secret for a new signing secret, --verify-checkout to create
//                                 and expire one test Checkout Session). The webhook secret is written to
//                                 .dev.vars.stripe.<mode> (gitignored), never printed.
//   bun run setup --crm           only CRM sync: HubSpot crusonia_* properties and the Notion "Crusonia leads"
//                                 database (writes NOTION_LEADS_DATABASE_ID with --write). Never part of a plain run:
//                                 it changes the owner's HubSpot schema and Notion workspace.
//
// Needs: PUBLIC_URL (wrangler.jsonc, after the first deploy), MCP_TOKEN, and the API key of each
// provider to set up (AGENTMAIL_API_KEY, NAIVE_API_KEY, APIFY_TOKEN). Providers without a key are skipped.
// Prints secrets to the terminal on purpose (some are shown only once by the provider).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { AgentMailClient } from "agentmail";
import { HubSpotClient } from "../src/providers/hubspot.ts";
import { NotionClient } from "../src/providers/notion.ts";
import { setupHubSpot, setupNotion } from "./lib/crm-setup.ts";
import { DEV_VARS, ROOT, WRANGLER_ENV, getVar, requireVar } from "./lib/env.ts";
import { AGENT_NAME, APIFY_MCP_URL, PLAYBOOK_PATH, agentSettings, changedFields, naiveAgentConfig, parsePlaybook } from "./lib/naive-agent.ts";
import { setupStripe } from "./lib/stripe-setup.ts";

export { APIFY_MCP_URL };

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
  const vars = WRANGLER_ENV ? config.env?.[WRANGLER_ENV]?.vars : config.vars;
  if (WRANGLER_ENV && !config.env?.[WRANGLER_ENV]) {
    console.error(`wrangler.jsonc has no env.${WRANGLER_ENV}.`);
    process.exit(1);
  }
  const url = (fromEnv ?? vars?.PUBLIC_URL ?? "").replace(/\/+$/, "");
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

class NaiveError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function naiveClient(apiKey: string, redact: string[]) {
  async function request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
    let res = await fetch(`${NAIVE_BASE}${path}`, init);
    // 429 (rate limit or provider capacity) is always safe to retry; a POST keeps its Idempotency-Key.
    for (let attempt = 1; res.status === 429 && attempt <= 4; attempt++) {
      const wait = Math.min(Number(res.headers.get("Retry-After")) || 5, 30);
      console.log(`Naive is busy (429), retrying in ${wait}s...`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      res = await fetch(`${NAIVE_BASE}${path}`, init);
    }
    const text = await res.text();
    if (!res.ok) {
      let safe = text.slice(0, 500);
      for (const secret of redact) safe = safe.replaceAll(secret, "[redacted]");
      throw new NaiveError(`Naive ${method} ${path.split("?")[0]} failed (${res.status}): ${safe}`, res.status);
    }
    return JSON.parse(text) as T;
  }
  return {
    request,
    /** POST with an Idempotency-Key derived from `seed`, so a re-run replays instead of duplicating. */
    post: async <T>(path: string, body: unknown, seed: string): Promise<T> => request<T>("POST", path, body, await stableUuid(seed)),
  };
}
type Naive = ReturnType<typeof naiveClient>;

async function setupNaive(baseUrl: string) {
  const apiKey = getVar("NAIVE_API_KEY");
  if (!apiKey) {
    notes.push("Naive skipped: NAIVE_API_KEY not set.");
    return;
  }
  const mcpToken = requireVar("MCP_TOKEN", "Generate one with `openssl rand -hex 32` and add it to .dev.vars.");
  const apifyToken = getVar("APIFY_TOKEN");
  const naive = naiveClient(apiKey, [apiKey, mcpToken, ...(apifyToken ? [apifyToken] : [])]);
  const post = naive.post;

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
    if (!addCredential) notes.push("Naive vault: already configured (NAIVE_VAULT_ID set), skipped. Use --naive-credential to re-add the MCP credentials.");
  } else {
    // The default environment keeps its original seed; another one (--env) gets its own vault.
    const vault = await post<{ id: string }>(
      "/v1/vaults",
      { display_name: WRANGLER_ENV ? `Crusonia (${WRANGLER_ENV})` : "Crusonia" },
      WRANGLER_ENV ? `naive-vault:${baseUrl}` : "naive-vault",
    );
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
    if (!apifyToken) {
      notes.push("Apify MCP credential skipped: APIFY_TOKEN not set. Add it, then re-run with --naive-credential.");
    } else {
      try {
        await post(
          `/v1/vaults/${vaultId}/credentials`,
          { kind: "static_bearer", key: "Apify MCP", mcp_server_url: APIFY_MCP_URL, value: apifyToken },
          `naive-credential:${vaultId}:${APIFY_MCP_URL}:${await sha256Hex(apifyToken)}`,
        );
        console.log(`Naive vault credential: Apify MCP -> ${APIFY_MCP_URL}`);
      } catch (err) {
        notes.push(`Apify MCP credential failed. Re-run with --naive-credential. ${(err as Error).message}`);
      }
    }
  }

  await applyNaiveAgent(baseUrl, naive);
}

// `bun run setup --agent`: only the agent, e.g. after editing the playbook. Needs NAIVE_API_KEY.
async function setupNaiveAgent(baseUrl: string) {
  const apiKey = getVar("NAIVE_API_KEY");
  if (!apiKey) {
    notes.push("Naive agent skipped: NAIVE_API_KEY not set.");
    return;
  }
  await applyNaiveAgent(baseUrl, naiveClient(apiKey, [apiKey]));
}

async function applyNaiveAgent(baseUrl: string, naive: Naive) {
  const agent = await createNaiveAgent(baseUrl, naive);
  results.NAIVE_AGENT_ID = agent.id;
  const { budget } = agent.config;
  const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;
  console.log(
    `Naive agent: "${agent.config.name}" ${agent.status} (v${agent.version}), playbook ${agent.config.metadata.playbook} v${agent.config.metadata.playbook_version}, ` +
      `model ${agent.config.model}, budget ${usd(budget.cap_micro_usd)}/${budget.period} and ${usd(budget.max_task_micro_usd)} per session`,
  );
}

type AgentRow = { id: string; name: string; current_version: number; harness?: string };

async function agentsNamed(naive: Naive, name: string): Promise<AgentRow[]> {
  const found: AgentRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({ limit: "100", ...(after ? { after } : {}) });
    const res = await naive.request<{ data: AgentRow[]; has_more: boolean; next_cursor: string | null }>("GET", `/v1/agents?${qs}`);
    found.push(...res.data.filter((a) => a.name === name));
    if (!res.has_more || !res.next_cursor) break;
    after = res.next_cursor;
  }
  return found;
}

/**
 * Creates the research agent, or updates it in place: a PATCH of the fields that changed mints a new
 * immutable version, and an unchanged config sends nothing. The agent is NAIVE_AGENT_ID when set, otherwise
 * the one agent named AGENT_NAME, so re-runs never create duplicates. The system prompt is playbooks/research.md.
 */
export async function createNaiveAgent(baseUrl: string, naive: Naive) {
  const playbook = parsePlaybook(readFileSync(`${ROOT}${PLAYBOOK_PATH}`, "utf8"));
  // Setup finds the agent by name, so each wrangler environment needs its own: `--env staging` defaults to
  // "Crusonia Research (staging)". NAIVE_AGENT_NAME overrides it.
  const name = getVar("NAIVE_AGENT_NAME") ?? (WRANGLER_ENV ? `${AGENT_NAME} (${WRANGLER_ENV})` : undefined);
  const config = naiveAgentConfig({ baseUrl, playbook, ...(name ? { name } : {}), ...agentSettings(getVar) });

  let id = getVar("NAIVE_AGENT_ID");
  const byName = !id;
  if (!id) {
    const matches = await agentsNamed(naive, config.name);
    if (matches.length > 1) {
      throw new Error(`Naive has ${matches.length} agents named "${config.name}". Set NAIVE_AGENT_ID to the one to keep.`);
    }
    id = matches[0]?.id;
  }
  if (!id) {
    // A fresh key per create: the name lookup above is what makes re-runs safe.
    const created = await naive.request<AgentRow>("POST", "/v1/agents", config, crypto.randomUUID());
    return { id: created.id, version: created.current_version, status: "created" as const, config };
  }

  let current: AgentRow & Record<string, unknown>;
  try {
    current = await naive.request("GET", `/v1/agents/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof NaiveError && err.status === 404) {
      throw new Error("NAIVE_AGENT_ID is set, but Naive has no such agent. Remove it from .dev.vars to create a new one.");
    }
    throw err;
  }
  // Never repoint another environment's agent: one found by name must already serve this PUBLIC_URL.
  const servedUrl = (current.mcp_servers as { name?: string; url?: string }[] | undefined)?.find((s) => s.name === "crusonia")?.url;
  const ownUrl = config.mcp_servers.find((s) => s.name === "crusonia")!.url;
  if (byName && servedUrl && servedUrl !== ownUrl) {
    throw new Error(
      `The Naive agent "${config.name}" serves ${servedUrl}, not ${ownUrl}. Set NAIVE_AGENT_NAME (or --env) for a separate agent, ` +
        "or NAIVE_AGENT_ID to move that agent on purpose.",
    );
  }
  if (config.harness && current.harness && config.harness !== current.harness) {
    notes.push(`Naive agent: NAIVE_AGENT_HARNESS=${config.harness} ignored; the harness is fixed at creation (${current.harness}).`);
  }
  const update = changedFields(config, current);
  if (!Object.keys(update).length) return { id, version: current.current_version, status: "unchanged" as const, config };
  // No expected_version: a declarative, last-write-wins apply of the config in this repo.
  const updated = await naive.request<AgentRow>("PATCH", `/v1/agents/${encodeURIComponent(id)}`, update);
  return { id, version: updated.current_version, status: `updated (${Object.keys(update).join(", ")})` as const, config };
}

// ---------- Stripe (--stripe) ----------

// `bun run setup --stripe`: needs STRIPE_SECRET_KEY (Crusonia's own account). Refuses a live key without --live.
async function setupStripeBilling(baseUrl: string) {
  const result = await setupStripe({
    key: getVar("STRIPE_SECRET_KEY"),
    baseUrl,
    live: args.has("--live"),
    rotateWebhookSecret: args.has("--rotate-webhook-secret"),
    verifyCheckout: args.has("--verify-checkout"),
    secretPath: (mode) => `${DEV_VARS}.stripe.${mode}`,
    log: (line) => console.log(line),
  });
  notes.push(...result.notes);
  if (result.secretWritten) {
    const file = `${DEV_VARS.slice(ROOT.length)}.stripe.${result.mode}`;
    notes.push(
      `Stripe webhook secret written to ${file} (mode 600, gitignored). Upload it with ` +
        `\`bunx wrangler secret bulk ${file}${WRANGLER_ENV ? ` --env ${WRANGLER_ENV}` : ""}\` (and copy the line into ${DEV_VARS.slice(ROOT.length)} for wrangler dev).`,
    );
  }
}

// ---------- CRM sync (--crm) ----------

async function setupCrm() {
  const hubspotToken = getVar("HUBSPOT_ACCESS_TOKEN");
  if (!hubspotToken) notes.push("HubSpot skipped: HUBSPOT_ACCESS_TOKEN not set.");
  else {
    const report = await setupHubSpot(new HubSpotClient(hubspotToken));
    for (const line of report.done) console.log(line);
    notes.push(...report.notes);
  }
  const notionToken = getVar("NOTION_API_TOKEN");
  if (!notionToken) notes.push("Notion skipped: NOTION_API_TOKEN not set.");
  else {
    const report = await setupNotion(new NotionClient(notionToken), {
      parentPageId: getVar("NOTION_PARENT_PAGE_ID"),
      databaseId: getVar("NOTION_LEADS_DATABASE_ID"),
    });
    for (const line of report.done) console.log(line);
    notes.push(...report.notes);
    if (report.databaseId && report.databaseId !== getVar("NOTION_LEADS_DATABASE_ID")) results.NOTION_LEADS_DATABASE_ID = report.databaseId;
  }
  notes.push("CRM sync stays off until HUBSPOT_SYNC_ENABLED / NOTION_SYNC_ENABLED is true (see README \"CRM sync\").");
}

// ---------- output ----------

function writeDevVars(values: Record<string, string>) {
  const path = DEV_VARS;
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
console.log(`PUBLIC_URL: ${baseUrl}${WRANGLER_ENV ? ` (env ${WRANGLER_ENV}, ${DEV_VARS.slice(ROOT.length)})` : ""}\n`);

// Exactly one mode per run: --stripe, --crm, --agent, or (none) AgentMail + Naive.
const steps: [string, (baseUrl: string) => Promise<void>][] = args.has("--stripe")
  ? [["Stripe", setupStripeBilling]]
  : args.has("--crm")
    ? [["CRM sync", setupCrm]]
    : args.has("--agent")
      ? [["Naive agent", setupNaiveAgent]]
      : [
          ["AgentMail", setupAgentMail],
          ["Naive", setupNaive],
        ];
let failed = false;
for (const [name, step] of steps) {
  try {
    await step(baseUrl);
  } catch (err) {
    failed = true;
    console.error(`${name} setup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (notes.length) console.log(`\n${notes.map((n) => `- ${n}`).join("\n")}`);

if (Object.keys(results).length) {
  const file = DEV_VARS.slice(ROOT.length);
  console.log(`\nAdd to ${file}, then run \`bun run ${WRANGLER_ENV ? `secrets:${WRANGLER_ENV}` : "secrets"}\` to upload:\n`);
  for (const [key, value] of Object.entries(results)) console.log(`${key}=${value}`);
  if (args.has("--write")) {
    writeDevVars(results);
    console.log(`\nWrote these to ${file}.`);
  }
}

if (failed) process.exit(1);
