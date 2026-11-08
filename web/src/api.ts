// Typed client for the Crusonia REST API. Every request carries `Authorization: Bearer <token>` (a fresh
// Clerk session token per request). Errors come back as { error: { code, message, details? } } and are
// thrown as ApiError so screens can tell "not set up yet" (503 not_configured) from real failures.

// The price list types are shared with the Worker (src/billing/catalog.ts), so the API and /pricing cannot drift.
import type { CatalogPack, CatalogPlan, CreditFacts } from "../../src/billing/catalog.ts";
import { currentWorkspace, leaveChosenWorkspace } from "./lib/workspace.ts";

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
  "meeting_booked",
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
  // Agent loop v2 (lead_notes, contacts, links, why_summary). Optional: older deployments do not send them.
  /** Named people at the company, only from public pages the agent read. */
  contacts?: LeadContact[];
  /** The company's links (site, LinkedIn page, GitHub org, X account). */
  links?: LeadLink[];
  /** "Why we picked it": 2-4 sentences citing the lead's evidence by number ([1] = oldest evidence item). */
  why_summary?: string | null;
  next_step?: string | null;
  /** The owner excluded the company: future runs skip it until un-excluded. */
  excluded_at?: string | null;
  excluded_reason?: string | null;
  /** List rows only (asked of the backend): notes on the lead, and the latest thumbs rating. */
  notes_count?: number;
  rating?: "up" | "down" | null;
  created_at: string;
  updated_at: string;
};

export type LeadContact = {
  name: string;
  title: string | null;
  linkedin_url: string | null;
  x_url: string | null;
  github_url: string | null;
  source_url: string;
  found_at?: string;
};

export type LinkKind = "website" | "linkedin" | "github" | "x" | "other";
export type LeadLink = { kind: LinkKind | (string & {}); url: string; source_url: string; found_at?: string };

export type NoteKind = "note" | "thumbs_down" | "thumbs_up";

/** A note on a lead. `author`: `user:<clerk id>` (or `user:owner`, `user:api_key:<id>`) for people, `agent:<session id>` for agents. */
export type LeadNote = { id: string; lead_id?: string; author: string; kind: NoteKind | (string & {}); body: string; created_at: string; updated_at: string };

export type LeadFilters = { stage?: LeadStage; min_score?: number; source?: string; q?: string; limit?: number; cursor?: string };

/** GET /api/autopilot: the switch, what is running, the feed, and the tally (src/services/autopilot.ts). */
export type AutopilotFeedItem = { id: string; at: string; text: string; detail?: string; by: "agent" | "you" | "system"; lead_id: string | null; waiting?: boolean };
export type Autopilot = {
  available: boolean;
  enabled: boolean;
  paused: boolean;
  running: { session_id: string; lead_id: string | null; waiting_on_you: boolean; text: string }[];
  feed: AutopilotFeedItem[];
  counts: { agent_actions: number; owner_actions: number; days: number };
};

/** `n`: 1..n, oldest first (the number why_summary and citations refer to). Older deployments omit it. */
export type Evidence = { id: number; lead_id: string; claim: string; source_url: string; created_at: string; n?: number };

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
  /** email (AgentMail, needs approval) or a manual channel (a task the owner sends). Absent = email. */
  channel?: DraftChannel | (string & {});
  target_url?: string | null;
  citations?: Citation[];
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
  /** When the iMessage notice for this approval was delivered (asked of the backend); null when not texted. */
  texted_at?: string | null;
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
  /** Newest first (agent loop v2). */
  notes?: LeadNote[];
};

// ---------- agent loop v2: find runs, manual tasks, traces ----------

export type FindStatus = "created" | "merged" | "known";
/** A lead a find run returned. `known` = already in Crusonia ("Already in your leads"). */
export type FindRunLead = Lead & { find_status?: FindStatus };
export type FindRun = { run: Run; leads: FindRunLead[] };

export type DraftChannel = "email" | "email_manual" | "linkedin" | "x" | "intro";
export type ManualChannel = Exclude<DraftChannel, "email">;
export type Citation = { text: string; source_url: string };

