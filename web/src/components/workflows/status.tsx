// Status helpers for "Dashboard · Workflow run".

/** Runs that can still change: poll them, list them under "Running". */
export const isActive = (status: string) => status === "running" || status === "queued";

const STOP: Record<string, string> = {
  finished: "Finished",
  failed: "Stopped with an error",
  out_of_time: "Out of time",
  out_of_tool_calls: "Out of tool calls",
  out_of_budget: "Out of budget",
  unclaimed: "No agent picked this up in time",
};

export const stopLabel = (reason: string | null | undefined) => (reason ? (STOP[reason] ?? reason.replace(/_/g, " ")) : null);

/** "14:22:06", with the date in front when it is not today. */
export function clockSeconds(v: string | number | Date): string {
  const d = new Date(v);
  const time = d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}
