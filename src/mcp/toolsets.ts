// Who may call which MCP tool. Pure, so tests and scripts/lib/naive-agent.ts can import it.
//
// A Naive session reads untrusted text, so what one session can read and where it can send data must not meet:
//   researcher  reads the web (search_web, read_website, Apify's page reader) and sees only its target lead. It has
//               no tool that lists the pipeline, and every lead tool needs the run id of a session on that lead.
//   operator    reads the whole pipeline and starts or manages work, with no web tool and no outbound fetch at all.
//               What it hands to a researcher is structured (lead ids, a count), never free text.
//   full        a person's own agent (Claude Code, Cursor) on a user API key or MCP_TOKEN: every tool.
//
// The role comes from the credential (an 'agent' key is a researcher, an 'operator' key an operator) or, for the owner
// token, which is the same for both Naive agents, from the URL the agent's vault credential is bound to (?role=).
// No role can send email, decide an approval, change consent, touch billing, API keys or suppressions: those tools
// don't exist in any set (test/autopilot-tools.test.ts checks the names and inputs).
export const MCP_ROLES = ["full", "researcher", "operator"] as const;
export type McpRole = (typeof MCP_ROLES)[number];

export const RESEARCHER_TOOLS = [
  "get_status",
  "read_website",
  "search_web",
  "get_company_summary",
  "update_company_summary",
  "get_profile",
  "add_leads",
  "get_lead",
  "save_evidence",
  "score_lead",
  "save_research",
  "create_draft",
  "add_note",
  "get_workflow",
  "flag_for_review",
] as const;

export const OPERATOR_TOOLS = [
  // Read the whole product.
  "get_status",
  "get_pipeline",
  "get_activity",
  "get_autopilot",
  "get_company_summary",
  "list_summary_versions",
  "get_profile",
  "list_leads",
  "get_lead",
  "list_replies",
  "list_tasks",
  "list_pending_approvals",
  "list_followups",
  "list_workflows",
  "get_workflow",
  "list_workflow_runs",
  "get_run",
  "get_integrations",
  "get_billing_balance",
  // Keep what Crusonia knows current.
  "update_company_summary",
  "add_leads",
  "update_lead",
  "merge_leads",
  "import_leads",
  "save_evidence",
  "score_lead",
  "save_research",
  "add_note",
  "flag_for_review",
  // Start and manage work (every start passes the pause switch, the caps and the credit check).
  "create_workflow",
  "update_workflow",
  "run_workflow",
  "find_more_leads",
  "start_research",
  // Prepare outreach (nothing here sends: the owner approves every email and sends every manual message).
  "create_draft",
  "schedule_followup",
  "sync_crm",
  "log_cycle",
] as const;

/** Tools only a person's own agent has: older aliases, kept for connected agents. */
export const FULL_ONLY_TOOLS = ["save_profile"] as const;

export const ALL_TOOLS = [...new Set<string>([...RESEARCHER_TOOLS, ...OPERATOR_TOOLS, ...FULL_ONLY_TOOLS])];

/** The tools a role sees (null: every registered tool). */
export function toolsFor(role: McpRole): ReadonlySet<string> | null {
  if (role === "researcher") return new Set(RESEARCHER_TOOLS);
  if (role === "operator") return new Set(OPERATOR_TOOLS);
  return null;
}

/** Tools that read or fetch the web. None may ever be in the operator's set. */
export const WEB_TOOLS = ["read_website", "search_web"] as const;
/** Tools that read across leads. None may ever be in the researcher's set. */
export const PIPELINE_READ_TOOLS = ["list_leads", "list_tasks", "list_pending_approvals", "list_replies", "get_pipeline", "get_activity", "list_workflow_runs", "get_run"] as const;

/**
 * The role of an MCP call. An agent's key decides it outright, so its credential can never reach a wider set by asking.
 * Others may narrow themselves with ?role= (the owner template agents use that, since MCP_TOKEN is one token).
 */
export function resolveRole(keyRole: "researcher" | "operator" | null | undefined, requested: string | undefined): McpRole {
  if (keyRole) return keyRole;
  return requested === "researcher" || requested === "operator" ? requested : "full";
}
