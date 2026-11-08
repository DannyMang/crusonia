// One Naive agent per workspace, so an agent's tool calls can only reach the workspace that started its session.
//
// Naive injects MCP credentials from the vault by exact URL match against the agent version's mcp_servers, and a
// credential can be bound to one agent. There is no per-session credential (session vault_ids and overrides are
// "coming soon" in Naive's docs), so the scoping unit is the agent:
//   - the owner workspace uses the template agent (NAIVE_AGENT_ID, made by `bun run setup --agent`): its crusonia
//     server is ${PUBLIC_URL}/mcp and the vault credential for that URL holds MCP_TOKEN;
//   - any other workspace gets a copy of the template whose crusonia server is ${PUBLIC_URL}/mcp?ws=<workspace id>,
//     plus a vault credential for exactly that URL, bound to that agent (agent_id), holding a workspace API key of
//     kind 'agent'. The key alone decides the workspace; /mcp also refuses a `ws` that names another workspace.
// The copy keeps the template's playbook, tools, model and Naive budget (so each workspace also has its own Naive
// budget) and is re-synced when the template's version changes. Created on the workspace's first paid run.
import type { Sql } from "../db.ts";
import { logEvent } from "../db.ts";
import type { Env } from "../env.ts";
import { ApiError, notConfigured } from "../lib/errors.ts";
import { ProviderError, type FetchFn } from "../providers/http.ts";
import { NaiveClient, type NaiveAgent } from "../providers/naive.ts";
import { createApiKey, revokeApiKey } from "./api-keys.ts";
import { isOwnerWorkspace } from "./workspaces.ts";

/** The crusonia MCP server name in the agent config (tool names are `crusonia.<tool>`). */
export const CRUSONIA_SERVER = "crusonia";
const SYNC_EVERY_MS = 10 * 60_000;


/** The workflow version a run records: the playbook and the agent version, e.g. "research@3, agent v12". */
export function workflowVersionOf(agent: NaiveAgent): string | null {
  const playbook = agent.metadata?.playbook ?? "playbook";
  const pv = agent.metadata?.playbook_version;
  if (!pv && agent.current_version === undefined) return null;
  return `${playbook}@${pv ?? "?"}${agent.current_version !== undefined ? `, agent v${agent.current_version}` : ""}`;
}

// The template agent's version, cached per isolate (a free read; a failure only leaves the version unknown).
const TEMPLATE_TTL_MS = 60_000;
let templateVersion: { agentId: string; value: string | null; at: number } | undefined;
export const resetTemplateVersionCache = () => (templateVersion = undefined);

export const workspaceMcpUrl = (env: Env, ws: string) => `${env.PUBLIC_URL.replace(/\/+$/, "")}/mcp?ws=${encodeURIComponent(ws)}`;
export const workspaceOperatorMcpUrl = (env: Env, ws: string) => `${workspaceMcpUrl(env, ws)}&role=operator`;

function naiveFailure(err: unknown): never {
  if (err instanceof ProviderError) throw new ApiError(502, "naive_error", err.message);
  throw err;
}

/** Naive client + template agent id. 503 not_configured names what is missing. */
export function naiveTemplate(env: Env, fetchFn?: FetchFn): { client: NaiveClient; agentId: string } {
  const missing = (["NAIVE_API_KEY", "NAIVE_AGENT_ID"] as const).filter((k) => !env[k]);
  if (missing.length) {
    throw new ApiError(
      503,
      "not_configured",
      `The Naive agent is not configured: ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set. ` +
        "Create the Crusonia agent in Naive, then add NAIVE_AGENT_ID (and NAIVE_API_KEY) to the Worker secrets.",
      { missing },
    );
  }
  return { client: new NaiveClient(env.NAIVE_API_KEY!, fetchFn), agentId: env.NAIVE_AGENT_ID! };
}

/** The workspace agent's config: the template's, with the crusonia server pointed at the workspace's MCP URL. */
export function workspaceAgentConfig(template: NaiveAgent, url: string, ws: string): Record<string, unknown> {
  const servers = (template.mcp_servers ?? []).map(({ type: _type, ...s }) => ({ type: "url", ...s, ...(s.name === CRUSONIA_SERVER ? { url } : {}) }));
  if (!servers.some((s) => s.name === CRUSONIA_SERVER)) servers.push({ type: "url", name: CRUSONIA_SERVER, url });
  const config: Record<string, unknown> = {
    name: `${template.name ?? "Crusonia Research"} · ${ws}`.slice(0, 120),
    description: template.description ?? "Crusonia research agent for one workspace.",
    model: template.model,
    window: template.window,
    system: template.system,
    tools: template.tools,
    mcp_servers: servers,
    handoffs: false,
    budget: template.budget,
    metadata: { ...(template.metadata ?? {}), workspace_id: ws, template_agent: template.id, template_version: String(template.current_version ?? "") },
  };
  return Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));
}

