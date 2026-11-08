// Right pane for a `send` approval: the exact draft, what the approval is bound to, why this lead, and
// Approve & send (two-step: it emails a real person) / Edit (new version + new code) / Reject.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { Link } from "react-router";
import type { ApprovalListItem, LeadFull } from "../../api.ts";
import { useApi } from "../../auth.tsx";
import { cx, hostOf, shortDate } from "../../lib/format.ts";
import { keys, useLead } from "../../queries.ts";
import { Skeleton } from "../ui.tsx";
import { safeHref, shortUrl } from "./model.ts";
import { ActionBar, ActionButton, Bound, BindingStrip, DetailHead, ReasonRow, useDisarm, useKeys, type OnDecided } from "./parts.tsx";

type Mode = "view" | "confirm" | "edit" | "reject";

const SOURCE: Record<string, string> = {
  apify: "found on the web",
  agent: "added by your agent",
  mcp: "added by your agent",
  hubspot: "from HubSpot",
  csv: "from a CSV import",
  manual: "added by hand",
};

export function SendDetail({ a, now, onDecided }: { a: ApprovalListItem; now: number; onDecided: OnDecided }) {
  const api = useApi();
  const qc = useQueryClient();
  const lead = useLead(a.lead_id ?? undefined);
  const draft = a.draft;
  const to = a.recipient ?? a.lead?.email ?? "the lead";
  const [mode, setMode] = useState<Mode>("view");
  const [subject, setSubject] = useState(draft?.subject ?? "");
  const [body, setBody] = useState(draft?.body ?? "");
  const [reason, setReason] = useState("");

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["approvals"] });
    void qc.invalidateQueries({ queryKey: keys.summary });
    if (a.lead_id) void qc.invalidateQueries({ queryKey: keys.lead(a.lead_id) });
  };
  const approve = useMutation({
    mutationFn: () => api.approve(a.code),
    onSuccess: (res) =>
      onDecided(a.code, res.status === "sent" ? `Sent to ${to}` : `Approved ${a.code}. Sending to ${to}; the inbox confirms shortly.`),
    onError: () => setMode("view"),
    onSettled: invalidate,
  });
  const reject = useMutation({
    mutationFn: () => api.reject(a.code, reason.trim() || undefined),
    onSuccess: () => onDecided(a.code, `Rejected ${a.code}. The draft goes back to the agent.`),
    onSettled: invalidate,
  });
  const edit = useMutation({
    mutationFn: () =>
      api.editApproval(a.code, {
        ...(subject.trim() !== draft?.subject ? { subject: subject.trim() } : {}),
        ...(body.trim() !== draft?.body?.trim() ? { body: body.trim() } : {}),
      }),
    onSuccess: (res) => onDecided(a.code, `Saved as v${res.draft?.version ?? (draft?.version ?? 0) + 1}. New code ${res.approval.code}.`, res.approval.code),
    onSettled: invalidate,
  });
  const busy = approve.isPending || reject.isPending || edit.isPending;
  const changed = subject.trim() !== (draft?.subject ?? "") || body.trim() !== (draft?.body ?? "").trim();
  const canSave = changed && subject.trim().length > 0 && body.trim().length > 0;

  const pressApprove = () => {
    if (busy || !draft) return;
    if (mode === "confirm") approve.mutate();
    else setMode("confirm");
  };
  const startEdit = () => {
    if (busy || !draft) return;
    setSubject(draft.subject);
    setBody(draft.body);
    setMode("edit");
  };
  const cancel = () => setMode("view");
  useDisarm(mode === "confirm", useCallback(() => setMode((m) => (m === "confirm" ? "view" : m)), []));
  useKeys({
    a: mode === "view" || mode === "confirm" ? pressApprove : undefined,
    e: mode === "view" ? startEdit : undefined,
    r: mode === "view" ? () => setMode("reject") : undefined,
    escape: mode !== "view" && !busy ? cancel : undefined,
  });

  const full = lead.data;
  const l = full?.lead;
  const nextVersion = (draft?.version ?? 0) + 1;
  // Send approvals come from create_draft and carry no session id; the lead's latest research run wrote the draft.
  const sessionId =
    a.naive_session_id ??
    [...(full?.sessions ?? [])].filter((x) => x.purpose === "research").sort((x, y) => y.created_at.localeCompare(x.created_at))[0]?.id ??
    null;

  return (
    <>
      <DetailHead
        a={a}
        now={now}
        sessionId={sessionId}
        title={a.lead?.name ?? a.lead?.company ?? to}
        aside={a.lead?.name ? [l?.title, a.lead.company].filter(Boolean).join(", ") || null : null}
      />
      <BindingStrip>
        <Bound label="To">{to}</Bound>
        {draft ? (
          <Bound label="Draft" mono>
            v{draft.version}
          </Bound>
        ) : null}
        {draft?.variant ? <Bound label="Variant">{draft.variant}</Bound> : null}
        {a.lead ? <Consent has={a.lead.has_consent} full={full} /> : null}
      </BindingStrip>

      <div className="flex min-h-0 grow flex-col gap-3 overflow-y-auto px-5 py-3.5">
        {draft ? (
          <div className="flex shrink-0 flex-col rounded-[10px] border border-[#200D0D1A]">
            <div className="flex items-baseline gap-2.5 border-b border-b-[#200D0D14] px-3.5 py-2.5">
              <label htmlFor={`subject-${a.code}`} className="w-13 shrink-0 text-xs/4 font-medium text-[#200D0D8C]">
                Subject
              </label>
              {mode === "edit" ? (
                <input
                  id={`subject-${a.code}`}
                  autoFocus
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  maxLength={200}
                  className="-my-1 min-w-0 grow rounded-md border border-[#200D0D26] px-2 py-1 text-sm/5 font-semibold text-ink outline-none focus:border-[#200D0D59]"
                />
              ) : (
                <div id={`subject-${a.code}`} className="min-w-0 text-sm/5 font-semibold text-ink">
                  {draft.subject}
                </div>
              )}
            </div>
            <div className="pb-3 pl-19 pr-3.5 pt-2.5">
              {mode === "edit" ? (
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSave) edit.mutate();
                    if (e.key === "Escape" && !busy) cancel();
                  }}
                  maxLength={10_000}
                  aria-label="Email body"
                  className="-mx-2 -my-1 block min-h-48 w-[calc(100%+16px)] resize-y rounded-md border border-[#200D0D26] px-2 py-1 text-sm/5 font-medium text-ink outline-none [field-sizing:content] focus:border-[#200D0D59]"
                />
              ) : (
                <div className="whitespace-pre-wrap break-words text-sm/5 font-medium text-ink">{draft.body}</div>
              )}
            </div>
          </div>
        ) : (
          <div className="rounded-[10px] border border-[#200D0D1A] px-3.5 py-3 text-[13px]/5 font-medium text-[#200D0D99]">
            The draft for this approval is no longer available. {a.summary}
          </div>
        )}
        {a.lead_id ? <WhyThisLead full={full} loading={lead.isLoading} failed={lead.isError} sessionId={sessionId} /> : null}
      </div>

      <ActionBar
        error={approve.error ?? reject.error ?? edit.error}
        note={
          mode === "edit" ? (
            <>
              Saving creates <span className="tabular-nums text-ink">v{nextVersion}</span> and voids {a.code}; you get a new code to approve.
            </>
          ) : mode === "confirm" ? (
            <>
              Press <span className="text-ink">A</span> or click again to email <span className="text-ink">{to}</span> now.
            </>
          ) : (
            <>
              Edit creates <span className="tabular-nums text-ink">v{nextVersion}</span> and voids this approval; the agent asks again with a new code.
            </>
          )
        }
      >
        {mode === "reject" ? (
          <ReasonRow
            value={reason}
            onChange={setReason}
            onSubmit={() => reject.mutate()}
            onCancel={cancel}
            loading={reject.isPending}
            submitLabel="Reject draft"
            placeholder="Reason for the agent (optional)"
          />
        ) : mode === "edit" ? (
          <>
            <ActionButton tone="primary" loading={edit.isPending} disabled={!canSave} onClick={() => edit.mutate()} title="⌘ Enter">
              Save as v{nextVersion}
            </ActionButton>
            <ActionButton onClick={cancel} disabled={edit.isPending}>
              Cancel
            </ActionButton>
          </>
        ) : (
          <>
            <ActionButton
              tone={mode === "confirm" ? "confirm" : "primary"}
              kbd="A"
              loading={approve.isPending}
              disabled={!draft}
              onClick={pressApprove}
              title={`Emails ${to}`}
            >
              {mode === "confirm" ? "Send now?" : "Approve & send"}
            </ActionButton>
            <ActionButton kbd="E" onClick={startEdit} disabled={busy || !draft}>
              Edit
            </ActionButton>
            <ActionButton tone="danger" kbd="R" onClick={() => setMode("reject")} disabled={busy}>
              Reject
            </ActionButton>
          </>
        )}
      </ActionBar>
    </>
  );
}

