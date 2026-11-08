// "Replies, cumulative" chart (Paper: Dashboard · Experiments > Chart card). Hand-written SVG on the design's
// 700×172 grid: one 2px line per arm (accumulated from the per-day series), the today marker, and the days left
// until the stop rule shaded. Hovering a day shows its totals; the variant table above is the table view.
import { useState } from "react";
import type { DailyPoint, Experiment } from "../../api.ts";
import { shortDate } from "../../lib/format.ts";
import { Skeleton } from "../ui.tsx";
import { arm, ARMS, armName, cumulative, isLive, type Arm } from "./derive.ts";

export const ARM_COLOR: Record<Arm, { line: string; text: string; badgeBg: string }> = {
  A: { line: "#0070F3", text: "#0059C2", badgeBg: "#0070F31A" },
  B: { line: "#00CA51", text: "#15803D", badgeBg: "#00CA5124" },
};

// Plot geometry from the design: x 40..690, y 10..150.
const W = 700;
const H = 172;
const X0 = 40;
const X1 = 690;
const Y0 = 10;
const Y1 = 150;
const YM = (Y0 + Y1) / 2;

/** 2, 4, 10, 20, 40, 100… so the midline tick is a whole number. */
function niceMax(v: number) {
  if (v <= 2) return 2;
  const half = v / 2;
  const mag = 10 ** Math.floor(Math.log10(half));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= half) ?? 10 * mag;
  return step * 2;
}

/** Dates are UTC days ("2026-11-07"); read them at noon UTC so the local short date matches. */
const dateOf = (d: string) => new Date(d.length === 10 ? `${d}T12:00:00Z` : d);

