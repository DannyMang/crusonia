// /api/company-summary (the workspace's Company summary: one markdown document), /api/profile (the
// older structured view of it), and /api/onboarding/* (read a website, have the agent write the summary).
import { Hono } from "hono";
import { z } from "zod";
import { requireCredits } from "../billing/accounts.ts";
import { apifyMeter } from "../billing/usage.ts";
import { actorOf, authorOf, parseJson, sqlFor, wsOf, type AppEnv } from "../lib/context.ts";
import { getCompanySummary, MAX_SUMMARY_CHARS, SUMMARY_TEMPLATE, writeCompanySummary, type SummaryView } from "../services/company-summary.ts";
import { requireWebCall } from "../services/limits.ts";
import { getProfile, profileUpdateSchema, saveProfile } from "../services/profile.ts";
import { getOnboardingProposal, naiveAgent, startOnboardingProposal } from "../services/runs.ts";
import { readWebsite } from "../services/web.ts";

// ---------- /api/company-summary ----------

export const companySummary = new Hono<AppEnv>();

const present = (s: SummaryView) => ({ markdown: s.markdown, version: s.version, updated_at: s.updated_at, updated_by: s.updated_by });

// -> {markdown, version, updated_at, updated_by}; version 0 and markdown null before the first save, with the
// suggested starting `template`. `version` counts saves: send it back as base_version.
companySummary.get("/", async (c) => {
  const s = await getCompanySummary(sqlFor(c.env), wsOf(c));
  return c.json({ ...present(s), ...(s.version === 0 ? { template: SUMMARY_TEMPLATE } : {}), max_chars: MAX_SUMMARY_CHARS });
});

const PutBody = z
  .object({
    markdown: z.string().max(MAX_SUMMARY_CHARS + 2000),
    // Optional stale-write check: 409 version_conflict if someone saved since this version.
    base_version: z.number().int().min(0).nullish(),
  })
  .strict();

// Overwrites the document. An unchanged document saves nothing (`unchanged: true`).
companySummary.put("/", async (c) => {
  const body = await parseJson(c, PutBody);
  const s = await writeCompanySummary(sqlFor(c.env), wsOf(c), {
    markdown: body.markdown,
    author: authorOf(c.get("principal")),
    baseVersion: body.base_version ?? null,
  });
  return c.json({ ...present(s), unchanged: s.unchanged ?? false });
});

// ---------- /api/profile (compatibility) ----------

export const profile = new Hono<AppEnv>();

// The structured fields read from the Company summary (null before the first save).
profile.get("/", async (c) => c.json({ profile: await getProfile(sqlFor(c.env), wsOf(c)) }));

// Writes the profile's parts into the Company summary; its other sections are kept.
profile.put("/", async (c) => {
  const body = await parseJson(c, profileUpdateSchema);
  return c.json({ profile: await saveProfile(sqlFor(c.env), wsOf(c), body, authorOf(c.get("principal"))) });
});

// ---------- /api/onboarding ----------

export const onboarding = new Hono<AppEnv>();

const ReadWebsiteBody = z.object({
  url: z.string().trim().min(3).max(2048),
  max_pages: z.number().int().min(1).max(10).default(5),
  // Render JavaScript from the start. Not needed in general: a read that finds no text is retried with rendering.
  render_js: z.boolean().default(false),
});

// Synchronous. Uses Apify's crawler when APIFY_TOKEN is set (a few cents, metered into the caller's credits), else a
// plain fetch (free). Crusonia's own site is answered from its landing copy.
onboarding.post("/read-website", async (c) => {
  const body = await parseJson(c, ReadWebsiteBody);
  if (c.env.APIFY_TOKEN && c.env.DATABASE_URL) await requireWebCall(sqlFor(c.env), c.env, wsOf(c), "read_website");
  const meter = c.env.APIFY_TOKEN && c.env.DATABASE_URL ? apifyMeter(sqlFor(c.env), { workspaceId: wsOf(c), via: "api" }) : undefined;
  const result = await readWebsite(c.env, { url: body.url, max_pages: body.max_pages, render_js: body.render_js }, { meter });
  return c.json({
    pages: result.pages.map((p) => ({ url: p.url, title: p.title, text: p.text, description: p.description, truncated: p.truncated })),
    mode: result.mode,
    ...(result.rendered ? { rendered: true } : {}),
    ...(result.note ? { note: result.note } : {}),
  });
});

const ProposeBody = z
  .object({
    url: z.string().trim().min(3).max(2048).optional(),
    description: z.string().trim().min(1).max(8000).optional(),
  })
  .refine((b) => Boolean(b.url || b.description), { message: "Pass url, description, or both" });

// Starts a Naive session (async): the agent reads the site / description and writes the Company summary.
// Poll GET /api/onboarding/propose/:session_id.
onboarding.post("/propose", async (c) => {
  const body = await parseJson(c, ProposeBody);
  naiveAgent(c.env); // 503 not_configured before touching the database
  const principal = c.get("principal");
  await requireCredits(c.env, principal, wsOf(c)); // 402 insufficient_credits when the workspace's balance is <= 0
  const result = await startOnboardingProposal(sqlFor(c.env), c.env, wsOf(c), body, actorOf(principal));
  return c.json(result, 202);
});

onboarding.get("/propose/:session_id", async (c) => {
  naiveAgent(c.env);
  return c.json(await getOnboardingProposal(sqlFor(c.env), c.env, wsOf(c), c.req.param("session_id")));
});