function Consent({ has, full }: { has: boolean; full: LeadFull | undefined }) {
  const l = full?.lead;
  const yes = l ? l.has_consent : has;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className={cx("size-1.5 shrink-0 rounded-full", yes ? "bg-green" : "bg-[#B42318]")} />
      <span className="truncate font-medium text-ink">
        {yes ? (l?.consent_at ? `Opted in ${shortDate(l.consent_at)}` : "Opted in") : "No consent on file"}
        {yes && l?.consent_text ? <span className="text-[#200D0D80]"> · {l.consent_text}</span> : null}
      </span>
    </span>
  );
}

/** Splits "[1]" style citation markers out of plain text so they can be tinted (still rendered as text). */
function Cited({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\[\d+\])/).map((part, i) =>
        /^\[\d+\]$/.test(part) ? (
          <span key={i} className="text-[11px] font-semibold text-green">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

function WhyThisLead({ full, loading, failed, sessionId }: { full: LeadFull | undefined; loading: boolean; failed: boolean; sessionId: string | null }) {
  const l = full?.lead;
  const evidence = full?.evidence ?? [];
  const meta = l ? [hostOf(l.website ?? l.domain), SOURCE[l.source] ?? (l.source ? `source: ${l.source}` : null)].filter(Boolean).join(" · ") : "";
  return (
    <section className="flex shrink-0 flex-col gap-2 rounded-[10px] border border-panel-line bg-panel px-3.5 py-3">
      <div className="flex items-center gap-2">
        <h3 className="text-[13px]/4 font-semibold text-ink">Why this lead</h3>
        {l?.score !== null && l?.score !== undefined ? (
          <span className="flex h-5 shrink-0 items-center rounded-full bg-lime px-1.75 text-[11px]/3.5 font-semibold tabular-nums text-ink">score {l.score}</span>
        ) : null}
        <span className="min-w-0 grow truncate text-xs/4 font-medium text-[#200D0D8C]">{meta}</span>
        {l ? (
          <Link to={`/app/leads/${encodeURIComponent(l.id)}`} className="shrink-0 text-xs/4 font-medium text-ink underline decoration-1 underline-offset-[3px]">
            Open lead
          </Link>
        ) : null}
        {sessionId ? (
          <Link to={`/app/workflows/runs/${encodeURIComponent(sessionId)}`} className="shrink-0 text-xs/4 font-medium text-ink underline decoration-1 underline-offset-[3px]">
            Open run
          </Link>
        ) : null}
      </div>
      {loading ? (
        <div className="flex flex-col gap-2 py-1">
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-full" />
        </div>
      ) : failed || !l ? (
        <p className="text-[13px]/4.75 font-medium text-[#200D0D99]">The research for this lead could not be loaded. The draft above is exactly what will be sent.</p>
      ) : (
        <>
          {l.rationale ? (
            <p className="text-[13px]/4.75 font-medium text-ink">
              <Cited text={l.rationale} />
            </p>
          ) : null}
          {evidence.length ? (
            <ol className="flex flex-col border-t border-t-panel-line">
              {evidence.map((ev, i) => {
                const href = safeHref(ev.source_url);
                return (
                  <li key={ev.id} className="flex h-7 shrink-0 items-center gap-2.5 border-b border-b-panel-line last:border-b-0">
                    <span className="w-5 shrink-0 text-[11px]/3.5 font-semibold tabular-nums text-green">[{i + 1}]</span>
                    <span className="min-w-0 grow truncate text-[13px]/4 font-medium text-ink" title={ev.claim}>
                      {ev.claim}
                    </span>
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer" className="max-w-[45%] shrink-0 truncate text-[11px]/3.5 text-[#200D0D99] hover:text-ink hover:underline">
                        {shortUrl(ev.source_url)}
                      </a>
                    ) : (
                      <span className="max-w-[45%] shrink-0 truncate text-[11px]/3.5 text-[#200D0D99]">{shortUrl(ev.source_url)}</span>
                    )}
                  </li>
                );
              })}
            </ol>
          ) : null}
          {!l.rationale && !evidence.length ? (
            <p className="text-[13px]/4.75 font-medium text-[#200D0D99]">No research saved for this lead yet. Every claim in a draft should link to a source the agent saved.</p>
          ) : null}
        </>
      )}
    </section>
  );
}
