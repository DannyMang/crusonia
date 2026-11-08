// Dashboard · Home (Paper artboard "Dashboard · Home"): pipeline strip, drafts waiting for approval,
// active workflows, spend and recent replies. Real data from /api/summary; calm empty states when empty.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { isApiError, type ApprovalListItem, type Lead, type Pipeline, type Reply, type Summary, type SummaryApproval, type Workflow } from "../api.ts";
import { useApi, useSession } from "../auth.tsx";
import { Page } from "../components/AppShell.tsx";
import { ChevronRight, XIcon } from "../components/icons.tsx";
import { Button, ButtonLink, Card, EmptyState, LiveChip, Pill, QueryError, ReplyLabel, Skeleton } from "../components/ui.tsx";
import { cx, duration, greeting, hostOf, num, plural, shortDate, timeAgo, usd, weekdayDate } from "../lib/format.ts";
import { keys, useApprovals, useLeads, usePause, useProfile, useSummary } from "../queries.ts";

const label = "text-[13px]/4 font-medium text-muted";
const sectionTitle = "text-[15px]/4.5 font-semibold tracking-[-0.01em] text-ink";

export default function Home() {
  const summary = useSummary();
  // If /api/summary is unavailable on this deployment (route not deployed yet, or the database not migrated
  // for it), count the pipeline from the newest 200 leads and list /api/approvals instead (older endpoints).
  const missing = isApiError(summary.error) && (summary.error.missingRoute || summary.error.code === "schema_out_of_date");
  const fallbackApprovals = useApprovals({ status: "pending" });
  const fallbackLeads = useLeads({ limit: 200 });
  const pause = usePause();
  const data: Summary | undefined =
    summary.data ?? (missing && fallbackApprovals.data && fallbackLeads.data ? fallbackSummary(fallbackLeads.data.data, fallbackApprovals.data.data, pause.data?.paused ?? false) : undefined);

  return (
    <Page className="gap-7 px-12 pb-14 pt-10">
      <Header data={data} />
      {summary.isError && !missing ? <QueryError error={summary.error} what="your overview" onRetry={() => void summary.refetch()} /> : null}
      {data?.paused ? (
        <div role="status" className="flex items-center gap-3 rounded-[10px] border border-[#200D0D1A] bg-pill px-4 py-3 text-[13px]/5 font-medium">
          <span className="size-1.5 rounded-full bg-ink" />
          Sends are paused. Nothing goes out and no new research starts until you turn sends back on in the sidebar.
        </div>
      ) : null}
      <PipelineStrip data={data} partial={missing} />
      <div className="flex items-start gap-6">
        <div className="flex min-w-0 grow basis-0 flex-col gap-7">
          <WaitingForYou approvals={data?.pending_approvals} total={data?.pending_approvals_total ?? 0} loading={!data && !summary.isError} />
          <ActiveWorkflows workflows={data?.active_workflows} loading={!data && !summary.isError} partial={missing} />
        </div>
        <div className="flex w-90 shrink-0 flex-col gap-6">
          <Spend spend={data?.spend} loading={!data && !summary.isError} />
          <RecentReplies replies={data?.recent_replies} loading={!data && !summary.isError} partial={missing} />
        </div>
      </div>
    </Page>
  );
}

/** Same buckets as the backend's summary: where each lead is now (unsubscribed leads in none). */
function fallbackSummary(leads: Lead[], approvals: ApprovalListItem[], paused: boolean): Summary {
  const byStage: Record<string, number> = {};
  for (const l of leads) byStage[l.stage] = (byStage[l.stage] ?? 0) + 1;
  const n = (...stages: string[]) => stages.reduce((sum, st) => sum + (byStage[st] ?? 0), 0);
  const open = new Set(approvals.filter((a) => a.kind === "send").map((a) => a.lead_id));
  const awaiting = leads.filter((l) => l.stage === "awaiting_approval" && open.has(l.id)).length;
  const pipeline: Pipeline = {
    found: n("new", "no_consent", "researching"),
    researched: n("qualified", "disqualified", "needs_review"),
    drafted: n("awaiting_approval") - awaiting,
    awaiting_approval: awaiting,
    sent: n("sent"),
    replied: n("replied", "interested", "not_interested"),
    meetings: n("meeting_booked"),
  };
  return {
    pipeline,
    pipeline_by_stage: byStage,
    total_leads: leads.length,
    pending_approvals: approvals.slice(0, 5).map((a) => ({ ...a, lead_name: a.lead?.name ?? null, company: a.lead?.company ?? null, subject: a.draft?.subject ?? null })),
    pending_approvals_total: approvals.length,
    active_workflows: [],
    recent_replies: [],
    spend: { week_usd: null, budget_usd: null },
    paused,
  };
}