export function RepliesChart({ e, daily }: { e: Experiment; daily: DailyPoint[] | undefined }) {
  const [hover, setHover] = useState<number | null>(null);
  const points = cumulative(daily ?? []);
  const live = isLive(e);
  const today = Math.max(points.length, 1);
  const stopDay = e.stop_rule_days;
  const stop = live && stopDay ? Math.max(stopDay, today) : today;
  const span = Math.max(stop, 2);
  const remaining = live && stop > today;
  // With nothing left to shade, the lines end 44px early so the direct labels sit to their right.
  const XE = remaining ? X1 : X1 - 44;
  const x = (day: number) => X0 + ((day - 1) * (XE - X0)) / (span - 1);
  const max = Math.max(0, ...points.flatMap((p) => [p.A, p.B]));
  const yMax = niceMax(max);
  const y = (v: number) => Y1 - (v / yMax) * (Y1 - Y0);
  const tx = x(today);
  const last = points.at(-1);

  // Direct labels next to today's points, nudged apart when the lines finish close together.
  const ends = ARMS.map((k) => ({ k, v: last?.[k] ?? 0, y: y(last?.[k] ?? 0) }));
  if (Math.abs(ends[0]!.y - ends[1]!.y) < 12) {
    const [hi, lo] = ends[0]!.y <= ends[1]!.y ? [ends[0]!, ends[1]!] : [ends[1]!, ends[0]!];
    const mid = Math.min(Math.max((hi.y + lo.y) / 2, Y0 + 6), Y1 - 6);
    hi.y = mid - 6;
    lo.y = mid + 6;
  }

  const per = e.stop_rule_sends_per_arm;
  const toGo = per ? Math.max(0, per - Math.min(arm(e, "A").sent, arm(e, "B").sent)) : null;
  const toGoNote = live && toGo ? `${toGo} more sends per arm to go` : remaining ? `${stop - today} more days to go` : null;
  const range = points.length ? `${shortDate(dateOf(points[0]!.date))} – ${shortDate(dateOf(last!.date))}` : null;
  const showDay1 = today > 1 && tx - X0 > 90;
  const showStop = remaining && X1 - tx > 120;
  const h = hover !== null ? points[hover] : undefined;

  return (
    <div className="flex shrink-0 flex-col gap-3 rounded-[10px] border border-[#200D0D1A] bg-white px-4 pb-3 pt-3.5 shadow-[0_1px_3px_#0000000F]">
      {/* Title, legend, date range in one row from 1280px; below that the legend gets its own row. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 xl:flex-nowrap">
        <h3 className="shrink-0 text-sm/4 font-semibold text-ink">Replies, cumulative</h3>
        <div className="order-last flex min-w-0 basis-full items-center gap-4 xl:order-none xl:basis-auto">
          {ARMS.map((k) => (
            <div key={k} className="flex min-w-0 items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-full" style={{ background: ARM_COLOR[k].line }} />
              <span className="max-w-40 truncate text-xs/4 font-medium text-muted">
                {k} · {armName(e, k)}:
              </span>
              <span className="text-xs/4 font-semibold tabular-nums text-ink">{arm(e, k).replies}</span>
            </div>
          ))}
        </div>
        <div className="ml-auto shrink-0 text-xs/4 font-medium tabular-nums text-muted">
          {range}
        </div>
      </div>

      {daily === undefined ? (
        <Skeleton className="h-43 w-full" />
      ) : points.length === 0 ? (
        <div className="flex h-43 shrink-0 items-center justify-center border-b border-b-[#200D0D26]">
          <p className="max-w-80 text-center text-xs/4 font-medium text-muted">
            {live ? "Each arm's replies draw here day by day once approved emails go out." : "No daily history is available for this experiment."}
          </p>
        </div>
      ) : (
        <div className="relative w-full">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            width="100%"
            role="img"
            aria-label={`Cumulative replies by day: A ${last?.A ?? 0}, B ${last?.B ?? 0} on day ${today}${remaining ? ` of ${stop}` : ""}.`}
            className="block overflow-visible"
            onMouseLeave={() => setHover(null)}
          >
            {remaining ? <rect x={tx} y={Y0} width={X1 - tx} height={Y1 - Y0} fill="#F5F9F0" /> : null}
            <path d={`M${X0} ${Y0}H${X1}M${X0} ${YM}H${X1}`} fill="none" stroke="#200D0D14" strokeDasharray="3 3" />
            <path d={`M${X0} ${Y1}H${X1}`} fill="none" stroke="#200D0D26" />
            {remaining ? <path d={`M${X1} ${Y0}V${Y1}`} fill="none" stroke="#200D0D" strokeDasharray="4 3" /> : null}
            {live ? <path d={`M${tx} ${Y0}V${Y1}`} fill="none" stroke="#200D0D33" strokeDasharray="2 3" /> : null}
            {hover !== null ? <path d={`M${x(hover + 1)} ${Y0}V${Y1}`} fill="none" stroke="#200D0D59" /> : null}

            {ARMS.map((k) => (
              <path
                key={k}
                d={points.map((p, i) => `${i ? "L" : "M"}${x(i + 1)} ${y(p[k])}`).join("")}
                fill="none"
                stroke={ARM_COLOR[k].line}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
            {ARMS.map((k) => (
              <circle key={k} cx={tx} cy={y(last?.[k] ?? 0)} r="3.5" fill="#FFFFFF" stroke={ARM_COLOR[k].line} strokeWidth="2" />
            ))}
            {h
              ? ARMS.map((k) => <circle key={k} cx={x(hover! + 1)} cy={y(h[k])} r="3" fill={ARM_COLOR[k].line} stroke="#FFFFFF" strokeWidth="1.5" />)
              : null}

            {/* y axis */}
            {[yMax, yMax / 2, 0].map((v, i) => (
              <text key={i} x="30" y={[Y0, YM, Y1][i]! + 4} textAnchor="end" className="fill-muted text-[11px] font-medium tabular-nums">
                {v}
              </text>
            ))}
            {/* x axis */}
            {showDay1 ? (
              <text x={X0} y={H - 5} className="fill-muted text-[11px] font-medium">
                Day 1
              </text>
            ) : null}
            <text
              x={remaining ? Math.max(X0, tx - 20) : tx + 4}
              y={H - 5}
              textAnchor={remaining ? "start" : "end"}
              className="fill-ink text-[11px] font-semibold"
            >
              {live ? `Day ${today} · today` : `Day ${today} · stopped`}
            </text>
            {showStop ? (
              <text x={X1} y={H - 5} textAnchor="end" className="fill-ink text-[11px] font-semibold">
                Day {stop} · stop
              </text>
            ) : null}
            {/* direct labels at today's points; the arm letter carries identity next to the colored line */}
            {(last?.A ?? 0) + (last?.B ?? 0) === 0
              ? null
              : ends.map((p) => (
              <text
                key={p.k}
                x={tx + 12}
                y={p.y + 4}
                className="text-[11px] font-semibold tabular-nums"
                fill={ARM_COLOR[p.k].text}
              >
                {p.k} {p.v}
              </text>
            ))}
            {remaining && toGoNote && X1 - tx > 200 ? (
              <text x={(tx + X1) / 2} y={YM + 4} textAnchor="middle" className="fill-muted text-xs font-medium">
                {toGoNote}
              </text>
            ) : null}

            {/* hover targets: one column per day */}
            {points.map((_, i) => {
              const half = (XE - X0) / (span - 1) / 2;
              return <rect key={i} x={x(i + 1) - half} y={Y0} width={half * 2} height={Y1 - Y0} fill="transparent" onMouseEnter={() => setHover(i)} />;
            })}
          </svg>
          {h && hover !== null ? (
            <div
              role="tooltip"
              className="pointer-events-none absolute top-0 z-10 flex -translate-x-1/2 flex-col gap-0.5 whitespace-nowrap rounded-lg border border-[#200D0D1A] bg-white px-2.5 py-1.5 text-xs/4 shadow-[0_2px_8px_#200D0D1A]"
              style={{ left: `${(x(hover + 1) / W) * 100}%` }}
            >
              <span className="font-semibold text-ink">
                Day {hover + 1} · {shortDate(dateOf(h.date))}
              </span>
              {ARMS.map((k) => (
                <span key={k} className="flex items-center gap-1.5 font-medium text-muted">
                  <span className="size-2 rounded-full" style={{ background: ARM_COLOR[k].line }} />
                  {k}: <span className="tabular-nums text-ink">{h[k]}</span> replies so far
                </span>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
