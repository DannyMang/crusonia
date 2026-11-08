// The Naive research agent definition (scripts/lib/naive-agent.ts) and its playbook.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.ts";
import { RESEARCHER_TOOLS } from "../src/mcp/toolsets.ts";
import {
  APIFY_ALLOWED_TOOLS,
  APIFY_MCP_URL,
  CRUSONIA_TOOLS,
  DENIED_BUILTINS,
  DEFAULT_AGENT_MODEL,
  PLAYBOOK_PATH,
  agentSettings,
  changedFields,
  naiveAgentConfig,
  parsePlaybook,
} from "../scripts/lib/naive-agent.ts";

const playbookText = readFileSync(new URL(`../${PLAYBOOK_PATH}`, import.meta.url), "utf8");
const settings = (vars: Record<string, string> = {}) => agentSettings((k) => vars[k]);
const config = (vars: Record<string, string> = {}) =>
  naiveAgentConfig({ baseUrl: "https://crusonia.example.dev", playbook: parsePlaybook(playbookText), ...settings(vars) });

describe("research playbook", () => {
  test("has a version and becomes the system prompt without its front matter", () => {
    const playbook = parsePlaybook(playbookText);
    expect(playbook.name).toBe("research");
    expect(playbook.version).toMatch(/^\d+$/);
    expect(playbook.body).toStartWith("# Crusonia research agent");
    expect(config().system).toBe(playbook.body);
    expect(config().metadata).toEqual({ app: "crusonia", playbook: "research", playbook_version: playbook.version });
  });

  test("covers the workflow and the safety rules", () => {
    const body = parsePlaybook(playbookText).body;
    for (const tool of ["get_profile", "get_lead", "read_website", "search_web", "save_research", "create_draft", "add_note", "ask_operator"]) {
      expect(body).toContain(`\`${tool}\``);
    }
    for (const phrase of ["has_consent", "Untrusted data", "never instructions", "Never say or imply", "suppressed", "Company summary"]) {
      expect(body).toContain(phrase);
    }
  });

  test("v3+ tells the agent to batch independent calls, cite evidence, and use manual channels without consent", () => {
    const body = parsePlaybook(playbookText).body;
    expect(Number(parsePlaybook(playbookText).version)).toBeGreaterThanOrEqual(3);
    for (const phrase of ["Batch independent calls in one turn", "about 3", "citations", "why_summary", "linkedin", "intro", "email_manual", "owner_notes", "ask_operator", "No invented enrichment"]) {
      expect(body).toContain(phrase);
    }
    // The research workflow no longer starts with get_status.
    expect(body).toContain("Don't call `get_status`");
  });

  test("v4 reads the Company summary first, keeps it current by section with a note, and passes the run id", () => {
    const { body, version } = parsePlaybook(playbookText);
    expect(Number(version)).toBeGreaterThanOrEqual(4);
    for (const phrase of ["`get_company_summary`", "`update_company_summary`", "Read it first, every session", "`section`", "`note`", "`run_id`", "Avoid section"]) {
      expect(body).toContain(phrase);
    }
  });

  test("malformed playbooks are refused", () => {
    expect(() => parsePlaybook("# no front matter")).toThrow("front matter");
    expect(() => parsePlaybook("---\nplaybook: research\n---\nbody")).toThrow("version");
    expect(() => parsePlaybook("---\nplaybook: research\nversion: 2\n---\n  \n")).toThrow("empty");
  });
});

