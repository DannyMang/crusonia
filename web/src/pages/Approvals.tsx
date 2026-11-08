// Dashboard · Approvals (Paper artboard "Dashboard · Approvals"): the queue of drafts, tool calls and agent
// questions waiting for a human, with the selected one on the right. /app/approvals/:code selects an approval.
// Real data from /api/approvals; approving a send emails a real person, so it takes two deliberate presses.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import type { ApprovalKind, ApprovalListItem, ApprovalStatus } from "../api.ts";
import { useApi } from "../auth.tsx";
import { Page } from "../components/AppShell.tsx";
import { QuestionDetail, ToolDetail } from "../components/approvals/AgentDetail.tsx";
import { FilterChip, isTypingTarget, SearchField, updatedAgo, useNow, useSlashToFocus } from "../components/approvals/controls.tsx";
import { matchesSearch, workflowOf } from "../components/approvals/model.ts";
import type { OnDecided } from "../components/approvals/parts.tsx";
import { Queue } from "../components/approvals/Queue.tsx";
import { SendDetail } from "../components/approvals/SendDetail.tsx";
import { CodeState, DetailSkeleton, NothingSelected } from "../components/approvals/States.tsx";
import { ApprovalsIcon } from "../components/icons.tsx";
import { Button, ButtonLink, EmptyState, QueryError } from "../components/ui.tsx";
import { keys, useApprovals } from "../queries.ts";

const KINDS = [
  { value: "", label: "Any" },
  { value: "send", label: "Emails" },
  { value: "tool", label: "Tool calls" },
  { value: "question", label: "Questions" },
];

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Decided today (approved / expired), for the counts on the right of the filter row. */
function useDecidedToday(status: ApprovalStatus) {
  const api = useApi();
  const filters = { status, limit: 200 };
  const q = useQuery({ queryKey: keys.approvals(filters), queryFn: () => api.approvals(filters), refetchInterval: 60_000 });
  if (!q.data) return null;
  const since = startOfToday();
  const n = q.data.data.filter((a) => a.decided_via !== "superseded" && new Date(a.decided_at ?? a.created_at).getTime() >= since).length;
  return q.data.data.length >= 200 && n >= 200 ? "200+" : String(n);
}

