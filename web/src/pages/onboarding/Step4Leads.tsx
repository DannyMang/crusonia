// Onboarding · 4 First leads (Paper artboard 2LQC-0): live progress of the "find my first 25 leads" run,
// from GET /api/leads (newest first, polled every few seconds). Leads created before the run started are
// left out. The API has no per-lead segment, so that column shows where the lead came from instead.
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import type { Lead } from "../../api.ts";
import { useApi } from "../../auth.tsx";
import { ButtonLink, QueryError, Skeleton, stageLabel } from "../../components/ui.tsx";
import { useOnboarding } from "../../components/onboarding/store.ts";
import { ArrowIcon, bigButton, DoneDot, Ring, StepTitle } from "../../components/onboarding/ui.tsx";
import { cx, hostOf, leadTitle } from "../../lib/format.ts";
import { keys } from "../../queries.ts";

const DEFAULT_TARGET = 25;
const SHOWN = 9;
const FILTERS = { limit: 100 } as const;

type Phase = "researched" | "researching" | "queued";
const phaseOf = (stage: string): Phase => (stage === "researching" ? "researching" : stage === "new" || stage === "no_consent" ? "queued" : "researched");

const SOURCES: Record<string, string> = { apify: "Web search", agent: "Agent", mcp: "Your agent", hubspot: "HubSpot", csv: "CSV import", manual: "Added by hand", api: "API" };
const sourceName = (s: string) => SOURCES[s] ?? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");

