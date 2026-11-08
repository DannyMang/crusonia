// Lead detail, right column: the latest draft with Approve (sends real email, two clicks), Edit (saves a new
// version with a new approval code) and Reject (optional reason). Draft text is untrusted: plain text only.
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import type { Approval, Draft, Lead } from "../../api.ts";
import { useApi } from "../../auth.tsx";
import { inputClass, textareaClass } from "../../components/leads/Overlay.tsx";
import { Button, Card, Pill, QueryError, type Tone } from "../../components/ui.tsx";
import { cx, timeLeft } from "../../lib/format.ts";
import { Spinner } from "../../components/icons.tsx";
import { keys } from "../../queries.ts";

export type ApproveMutation = UseMutationResult<Record<string, unknown>, Error, string>;

/** Invalidates everything an approval decision changes. */
export function useInvalidateLead(leadId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: keys.lead(leadId) });
    void qc.invalidateQueries({ queryKey: ["approvals"] });
    void qc.invalidateQueries({ queryKey: ["leads"] });
    void qc.invalidateQueries({ queryKey: keys.summary });
  };
}

const pillBase = "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full text-[13px]/4 font-medium transition-colors disabled:opacity-60";
/** Card-sized action buttons (h-8.5 in the design), built without overriding the shared Button's size classes. */
export const cardButton = {
  outline: cx(pillBase, "h-8.5 border border-ink bg-white px-4 text-ink hover:bg-[#200D0D08]"),
  reject: cx(pillBase, "h-8.5 border border-[#200D0D26] bg-white px-4 text-[#B42318] hover:bg-[#FDECEB]"),
};

/** Approving a send emails a real person, so it takes a second, deliberate click (like Home's ApproveButton). */
export function SendButton({
  approval,
  approve,
  label,
  size = "sm",
  className,
}: {
  approval: Approval;
  approve: ApproveMutation;
  label: string;
  size?: "sm" | "card";
  className?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(t);
  }, [confirming]);
  const height = size === "card" ? "h-8.5 px-4" : "h-7.5 px-3.5";
  if (approve.isSuccess && approve.variables === approval.code) {
    return <span className={cx(pillBase, height, "bg-[#16A34A1F] text-[#15803D]", className)}>Approved · sending</span>;
  }
  return (
    <button
      type="button"
      disabled={approve.isPending}
      aria-busy={approve.isPending || undefined}
      onClick={() => {
        if (confirming) {
          setConfirming(false);
          approve.mutate(approval.code);
        } else setConfirming(true);
      }}
      title={`Sends this exact draft to ${approval.recipient ?? "the lead"}`}
      className={cx(pillBase, height, confirming ? "bg-ink text-white" : "bg-lime text-ink hover:bg-[#b3de7a]", className)}
    >
      {approve.isPending ? <Spinner size={12} /> : null}
      {confirming ? `Send to ${approval.recipient ?? "the lead"}?` : label}
    </button>
  );
}

const DRAFT_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "outline" },
  pending_approval: { label: "Awaiting approval", tone: "lime" },
  sending: { label: "Sending", tone: "highlight" },
  sent: { label: "Sent", tone: "green" },
  send_failed: { label: "Send failed", tone: "red" },
  rejected: { label: "Rejected", tone: "red" },
  superseded: { label: "Superseded", tone: "gray" },
  cancelled: { label: "Cancelled", tone: "gray" },
};

function DraftStatus({ status }: { status: string }) {
  const s = DRAFT_STATUS[status] ?? { label: status.replace(/_/g, " "), tone: "outline" as Tone };
  return (
    <Pill tone={s.tone} className="h-5.5 px-2.25 text-xs/4 font-medium">
      {s.label}
    </Pill>
  );
}