// ---------- header ----------

function Header({ data }: { data: Summary | undefined }) {
  const { user } = useSession();
  const first = user?.name?.split(" ")[0];
  const total = data?.total_leads ?? 0;
  const waiting = data?.pending_approvals_total ?? 0;
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl/7.5 font-semibold tracking-[-0.02em] text-ink">
          {greeting()}
          {first ? `, ${first}` : ""}
        </h1>
        <p className="text-sm/5 font-medium text-muted">
          {weekdayDate()} ·{" "}
          {!data ? (
            "Loading your pipeline…"
          ) : total > 0 ? (
            <>
              You have <span className="text-ink">{total === 1 ? "1 lead" : `${num(total)} leads`}</span> and{" "}
              {waiting ? (
                <>
                  <span className="text-ink">{waiting === 1 ? "1 draft" : `${waiting} drafts`}</span> {waiting === 1 ? "needs" : "need"} your OK.
                </>
              ) : (
                <>nothing is waiting on you.</>
              )}
            </>
          ) : waiting ? (
            <>
              <span className="text-ink">{waiting === 1 ? "1 draft" : `${waiting} drafts`}</span> need your OK.
            </>
          ) : (
            "No leads yet. Tell Crusonia about your company and your agents start finding them."
          )}
        </p>
      </div>
      <AgentPill />
    </div>
  );
}

function AgentPill() {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem("crusonia.hideAgentPill") === "1";
    } catch {
      return false;
    }
  });
  if (hidden) return null;
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 rounded-full bg-[#BDE68973] pl-3.75 pr-1.25">
      <Link to="/app/connect" className="flex items-center gap-1">
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden className="shrink-0">
          <rect x="5.75" y="5.75" width="7.5" height="7.5" rx="2" fill="none" stroke="#16A34A" strokeWidth="1.4" />
          <path d="M10.25 3.75a2 2 0 00-2-2h-3.5a3 3 0 00-3 3v3.5a2 2 0 002 2" fill="none" stroke="#16A34A" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <span className="pl-1 text-[13px]/4 font-medium text-ink">Connect your agent here!</span>
      </Link>
      <button
        type="button"
        aria-label="Hide"
        onClick={() => {
          setHidden(true);
          try {
            localStorage.setItem("crusonia.hideAgentPill", "1");
          } catch {
            // ignore
          }
        }}
        className="flex size-6.5 shrink-0 items-center justify-center rounded-full text-[rgb(22_163_74/72%)] hover:bg-[#FFFFFF80]"
      >
        <XIcon />
      </button>
    </div>
  );
}

// ---------- pipeline ----------

