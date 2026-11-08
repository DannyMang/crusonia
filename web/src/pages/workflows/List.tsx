// Final · Workflows · List. Every saved workflow with its status, trigger, last run, spend against its cap and an
// on/off switch; a row opens the builder. "Suggested" starts a workflow from a template.
import { useState } from "react";
import { useNavigate } from "react-router";
import { useFlowMutations, useFlows, type FlowDef } from "../../api/workflows.ts";
import { Page } from "../../components/AppShell.tsx";
import { WorkflowsIcon } from "../../components/icons.tsx";
import { Button, ButtonLink, EmptyState, QueryError, Skeleton } from "../../components/ui.tsx";
import { cx, usd } from "../../lib/format.ts";
import { useSummary } from "../../queries.ts";
import { flowPath, FlowStatusPill, SourceTag, spendLabel, whenLabel } from "./parts.tsx";
import { TEMPLATES, type Template } from "./templates.ts";

// Column widths (Paper: 270 / 190 / 150 / grow / 170 / 40), narrower below xl so "Last run" keeps room at 1024.
const COL = {
  name: "w-52 xl:w-67.5",
  status: "w-44 xl:w-47.5",
  trigger: "w-28 xl:w-37.5",
  spend: "w-40 xl:w-42.5",
  on: "w-10",
};
const INDENT = "pl-59 xl:pl-74.5"; // 16px padding + the name column + 12px gap: starts under Status

