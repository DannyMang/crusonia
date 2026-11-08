// MCP tool definitions. Thin layer: validate input (zod), call a service, return JSON text.
// All logic lives in src/services/*. No tool sends email or decides an approval.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getSql, type Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { searchGoogle, searchInputSchema } from "../services/apify.ts";
import { describeMinutes, sendApprovalTtlMinutes } from "../services/approval-ttl.ts";
import { createDraft, draftInputSchema, listPendingApprovals } from "../services/drafts.ts";
import { ServiceError, describeError, missingKey } from "../services/errors.ts";
import {
  LEAD_STAGES,
  MAX_LEADS_PER_CALL,
  addLeads,
  evidenceInputSchema,
  getLeadDetail,
  leadInputSchema,
  listLeads,
  saveEvidence,
  scoreInputSchema,
  scoreLead,
} from "../services/leads.ts";
import { getProfile, profileInputSchema, saveProfile } from "../services/profile.ts";
import { getStatus } from "../services/status.ts";
import { readWebsite, readWebsiteInputSchema } from "../services/web.ts";

export const SERVER_INFO = { name: "crusonia", title: "Crusonia GTM engine", version: "0.1.0" };

const INSTRUCTIONS = `Crusonia is a GTM engine (a Clay/Apollo alternative run by AI agents). Typical flow:
1. get_status: see what is configured.
2. Onboarding: read_website on the user's company site, propose an ideal customer profile (ICP) to the user, then save_profile once they agree.
3. Prospecting: search_web (and read_website on prospects) to find companies/people that match the profile, then add_leads with the source URL.
4. Research: save_evidence for each fact (with its URL), then score_lead against the profile.
5. Outreach: create_draft only for leads with has_consent: true. It opens an approval; a human approves every send. Nothing in this server sends email.
Agent-found leads have no consent and are never emailed.`;

type Deps = { sql?: () => Sql };

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WEB = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await fn();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    if (!(err instanceof ServiceError)) console.error("mcp tool error", err);
    return { content: [{ type: "text", text: describeError(err) }], isError: true };
  }
}