export default function Step4Leads() {
  const api = useApi();
  const run = useOnboarding().leads;
  const target = run?.target ?? DEFAULT_TARGET;

  const q = useQuery({
    queryKey: keys.leads(FILTERS),
    queryFn: ({ signal }) => api.leads(FILTERS, signal),
    refetchInterval: (query) => {
      const list = inRun(query.state.data?.data ?? [], run?.startedAt);
      const done = list.length >= target && list.every((l) => phaseOf(l.stage) === "researched");
      return done ? false : 4000;
    },
  });

  const leads = inRun(q.data?.data ?? [], run?.startedAt);
  const researched = leads.filter((l) => phaseOf(l.stage) === "researched").length;
  const researching = leads.filter((l) => phaseOf(l.stage) === "researching").length;
  const queued = leads.filter((l) => phaseOf(l.stage) === "queued").length;
  const complete = leads.length >= target && researched === leads.length;
  const shown = leads.slice(0, SHOWN);

  return (
    <div className="flex grow justify-center px-6 pb-16 pt-14">
      <div className="flex w-full max-w-260 flex-col gap-7">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <StepTitle
            step={4}
            title={complete ? "Your first leads are in" : run || leads.length ? "Your first leads are coming in" : "Your first leads"}
            subtitle="Each one is checked against your profile, with the evidence attached."
          />
          <Link to="/app" className={bigButton}>
            Go to dashboard
            <ArrowIcon />
          </Link>
        </div>

        {q.isError && !q.data ? <QueryError error={q.error} what="your leads" onRetry={() => void q.refetch()} /> : null}

        {run || leads.length ? (
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
              <div className="flex items-center gap-2.5">
                {complete ? <DoneDot size={16} check={9} /> : <Ring size={14} />}
                <div className="text-[15px]/4.5 font-semibold tabular-nums text-ink" role="status">
                  Researched {Math.min(researched, target)} of {target}
                </div>
              </div>
              <div className="flex items-center gap-3 text-[13px]/4 font-medium text-muted">
                <span className="tabular-nums">
                  {[researching ? `${researching} in progress` : null, queued ? `${queued} queued` : null, !researching && !queued && !complete ? (leads.length ? "waiting for the next lead" : "waiting for the first lead") : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {run ? (
                  <Link to={`/app/workflows/runs/${encodeURIComponent(run.sessionId)}`} className="text-ink underline decoration-[#200D0D4D] underline-offset-[3px] hover:decoration-ink">
                    See what the agent is doing
                  </Link>
                ) : null}
              </div>
            </div>
            <div className="flex h-2 shrink-0 overflow-hidden rounded-full bg-[#200D0D0F]" role="progressbar" aria-valuemin={0} aria-valuemax={target} aria-valuenow={Math.min(researched, target)} aria-label="Leads researched">
              <div className="h-2 rounded-full bg-lime transition-[width] duration-500" style={{ width: `${Math.min(100, (researched / target) * 100)}%` }} />
            </div>
          </div>
        ) : null}

        {q.isPending ? (
          <TableSkeleton />
        ) : shown.length ? (
          <>
            <LeadsTable leads={shown} />
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
              <div className="text-[13px]/4.5 font-medium text-muted">
                Showing the latest {shown.length} · {researched} researched, {researching} in progress, {queued} queued. Drafts for the top leads will wait in
                Outreach.
              </div>
              <Link to="/app/leads" className="text-[13px]/4 font-medium text-ink underline decoration-[#200D0D4D] underline-offset-[3px] hover:decoration-ink">
                View all {leads.length} {leads.length === 1 ? "lead" : "leads"}
              </Link>
            </div>
          </>
        ) : q.data ? (
          <Waiting running={Boolean(run)} />
        ) : null}
      </div>
    </div>
  );
}

/** Leads from this run: created after it started (a minute of slack for clock skew). Newest first. */
function inRun(all: Lead[], startedAt: number | undefined) {
  const from = startedAt ? startedAt - 60_000 : 0;
  return all.filter((l) => new Date(l.created_at).getTime() >= from).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

const th = "h-10 text-left text-xs/4 font-medium text-faint";

function LeadsTable({ leads }: { leads: Lead[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[#200D0D1A] bg-white px-6 py-2">
      <table className="w-full min-w-[860px] table-fixed border-collapse">
        <colgroup>
          <col className="w-62.5" />
          <col className="w-57.5" />
          <col />
          <col className="w-27.5" />
          <col className="w-30" />
        </colgroup>
        <thead>
          <tr className="border-b border-b-[#200D0D1A]">
            <th className={th}>Company</th>
            <th className={th}>Source</th>
            <th className={th}>Signal</th>
            <th className={th}>Score</th>
            <th className={th}>Status</th>
          </tr>
        </thead>
        <tbody className="[&>tr:last-child]:border-b-0">
          {leads.map((l) => (
            <Row key={l.id} l={l} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ l }: { l: Lead }) {
  const phase = phaseOf(l.stage);
  const domain = l.domain || hostOf(l.website) || l.email?.split("@")[1] || "";
  const fresh = Date.now() - new Date(l.created_at).getTime() < 2 * 60_000;
  return (
    <tr className={cx("h-15 border-b border-b-[#200D0D0F]", phase === "queued" && "opacity-50")}>
      <td className="pr-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <Link to={`/app/leads/${encodeURIComponent(l.id)}`} className="truncate text-sm/4.5 font-medium text-ink hover:underline">
              {leadTitle(l)}
            </Link>
            {fresh ? <span className="flex h-4.5 shrink-0 items-center rounded-full bg-highlight px-1.75 text-[11px]/3.5 font-semibold text-ink">Just now</span> : null}
          </div>
          {domain && domain !== leadTitle(l) ? <div className="truncate text-xs/4 font-medium text-faint">{domain}</div> : null}
        </div>
      </td>
      <td className="truncate pr-4 text-[13px]/4 font-medium text-ink">{sourceName(l.source)}</td>
      <td className="pr-4">
        {phase === "researched" && l.rationale ? (
          <span className="inline-flex h-6 max-w-full items-center rounded-full bg-[#BDE68973] px-2.5 text-xs/4 font-medium text-ink" title={l.rationale}>
            <span className="truncate">{l.rationale}</span>
          </span>
        ) : phase === "researching" ? (
          <span className="text-[13px]/4 font-medium text-muted">Looking for evidence…</span>
        ) : phase === "researched" ? (
          <span className="text-[13px]/4 font-medium text-muted">—</span>
        ) : null}
      </td>
      <td>
        {phase === "researched" && l.score !== null ? (
          <div className="flex items-center gap-2">
            <span className="w-5.5 shrink-0 text-[15px]/4.5 font-semibold tabular-nums text-ink">{l.score}</span>
            <span className="flex h-1 w-11 shrink-0 rounded-full bg-[#200D0D0F]">
              <span className="h-1 rounded-full bg-green" style={{ width: `${Math.max(0, Math.min(100, l.score))}%` }} />
            </span>
          </div>
        ) : phase === "researching" ? (
          <span className="block h-2 w-16.5 rounded-full bg-[#200D0D0F]" />
        ) : null}
      </td>
      <td>
        <Status stage={l.stage} phase={phase} />
      </td>
    </tr>
  );
}

/** Status column labels short enough for its 120px. */
const SHORT: Record<string, string> = { qualified: "Researched", awaiting_approval: "Draft waiting", sent: "Sent", not_interested: "Not now" };
const DOT: Record<string, string> = { disqualified: "bg-[#200D0D4D]", needs_review: "bg-[#D97706]", unsubscribed: "bg-[#B42318]", not_interested: "bg-[#200D0D4D]" };

function Status({ stage, phase }: { stage: string; phase: Phase }) {
  if (phase === "queued") return <span className="text-[13px]/4 font-medium text-muted">Queued</span>;
  if (phase === "researching")
    return (
      <span className="flex items-center gap-2 text-[13px]/4 font-medium text-ink">
        <Ring size={12} />
        Researching
      </span>
    );
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[13px]/4 font-medium text-ink">
      <span className={cx("size-1.5 shrink-0 rounded-full", DOT[stage] ?? "bg-green")} />
      <span className="truncate">{SHORT[stage] ?? stageLabel(stage)}</span>
    </span>
  );
}

function Waiting({ running }: { running: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-[#200D0D1A] bg-white px-6 py-14 text-center">
      {running ? <Ring size={18} /> : null}
      <div className="pt-1 text-[15px]/5 font-semibold tracking-[-0.01em] text-ink">{running ? "Looking for companies that match your profile" : "No leads yet"}</div>
      <p className="max-w-md text-[13px]/5 font-medium text-muted">
        {running
          ? "The agent searches for companies like your best customers, then researches each one. The first ones usually show up within a few minutes, and this page updates on its own."
          : "Start a search from your profile and your first leads show up here as the agent finds and researches them."}
      </p>
      {running ? null : (
        <ButtonLink to="/onboarding/3" variant="outline" size="md" className="mt-2">
          Back to your profile
        </ButtonLink>
      )}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="flex flex-col rounded-xl border border-[#200D0D1A] bg-white px-6 py-2" aria-busy="true" aria-label="Loading leads">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex h-15 items-center gap-6 border-b border-b-[#200D0D0F] last:border-b-0">
          <Skeleton className="h-8 w-50" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-6 grow" />
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}
