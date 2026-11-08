import { OPERATOR_TOOLS } from "../mcp/toolsets.ts";

// Owner policy for Naive tool confirmations: which tools run without asking. Pure.
// The allowlist comes from AUTO_CONFIRM_TOOLS (comma list). An entry is an exact tool name, or a prefix
// followed by `*` (`crusonia.*` matches `crusonia.get_lead`, not `crusonia_x.y`). Anything else becomes
// a 'tool' approval for the owner. There is deliberately no send tool to allow.
//
// Apify is not blanket-allowed: only the single-page reader (charged per request, starts no run in the account) and
// the read-only get-* tools. Anything that starts an Actor run (call-actor, apify--website-content-crawler, ...) or
// changes the account reaches the owner as an approval. Our own search_web / read_website wrap those Actors with page
// limits and a maxTotalChargeUsd cap, and are metered into credits.

/**
 * The Operator's auto-confirm list: its crusonia tools and nothing else. It has no web tool to reach out with, so it may
 * read the pipeline (the list_* tools). AUTO_CONFIRM_TOOLS never widens this list.
 */
export const OPERATOR_AUTO_CONFIRM: readonly string[] = OPERATOR_TOOLS.map((t) => `crusonia.${t}`);

// Crusonia tools are listed one by one instead of `crusonia.*`: the list_* tools (all leads, tasks and approvals) and
// web_fetch are left out, so text on a scraped page can't make the agent read the whole pipeline and fetch it out to a
// URL without the owner seeing an approval first.
export const DEFAULT_AUTO_CONFIRM_TOOLS = [
  "crusonia.get_status",
  "crusonia.get_company_summary",
  "crusonia.update_company_summary",
  "crusonia.get_profile",
  "crusonia.save_profile",
  "crusonia.get_workflow",
  "crusonia.get_lead",
  "crusonia.read_website",
  "crusonia.search_web",
  "crusonia.add_leads",
  "crusonia.save_research",
  "crusonia.save_evidence",
  "crusonia.score_lead",
  "crusonia.flag_for_review",
  "crusonia.add_note",
  "crusonia.create_draft",
  "apify.apify--rag-web-browser",
  "apify.get-*",
  "web_search",
].join(",");

/** Unset or empty means the default list; `none` means ask the owner for every tool. */
export function parseToolAllowlist(raw: string | undefined): string[] {
  const source = raw === undefined || raw.trim() === "" ? DEFAULT_AUTO_CONFIRM_TOOLS : raw;
  if (source.trim().toLowerCase() === "none") return [];
  return source
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isToolAllowed(name: string, patterns: readonly string[]): boolean {
  if (!name) return false;
  for (const pattern of patterns) {
    if (pattern.endsWith("*")) {
      if (name.startsWith(pattern.slice(0, -1))) return true;
    } else if (name === pattern) {
      return true;
    }
  }
  return false;
}
