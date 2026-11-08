// React Query hooks over the API client. Keys are shared so mutations can invalidate what they change.
import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isApiError, type ApprovalFilters, type LeadFilters } from "./api.ts";
import { useApi } from "./auth.tsx";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // 4xx and 503 (not configured) will not fix themselves on retry.
      retry: (count, err) => !(isApiError(err) && err.status >= 400 && err.status < 600 && err.status !== 502) && count < 2,
    },
  },
});

export const keys = {
  me: ["me"] as const,
  summary: ["summary"] as const,
  status: ["status"] as const,
  pause: ["pause"] as const,
  profile: ["profile"] as const,
  leads: (f: LeadFilters = {}) => ["leads", f] as const,
  lead: (id: string) => ["lead", id] as const,
  approvals: (f: ApprovalFilters = {}) => ["approvals", f] as const,
  workflows: ["workflows"] as const,
  run: (id: string) => ["run", id] as const,
  replies: ["replies"] as const,
  keys: ["keys"] as const,
  suppressions: (q?: string) => ["suppressions", q ?? ""] as const,
  billing: ["billing"] as const,
};

export function useMe() {
  const api = useApi();
  return useQuery({ queryKey: keys.me, queryFn: () => api.me(), staleTime: 5 * 60_000 });
}

export function useSummary() {
  const api = useApi();
  return useQuery({ queryKey: keys.summary, queryFn: () => api.summary(), refetchInterval: 30_000 });
}

export function useStatus() {
  const api = useApi();
  return useQuery({ queryKey: keys.status, queryFn: () => api.status(), staleTime: 60_000 });
}

export function usePause() {
  const api = useApi();
  return useQuery({ queryKey: keys.pause, queryFn: () => api.getPause() });
}

export function useSetPause() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paused: boolean) => api.setPause(paused),
    onSuccess: (data) => {
      qc.setQueryData(keys.pause, data);
      void qc.invalidateQueries({ queryKey: keys.summary });
    },
  });
}

export function useProfile() {
  const api = useApi();
  return useQuery({ queryKey: keys.profile, queryFn: () => api.profile() });
}

export function useLeads(filters: LeadFilters = {}) {
  const api = useApi();
  return useQuery({ queryKey: keys.leads(filters), queryFn: ({ signal }) => api.leads(filters, signal), placeholderData: (prev) => prev });
}

export function useLead(id: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: keys.lead(id ?? ""), queryFn: () => api.lead(id!), enabled: Boolean(id) });
}

export function useApprovals(filters: ApprovalFilters = {}) {
  const api = useApi();
  return useQuery({ queryKey: keys.approvals(filters), queryFn: () => api.approvals(filters), refetchInterval: 30_000 });
}

/** Pending approvals count for the sidebar badge. */
export function usePendingCount() {
  const q = useApprovals({ status: "pending" });
  return q.data?.data.length ?? 0;
}

export function useWorkflows() {
  const api = useApi();
  return useQuery({ queryKey: keys.workflows, queryFn: () => api.workflows(), refetchInterval: 30_000 });
}

export function useWorkflowRun(id: string | undefined, live = false) {
  const api = useApi();
  return useQuery({ queryKey: keys.run(id ?? ""), queryFn: () => api.workflowRun(id!), enabled: Boolean(id), refetchInterval: live ? 5_000 : false });
}

export function useReplies(q: { label?: string; limit?: number } = {}) {
  const api = useApi();
  return useQuery({ queryKey: [...keys.replies, q], queryFn: () => api.replies({ limit: 100, ...q }) });
}

export function useApiKeys() {
  const api = useApi();
  return useQuery({ queryKey: keys.keys, queryFn: () => api.keys() });
}

/** GET /api/billing: balance, plan, ledger, plans and packs. Shared by the sidebar credits pill and the billing page. */
export function useBilling({ enabled = true, poll }: { enabled?: boolean; poll?: number | false } = {}) {
  const api = useApi();
  return useQuery({ queryKey: keys.billing, queryFn: () => api.billing(), enabled, staleTime: 30_000, refetchInterval: poll ?? false });
}
