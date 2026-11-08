// Pieces shared by the workflow list, builder and run history (Paper: "Final · Workflows · …").
import type { ReactNode } from "react";
import { Link, NavLink } from "react-router";
import type { FlowDef, FlowStatus } from "../../api/workflows.ts";
import { RingSpinner } from "../../components/ui.tsx";
import { cx, usd } from "../../lib/format.ts";

export const COMPANY_SUMMARY_PATH = "/app/settings/company";
export const flowPath = (id: string) => `/app/workflows/${encodeURIComponent(id)}`;
export const runsPath = (id: string) => `${flowPath(id)}/runs`;

/** "9:00" (no am/pm, like the designs). */
export function hm(v: string | number | Date): string {
  const d = new Date(v);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "12m ago" within the hour, "Today 8:12", else "Mon Nov 3". */
export function whenLabel(v: string, now = Date.now()): string {
  const d = new Date(v);
  const diff = now - d.getTime();
  if (diff >= 0 && diff < 60 * 60_000) return diff < 60_000 ? "just now" : `${Math.floor(diff / 60_000)}m ago`;
  if (d.toDateString() === new Date(now).toDateString()) return `Today ${hm(d)}`;
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).replace(",", "");
}

/** "Mon Nov 3, 9:00". */
export function runDate(v: string): string {
  const d = new Date(v);
  return `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).replace(",", "")}, ${hm(d)}`;
}

/** "$0.84 of $5 this week" / "$1.00 of $1.00 this run". */
export function spendLabel(spend: FlowDef["spend"]): string {
  const cap = spend.cap_usd;
  const whole = (n: number) => (Number.isInteger(n) && spend.period === "week" ? `$${n}` : usd(n));
  return cap === null ? `${usd(spend.usd)} this ${spend.period}` : `${usd(spend.usd)} of ${whole(cap)} this ${spend.period}`;
}

const TerminalGlyph = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="shrink-0">
    <path d="M4 17l6-6-6-6M12 19h8" fill="none" stroke="#200D0D" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** "Built by Claude Code" for agent-made workflows; nothing for the owner's own. */
export function SourceTag({ source, size = "md" }: { source: FlowDef["source"]; size?: "sm" | "md" }) {
  if (source === "user") return null;
  const label = source === "claude_code" ? "Built by Claude Code" : "Template";
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center rounded-full bg-pill font-semibold text-ink",
        size === "sm" ? "h-4.5 gap-1 px-1.5 text-[11px]/3.5" : "h-5.5 gap-1.25 px-2 text-xs/4",
      )}
    >
      {source === "claude_code" ? <TerminalGlyph size={size === "sm" ? 10 : 11} /> : null}
      {label}
    </span>
  );
}

const STATUS: Record<string, { label: string; className: string; spin?: boolean }> = {
  running: { label: "Running", className: "bg-[#BDE68973] text-ink", spin: true },
  waiting: { label: "Waiting on you", className: "bg-lime text-ink" },
  budget_paused: { label: "Budget paused", className: "bg-[#FDECEC] text-[#B42318]" },
  paused: { label: "Paused", className: "bg-pill text-ink" },
  error: { label: "Error", className: "bg-[#FDECEC] text-[#B42318]" },
  done: { label: "Done", className: "border border-[#200D0D26] text-ink" },
  off: { label: "Off", className: "bg-pill text-ink" },
};

export function FlowStatusPill({ status, extra }: { status: FlowStatus; extra?: string | null }) {
  const s = STATUS[status] ?? { label: status.replace(/_/g, " "), className: "border border-[#200D0D26] text-ink" };
  return (
    <span className={cx("inline-flex h-5.5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.25 text-xs/4 font-medium", s.className)}>
      {s.spin ? <RingSpinner /> : null}
      {extra ? `${s.label} · ${extra}` : s.label}
    </span>
  );
}

/** "Workflows / Name [tag]" with actions on the right and, for saved workflows, the Builder / Runs tabs. */
export function FlowHeader({ title, source, right, tabsFor }: { title: ReactNode; source?: FlowDef["source"]; right?: ReactNode; tabsFor?: string }) {
  return (
    <div className="flex shrink-0 flex-col gap-4">
      <div className="flex min-h-10 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Link to="/app/workflows" className="shrink-0 text-sm/4.5 text-muted hover:text-ink">
            Workflows /
          </Link>
          <div className="min-w-0 truncate text-xl/7 font-semibold tracking-[-0.01em] text-ink">{title}</div>
          {source ? <SourceTag source={source} /> : null}
        </div>
        {right ? <div className="flex items-center gap-2.5">{right}</div> : null}
      </div>
      {tabsFor ? (
        <nav aria-label="Workflow" className="flex items-center gap-6 border-b border-b-[#200D0D14]">
          {[
            { to: flowPath(tabsFor), label: "Builder", end: true },
            { to: runsPath(tabsFor), label: "Runs", end: true },
          ].map((t) => (
            <NavLink
              key={t.label}
              to={t.to}
              end={t.end}
              className={({ isActive }) =>
                cx("-mb-px pb-2.25 text-sm/4.5", isActive ? "border-b-2 border-b-ink font-semibold text-ink" : "border-b-2 border-b-transparent font-medium text-muted hover:text-ink")
              }
            >
              {t.label}
            </NavLink>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
