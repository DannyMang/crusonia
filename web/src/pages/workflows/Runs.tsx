// Final · Workflows · Run history. Runs newest first (version, start, status, spend, the clean timeline and the
// full trace), the per-variant counts for the current version and the leads paused for review. Counts only.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";
import { useFlow, useFlowRuns, type FlowRun, type FlowRunHistory, type VariantCounts } from "../../api/workflows.ts";
import { useApi } from "../../auth.tsx";
import { Page } from "../../components/AppShell.tsx";
import { Button, EmptyState, QueryError, Skeleton } from "../../components/ui.tsx";
import { creditsLabel, cx, num } from "../../lib/format.ts";
import { FlowHeader, FlowStatusPill, hm, runDate, spendLabel } from "./parts.tsx";
import { TraceDialog } from "./Trace.tsx";

export default function WorkflowRuns() {
  const { id } = useParams();
  const flow = useFlow(id);
  const runs = useFlowRuns(id);
  const [trace, setTrace] = useState<FlowRun | null>(null);
  const w = flow.data?.workflow;

  return (
    <Page className="grow gap-5 px-4 pb-9 pt-8 sm:px-8">
      <FlowHeader
        title={w?.name ?? (flow.isPending ? <Skeleton className="h-6 w-48" /> : "Workflow")}
        source={w?.source}
        right={w ? <div className="text-[13px]/4 tabular-nums text-muted">{spendLabel(w.spend)}</div> : null}
        tabsFor={id}
      />
      {runs.isError ? (
        <QueryError error={runs.error} what="run history" onRetry={() => void runs.refetch()} />
      ) : runs.isPending ? (
        <div className="flex flex-col gap-5 lg:flex-row">
          <Skeleton className="h-70 grow rounded-xl" />
          <Skeleton className="h-70 w-full rounded-xl lg:w-96 xl:w-120" />
        </div>
      ) : (
        <History data={runs.data} onTrace={setTrace} />
      )}
      <TraceDialog run={trace} onClose={() => setTrace(null)} />
    </Page>
  );
}