function Arrow() {
  return (
    <div className="flex w-4 shrink-0 items-center justify-center">
      <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden>
        <path d="M9 6l6 6-6 6" fill="none" stroke="rgb(32 13 13 / 30%)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function Stat({ title, value, note, accent }: { title: string; value: string | undefined; note: string; accent?: boolean }) {
  return (
    <div className="flex grow basis-0 flex-col gap-1 px-3 py-1.5">
      <div className={label}>{title}</div>
      {value === undefined ? (
        <Skeleton className="my-1 h-5 w-12" />
      ) : (
        <div className={cx("tabular-nums text-[22px]/7 font-semibold tracking-[-0.02em]", accent ? "text-green" : "text-ink")}>{value}</div>
      )}
      <div className="text-xs/4 font-medium text-muted">{note}</div>
    </div>
  );
}

function PipelineStrip({ data, partial }: { data: Summary | undefined; partial: boolean }) {
  const profile = useProfile();
  const p = data?.pipeline;
  const icp = profile.data?.segments?.[0]?.name ?? profile.data?.icp_description ?? null;
  const approvals = data?.pending_approvals ?? [];
  // Only the 5 newest approvals come with the summary, so "oldest" is exact only when that is all of them.
  const oldest =
    approvals.length && approvals.length === data?.pending_approvals_total
      ? Math.max(...approvals.map((a) => Date.now() - new Date(a.created_at).getTime()))
      : null;
  const v = (n: number | undefined) => (p ? num(n ?? 0) : undefined);
  const workflows = data?.active_workflows.length;
  const context = [
    partial ? "counted from your newest leads" : "where your leads are now",
    workflows !== undefined && !partial ? plural(workflows, "active workflow") : null,
    icp ? `ICP “${icp.length > 48 ? `${icp.slice(0, 47)}…` : icp}”` : null,
  ].filter(Boolean);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-3">
          <h2 className={sectionTitle}>Pipeline</h2>
          <div className={label}>{context.join(" · ")}</div>
        </div>
        <Link to="/app/leads" className="text-[13px]/4 font-medium text-ink underline decoration-[#200D0D4D] decoration-1 underline-offset-[3px] hover:decoration-ink">
          Open leads
        </Link>
      </div>
      <div className="flex border-y border-y-[#200D0D1A] py-3.5">
        <Stat title="Found" value={v(p?.found)} note="new or in research" />
        <Arrow />
        <Stat title="Researched" value={v(p?.researched)} note="scored, sourced" />
        <Arrow />
        <Stat title="Drafted" value={v(p?.drafted)} note="draft needs a redo" />
        <Arrow />
        <div className="flex grow-[1.25] basis-0 flex-col gap-1 rounded-[10px] border border-panel-line bg-panel px-3 py-1.5">
          <div className="text-[13px]/4 font-semibold text-ink">Awaiting approval</div>
          <div className="flex items-center gap-2">
            {p ? (
              <div className="text-[22px]/7 font-semibold tracking-[-0.02em] text-ink tabular-nums">{num(p.awaiting_approval)}</div>
            ) : (
              <Skeleton className="my-1 h-5 w-8" />
            )}
            {p && p.awaiting_approval > 0 ? <Pill tone="lime">needs you</Pill> : null}
          </div>
          <div className="text-xs/4 font-medium text-muted">
            {oldest !== null ? `oldest waiting ${duration(oldest)}` : data?.pending_approvals_total ? plural(data.pending_approvals_total, "open approval") : "nothing waiting"}
          </div>
        </div>
        <Arrow />
        <Stat title="Sent" value={v(p?.sent)} note="no reply yet" />
        <Arrow />
        <Stat title="Replied" value={v(p?.replied)} note="reply received" />
        <Arrow />
        <Stat title="Meetings" value={v(p?.meetings)} note={p?.meetings ? "booked" : "none yet"} accent={Boolean(p?.meetings)} />
      </div>
    </section>
  );
}

// ---------- waiting for you ----------

function ApproveButton({ approval }: { approval: SummaryApproval }) {
  const api = useApi();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(t);
  }, [confirming]);
  const approve = useMutation({
    mutationFn: () => api.approve(approval.code),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.summary });
      void qc.invalidateQueries({ queryKey: ["approvals"] });
    },
  });
  if (approve.isSuccess) return <Pill tone="green">Approved</Pill>;
  // Approving a send emails a real person, so it takes a second, deliberate click.
  return (
    <Button
      size="sm"
      variant={confirming ? "ink" : "primary"}
      loading={approve.isPending}
      onClick={() => (confirming ? approve.mutate() : setConfirming(true))}
      title={approval.kind === "send" ? `Sends to ${approval.recipient ?? approval.lead?.email ?? "the lead"}` : undefined}
    >
      {confirming ? (approval.kind === "send" ? "Send now?" : "Confirm") : "Approve"}
    </Button>
  );
}

