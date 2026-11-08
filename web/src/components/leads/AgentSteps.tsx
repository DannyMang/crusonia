// "What the agent did" (Paper: "Final · Research · Review queue" > Agent steps): the clean timeline of a lead's
// latest research run (GET /api/workflows/runs/:id), with "View full trace" opening every stored event of the run
// (GET /api/workflows/runs/:id/trace, paginated by Naive seq). Agent output is untrusted: shown as text only.
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { RunStep, Trace, TraceEvent } from "../../api.ts";
import { useApi } from "../../auth.tsx";
import { clock, creditsLabel, cx, duration } from "../../lib/format.ts";
import { keys, useWorkflowRun } from "../../queries.ts";
import { CheckLineIcon } from "../core-icons.tsx";
import { Button, LiveChip, QueryError, Skeleton } from "../ui.tsx";
import { Dialog } from "./Overlay.tsx";

/** Steps worth a line: tool calls, agent messages, approvals and our own audit events (not model requests). */
const shown = (s: RunStep) => s.type !== "model" && s.type !== "usage" && s.summary.trim().length > 0;

export function AgentSteps({ sessionId, className }: { sessionId: string; className?: string }) {
  const detail = useWorkflowRun(sessionId);
  const [trace, setTrace] = useState(false);
  const run = detail.data?.run;
  const steps = (detail.data?.steps ?? []).filter(shown);
  const active = run ? run.status === "running" || run.status === "idle" : false;
  const took = run ? new Date(run.updated_at).getTime() - new Date(run.started_at).getTime() : null;

  return (
    <section aria-label="What the agent did" className={cx("flex flex-col bg-[#200D0D06] px-5.5 pb-2.5 pt-3.5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 pb-1.5">
        <h3 className="whitespace-nowrap text-[13px]/4.5 font-semibold text-ink">What the agent did</h3>
        <div className="flex shrink-0 items-center gap-2.5">
          {run ? (
            active ? (
              <LiveChip>Working</LiveChip>
            ) : run.status === "error" ? (
              <span className="text-xs/4 font-medium text-[#B42318]">Stopped</span>
            ) : (
              <span className="flex items-center gap-1.25 text-xs/4 font-medium text-ink">
                <CheckLineIcon className="text-green" />
                Saved
              </span>
            )
          ) : null}
          {run && !active ? <span className="text-xs/4 tabular-nums text-muted">{[took !== null ? duration(took) : null, run.cost_credits !== null ? creditsLabel(run.cost_credits) : null].filter(Boolean).join(" · ")}</span> : null}
          <button type="button" onClick={() => setTrace(true)} className="flex h-6.5 items-center rounded-full border border-ink bg-white px-2.75 text-xs/4 font-medium text-ink hover:bg-[#200D0D08]">
            View full trace
          </button>
        </div>
      </div>
      {detail.isError ? (
        <QueryError error={detail.error} what="this run" className="my-1.5" />
      ) : detail.isPending ? (
        <div className="flex flex-col gap-2 py-1.5">
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-4 w-56" />
        </div>
      ) : (
        <ol className="flex flex-col">
          {steps.slice(-8).map((s) => (
            <li key={s.seq} className="flex gap-3 py-1.5">
              <span className="w-16 shrink-0 whitespace-nowrap text-xs/4.25 tabular-nums text-muted">{s.started_at ? clock(s.started_at) : ""}</span>
              <span className={cx("min-w-0 grow basis-0 text-[13px]/4.25 [overflow-wrap:anywhere]", s.is_error ? "text-[#B42318]" : "text-ink")}>{s.summary}</span>
            </li>
          ))}
        </ol>
      )}
      <TraceDialog sessionId={sessionId} open={trace} onClose={() => setTrace(false)} />
    </section>
  );
}

// ---------- full trace ----------

/** One line for a stored Naive event: its type, then the tool name and a preview of what went in or came out. */
function eventLine(e: TraceEvent): { title: string; body: string | null } {
  const d = e.data ?? {};
  const name = typeof d.name === "string" ? d.name : typeof d.tool === "string" ? d.tool : null;
  const text = typeof d.text === "string" ? d.text : null;
  const payload = d.args ?? d.input ?? d.output ?? d.result ?? (text === null ? (Object.keys(d).length ? d : null) : null);
  const preview = text ?? (payload === null || payload === undefined ? null : typeof payload === "string" ? payload : JSON.stringify(payload));
  return { title: name ? `${e.type} · ${name}` : e.type, body: preview && preview.length > 600 ? `${preview.slice(0, 600)}…` : preview };
}

export function TraceDialog({ sessionId, open, onClose }: { sessionId: string; open: boolean; onClose: () => void }) {
  const api = useApi();
  const [exportError, setExportError] = useState<unknown>(null);
  const trace = useInfiniteQuery({
    queryKey: keys.trace(sessionId),
    queryFn: ({ pageParam }) => api.trace(sessionId, { after_seq: pageParam, limit: 200 }),
    initialPageParam: 0,
    getNextPageParam: (last: Trace) => (last.has_more ? (last.next_after_seq ?? undefined) : undefined),
    enabled: open,
  });
  const first = trace.data?.pages[0];
  const events = trace.data?.pages.flatMap((p) => p.events) ?? [];
  const spend = first?.spend;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Full trace"
      className="w-[min(760px,calc(100vw-48px))]! max-h-[min(820px,90vh)]!"
      footer={
        <>
          <a
            href={`/api/workflows/runs/${encodeURIComponent(sessionId)}/trace/export`}
            onClick={(e) => {
              // The export needs the auth header: fetch it and save it as a file instead of navigating.
              e.preventDefault();
              setExportError(null);
              api.request<unknown>("GET", `/api/workflows/runs/${encodeURIComponent(sessionId)}/trace/export`).then((json) => {
                const url = URL.createObjectURL(new Blob([JSON.stringify(json, null, 2)], { type: "application/json" }));
                const a = document.createElement("a");
                a.href = url;
                a.download = `crusonia-trace-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "")}.json`;
                a.click();
                URL.revokeObjectURL(url);
              }, setExportError);
            }}
            className="mr-auto text-[13px]/4 font-medium text-ink underline decoration-[#200D0D4D] underline-offset-[3px] hover:decoration-ink"
          >
            Download JSON
          </a>
          <Button variant="soft" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {trace.isError ? (
        <QueryError error={trace.error} what="the trace" />
      ) : trace.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-4 w-80" />
          <Skeleton className="h-4 w-56" />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {exportError ? <QueryError error={exportError} what="the download" /> : null}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs/4 tabular-nums text-muted">
            <span>{events.length} events</span>
            {spend?.credits ?? spend?.credits_debited ? <span>{creditsLabel(spend?.credits ?? spend?.credits_debited)}</span> : null}
            {spend?.apify_runs.length ? <span>{spend.apify_runs.length} Apify runs</span> : null}
            {first?.sync?.error ? <span className="text-[#B42318]">{first.sync.error}</span> : null}
          </div>
          <ol className="flex max-h-[60vh] flex-col overflow-y-auto rounded-[10px] border border-[#200D0D1A]">
            {events.map((e) => {
              const line = eventLine(e);
              return (
                <li key={e.seq} className="flex gap-3 border-b border-b-[#200D0D0F] px-3.5 py-2.5 last:border-b-0">
                  <span className="w-8 shrink-0 text-xs/4.5 tabular-nums text-faint">{e.seq}</span>
                  <div className="flex min-w-0 grow flex-col gap-0.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-[13px]/4.5 font-medium text-ink">{line.title}</span>
                      <span className="shrink-0 text-xs/4 tabular-nums text-muted">{clock(e.created_at)}</span>
                    </div>
                    {line.body ? <p className="whitespace-pre-wrap text-xs/4.5 text-muted [overflow-wrap:anywhere]">{line.body}</p> : null}
                  </div>
                </li>
              );
            })}
          </ol>
          {trace.hasNextPage ? (
            <Button variant="soft" className="self-start" loading={trace.isFetchingNextPage} onClick={() => void trace.fetchNextPage()}>
              Load more
            </Button>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
