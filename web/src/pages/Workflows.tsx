// Dashboard · Workflows (Paper artboard "Dashboard · Workflows"). A workflow is one purpose (lead research,
// find leads, onboarding) aggregated over its agent runs; each row opens to its recent runs, and a run opens
// /app/workflows/runs/:id. Real data from /api/workflows; schedules and versions are not modelled, so those
// design columns are left out.
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { ApprovalListItem, Run, Workflow } from "../api.ts";
import { Page } from "../components/AppShell.tsx";
import { FilterChip, SearchField, updatedAgo, useNow, useSlashToFocus } from "../components/approvals/controls.tsx";
import { WorkflowsIcon } from "../components/icons.tsx";
import { NewWorkflowButton } from "../components/workflows/NewWorkflow.tsx";
import { isActive, runPill, StatusPill, stopLabel, workflowPill } from "../components/workflows/status.tsx";
import { ButtonLink, EmptyState, QueryError, Skeleton } from "../components/ui.tsx";
import { cx, duration, hostOf, leadTitle, num, shortDate, timeAgo, usd } from "../lib/format.ts";
import { useApprovals, useLeads, useWorkflows } from "../queries.ts";

type GroupKey = "running" | "paused" | "finished";
const GROUP_OF = (w: Workflow): GroupKey => (isActive(w.status) ? "running" : w.status === "paused" || w.status === "error" ? "paused" : "finished");

const STATUS_OPTIONS = [
  { value: "", label: "Any" },
  { value: "running", label: "Running" },
  { value: "idle", label: "Waiting on you" },
  { value: "paused", label: "Paused" },
  { value: "error", label: "Error" },
  { value: "done", label: "Done" },
];

type Ctx = {
  leadName: (id: string | null) => string | null;
  /** Pending approvals for a run: by session id, or send approvals for the run's lead. */
  approvalsFor: (run: Run) => ApprovalListItem[];
  now: number;
};

function runLabel(run: Run, ctx: Ctx): string {
  const input = run.input ?? {};
  if (run.purpose === "find_leads") return typeof input.count === "number" ? `Find up to ${input.count} leads` : "Find leads";
  if (run.purpose === "onboarding") return typeof input.url === "string" ? `Profile from ${hostOf(input.url)}` : "Onboarding profile";
  return ctx.leadName(run.lead_id) ?? run.name;
}

