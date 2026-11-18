// Registers Crusonia with its providers. Idempotent: safe to re-run.
//   bun run setup                 print the values to add to .dev.vars
//   bun run setup --write         also write them into .dev.vars
//   bun run setup --stripe        only Stripe billing: products/prices from src/billing/plans.ts, the Customer
//                                 Portal and the webhook endpoint (test key; --live for a live key,
//                                 --rotate-webhook-secret for a new signing secret, --verify-checkout to create
//                                 and expire one test Checkout Session). The webhook secret is written to
//                                 .dev.vars.stripe.<mode> (gitignored), never printed.
//   bun run setup --crm           only CRM sync: HubSpot crusonia_* properties and the Notion "Crusonia leads"
//                                 database (writes NOTION_LEADS_DATABASE_ID with --write). Never part of a plain run:
//                                 it changes the owner's HubSpot schema and Notion workspace.
//
// Needs: PUBLIC_URL (wrangler.jsonc, after the first deploy) and the API key of each provider to set up
// (AGENTMAIL_API_KEY). Providers without a key are skipped.
// Prints secrets to the terminal on purpose (some are shown only once by the provider).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { AgentMailClient } from "agentmail";
import { HubSpotClient } from "../src/providers/hubspot.ts";
import { NotionClient } from "../src/providers/notion.ts";
import { setupHubSpot, setupNotion } from "./lib/crm-setup.ts";
import { DEV_VARS, ROOT, WRANGLER_ENV, getVar, requireVar } from "./lib/env.ts";
import { setupStripe } from "./lib/stripe-setup.ts";

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

// Exactly one mode per run: --stripe, --crm, or (none) AgentMail.
const steps: [string, (baseUrl: string) => Promise<void>][] = args.has("--stripe")
  ? [["Stripe", setupStripeBilling]]
  : args.has("--crm")
    ? [["CRM sync", setupCrm]]
    : [["AgentMail", setupAgentMail]];
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