export type TaskStatus = "open" | "sent" | "skipped" | "superseded";

/** A manual outreach task: a draft on a manual channel the owner sends personally, then marks sent or skipped. */
export type Task = {
  id: string;
  lead_id: string;
  version: number;
  channel: ManualChannel | (string & {});
  status: TaskStatus | (string & {});
  subject: string;
  body: string;
  target_url: string | null;
  /** The profile to open, or a mailto: link for email_manual. */
  open_url: string | null;
  citations: Citation[];
  created_at: string;
  closed_at: string | null;
  lead: {
    id: string;
    name: string | null;
    title: string | null;
    company: string | null;
    domain: string | null;
    website: string | null;
    linkedin_url: string | null;
    email: string | null;
    stage: string;
    score: number | null;
    has_consent: boolean;
  };
};

export type TraceEvent = { seq: number; type: string; data: Record<string, unknown>; created_at: string };

/** GET /api/workflows/runs/:id/trace: every stored event of a run, plus our audit events, approvals and spend. */
export type Trace = {
  run: Run;
  events: TraceEvent[];
  has_more: boolean;
  next_after_seq: number | null;
  audit: { id: string; lead_id: string | null; kind: string; data: Record<string, unknown>; created_at: string }[];
  approvals: { code: string; kind: string; status: string; summary: string; decided_via: string | null; created_at: string }[];
  spend: { naive_usd: number | null; credits_debited: number; credits?: number; apify_runs: { run_id: string; actor: string; status: string; usage_usd: number | null }[] };
  retention_days: number;
  sync?: { ok: boolean; complete?: boolean; error?: string; skipped?: string };
};

// ---------- company summary (workspaces) ----------

export type CompanySummary = {
  /** null before the first save (version 0); `template` is the suggested start then. */
  markdown: string | null;
  version: number;
  updated_at: string | null;
  /** `user:<id>`, `agent:<run id>`, `agent:api_key:<key id>`, `agent:mcp_token` or `onboarding`. */
  updated_by: string | null;
  change_note: string | null;
  template?: string;
  max_chars?: number;
};

export type SummaryVersion = { version: number; author: string; change_note: string | null; created_at: string; chars: number };

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

// ---------- web app endpoints (backend PR #7; mocked with MSW in `bun run dev:mock`) ----------

export type Me = {
  user: { id: string; email?: string; name?: string };
  /** `clerk` for a signed-in user; `token` for MCP_TOKEN or an API key. */
  auth: "clerk" | "token";
  key?: { id: string; name: string };
  /** The workspace this caller acts on (`owner` is the instance owner's), and their role in it. */
  workspace?: { id: string; name: string; owner: boolean; role?: WorkspaceRole };
};

// ---------- workspaces and the team ----------

export type WorkspaceRole = "owner" | "admin" | "member";
export type InviteRole = Exclude<WorkspaceRole, "owner">;
export type MyWorkspace = { id: string; name: string; role: WorkspaceRole; owner: boolean };
export type TeamMember = { user_id: string; role: WorkspaceRole; joined_at: string; email?: string; name?: string; image_url?: string };
export type TeamInvite = {
  id: string;
  email: string;
  role: InviteRole;
  inviter_name: string | null;
  created_at: string;
  expires_at: string;
  last_sent_at: string;
  status: "pending" | "expired";
};
/** What an invite link shows before anyone signs in. */
export type InvitePreview = { workspace_name: string; inviter_name: string | null; email: string; role: InviteRole; expires_at: string };
export type AcceptedInvite = { workspace: { id: string; name: string; role: WorkspaceRole }; already_member: boolean };

/**
 * `pipeline` is cumulative (how many leads got at least this far: found >= researched >= drafted >= sent >= replied
 * >= meetings); `pipeline_now` is where leads are now, each in at most one bucket. `awaiting_approval` is not a step:
 * it is how many leads have an email waiting for the owner. `qualified` (asked of the backend) is optional.
 */
export type Pipeline = {
  found: number;
  researched: number;
  qualified?: number;
  drafted: number;
  awaiting_approval: number;
  sent: number;
  replied: number;
  meetings: number;
};

