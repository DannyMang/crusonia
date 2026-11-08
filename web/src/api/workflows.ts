// Workflow definitions (versioned, immutable per version), their run history and the full trace of one run.
// Contract agreed with the integrator (demo-backend): /api/workflow-definitions… ; the trace is agent-loop-v2's
// GET /api/workflows/runs/:id/trace. Mocked with MSW in `bun run dev:mock` (web/src/mocks/flows.ts).
// The older GET /api/workflows (one row per agent purpose, used by Home) lives in ../api.ts and is unrelated.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Api, Run } from "../api.ts";
import { useApi } from "../auth.tsx";
import type { FlowStep } from "./flow-types.ts";

// ---------- definitions ----------

export type FlowSource = "user" | "claude_code" | "template";
export type TriggerKind = "schedule" | "csv_import" | "reply" | "manual";

export type { FlowStep, StepKind } from "./flow-types.ts";

export type Qualification = {
  icp: { source: "company_summary" };
  research_questions: string[];
  evidence_required: string[];
  done_when: string;
};

export type FlowVersion = Qualification & {
  version: number;
  label: string | null;
  created_at: string;
  steps: FlowStep[];
};

export type FlowStatus = "running" | "waiting" | "budget_paused" | "paused" | "done" | "error" | "off" | (string & {});

export type FlowDef = {
  id: string;
  name: string;
  source: FlowSource;
  enabled: boolean;
  trigger: { kind: TriggerKind; label: string };
  latest_version: number;
  spend: { usd: number; cap_usd: number | null; period: "week" | "run" };
  status: FlowStatus;
  last_run: { id: string; started_at: string; status: string; summary: string; detail?: string | null } | null;
  /** Agent that runs it ("Researcher"), shown under the name when the source tag is not. */
  agent?: string | null;
  /** Drafts the next run waits on (status "waiting"). */
  waiting?: { drafts: number } | null;
  /** Leads still to process (status "budget_paused"). */
  remaining?: number | null;
};

export type FlowInput = Qualification & {
  name: string;
  steps: FlowStep[];
  source?: FlowSource;
  trigger?: FlowDef["trigger"];
};

export type FlowVersionInput = Qualification & { steps: FlowStep[]; label?: string | null };

export type FlowPatch = { enabled?: boolean; cap_usd?: number; resume?: boolean; name?: string };

// ---------- runs ----------

export type FlowRunCounts = { found: number; researched: number; qualified: number; drafted: number; sent: number };

export type FlowRun = {
  /** Session id: GET /api/workflows/runs/:id/trace. */
  id: string;
  version: number;
  started_at: string;
  status: FlowStatus;
  cost_usd: number | null;
  counts: FlowRunCounts;
  /** What started it: schedule, csv_import, reply, operator, or a person (manual). */
  trigger?: string;
  /** What its agents did, and the times a person stepped in. */
  agent_actions?: number;
  owner_actions?: number;
  /** The clean timeline: a few plain lines. */
  timeline: { at: string; text: string }[];
  trace_steps: number | null;
};

export type VariantCounts = { leads: number; researched: number; qualified: number; drafted: number; approved: number; sent: number; replied: number };

export type FlowRunHistory = {
  runs: FlowRun[];
  variants: { version: number; runs: number; arms: { key: string; label: string | null; counts: VariantCounts }[] } | null;
  needs_review: { lead_id: string; company: string | null; question: string; paused_at: string }[];
};

// ---------- trace (agent-loop-v2 src/services/traces.ts getTrace) ----------

export type TraceEvent = { seq: number; type: string; data: Record<string, unknown>; created_at: string };

export type RunTrace = {
  run: Run;
  events: TraceEvent[];
  has_more: boolean;
  next_after_seq: number | null;
  audit: { id: string; lead_id: string | null; kind: string; data: Record<string, unknown>; created_at: string }[];
  approvals: { code: string; kind: string; status: string; summary: string; created_at: string }[];
  spend: { naive_usd: number | null; credits_debited: number; apify_runs: { usage_usd: number | null }[] };
  retention_days: number;
  sync?: { ok: boolean; complete?: boolean; error?: string; skipped?: string };
};