function WaitingRow({ a }: { a: SummaryApproval }) {
  const email = a.recipient ?? a.lead?.email ?? null;
  const company = a.company ?? a.lead_name ?? email ?? "Unknown lead";
  const domain = email?.split("@")[1] ?? "";
  const workflow = typeof a.payload?.workflow === "string" ? a.payload.workflow : null;
  return (
    <div className="flex items-center gap-3.5 border-t border-t-[#200D0D14] px-4.5 py-3.5">
      <div className="flex w-34 shrink-0 flex-col gap-0.5">
        <div className="truncate text-sm/4.5 font-medium text-ink">{company}</div>
        <div className="truncate text-[11px]/3.5 text-muted">{hostOf(domain)}</div>
      </div>
      <div className="flex min-w-0 grow basis-0 flex-col gap-0.75">
        <div className="truncate text-[13px]/4 font-medium text-ink">{a.subject ? `“${a.subject}”` : a.summary}</div>
        <div className="truncate text-xs/4 font-medium text-muted">
          {[a.company ? a.lead_name : null, workflow ?? (a.draft ? `draft v${a.draft.version}` : a.kind)].filter(Boolean).join(" · ")}
        </div>
      </div>
      <div className="flex w-19 shrink-0 flex-col items-end gap-0.5">
        <div className="whitespace-pre text-[13px]/4 font-semibold text-ink tabular-nums">{a.code}</div>
        <div className="whitespace-pre text-[11px]/3.5 font-medium text-muted">waiting {duration(Date.now() - new Date(a.created_at).getTime())}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <ButtonLink to={`/app/approvals/${a.code}`} variant="outline" size="sm">
          Review
        </ButtonLink>
        <ApproveButton approval={a} />
      </div>
    </div>
  );
}

function WaitingForYou({ approvals, total, loading }: { approvals: SummaryApproval[] | undefined; total: number; loading: boolean }) {
  const shown = approvals?.slice(0, 4) ?? [];
  const rest = Math.max(0, total - shown.length);
  return (
    <Card className="flex w-full flex-col overflow-clip">
      <div className="flex items-center justify-between px-4.5 pb-3.5 pt-4">
        <div className="flex items-center gap-2.5">
          <h2 className={sectionTitle}>Waiting for you</h2>
          {total ? <Pill tone="lime" mono>{total}</Pill> : null}
          <div className={label}>drafts held until you approve · nothing sends on its own</div>
        </div>
        <Link to="/app/approvals" className="flex items-center gap-1 text-[13px]/4 font-medium text-ink hover:underline">
          All approvals
          <ChevronRight className="text-green" />
        </Link>
      </div>
      {loading ? (
        [0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3.5 border-t border-t-[#200D0D14] px-4.5 py-4">
            <Skeleton className="h-8 w-34" />
            <Skeleton className="h-8 grow" />
            <Skeleton className="h-7.5 w-36" />
          </div>
        ))
      ) : shown.length ? (
        shown.map((a) => <WaitingRow key={a.code} a={a} />)
      ) : (
        <div className="border-t border-t-[#200D0D14]">
          <EmptyState
            title="Nothing waiting for you"
            body="When an agent drafts an email, it waits here until you approve the exact draft. Nothing sends on its own."
          />
        </div>
      )}
      {shown.length ? (
        <div className="flex items-center justify-between border-t border-t-[#200D0D14] bg-[#200D0D06] px-4.5 py-3">
          <div className="text-xs/4 font-medium text-muted">
            {rest ? (
              <Link to="/app/approvals" className="hover:text-ink hover:underline">
                {rest} more in Approvals
              </Link>
            ) : (
              "That's everything"
            )}
          </div>
          <div className="text-xs/4 font-medium text-muted">Every claim in a draft links to its source</div>
        </div>
      ) : null}
    </Card>
  );
}

// ---------- active workflows ----------

const RUNNING = new Set(["running", "idle"]);

