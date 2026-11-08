// Owner policy for Naive tool confirmations: which tools run without asking. Pure.
// The allowlist comes from AUTO_CONFIRM_TOOLS (comma list). An entry is an exact tool name, or a prefix
// followed by `*` (`crusonia.*` matches `crusonia.get_lead`, not `crusonia_x.y`). Anything else becomes
// a 'tool' approval for the owner. There is deliberately no send tool to allow.
//
// Apify is not blanket-allowed: only the single-page reader (charged per request, starts no run in the account) and
// the read-only get-* tools. Anything that starts an Actor run (call-actor, apify--website-content-crawler, ...) or
// changes the account reaches the owner as an approval. Our own search_web / read_website wrap those Actors with page
// limits and a maxTotalChargeUsd cap, and are metered into credits.

export const DEFAULT_AUTO_CONFIRM_TOOLS = "crusonia.*,apify.apify--rag-web-browser,apify.get-*,web_search,web_fetch";

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