export type RunStatus = "running" | "paused" | "idle" | "done" | "error";

/** One agent session. `id` is the Naive session id (route /app/workflows/runs/:id). */
export type Run = {
  id: string;
  workflow_id: string;
  name: string;
  purpose: string;
  status: RunStatus;
  stop_reason: string | null;
  lead_id: string | null;
  input: Record<string, unknown>;
  started_at: string;
  updated_at: string;
  last_event_at: string;
  leads_processed: number;
  cost_usd: number | null;
  /** What it cost in credits: agent time and data calls. Null until anything is reported. */
  cost_credits: number | null;
};

/** A workflow = all runs with one purpose (`research`, `find_leads`, `onboarding`). `id` is the purpose. */
export type Workflow = {
  id: string;
  name: string;
  purpose: string;
  status: RunStatus;
  started_at: string;
  first_started_at: string;
  last_event_at: string | null;
  leads_processed: number;
  cost_usd: number | null;
  cost_credits: number | null;
  run_count: number;
  active_runs: number;
  /** Most recent runs, newest first (10 by default). */
  runs: Run[];
};

export type ReplyLabelValue = "interested" | "not_interested" | "unsubscribe" | "out_of_office" | "other";

export type Reply = {
  id: string;
  lead_id: string | null;
  lead: { id: string; name: string | null; email: string | null; company: string | null; stage: string } | null;
  from: string | null;
  subject: string | null;
  /** Untrusted inbound text (first 200 chars): render as plain text. */
  preview: string;
  label: ReplyLabelValue | (string & {}) | null;
  thread_id: string | null;
  received_at: string;
};

export type SummaryApproval = ApprovalListItem & { lead_name: string | null; company: string | null; subject: string | null };

export type Summary = {
  pipeline: Pipeline;
  /** Where leads are now (the old `pipeline`). Absent on older deployments. */
  pipeline_now?: Pipeline;
  /** Open manual tasks. Absent on older deployments. */
  tasks_open?: number;
  pipeline_by_stage: Record<string, number>;
  total_leads: number;
  /** The 5 newest pending approvals; `pending_approvals_total` counts all of them. */
  pending_approvals: SummaryApproval[];
  pending_approvals_total: number;
  /** Pending send approvals (email drafts) among them. Optional: older deployments do not send it. */
  pending_sends_total?: number;
  /** Workflows with at least one active run. */
  active_workflows: Workflow[];
  recent_replies: Reply[];
  /** `week_usd` is null until Naive reports usage; `budget_usd` is null without WEEKLY_BUDGET_USD. */
  spend: { week_usd: number | null; week_credits?: number | null; budget_usd: number | null; budget_credits?: number | null };
  paused: boolean;
};

export type ProviderStatus = { configured: boolean; used_for: string; missing?: string[] };

/** One CRM sync target in /api/status (`crm_sync`). Writes happen only when `active` (configured + enabled). */
export type CrmSyncTarget = {
  /** The *_SYNC_ENABLED switch is on. */
  enabled: boolean;
  /** The target's keys are set. */
  configured: boolean;
  active: boolean;
  /** Pending queue items; null without a database. */
  queue_depth: number | null;
  failed: number | null;
  last_sync_at: string | null;
  last_error: string | null;
};

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
  next_steps: string[];
  /** The AgentMail inbox address, or null when AgentMail is not configured. */
  inbox_address: string | null;
  naive_agent_configured: boolean;
  mcp_url: string;
  /** HubSpot and Notion sync (added with the CRM sync backend; absent on older deployments). */
  crm_sync?: { hubspot: CrmSyncTarget; notion: CrmSyncTarget; error?: string };
  /** iMessage approvals through Photon (absent on older deployments). `owner_phone_hint` ("···0142") was asked of the backend. */
  imessage?: { enabled: boolean; configured: boolean; active: boolean; owner_phone_set: boolean; owner_phone_hint?: string | null; bridge?: { online?: boolean } | null };
};

export type Segment = { name: string; company_size: string | null; industry: string | null; roles: string[] };
export type Signal = { name: string; description: string | null };
export type ProfileSource = { field: string; url: string };

