// Lead detail, middle column: the agent timeline built from `events` rows (newest first from the API, shown
// oldest first like the design). Event data is untrusted agent output: shown as small plain text.
import { useState } from "react";
import type { Approval, TimelineEvent } from "../../api.ts";
import { RingSpinner } from "../../components/ui.tsx";
import { cx, duration, plural, usd } from "../../lib/format.ts";
import { stamp } from "./shared.ts";

const TITLES: Record<string, string> = {
  lead_added: "Found",
  lead_email_found: "Email found",
  lead_updated: "Details updated",
  research_started: "Research started",
  research_done: "Researched",
  evidence_saved: "Evidence saved",
  lead_scored: "Scored",
  consent_checked: "Consent checked",
  consent_revoked: "Consent removed",
  draft_created: "Drafted",
  approval_requested: "Approval requested",
  approval_approved: "Approved",
  approval_rejected: "Rejected",
  approval_expired: "Approval expired",
  approval_closed: "Approval closed",
  email_sent: "Sent",
  email_delivered: "Delivered",
  email_send_failed: "Send failed",
  email_send_unknown: "Send status unknown",
  send_refused: "Send blocked",
  email_received: "Reply received",
  reply_classified: "Reply sorted",
  email_bounced: "Bounced",
  email_complained: "Marked as spam",
  followups_stopped: "Follow-ups stopped",
  suppression_added: "Suppressed",
  suppression_removed: "Removed from suppression list",
  naive_idle: "Agent waiting",
  naive_tool_auto_allowed: "Tool call allowed by a rule",
  lead_deleted: "Deleted",
};

const BAD = new Set(["email_send_failed", "send_refused", "email_bounced", "email_complained", "approval_expired"]);

export const eventTitle = (kind: string) => TITLES[kind] ?? kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Keys that are noise in the timeline or shown elsewhere in the row. */
const HIDDEN = new Set(["cost_usd"]);

function show(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 79)}…` : v;
  if (Array.isArray(v)) {
    if (!v.length) return null;
    return v.every((x) => typeof x === "string" || typeof x === "number") && v.join(", ").length <= 60 ? v.join(", ") : plural(v.length, "item");
  }
  try {
    const s = JSON.stringify(v);
    return s.length > 80 ? `${s.slice(0, 79)}…` : s;
  } catch {
    return null;
  }
}

function DataChips({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data ?? {})
    .filter(([k]) => !HIDDEN.has(k))
    .map(([k, v]) => [k.replace(/_/g, " "), show(v)] as const)
    .filter((e): e is readonly [string, string] => e[1] !== null);
  if (!entries.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {entries.map(([k, v]) => (
        <span key={k} className="flex h-4.5 max-w-full items-center truncate rounded-md bg-pill px-1.75 text-[11px]/3.5 text-[#200D0DB3]">
          <span className="text-faint">{k}</span>&nbsp;{v}
        </span>
      ))}
    </div>
  );
}

const SHOW = 8;

export function Timeline({ events, pending }: { events: TimelineEvent[]; pending: Approval[] }) {
  const [all, setAll] = useState(false);
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const hidden = all ? 0 : Math.max(0, ordered.length - SHOW);
  const shown = ordered.slice(hidden);
  const pendingCodes = new Map(pending.map((a) => [a.code, a]));
  const sendPending = pending.find((a) => a.kind === "send");
  const first = ordered[0];
  const last = ordered.at(-1);
  const span = first && last ? new Date(last.created_at).getTime() - new Date(first.created_at).getTime() : 0;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2.5">
        <h2 className="text-[15px]/4.5 font-semibold tracking-[-0.01em] text-ink">Agent timeline</h2>
        <div className="text-[13px]/4 font-medium text-muted">
          {ordered.length ? [plural(ordered.length, "step"), span > 60_000 ? `over ${duration(span)}` : null].filter(Boolean).join(" · ") : "nothing yet"}
        </div>
      </div>
      <div className="flex flex-col overflow-clip rounded-xl border border-[#200D0D1A]">
        {!ordered.length ? (
          <div className="flex flex-col gap-1 px-4 py-5">
            <div className="text-[13px]/4 font-semibold text-ink">No activity yet</div>
            <div className="text-xs/4.5 font-medium text-muted">
              Every step the agent takes on this lead (research, scoring, drafting, sending, replies) is logged here with its time.
            </div>
          </div>
        ) : null}
        {hidden ? (
          <button type="button" onClick={() => setAll(true)} className="flex h-9 items-center gap-2 bg-[#200D0D06] px-4 text-left text-xs/4 font-medium text-ink hover:underline">
            Show {plural(hidden, "earlier step")}
          </button>
        ) : null}
        {shown.map((e, i) => {
          const n = hidden + i + 1;
          const cost = typeof e.data?.cost_usd === "number" ? e.data.cost_usd : null;
          const waiting = e.kind === "approval_requested" && typeof e.data?.code === "string" ? pendingCodes.get(e.data.code) : undefined;
          return (
            <div
              key={e.id}
              className={cx("flex flex-col gap-1.25 px-4 py-2.75", (i > 0 || hidden > 0) && "border-t border-t-[#200D0D14]", waiting && "bg-panel")}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="text-[11px]/3.5 font-medium tabular-nums text-faint">#{n}</span>
                  <span className={cx("truncate text-xs/4 font-semibold", BAD.has(e.kind) ? "text-[#B42318]" : "text-ink")}>{eventTitle(e.kind)}</span>
                </div>
                <time dateTime={e.created_at} className="shrink-0 text-[11px]/3.5 font-medium tabular-nums text-faint">
                  {stamp(e.created_at)}
                  {cost !== null ? ` · ${usd(cost)}` : ""}
                </time>
              </div>
              {waiting ? (
                <div className="flex items-center gap-2">
                  <RingSpinner />
                  <span className="text-[13px]/4.25 font-medium text-ink">
                    Waiting on you · {duration(Date.now() - new Date(waiting.created_at).getTime())}
                  </span>
                </div>
              ) : null}
              <DataChips data={e.data} />
            </div>
          );
        })}
        {sendPending && ordered.length ? (
          <div className="flex flex-col gap-1 border-t border-t-[#200D0D14] px-4 pb-3 pt-2.5">
            <div className="flex gap-2.5 text-[11px]/4 font-medium text-faint">
              <span className="w-5 shrink-0 tabular-nums">#{ordered.length + 1}</span>
              <span>Send · goes out after you approve the draft</span>
            </div>
            <div className="flex gap-2.5 text-[11px]/4 font-medium text-faint">
              <span className="w-5 shrink-0 tabular-nums">#{ordered.length + 2}</span>
              <span>Reply · sorted into Interested, Not now or Unsubscribed</span>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
