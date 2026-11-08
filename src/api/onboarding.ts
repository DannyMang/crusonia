// /api/profile (the onboarding result) and /api/onboarding/* (read a website, have the agent propose a profile).
import { Hono } from "hono";
import { z } from "zod";
import { billingOwnerOf, requireCredits } from "../billing/accounts.ts";
import { apifyMeter } from "../billing/usage.ts";
import { actorOf, parseJson, sqlFor, type AppEnv } from "../lib/context.ts";
import { getProfile, profileUpdateSchema, saveProfile } from "../services/profile.ts";
import { getOnboardingProposal, naiveAgent, startOnboardingProposal } from "../services/runs.ts";
import { readWebsite } from "../services/web.ts";

export const profile = new Hono<AppEnv>();

profile.get("/", async (c) => c.json({ profile: await getProfile(sqlFor(c.env)) }));

// Replaces the whole profile (send every field; omitted arrays become empty).
profile.put("/", async (c) => {
  const body = await parseJson(c, profileUpdateSchema);
  return c.json({ profile: await saveProfile(sqlFor(c.env), body, "api", actorOf(c.get("principal"))) });
});

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
  const meter = c.env.APIFY_TOKEN && c.env.DATABASE_URL ? apifyMeter(sqlFor(c.env), { billingOwnerId: billingOwnerOf(c.get("principal")), via: "api" }) : undefined;
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

// Starts a Naive session (async): the agent reads the site / description and saves a proposed profile.
// Poll GET /api/onboarding/propose/:session_id.
onboarding.post("/propose", async (c) => {
  const body = await parseJson(c, ProposeBody);
  naiveAgent(c.env); // 503 not_configured before touching the database
  const principal = c.get("principal");
  await requireCredits(c.env, principal); // 402 insufficient_credits when BILLING_ENFORCED and the balance is <= 0
  const result = await startOnboardingProposal(sqlFor(c.env), c.env, body, actorOf(principal), undefined, {
    billingOwnerId: billingOwnerOf(principal),
  });
  return c.json(result, 202);
});

onboarding.get("/propose/:session_id", async (c) => {
  naiveAgent(c.env);
  return c.json(await getOnboardingProposal(sqlFor(c.env), c.env, c.req.param("session_id")));
});
