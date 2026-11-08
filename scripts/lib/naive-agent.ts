// The Naive agents' definitions: the request bodies for POST/PATCH /v1/agents (Naive REST API,
// https://usenaive.ai/docs/api/agents). Pure, so tests can check them; scripts/setup.ts sends them.
//   Research agent  reads the web, sees only its target lead (one session per lead or per lead-finding run).
//   Operator        reads the whole pipeline and manages work, with no web tool at all (src/mcp/toolsets.ts).
// Both are Naive agents, started by our Worker over REST, not by a handoff (send_to_agent): a start from the Operator has to
// pass the pause switch, the caps and the credit check, and it carries lead ids, never free text.
import { ALL_TOOLS, OPERATOR_TOOLS, RESEARCHER_TOOLS } from "../../src/mcp/toolsets.ts";

// Apify's hosted MCP server. No agent uses it any more: one page through its reader put 10-85 KB into the conversation,
// which Naive re-writes to the prompt cache on every resume. Agents read pages through our read_website (trimmed per page,
// capped and metered). Kept for setup, which still knows the URL's vault credential.
export const APIFY_MCP_URL = "https://mcp.apify.com?tools=apify/rag-web-browser";

export const AGENT_NAME = "Crusonia Research";
export const PLAYBOOK_PATH = "playbooks/research.md";
export const OPERATOR_AGENT_NAME = "Crusonia Operator";
export const OPERATOR_PLAYBOOK_PATH = "playbooks/operator.md";

/** Every tool our MCP server registers (src/mcp/server.ts). A test checks this against tools/list. */
export const CRUSONIA_TOOLS = ALL_TOOLS;

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

/** Built-in tools with a way out to the network or a shell. Withheld from every agent: the model never sees them. */
export const DENIED_BUILTINS = ["web_fetch", "browser", "bash", "fetch_file", "publish_file", "apps", "post_to_channel", "send_to_agent"] as const;
/** The MCP URLs setup needs vault credentials for. One per agent: Naive matches the credential by exact URL. */
export const researcherMcpUrl = (baseUrl: string) => `${baseUrl}/mcp?role=researcher`;
export const operatorMcpUrl = (baseUrl: string) => `${baseUrl}/mcp?role=operator`;

/**
 * The research agent: our MCP server (its role's tools), the playbook as system prompt, and a toolset that allows those, keeps ask_operator as ask (Naive never allows it), denies the operator's tools and anything that reaches
 * out, and asks for the rest. `handoffs: false`: a research session never starts other agents' sessions.
 */
export function naiveAgentConfig(input: {
  baseUrl: string;
  playbook: Playbook;
  /** Defaults to AGENT_NAME. Another environment (staging) needs its own name: setup finds agents by name. */
  name?: string;
  model: string;
  harness?: string;
  budget: Budget;
}): AgentConfig {
  const allow: ToolConfig = { enabled: true, permission: "allow" };
  const deny: ToolConfig = { enabled: false, permission: "deny" };
  const configs: Record<string, ToolConfig> = {};
  for (const tool of CRUSONIA_TOOLS) configs[`crusonia.${tool}`] = (RESEARCHER_TOOLS as readonly string[]).includes(tool) ? allow : deny;
  for (const tool of DENIED_BUILTINS) configs[tool] = deny;
  configs.ask_operator = { enabled: true, permission: "ask" };
  return {
    name: input.name ?? AGENT_NAME,
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
      { type: "url", name: "crusonia", url: researcherMcpUrl(input.baseUrl) },
    ],
    handoffs: false,
    budget: input.budget,
    metadata: { app: "crusonia", playbook: input.playbook.name, playbook_version: input.playbook.version },
  };
}

/**
 * The Operator: deny by default, only its crusonia tools allowed. No web tool, no outbound fetch, no Apify server, no
 * ask_operator (it acts where policy allows and leaves the rest), so nothing it reads can leave and nothing makes it wait.
 */
export function operatorAgentConfig(input: { baseUrl: string; playbook: Playbook; name?: string; model: string; harness?: string; budget: Budget }): AgentConfig {
  const configs: Record<string, ToolConfig> = {};
  for (const tool of OPERATOR_TOOLS) configs[`crusonia.${tool}`] = { enabled: true, permission: "allow" };
  return {
    name: input.name ?? OPERATOR_AGENT_NAME,
    description: "Runs a Crusonia workspace: reads the pipeline and the owner's ratings, decides what to do next and starts research agents. Never reads the web, never sends anything.",
    model: input.model,
    ...(input.harness ? { harness: input.harness } : {}),
    window: "immediate",
    system: input.playbook.body,
    tools: { default_config: { permission: "deny" }, configs },
    mcp_servers: [{ type: "url", name: "crusonia", url: operatorMcpUrl(input.baseUrl) }],
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
