// Dashboard · Workflow run (Paper artboard "Dashboard · Workflow run"): one agent session, step by step, with
// its cost, lead and approvals. Route /app/workflows/runs/:id (id = Naive session id). Polls while the run is
// active. The design's budget meter, workflow version card and Cancel run have no backing data or API, so they
// are left out.
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import { isApiError, type Run, type RunApproval, type RunLead, type RunStep, type WorkflowRun as WorkflowRunData } from "../api.ts";
import { Page } from "../components/AppShell.tsx";
import { useNow } from "../components/approvals/controls.tsx";
import { WorkflowsIcon } from "../components/icons.tsx";
import { clockSeconds, isActive, stopLabel } from "../components/workflows/status.tsx";
import { Timeline } from "../components/workflows/Timeline.tsx";
import { ButtonLink, EmptyState, QueryError, RingSpinner, Skeleton, stageLabel } from "../components/ui.tsx";
import { cx, duration, hostOf, leadTitle, timeAgo, timeLeft, usd } from "../lib/format.ts";
import { keys, useWorkflowRun } from "../queries.ts";

const meta = "text-xs/4 font-[525] text-faint";

export default function WorkflowRun() {
  const { id } = useParams();
  const qc = useQueryClient();
  const cached = qc.getQueryData<WorkflowRunData>(keys.run(id ?? ""));
  const q = useWorkflowRun(id, cached ? isActive(cached.run.status) : false);
  const now = useNow(1000);

  if (q.isLoading) return <Loading />;
  if (q.isError) {
    const notFound = isApiError(q.error) && q.error.status === 404 && !q.error.missingRoute;
    return (
      <Page className="min-h-screen gap-5 px-8 pb-6 pt-7">
        <Breadcrumb />
        {notFound ? (
          <div className="rounded-xl border border-[#200D0D1A]">
            <EmptyState
              icon={<WorkflowsIcon />}
              title="Run not found"
              body={
                <>
                  There is no run with the id <span className="text-ink">{id}</span>. The link may be incomplete, or the run belongs to another workspace.
                </>
              }
              action={<ButtonLink to="/app/workflows" variant="outline">Back to workflows</ButtonLink>}
              className="py-16"
            />
          </div>
        ) : (
          <QueryError error={q.error} what="this run" onRetry={() => void q.refetch()} />
        )}
      </Page>
    );
  }

  const { run, steps, lead, approvals, sync } = q.data!;
  const live = isActive(run.status);
  const pending = approvals
    .filter((a) => a.status === "pending" && new Date(a.expires_at).getTime() > now)
    .sort((a, b) => a.expires_at.localeCompare(b.expires_at));
  const waitingOn = pending[0];
  const title = lead ? leadTitle(lead) : runTitle(run);
  const tools = steps.filter((s) => s.type === "tool" || s.type === "approval").length;
  const stepCost = steps.reduce<number | null>((sum, s) => (s.cost_usd === undefined ? sum : (sum ?? 0) + s.cost_usd), null);
  const cost = run.cost_usd ?? stepCost;
  const timing = timingOf(run, steps, now);

  return (
    <Page className="min-h-screen gap-5 px-8 pb-6 pt-7">
      <div className="flex shrink-0 flex-col gap-3">
        <Breadcrumb name={run.name} id={run.id} />
        <div className="flex h-8.5 shrink-0 items-center gap-3.5">
          <Link
            to="/app/workflows"
            aria-label="Back to workflows"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[#16A34A29] bg-[#16A34A0F] hover:bg-[#16A34A1A]"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
              <path d="m12 19-7-7 7-7M19 12H5" fill="none" stroke="rgb(32 13 13 / 50%)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
          <h1 className="min-w-0 truncate text-xl/6 font-semibold tracking-[-0.01em] text-ink">{title}</h1>
          <RunChip run={run} waiting={Boolean(waitingOn)} />
          {live ? (
            <span className="flex shrink-0 items-center gap-1.5" title="Refreshes every 5 seconds while the run is active">
              <span className="size-1.75 rounded-full bg-green" />
              <span className={meta}>live</span>
            </span>
          ) : null}
          <span className="grow" />
          {waitingOn ? (
            <Link
              to={`/app/approvals/${encodeURIComponent(waitingOn.code)}`}
              className="flex h-8.5 shrink-0 items-center rounded-lg bg-lime px-4.5 text-[13px]/4 font-medium text-ink hover:bg-[#b3de7a]"
            >
              Open approval {waitingOn.code}
            </Link>
          ) : null}
        </div>
        <div className="flex min-h-4 shrink-0 flex-wrap items-center gap-x-4.5 gap-y-1 whitespace-nowrap">
          <span className={meta}>
            Started <span className="tabular-nums text-ink">{clockSeconds(run.started_at)}</span>
          </span>
          {timing ? <span className={meta}>{timing}</span> : null}
          <span className={meta}>
            Tool calls <span className="tabular-nums text-ink">{tools}</span>
          </span>
          <span className={meta}>
            Cost <span className="tabular-nums text-ink">{usd(cost)}</span>
          </span>
          <span className={meta}>
            Agent <span className="text-ink">Naive</span>
          </span>
          <span className={meta}>
            Purpose <span className="text-ink">{run.purpose.replace(/_/g, " ")}</span>
          </span>
        </div>
      </div>

      {/* Below 1280px the cost and lead panel moves under the timeline so the step table keeps its columns. */}
      <div className="flex grow flex-col items-stretch gap-4 xl:flex-row">
        <Timeline
          steps={steps}
          runStart={run.started_at}
          lead={lead}
          live={live}
          now={now}
          notice={
            sync && !sync.ok && sync.error ? (
              <div role="status" title={sync.error} className="flex items-center gap-2 border-t border-t-[#200D0D14] bg-[#FEF3C766] px-4 py-2 text-xs/4 font-medium text-[#92400E]">
                <span className="size-1.5 shrink-0 rounded-full bg-[#D97706]" />
                Could not refresh from Naive just now; showing the steps stored so far.
              </div>
            ) : null
          }
          footer={footerNote(run, steps, waitingOn, lead)}
        />
        <aside className="flex w-full shrink-0 flex-col overflow-clip rounded-xl border border-[#200D0D1A] xl:w-75">
          <CostSection run={run} steps={steps} cost={cost} tools={tools} />
          {lead ? <LeadSection lead={lead} steps={steps} /> : null}
          {approvals.length ? <ApprovalSection approvals={approvals} lead={lead} now={now} /> : null}
        </aside>
      </div>
    </Page>
  );
}

function runTitle(run: Run): string {
  const input = run.input ?? {};
  if (run.purpose === "find_leads" && typeof input.count === "number") return `Find up to ${input.count} leads`;
  if (run.purpose === "onboarding" && typeof input.url === "string") return `Profile from ${hostOf(input.url)}`;
  return run.name;
}

/** "Working 48s, then waiting 6m" from the steps; "Running 2m" / "Took 3m" otherwise. */
function timingOf(run: Run, steps: RunStep[], now: number): ReactNode {
  const start = new Date(run.started_at).getTime();
  const timed = steps.filter((s) => s.started_at).map((s) => new Date(s.started_at!).getTime() + (s.duration_ms ?? 0));
  const workEnd = timed.length ? Math.max(...timed) : null;
  if (run.status === "running") {
    return (
      <>
        Running <span className="tabular-nums text-ink">{duration(now - start)}</span>
      </>
    );
  }
  if ((run.status === "idle" || run.status === "paused") && workEnd) {
    return (
      <>
        Working <span className="tabular-nums text-ink">{duration(workEnd - start)}</span>, then waiting{" "}
        <span className="tabular-nums text-ink">{duration(now - workEnd)}</span>
      </>
    );
  }
  const end = workEnd ?? new Date(run.last_event_at).getTime();
  return (
    <>
      Took <span className="tabular-nums text-ink">{duration(end - start)}</span>
    </>
  );
}

function footerNote(run: Run, steps: RunStep[], a: RunApproval | undefined, lead: RunLead | null): ReactNode {
  const at = steps.at(-1)?.seq;
  const by = (iso: string) => <span className="tabular-nums text-ink">{clockSeconds(iso)}</span>;
  if (a?.kind === "send") {
    return (
      <>
        {a.draft ? `Draft v${a.draft.version}` : "The draft"} waits for your approval as <span className="text-ink">{a.code}</span>
        {lead?.email ? ` before anything goes to ${lead.email}` : ""}. If nobody approves it by {by(a.expires_at)}, it goes back to the agent.
      </>
    );
  }
  if (a) {
    return (
      <>
        Paused{at ? ` at step ${at}` : ""}. Resumes when <span className="text-ink">{a.code}</span> is answered; if nobody answers by {by(a.expires_at)},{" "}
        {a.kind === "tool" ? "the tool call is denied" : "the question expires"}.
      </>
    );
  }
  if (run.status === "error") return <span className="text-[#B42318]">Stopped{at ? ` at step ${at}` : ""}: {stopLabel(run.stop_reason) ?? "an error"}.</span>;
  if (run.status === "paused") {
    const why = run.stop_reason === "budget_paused" ? "because it reached its budget" : "while sends are paused";
    return (
      <>
        Paused{at ? ` at step ${at}` : ""} {why}. No new steps until it resumes.
      </>
    );
  }
  return null;
}

// ---------- header pieces ----------

function Breadcrumb({ name, id }: { name?: string; id?: string }) {
  return (
    <nav aria-label="Breadcrumb" className="flex h-4 shrink-0 items-center gap-1.5 text-xs/4">
      <Link to="/app/workflows" className="font-medium text-muted hover:text-ink">
        Workflows
      </Link>
      {name ? (
        <>
          <span className="text-[#200D0D59]">/</span>
          <span className="font-medium text-muted">{name}</span>
        </>
      ) : null}
      {id ? (
        <>
          <span className="text-[#200D0D59]">/</span>
          <span className="text-[11px]/4 font-medium text-ink" aria-current="page">
            {id}
          </span>
        </>
      ) : null}
    </nav>
  );
}

function RunChip({ run, waiting }: { run: Run; waiting: boolean }) {
  const base = "flex h-5.75 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs/4 font-medium tracking-[0.02em]";
  const soft = "bg-[#BDE68933] text-green";
  if (run.status === "running") {
    return (
      <span className={cx(base, soft)}>
        <RingSpinner />
        Running
      </span>
    );
  }
  if (run.status === "idle" || (waiting && run.status === "done")) {
    const label = waiting ? "Waiting for approval" : run.stop_reason === "awaiting_answer" ? "Waiting for your answer" : "Waiting on you";
    return <span className={cx(base, soft)}>{label}</span>;
  }
  if (run.status === "paused") return <span className={cx(base, "bg-pill text-[#200D0DB3]")}>{run.stop_reason === "budget_paused" ? "Paused at budget" : "Paused"}</span>;
  if (run.status === "error") return <span className={cx(base, "bg-[#FDECEB] text-[#B42318]")}>Stopped</span>;
  return <span className={cx(base, "border border-[#200D0D26] text-muted")}>Finished</span>;
}

// ---------- right column ----------

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-xs/4 font-[525] text-faint">{label}</dt>
      <dd className="min-w-0 truncate text-right text-xs/4 font-medium text-ink">{children}</dd>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-xs/4 font-medium text-muted">{children}</h2>;
}