function History({ data, onTrace }: { data: FlowRunHistory; onTrace: (run: FlowRun) => void }) {
  const [open, setOpen] = useState<string | null>(data.runs[0]?.id ?? null);
  return (
    <div className="flex flex-col items-start gap-5 lg:flex-row">
      <div className="flex w-full min-w-0 flex-col gap-3 lg:w-auto lg:grow lg:basis-0">
        {data.runs.length === 0 ? (
          <div className="rounded-xl border border-[#200D0D1A]">
            <EmptyState title="No runs yet" />
          </div>
        ) : (
          data.runs.map((r) => (open === r.id ? <OpenRun key={r.id} run={r} onTrace={() => onTrace(r)} /> : <RunRow key={r.id} run={r} onOpen={() => setOpen(r.id)} onTrace={() => onTrace(r)} />))
        )}
      </div>
      {data.variants || data.needs_review.length ? (
        <div className="flex w-full shrink-0 flex-col gap-4 lg:w-96 xl:w-120">
          {data.variants ? <Variants v={data.variants} /> : null}
          {data.needs_review.map((n) => (
            <NeedsReview key={n.lead_id} item={n} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const VersionChip = ({ v }: { v: number }) => <span className="flex h-5.5 shrink-0 items-center rounded-full bg-pill px-2 text-xs/4 font-semibold text-ink">v{v}</span>;

const STILL = new Set(["waiting", "running"]);

function OpenRun({ run, onTrace }: { run: FlowRun; onTrace: () => void }) {
  const live = STILL.has(run.status);
  return (
    <div className="flex flex-col overflow-clip rounded-xl border border-[#200D0D1A]">
      <div className="flex items-center gap-3 border-b border-b-[#200D0D14] px-4.5 py-3.5">
        <VersionChip v={run.version} />
        <div className="min-w-0 grow basis-0 truncate text-sm/4.5 font-semibold text-ink">{runDate(run.started_at)}</div>
        <FlowStatusPill status={run.status} />
        <div className="w-20 shrink-0 whitespace-nowrap text-right text-[13px]/4 font-medium tabular-nums text-ink">{creditsLabel(run.cost_credits)}</div>
      </div>
      <ol className="flex flex-col px-4.5 py-2">
        {run.timeline.map((t, i) => (
          <li key={i} className="flex gap-4 py-1.75">
            <span className="w-11 shrink-0 text-xs/4.5 tabular-nums text-muted">{hm(t.at)}</span>
            <span className={cx("text-[13px]/4.5 text-ink", live && i === run.timeline.length - 1 && "font-semibold")}>{t.text}</span>
          </li>
        ))}
      </ol>
      <div className="flex items-center justify-between gap-3 border-t border-t-[#200D0D14] px-4.5 py-3">
        <div className="flex items-center gap-1.5 text-xs/4 font-medium text-ink">
          {run.trace_steps !== null ? (
            <>
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                <path d="M2.5 6.25l2.25 2.25L9.5 3.75" fill="none" stroke="#16A34A" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Trace saved · {num(run.trace_steps)} steps
            </>
          ) : null}
        </div>
        <Button variant="outline" size="sm" onClick={onTrace}>
          View full trace
        </Button>
      </div>
    </div>
  );
}

const BY_ITSELF = new Set(["schedule", "csv_import", "reply", "operator"]);

/** Started by itself or by a person; what the agents did and the times a person stepped in. */
function RunTally({ run }: { run: FlowRun }) {
  if (run.agent_actions === undefined) return null;
  const did = run.agent_actions === 1 ? "1 agent action" : `${num(run.agent_actions)} agent actions`;
  const owner = run.owner_actions ?? 0;
  return (
    <span className="truncate text-xs/4 tabular-nums text-muted">
      {run.trigger && BY_ITSELF.has(run.trigger) ? "Started by itself" : "You started it"} · {did} · you stepped in {owner === 1 ? "once" : `${num(owner)} times`}
    </span>
  );
}

function RunRow({ run, onOpen, onTrace }: { run: FlowRun; onOpen: () => void; onTrace: () => void }) {
  const c = run.counts;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[#200D0D1A] px-4.5 py-3.5">
      <VersionChip v={run.version} />
      <button type="button" onClick={onOpen} className="flex min-w-0 grow basis-0 flex-col gap-0.5 text-left">
        <span className="truncate text-sm/4.5 font-semibold text-ink">{runDate(run.started_at)}</span>
        <span className="truncate text-xs/4 tabular-nums text-muted">
          {num(c.found)} found · {num(c.researched)} researched · {num(c.qualified)} qualified · {num(c.sent)} sent
        </span>
        <RunTally run={run} />
      </button>
      <FlowStatusPill status={run.status} />
      <div className="w-20 shrink-0 whitespace-nowrap text-right text-[13px]/4 font-medium tabular-nums text-ink">{creditsLabel(run.cost_credits)}</div>
      <button type="button" onClick={onTrace} className="hidden shrink-0 text-[13px]/4 font-medium text-ink underline decoration-1 underline-offset-2 sm:block">
        View full trace
      </button>
    </div>
  );
}

const ROWS: [keyof VariantCounts, string][] = [
  ["leads", "Leads"],
  ["researched", "Researched"],
  ["qualified", "Qualified"],
  ["drafted", "Drafted"],
  ["approved", "Approved"],
  ["sent", "Sent"],
  ["replied", "Replied"],
];

function Variants({ v }: { v: NonNullable<FlowRunHistory["variants"]> }) {
  return (
    <section className="flex flex-col overflow-clip rounded-xl border border-[#200D0D1A]">
      <div className="flex items-center justify-between border-b border-b-[#200D0D14] px-4.5 py-3.5">
        <h2 className="text-[15px]/4.5 font-medium text-ink">Variants</h2>
        <div className="text-xs/4 tabular-nums text-muted">
          v{v.version} · {v.runs} {v.runs === 1 ? "run" : "runs"}
        </div>
      </div>
      <table className="w-full border-collapse text-[13px]/4">
        <thead>
          <tr className="h-8.5 border-b border-b-[#200D0D14] bg-[#200D0D06] text-xs/4 font-medium text-muted">
            <th scope="col" className="w-33 px-4.5 text-left font-medium">
              <span className="sr-only">Count</span>
            </th>
            {v.arms.map((a, i) => (
              <th key={a.key} scope="col" className={cx("text-right font-medium", i === v.arms.length - 1 ? "w-27.5 pr-4.5" : "pr-0")}>
                {a.label ? `${a.key} · ${a.label}` : a.key}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map(([k, label], r) => (
            <tr key={k} className={cx("h-8", r > 0 && "border-t border-t-[#200D0D0F]")}>
              <th scope="row" className="px-4.5 text-left font-normal text-ink">
                {label}
              </th>
              {v.arms.map((a, i) => (
                <td key={a.key} className={cx("text-right font-medium tabular-nums text-ink", i === v.arms.length - 1 && "pr-4.5")}>
                  {num(a.counts[k])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const DONE = { qualify: "Qualified", skip: "Skipped", again: "Researching again" } as const;

function NeedsReview({ item }: { item: FlowRunHistory["needs_review"][number] }) {
  const api = useApi();
  const qc = useQueryClient();
  const act = useMutation({
    mutationFn: (what: "qualify" | "skip" | "again") =>
      what === "again"
        ? api.request("POST", "/api/workflows/research", { body: { lead_ids: [item.lead_id] } })
        : api.patchLead(item.lead_id, { stage: what === "qualify" ? "qualified" : "disqualified" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["flows"] });
      void qc.invalidateQueries({ queryKey: ["leads"] });
    },
  });
  const done = act.isSuccess;
  const btn = "flex h-8 items-center gap-1.5 rounded-full bg-white px-3.5 text-[13px]/4 font-medium text-ink transition-colors hover:bg-[#200D0D08] disabled:opacity-60";
  return (
    <section className="flex flex-col gap-2.5 rounded-xl border border-panel-line bg-panel px-4.5 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm/4.5 font-semibold text-ink">{item.company ?? "Lead"}</span>
          <span className="flex h-5 shrink-0 items-center rounded-full border border-ink px-2 text-[11px]/3.5 font-semibold text-ink">Needs review</span>
        </div>
        <span className="shrink-0 text-xs/4 tabular-nums text-muted">paused {hm(item.paused_at)}</span>
      </div>
      <p className="text-sm/5 font-medium text-ink">{item.question}</p>
      {act.isError ? <QueryError error={act.error} what="research" /> : null}
      {done ? (
        <div className="text-[13px]/4 font-medium text-ink">{DONE[act.variables]}</div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={act.isPending} onClick={() => act.mutate("qualify")} className={cx(btn, "border border-ink")}>
            Qualify
          </button>
          <button type="button" disabled={act.isPending} onClick={() => act.mutate("skip")} className={cx(btn, "border border-ink")}>
            Skip
          </button>
          <button type="button" disabled={act.isPending} onClick={() => act.mutate("again")} className={cx(btn, "border border-[#200D0D1A]")}>
            Research again
          </button>
        </div>
      )}
    </section>
  );
}