function WorkflowCard({ w }: { w: Workflow }) {
  const [open, setOpen] = useState(true);
  const latest = w.runs[0];
  const to = latest ? `/app/workflows/runs/${encodeURIComponent(latest.id)}` : "/app/workflows";
  return (
    <Card className="flex flex-col gap-3 px-4.75 pb-4 pt-4.25">
      <div className="flex items-center justify-between gap-3">
        <Link to={to} className="flex min-w-0 items-baseline gap-2.5 hover:underline">
          <span className="truncate text-[15px]/4.5 font-semibold tracking-[-0.01em] text-ink">{w.name}</span>
          <span className="shrink-0 text-xs/4 text-faint">{w.purpose}</span>
        </Link>
        <div className="flex items-center gap-2.5">
          {w.status === "running" ? (
            <LiveChip>{w.purpose === "research" ? "researching" : "running"}</LiveChip>
          ) : w.status === "idle" ? (
            <LiveChip spinning={false}>waiting on you</LiveChip>
          ) : (
            <Pill tone="gray" className="h-5.75 px-3 text-[13px]/4 font-medium">
              {w.status}
            </Pill>
          )}
          <button
            type="button"
            aria-label={open ? "Collapse" : "Expand"}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="flex size-6.5 shrink-0 items-center justify-center rounded-full border border-[#200D0D1A] bg-[#FFFFFFA6] hover:bg-[#200D0D08]"
          >
            <svg width="10" height="7" viewBox="0 0 10 7" aria-hidden className={open ? "" : "rotate-180"}>
              <polygon points="0,7 10,7 5,0" fill="rgb(32 13 13 / 58%)" />
            </svg>
          </button>
        </div>
      </div>
      <div className="text-[13px]/3.75 font-medium text-faint">
        {plural(w.run_count, "run")} · {w.active_runs} active · started {shortDate(w.first_started_at)}
        {w.last_event_at ? ` · last activity ${timeAgo(w.last_event_at)}` : ""}
      </div>
      {open ? (
        <div className="flex border-t border-t-[#200D0D1A] pt-2.75">
          <WfStat first title="Cost" value={usd(w.cost_usd)} />
          <WfStat title="Leads processed" value={num(w.leads_processed)} />
          <WfStat title="Runs" value={`${num(w.active_runs)}/${num(w.run_count)}`} />
          <WfStat title="Last event" value={timeAgo(w.last_event_at)} />
        </div>
      ) : null}
    </Card>
  );
}

function WfStat({ title, value, first }: { title: string; value: string; first?: boolean }) {
  return (
    <div className={cx("flex w-37.5 shrink-0 flex-col gap-1", !first && "border-l border-l-[#200D0D1A] pl-4.75")}>
      <div className="text-[13px]/4 font-medium text-faint">{title}</div>
      <div className="tabular-nums text-sm/4.5 font-semibold text-ink">{value}</div>
    </div>
  );
}