export type Profile = {
  company: string | null;
  website: string | null;
  sells: string | null;
  icp_description: string | null;
  segments: Segment[];
  signals: Signal[];
  sources: ProfileSource[];
  notes: string | null;
  updated_at: string | null;
};

/** PUT /api/profile body: the whole profile (omitted arrays become empty; empty strings clear a field). */
export type ProfileInput = {
  company?: string | null;
  website?: string | null;
  sells?: string | null;
  icp_description?: string | null;
  segments?: { name: string; company_size?: string | null; industry?: string | null; roles?: string[] }[];
  signals?: { name: string; description?: string | null }[];
  sources?: ProfileSource[];
  notes?: string | null;
};

export type WebsitePage = { url: string; title: string; text: string; description?: string | null; truncated?: boolean };
export type ReadWebsiteResult = { pages: WebsitePage[]; mode?: string; note?: string };

export type ProposeStatus = {
  session_id: string;
  status: "running" | "done" | "error";
  profile?: Profile;
  error?: string;
  stop_reason?: string | null;
  /** The agent is parked on the owner: answer in /app/approvals and polling continues. */
  waiting_on: "approval" | "answer" | null;
  pending_approvals: { code: string; kind: string; summary: string; expires_at: string }[];
  note?: string;
};

export type RunStep = {
  /** 1..n in display order. */
  seq: number;
  type: string;
  tool?: string;
  summary: string;
  started_at?: string;
  duration_ms?: number;
  cost_usd?: number;
  cost_credits?: number;
  /** From the agent: untrusted, display as text. */
  input?: unknown;
  output?: unknown;
  is_error?: boolean;
  source: "naive" | "crusonia";
  /** Naive's own event seq, for steps built from Naive events. */
  naive_seq?: number;
};

export type RunLead = {
  id: string;
  email: string | null;
  name: string | null;
  title: string | null;
  company: string | null;
  domain: string | null;
  stage: string;
  score: number | null;
  qualified: boolean | null;
  has_consent: boolean;
};

export type RunApproval = Pick<
  Approval,
  "code" | "kind" | "status" | "summary" | "lead_id" | "draft_id" | "naive_session_id" | "tool_call_id" | "payload" | "expires_at" | "decided_at" | "decided_via" | "created_at"
> & { draft: { id: string; version: number; subject: string; status: string } | null };

export type WorkflowRun = {
  run: Run;
  steps: RunStep[];
  lead: RunLead | null;
  approvals: RunApproval[];
  /** Whether the step cache was refreshed from Naive on this read, and why not. */
  sync?: { ok: boolean; fetched?: number; error?: string; skipped?: string };
};

export type ApiKey = {
  id: string;
  name: string;
  /** `crs_live_` + 8 characters. */
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  status: "active" | "revoked";
};

// ---------- billing (src/billing/overview.ts; mocked with MSW in `bun run dev:mock`) ----------

export type { CatalogPack, CatalogPlan, CreditFacts };

export type LedgerReason = "grant" | "pack" | "plan" | "usage" | "refund" | "expire" | "adjustment";

export type LedgerEntry = {
  id: string;
  /** Whole credits: + grants and purchases, - usage, refunds and expiry. */
  amount: number;
  reason: LedgerReason | (string & {});
  source: string;
  session_id: string | null;
  data: Record<string, unknown>;
  created_at: string;
};

export type Billing = {
  /** The paying workspace (`owner_id` is the same id, kept for older clients). */
  workspace_id?: string;
  owner_id: string;
  /** `configured`: Stripe is set up on this deployment, so Checkout and the portal work. */
  billing: { configured: boolean; webhook_configured: boolean; mode: "test" | "live" | null; enforced: boolean };
  plan: { key: string; name: string; status: string | null; current_period_end: string | null; cancel_at_period_end: boolean };
  /** A Stripe customer exists, so the Customer Portal can open. */
  has_customer: boolean;
  balance: number;
  balance_usd: number;
  /** Included plan credit still unspent, soonest expiry first. */
  expiring: { credits: number; expires_at: string }[];
  /** The 20 newest ledger rows, newest first. */
  ledger: LedgerEntry[];
  plans: (CatalogPlan & { current: boolean })[];
  packs: CatalogPack[];
  credit: CreditFacts;
};