function CostSection({ run, steps, cost, tools }: { run: Run; steps: RunStep[]; cost: number | null; tools: number }) {
  const models = steps.filter((s) => s.type === "model");
  const agentMs = steps.reduce((sum, s) => sum + (s.duration_ms ?? 0), 0);
  return (
    <section className="flex flex-col gap-2.5 p-4">
      <SectionTitle>{isActive(run.status) ? "Cost so far" : "Cost"}</SectionTitle>
      <div className="flex items-baseline gap-1.5">
        <div className="text-[22px]/6.5 font-semibold tracking-[-0.01em] tabular-nums text-ink">{usd(cost)}</div>
        <div className="text-[13px]/4 font-medium text-muted">{cost === null ? "not reported yet" : "for this run"}</div>
      </div>
      <dl className="flex flex-col gap-1.5 pt-0.5">
        <Row label="Tool calls">
          <span className="tabular-nums">{tools}</span>
        </Row>
        <Row label="Model calls">
          <span className="tabular-nums">{models.length}</span>
        </Row>
        {agentMs ? (
          <Row label="Time in steps">
            <span className="tabular-nums">{duration(agentMs)}</span>
          </Row>
        ) : null}
        {run.purpose !== "research" || run.leads_processed ? (
          <Row label="Leads processed">
            <span className="tabular-nums">{run.leads_processed}</span>
          </Row>
        ) : null}
      </dl>
    </section>
  );
}

