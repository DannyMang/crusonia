// The run timeline on "Dashboard · Workflow run": one row per step (Naive events merged with Crusonia's audit
// events), a time bar placed by start time and sized by duration, and INPUT / OUTPUT on click. Step data comes
// from the agent: untrusted, rendered as plain text only.
import { Fragment, useState, type ReactNode } from "react";
import type { RunLead, RunStep } from "../../api.ts";
import { cx, duration, leadTitle, usd } from "../../lib/format.ts";
import { jsonText, shortUrl } from "../approvals/model.ts";

// ---------- categories (legend colors from the design) ----------

type CatKey = "external" | "mcp" | "human" | "agent" | "error";
const CATS: Record<CatKey, { label: string; color: string }> = {
  external: { label: "External tool", color: "#0070F3" },
  mcp: { label: "Crusonia MCP", color: "#00CA51" },
  human: { label: "Human", color: "#200D0D" },
  agent: { label: "Agent and system", color: "#200D0D40" },
  error: { label: "Error", color: "#B42318" },
};

/** Crusonia MCP tools that reach outside (Apify) get the external color and say what they call. */
const EXTERNAL: Record<string, string> = { read_website: "Apify website crawler", search_web: "Google search via Apify" };
const MCP = new Set([
  "get_status",
  "save_profile",
  "get_profile",
  "add_leads",
  "list_leads",
  "get_lead",
  "save_evidence",
  "score_lead",
  "create_draft",
  "list_pending_approvals",
]);
const TYPE_CAPTION: Record<string, string> = {
  model: "Model call",
  message: "Agent message",
  status: "Session",
  warning: "Warning",
  error: "Error",
  crusonia: "Crusonia",
  other: "Event",
};
const HUMAN_EVENT = /approval|owner/i;

export function categorize(step: RunStep): { cat: CatKey; name: string; caption: string } {
  const tool = step.tool;
  if (step.type === "tool" && tool) {
    if (EXTERNAL[tool]) return { cat: "external", name: tool, caption: EXTERNAL[tool] };
    if (MCP.has(tool)) return { cat: "mcp", name: tool, caption: "Crusonia MCP" };
    return { cat: "external", name: tool, caption: "Agent tool" };
  }
  if (step.type === "approval") return { cat: "human", name: tool ?? "approval", caption: "Needs your approval" };
  if (step.type === "error" || (step.is_error && step.type !== "tool")) return { cat: "error", name: step.type, caption: TYPE_CAPTION[step.type] ?? "Error" };
  if (step.type === "crusonia" && HUMAN_EVENT.test(step.summary)) return { cat: "human", name: "crusonia", caption: "Human" };
  return { cat: "agent", name: tool ?? step.type, caption: TYPE_CAPTION[step.type] ?? step.type };
}

// ---------- time axis ----------

const NICE_S = [1, 2, 5, 10, 15, 20, 30, 45, 50, 60, 90, 120, 180, 240, 300, 600, 900, 1200, 1800, 3600, 7200, 14_400, 28_800, 86_400];
const niceSpan = (ms: number) => (NICE_S.find((s) => s * 1000 >= ms) ?? Math.ceil(ms / 86_400_000) * 86_400) * 1000;