export default function Workflows() {
  const navigate = useNavigate();
  const now = useNow(1000);
  const q = useWorkflows();
  const pending = useApprovals({ status: "pending" });
  const leads = useLeads({ limit: 200 });
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [closedGroups, setClosedGroups] = useState<Set<GroupKey>>(() => new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashToFocus(searchRef);

  const ctx: Ctx = useMemo(() => {
    const names = new Map((leads.data?.data ?? []).map((l) => [l.id, leadTitle(l)]));
    for (const a of pending.data?.data ?? []) if (a.lead && !names.has(a.lead.id)) names.set(a.lead.id, leadTitle(a.lead));
    const list = pending.data?.data ?? [];
    return {
      leadName: (id) => (id ? (names.get(id) ?? null) : null),
      approvalsFor: (run) =>
        list.filter((a) => a.naive_session_id === run.id || (a.kind === "send" && run.lead_id && a.lead_id === run.lead_id && a.created_at >= run.started_at)),
      now,
    };
  }, [leads.data, pending.data, now]);

  const workflows = q.data ?? [];
  const s = search.trim().toLowerCase();
  const visible = workflows
    .filter((w) => !status || w.status === status)
    .map((w) => {
      if (!s || [w.name, w.purpose, w.id].some((v) => v.toLowerCase().includes(s))) return { w, runs: w.runs, matchedRuns: false };
      const runs = w.runs.filter((r) => [runLabel(r, ctx), r.id].some((v) => v.toLowerCase().includes(s)));
      return runs.length ? { w, runs, matchedRuns: true } : null;
    })
    .filter((x): x is { w: Workflow; runs: Run[]; matchedRuns: boolean } => x !== null);

  const groups = (["running", "paused", "finished"] as const)
    .map((key) => ({ key, items: visible.filter((v) => GROUP_OF(v.w) === key) }))
    .filter((g) => g.items.length);

  const totalRuns = workflows.reduce((n, w) => n + w.run_count, 0);
  const totalLeads = workflows.reduce((n, w) => n + w.leads_processed, 0);
  const counts = q.data
    ? [
        workflows.length === 1 ? "1 workflow" : `${workflows.length} workflows`,
        `${num(totalRuns)} ${totalRuns === 1 ? "run" : "runs"}`,
        `${num(totalLeads)} leads processed`,
        updatedAgo(q.dataUpdatedAt, now),
      ]
    : [];
  // Runs that matched the search always show; otherwise rows with active runs start open.
  const isOpen = (w: Workflow, matchedRuns: boolean) => matchedRuns || (open[w.id] ?? w.active_runs > 0);

  return (
    <Page className="min-h-screen gap-5 px-8 pb-6 pt-10">
      <div className="flex h-10 shrink-0 items-center justify-between">
        <h1 className="text-xl/7 font-semibold tracking-[-0.01em] text-ink">Workflows</h1>
        <div className="flex items-center gap-2.5">
          {workflows.length ? (
            <SearchField
              inputRef={searchRef}
              value={search}
              onChange={setSearch}
              placeholder="Search workflows"
              className="h-9 w-55"
              hint={<kbd className="flex rounded-[5px] border border-[#200D0D1F] px-1.25 py-px text-[11px]/3.5 text-[#200D0D73]">/</kbd>}
            />
          ) : null}
          <NewWorkflowButton />
        </div>
      </div>

      {workflows.length ? (
        <div className="flex h-8 shrink-0 items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <FilterChip label="Status" value={status} options={STATUS_OPTIONS} onChange={setStatus} />
          </div>
          <div className="text-[13px]/4 tabular-nums text-[#200D0D73]">{counts.join(" · ")}</div>
        </div>
      ) : null}

      {q.isError ? (
        <QueryError error={q.error} what="workflows" onRetry={() => void q.refetch()} />
      ) : q.isLoading ? (
        <div className="flex flex-col overflow-clip rounded-xl border border-[#200D0D1A]">
          <div className="h-9 bg-[#200D0D06]" />
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex h-15 items-center gap-6 border-t border-t-[#200D0D14] px-4">
              <Skeleton className="h-8 w-56" />
              <Skeleton className="h-5.5 w-20" />
              <Skeleton className="h-8 grow" />
            </div>
          ))}
        </div>
      ) : !workflows.length ? (
        <div className="rounded-xl border border-[#200D0D1A]">
          <EmptyState
            icon={<WorkflowsIcon />}
            title="No workflows yet"
            body="Workflows appear when an agent starts working for you: finding leads, researching them and drafting emails for your approval. Every run lists each step it took, with its input, output and cost."
            action={
              <div className="flex items-center gap-2">
                <ButtonLink to="/onboarding/1" variant="outline">
                  Set up your company
                </ButtonLink>
                <ButtonLink to="/app/connect" variant="soft">
                  Connect your agent
                </ButtonLink>
              </div>
            }
            className="py-16"
          />
        </div>
      ) : (
        <div className="overflow-clip rounded-xl border border-[#200D0D1A]">
          <table className="w-full table-fixed border-collapse text-left text-xs/4">
            <colgroup>
              <col className="w-72" />
              <col className="w-32" />
              <col />
              <col className="w-24" />
              <col className="w-22" />
              <col className="w-8" />
            </colgroup>
            <thead>
              <tr className="h-9 bg-[#200D0D06] text-xs/4 text-[#200D0D80]">
                <th scope="col" className="pl-4 pr-3 font-medium">
                  Workflow
                </th>
                <th scope="col" className="pr-3 font-medium">
                  Status
                </th>
                <th scope="col" className="pr-7 font-medium">
                  Activity
                </th>
                <th scope="col" className="pr-3 text-right font-medium">
                  Leads
                </th>
                <th scope="col" className="pr-3 text-right font-medium">
                  Cost
                </th>
                <th scope="col" className="pr-4">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            {groups.map((g) => {
              const closed = closedGroups.has(g.key);
              const cost = g.items.reduce<number | null>((sum, { w }) => (w.cost_usd === null ? sum : (sum ?? 0) + w.cost_usd), null);
              return (
                <tbody key={g.key}>
                  <tr>
                    <th colSpan={6} scope="colgroup" className="h-8.5 border-t border-t-[#200D0D14] bg-[#200D0D08] px-4 font-normal">
                      <div className="flex items-center justify-between">
                        <button
                          type="button"
                          aria-expanded={!closed}
                          onClick={() =>
                            setClosedGroups((prev) => {
                              const next = new Set(prev);
                              if (next.has(g.key)) next.delete(g.key);
                              else next.add(g.key);
                              return next;
                            })
                          }
                          className="flex items-center gap-2"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden className={cx("transition-transform", closed && "-rotate-90")}>
                            <path d="M6 9l6 6 6-6" fill="none" stroke="#200D0D" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          <span className="text-[13px]/4 font-semibold text-ink">{g.key === "running" ? "Running" : g.key === "paused" ? "Paused" : "Finished"}</span>
                          <span className="text-[13px]/4 text-[#200D0D8C]">{groupNote(g.key, g.items.map((i) => i.w))}</span>
                        </button>
                        {cost !== null ? <span className="text-xs/4 tabular-nums text-[#200D0D8C]">{usd(cost)} spent</span> : null}
                      </div>
                    </th>
                  </tr>
                  {closed
                    ? null
                    : g.items.map(({ w, runs, matchedRuns }) => {
                        const expanded = isOpen(w, matchedRuns);
                        return (
                          <WorkflowRows
                            key={w.id}
                            w={w}
                            runs={runs}
                            expanded={expanded}
                            onToggle={() => setOpen((o) => ({ ...o, [w.id]: !expanded }))}
                            onOpenRun={(id) => navigate(`/app/workflows/runs/${encodeURIComponent(id)}`)}
                            ctx={ctx}
                          />
                        );
                      })}
                </tbody>
              );
            })}
            {!groups.length ? (
              <tbody>
                <tr>
                  <td colSpan={6} className="border-t border-t-[#200D0D14] px-4 py-10 text-center">
                    <div className="text-[13px]/4 font-semibold text-ink">No workflows match</div>
                    <button
                      type="button"
                      onClick={() => {
                        setSearch("");
                        setStatus("");
                      }}
                      className="mt-2 text-xs/4 font-medium text-ink underline decoration-1 underline-offset-[3px]"
                    >
                      Clear search and filters
                    </button>
                  </td>
                </tr>
              </tbody>
            ) : null}
          </table>
        </div>
      )}

      {workflows.length ? (
        <div className="flex shrink-0 items-center gap-2.5 px-1">
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden className="shrink-0">
            <circle cx="12" cy="12" r="9" fill="none" stroke="rgb(32 13 13 / 55%)" strokeWidth="2" />
            <path d="M12 11v5M12 8v.01" fill="none" stroke="rgb(32 13 13 / 55%)" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <p className="text-xs/4 font-medium text-[#200D0D8C]">Each run is one agent session. Open a run to see every step it took, its input and output, and what it cost.</p>
        </div>
      ) : null}
    </Page>
  );
}