export default function WorkflowList() {
  const q = useFlows();
  const summary = useSummary();
  const spend = summary.data?.spend;
  const navigate = useNavigate();

  return (
    <Page className="grow gap-5 px-4 pb-9 pt-8 sm:px-8">
      <div className="flex h-10 shrink-0 items-center justify-between">
        <h1 className="text-xl/7 font-semibold tracking-[-0.01em] text-ink">Workflows</h1>
        <div className="flex items-center gap-2.5">
          {spend?.week_usd !== null && spend?.week_usd !== undefined ? (
            <div className="hidden whitespace-nowrap pr-1.5 text-[13px]/4 font-[450] text-muted sm:block">
              {spend.budget_usd !== null ? `${usd(spend.week_usd)} of ${usd(spend.budget_usd, 0)} this week` : `${usd(spend.week_usd)} this week`}
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => navigate("/app/workflows/new")}
            className="flex h-9 items-center gap-1.5 rounded-full bg-lime px-4 text-sm/4.5 font-medium text-ink transition-colors hover:bg-[#b3de7a]"
          >
            <span className="text-base/4">+</span>
            Build workflow
          </button>
        </div>
      </div>

      {q.isError ? (
        <QueryError error={q.error} what="workflows" onRetry={() => void q.refetch()} />
      ) : q.isPending ? (
        <ListSkeleton />
      ) : q.data.length === 0 ? (
        <div className="rounded-xl border border-[#200D0D1A]">
          <EmptyState
            icon={<WorkflowsIcon />}
            title="No workflows yet"
            action={
              <ButtonLink to="/app/workflows/new" variant="primary" size="md">
                Build workflow
              </ButtonLink>
            }
          />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[#200D0D1A]">
          <div className="flex min-w-[780px] flex-col">
            <div className="flex h-9 shrink-0 items-center gap-3 bg-[#200D0D06] px-4 text-xs/4 text-muted">
              <div className={cx(COL.name, "shrink-0")}>Play · agent</div>
              <div className={cx(COL.status, "shrink-0")}>Status</div>
              <div className={cx(COL.trigger, "shrink-0")}>Trigger</div>
              <div className="min-w-0 grow basis-0">Last run</div>
              <div className={cx(COL.spend, "shrink-0")}>Spend · cap</div>
              <div className={cx(COL.on, "shrink-0")}>On</div>
            </div>
            {q.data.map((w) => (
              <FlowRow key={w.id} flow={w} />
            ))}
          </div>
        </div>
      )}

      <Suggested />
    </Page>
  );
}

function FlowRow({ flow: w }: { flow: FlowDef }) {
  const navigate = useNavigate();
  const { patch } = useFlowMutations();
  const cap = w.spend.cap_usd;
  const fill = cap ? Math.min(1, w.spend.usd / cap) : 0;
  const atCap = cap !== null && w.spend.usd >= cap;
  const drafts = w.waiting?.drafts ?? 0;
  const toggling = patch.isPending && patch.variables?.id === w.id && patch.variables.body.enabled !== undefined;
  const raising = patch.isPending && patch.variables?.id === w.id && patch.variables.body.resume;
  const raiseTo = cap ? cap * 2 : 2;

  return (
    <div className="flex flex-col border-t border-t-[#200D0D14]">
      <div
        role="link"
        tabIndex={0}
        onClick={() => navigate(flowPath(w.id))}
        onKeyDown={(e) => {
          if (e.key === "Enter") navigate(flowPath(w.id));
        }}
        className="flex h-15 shrink-0 cursor-pointer items-center gap-3 px-4 hover:bg-[#200D0D04]"
      >
        <div className={cx(COL.name, "flex shrink-0 flex-col gap-1")}>
          <div className="truncate text-sm/4.5 font-medium text-ink">{w.name}</div>
          {w.source !== "user" ? (
            <div className="flex">
              <SourceTag source={w.source} size="sm" />
            </div>
          ) : w.agent ? (
            <div className="-mt-0.5 truncate text-xs/4 text-muted">{w.agent}</div>
          ) : null}
        </div>
        <div className={cx(COL.status, "flex shrink-0")}>
          <FlowStatusPill status={w.status} extra={w.status === "waiting" && drafts ? `${drafts} ${drafts === 1 ? "draft" : "drafts"}` : null} />
        </div>
        <div className={cx(COL.trigger, "shrink-0 truncate text-[13px]/4 text-ink")}>{w.trigger.label}</div>
        <div className="flex min-w-0 grow basis-0 flex-col gap-0.5">
          {w.last_run ? (
            <>
              <div className="truncate text-[13px]/4 text-ink">
                {whenLabel(w.last_run.started_at)} · {w.last_run.summary}
              </div>
              {w.last_run.detail ? <div className="truncate text-xs/4 text-muted">{w.last_run.detail}</div> : null}
            </>
          ) : (
            <div className="text-[13px]/4 text-muted">Not run yet</div>
          )}
        </div>
        <div className={cx(COL.spend, "flex shrink-0 flex-col gap-1.25")}>
          <div className={cx("truncate text-[13px]/4 tabular-nums", atCap ? "text-[#B42318]" : "text-ink")}>{spendLabel(w.spend)}</div>
          {cap !== null ? (
            <div className="h-1 shrink-0 rounded-full bg-[#200D0D0F]">
              <div className={cx("h-1 rounded-full", atCap ? "bg-[#B42318]" : "bg-ink")} style={{ width: `${Math.round(fill * 100)}%` }} />
            </div>
          ) : null}
        </div>
        <div className={cx(COL.on, "shrink-0")} onClick={(e) => e.stopPropagation()}>
          <Switch on={w.enabled} busy={toggling} label={`${w.name} on`} onChange={(enabled) => patch.mutate({ id: w.id, body: { enabled } })} />
        </div>
      </div>

      {w.status === "waiting" && drafts ? (
        <div className={cx("flex items-center gap-2.5 border-t border-t-[#200D0D0F] pb-3 pr-4 pt-3", INDENT)}>
          <WarnIcon />
          <div className="min-w-0 grow basis-0 text-[13px]/4.5 font-[450] text-ink">
            Next run will be skipped until you decide on {drafts} {drafts === 1 ? "draft" : "drafts"}.
          </div>
          <ButtonLink to="/app/outreach" variant="outline" size="sm">
            Review {drafts} {drafts === 1 ? "draft" : "drafts"}
          </ButtonLink>
        </div>
      ) : null}

      {w.status === "budget_paused" ? (
        <div className={cx("flex items-center gap-2.5 pb-3 pr-4", INDENT)}>
          <div className="min-w-0 grow basis-0 text-[13px]/4.5 font-[450] text-ink">{w.remaining ? `${w.remaining} leads left` : null}</div>
          <Button variant="primary" size="sm" loading={raising} onClick={() => patch.mutate({ id: w.id, body: { cap_usd: raiseTo, resume: true } })}>
            Raise cap to {usd(raiseTo, Number.isInteger(raiseTo) ? 0 : 2)} and resume
          </Button>
        </div>
      ) : null}

      {patch.isError && patch.variables?.id === w.id ? (
        <div className={cx("pb-3 pr-4", INDENT)}>
          <QueryError error={patch.error} what="this change" />
        </div>
      ) : null}
    </div>
  );
}

function Switch({ on, busy, label, onChange }: { on: boolean; busy?: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={busy}
      onClick={() => onChange(!on)}
      className={cx("relative h-4.5 w-8 rounded-full transition-colors disabled:opacity-60", on ? "bg-green" : "bg-[#200D0D33]")}
    >
      <span className={cx("absolute top-0.5 size-3.5 rounded-full bg-white transition-[left]", on ? "left-4" : "left-0.5")} />
    </button>
  );
}

const WarnIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden className="shrink-0">
    <path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0zM12 9v4M12 17h.01" fill="none" stroke="#B45309" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function Suggested() {
  const { create } = useFlowMutations();
  const navigate = useNavigate();
  const [using, setUsing] = useState<string | null>(null);
  const use = (t: Template) => {
    setUsing(t.id);
    create.mutate(t.input, {
      onSuccess: (res) => navigate(flowPath(res.workflow.id)),
      onSettled: () => setUsing(null),
    });
  };
  return (
    <section className="flex shrink-0 flex-col gap-3">
      <h2 className="text-[15px]/4.5 font-medium text-ink">Suggested</h2>
      <div className="grid gap-3 md:grid-cols-3">
        {TEMPLATES.map((t) => (
          <div key={t.id} className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-[#200D0D1A] px-4 py-3.5">
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="truncate text-sm/4.5 font-medium text-ink">{t.name}</div>
              <div className="truncate text-xs/4 text-muted">{t.meta}</div>
            </div>
            <Button variant="outline" size="sm" loading={using === t.id} disabled={create.isPending} onClick={() => use(t)}>
              Use
            </Button>
          </div>
        ))}
      </div>
      {create.isError ? <QueryError error={create.error} what="templates" /> : null}
    </section>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col overflow-clip rounded-xl border border-[#200D0D1A]">
      <div className="h-9 bg-[#200D0D06]" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex h-15 items-center gap-6 border-t border-t-[#200D0D14] px-4">
          <Skeleton className="h-8 w-52" />
          <Skeleton className="h-5.5 w-28" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 grow" />
          <Skeleton className="h-6 w-36" />
        </div>
      ))}
    </div>
  );
}