type AgentRow = {
  naive_workflow_version: string | null;
  naive_agent_id: string | null;
  naive_credential_id: string | null;
  naive_api_key_id: string | null;
  naive_template_version: number | null;
  naive_synced_at: Date | string | null;
};

export type WorkspaceAgent = { client: NaiveClient; agentId: string; workflowVersion: string | null };

/**
 * The Naive agent that runs this workspace's sessions (created or re-synced as needed), with the client and the
 * workflow version its runs record. The owner workspace runs on the template agent itself.
 */
export async function naiveAgentFor(sql: Sql, env: Env, ws: string, fetchFn?: FetchFn): Promise<WorkspaceAgent> {
  const template = naiveTemplate(env, fetchFn);
  if (isOwnerWorkspace(ws)) {
    if (!templateVersion || templateVersion.agentId !== template.agentId || Date.now() - templateVersion.at > TEMPLATE_TTL_MS) {
      const value = await template.client.getAgent(template.agentId).then(workflowVersionOf, () => null);
      templateVersion = { agentId: template.agentId, value, at: Date.now() };
    }
    return { ...template, workflowVersion: templateVersion.value };
  }
  return { client: template.client, ...(await ensureWorkspaceAgent(sql, env, ws, template)) };
}

async function ensureWorkspaceAgent(
  sql: Sql,
  env: Env,
  ws: string,
  template: { client: NaiveClient; agentId: string },
): Promise<{ agentId: string; workflowVersion: string | null }> {
  const { client } = template;
  const [row] = (await sql`
    select naive_agent_id, naive_credential_id, naive_api_key_id, naive_template_version, naive_synced_at, naive_workflow_version
    from workspaces where id = ${ws}`) as AgentRow[];
  if (!row) throw new ApiError(404, "not_found", "Workspace not found");
  const fresh = row.naive_synced_at && Date.now() - new Date(row.naive_synced_at).getTime() < SYNC_EVERY_MS;
  if (row.naive_agent_id && row.naive_credential_id && fresh) return { agentId: row.naive_agent_id, workflowVersion: row.naive_workflow_version };

  const current = await client.getAgent(template.agentId).catch(naiveFailure);
  const workflowVersion = workflowVersionOf(current);
  const url = workspaceMcpUrl(env, ws);
  if (row.naive_agent_id && row.naive_credential_id) {
    if (row.naive_template_version !== (current.current_version ?? null)) {
      // The template changed (playbook, tools, budget): apply it to the copy. A no-op patch mints no version.
      await client.updateAgent(row.naive_agent_id, workspaceAgentConfig(current, url, ws)).catch(naiveFailure);
    }
    await sql`update workspaces set naive_template_version = ${current.current_version ?? null}, naive_workflow_version = ${workflowVersion},
                naive_synced_at = now() where id = ${ws}`;
    return { agentId: row.naive_agent_id, workflowVersion };
  }

  // First run: claim provisioning so concurrent starts create one agent.
  const claimed = await sql`
    update workspaces set naive_provisioning_at = now()
    where id = ${ws} and (naive_provisioning_at is null or naive_provisioning_at < now() - interval '2 minutes')
    returning id`;
  if (!claimed.length) throw new ApiError(409, "agent_provisioning", "This workspace's agent is being set up; try again in a few seconds.");
  try {
    if (!env.NAIVE_VAULT_ID) throw notConfigured("NAIVE_VAULT_ID");
    let agentId = row.naive_agent_id;
    if (!agentId) {
      const agent = await client.createAgent(workspaceAgentConfig(current, url, ws), `crusonia-agent-${ws}`).catch(naiveFailure);
      agentId = agent.id;
      await sql`update workspaces set naive_agent_id = ${agentId}, naive_mcp_url = ${url} where id = ${ws}`;
    }
    // A fresh key for the credential; an older agent key (an earlier attempt that failed) is revoked.
    if (row.naive_api_key_id) await revokeApiKey(sql, ws, row.naive_api_key_id, "system:naive_agent", "agent").catch(() => {});
    const { api_key, key } = await createApiKey(sql, ws, "Naive agent", "system:naive_agent", "agent");
    const credential = await client
      .createVaultCredential(
        env.NAIVE_VAULT_ID,
        { kind: "static_bearer", key: `Crusonia MCP ${ws}`, mcp_server_url: url, agent_id: agentId, value: key },
        `crusonia-credential-${ws}-${api_key.id}`,
      )
      .catch(naiveFailure);
    await sql`
      update workspaces set naive_credential_id = ${credential.id}, naive_api_key_id = ${api_key.id}, naive_mcp_url = ${url},
             naive_template_version = ${current.current_version ?? null}, naive_workflow_version = ${workflowVersion},
             naive_synced_at = now(), naive_provisioning_at = null
      where id = ${ws}`;
    await logEvent(sql, ws, null, "naive_agent_created", { agent_id: agentId, template_version: current.current_version ?? null });
    return { agentId, workflowVersion };
  } catch (err) {
    await sql`update workspaces set naive_provisioning_at = null where id = ${ws}`.catch(() => {});
    throw err;
  }
}

