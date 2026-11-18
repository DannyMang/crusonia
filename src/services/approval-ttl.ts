// How long a send approval (an email draft, from MCP create_draft or the REST API) stays open before the minute cron
// expires it: SEND_APPROVAL_TTL_HOURS, 7 days. Nothing is waiting on it, so the owner gets a week to review.
// Unset, empty or invalid values fall back to the default. Pure.
import type { Env } from "../env.ts";

export const DEFAULT_SEND_APPROVAL_TTL_HOURS = 168;

function positive(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Send approval lifetime in whole minutes (at least 1). */
export function sendApprovalTtlMinutes(env: Pick<Env, "SEND_APPROVAL_TTL_HOURS">): number {
  const hours = positive(env.SEND_APPROVAL_TTL_HOURS) ?? DEFAULT_SEND_APPROVAL_TTL_HOURS;
  return Math.max(1, Math.round(hours * 60));
}

/** "7 days", "48 hours", "90 minutes": for tool descriptions. */
export function describeMinutes(minutes: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (minutes % 1440 === 0) return unit(minutes / 1440, "day");
  if (minutes % 60 === 0) return unit(minutes / 60, "hour");
  return unit(minutes, "minute");
}
