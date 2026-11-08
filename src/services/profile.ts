// The structured onboarding profile (what the user sells and who to target): a compatibility view of the
// workspace's Company summary (./company-summary.ts), which is the source of truth. GET /api/profile and MCP
// get_profile read it from the markdown; PUT /api/profile and MCP save_profile write the profile's parts into the
// markdown and keep every other section. Inputs in the first profile shape
// (company_name, icp, segments and buying_signals as strings) are accepted by normalizeProfile.
import { z } from "zod";
import type { Sql } from "../db.ts";
import { getCompanySummary, markdownToProfile, profileToMarkdown, writeCompanySummary } from "./company-summary.ts";

const text = (max: number) => z.string().trim().min(1).max(max);

const segmentSchema = z.object({
  name: text(200).describe("Short segment name, e.g. 'Seed-Series A B2B SaaS'."),
  company_size: text(100).nullish().describe("Company size, e.g. '11-50 employees' or 'Seed to Series A'."),
  industry: text(200).nullish().describe("Industry or vertical, e.g. 'B2B SaaS', 'Logistics'."),
  roles: z.array(text(200)).max(20).default([]).describe("Roles to contact, e.g. ['Founder', 'Head of Sales']."),
});

const signalSchema = z.object({
  name: text(200).describe("Short signal name, e.g. 'Hiring first SDR'."),
  description: text(2000).nullish().describe("How to observe it and why it means the company is ready to buy."),
});

const sourceSchema = z.object({
  field: text(100).describe("Profile field the page supports, e.g. 'sells', 'icp_description', 'segments'."),
  url: z.httpUrl().max(2048).describe("Page the field is based on."),
});

/** MCP save_profile input. Agents must say what the company sells and who it sells to. */
export const profileInputSchema = z.object({
  company: text(200).nullish().describe("The user's company name."),
  website: z.httpUrl().max(2048).nullish().describe("The user's company website."),
  sells: text(4000).describe("What the user sells, in one or two sentences (product, who it is for, the outcome it delivers)."),
  icp_description: text(8000).describe(
    "Ideal customer profile: industries, company size, geography, roles to contact (titles/seniority), and who to exclude.",
  ),
  segments: z.array(segmentSchema).max(20).default([]).describe("Distinct target segments (2-4 is typical)."),
  signals: z
    .array(signalSchema)
    .max(30)
    .default([])
    .describe("Observable buying signals, e.g. 'hiring first SDR', 'just raised a Series A' (3 is typical)."),
  sources: z.array(sourceSchema).max(50).default([]).describe("Which page each part of the profile is based on."),
  notes: text(8000).nullish().describe("Anything else worth keeping: competitors, pricing, objections, tone of voice."),
});

// PUT /api/profile: the same fields, all optional (the owner may save an unfinished profile). Empty strings
// clear a field, and a website without a scheme gets https://.
const emptyToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const optionalText = (max: number) => z.preprocess(emptyToNull, text(max).nullish());
const withScheme = (v: unknown) => {
  const value = emptyToNull(v);
  return typeof value === "string" && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim()) ? `https://${value.trim()}` : value;
};

const roles = z
  .array(z.string().trim().max(200))
  .max(20)
  .default([])
  .transform((r) => r.filter(Boolean));

export const profileUpdateSchema = z
  .object({
    company: optionalText(200),
    website: z.preprocess(withScheme, z.httpUrl().max(2048).nullish()),
    sells: optionalText(4000),
    icp_description: optionalText(8000),
    segments: z
      .array(z.object({ name: text(200), company_size: optionalText(100), industry: optionalText(200), roles }))
      .max(20)
      .default([]),
    signals: z
      .array(z.object({ name: text(200), description: optionalText(2000) }))
      .max(30)
      .default([]),
    sources: z.array(sourceSchema).max(50).default([]),
    notes: optionalText(8000),
  })
  .strict();

export type Segment = { name: string; company_size: string | null; industry: string | null; roles: string[] };
export type Signal = { name: string; description: string | null };
export type Source = { field: string; url: string };

export type Profile = {
  company: string | null;
  website: string | null;
  sells: string | null;
  icp_description: string | null;
  segments: Segment[];
  signals: Signal[];
  sources: Source[];
  notes: string | null;
  updated_at: string | null;
};

export type ProfileInput = z.input<typeof profileUpdateSchema> | z.infer<typeof profileInputSchema>;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Any stored or submitted profile (current or first shape) in the current shape. */
export function normalizeProfile(raw: Record<string, unknown>): Profile {
  const segments = list(raw.segments).flatMap((s): Segment[] => {
    if (typeof s === "string") return s.trim() ? [{ name: s, company_size: null, industry: null, roles: [] }] : [];
    if (!s || typeof s !== "object") return [];
    const o = s as Record<string, unknown>;
    const name = str(o.name);
    if (!name) return [];
    return [{ name, company_size: str(o.company_size), industry: str(o.industry), roles: list(o.roles).filter((r): r is string => typeof r === "string") }];
  });
  const rawSignals = Array.isArray(raw.signals) ? raw.signals : list(raw.buying_signals);
  const signals = rawSignals.flatMap((s): Signal[] => {
    if (typeof s === "string") return s.trim() ? [{ name: s, description: null }] : [];
    if (!s || typeof s !== "object") return [];
    const o = s as Record<string, unknown>;
    const name = str(o.name);
    return name ? [{ name, description: str(o.description) }] : [];
  });
  const sources = list(raw.sources).flatMap((s): Source[] => {
    const o = (s ?? {}) as Record<string, unknown>;
    const field = str(o.field);
    const url = str(o.url);
    return field && url ? [{ field, url }] : [];
  });
  return {
    company: str(raw.company) ?? str(raw.company_name),
    website: str(raw.website),
    sells: str(raw.sells),
    icp_description: str(raw.icp_description) ?? str(raw.icp),
    segments,
    signals,
    sources,
    notes: str(raw.notes),
    updated_at: str(raw.updated_at),
  };
}

/**
 * Saves a full profile (not a patch) into the workspace's Company summary: the title, Website
 * line and the profile's sections are replaced, the rest of the document is kept. `author` is the summary author.
 */
export async function saveProfile(sql: Sql, ws: string, input: ProfileInput, author: string): Promise<Profile> {
  const profile = normalizeProfile(input as Record<string, unknown>);
  const current = await getCompanySummary(sql, ws);
  // Saving the structured view unchanged keeps the document as it is: rendering it again would drop anything written by
  // hand inside a section, and there's no history to get it back from.
  if (current.markdown) {
    const { updated_at: _a, ...before } = normalizeProfile(markdownToProfile(current.markdown, current.updated_at) as unknown as Record<string, unknown>) as Profile & { updated_at?: unknown };
    const { updated_at: _b, ...after } = profile as Profile & { updated_at?: unknown };
    if (JSON.stringify(before) === JSON.stringify(after)) return markdownToProfile(current.markdown, current.updated_at);
  }
  const saved = await writeCompanySummary(sql, ws, { markdown: profileToMarkdown(profile, current.markdown), author });
  return markdownToProfile(saved.markdown ?? "", saved.updated_at);
}

/** The profile read from the workspace's Company summary, or null when there is no summary yet. */
export async function getProfile(sql: Sql, ws: string): Promise<Profile | null> {
  const current = await getCompanySummary(sql, ws);
  return current.markdown === null ? null : markdownToProfile(current.markdown, current.updated_at);
}
