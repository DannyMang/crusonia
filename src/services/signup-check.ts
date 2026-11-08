// Who may get a new workspace, with its free credits: a person with a verified email that isn't a throwaway one. Clerk
// decides who a person is; a session token only says which user id it is, so this reads the email from Clerk, never from
// the token. Runs once per new workspace (src/api/auth.ts, POST /api/workspaces), so the extra call costs nothing per request.
import type { Env } from "../env.ts";
import { sha256, toHex } from "../lib/crypto.ts";
import { ApiError } from "../lib/errors.ts";
import { clerkUser, type ClerkProfile } from "../providers/clerk.ts";
import type { FetchFn } from "../providers/http.ts";
import { canonicalEmail, isDisposableEmail } from "./disposable-email.ts";

/** The address that vouches for this person: their primary one when it is verified, else the first verified one; never a throwaway. Pure. */
export function signupEmail(profile: Pick<ClerkProfile, "email" | "verified_emails">): string | null {
  const primary = profile.email?.trim().toLowerCase();
  const ordered = primary && profile.verified_emails.includes(primary) ? [primary, ...profile.verified_emails] : profile.verified_emails;
  return ordered.find((e) => !isDisposableEmail(e)) ?? null;
}

/** The settings key that marks a mailbox's free sample as taken (a hash: the settings table doesn't need the address). */
export const freeSampleKey = async (email: string) => `free_sample_email:${toHex(await sha256(canonicalEmail(email)))}`;

export type Admission = { freeSampleKey: string };

/** 403 email_not_verified, 403 email_not_allowed for a throwaway address, 503 clerk_unavailable when Clerk can't say. */
export async function admitNewUser(env: Env, userId: string, fetchFn?: FetchFn): Promise<Admission> {
  const profile = await clerkUser(env, userId, fetchFn);
  if (!profile) throw new ApiError(503, "clerk_unavailable", "Could not check your email address; try again");
  if (!profile.verified_emails.length) throw new ApiError(403, "email_not_verified", "Verify your email address to start using Crusonia");
  const email = signupEmail(profile);
  if (!email) throw new ApiError(403, "email_not_allowed", "Crusonia doesn't accept throwaway email addresses. Sign up with your work email.");
  return { freeSampleKey: await freeSampleKey(email) };
}
