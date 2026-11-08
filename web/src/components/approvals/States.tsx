// Calm states for the right pane: nothing selected, and an approval that is no longer waiting.
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { isApiError, type Approval } from "../../api.ts";
import { useApi } from "../../auth.tsx";
import { timeAgo } from "../../lib/format.ts";
import { ApprovalsIcon } from "../icons.tsx";
import { Button, ButtonLink, QueryError, Skeleton } from "../ui.tsx";

function Calm({ title, body, action }: { title: ReactNode; body: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex grow flex-col items-center justify-center gap-2 px-10 text-center">
      <div className="mb-1 flex size-9 items-center justify-center rounded-full bg-panel text-green">
        <ApprovalsIcon />
      </div>
      <h2 className="text-[15px]/5 font-semibold tracking-[-0.01em] text-ink">{title}</h2>
      <p className="max-w-sm text-[13px]/5 font-medium text-[#200D0D8C]">{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function NothingSelected({ count }: { count: number }) {
  return (
    <Calm
      title={count ? "Pick something to review" : "All caught up"}
      body={
        count ? (
          <>
            {count === 1 ? "One approval is" : `${count} approvals are`} waiting on the left. Press <span className="text-ink">J</span> to open the first, then{" "}
            <span className="text-ink">J</span> / <span className="text-ink">K</span> to move through the queue.
          </>
        ) : (
          "Nothing matches these filters right now."
        )
      }
    />
  );
}

export function DetailSkeleton() {
  return (
    <div className="flex grow flex-col">
      <div className="flex flex-col gap-2 border-b border-b-[#200D0D1A] px-5 pb-3.5 pt-4">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="h-10 border-b border-b-[#200D0D1A] bg-[#200D0D04]" />
      <div className="flex flex-col gap-3 px-5 py-3.5">
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    </div>
  );
}

const OUTCOME: Record<string, (a: Approval) => { title: string; body: string }> = {
  approved: (a) => ({
    title: `${a.code} was approved`,
    body: `${a.kind === "send" ? "The email went out" : "The agent was allowed to continue"} ${a.decided_at ? timeAgo(a.decided_at) : ""}.`,
  }),
  rejected: (a) => ({ title: `${a.code} was rejected`, body: `${a.kind === "send" ? "The draft went back to the agent" : "The agent was told no"}${a.answer ? `: “${a.answer}”` : "."}` }),
  answered: (a) => ({ title: `${a.code} was answered`, body: `Your answer went to the agent ${a.decided_at ? timeAgo(a.decided_at) : ""}.` }),
  expired: (a) => ({
    title: `${a.code} expired`,
    body:
      a.decided_via === "superseded"
        ? "A newer draft replaced it; the newer version has its own code."
        : a.kind === "send"
          ? "Nobody approved it in time, so the draft went back to the agent. Nothing was sent."
          : "Nobody answered in time, so the agent moved on.",
  }),
};

/** A code from the URL that is not in the waiting list: decided, expired, hidden by a filter, or unknown. */
export function CodeState({ code, filtered, onClearFilters }: { code: string; filtered: boolean; onClearFilters: () => void }) {
  const api = useApi();
  const q = useQuery({ queryKey: ["approval", code], queryFn: () => api.approval(code), staleTime: 5_000 });
  if (q.isLoading) return <DetailSkeleton />;
  if (q.isError) {
    if (isApiError(q.error) && q.error.status === 404 && !q.error.missingRoute) {
      return <Calm title={`No approval with code ${code}`} body="Codes are four characters, like A7F2. Check the link, or pick an approval on the left." />;
    }
    return (
      <div className="p-5">
        <QueryError error={q.error} what="this approval" onRetry={() => void q.refetch()} />
      </div>
    );
  }
  const a = q.data!.approval;
  const lapsed = a.status === "pending" && new Date(a.expires_at).getTime() <= Date.now();
  if (a.status === "pending" && !lapsed) {
    return filtered ? (
      <Calm
        title={`${a.code} is hidden by your filters`}
        body="It is still waiting for a decision."
        action={
          <Button variant="soft" onClick={onClearFilters}>
            Clear filters
          </Button>
        }
      />
    ) : (
      <DetailSkeleton />
    );
  }
  const o = (OUTCOME[lapsed ? "expired" : a.status] ?? ((x: Approval) => ({ title: `${x.code} is ${x.status}`, body: "" })))(a);
  return (
    <Calm
      title={o.title}
      body={o.body}
      action={
        a.lead_id ? (
          <ButtonLink to={`/app/leads/${encodeURIComponent(a.lead_id)}`} variant="soft">
            Open lead
          </ButtonLink>
        ) : undefined
      }
    />
  );
}