/** A fresh server per request (stateless): cheap, and nothing leaks between callers. */
export function createMcpServer(env: Env, deps: Deps = {}): McpServer {
  const db = deps.sql ?? (() => getSql(env.DATABASE_URL));
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  const sendTtlMinutes = sendApprovalTtlMinutes(env);

  server.registerTool(
    "get_status",
    {
      title: "Get status",
      description:
        "Shows which providers are configured (database, Apify, AgentMail, Naive, HubSpot, Notion), whether the database is reachable, lead counts by stage, open approvals, whether a profile is saved, and suggested next steps. Call this first. Works with no keys set.",
      annotations: READ,
    },
    () => run(() => getStatus(env)),
  );

  server.registerTool(
    "read_website",
    {
      title: "Read a website",
      description:
        "Reads a company's website (homepage plus a few pages such as about, product, pricing) and returns each page's URL, title, description and visible text (trimmed to ~6000 characters per page). Use it during onboarding to understand what the user sells and propose an ideal customer profile, or to research a prospect. Uses Apify's website crawler when APIFY_TOKEN is set, otherwise a plain fetch (no JavaScript rendering); `mode` and `note` say which.",
      inputSchema: readWebsiteInputSchema,
      annotations: WEB,
    },
    (args) => run(() => readWebsite(env, args)),
  );

  server.registerTool(
    "search_web",
    {
      title: "Search the web",
      description:
        "Google search via Apify (needs APIFY_TOKEN). Returns organic results (position, title, url, description) and related queries. Use it to find companies and people that match the saved profile, e.g. 'site:linkedin.com/in \"VP Sales\" logistics Germany'. Results are leads to verify, not facts: open the pages before saving evidence.",
      inputSchema: searchInputSchema,
      annotations: WEB,
    },
    (args) =>
      run(async () => {
        if (!env.APIFY_TOKEN) throw missingKey("APIFY_TOKEN", "search_web");
        return searchGoogle(env.APIFY_TOKEN, args);
      }),
  );

  server.registerTool(
    "save_profile",
    {
      title: "Save the onboarding profile",
      description:
        "Saves the user's go-to-market profile: company, website, what they sell, the ideal customer profile (icp_description), target segments (name, company_size, industry, roles), buying signals (name, description) and sources (which page supports which field). Replaces any previous profile, so send all fields. Only save after the user has confirmed the ICP you proposed, unless the user asked you to save a proposal for them to review.",
      inputSchema: profileInputSchema,
      annotations: { ...WRITE, idempotentHint: true },
    },
    (args) => run(() => saveProfile(db(), args)),
  );

  server.registerTool(
    "get_profile",
    {
      title: "Get the onboarding profile",
      description: "Returns the saved go-to-market profile (what the user sells, ICP description, segments, buying signals, sources), or null if onboarding hasn't happened yet. Read it before prospecting or scoring.",
      annotations: READ,
    },
    () => run(async () => ({ profile: await getProfile(db()) })),
  );

  server.registerTool(
    "add_leads",
    {
      title: "Add leads",
      description: `Adds or updates people/companies you found (up to ${MAX_LEADS_PER_CALL} per call). Each lead needs a source and source_url, plus an email or a company domain/website. Deduped by email, otherwise by company domain + name, so re-adding is safe and fills in missing fields. New leads get stage 'no_consent': they are stored for research and scoring but are never emailed. Returns each lead's id and whether it was added, updated or skipped (with the reason).`,
      inputSchema: z.object({
        leads: z.array(leadInputSchema).min(1).max(MAX_LEADS_PER_CALL).describe("Leads to add or update."),
      }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    (args) => run(() => addLeads(db(), args.leads)),
  );

  server.registerTool(
    "list_leads",
    {
      title: "List leads",
      description: "Lists leads, most recently updated first, optionally filtered by stage. Returns id, contact fields, stage, score, qualified and has_consent for each.",
      inputSchema: z.object({
        stage: z.enum(LEAD_STAGES).nullish().describe("Only leads in this stage."),
        limit: z.number().int().min(1).max(200).default(25).describe("Maximum leads to return (default 25)."),
      }),
      annotations: READ,
    },
    (args) => run(async () => ({ leads: await listLeads(db(), args) })),
  );

  server.registerTool(
    "get_lead",
    {
      title: "Get a lead",
      description: "Returns one lead with all its fields, its evidence (claims + source URLs), its drafts (newest version first) and its approvals.",
      inputSchema: z.object({ lead_id: z.string().trim().min(1).max(64).describe("Lead id, e.g. 'lead_3f2a...'.") }),
      annotations: READ,
    },
    (args) => run(() => getLeadDetail(db(), args.lead_id)),
  );

  server.registerTool(
    "save_evidence",
    {
      title: "Save evidence",
      description: "Records one fact about a lead with the public URL that supports it. Save one call per fact; scores and drafts should only rely on saved evidence.",
      inputSchema: evidenceInputSchema,
      annotations: WRITE,
    },
    (args) => run(() => saveEvidence(db(), args)),
  );

  server.registerTool(
    "score_lead",
    {
      title: "Score a lead",
      description:
        "Stores your fit score (0-100), rationale and qualified verdict for a lead against the saved profile. Moves the lead to 'qualified' or 'disqualified' unless it has no consent or is already in the send flow (then the stage is kept).",
      inputSchema: scoreInputSchema,
      annotations: { ...WRITE, idempotentHint: true },
    },
    (args) => run(() => scoreLead(db(), args)),
  );

  server.registerTool(
    "create_draft",
    {
      title: "Create an email draft",
      description:
        `Saves an email draft for an opted-in lead (has_consent: true) and opens a pending send approval with a short code that expires in ${describeMinutes(sendTtlMinutes)}. Drafts are immutable: calling again creates a new version and supersedes the older open draft and its approval. This does NOT send anything; a human must approve first. Fails for leads without consent, without an email, or who unsubscribed.`,
      inputSchema: draftInputSchema,
      annotations: WRITE,
    },
    (args) => run(() => createDraft(db(), args, { ttlMinutes: sendTtlMinutes })),
  );

  server.registerTool(
    "list_pending_approvals",
    {
      title: "List pending approvals",
      description: "Lists approvals still waiting for a human decision (not expired), oldest first, with the lead and the draft subject/body. Read-only: approving or rejecting happens outside this server.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(50).describe("Maximum approvals to return (default 50).") }),
      annotations: READ,
    },
    (args) => run(async () => ({ approvals: await listPendingApprovals(db(), args.limit) })),
  );

  return server;
}