function groupNote(key: GroupKey, items: Workflow[]): string {
  const n = items.length;
  const label = n === 1 ? "1 workflow" : `${n} workflows`;
  if (key === "running") {
    const active = items.reduce((s, w) => s + w.active_runs, 0);
    const waiting = items.filter((w) => w.status === "idle").length;
    return [label, `${active} active ${active === 1 ? "run" : "runs"}`, waiting ? `${waiting} waiting on you` : null].filter(Boolean).join(" · ");
  }
  if (key === "paused") {
    const errors = items.filter((w) => w.status === "error").length;
    return [label, errors ? `${errors} stopped with an error` : null, items.some((w) => w.status === "paused") ? "no new steps until resumed" : null].filter(Boolean).join(" · ");
  }
  return `${label} · done`;
}

const CHEVRON = (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden className="inline-block">
    <path d="M9 6l6 6-6 6" fill="none" stroke="rgb(32 13 13 / 35%)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function WorkflowRows({
  w,
  runs,
  expanded,
  onToggle,
  onOpenRun,
  ctx,
}: {
  w: Workflow;
  runs: Run[];
  expanded: boolean;
  onToggle: () => void;
  onOpenRun: (id: string) => void;
  ctx: Ctx;
}) {
  const waiting = w.runs.flatMap((r) => ctx.approvalsFor(r));
  const codes = [...new Set(waiting.map((a) => a.code))];
  const budgetHit = w.runs.some((r) => r.stop_reason === "budget_paused" && r.status === "paused");
  const line1 =
    w.status === "running"
      ? `${w.active_runs} active · last step ${timeAgo(w.last_event_at, ctx.now)}`
      : w.status === "idle"
        ? codes.length
          ? `Waiting for ${codes.length === 1 ? `approval ${codes[0]}` : `${codes.length} approvals`}`
          : `${w.active_runs} ${w.active_runs === 1 ? "run" : "runs"} waiting on you`
        : w.status === "paused"
          ? budgetHit
            ? "A run paused itself at its budget"
            : "Paused · sends are off"
          : w.status === "error"
            ? `Last run stopped with an error ${timeAgo(w.last_event_at, ctx.now)}`
            : `Last run finished ${timeAgo(w.last_event_at, ctx.now)}`;
  const line2 = [`${num(w.run_count)} ${w.run_count === 1 ? "run" : "runs"} since ${shortDate(w.first_started_at)}`, codes.length && w.status !== "idle" ? `${codes.length} waiting for approval` : null]
    .filter(Boolean)
    .join(" · ");
  const red = w.status === "error" || budgetHit;
  return (
    <>
      <tr onClick={onToggle} className="h-15 cursor-pointer border-t border-t-[#200D0D14] hover:bg-[#200D0D04]">
        <td className="pl-4 pr-3">
          <button type="button" aria-expanded={expanded} onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }} className="flex max-w-full flex-col items-start gap-0.5 text-left">
            <span className="max-w-full truncate text-sm/4.5 font-medium text-ink">{w.name}</span>
            <span className="max-w-full truncate text-[11px]/3.5 text-[#200D0D73]">
              {w.id} · {w.runs.length < w.run_count ? `${w.runs.length} most recent runs` : `${w.runs.length} ${w.runs.length === 1 ? "run" : "runs"}`}
            </span>
          </button>
        </td>
        <td className="pr-3">
          <StatusPill spec={workflowPill(w.status)} />
        </td>
        <td className="pr-7">
          <div className={cx("truncate text-xs/4", red ? "text-[#B42318]" : "text-[#200D0D99]")}>{line1}</div>
          <div className="truncate text-[11px]/3.5 text-[#200D0D73]">{line2}</div>
        </td>
        <td className={cx("pr-3 text-right text-[13px]/4 tabular-nums", w.leads_processed ? "text-ink" : "text-[#200D0D66]")}>{num(w.leads_processed)}</td>
        <td className={cx("pr-3 text-right text-[13px]/4 font-medium tabular-nums", w.cost_usd ? "text-ink" : "text-[#200D0D66]")}>{usd(w.cost_usd)}</td>
        <td className="pr-4 text-center">
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden className={cx("inline-block transition-transform", expanded && "rotate-90")}>
            <path d="M9 6l6 6-6 6" fill="none" stroke={expanded ? "#200D0D" : "rgb(32 13 13 / 35%)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </td>
      </tr>
      {expanded
        ? runs.map((r) => <RunRow key={r.id} run={r} ctx={ctx} onOpen={() => onOpenRun(r.id)} />)
        : null}
      {expanded && !runs.length ? (
        <tr className="border-t border-t-[#200D0D0F] bg-[#200D0D03]">
          <td colSpan={6} className="py-3 pl-8 text-xs/4 font-medium text-[#200D0D8C]">
            No runs listed yet.
          </td>
        </tr>
      ) : null}
    </>
  );
}