/** Axis end label: "50s", "1m 30s", "2h". */
function spanLabel(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s / 60}m`;
  return duration(ms);
}

export function axisOf(runStart: string, steps: RunStep[]) {
  const times = steps.filter((s) => s.started_at).map((s) => ({ t: new Date(s.started_at!).getTime(), d: s.duration_ms ?? 0 }));
  const start = Math.min(new Date(runStart).getTime(), ...times.map((x) => x.t));
  const end = Math.max(start + 1000, ...times.map((x) => x.t + x.d));
  return { start, span: niceSpan(end - start) };
}

// ---------- rows ----------

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const field = (v: unknown, k: string) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined);

/** The step summary without the leading "tool: " (the tool column already says it), with a few derived extras. */
function WhatHappened({ step, lead, name }: { step: RunStep; lead: RunLead | null; name: string }) {
  let text = step.summary.startsWith(`${name}: `) ? step.summary.slice(name.length + 2) : step.summary;
  if (lead && text === lead.id) text = leadTitle(lead);
  const score = step.tool === "score_lead" ? (field(step.output, "score") ?? field(step.input, "score")) : undefined;
  const source = step.tool === "save_evidence" ? str(field(step.input, "source_url")) : undefined;
  return (
    <div className="flex min-w-0 items-center gap-2">
      {typeof score === "number" ? (
        <span className="flex h-5 shrink-0 items-center rounded-full bg-lime px-1.75 text-[11px]/3.5 font-semibold tabular-nums text-ink">{score}</span>
      ) : null}
      <span className={cx("min-w-0 truncate text-[13px]/4 font-medium", step.is_error ? "text-[#B42318]" : "text-ink")} title={step.summary}>
        {text}
        {source ? <span className="pl-1.5 text-[11px] text-muted">{shortUrl(source)}</span> : null}
      </span>
    </div>
  );
}

function Panel({ title, value }: { title: string; value: unknown }) {
  const text = value === undefined || value === null ? "" : typeof value === "string" ? value : jsonText(value);
  return (
    <div className="flex min-w-0 grow basis-0 flex-col overflow-clip rounded-lg border border-[#200D0D14] bg-white">
      <div className="flex h-6.5 shrink-0 items-center border-b border-b-[#200D0D14] bg-[#200D0D08] px-3">
        <h4 className="text-[11px]/3.5 font-semibold tracking-[0.08em] text-faint">{title}</h4>
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-sans text-xs/4.5 font-medium tabular-nums text-ink">
        {text || <span className="text-faint">Nothing recorded</span>}
      </pre>
    </div>
  );
}

export function Timeline({
  steps,
  runStart,
  lead,
  live,
  now,
  notice,
  footer,
}: {
  steps: RunStep[];
  runStart: string;
  lead: RunLead | null;
  /** The run can still change: the last open-ended step counts up. */
  live: boolean;
  now: number;
  notice?: ReactNode;
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const axis = axisOf(runStart, steps);
  const cats = steps.map(categorize);
  const present = (Object.keys(CATS) as CatKey[]).filter((k) => cats.some((c) => c.cat === k));
  const last = steps.at(-1);

  return (
    <div className="flex min-w-0 grow flex-col overflow-clip rounded-xl border border-[#200D0D1A]">
      <div className="flex h-11 shrink-0 items-center justify-between gap-4 px-4">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h2 className="text-sm/4 font-semibold text-ink">Timeline</h2>
          <span className="truncate text-xs/4 font-medium text-muted">
            {steps.length ? `${steps.length} ${steps.length === 1 ? "step" : "steps"} · click a step to see its input and output` : "no steps yet"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-3.5">
          {present.map((k) => (
            <span key={k} className="flex items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-xs" style={{ background: CATS[k].color }} />
              <span className="text-xs/4 font-medium text-muted">{CATS[k].label}</span>
            </span>
          ))}
        </div>
      </div>
      {notice}
      <table className="w-full table-fixed border-collapse text-left text-xs/4">
        {/* Tool and the time bar are narrower below 1440px so "What happened" keeps room. */}
        <colgroup>
          <col className="w-13" />
          <col className="w-36 min-[1440px]:w-45" />
          <col />
          <col className="w-24 min-[1440px]:w-33" />
          <col className="w-17" />
          <col className="w-16" />
          <col className="w-8" />
        </colgroup>
        <thead>
          <tr className="h-8 border-y border-y-[#200D0D14] bg-[#200D0D06] text-xs/4 text-faint">
            <th scope="col" className="pl-4 pr-3 font-medium">
              #
            </th>
            <th scope="col" className="pr-3 font-medium">
              Tool
            </th>
            <th scope="col" className="pr-3 font-medium">
              What happened
            </th>
            <th scope="col" className="pr-3 font-normal">
              <div className="flex justify-between text-[11px]/4 tabular-nums">
                <span>0s</span>
                <span>{spanLabel(axis.span)}</span>
              </div>
            </th>
            <th scope="col" className="pr-3 text-right font-medium">
              Time
            </th>
            <th scope="col" className="pr-3 text-right font-medium">
              Cost
            </th>
            <th scope="col" className="pr-4">
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {steps.map((step, i) => {
            const c = cats[i]!;
            const expanded = open === step.seq;
            const t = step.started_at ? new Date(step.started_at).getTime() : null;
            const left = t === null ? null : Math.max(0, Math.min(1, (t - axis.start) / axis.span));
            const width = step.duration_ms ? step.duration_ms / axis.span : 0;
            const pending = live && step === last && step.duration_ms === undefined && t !== null;
            const id = `step-${step.seq}`;
            return (
              <Fragment key={step.seq}>
                <tr
                  onClick={() => setOpen(expanded ? null : step.seq)}
                  className={cx("h-11.5 cursor-pointer", expanded ? "bg-[#BDE6891A]" : "border-b border-b-[#200D0D14] hover:bg-[#200D0D04]")}
                >
                  <td className="pl-4 pr-3 align-middle text-[11px]/3.5 font-medium tabular-nums text-faint">{step.seq}</td>
                  <td className="pr-3">
                    <div className="truncate text-xs/4 font-semibold text-ink">{c.name}</div>
                    <div className="truncate text-[11px]/3.5 font-medium text-faint">{c.caption}</div>
                  </td>
                  <td className="pr-3">
                    <WhatHappened step={step} lead={lead} name={c.name} />
                  </td>
                  <td className="pr-3">
                    <div className="relative h-1.5 rounded-xs bg-[#200D0D0A]">
                      {left === null ? null : width > 0 ? (
                        <div
                          className="absolute top-0 h-1.5 rounded-xs"
                          style={{
                            left: `min(${left * 100}%, calc(100% - 3px))`,
                            width: `max(3px, ${Math.min(width, 1 - left) * 100}%)`,
                            background: CATS[c.cat].color,
                          }}
                        />
                      ) : (
                        <div
                          className={cx("absolute top-0 size-1.5 rounded-xs", pending && "[animation:crusonia-pulse_1.6s_ease-in-out_infinite]")}
                          style={{ left: `min(${left * 100}%, calc(100% - 6px))`, background: CATS[c.cat].color }}
                        />
                      )}
                    </div>
                  </td>
                  <td className={cx("pr-3 text-right text-xs/4 tabular-nums", pending ? "text-green" : "text-muted")}>
                    {step.duration_ms !== undefined ? duration(step.duration_ms) : pending ? duration(now - t!) : "—"}
                  </td>
                  <td className={cx("pr-3 text-right text-xs/4 font-medium tabular-nums", step.cost_usd ? "text-ink" : "text-faint")}>
                    {step.cost_usd !== undefined ? usd(step.cost_usd) : "—"}
                  </td>
                  <td className="pr-4 text-center">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={id}
                      aria-label={expanded ? `Hide step ${step.seq}` : `Show input and output of step ${step.seq}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpen(expanded ? null : step.seq);
                      }}
                      className="inline-flex size-5 items-center justify-center rounded"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden className={cx("transition-transform", expanded && "rotate-90")}>
                        <path d="M9 6l6 6-6 6" fill="none" stroke={expanded ? "#200D0D" : "rgb(32 13 13 / 35%)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </td>
                </tr>
                {expanded ? (
                  <tr id={id} className="border-b border-b-[#200D0D14] bg-[#BDE6891A]">
                    <td colSpan={7} className="pb-3.5 pl-13 pr-4">
                      <div className="flex gap-2.5">
                        <Panel title="INPUT" value={step.input} />
                        <Panel title="OUTPUT" value={step.output} />
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
          {!steps.length ? (
            <tr>
              <td colSpan={7} className="px-4 py-10 text-center">
                <div className="text-[13px]/4 font-semibold text-ink">No steps recorded yet</div>
                <div className="mt-1 text-xs/4 font-medium text-muted">Steps appear here as the agent works: every tool call, message and model request.</div>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <div className="grow" />
      {footer ? (
        <div className="flex min-h-11 shrink-0 items-center gap-2.5 border-t border-t-[#200D0D14] bg-[#200D0D04] px-4 py-2.5">
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden className="shrink-0">
            <circle cx="12" cy="12" r="9" fill="none" stroke="rgb(32 13 13 / 55%)" strokeWidth="2" />
            <path d="M12 7v5l3 2" fill="none" stroke="rgb(32 13 13 / 55%)" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <div className="text-xs/4 font-medium text-muted">{footer}</div>
        </div>
      ) : null}
    </div>
  );
}
