// Status pills and labels shared by "Dashboard · Workflows" and "Dashboard · Workflow run".
import type { Run, RunStatus } from "../../api.ts";
import { cx } from "../../lib/format.ts";
import { RingSpinner } from "../ui.tsx";

/** Runs that can still change: poll them, list them under "Running". */
export const isActive = (status: string) => status === "running" || status === "idle";

type PillSpec = { label: string; className: string; spin?: boolean };

const pill = (label: string, className: string, spin?: boolean): PillSpec => ({ label, className, spin });
const LIME = "bg-lime text-ink";
const GRAY = "bg-[#200D0D0F] text-[#200D0DB3]";
const RED = "bg-[#FDECEB] text-[#B42318]";
const OUTLINE = "border border-[#200D0D26] text-[#200D0D99]";

/** Workflow-level status (a purpose aggregated over its runs). */
export function workflowPill(status: RunStatus | string): PillSpec {
  switch (status) {
    case "running":
      return pill("running", LIME, true);
    case "idle":
      return pill("waiting on you", LIME);
    case "paused":
      return pill("paused", GRAY);
    case "error":
      return pill("error", RED);
    default:
      return pill("done", OUTLINE);
  }
}

/** Run-level status, using the stop reason to say what it is waiting on. */
export function runPill(run: Pick<Run, "status" | "stop_reason">): PillSpec {
  if (run.status === "idle") {
    if (run.stop_reason === "awaiting_approval") return pill("needs approval", LIME);
    if (run.stop_reason === "awaiting_answer") return pill("needs answer", LIME);
    return pill("waiting on you", LIME);
  }
  if (run.status === "paused") return run.stop_reason === "budget_paused" ? pill("budget hit", RED) : pill("paused", GRAY);
  return workflowPill(run.status);
}

export function StatusPill({ spec, small, className }: { spec: PillSpec; small?: boolean; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full font-medium",
        small ? "h-5 px-2 text-[11px]/3.5" : "h-5.5 px-2.25 text-xs/4",
        spec.className,
        className,
      )}
    >
      {spec.spin ? <RingSpinner /> : null}
      {spec.label}
    </span>
  );
}

const STOP: Record<string, string> = {
  end_turn: "finished",
  awaiting_approval: "waiting for a tool approval",
  awaiting_answer: "waiting for your answer",
  awaiting_input: "waiting for input",
  awaiting_delegation: "waiting on a delegated task",
  budget_paused: "paused at its budget",
  interrupted: "interrupted",
  max_iterations: "too many steps",
  context_exhausted: "ran out of context",
  error: "an error",
};

export const stopLabel = (reason: string | null | undefined) => (reason ? (STOP[reason] ?? reason.replace(/_/g, " ")) : null);

/** "14:22:06", with the date in front when it is not today. */
export function clockSeconds(v: string | number | Date): string {
  const d = new Date(v);
  const time = d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}
