// Left pane of "Dashboard · Approvals": the waiting list, grouped into "Expiring soon" and "Waiting".
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { ApprovalListItem } from "../../api.ts";
import { cx, timeLeft } from "../../lib/format.ts";
import { Skeleton } from "../ui.tsx";
import { msLeft, rowContext, rowSubtitle, rowTag, rowTitle, SOON_MS, ttlMinutes } from "./model.ts";

function Row({ a, selected, now }: { a: ApprovalListItem; selected: boolean; now: number }) {
  const urgent = msLeft(a, now) < SOON_MS;
  const sub = rowSubtitle(a);
  return (
    <Link
      to={`/app/approvals/${encodeURIComponent(a.code)}`}
      aria-current={selected ? "true" : undefined}
      className={cx(
        "flex h-15.5 shrink-0 flex-col justify-center gap-1.5 border-b border-b-[#200D0D1A] px-4",
        selected ? "bg-[#BDE6892E]" : "hover:bg-[#200D0D05]",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className={cx("max-w-[60%] shrink-0 truncate text-[13px]/4 text-ink", selected ? "font-semibold" : "font-medium")}>{rowTitle(a)}</span>
        <span className="min-w-0 grow truncate text-[13px]/4 font-medium text-muted">{sub}</span>
        <span className={cx("shrink-0 tabular-nums text-xs/4 font-medium", urgent ? "text-[#B42318]" : "text-ink")}>{timeLeft(a.expires_at, now)}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className={cx("flex h-4.5 shrink-0 items-center rounded-full px-1.75 text-[11px]/3.5 font-medium text-ink", selected ? "bg-lime" : "bg-pill")}>{rowTag(a)}</span>
        <span className="min-w-0 grow truncate text-xs/4 font-medium text-muted">{rowContext(a)}</span>
        <span className={cx("shrink-0 tabular-nums text-[11px]/3.5", selected ? "font-semibold text-ink" : "font-medium text-muted")}>{a.code}</span>
      </div>
    </Link>
  );
}

function GroupHeader({ title, note }: { title: string; note: string }) {
  return (
    <div className="flex h-8.5 shrink-0 items-center gap-2 border-b border-b-[#200D0D1A] bg-[#200D0D08] px-4">
      <h3 className="text-xs/4 font-semibold text-ink">{title}</h3>
      <span className="text-xs/4 font-medium text-muted">· {note}</span>
    </div>
  );
}

export function Queue({
  items,
  selectedCode,
  now,
  loading,
  emptyNote,
}: {
  items: ApprovalListItem[];
  selectedCode: string | undefined;
  now: number;
  loading: boolean;
  emptyNote?: ReactNode;
}) {
  const soon = items.filter((a) => msLeft(a, now) < SOON_MS);
  const rest = items.filter((a) => msLeft(a, now) >= SOON_MS);
  const ttl = ttlMinutes(items);
  return (
    <div className="flex w-100 shrink-0 flex-col border-r border-r-[#200D0D1A]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-b-[#200D0D1A] bg-[#200D0D06] px-4">
        <span className="text-xs/4 font-medium text-faint">Waiting for you</span>
        <span className="text-xs/4 font-medium text-faint">Expires</span>
      </div>
      <nav aria-label="Approvals waiting" className="flex min-h-0 grow flex-col overflow-y-auto">
        {loading ? (
          [0, 1, 2, 3].map((i) => (
            <div key={i} className="flex h-15.5 shrink-0 flex-col justify-center gap-2 border-b border-b-[#200D0D1A] px-4">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3.5 w-64" />
            </div>
          ))
        ) : items.length ? (
          <>
            {soon.length ? (
              <>
                <GroupHeader title="Expiring soon" note={`${soon.length} under 15 min`} />
                {soon.map((a) => (
                  <Row key={a.code} a={a} selected={a.code === selectedCode} now={now} />
                ))}
              </>
            ) : null}
            {rest.length ? (
              <>
                <GroupHeader title="Waiting" note={`${rest.length} · soonest first`} />
                {rest.map((a) => (
                  <Row key={a.code} a={a} selected={a.code === selectedCode} now={now} />
                ))}
              </>
            ) : null}
          </>
        ) : (
          (emptyNote ?? null)
        )}
      </nav>
      <div className="flex shrink-0 items-start gap-2.5 border-t border-t-[#200D0D1A] px-4 py-3.5">
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden className="mt-px shrink-0">
          <circle cx="12" cy="12" r="9" fill="none" stroke="rgb(32 13 13 / 55%)" strokeWidth="2" />
          <path d="M12 7v5l3 2" fill="none" stroke="rgb(32 13 13 / 55%)" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <p className="text-xs/4.25 font-medium text-muted">
          Each approval is bound to one recipient and one draft version, and expires{" "}
          {ttl ? `${ttl} min after it is requested` : "if nobody decides in time"}. Expired drafts go back to the agent.
        </p>
      </div>
    </div>
  );
}
