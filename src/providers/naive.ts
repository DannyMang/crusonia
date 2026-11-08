// Thin Naive (vetta.sh) REST client: sessions, events, tool confirmations and answers.
// Every POST carries an Idempotency-Key; an ambiguous failure is retried once with the same key, which
// the provider replays instead of acting twice.
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
export type EventPage = { data: NaiveEvent[]; has_more: boolean; next_cursor: string | null };

export class NaiveClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchFn = defaultFetch,
    private readonly baseUrl = NAIVE_BASE,
  ) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const init = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    };
    try {
      return await requestJson<T>("naive", this.fetchFn, `${this.baseUrl}${path}`, init);
    } catch (err) {
      if (err instanceof ProviderError && err.ambiguous) {
        return requestJson<T>("naive", this.fetchFn, `${this.baseUrl}${path}`, init);
      }
      throw err;
    }
  }

  private get<T>(path: string): Promise<T> {
    return requestJson<T>("naive", this.fetchFn, `${this.baseUrl}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
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
