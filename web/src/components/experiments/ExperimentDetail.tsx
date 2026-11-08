// Right pane of Dashboard · Experiments: hypothesis, setup facts, per-arm results, cumulative replies, an honest
// read of the numbers (never a winner) and spend. "Stop early" is the only write (PATCH {status: "stopped"}).
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import type { DailyPoint, Experiment, ExperimentDetail as Detail } from "../../api.ts";
import { useApi } from "../../auth.tsx";
import { cx, pct, shortDate, usd } from "../../lib/format.ts";
import { keys, useProfile } from "../../queries.ts";
import { errorCopy, RingSpinner } from "../ui.tsx";
import { arm, ARMS, armDescription, armName, dayLabel, dayNumber, isLive, stopRuleText, totals, verdict } from "./derive.ts";
import { ARM_COLOR, RepliesChart } from "./RepliesChart.tsx";

export function ExperimentDetail({ e, daily }: { e: Experiment; daily: DailyPoint[] | undefined }) {
  return (
    <>
      <Head e={e} />
      <Facts e={e} />
      <div className="flex grow flex-col gap-3.5 px-5 py-4">
        <VariantTable e={e} />
        <RepliesChart e={e} daily={daily} />
        <Verdict e={e} />
        <SpendLine e={e} />
      </div>
    </>
  );
}

// ---------- head ----------

export function StatusChip({ e }: { e: Experiment }) {
  const base = "inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[11px]/3.5 font-medium";
  if (isLive(e))
    return (
      <span className={cx(base, "bg-lime text-ink")}>
        <RingSpinner />
        running · {e.stop_rule_met ? "stop rule met" : dayLabel(e)}
      </span>
    );
  return <span className={cx(base, "bg-pill text-[#200D0DB3]")}>stopped{e.stopped_at ? ` · ${shortDate(e.stopped_at)}` : ""}</span>;
}

/** Stopping ends both arms for good, so it takes a second, deliberate click. */
function StopEarly({ e }: { e: Experiment }) {
  const api = useApi();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(t);
  }, [confirming]);
  const stop = useMutation({
    mutationFn: () => api.stopExperiment(e.id),
    onSuccess: ({ experiment }) => {
      qc.setQueryData<Detail>(keys.experiment(e.id), (old) => (old ? { ...old, experiment } : old));
      qc.setQueryData<Experiment[]>(keys.experiments, (old) => old?.map((x) => (x.id === e.id ? experiment : x)));
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.experiments });
      void qc.invalidateQueries({ queryKey: keys.experiment(e.id) });
    },
  });
  const label = e.stop_rule_met ? "Stop now" : "Stop early";
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => (confirming ? stop.mutate() : setConfirming(true))}
        disabled={stop.isPending}
        title={confirming ? "Both arms stop for good; the numbers so far are kept" : undefined}
        className={cx(
          "flex h-8 items-center rounded-full border px-3.5 text-[13px]/4 font-medium disabled:opacity-60",
          confirming ? "border-ink bg-ink text-white" : "border-[#200D0D26] bg-white text-ink hover:bg-[#200D0D08]",
        )}
      >
        {stop.isPending ? "Stopping…" : confirming ? "Stop both arms?" : label}
      </button>
      {stop.isError ? <span className="max-w-60 text-right text-[11px]/3.5 font-medium text-[#B42318]">{errorCopy(stop.error, "Experiments").body}</span> : null}
    </div>
  );
}

function Head({ e }: { e: Experiment }) {
  return (
    <div className="flex shrink-0 items-start justify-between gap-4 border-b border-b-[#200D0D1A] px-5 pb-4 pt-4.5">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-center gap-2.5">
          <div className="text-xs/4 font-medium text-muted">{e.hypothesis ? "Hypothesis" : "Experiment"}</div>
          <StatusChip e={e} />
        </div>
        <h2 className="text-lg/6 font-semibold tracking-[-0.015em] text-ink">{e.hypothesis || e.name}</h2>
      </div>
      {isLive(e) ? (
        <div className="flex shrink-0 items-center gap-2">
          <StopEarly e={e} />
        </div>
      ) : null}
    </div>
  );
}

// ---------- setup facts ----------