export type CheckoutInput = { plan: string } | { pack: string };

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
    const workspace = currentWorkspace();
    if (workspace) headers["X-Crusonia-Workspace"] = workspace;
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
      // Removed from that workspace, or it belonged to another account in this browser: back to the default one.
      if (e?.code === "not_a_member" && workspace) leaveChosenWorkspace();
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

    autopilot: () => get<Autopilot>("/api/autopilot"),
    setAutopilot: (enabled: boolean) => put<Autopilot>("/api/autopilot", { enabled }),
    // settings
    getPause: () => get<{ paused: boolean }>("/api/settings/pause"),
    setPause: (paused: boolean) => put<{ paused: boolean }>("/api/settings/pause", { paused }),
    suppressions: (q?: { q?: string; limit?: number; cursor?: string }) =>
      get<Page<{ email: string; reason: string; created_at: string }> & Record<string, unknown>>("/api/suppressions", q),
    addSuppression: (email: string, reason = "manual") => post<{ created: boolean }>("/api/suppressions", { email, reason }),
    removeSuppression: (email: string) => del(`/api/suppressions/${id(email)}`),

    // profile + onboarding
    profile: () => unwrap<Profile | null>(get("/api/profile"), "profile"),
    saveProfile: (profile: ProfileInput) => unwrap<Profile>(put("/api/profile", profile), "profile"),

    // company summary (GTM.md): every save is a new version; restore copies an old one into a new version
    companySummary: () => get<CompanySummary>("/api/company-summary"),
    /** 409 version_conflict when someone saved since `base_version`. Unchanged text saves nothing (`unchanged`). */
    saveCompanySummary: (input: { markdown: string; note?: string; base_version?: number }) =>
      put<CompanySummary & { unchanged: boolean }>("/api/company-summary", input),
    summaryVersions: (q: { limit?: number; before?: number } = {}) => get<{ data: SummaryVersion[] }>("/api/company-summary/versions", q),
    summaryVersion: (version: number) => get<CompanySummary>(`/api/company-summary/versions/${version}`),
    revertCompanySummary: (version: number) => post<CompanySummary & { unchanged: boolean }>("/api/company-summary/revert", { version }),
    /** Synchronous crawl: Apify when configured (a few cents), plain fetch otherwise. */
    readWebsite: (url: string, maxPages?: number) => post<ReadWebsiteResult>("/api/onboarding/read-website", { url, ...(maxPages ? { max_pages: maxPages } : {}) }),
    /** Starts a paid Naive session (202). 503 not_configured without the agent; 423 while paused. */
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
    /** Starts a paid Naive session (202). 409 profile_missing without a saved profile; 503 without the agent. */
    findLeads: (count = 25, opts: { like_lead_id?: string } = {}) => post<{ session_id: string }>("/api/leads/find", { count, ...opts }),
    /** The leads one find run created or found again (`find_status`). */
    findRun: (sessionId: string) => get<FindRun>(`/api/leads/find/${id(sessionId)}`),
    /** Starts paid research sessions (202), one per lead. */
    research: (leadIds: string[]) => post<{ started: { lead_id: string; session_id: string }[]; skipped?: unknown[] }>("/api/workflows/research", { lead_ids: leadIds }),

    // notes on a lead; a thumbs rating is a note of kind thumbs_up / thumbs_down with the reason as its body
    notes: (leadId: string) => list<LeadNote>(`/api/leads/${id(leadId)}/notes`),
    addNote: (leadId: string, note: { body: string; kind?: NoteKind }) => post<{ note: LeadNote }>(`/api/leads/${id(leadId)}/notes`, note),
    editNote: (leadId: string, noteId: string, body: string) => patch<{ note: LeadNote }>(`/api/leads/${id(leadId)}/notes/${id(noteId)}`, { body }),
    deleteNote: (leadId: string, noteId: string) => del(`/api/leads/${id(leadId)}/notes/${id(noteId)}`),
    /** Future runs skip an excluded company until it is un-excluded. */
    excludeLead: (leadId: string, reason?: string) => post<{ lead: Lead }>(`/api/leads/${id(leadId)}/exclude`, reason ? { reason } : {}),
    unexcludeLead: (leadId: string) => del<{ lead: Lead }>(`/api/leads/${id(leadId)}/exclude`),

    // manual outreach tasks (LinkedIn, X, intro, own mailbox): nothing here sends anything
    tasks: (q: { status?: TaskStatus | "all"; channel?: ManualChannel; lead_id?: string; limit?: number } = {}) =>
      get<{ data: Task[]; open_total: number }>("/api/tasks", q),
    /** The owner sent it; `body` = the text actually sent when edited. Moves the lead to `sent`. */
    taskSent: (taskId: string, input: { body?: string; note?: string } = {}) =>
      post<{ task: Task; lead_stage: string; message_id: string }>(`/api/tasks/${id(taskId)}/sent`, input),
    taskSkip: (taskId: string, reason?: string) => post<{ task: Task }>(`/api/tasks/${id(taskId)}/skip`, reason ? { reason } : {}),

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
    workflows: (runs?: number) => list<Workflow>(`/api/workflows${runs !== undefined ? `?runs=${runs}` : ""}`),
    workflowRun: (sessionId: string) => get<WorkflowRun>(`/api/workflows/runs/${id(sessionId)}`),
    /** "View full trace": stored events after `after_seq`, oldest first. */
    trace: (sessionId: string, q: { after_seq?: number; limit?: number } = {}) => get<Trace>(`/api/workflows/runs/${id(sessionId)}/trace`, q),
    replies: (q: { limit?: number; cursor?: string; label?: string; lead_id?: string } = {}) => get<Page<Reply>>("/api/replies", q),


    // billing
    billing: () => get<Billing>("/api/billing"),
    /** -> Stripe Checkout URL. 409 already_subscribed for a plan while subscribed; 503 not_configured without Stripe. */
    checkout: (input: CheckoutInput) => post<{ url: string }>("/api/billing/checkout", input),
    /** -> Stripe Customer Portal URL. 409 no_billing_account before the first purchase. */
    billingPortal: () => post<{ url: string }>("/api/billing/portal"),

    // API keys (for MCP clients)
    keys: () => list<ApiKey>("/api/keys"),
    /** Returns the full key exactly once (`key`); only its hash is stored. */
    createKey: (name: string) => post<{ api_key: ApiKey; key: string }>("/api/keys", { name }),
    revokeKey: (keyId: string) => del<{ api_key: ApiKey }>(`/api/keys/${id(keyId)}`),

    // Workspaces and the team
    workspaces: () => get<{ current: string; data: MyWorkspace[] }>("/api/workspaces"),
    createWorkspace: (name: string) => post<{ workspace: MyWorkspace }>("/api/workspaces", { name }),
    renameWorkspace: (name: string) => patch<{ workspace: { id: string; name: string } }>("/api/workspaces/current", { name }),
    teamMembers: () => list<TeamMember>("/api/team/members"),
    changeMemberRole: (userId: string, role: WorkspaceRole) => patch<{ member: { user_id: string; role: WorkspaceRole } }>(`/api/team/members/${id(userId)}`, { role }),
    removeMember: (userId: string) => del(`/api/team/members/${id(userId)}`),
    leaveWorkspace: () => post<void>("/api/team/leave"),
    teamInvites: () => list<TeamInvite>("/api/team/invites"),
    createInvite: (email: string, role: InviteRole) => post<{ invite: TeamInvite }>("/api/team/invites", { email, role }),
    resendInvite: (inviteId: string) => post<{ invite: TeamInvite }>(`/api/team/invites/${id(inviteId)}/resend`),
    revokeInvite: (inviteId: string) => del(`/api/team/invites/${id(inviteId)}`),
    invitePreview: (token: string) => get<{ invite: InvitePreview }>(`/api/invites/${id(token)}`),
    acceptInvite: (token: string) => post<AcceptedInvite>(`/api/invites/${id(token)}/accept`),
  };
}

export type Api = ReturnType<typeof createApi>;
