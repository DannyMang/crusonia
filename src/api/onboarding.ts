// /api/profile (the onboarding result) and /api/onboarding/* (read a website, have the agent propose a profile).
import { Hono } from "hono";
import { z } from "zod";
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
});

// Synchronous. Uses Apify's crawler when APIFY_TOKEN is set (a few cents), else a plain fetch (free).
onboarding.post("/read-website", async (c) => {
  const body = await parseJson(c, ReadWebsiteBody);
  const result = await readWebsite(c.env, { url: body.url, max_pages: body.max_pages, render_js: false });
  return c.json({
    pages: result.pages.map((p) => ({ url: p.url, title: p.title, text: p.text, description: p.description, truncated: p.truncated })),
    mode: result.mode,
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
  const result = await startOnboardingProposal(sqlFor(c.env), c.env, body, actorOf(c.get("principal")));
  return c.json(result, 202);
});

onboarding.get("/propose/:session_id", async (c) => {
  naiveAgent(c.env);
  return c.json(await getOnboardingProposal(sqlFor(c.env), c.env, c.req.param("session_id")));
});