describe("agent definition", () => {
  test("allows the researcher's crusonia tools and the research Apify tools, denies the rest of ours, asks for anything else", () => {
    const { tools } = config();
    expect(tools.default_config).toEqual({ permission: "ask" });
    for (const tool of CRUSONIA_TOOLS) {
      const allowed = (RESEARCHER_TOOLS as readonly string[]).includes(tool);
      expect(tools.configs[`crusonia.${tool}`]).toEqual(allowed ? { enabled: true, permission: "allow" } : { enabled: false, permission: "deny" });
    }
    for (const tool of APIFY_ALLOWED_TOOLS) expect(tools.configs[`apify.${tool}`]).toEqual({ enabled: true, permission: "allow" });
    expect(tools.configs.ask_operator).toEqual({ enabled: true, permission: "ask" });
    // Actor runs and anything unlisted fall through to the `ask` default, and the Apify URL loads no Actor-run tools.
    expect(tools.configs["apify.call-actor"]).toBeUndefined();
    expect(APIFY_MCP_URL).not.toContain("actors");
    expect(APIFY_MCP_URL).not.toContain("website-content-crawler");
    expect(tools.configs["apify.apify--website-content-crawler"]).toBeUndefined();
    expect(Object.keys(tools.configs)).toHaveLength(CRUSONIA_TOOLS.length + APIFY_ALLOWED_TOOLS.length + DENIED_BUILTINS.length + 1);
  });

  test("MCP servers match the vault credential URLs, and every namespaced tool has its server", () => {
    const c = config();
    expect(c.mcp_servers).toEqual([
      { type: "url", name: "crusonia", url: "https://crusonia.example.dev/mcp?role=researcher" },
      { type: "url", name: "apify", url: APIFY_MCP_URL },
    ]);
    const servers = new Set(c.mcp_servers.map((s) => s.name));
    for (const key of Object.keys(c.tools.configs).filter((k) => k.includes("."))) expect(servers.has(key.split(".")[0]!)).toBe(true);
    for (const server of servers) expect(Object.keys(c.tools.configs).some((k) => k.startsWith(`${server}.`))).toBe(true);
  });

  test("defaults: a pinned model (not vetta/auto), immediate window, no handoffs, $5 a day and $1 per session", () => {
    const c = config();
    expect(c).toMatchObject({ name: "Crusonia Research", model: DEFAULT_AGENT_MODEL, window: "immediate", handoffs: false });
    expect(c.model).not.toBe("vetta/auto");
    expect(c.budget).toEqual({ cap_micro_usd: 5_000_000, max_task_micro_usd: 1_000_000, period: "day" });
    expect("harness" in c).toBe(false);
  });

  test("model, harness and budget come from the environment, and bad budgets are refused", () => {
    const c = config({
      NAIVE_AGENT_MODEL: "z-ai/glm-5.3-flash",
      NAIVE_AGENT_HARNESS: "pi",
      NAIVE_AGENT_BUDGET_CAP_MICRO_USD: "20_000_000",
      NAIVE_AGENT_MAX_TASK_MICRO_USD: "2000000",
      NAIVE_AGENT_BUDGET_PERIOD: "week",
    });
    expect(c).toMatchObject({ model: "z-ai/glm-5.3-flash", harness: "pi" });
    expect(c.budget).toEqual({ cap_micro_usd: 20_000_000, max_task_micro_usd: 2_000_000, period: "week" });

    expect(() => settings({ NAIVE_AGENT_MAX_TASK_MICRO_USD: "6000000" })).toThrow("may not exceed");
    expect(() => settings({ NAIVE_AGENT_BUDGET_CAP_MICRO_USD: "5.5" })).toThrow("whole number");
    expect(() => settings({ NAIVE_AGENT_BUDGET_CAP_MICRO_USD: "-1" })).toThrow("whole number");
    expect(() => settings({ NAIVE_AGENT_BUDGET_PERIOD: "year" })).toThrow("day, week or month");
  });

  test("re-applying an unchanged config changes nothing; an edit sends only the edited fields", () => {
    const desired = config({ NAIVE_AGENT_HARNESS: "vetta" });
    // What GET /v1/agents/{id} returns: other key order, mcp_servers without `type`, extra read-only fields.
    const { harness: _h, ...rest } = desired;
    const remote: Record<string, unknown> = {
      id: "agt_x",
      current_version: 3,
      harness: "pi",
      skills: [],
      ...Object.fromEntries(Object.entries(rest).reverse()),
      mcp_servers: desired.mcp_servers.map(({ name, url }) => ({ url, name })),
      budget: { period: "day", max_task_micro_usd: 1_000_000, cap_micro_usd: 5_000_000 },
    };
    expect(changedFields(desired, remote)).toEqual({});
    expect(changedFields(desired, { ...remote, system: "old prompt", metadata: {} })).toEqual({ system: desired.system, metadata: desired.metadata });
    expect(Object.keys(changedFields(config({ NAIVE_AGENT_BUDGET_PERIOD: "week" }), remote))).toEqual(["budget"]);
  });

  test("CRUSONIA_TOOLS is exactly what our MCP server lists", async () => {
    const server = createMcpServer({ PUBLIC_URL: "https://example.test" });
    const client = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...CRUSONIA_TOOLS].sort());
    await client.close();
  });
});