/** Highlights citation markers like [1] without rendering any HTML from the draft. */
function withCitations(text: string): ReactNode[] {
  return text.split(/(\[\d{1,2}\])/g).map((part, i) =>
    /^\[\d{1,2}\]$/.test(part) ? (
      <span key={i} className="text-[11px] font-semibold tabular-nums text-green">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

export function DraftCard({
  lead,
  drafts,
  approval,
  approve,
}: {
  lead: Lead;
  drafts: Draft[];
  approval: Approval | undefined;
  approve: ApproveMutation;
}) {
  const api = useApi();
  const invalidate = useInvalidateLead(lead.id);
  const sorted = [...drafts].sort((a, b) => b.version - a.version);
  const draft = sorted.find((d) => d.id === approval?.draft_id) ?? sorted[0];
  const earlier = sorted.filter((d) => d !== draft);
  const [mode, setMode] = useState<"view" | "edit" | "reject">("view");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [reason, setReason] = useState("");

  const edit = useMutation({
    mutationFn: (v: { code: string; subject: string; body: string }) => api.editApproval(v.code, { subject: v.subject, body: v.body }),
    onSuccess: () => {
      setMode("view");
      invalidate();
    },
  });
  const reject = useMutation({
    mutationFn: (v: { code: string; reason?: string }) => api.reject(v.code, v.reason),
    onSuccess: () => {
      setMode("view");
      invalidate();
    },
  });

  if (!draft) {
    return (
      <Card className="flex flex-col overflow-clip">
        <div className="px-4 pb-3 pt-3.5 text-[15px]/4.5 font-semibold tracking-[-0.01em] text-ink">Draft</div>
        <div className="flex flex-col gap-1 border-t border-t-[#200D0D14] px-4 py-5">
          <div className="text-[13px]/4 font-semibold text-ink">No draft yet</div>
          <div className="text-xs/4.5 font-medium text-[#200D0D8C]">
            {lead.stage === "unsubscribed"
              ? "This lead unsubscribed, so no email is ever drafted or sent to them again."
              : lead.has_consent
              ? "After research, the agent writes a first email with a source behind every claim. It waits here until you approve it."
              : "This lead has no consent on file, so the agent never drafts or sends an email to them."}
          </div>
        </div>
      </Card>
    );
  }

  const live = approval && approval.status === "pending" && approval.kind === "send" && (!approval.draft_id || approval.draft_id === draft.id);
  const decided = (approve.isSuccess && approve.variables === approval?.code) || reject.isSuccess;
  const paragraphs = draft.body.split(/\n{2,}/).filter((p) => p.trim());
  const to = approval?.recipient ?? lead.email;

  return (
    <Card className="flex flex-col overflow-clip">
      <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-3.5">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-[15px]/4.5 font-semibold tracking-[-0.01em] text-ink">Draft</h2>
          <div className="text-xs/4 tabular-nums text-[#200D0D8C]">
            v{draft.version} · variant {draft.variant}
          </div>
        </div>
        <DraftStatus status={reject.isSuccess ? "rejected" : draft.status} />
      </div>

      {mode === "edit" && approval ? (
        <form
          className="flex flex-col gap-2.5 border-t border-t-[#200D0D14] px-4 pb-4 pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            edit.mutate({ code: approval.code, subject: subject.trim(), body });
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="text-xs/4 font-medium text-[#200D0D8C]">Subject</span>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} required className={inputClass} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs/4 font-medium text-[#200D0D8C]">Body</span>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} required rows={14} className={cx(textareaClass, "resize-y")} />
          </label>
          <div className="text-xs/4 font-medium text-[#200D0D8C]">
            Saving creates v{draft.version + 1} with a new approval code. It still waits for you; nothing sends.
          </div>
          {edit.isError ? <QueryError error={edit.error} what="editing drafts" /> : null}
          <div className="flex justify-end gap-2">
            <Button variant="soft" onClick={() => setMode("view")}>
              Cancel
            </Button>
            <Button type="submit" loading={edit.isPending} disabled={!subject.trim() || !body.trim()}>
              Save as v{draft.version + 1}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex flex-col gap-1.5 border-t border-t-[#200D0D14] px-4 py-3">
            <div className="flex gap-2.5">
              <div className="w-13 shrink-0 text-xs/4 font-medium text-[#200D0D8C]">To</div>
              <div className="min-w-0 wrap-anywhere text-xs/4 text-ink">{to ?? "No email yet"}</div>
            </div>
            <div className="flex gap-2.5">
              <div className="w-13 shrink-0 text-xs/4 font-medium text-[#200D0D8C]">Subject</div>
              <div className="min-w-0 text-[13px]/4 font-semibold text-ink">{draft.subject}</div>
            </div>
          </div>
          <div className="flex flex-col gap-2.5 border-t border-t-[#200D0D14] px-4 pb-4 pt-3.5">
            {paragraphs.map((p, i) => (
              <p key={i} className="whitespace-pre-wrap break-words text-[13px]/5 font-medium text-ink">
                {withCitations(p)}
              </p>
            ))}
            {draft.error ? (
              <div className="self-start rounded-full bg-[#C4873B1F] px-2 text-[11px]/4.5 font-medium text-[#A16207]">{draft.error}</div>
            ) : null}
          </div>
        </>
      )}

      {live && mode !== "edit" ? (
        <div className="flex flex-col gap-2.5 border-t border-t-[#200D0D14] bg-[#200D0D06] px-4 pb-3.5 pt-3">
          {mode === "reject" ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                reject.mutate({ code: approval.code, reason: reason.trim() || undefined });
              }}
            >
              <label className="flex flex-col gap-1">
                <span className="text-xs/4 font-medium text-[#200D0D8C]">Why? Optional, the agent reads this for its next draft</span>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Too long; lead with the job post" autoFocus className={inputClass} />
              </label>
              {reject.isError ? <QueryError error={reject.error} what="rejecting drafts" /> : null}
              <div className="flex justify-end gap-2">
                <Button variant="soft" onClick={() => setMode("view")}>
                  Cancel
                </Button>
                <Button type="submit" variant="danger" loading={reject.isPending}>
                  Reject draft
                </Button>
              </div>
            </form>
          ) : decided ? (
            <div className="text-[13px]/5 font-medium text-ink">
              {reject.isSuccess ? "Rejected. The agent can write a new version." : `Approved. Sending to ${to ?? "the lead"} now.`}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <SendButton approval={approval} approve={approve} label="Approve" size="card" className="grow" />
                <button
                  type="button"
                  className={cardButton.outline}
                  onClick={() => {
                    setSubject(draft.subject);
                    setBody(draft.body);
                    edit.reset();
                    setMode("edit");
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className={cardButton.reject}
                  onClick={() => {
                    setReason("");
                    reject.reset();
                    setMode("reject");
                  }}
                >
                  Reject
                </button>
              </div>
              <div className="text-xs/4 font-medium text-[#200D0D8C]">
                Approving sends this exact draft to {to ?? "the lead"} · code <span className="tabular-nums text-ink">{approval.code}</span> · expires in{" "}
                {timeLeft(approval.expires_at)}
              </div>
            </>
          )}
          {approve.isError && approve.variables === approval.code ? <QueryError error={approve.error} what="sending" /> : null}
        </div>
      ) : null}

      {edit.isSuccess && mode === "view" ? (
        <div className="border-t border-t-[#200D0D14] px-4 py-2.5 text-xs/4 font-medium text-[#200D0D8C]">
          Saved as v{edit.data.draft?.version ?? draft.version + 1} · new code <span className="tabular-nums text-ink">{edit.data.approval.code}</span>
        </div>
      ) : null}

      {earlier.length ? (
        <div className="flex flex-col gap-1 border-t border-t-[#200D0D14] px-4 py-2.5">
          <div className="text-xs/4 font-medium text-[#200D0D8C]">Earlier versions</div>
          {earlier.slice(0, 4).map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-1.5 text-xs/4 font-medium text-ink">
              <span className="tabular-nums">v{d.version}</span>
              <span className="text-[#200D0D8C]">{(DRAFT_STATUS[d.status]?.label ?? d.status).toLowerCase()}</span>
              {d.error ? <span className="rounded-full bg-[#C4873B1F] px-2 text-[11px]/4.5 text-[#A16207]">{d.error}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