function ActiveWorkflows({ workflows, loading, partial }: { workflows: Workflow[] | undefined; loading: boolean; partial: boolean }) {
  const [tab, setTab] = useState<"running" | "paused">("running");
  const running = workflows?.filter((w) => RUNNING.has(w.status)) ?? [];
  const paused = workflows?.filter((w) => !RUNNING.has(w.status)) ?? [];
  const list = tab === "running" ? running : paused;
  const navigate = useNavigate();
  return (
    <section className="flex flex-col gap-3.5">
      <div className="flex items-center justify-between">
        <h2 className={sectionTitle}>Active workflows</h2>
        <div className="flex items-center gap-1 rounded-full border border-[#200D0D1A] bg-[#200D0D0A] p-1" role="tablist">
          {(["running", "paused"] as const).map((t) => {
            const active = tab === t;
            const n = t === "running" ? running.length : paused.length;
            return (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t)}
                className={cx("flex h-7 items-center gap-2 rounded-full pr-2", active ? "bg-lime pl-3.5" : "pl-3 hover:bg-[#200D0D08]")}
              >
                <span className={cx("text-[13px]/4 font-medium", active ? "text-ink" : "text-faint")}>{t === "running" ? "Running" : "Paused"}</span>
                <span className={cx("flex h-4 items-center rounded-full px-1.5 tabular-nums text-xs/3 font-medium", active ? "bg-[#BDE6893D] text-ink" : "bg-[#200D0D14] text-faint")}>
                  {n}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {loading ? (
        <Card className="flex flex-col gap-3 px-4.75 py-4.25">
          <Skeleton className="h-4.5 w-56" />
          <Skeleton className="h-4 w-80" />
          <Skeleton className="h-9 w-full" />
        </Card>
      ) : list.length ? (
        list.map((w) => <WorkflowCard key={w.id} w={w} />)
      ) : (
        <Card>
          <EmptyState
            title={tab === "running" ? "No workflows running" : "Nothing paused"}
            body={
              partial
                ? "Workflow status is not available on this deployment yet."
                : tab === "running"
                  ? "Workflows research, score and draft for you. Start one by finding your first leads."
                  : "Paused workflows show up here until you resume them."
            }
            action={tab === "running" && !partial ? <Button onClick={() => navigate("/onboarding/1")}>Find leads</Button> : undefined}
          />
        </Card>
      )}
    </section>
  );
}

// ---------- right column ----------

function Spend({ spend, loading }: { spend: Summary["spend"] | undefined; loading: boolean }) {
  const used = spend?.week_usd ?? null;
  const budget = spend?.budget_usd ?? null;
  const share = used !== null && budget ? Math.min(100, (used / budget) * 100) : 0;
  return (
    <Card className="flex flex-col gap-3.5 px-4.5 pb-4.5 pt-4">
      <div className="flex items-baseline justify-between">
        <h2 className={sectionTitle}>Spend this week</h2>
        <div className="text-xs/4 font-medium text-muted">last 7 days</div>
      </div>
      {loading ? (
        <Skeleton className="h-7.5 w-40" />
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <div className="text-[26px]/7.5 font-semibold tracking-[-0.03em] text-ink tabular-nums">{usd(used ?? 0)}</div>
            <div className="text-[13px]/4 font-medium text-muted">
              {budget !== null ? (
                <>
                  of <span className="text-ink tabular-nums">{usd(budget)}</span> budget
                </>
              ) : (
                "no weekly budget set"
              )}
            </div>
          </div>
          <div
            className="flex h-2 shrink-0 overflow-clip rounded-full bg-pill"
            role="meter"
            aria-valuenow={Math.round(share)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Budget used"
          >
            <div className="h-full bg-ink" style={{ width: `${share}%` }} />
          </div>
          <div className="border-t border-t-[#200D0D14] pt-3 text-xs/4 font-medium text-muted">
            {used === null
              ? "Agent spend shows up here once Naive reports usage for a run."
              : budget !== null
                ? `${usd(Math.max(0, budget - used))} left of this week's budget`
                : "Naive usage across every run active this week"}
          </div>
        </>
      )}
    </Card>
  );
}

function ReplyRow({ r }: { r: Reply }) {
  const who = r.lead?.name ?? r.from ?? "Unknown sender";
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 truncate text-[13px]/4 font-medium text-ink">
          {who}
          {r.lead?.company ? <span className="text-muted"> · {r.lead.company}</span> : null}
        </div>
        <ReplyLabel label={r.label} />
      </div>
      <div className="line-clamp-2 text-xs/4.25 font-medium text-muted">{r.preview ? `“${r.preview}”` : (r.subject ?? "")}</div>
    </>
  );
  return r.lead_id ? (
    <Link to={`/app/leads/${encodeURIComponent(r.lead_id)}`} className="flex flex-col gap-1 border-t border-t-[#200D0D14] px-4.5 py-3 hover:bg-[#200D0D05]">
      {body}
    </Link>
  ) : (
    <div className="flex flex-col gap-1 border-t border-t-[#200D0D14] px-4.5 py-3">{body}</div>
  );
}

function RecentReplies({ replies, loading, partial }: { replies: Reply[] | undefined; loading: boolean; partial: boolean }) {
  return (
    <Card className="flex flex-col overflow-clip">
      <div className="flex items-baseline justify-between px-4.5 pb-3 pt-4">
        <h2 className={sectionTitle}>Recent replies</h2>
        <Link to="/app/replies" className="text-xs/4 font-medium text-muted hover:text-ink">
          sorted by agent
        </Link>
      </div>
      {loading ? (
        [0, 1].map((i) => (
          <div key={i} className="flex flex-col gap-1.5 border-t border-t-[#200D0D14] px-4.5 py-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-full" />
          </div>
        ))
      ) : replies?.length ? (
        replies.slice(0, 5).map((r) => <ReplyRow key={r.id} r={r} />)
      ) : (
        <div className="border-t border-t-[#200D0D14] px-4.5 py-6 text-center">
          <div className="text-[13px]/4 font-semibold text-ink">No replies yet</div>
          <div className="mt-1 text-xs/4.25 font-medium text-muted">
            {partial ? "Replies are not available on this deployment yet." : "Replies land here, sorted into Interested, Not now and Unsubscribed."}
          </div>
        </div>
      )}
    </Card>
  );
}