// ---------- client ----------

const BASE = "/api/workflow-definitions";
const enc = encodeURIComponent;

export function flowsApi(api: Api) {
  const r = api.request;
  return {
    list: async () => {
      const res = await r<{ data: FlowDef[] } | FlowDef[]>("GET", BASE);
      return Array.isArray(res) ? res : (res?.data ?? []);
    },
    get: (id: string) => r<{ workflow: FlowDef; versions: FlowVersion[] }>("GET", `${BASE}/${enc(id)}`),
    create: (input: FlowInput) => r<{ workflow: FlowDef; version?: FlowVersion }>("POST", BASE, { body: input }),
    newVersion: (id: string, input: FlowVersionInput) => r<{ version: FlowVersion; workflow?: FlowDef }>("POST", `${BASE}/${enc(id)}/versions`, { body: input }),
    patch: (id: string, body: FlowPatch) => r<{ workflow: FlowDef }>("PATCH", `${BASE}/${enc(id)}`, { body }),
    /** Starts a paid run. `test_leads` limits it to that many leads. */
    run: (id: string, body: { version?: number; test_leads?: number } = {}) => r<{ run: { id: string } }>("POST", `${BASE}/${enc(id)}/run`, { body }),
    runs: (id: string) => r<FlowRunHistory>("GET", `${BASE}/${enc(id)}/runs`),
    trace: (sessionId: string, afterSeq = 0) => r<RunTrace>("GET", `/api/workflows/runs/${enc(sessionId)}/trace`, { query: { after_seq: afterSeq, limit: 200 } }),
  };
}

// ---------- React Query ----------

export const flowKeys = {
  all: ["flows"] as const,
  list: ["flows", "list"] as const,
  one: (id: string) => ["flows", "one", id] as const,
  runs: (id: string) => ["flows", "runs", id] as const,
  trace: (id: string) => ["flows", "trace", id] as const,
};

function useFlowsApi() {
  const api = useApi();
  return flowsApi(api);
}

export function useFlows() {
  const f = useFlowsApi();
  return useQuery({ queryKey: flowKeys.list, queryFn: () => f.list(), refetchInterval: 30_000 });
}

export function useFlow(id: string | undefined) {
  const f = useFlowsApi();
  return useQuery({ queryKey: flowKeys.one(id ?? ""), queryFn: () => f.get(id!), enabled: Boolean(id) });
}

export function useFlowRuns(id: string | undefined) {
  const f = useFlowsApi();
  return useQuery({ queryKey: flowKeys.runs(id ?? ""), queryFn: () => f.runs(id!), enabled: Boolean(id), refetchInterval: 30_000 });
}

export function useRunTrace(sessionId: string | null) {
  const f = useFlowsApi();
  return useInfiniteQuery({
    queryKey: flowKeys.trace(sessionId ?? ""),
    queryFn: ({ pageParam }) => f.trace(sessionId!, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.has_more && last.next_after_seq !== null ? last.next_after_seq : undefined),
    enabled: Boolean(sessionId),
  });
}

export function useFlowMutations() {
  const f = useFlowsApi();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: flowKeys.all });
  return {
    create: useMutation({ mutationFn: (input: FlowInput) => f.create(input), onSuccess: refresh }),
    newVersion: useMutation({ mutationFn: ({ id, input }: { id: string; input: FlowVersionInput }) => f.newVersion(id, input), onSuccess: refresh }),
    patch: useMutation({ mutationFn: ({ id, body }: { id: string; body: FlowPatch }) => f.patch(id, body), onSuccess: refresh }),
    run: useMutation({ mutationFn: ({ id, body }: { id: string; body?: { version?: number; test_leads?: number } }) => f.run(id, body), onSuccess: refresh }),
  };
}
