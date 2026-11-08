// Replies: every inbound reply, sorted into labels by the classifier. No Paper artboard of its own; built
// from the "Recent replies" card on Dashboard · Home and the table style of Dashboard · Leads.
import { useMemo, useState } from "react";
import { Link } from "react-router";
import type { Reply } from "../api.ts";
import { Page } from "../components/AppShell.tsx";
import { RepliesIcon } from "../components/icons.tsx";
import { ButtonLink, Card, EmptyState, QueryError, ReplyLabel, Skeleton, tabListKeys } from "../components/ui.tsx";
import { cx, timeAgo } from "../lib/format.ts";
import { useReplies } from "../queries.ts";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "positive", label: "Interested", match: ["interested"] },
  { id: "not_interested", label: "Not now", match: ["not_interested", "out_of_office"] },
  { id: "unsubscribe", label: "Unsubscribed", match: ["unsubscribe"] },
  { id: "other", label: "Other", match: ["other"] },
] as const;

export default function Replies() {
  const replies = useReplies();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const counts = useMemo(() => {
    const all = replies.data?.data ?? [];
    return Object.fromEntries(FILTERS.map((f) => [f.id, "match" in f ? all.filter((r) => (f.match as readonly string[]).includes(r.label ?? "other")).length : all.length]));
  }, [replies.data]);
  const active = FILTERS.find((f) => f.id === filter)!;
  const list = (replies.data?.data ?? []).filter((r) => !("match" in active) || (active.match as readonly string[]).includes(r.label ?? "other"));

  return (
    <Page className="gap-6 px-4 pb-14 pt-6 sm:px-12 sm:pt-10">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-2xl/7.5 font-semibold tracking-[-0.02em]">Replies</h1>
        <div className="text-sm/5 font-medium text-muted">Real inbound email only. Each one stops that lead's follow-ups.</div>
      </div>

      <div
        className="flex flex-wrap items-center gap-1 self-start rounded-[18px] border border-[#200D0D1A] bg-[#200D0D0A] p-1"
        role="tablist"
        aria-label="Reply labels"
        onKeyDown={tabListKeys(
          FILTERS.map((f) => f.id),
          filter,
          setFilter,
        )}
      >
        {FILTERS.map((f) => {
          const on = f.id === filter;
          return (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              onClick={() => setFilter(f.id)}
              className={cx("flex h-7 items-center gap-2 rounded-full pr-2", on ? "bg-lime pl-3.5" : "pl-3 hover:bg-[#200D0D08]")}
            >
              <span className={cx("text-[13px]/4 font-medium", on ? "text-ink" : "text-faint")}>{f.label}</span>
              <span className={cx("flex h-4 items-center rounded-full px-1.5 tabular-nums text-xs/3 font-medium", on ? "bg-[#BDE6893D] text-ink" : "bg-[#200D0D14] text-muted")}>
                {counts[f.id] ?? 0}
              </span>
            </button>
          );
        })}
      </div>

      {replies.isError ? <QueryError error={replies.error} what="replies" onRetry={() => void replies.refetch()} /> : null}

      <Card className="overflow-clip">
        <div className="hidden items-center gap-4 border-b border-b-[#200D0D14] bg-[#200D0D06] px-4.5 py-2.5 text-xs/4 font-medium text-muted sm:flex">
          <div className="w-40 shrink-0 xl:w-56">From</div>
          <div className="grow">Reply</div>
          <div className="w-28 shrink-0">Label</div>
          <div className="w-24 shrink-0 text-right">Received</div>
        </div>
        {replies.isPending ? (
          [0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-4 border-t border-t-[#200D0D0F] px-4.5 py-4 first:border-t-0">
              <Skeleton className="h-8 w-40 sm:w-56" />
              <Skeleton className="h-8 grow" />
            </div>
          ))
        ) : list.length ? (
          list.map((r) => <Row key={r.id} r={r} />)
        ) : (
          <EmptyState
            icon={<RepliesIcon />}
            title={filter === "all" ? "No replies yet" : `No ${active.label.toLowerCase()} replies`}
            body="When someone answers an approved email, the reply lands here, labeled Interested, Not now or Unsubscribed, and that lead's follow-ups stop."
            action={filter === "all" ? <ButtonLink to="/app/approvals" variant="soft">See what's waiting for approval</ButtonLink> : undefined}
          />
        )}
      </Card>
      {replies.data?.next_cursor ? <div className="text-xs/4 font-medium text-muted">Showing the newest 100 replies.</div> : null}
    </Page>
  );
}

function Row({ r }: { r: Reply }) {
  const content = (
    <>
      <div className="flex min-w-0 grow basis-0 flex-col gap-0.5 sm:w-40 sm:shrink-0 sm:grow-0 sm:basis-auto xl:w-56">
        <div className="truncate text-sm/4.5 font-medium text-ink">{r.lead?.name ?? r.from ?? "Unknown sender"}</div>
        <div className="truncate text-[11px]/3.5 text-muted">{r.lead?.company ?? (r.lead?.name ? r.from : "") ?? ""}</div>
      </div>
      <div className="order-1 flex min-w-0 grow basis-full flex-col gap-0.5 sm:order-none sm:basis-auto">
        <div className="truncate text-[13px]/4 font-medium text-ink">{r.subject ?? "(no subject)"}</div>
        <div className="truncate text-xs/4 font-medium text-muted">{r.preview ?? ""}</div>
      </div>
      <div className="shrink-0 sm:w-28">
        <ReplyLabel label={r.label} />
      </div>
      <div className="shrink-0 text-right text-[13px]/4 font-medium text-muted sm:w-24">{timeAgo(r.received_at)}</div>
    </>
  );
  // Phones: sender, label and time on top, the subject and preview under them.
  const cls = "flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-t-[#200D0D0F] px-4 py-3.5 first:border-t-0 sm:flex-nowrap sm:px-4.5";
  return r.lead_id ? (
    <Link to={`/app/leads/${encodeURIComponent(r.lead_id)}`} className={cx(cls, "hover:bg-[#200D0D05]")}>
      {content}
    </Link>
  ) : (
    <div className={cls}>{content}</div>
  );
}
