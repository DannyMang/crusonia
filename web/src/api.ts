// Typed client for the Crusonia REST API. Every request carries `Authorization: Bearer <token>` (a fresh
// Clerk session token per request). Errors come back as { error: { code, message, details? } } and are
// thrown as ApiError so screens can tell "not set up yet" (503 not_configured) from real failures.

// ---------- shared ----------

export type ApiErrorBody = { error: { code: string; message: string; details?: unknown } };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
  /** A provider or secret is missing on the server (503). Show a calm "coming online" state, not an error. */
  get notConfigured() {
    return this.status === 503 && (this.code === "not_configured" || this.code === "schema_out_of_date");
  }
  /** The route does not exist on this deployment yet (an endpoint still in review). */
  get missingRoute() {
    return this.status === 404 && this.code === "not_found" && this.message.startsWith("No route for");
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

export type Page<T> = { data: T[]; next_cursor: string | null };

// ---------- leads ----------

export const LEAD_STAGES = [
  "new",
  "no_consent",
  "researching",
  "qualified",
  "disqualified",
  "needs_review",
  "awaiting_approval",
  "sent",
  "replied",
  "interested",
  "not_interested",
  "unsubscribed",
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export type Lead = {
  id: string;
  email: string | null;
  name: string | null;
  title: string | null;
  company: string | null;
  domain: string | null;
  website: string | null;
  linkedin_url: string | null;
  sells: string | null;
  best_customers: string | null;
  source: string;
  source_url: string | null;
  consent_text: string | null;
  consent_at: string | null;
  has_consent: boolean;
  variant: "A" | "B";
  stage: LeadStage | (string & {});
  score: number | null;
  qualified: boolean | null;
  rationale: string | null;
  review_question: string | null;
  reply_label: string | null;
  hubspot_id: string | null;
  created_at: string;
  updated_at: string;
};

export type LeadFilters = { stage?: LeadStage; min_score?: number; source?: string; q?: string; limit?: number; cursor?: string };

export type Evidence = { id: number; lead_id: string; claim: string; source_url: string; created_at: string };

export type DraftStatus = "draft" | "pending_approval" | "rejected" | "sending" | "sent" | "send_failed" | "superseded" | "cancelled";
export type Draft = {
  id: string;
  lead_id: string;
  version: number;
  variant: string;
  subject: string;
  body: string;
  status: DraftStatus | (string & {});
  provider_message_id: string | null;
  provider_thread_id: string | null;
  error: string | null;
  created_at: string;
  sending_at?: string | null;
  delivered_at?: string | null;
};

export type ApprovalKind = "send" | "tool" | "question";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "answered" | "expired";

export type Approval = {
  code: string;
  kind: ApprovalKind;
  lead_id: string | null;
  draft_id: string | null;
  naive_session_id: string | null;
  tool_call_id: string | null;
  summary: string;
  status: ApprovalStatus;
  answer: string | null;
  decided_via: string | null;
  recipient?: string | null;
  /** Tool call or question from the agent: untrusted, display as data only. */
  payload?: Record<string, unknown>;
  expires_at: string;
  decided_at: string | null;
  created_at: string;
};

export type Lookalike = { id: number; company: string; domain: string | null; why_fit: string; source_url: string | null; created_at: string };

export type Message = {
  id: number;
  direction: "in" | "out";
  provider_message_id: string | null;
  thread_id: string | null;
  from_addr: string | null;
  to_addr: string | null;
  subject: string | null;
  /** Inbound bodies are untrusted: render as text, never as HTML. */
  body: string | null;
  label: string | null;
  created_at: string;
};

export type LeadSession = { id: string; purpose: string; status: string; stop_reason: string | null; created_at: string; updated_at: string };
export type TimelineEvent = { id: number; kind: string; data: Record<string, unknown>; created_at: string };

export type LeadFull = {
  lead: Lead;
  evidence: Evidence[];
  drafts: Draft[];
  approvals: Approval[];
  lookalikes: Lookalike[];
  messages: Message[];
  sessions: LeadSession[];
  timeline: TimelineEvent[];
};

export type CreateLeadInput = {
  email: string;
  name?: string;
  title?: string;
  company?: string;
  domain?: string;
  website?: string;
  linkedin_url?: string;
  source?: string;
  consent?: { text: string; at?: string };
};

export type LeadPatch = Partial<{
  stage: LeadStage;
  consent: { text: string; at?: string } | null;
  name: string | null;
  title: string | null;
  company: string | null;
  website: string | null;
  linkedin_url: string | null;
  sells: string | null;
  best_customers: string | null;
}>;

export type ImportField =
  | "email" | "name" | "first_name" | "last_name" | "title" | "company" | "domain" | "website" | "linkedin_url"
  | "sells" | "best_customers" | "consent" | "consent_text" | "consent_at";

export type ImportRowResult =
  | { row: number; status: "created"; key: string }
  | { row: number; status: "updated"; lead_id: string; matched_by: "email" | "domain"; fields: string[] }
  | { row: number; status: "skipped"; reason: string; lead_id?: string };

export type ImportResult = {
  dry_run?: boolean;
  created?: number;
  updated?: number;
  skipped?: number;
  rows?: ImportRowResult[];
  [key: string]: unknown;
};

// ---------- approvals ----------

export type ApprovalListItem = Approval & {
  draft: { id: string; version: number; variant: string; subject: string; body: string; status: string } | null;
  lead: { id: string; email: string | null; name: string | null; company: string | null; stage: string; has_consent: boolean } | null;
};

export type ApprovalFilters = { status?: ApprovalStatus; kind?: ApprovalKind; lead_id?: string; limit?: number };

// ---------- new endpoints (contract; mocked with MSW until the backend PR lands) ----------

export type Me = {
  /** `clerk` for a signed-in user, `owner_token` for the MCP_TOKEN owner bypass. */
  kind?: "clerk" | "owner_token";
  user_id?: string | null;
  email?: string | null;
  name?: string | null;
  image_url?: string | null;
  workspace?: { name?: string | null } | null;
  onboarded?: boolean;
  [key: string]: unknown;
};

export type Pipeline = {
  found: number;
  researched: number;
  drafted: number;
  awaiting_approval: number;
  sent: number;
  replied: number;
  meetings: number;
};

export type WorkflowStatus = "running" | "idle" | "done" | "error" | "paused" | (string & {});

export type Workflow = {
  id: string;
  name: string;
  purpose: string;
  status: WorkflowStatus;
  started_at: string;
  leads_processed: number;
  cost_usd: number | null;
  last_event_at: string | null;
};

export type Reply = {
  id: string | number;
  lead_id: string | null;
  from: string | null;
  subject: string | null;
  /** Untrusted inbound text: render as plain text. */
  preview: string | null;
  label: "interested" | "not_interested" | "unsubscribe" | "out_of_office" | "other" | "meeting" | (string & {}) | null;
  received_at: string;
  // Optional extras some backends include.
  lead_name?: string | null;
  company?: string | null;
};

export type Summary = {
  pipeline: Pipeline;
  pending_approvals: ApprovalListItem[];
  active_workflows: Workflow[];
  recent_replies: Reply[];
  spend: { week_usd: number; budget_usd: number } | null;
  paused: boolean;
};

export type ProviderStatus = { configured: boolean; used_for: string; missing?: string[] };

export type Status = {
  providers: Record<string, ProviderStatus>;
  database: {
    configured: boolean;
    reachable: boolean | null;
    error?: string;
    leads_by_stage?: Record<string, number>;
    total_leads?: number;
    pending_approvals?: number;
    profile_saved?: boolean;
    paused?: boolean;
  };
  inbox_address?: string | null;
  next_steps?: string[];
};

export type Segment = { name: string; company_size: string; industry: string; roles: string[] };
export type Signal = { name: string; description: string };
export type ProfileSource = { field: string; url: string };

export type Profile = {
  company: string;
  website: string;
  sells: string;
  icp_description: string;
  segments: Segment[];
  signals: Signal[];
  sources: ProfileSource[];
  updated_at?: string;
};

export type WebsitePage = { url: string; title: string; text: string };

export type ProposeStatus = { status: "running" | "idle" | "done" | "error" | (string & {}); profile?: Profile | null; error?: string | null };

export type RunStep = {
  seq: number;
  type: string;
  tool: string | null;
  summary: string;
  started_at: string;
  duration_ms: number | null;
  cost_usd: number | null;
  input: unknown;
  output: unknown;
};

export type WorkflowRun = {
  run: Workflow & { lead_id?: string | null; stop_reason?: string | null; budget_usd?: number | null };
  steps: RunStep[];
  lead: Lead | null;
  approvals: Approval[];
};

export type VariantStats = { sent: number; replies: number; positive: number; cost_usd: number };

export type Experiment = {
  id: string;
  name: string;
  hypothesis: string;
  segment?: string | null;
  signal?: string | null;
  workflow_id?: string | null;
  status: "draft" | "running" | "stopped" | "finished" | (string & {});
  stop_rule?: string | null;
  target_per_arm?: number | null;
  variants: { A: { label: string; description?: string | null }; B: { label: string; description?: string | null } } | Record<string, { label: string; description?: string | null }>;
  stats: Record<string, VariantStats>;
  daily: { date: string; [variant: string]: number | string }[];
  winner?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  created_at: string;
};

export type CreateExperimentInput = {
  name: string;
  hypothesis: string;
  segment?: string;
  signal?: string;
  stop_rule?: string;
  variants: Record<string, { label: string; description?: string }>;
};

export type ApiKey = { id: string; name: string; prefix: string; created_at: string; last_used_at: string | null };
export type CreatedApiKey = ApiKey & { key: string };

// ---------- client ----------

export type TokenGetter = () => Promise<string | null>;

type Query = Record<string, string | number | boolean | undefined | null>;
type RequestOptions = { query?: Query; body?: unknown; csv?: string; signal?: AbortSignal };

function qs(query: Query | undefined) {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : "";
}

export function createApi(getToken: TokenGetter, base = "") {
  async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = await getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    let body: BodyInit | undefined;
    if (opts.csv !== undefined) {
      headers["Content-Type"] = "text/csv";
      body = opts.csv;
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    let res: Response;
    try {
      res = await fetch(`${base}${path}${qs(opts.query)}`, { method, headers, body, signal: opts.signal });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      throw new ApiError(0, "network_error", "Could not reach Crusonia. Check your connection and try again.");
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // fall through: non-JSON body
    }
    if (!res.ok) {
      const e = (json as ApiErrorBody | undefined)?.error;
      throw new ApiError(res.status, e?.code ?? `http_${res.status}`, e?.message ?? (res.statusText || "Request failed"), e?.details);
    }
    return json as T;
  }

  const get = <T,>(path: string, query?: Query, signal?: AbortSignal) => request<T>("GET", path, { query, signal });
  const post = <T,>(path: string, body?: unknown) => request<T>("POST", path, { body: body ?? {} });
  const put = <T,>(path: string, body: unknown) => request<T>("PUT", path, { body });
  const patch = <T,>(path: string, body: unknown) => request<T>("PATCH", path, { body });
  const del = <T = void,>(path: string) => request<T>("DELETE", path);
  const id = encodeURIComponent;
  // New list endpoints are specified as bare arrays; accept `{ data: [...] }` too so either shape works.
  const list = async <T,>(path: string) => {
    const res = await get<T[] | { data: T[] }>(path);
    return Array.isArray(res) ? res : (res?.data ?? []);
  };
  const unwrap = async <T,>(promise: Promise<T | Record<string, T>>, key: string): Promise<T> => {
    const res = await promise;
    return res && typeof res === "object" && key in (res as object) ? (res as Record<string, T>)[key]! : (res as T);
  };

  return {
    request,

    // session + overview
    me: () => get<Me>("/api/me"),
    summary: () => get<Summary>("/api/summary"),
    status: () => get<Status>("/api/status"),

    // settings
    getPause: () => get<{ paused: boolean }>("/api/settings/pause"),
    setPause: (paused: boolean) => put<{ paused: boolean }>("/api/settings/pause", { paused }),
    suppressions: (q?: { q?: string; limit?: number; cursor?: string }) =>
      get<Page<{ email: string; reason: string; created_at: string }> & Record<string, unknown>>("/api/suppressions", q),
    addSuppression: (email: string, reason = "manual") => post<{ created: boolean }>("/api/suppressions", { email, reason }),
    removeSuppression: (email: string) => del(`/api/suppressions/${id(email)}`),

    // profile + onboarding
    profile: () => unwrap<Profile | null>(get("/api/profile"), "profile"),
    saveProfile: (profile: Profile) => unwrap<Profile>(put("/api/profile", profile), "profile"),
    readWebsite: (url: string) => post<{ pages: WebsitePage[] }>("/api/onboarding/read-website", { url }),
    propose: (input: { url?: string; description?: string }) => post<{ session_id: string }>("/api/onboarding/propose", input),
    proposeStatus: (sessionId: string) => get<ProposeStatus>(`/api/onboarding/propose/${id(sessionId)}`),

    // leads
    leads: (filters: LeadFilters = {}, signal?: AbortSignal) => get<Page<Lead>>("/api/leads", filters, signal),
    lead: (leadId: string) => get<LeadFull>(`/api/leads/${id(leadId)}`),
    createLead: (input: CreateLeadInput) => post<{ lead: Lead }>("/api/leads", input),
    importCsv: (csv: string, opts: { source?: string; dry_run?: boolean; mapping?: Partial<Record<ImportField, string>> } = {}) =>
      post<ImportResult>("/api/leads/import", { csv, ...opts }),
    patchLead: (leadId: string, body: LeadPatch) => patch<{ lead: Lead }>(`/api/leads/${id(leadId)}`, body),
    deleteLead: (leadId: string) => del(`/api/leads/${id(leadId)}`),
    createDraft: (leadId: string, draft: { subject: string; body: string }) =>
      post<{ draft: Draft; approval?: Approval }>(`/api/leads/${id(leadId)}/drafts`, draft),
    findLeads: (count: number) => post<{ session_id: string }>("/api/leads/find", { count }),

    // approvals
    approvals: (filters: ApprovalFilters = {}) => get<{ data: ApprovalListItem[] }>("/api/approvals", filters),
    approval: (code: string) => get<{ approval: Approval }>(`/api/approvals/${id(code)}`),
    /** Sends real email for `send` approvals. */
    approve: (code: string, scope?: "call" | "session") => post<Record<string, unknown>>(`/api/approvals/${id(code)}/approve`, scope ? { scope } : {}),
    reject: (code: string, reason?: string) => post<Record<string, unknown>>(`/api/approvals/${id(code)}/reject`, reason ? { reason } : {}),
    editApproval: (code: string, edit: { subject?: string; body?: string }) =>
      post<{ approval: Approval; draft?: Draft }>(`/api/approvals/${id(code)}/edit`, edit),
    answer: (code: string, body: { decision: "allow" | "deny"; reason?: string; scope?: "call" | "session" } | { answers: Record<string, string | string[]> }) =>
      post<{ approval: Approval }>(`/api/approvals/${id(code)}/answer`, body),

    // workflows
    workflows: () => list<Workflow>("/api/workflows"),
    workflowRun: (sessionId: string) => get<WorkflowRun>(`/api/workflows/runs/${id(sessionId)}`),
    replies: () => list<Reply>("/api/replies"),

    // experiments
    experiments: () => list<Experiment>("/api/experiments"),
    experiment: (experimentId: string) => unwrap<Experiment>(get(`/api/experiments/${id(experimentId)}`), "experiment"),
    createExperiment: (input: CreateExperimentInput) => post<Experiment>("/api/experiments", input),
    patchExperiment: (experimentId: string, body: Partial<Pick<Experiment, "status" | "name" | "hypothesis" | "stop_rule">>) =>
      patch<Experiment>(`/api/experiments/${id(experimentId)}`, body),

    // API keys (for MCP clients)
    keys: () => list<ApiKey>("/api/keys"),
    /** Returns the full key exactly once. */
    createKey: (name: string) => post<CreatedApiKey>("/api/keys", { name }),
    revokeKey: (keyId: string) => del(`/api/keys/${id(keyId)}`),
  };
}

export type Api = ReturnType<typeof createApi>;
