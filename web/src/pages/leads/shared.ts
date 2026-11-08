// Helpers shared by the Leads list and the Lead detail screens.
import type { Lead, LeadStage } from "../../api.ts";
import { clock, shortDate } from "../../lib/format.ts";

export type GroupKey = "needs" | "working" | "conversation" | "closed";

export type Group = { key: GroupKey; title: string; stages: readonly LeadStage[]; tint: string };

/** The Leads table sections, in display order. Unknown stages fall into "Agent working". */
export const GROUPS: readonly Group[] = [
  { key: "needs", title: "Needs you", stages: ["awaiting_approval"], tint: "bg-panel" },
  { key: "working", title: "Agent working", stages: ["new", "no_consent", "researching", "qualified", "needs_review"], tint: "bg-[#200D0D08]" },
  { key: "conversation", title: "In conversation", stages: ["sent", "replied", "interested", "meeting_booked"], tint: "bg-[#200D0D08]" },
  { key: "closed", title: "Closed", stages: ["not_interested", "unsubscribed", "disqualified"], tint: "bg-[#200D0D08]" },
];

export function groupOf(stage: string): Group {
  return GROUPS.find((g) => (g.stages as readonly string[]).includes(stage)) ?? GROUPS[1]!;
}

const SOURCES: Record<string, string> = {
  apify: "Apify",
  hubspot: "HubSpot",
  agent: "Agent",
  mcp: "Agent",
  naive: "Agent",
  csv: "CSV",
  csv_import: "CSV",
  api: "API",
  manual: "Manual",
  onboarding: "Onboarding",
  google_search: "Google",
  company_website: "Website",
  linkedin: "LinkedIn",
};

/** "apify:linkedin-profile-scraper" -> "Apify", "csv_import" -> "CSV", "trade_show" -> "Trade show". */
export function sourceLabel(source: string | null | undefined): string {
  if (!source) return "—";
  const key = source.toLowerCase();
  if (SOURCES[key]) return SOURCES[key];
  const head = key.split(/[:/]/)[0]!;
  if (SOURCES[head]) return SOURCES[head];
  const words = head.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : source;
}

/** Only http(s) links from agent data become clickable; anything else renders as text. */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/** "fieldnote.io/careers/founding-sdr" from "https://www.fieldnote.io/careers/founding-sdr/". */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
}

/** "6:44 AM" for today, "Nov 6, 4:12 PM" otherwise. */
export function stamp(v: string): string {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toDateString() === new Date().toDateString() ? clock(d) : `${shortDate(d)}, ${clock(d)}`;
}

/** Contact line for a lead: the person, else the email, else nothing. */
export function contactOf(l: Pick<Lead, "name" | "email" | "title">): { primary: string | null; secondary: string | null } {
  if (l.name) return { primary: l.name, secondary: l.title };
  if (l.email) return { primary: l.email, secondary: l.title };
  return { primary: null, secondary: null };
}
