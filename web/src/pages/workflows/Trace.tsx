// "View full trace": every stored event of one run (GET /api/workflows/runs/:id/trace, agent-loop-v2), oldest
// first, 200 per page. Event data comes from the agent: untrusted, rendered as text only.
import type { FlowRun, TraceEvent } from "../../api/workflows.ts";
import { useRunTrace } from "../../api/workflows.ts";
import { Dialog } from "../../components/leads/Overlay.tsx";
import { Button, EmptyState, QueryError, Skeleton } from "../../components/ui.tsx";
import { num, usd } from "../../lib/format.ts";
import { runDate } from "./parts.tsx";

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);

function summary(e: TraceEvent): string {
  const d = e.data ?? {};
  const name = str(d.name) ?? str(d.tool) ?? str((d as { tool_name?: unknown }).tool_name);
  const text = str(d.text) ?? str(d.message) ?? str(d.summary);
  if (name && text) return `${name}: ${text}`;
  if (name) return name;
  if (text) return text;
  if (str(d.model)) return [str(d.model), str(d.tokens) ? `${num(Number(d.tokens))} tokens` : null].filter(Boolean).join(" · ");
  if (str(d.status)) return String(d.status);
  return "";
}

function seconds(v: string) {
  return new Date(v).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}

export function TraceDialog({ run, onClose }: { run: FlowRun | null; onClose: () => void }) {
  const q = useRunTrace(run?.id ?? null);
  const pages = q.data?.pages ?? [];
  const first = pages[0];
  const events = pages.flatMap((p) => p.events);
  const credits = first?.spend.credits_debited;
  return (
    <Dialog
      open={Boolean(run)}
      onClose={onClose}
      title={run ? `v${run.version} · ${runDate(run.started_at)}` : "Trace"}
      description={first ? [usd(first.spend.naive_usd ?? run?.cost_usd ?? null), credits ? `${num(credits)} credits` : null, `${num(events.length)}${q.hasNextPage ? "+" : ""} events`].filter(Boolean).join(" · ") : undefined}
      className="w-[880px]"
      footer={
        q.hasNextPage ? (
          <Button variant="soft" size="sm" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            Load more
          </Button>
        ) : undefined
      }
    >
      {q.isError ? (
        <QueryError error={q.error} what="this trace" onRetry={() => void q.refetch()} />
      ) : q.isPending ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-7" />
          ))}
        </div>
      ) : events.length === 0 ? (
        <EmptyState title="No events stored" />
      ) : (
        <ol className="flex flex-col">
          {events.map((e, i) => (
            <li key={e.seq} className={i > 0 ? "border-t border-t-[#200D0D0F]" : undefined}>
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-3 py-2 text-[13px]/4.5 text-ink">
                  <span className="w-8 shrink-0 text-right text-xs/4 tabular-nums text-muted">{e.seq}</span>
                  <span className="w-16 shrink-0 text-xs/4 tabular-nums text-muted">{seconds(e.created_at)}</span>
                  <span className="w-32 shrink-0 truncate text-xs/4 font-medium text-ink">{e.type}</span>
                  <span className="min-w-0 grow truncate">{summary(e)}</span>
                </summary>
                <pre className="mb-2 ml-11 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[#200D0D06] px-3 py-2 font-sans text-xs/4.5 text-ink">
                  {JSON.stringify(e.data, null, 2)}
                </pre>
              </details>
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}
