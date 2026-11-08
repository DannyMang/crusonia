// The kill switch for the whole instance, for platform admins only (Settings · General). Same row as the workspace's pause
// switch above it, so it reads the same way. Everything comes from /api/admin/instance (src/services/instance.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../auth.tsx";
import { Button, Card, QueryError } from "../../components/ui.tsx";
import { useMe } from "../../queries.ts";

const KEY = ["admin", "instance"] as const;
const usd = (n: number) => `$${n.toFixed(2)}`;

export function InstanceCard() {
  const me = useMe();
  return me.data?.platform_admin ? <Switch /> : null;
}

function Switch() {
  const api = useApi();
  const qc = useQueryClient();
  const state = useQuery({ queryKey: KEY, queryFn: () => api.instance(), refetchInterval: 30_000 });
  const set = useMutation({ mutationFn: (halted: boolean) => api.setInstanceHalted(halted), onSuccess: (data) => qc.setQueryData(KEY, data) });
  const s = state.data;
  return (
    <Card className="flex flex-col items-start gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-6 sm:py-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-[15px]/4.5 font-semibold tracking-[-0.01em] text-ink">{s?.halted ? "New agent runs are stopped everywhere" : "Agent runs are on everywhere"}</h2>
        <p className="text-[13px]/5 font-medium text-muted">
          Stops Autopilot, new agent runs and web reads in every workspace, yours too. Running sessions finish.
          {s ? ` Other workspaces spent ${usd(s.spent_usd)} of ${usd(s.cap_usd)} in the last 24 hours${s.cap_reached ? ", so they wait" : ""}.` : ""}
        </p>
        {set.isError ? <QueryError error={set.error} className="mt-2" /> : null}
      </div>
      {state.isError ? (
        <QueryError error={state.error} what="the instance switch" />
      ) : (
        <Button variant={s?.halted ? "primary" : "outline"} size="md" loading={set.isPending} disabled={!s} onClick={() => set.mutate(!s?.halted)}>
          {s?.halted ? "Resume runs" : "Stop all runs"}
        </Button>
      )}
    </Card>
  );
}
