// The Naive research agent's definition: the request body for POST/PATCH /v1/agents (Naive REST API,
// https://usenaive.ai/docs/api/agents). Pure, so tests can check it; scripts/setup.ts sends it.

// Apify's hosted MCP server, limited to the one tool the playbook uses: the single-page reader (charged per request,
// starts no Actor run in the account). Apify adds the read-only run/dataset getters (and abort-actor-run) with it.
// No `actors` toolset (call-actor, search-actors) and no crawler/search Actor tools: those start paid runs, and our
// own read_website / search_web wrap them with page limits, a maxTotalChargeUsd cap and credit metering. Fewer
// tool schemas also make the agent's cached prompt smaller.
// The agent's mcp_servers[].url must equal this string exactly for Naive to inject the vault token: changing it
// needs a vault credential for the new URL, which `bun run setup --agent` adds (ensureApifyCredential in setup.ts).
export const APIFY_MCP_URL = "https://mcp.apify.com?tools=apify/rag-web-browser";

export const AGENT_NAME = "Crusonia Research";
export const PLAYBOOK_PATH = "playbooks/research.md";

/** Every tool our MCP server registers (src/mcp/server.ts). A test checks this against tools/list. */
export const CRUSONIA_TOOLS = [
  "get_status",
  "read_website",
  "search_web",
  "save_profile",
  "get_profile",
  "add_leads",
  "list_leads",
  "get_lead",
  "save_evidence",
  "score_lead",
  "save_research",
  "create_draft",
  "list_pending_approvals",
  "list_tasks",
  "add_note",
] as const;

// Apify tools that run without asking: the single-page reader the playbook uses (charged per request, starts
// no run) and the free readers for run results. Anything else (abort-actor-run, or an Actor tool if the URL above
// ever lists one) stays `ask`: the crusonia search_web and read_website tools wrap the Actors with page and time
// limits and a cost cap.
export const APIFY_ALLOWED_TOOLS = [
  "apify--rag-web-browser",
  "get-actor-run",
  "get-dataset-items",
  "get-key-value-store-record",
] as const;

export type BudgetPeriod = "day" | "week" | "month";
export type Budget = { cap_micro_usd: number; max_task_micro_usd: number; period: BudgetPeriod };
type Permission = "allow" | "ask" | "deny";
type ToolConfig = { enabled: boolean; permission: Permission };

export type Playbook = { name: string; version: string; body: string };

export type AgentConfig = {
  name: string;
  description: string;
  model: string;
  harness?: string;
  window: "immediate";
  system: string;
  tools: { default_config: { permission: Permission }; configs: Record<string, ToolConfig> };
  mcp_servers: { type: "url"; name: string; url: string }[];
  handoffs: false;
  budget: Budget;
  metadata: Record<string, string>;
};

/**
 * A playbook file is front matter (`playbook:` and `version:` lines between `---` fences) and a Markdown
 * body, which becomes the agent's system prompt. Bump `version` with every change.
 */
export function parsePlaybook(text: string): Playbook {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error("Playbook must start with front matter (--- playbook: ... version: ... ---).");
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^\s*([a-z_]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (kv) meta[kv[1]!] = kv[2]!;
  }
  const body = match[2]!.trim();
  if (!meta.playbook || !meta.version) throw new Error("Playbook front matter needs `playbook` and `version`.");
  if (!body) throw new Error("Playbook body is empty.");
  return { name: meta.playbook, version: meta.version, body };
}

/**
 * The pinned default model. `vetta/auto` routed one session across three models (gpt-6.1-sol, gpt-6.1-terra,
 * gpt-6-luna), and every switch re-wrote the prompt cache for the ~38k-token prompt. gpt-6.1-terra is the model the
 * router picked for most of the first end-to-end run's tool work: good research quality at about half sol's cost per
 * cached-prompt write. NAIVE_AGENT_MODEL overrides it (any id from GET /v1/models).
 */
export const DEFAULT_AGENT_MODEL = "openai/gpt-6.1-terra";

const DEFAULTS = { model: DEFAULT_AGENT_MODEL, cap: 5_000_000, maxTask: 1_000_000, period: "day" as BudgetPeriod };