export default function Approvals() {
  const { code: rawCode } = useParams();
  const code = rawCode?.toUpperCase();
  const navigate = useNavigate();
  const now = useNow(1000);
  const [kind, setKind] = useState<"" | ApprovalKind>("");
  const [workflow, setWorkflow] = useState("");
  const [variant, setVariant] = useState("");
  const [search, setSearch] = useState("");
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [toast, setToast] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashToFocus(searchRef);

  const pending = useApprovals(kind ? { status: "pending", kind } : { status: "pending" });
  const approvedToday = useDecidedToday("approved");
  const expiredToday = useDecidedToday("expired");

  const all = useMemo(() => (pending.data?.data ?? []).filter((a) => !hidden.has(a.code)), [pending.data, hidden]);
  const workflows = useMemo(() => [...new Set(all.map(workflowOf).filter((w): w is string => Boolean(w)))].sort(), [all]);
  const variants = useMemo(() => [...new Set(all.map((a) => a.draft?.variant).filter((v): v is string => Boolean(v)))].sort(), [all]);
  const filtering = Boolean(kind || workflow || variant || search.trim());
  const ordered = useMemo(
    () =>
      all
        .filter((a) => (!workflow || workflowOf(a) === workflow) && (!variant || a.draft?.variant === variant) && matchesSearch(a, search))
        .sort((x, y) => new Date(x.expires_at).getTime() - new Date(y.expires_at).getTime()),
    [all, workflow, variant, search],
  );
  const selected = code ? (all.find((a) => a.code === code) ?? null) : null;

  const clearFilters = () => {
    setKind("");
    setWorkflow("");
    setVariant("");
    setSearch("");
  };

  // J / K move through the visible queue (and open the first item when nothing is selected).
  const orderedRef = useRef(ordered);
  orderedRef.current = ordered;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((k !== "j" && k !== "k") || isTypingTarget(e)) return;
      const list = orderedRef.current;
      if (!list.length) return;
      e.preventDefault();
      const i = list.findIndex((a) => a.code === code);
      const next = i === -1 ? list[0] : list[Math.min(list.length - 1, Math.max(0, i + (k === "j" ? 1 : -1)))];
      if (next && next.code !== code) navigate(`/app/approvals/${encodeURIComponent(next.code)}`, { replace: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [code, navigate]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const onDecided: OnDecided = (decided, message, replacement) => {
    const list = orderedRef.current;
    const i = list.findIndex((a) => a.code === decided);
    const rest = list.filter((a) => a.code !== decided);
    const next = replacement ?? (i === -1 ? undefined : (rest[i] ?? rest[i - 1])?.code);
    setHidden((h) => new Set(h).add(decided));
    setToast(message);
    navigate(next ? `/app/approvals/${encodeURIComponent(next)}` : "/app/approvals", { replace: true });
  };

  const counts = [
    pending.data ? (all.length || kind ? `${all.length} waiting` : "Nothing waiting") : null,
    approvedToday && approvedToday !== "0" ? `${approvedToday} approved today` : null,
    expiredToday && expiredToday !== "0" ? `${expiredToday} expired` : null,
    pending.dataUpdatedAt ? updatedAgo(pending.dataUpdatedAt, now) : null,
  ].filter(Boolean);

  const loading = pending.isLoading;
  const empty = !loading && !pending.isError && all.length === 0 && !kind;

  return (
    <Page className="h-screen min-h-160 gap-5 px-8 pb-6 pt-8">
      <div className="flex h-9 shrink-0 items-center justify-between gap-6">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-xl/7 font-semibold tracking-[-0.01em] text-ink">Approvals</h1>
          <p className="truncate text-[13px]/4 font-medium text-[#200D0D8C]">Nothing is sent until someone approves the exact draft.</p>
        </div>
        <SearchField inputRef={searchRef} value={search} onChange={setSearch} placeholder="Search recipient, company, code" className="h-8 w-65" />
      </div>

      <div className="flex h-7.5 shrink-0 items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          {empty ? null : <FilterChip label="Kind" value={kind} options={KINDS} onChange={(v) => setKind(v as "" | ApprovalKind)} />}
          {workflows.length ? (
            <FilterChip label="Workflow" value={workflow} options={[{ value: "", label: "Any" }, ...workflows.map((w) => ({ value: w, label: w }))]} onChange={setWorkflow} />
          ) : null}
          {variants.length ? (
            <FilterChip label="Variant" value={variant} options={[{ value: "", label: "Any" }, ...variants.map((v) => ({ value: v, label: v }))]} onChange={setVariant} />
          ) : null}
          {filtering ? (
            <button type="button" onClick={clearFilters} className="h-7.5 rounded-full px-2.5 text-[13px]/4 font-medium text-[#200D0D99] hover:bg-[#200D0D08] hover:text-ink">
              Clear
            </button>
          ) : null}
        </div>
        <div className="shrink-0 text-[13px]/4 tabular-nums text-[#200D0D73]" aria-live="polite">
          {counts.join(" · ")}
        </div>
      </div>

      {pending.isError ? (
        <QueryError error={pending.error} what="approvals" onRetry={() => void pending.refetch()} />
      ) : empty ? (
        <div className="flex min-h-0 grow flex-col items-center justify-center rounded-xl border border-[#200D0D1A]">
          <EmptyState
            icon={<ApprovalsIcon />}
            title="Nothing waiting for you"
            body={
              <>
                When an agent drafts an email, wants to run a tool outside your policy, or has a question, it waits here until you decide. Each email is
                bound to one recipient and one draft version, and nothing is sent until you approve it.
              </>
            }
            action={
              <div className="flex items-center gap-2">
                <ButtonLink to="/app/leads" variant="outline">
                  Open leads
                </ButtonLink>
                <ButtonLink to="/app/connect" variant="soft">
                  Connect your agent
                </ButtonLink>
              </div>
            }
          />
        </div>
      ) : (
        <div className="flex min-h-0 grow overflow-clip rounded-xl border border-[#200D0D1A]">
          <Queue
            items={ordered}
            selectedCode={selected?.code}
            now={now}
            loading={loading}
            emptyNote={
              <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
                <div className="text-[13px]/4 font-semibold text-ink">No approvals match</div>
                <div className="text-xs/4 font-medium text-[#200D0D8C]">{all.length ? `${all.length} waiting outside these filters.` : "Nothing of this kind is waiting."}</div>
                <Button variant="soft" onClick={clearFilters} className="mt-1">
                  Clear filters
                </Button>
              </div>
            }
          />
          <section aria-label="Selected approval" className="flex min-w-0 grow flex-col">
            {loading ? (
              <DetailSkeleton />
            ) : selected ? (
              <Detail key={selected.code} a={selected} now={now} onDecided={onDecided} />
            ) : code ? (
              <CodeState key={code} code={code} filtered={filtering} onClearFilters={clearFilters} />
            ) : (
              <NothingSelected count={ordered.length} />
            )}
          </section>
        </div>
      )}

      {toast ? (
        <div role="status" className="fixed bottom-6 left-[calc(50%+120px)] z-20 flex h-10 -translate-x-1/2 items-center rounded-full bg-ink px-4.5 text-[13px]/4 font-medium text-white shadow-lg">
          {toast}
        </div>
      ) : null}
    </Page>
  );
}

function Detail({ a, now, onDecided }: { a: ApprovalListItem; now: number; onDecided: OnDecided }) {
  if (a.kind === "tool") return <ToolDetail a={a} now={now} onDecided={onDecided} />;
  if (a.kind === "question") return <QuestionDetail a={a} now={now} onDecided={onDecided} />;
  return <SendDetail a={a} now={now} onDecided={onDecided} />;
}