function LeadSection({ lead, steps }: { lead: RunLead; steps: RunStep[] }) {
  const evidence = steps.filter((s) => s.tool === "save_evidence" && !s.is_error).length;
  const name = leadTitle(lead);
  return (
    <section className="flex flex-col gap-2.5 border-t border-t-[#200D0D14] p-4">
      <div className="flex items-center justify-between">
        <SectionTitle>Lead</SectionTitle>
        <Link to={`/app/leads/${encodeURIComponent(lead.id)}`} className="text-xs/4 font-medium text-ink underline decoration-1 underline-offset-[3px]">
          Open lead
        </Link>
      </div>
      <div className="flex items-center gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-pill text-[13px]/4 font-semibold text-ink">{name.charAt(0).toUpperCase()}</div>
        <div className="flex min-w-0 grow flex-col gap-px">
          <div className="truncate text-sm/4.5 font-semibold text-ink">{name}</div>
          {lead.domain ? <div className="truncate text-[11px]/3.5 text-muted">{lead.domain}</div> : null}
        </div>
        {lead.score !== null ? (
          <span className="flex h-5.5 shrink-0 items-center rounded-full bg-lime px-2 text-xs/4 font-semibold tabular-nums text-ink">{lead.score}</span>
        ) : null}
      </div>
      <dl className="flex flex-col gap-1.5">
        <Row label="Contact">{[lead.name, lead.title].filter(Boolean).join(", ") || "—"}</Row>
        <Row label="Email">{lead.email ?? "—"}</Row>
        <Row label="Consent">
          <span className="inline-flex items-center gap-1.5">
            <span className={cx("size-1.5 shrink-0 rounded-full", lead.has_consent ? "bg-green" : "bg-[#B42318]")} />
            {lead.has_consent ? "Opted in" : "No consent on file"}
          </span>
        </Row>
        <Row label="Stage">{stageLabel(lead.stage)}</Row>
        {evidence ? <Row label="Evidence">{evidence === 1 ? "1 source saved in this run" : `${evidence} sources saved in this run`}</Row> : null}
      </dl>
    </section>
  );
}