function Fact({ title, value, sub, className }: { title: string; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex min-w-0 basis-0 flex-col gap-0.75", className)}>
      <div className="text-xs/4 font-medium text-muted">{title}</div>
      <div className="truncate text-sm/4.5 font-semibold text-ink" title={typeof value === "string" ? value : undefined}>
        {value}
      </div>
      {sub ? (
        <div className="truncate text-xs/4 font-medium text-muted" title={typeof sub === "string" ? sub : undefined}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

function Facts({ e }: { e: Experiment }) {
  const profile = useProfile();
  const seg = profile.data?.segments?.find((s) => s.name.trim().toLowerCase() === e.segment?.trim().toLowerCase());
  const segSub = seg ? [seg.company_size && `${seg.company_size} people`, seg.industry].filter(Boolean).join(" · ") : null;
  const enrolled = (e.enrolled?.A ?? 0) + (e.enrolled?.B ?? 0);
  const per = e.stop_rule_sends_per_arm;
  const minSent = Math.min(arm(e, "A").sent, arm(e, "B").sent);
  const rule = stopRuleText(e);
  const day = dayNumber(e);
  return (
    <div className="flex shrink-0 border-b border-b-[#200D0D1A] px-5 py-3.5">
      <Fact className="grow pr-4" title="Segment" value={e.segment || "Any lead"} sub={segSub || (e.segment ? null : "no segment set")} />
      <Fact
        className="grow border-l border-l-[#200D0D14] px-4"
        title="Enrolled"
        value={<span className="tabular-nums">{enrolled === 1 ? "1 lead" : `${enrolled} leads`}</span>}
        sub={
          <span className="tabular-nums">
            A {e.enrolled?.A ?? 0} · B {e.enrolled?.B ?? 0}
          </span>
        }
      />
      <Fact
        className="grow border-l border-l-[#200D0D14] px-4"
        title="Metric"
        value={e.metric === "positive_reply_rate" || !e.metric ? "Positive replies" : e.metric.replace(/_/g, " ")}
        sub="as sorted in Replies"
      />
      <Fact
        className="grow-[1.3] border-l border-l-[#200D0D14] pl-4"
        title="Stop rule"
        value={rule ?? "None set"}
        sub={
          rule ? (
            <>
              {per ? (
                <>
                  <span className="tabular-nums text-ink">
                    {minSent}/{per}
                  </span>{" "}
                  per arm ·{" "}
                </>
              ) : null}
              {`day ${day}`}
            </>
          ) : (
            "runs until you stop it"
          )
        }
      />
    </div>
  );
}

// ---------- variant table ----------

const cell = "py-0 pl-3 text-right text-[13px]/4 tabular-nums text-ink";

function VariantTable({ e }: { e: Experiment }) {
  const th = "h-8 py-0 text-xs/4 font-medium text-faint";
  return (
    <div className="shrink-0 overflow-clip rounded-[10px] border border-[#200D0D1A]">
      <table className="w-full table-fixed border-collapse">
        <colgroup>
          <col />
          <col className="w-17" />
          <col className="w-28" />
          <col className="w-28" />
          <col className="w-29" />
        </colgroup>
        <thead>
          <tr className="border-b border-b-[#200D0D14] bg-[#200D0D06]">
            <th scope="col" className={cx(th, "pl-4 text-left")}>
              Variant
            </th>
            <th scope="col" className={cx(th, "pl-3 text-right")}>
              Sent
            </th>
            <th scope="col" className={cx(th, "pl-3 text-right")}>
              Replies
            </th>
            <th scope="col" className={cx(th, "pl-3 text-right")}>
              Positive
            </th>
            <th scope="col" className={cx(th, "pl-3 pr-4 text-right")}>
              Cost / reply
            </th>
          </tr>
        </thead>
        <tbody>
          {ARMS.map((k, i) => {
            const s = arm(e, k);
            const desc = armDescription(e, k);
            return (
              <tr key={k} className={cx(i === 0 && "border-b border-b-[#200D0D14]")}>
                <th scope="row" className="h-13.5 py-0 pl-4 text-left font-normal">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span
                      className="flex size-5.5 shrink-0 items-center justify-center rounded-md text-xs/3.5 font-semibold"
                      style={{ background: ARM_COLOR[k].badgeBg, color: ARM_COLOR[k].text }}
                    >
                      {k}
                    </span>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <div className="truncate text-[13px]/4 font-semibold text-ink">{armName(e, k)}</div>
                      {desc ? <div className="truncate text-xs/4 font-medium text-muted">“{desc.replace(/^[“"]+|[”"]+$/g, "")}”</div> : null}
                    </div>
                  </div>
                </th>
                <td className={cell}>{s.sent}</td>
                <td className={cell}>
                  {s.replies} <span className="text-muted">· {pct(s.replies, s.sent, 1)}</span>
                </td>
                <td className={cell}>
                  {s.positive} <span className="text-muted">· {pct(s.positive, s.sent, 1)}</span>
                </td>
                <td className={cx(cell, "pr-4 font-medium")}>{s.replies && s.cost_usd !== null ? usd(s.cost_usd / s.replies) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- verdict + spend ----------

function Verdict({ e }: { e: Experiment }) {
  const v = verdict(e);
  return (
    <div role="note" className="flex shrink-0 items-start gap-2.5 rounded-[10px] bg-pill px-3.5 py-3">
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden className="mt-px shrink-0">
        <circle cx="12" cy="12" r="9" fill="none" stroke="#200D0D" strokeWidth="2" />
        <path d="M12 11v5M12 8h.01" fill="none" stroke="#200D0D" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <div className="flex flex-col gap-0.5">
        <div className="text-[13px]/4 font-semibold text-ink">{v.title}</div>
        <div className="text-xs/4.25 font-medium text-[#200D0DB3]">{v.body}</div>
      </div>
    </div>
  );
}

function SpendLine({ e }: { e: Experiment }) {
  const t = totals(e);
  const item = "text-xs/4 font-[525] text-faint";
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4.5 gap-y-1 px-0.5">
      <div className={item}>
        Spent <span className="tabular-nums text-ink">{t.cost === null ? "—" : usd(t.cost)}</span>
        {t.cost === null ? " (no spend reported yet)" : null}
      </div>
      <div className={item}>
        Per send <span className="tabular-nums text-ink">{t.cost !== null && t.sent ? usd(t.cost / t.sent) : "—"}</span>
      </div>
      <div className={item}>Every send still needs a human approval</div>
    </div>
  );
}
