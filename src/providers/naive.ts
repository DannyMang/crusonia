// Thin Naive (vetta.sh) REST client: sessions, events, tool confirmations and answers.
// Every POST carries an Idempotency-Key; a 429 or an ambiguous failure is retried (up to NAIVE_POST_ATTEMPTS) with the
// same key, which the provider replays instead of acting twice.
import { defaultFetch, ProviderError, requestJson, type FetchFn } from "./http.ts";

export const NAIVE_BASE = "https://api.vetta.sh";

export type StopReason =
  | "end_turn"
  | "awaiting_input"
  | "awaiting_approval"
  | "awaiting_answer"
  | "awaiting_delegation"
  | "budget_paused"
  | "interrupted"
  | "max_iterations"
  | "context_exhausted"
  | "error";

export type QuestionField = { key: string; label?: string; multiple?: boolean; options?: unknown[] };

/** A parked row on an idle session: a tool confirmation (kind "tool", the default) or an ask_operator question. */
export type PendingAction = {
  kind?: "tool" | "question";
  tool_call_id: string;
  name: string;
  args?: unknown;
  question?: { prompt: string; fields: QuestionField[] };
  parked_seq?: number;
};

export type NaiveSession = {
  id: string;
  status: "queued" | "running" | "idle" | "completed" | "failed" | "cancelled" | string;
  stop_reason?: StopReason | null;
  pending_actions?: PendingAction[];
  /** Running session total in micro-USD (1,000,000 = $1). */
  consumed_micro_usd?: number | null;
  started_at?: string;
  ended_at?: string | null;
  last_seq?: number;
};

export type NaiveEvent = { seq: number; type: string; data: Record<string, unknown>; created_at?: string };

/** GET /v1/agents/{id}: the current configuration (fields we copy for workspace agents) and its version. */
export type NaiveAgent = {
  id: string;
  name?: string;
  description?: string | null;
  model?: string;
  harness?: string | null;
  window?: string;
  system?: string;
  tools?: unknown;
  mcp_servers?: { type?: string; name: string; url: string }[];
  handoffs?: unknown;
  budget?: { cap_micro_usd: number; max_task_micro_usd: number; period: string };
  metadata?: Record<string, string>;
  current_version?: number;
};
export type EventPage = { data: NaiveEvent[]; has_more: boolean; next_cursor: string | null };

/** POSTs: per-attempt timeout and attempts (429 "at capacity" and ambiguous failures are retried). */
export const NAIVE_POST_TIMEOUT_MS = 30_000;
export const NAIVE_POST_ATTEMPTS = 3;

export class NaiveClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchFn = defaultFetch,
    private readonly baseUrl = NAIVE_BASE,
    private readonly retryDelayMs = 2_000,
  ) {}

  /** `idempotencyKey`: a stable key makes a retried create return the first result (default: random per call). */
  private async post<T>(path: string, body: unknown, idempotencyKey: string = crypto.randomUUID(), method = "POST"): Promise<T> {
    const init = {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    };
    // At capacity Naive answers 429 after ~15 seconds, so wait longer than the default and retry 429s as well as
    // ambiguous failures, with the same key (a replay never acts twice).
    for (let attempt = 1; ; attempt++) {
      try {
        return await requestJson<T>("naive", this.fetchFn, `${this.baseUrl}${path}`, { ...init, timeoutMs: NAIVE_POST_TIMEOUT_MS });
      } catch (err) {
        const retryable = err instanceof ProviderError && (err.ambiguous || err.status === 429);
        if (!retryable || attempt >= NAIVE_POST_ATTEMPTS) throw err;
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }
  }

  private get<T>(path: string): Promise<T> {
    return requestJson<T>("naive", this.fetchFn, `${this.baseUrl}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
  }

  getAgent(agentId: string) {
    return this.get<NaiveAgent>(`/v1/agents/${encodeURIComponent(agentId)}`);
  }

  createAgent(config: Record<string, unknown>, idempotencyKey?: string) {
    return this.post<NaiveAgent>("/v1/agents", config, idempotencyKey);
  }

  /** PATCH: a new agent version when the config changed (unconditional apply: no expected_version). */
  updateAgent(agentId: string, patch: Record<string, unknown>) {
    return this.post<NaiveAgent>(`/v1/agents/${encodeURIComponent(agentId)}`, patch, crypto.randomUUID(), "PATCH");
  }

  /** A write-only vault credential; `agent_id` binds it to that agent's sessions only. */
  createVaultCredential(
    vaultId: string,
    input: { kind: "static_bearer"; key: string; mcp_server_url: string; agent_id?: string; value: string },
    idempotencyKey?: string,
  ) {
    return this.post<{ id: string; mcp_server_url: string; agent_id: string | null }>(
      `/v1/vaults/${encodeURIComponent(vaultId)}/credentials`,
      input,
      idempotencyKey,
    );
  }

  createSession(input: { agent_id: string; message: string; metadata?: Record<string, string> }) {
    return this.post<{ id: string; status: string }>("/v1/sessions", input);
  }

  sendMessage(sessionId: string, input: { message: string; queue?: boolean }) {
    return this.post<unknown>(`/v1/sessions/${encodeURIComponent(sessionId)}/messages`, input);
  }

  getSession(sessionId: string) {
    return this.get<NaiveSession>(`/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  confirmTool(
    sessionId: string,
    input: { tool_call_id: string; decision: "allow" | "deny"; reason?: string; scope?: "call" | "session" },
  ) {
    return this.post<unknown>(`/v1/sessions/${encodeURIComponent(sessionId)}/tool_confirmations`, input);
  }

  answer(sessionId: string, input: { tool_call_id: string; answers: Record<string, string | string[]> }) {
    return this.post<unknown>(`/v1/sessions/${encodeURIComponent(sessionId)}/answers`, input);
  }

  /** `includeAccepted` adds the opt-in types (tool.confirm.resolved, message.accepted, ...); a free read either way. */
  listEvents(sessionId: string, afterSeq: number, limit = 100, opts: { includeAccepted?: boolean } = {}) {
    const qs = new URLSearchParams({ after_seq: String(afterSeq), limit: String(limit) });
    if (opts.includeAccepted) qs.set("include_accepted", "true");
    return this.get<EventPage>(`/v1/sessions/${encodeURIComponent(sessionId)}/events?${qs}`);
  }
}
