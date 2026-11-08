// The onboarding result: what the user sells and who to target. Stored in `settings` under key `profile`.
// Written by the MCP save_profile tool (agents) and PUT /api/profile (the web app); both send the full
// profile. Profiles saved in the first shape (company_name, icp, segments and buying_signals as strings)
// are read back in the current shape by normalizeProfile.
// TODO(workspaces): one profile per Clerk workspace once multi-tenant lands (key by workspace id).
import { z } from "zod";
import type { Sql } from "../db.ts";

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

/** Replaces the saved profile (send the full profile, not a patch). `via` labels the audit event. */
export async function saveProfile(sql: Sql, input: ProfileInput, via: "mcp" | "api" = "mcp", actor?: string): Promise<Profile> {
  const profile: Profile = { ...normalizeProfile(input as Record<string, unknown>), updated_at: new Date().toISOString() };
  const rows = await sql`
    with up as (
      insert into settings (key, value) values ('profile', ${JSON.stringify(profile)}::jsonb)
      on conflict (key) do update set value = excluded.value
      returning value
    ),
    ev as (
      insert into events (lead_id, kind, data)
      select null, 'profile_saved', jsonb_build_object('via', ${via}::text, 'website', value->>'website', 'actor', ${actor ?? null}::text) from up
    )
    select value from up`;
  return normalizeProfile(rows[0]!.value as Record<string, unknown>);
}

export async function getProfile(sql: Sql): Promise<Profile | null> {
  const rows = await sql`select value from settings where key = 'profile'`;
  const value = rows[0]?.value as Record<string, unknown> | undefined;
  return value ? normalizeProfile(value) : null;
}
