// Status helpers for "Dashboard · Workflow run".

/** Runs that can still change: poll them, list them under "Running". */
export const isActive = (status: string) => status === "running" || status === "idle";

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
