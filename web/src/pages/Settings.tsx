// Settings · General: the global pause, the do-not-contact list and the account. No Paper artboard of its own;
// uses the card and form styles of the Integrations and Connect screens, and the crumb bar and tabs of
// "Settings · Billing" (pages/settings/Billing.tsx).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useApi, useSession } from "../auth.tsx";
import { Page } from "../components/AppShell.tsx";
import { Button, Card, EmptyState, QueryError, Skeleton } from "../components/ui.tsx";
import { cx, longDate } from "../lib/format.ts";
import { keys, usePause, useProfile, useSetPause } from "../queries.ts";
import { CrumbBar } from "./connect/CrumbBar.tsx";
import { SettingsTabs } from "./settings/SettingsTabs.tsx";

const cardTitle = "text-[15px]/4.5 font-semibold tracking-[-0.01em] text-ink";
const muted = "text-[13px]/5 font-medium text-[#200D0D99]";

export default function Settings() {
  return (
    <>
      <CrumbBar here="Settings" />
      <Page>
        <div className="flex w-240 max-w-full flex-col gap-4 px-12 pb-14 pt-8">
          <SettingsTabs />
          <div className="flex flex-col gap-2 pb-2 pt-3">
            <h1 className="text-xl/5.75 font-medium tracking-[-0.01em] text-ink">General</h1>
            <p className="text-[13px]/4.5 font-medium text-[#200D0D99]">Workspace controls. Changes apply right away.</p>
          </div>
          <div className="flex flex-col gap-6">
            <PauseCard />
            <ProfileCard />
            <Suppressions />
            <AccountCard />
          </div>
        </div>
      </Page>
    </>
  );
}

function PauseCard() {
  const pause = usePause();
  const setPause = useSetPause();
  const paused = pause.data?.paused ?? false;
  return (
    <Card className="flex items-center justify-between gap-6 px-6 py-5">
      <div className="flex flex-col gap-1">
        <h2 className={cardTitle}>{paused ? "Sends are paused" : "Sends are on"}</h2>
        <p className={muted}>
          Pausing stops every outgoing email (checked again at send time), new research sessions and auto-allowed agent tools. History is kept.
        </p>
      </div>
      {pause.isError ? (
        <QueryError error={pause.error} what="the pause switch" />
      ) : (
        <Button variant={paused ? "primary" : "outline"} size="md" loading={setPause.isPending} disabled={!pause.isSuccess} onClick={() => setPause.mutate(!paused)}>
          {paused ? "Resume sends" : "Pause everything"}
        </Button>
      )}
    </Card>
  );
}

function ProfileCard() {
  const profile = useProfile();
  const p = profile.data;
  return (
    <Card className="flex items-center justify-between gap-6 px-6 py-5">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className={cardTitle}>Ideal customer</h2>
        {profile.isPending ? (
          <Skeleton className="h-4 w-72" />
        ) : p ? (
          <p className={cx(muted, "line-clamp-2")}>{p.icp_description || p.sells}</p>
        ) : (
          <p className={muted}>Not set up yet. Agents use it to find, research and score every lead.</p>
        )}
      </div>
      <Link to={p ? "/onboarding/3" : "/onboarding/1"} className="shrink-0 text-[13px]/4 font-medium text-ink underline decoration-[#200D0D4D] underline-offset-[3px] hover:decoration-ink">
        {p ? "Edit profile" : "Start onboarding"}
      </Link>
    </Card>
  );
}

function Suppressions() {
  const api = useApi();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [email, setEmail] = useState("");
  const list = useQuery({ queryKey: keys.suppressions(q), queryFn: () => api.suppressions({ q: q || undefined, limit: 100 }) });
  const add = useMutation({
    mutationFn: (e: string) => api.addSuppression(e, "manual"),
    onSuccess: () => {
      setEmail("");
      void qc.invalidateQueries({ queryKey: ["suppressions"] });
    },
  });
  const remove = useMutation({
    mutationFn: (e: string) => api.removeSuppression(e),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["suppressions"] }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (email.trim()) add.mutate(email.trim());
  };
  const rows = list.data?.data ?? [];
  return (
    <Card className="flex flex-col overflow-clip">
      <div className="flex flex-col gap-1 px-6 pb-4 pt-5">
        <h2 className={cardTitle}>Do-not-contact list</h2>
        <p className={muted}>Nobody on this list is stored again or emailed, whoever finds them. Unsubscribes and complaints are added automatically.</p>
      </div>
      <div className="flex items-center gap-3 border-t border-t-[#200D0D14] px-6 py-3.5">
        <form onSubmit={submit} className="flex grow items-center gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@company.com"
            aria-label="Email to suppress"
            className="h-9 grow rounded-lg border border-[#200D0D24] px-3 tabular-nums text-[13px]/4 text-ink outline-none placeholder:text-[#200D0D73] focus:border-ink"
          />
          <Button type="submit" variant="outline" size="md" loading={add.isPending} disabled={!email.trim()}>
            Add
          </Button>
        </form>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          aria-label="Search the list"
          className="h-9 w-48 rounded-lg border border-[#200D0D1A] px-3 text-[13px]/4 outline-none placeholder:text-[#200D0D73] focus:border-ink"
        />
      </div>
      {add.isError ? <QueryError className="mx-6 mb-3" error={add.error} /> : null}
      {list.isError ? (
        <QueryError className="mx-6 mb-5" error={list.error} what="the do-not-contact list" onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <div className="border-t border-t-[#200D0D14] px-6 py-4">
          <Skeleton className="h-5 w-64" />
        </div>
      ) : rows.length ? (
        rows.map((r) => (
          <div key={r.email} className="flex items-center gap-4 border-t border-t-[#200D0D0F] px-6 py-3">
            <div className="grow truncate tabular-nums text-[13px]/4 text-ink">{r.email}</div>
            <div className="w-28 text-xs/4 font-medium text-[#200D0D8C]">{r.reason}</div>
            <div className="w-28 text-xs/4 font-medium text-[#200D0D8C]">{longDate(r.created_at)}</div>
            <Button variant="danger" size="sm" onClick={() => window.confirm(`Allow ${r.email} to be contacted again?`) && remove.mutate(r.email)}>
              Remove
            </Button>
          </div>
        ))
      ) : (
        <div className="border-t border-t-[#200D0D14]">
          <EmptyState title={q ? "No matches" : "Nobody on the list yet"} body={q ? undefined : "Add an address above, or let replies add unsubscribes for you."} />
        </div>
      )}
    </Card>
  );
}

function AccountCard() {
  const { user, signOut } = useSession();
  return (
    <Card className="flex items-center justify-between gap-6 px-6 py-5">
      <div className="flex flex-col gap-1">
        <h2 className={cardTitle}>Account</h2>
        <p className={muted}>
          Signed in as <span className="tabular-nums text-ink">{user?.email ?? "—"}</span>
        </p>
      </div>
      <Button variant="soft" size="md" onClick={() => void signOut()}>
        Sign out
      </Button>
    </Card>
  );
}