/**
 * Model, harness and budget, overridable from the environment (setup only, not Worker vars):
 * NAIVE_AGENT_MODEL (DEFAULT_AGENT_MODEL), NAIVE_AGENT_HARNESS (Naive's default; fixed once the agent exists),
 * NAIVE_AGENT_BUDGET_CAP_MICRO_USD (5000000 = $5 per period), NAIVE_AGENT_MAX_TASK_MICRO_USD (1000000 = $1 per
 * session), NAIVE_AGENT_BUDGET_PERIOD (day | week | month).
 */
export function agentSettings(get: (key: string) => string | undefined): { model: string; harness?: string; budget: Budget } {
  const microUsd = (key: string, fallback: number) => {
    const raw = get(key)?.trim();
    if (!raw) return fallback;
    const n = Number(raw.replaceAll("_", ""));
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${key} must be a whole number of micro-USD (1000000 = $1).`);
    return n;
  };
  const period = get("NAIVE_AGENT_BUDGET_PERIOD")?.trim() || DEFAULTS.period;
  if (period !== "day" && period !== "week" && period !== "month") throw new Error("NAIVE_AGENT_BUDGET_PERIOD must be day, week or month.");
  const budget: Budget = {
    cap_micro_usd: microUsd("NAIVE_AGENT_BUDGET_CAP_MICRO_USD", DEFAULTS.cap),
    max_task_micro_usd: microUsd("NAIVE_AGENT_MAX_TASK_MICRO_USD", DEFAULTS.maxTask),
    period,
  };
  if (budget.max_task_micro_usd > budget.cap_micro_usd) {
    throw new Error("NAIVE_AGENT_MAX_TASK_MICRO_USD may not exceed NAIVE_AGENT_BUDGET_CAP_MICRO_USD (Naive refuses it).");
  }
  const harness = get("NAIVE_AGENT_HARNESS")?.trim();
  return { model: get("NAIVE_AGENT_MODEL")?.trim() || DEFAULTS.model, ...(harness ? { harness } : {}), budget };
}

/**
 * The agent: our MCP server and Apify's, the playbook as system prompt, and a toolset that allows the
 * crusonia tools and the research Apify tools, keeps ask_operator as ask (Naive never allows it), and asks
 * for everything else. `handoffs: false`: a research session never starts other agents' sessions.
 */
export function naiveAgentConfig(input: {
  baseUrl: string;
  playbook: Playbook;
  model: string;
  harness?: string;
  budget: Budget;
}): AgentConfig {
  const allow: ToolConfig = { enabled: true, permission: "allow" };
  const configs: Record<string, ToolConfig> = {};
  for (const tool of CRUSONIA_TOOLS) configs[`crusonia.${tool}`] = allow;
  for (const tool of APIFY_ALLOWED_TOOLS) configs[`apify.${tool}`] = allow;
  configs.ask_operator = { enabled: true, permission: "ask" };
  return {
    name: AGENT_NAME,
    description:
      "Researches one Crusonia lead per session: sourced evidence, an ICP fit score and, for opted-in leads only, an email draft that a human approves.",
    model: input.model,
    ...(input.harness ? { harness: input.harness } : {}),
    // vetta/auto serves the immediate window only, and every catalogue model supports it.
    window: "immediate",
    system: input.playbook.body,
    tools: { default_config: { permission: "ask" }, configs },
    mcp_servers: [
      // Each url must equal the vault credential's mcp_server_url exactly (see setupNaive).
      { type: "url", name: "crusonia", url: `${input.baseUrl}/mcp` },
      { type: "url", name: "apify", url: APIFY_MCP_URL },
    ],
    handoffs: false,
    budget: input.budget,
    metadata: { app: "crusonia", playbook: input.playbook.name, playbook_version: input.playbook.version },
  };
}

// Key order never matters; Naive returns mcp_servers without `type` (url is the only kind).
function canonical(key: string, value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)]))
        : v;
  const normalized = key === "mcp_servers" && Array.isArray(value) ? value.map(({ type: _type, ...server }) => server) : value;
  return JSON.stringify(sort(normalized ?? null));
}

/**
 * The fields of `desired` that differ from the agent Naive returned (GET /v1/agents/{id}), for a PATCH
 * that mints a new agent version only when the config really changed. `harness` is left out: it is
 * fixed at creation.
 */
export function changedFields(desired: AgentConfig, current: Record<string, unknown>): Partial<AgentConfig> {
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(desired)) {
    if (key !== "harness" && canonical(key, value) !== canonical(key, current[key])) changed[key] = value;
  }
  return changed as Partial<AgentConfig>;
}