const DECIDED: Record<string, string> = { approved: "Approved", rejected: "Rejected", answered: "Answered", expired: "Expired" };

function ApprovalSection({ approvals, lead, now }: { approvals: RunApproval[]; lead: RunLead | null; now: number }) {
  const sorted = [...approvals].sort((a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1) || b.created_at.localeCompare(a.created_at)).slice(0, 3);
  return (
    <section className="flex flex-col gap-3 border-t border-t-[#200D0D14] p-4">
      <SectionTitle>{sorted.length === 1 ? "Approval" : "Approvals"}</SectionTitle>
      {sorted.map((a) => {
        const open = a.status === "pending" && new Date(a.expires_at).getTime() > now;
        const tool = typeof a.payload?.name === "string" ? a.payload.name : null;
        return (
          <div key={a.code} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Link to={`/app/approvals/${encodeURIComponent(a.code)}`} className="text-base/5 font-semibold tracking-[0.04em] text-ink hover:underline">
                {a.code}
              </Link>
              <span className="text-xs/4 font-medium text-ink">
                {open ? (
                  <>
                    expires in <span className="font-semibold tabular-nums">{timeLeft(a.expires_at, now)}</span>
                  </>
                ) : (
                  <span className="text-muted">
                    {DECIDED[a.status] ?? (a.status === "pending" ? "Expired" : a.status)}
                    {a.decided_at ? ` ${timeAgo(a.decided_at, now)}` : ""}
                  </span>
                )}
              </span>
            </div>
            <p className="text-xs/4.25 font-medium text-muted">
              {a.kind === "send"
                ? `${open ? "Waiting in your approvals queue. " : ""}Bound to ${a.draft ? `v${a.draft.version}` : "one draft version"}${lead?.email ? ` for ${lead.email}` : ""} only.`
                : a.kind === "tool"
                  ? `The agent ${open ? "wants" : "wanted"} to run ${tool ?? "a tool"}.`
                  : `The agent ${open ? "is asking" : "asked"} you a question.`}
            </p>
          </div>
        );
      })}
    </section>
  );
}

function Loading() {
  return (
    <Page className="min-h-screen gap-5 px-8 pb-6 pt-7">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-8 w-96" />
        <Skeleton className="h-4 w-[560px]" />
      </div>
      <div className="flex grow gap-4">
        <div className="flex grow flex-col gap-3 rounded-xl border border-[#200D0D1A] p-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
        <div className="flex w-75 shrink-0 flex-col gap-3 rounded-xl border border-[#200D0D1A] p-4">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-20 w-full" />
        </div>
      </div>
    </Page>
  );
}
