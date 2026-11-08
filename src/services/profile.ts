// The onboarding result: what the user sells and who to target. Stored in `settings` under key `profile`.
// TODO(workspaces): one profile per Clerk workspace once multi-tenant lands (key by workspace id).
import { z } from "zod";
import type { Sql } from "../db.ts";

const text = (max: number) => z.string().trim().min(1).max(max);

export const profileInputSchema = z.object({
  company_name: text(200).nullish().describe("The user's company name."),
  website: z.httpUrl().max(2048).describe("The user's company website."),
  sells: text(4000).describe("What the user sells, in one or two sentences (product, who it is for, the outcome it delivers)."),
  icp: text(8000).describe(
    "Ideal customer profile: industries, company size, geography, roles to contact (titles/seniority), and who to exclude.",
  ),
  segments: z
    .array(text(500))
    .max(20)
    .default([])
    .describe("Distinct target segments, e.g. 'Seed-Series B B2B SaaS in the US with a 2-10 person sales team'."),
  buying_signals: z
    .array(text(500))
    .max(30)
    .default([])
    .describe("Observable signals that a company is ready to buy, e.g. 'hiring first SDR', 'just raised a Series A'."),
  notes: text(8000).nullish().describe("Anything else worth keeping: competitors, pricing, objections, tone of voice."),
});
export type ProfileInput = z.infer<typeof profileInputSchema>;
export type Profile = ProfileInput & { updated_at: string };

/** Replaces the saved profile (send the full profile, not a patch). */
export async function saveProfile(sql: Sql, input: ProfileInput): Promise<Profile> {
  const profile: Profile = { ...input, updated_at: new Date().toISOString() };
  const rows = await sql`
    with up as (
      insert into settings (key, value) values ('profile', ${JSON.stringify(profile)}::jsonb)
      on conflict (key) do update set value = excluded.value
      returning value
    ),
    ev as (
      insert into events (lead_id, kind, data)
      select null, 'profile_saved', jsonb_build_object('via', 'mcp', 'website', value->>'website') from up
    )
    select value from up`;
  return rows[0]!.value as Profile;
}

export async function getProfile(sql: Sql): Promise<Profile | null> {
  const rows = await sql`select value from settings where key = 'profile'`;
  return (rows[0]?.value as Profile | undefined) ?? null;
}