// ---------- the Operator (playbooks/operator.md, src/mcp/toolsets.ts) ----------

type OperatorRow = {
  agent_id?: string;
  credential_id?: string;
  api_key_id?: string;
  template_version?: number | null;
  workflow_version?: string | null;
  synced_at?: string;
};

export const operatorConfigured = (env: Env) => Boolean(env.NAIVE_API_KEY && env.NAIVE_OPERATOR_AGENT_ID);

/**
 * The Naive agent that runs this workspace's Operator sessions. Same scoping as naiveAgentFor: the owner workspace runs
 * on the template (NAIVE_OPERATOR_AGENT_ID), any other on its own copy, whose vault credential holds a key of kind
 * 'operator' for exactly /mcp?ws=<id>&role=operator.
 */
export async function naiveOperatorFor(sql: Sql, env: Env, ws: string, fetchFn?: FetchFn): Promise<WorkspaceAgent> {
  if (!env.NAIVE_API_KEY) throw notConfigured("NAIVE_API_KEY");
  if (!env.NAIVE_OPERATOR_AGENT_ID) throw notConfigured("NAIVE_OPERATOR_AGENT_ID");
  const client = new NaiveClient(env.NAIVE_API_KEY, fetchFn);
  const templateId = env.NAIVE_OPERATOR_AGENT_ID;
  if (isOwnerWorkspace(ws)) {
    const template = await client.getAgent(templateId).then(workflowVersionOf, () => null);
    return { client, agentId: templateId, workflowVersion: template };
  }
  const [row] = await sql`select naive_operator from workspaces where id = ${ws}`;
  if (!row) throw new ApiError(404, "not_found", "Workspace not found");
  const saved = (row.naive_operator ?? {}) as OperatorRow;
  const fresh = saved.synced_at && Date.now() - new Date(saved.synced_at).getTime() < SYNC_EVERY_MS;
  if (saved.agent_id && saved.credential_id && fresh) return { client, agentId: saved.agent_id, workflowVersion: saved.workflow_version ?? null };

  const current = await client.getAgent(templateId).catch(naiveFailure);
  const workflowVersion = workflowVersionOf(current);
  const url = workspaceOperatorMcpUrl(env, ws);
  const save = async (fields: OperatorRow) => {
    await sql`update workspaces set naive_operator = coalesce(naive_operator, '{}'::jsonb) || ${JSON.stringify(fields)}::jsonb where id = ${ws}`;
  };
  const stamp = { template_version: current.current_version ?? null, workflow_version: workflowVersion, synced_at: new Date().toISOString() };
  if (saved.agent_id && saved.credential_id) {
    if (saved.template_version !== (current.current_version ?? null)) {
      await client.updateAgent(saved.agent_id, workspaceAgentConfig(current, url, ws)).catch(naiveFailure);
    }
    await save(stamp);
    return { client, agentId: saved.agent_id, workflowVersion };
  }
  if (!env.NAIVE_VAULT_ID) throw notConfigured("NAIVE_VAULT_ID");
  let agentId = saved.agent_id;
  if (!agentId) {
    agentId = (await client.createAgent(workspaceAgentConfig(current, url, ws), `crusonia-operator-${ws}`).catch(naiveFailure)).id;
    await save({ agent_id: agentId });
  }
  if (saved.api_key_id) await revokeApiKey(sql, ws, saved.api_key_id, "system:naive_agent", "operator").catch(() => {});
  const { api_key, key } = await createApiKey(sql, ws, "Naive operator", "system:naive_agent", "operator");
  const credential = await client
    .createVaultCredential(
      env.NAIVE_VAULT_ID,
      { kind: "static_bearer", key: `Crusonia operator ${ws}`, mcp_server_url: url, agent_id: agentId, value: key },
      `crusonia-operator-credential-${ws}-${api_key.id}`,
    )
    .catch(naiveFailure);
  await save({ credential_id: credential.id, api_key_id: api_key.id, ...stamp });
  await logEvent(sql, ws, null, "naive_agent_created", { agent_id: agentId, role: "operator", template_version: current.current_version ?? null });
  return { client, agentId, workflowVersion };
}
