// Clerk Backend API: reading users. Clerk decides who a person is; a session token only says which user id it is, so
// anything that depends on an email (accepting an invite) reads it here, never from the token.
import type { Env } from "../env.ts";
import { defaultFetch, type FetchFn } from "./http.ts";

const BASE = "https://api.clerk.com/v1";
/** Clerk's page size for GET /users. */
const PAGE = 100;

type RawUser = {
  id: string;
  primary_email_address_id?: string | null;
  email_addresses?: { id: string; email_address: string; verification?: { status?: string | null } | null }[];
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  image_url?: string | null;
  has_image?: boolean;
};

export type ClerkProfile = {
  id: string;
  /** The primary address, verified or not: for display only. */
  email?: string;
  name?: string;
  /** A photo the person chose. Clerk's generated placeholder doesn't count: the app shows initials instead. */
  image_url?: string;
  /** Lowercased. Only these prove the user owns an address. */
  verified_emails: string[];
};

function toProfile(u: RawUser): ClerkProfile {
  const emails = u.email_addresses ?? [];
  const email = (emails.find((e) => e.id === u.primary_email_address_id) ?? emails[0])?.email_address;
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || undefined;
  return {
    id: u.id,
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    ...(u.image_url && u.has_image ? { image_url: u.image_url } : {}),
    verified_emails: emails.filter((e) => e.verification?.status === "verified").map((e) => e.email_address.trim().toLowerCase()),
  };
}

/** One user, or null when Clerk is not configured, does not answer, or has no such user. */
export async function clerkUser(env: Env, userId: string, fetchFn: FetchFn = defaultFetch): Promise<ClerkProfile | null> {
  if (!env.CLERK_SECRET_KEY) return null;
  try {
    const res = await fetchFn(`${BASE}/users/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    return res.ok ? toProfile((await res.json()) as RawUser) : null;
  } catch {
    return null;
  }
}

/** Several users by id, best effort: whoever Clerk does not return is simply missing from the map. */
export async function clerkUsers(env: Env, ids: string[], fetchFn: FetchFn = defaultFetch): Promise<Map<string, ClerkProfile>> {
  const out = new Map<string, ClerkProfile>();
  if (!env.CLERK_SECRET_KEY) return out;
  for (let i = 0; i < ids.length; i += PAGE) {
    const qs = new URLSearchParams({ limit: String(PAGE) });
    for (const id of ids.slice(i, i + PAGE)) qs.append("user_id", id);
    try {
      const res = await fetchFn(`${BASE}/users?${qs}`, { headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      for (const u of (await res.json()) as RawUser[]) out.set(u.id, toProfile(u));
    } catch {
      // Best effort: the caller shows the user id.
    }
  }
  return out;
}
