// The rules a send approval must pass, checked when the owner approves (right before sending).
// Pure, so they are unit tested; src/services/send.ts also re-asserts them inside the SQL that consumes
// the approval, so a concurrent change between this check and the send cannot slip through.
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type SendCheckInput = {
  approval: {
    kind: string;
    status: string;
    expires_at: Date | string;
    draft_id: string | null;
    recipient: string | null;
  };
  draft: { id: string; status: string; version: number } | null;
  /** Highest draft version for the lead: an approval is only valid for the latest version. */
  latestVersion: number | null;
  lead: { email: string | null; consent_at: Date | string | null } | null;
  suppressed: boolean;
  paused: boolean;
  now: Date;
};

export type SendCheck =
  | { ok: true }
  | { ok: false; status: ContentfulStatusCode; code: string; message: string };

const fail = (status: ContentfulStatusCode, code: string, message: string): SendCheck => ({ ok: false, status, code, message });

export function checkSendApproval(input: SendCheckInput): SendCheck {
  const { approval, draft, lead } = input;
  if (approval.kind !== "send") return fail(409, "wrong_kind", `This is a ${approval.kind} approval, not a send approval`);
  if (approval.status !== "pending") return fail(409, "approval_not_pending", `Approval is ${approval.status}`);
  if (new Date(approval.expires_at).getTime() <= input.now.getTime()) return fail(410, "approval_expired", "Approval has expired");
  if (!draft || draft.id !== approval.draft_id) return fail(409, "draft_missing", "The approved draft no longer exists");
  if (input.latestVersion !== null && draft.version !== input.latestVersion) {
    return fail(409, "draft_superseded", `Draft v${draft.version} was superseded by v${input.latestVersion}`);
  }
  if (draft.status !== "pending_approval") return fail(409, "draft_not_pending", `Draft is ${draft.status}`);
  if (!lead) return fail(409, "lead_missing", "The lead no longer exists");
  if (!approval.recipient || !lead.email || approval.recipient.toLowerCase() !== lead.email.toLowerCase()) {
    return fail(409, "recipient_mismatch", "The lead's email changed after this approval was requested");
  }
  if (!lead.consent_at) return fail(403, "no_consent", "This lead has not opted in to email; it can be researched but never emailed");
  if (input.suppressed) return fail(403, "suppressed", "The recipient is on the suppression list");
  if (input.paused) return fail(423, "paused", "Sending is paused (PUT /api/settings/pause to resume)");
  return { ok: true };
}