function RunRow({ run, ctx, onOpen }: { run: Run; ctx: Ctx; onOpen: () => void }) {
  const waiting = ctx.approvalsFor(run);
  const href = `/app/workflows/runs/${encodeURIComponent(run.id)}`;
  const line1 = waiting.length
    ? `Waiting for approval ${waiting.map((a) => a.code).join(", ")}`
    : run.status === "running"
      ? `Working · last step ${timeAgo(run.last_event_at, ctx.now)}`
      : run.status === "done"
        ? `Finished ${timeAgo(run.last_event_at, ctx.now)}`
        : run.status === "error"
          ? `Stopped: ${stopLabel(run.stop_reason) ?? "an error"} · ${timeAgo(run.last_event_at, ctx.now)}`
          : capitalize(stopLabel(run.stop_reason) ?? run.status);
  const took = new Date(run.last_event_at).getTime() - new Date(run.started_at).getTime();
  const line2 = isActive(run.status) ? `Started ${timeAgo(run.started_at, ctx.now)}` : `Started ${timeAgo(run.started_at, ctx.now)} · ran ${duration(took)}`;
  return (
    <tr onClick={onOpen} className="h-12 cursor-pointer border-t border-t-[#200D0D0F] bg-[#200D0D03] hover:bg-[#200D0D08]">
      <td className="pl-8 pr-3">
        <Link to={href} onClick={(e) => e.stopPropagation()} className="flex max-w-full flex-col gap-0.5">
          <span className="truncate text-[13px]/4 font-medium text-ink">{runLabel(run, ctx)}</span>
          <span className="truncate text-[11px]/3.5 text-[#200D0D73]">{run.id}</span>
        </Link>
      </td>
      <td className="pr-3">
        <StatusPill spec={runPill(run)} small />
      </td>
      <td className="pr-7">
        <div className={cx("truncate text-xs/4", run.status === "error" ? "text-[#B42318]" : "text-[#200D0D99]")}>{line1}</div>
        <div className="truncate text-[11px]/3.5 text-[#200D0D73]">{line2}</div>
      </td>
      <td className={cx("pr-3 text-right text-xs/4 tabular-nums", run.leads_processed ? "text-ink" : "text-[#200D0D66]")}>{num(run.leads_processed)}</td>
      <td className={cx("pr-3 text-right text-xs/4 font-medium tabular-nums", run.cost_usd ? "text-ink" : "text-[#200D0D66]")}>{usd(run.cost_usd)}</td>
      <td className="pr-4 text-center">{CHEVRON}</td>
    </tr>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
