// How long approvals stay open before the minute cron expires them. Two settings, because the two kinds
// wait on different things:
//   send approvals (email drafts, from MCP create_draft or the REST API): SEND_APPROVAL_TTL_HOURS, 7 days.
//     Nothing is waiting on them, so the owner gets a week to review.
//   tool and question approvals (a parked Naive session): TOOL_APPROVAL_TTL_MINUTES, 1 hour. The session
//     is blocked meanwhile; an expired tool call is denied to Naive (see expireStaleApprovals).
// Unset, empty or invalid values fall back to the defaults. Pure.
import type { Env } from "../env.ts";

export const DEFAULT_SEND_APPROVAL_TTL_HOURS = 168;
export const DEFAULT_TOOL_APPROVAL_TTL_MINUTES = 60;

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

/** Tool/question approval lifetime in whole minutes (at least 1). */
export function toolApprovalTtlMinutes(env: Pick<Env, "TOOL_APPROVAL_TTL_MINUTES">): number {
  const minutes = positive(env.TOOL_APPROVAL_TTL_MINUTES) ?? DEFAULT_TOOL_APPROVAL_TTL_MINUTES;
  return Math.max(1, Math.round(minutes));
}

/** "7 days", "48 hours", "90 minutes": for tool descriptions. */
export function describeMinutes(minutes: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (minutes % 1440 === 0) return unit(minutes / 1440, "day");
  if (minutes % 60 === 0) return unit(minutes / 60, "hour");
  return unit(minutes, "minute");
}
