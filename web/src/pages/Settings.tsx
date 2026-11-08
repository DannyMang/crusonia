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
import { keys, usePause, useProfile, useRole, useSetPause, useWorkspaces } from "../queries.ts";
import { CrumbBar } from "./connect/CrumbBar.tsx";
import { InstanceCard } from "./settings/InstanceCard.tsx";
import { SettingsTabs } from "./settings/SettingsTabs.tsx";

const cardTitle = "text-[15px]/4.5 font-semibold tracking-[-0.01em] text-ink";
const muted = "text-[13px]/5 font-medium text-muted";
/** Text beside its action from `sm`; phones put the action under the text. */
const rowCard = "flex flex-col items-start gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-6 sm:py-5";

export default function Settings() {
  return (
    <>
      <CrumbBar here="Settings" />
      <Page>
        <div className="flex w-240 max-w-full flex-col gap-4 px-4 pb-14 pt-6 sm:px-12 sm:pt-8">
          <SettingsTabs />
          <div className="flex flex-col gap-2 pb-2 pt-3">
            <h1 className="text-xl/5.75 font-medium tracking-[-0.01em] text-ink">General</h1>
          </div>
          <div className="flex flex-col gap-6">
            <WorkspaceNameCard />
            <PauseCard />
            <InstanceCard />
            <ProfileCard />
            <Suppressions />
            <AccountCard />
          </div>
        </div>
      </Page>
    </>
  );
}

/** Owners and admins name the workspace; it's what the switcher and the invite email show. */
function WorkspaceNameCard() {
  const api = useApi();
  const qc = useQueryClient();
  const { canManage } = useRole();
  const list = useWorkspaces();
  const current = list.data?.data.find((w) => w.id === list.data?.current);
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? current?.name ?? "";
  const rename = useMutation({
    mutationFn: () => api.renameWorkspace(name.trim()),
    onSuccess: () => {
      setDraft(null);
      void qc.invalidateQueries({ queryKey: keys.workspaces });
    },
  });
  if (!canManage || !current) return null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && name.trim() !== current.name) rename.mutate();
  };
  return (
    <Card className={rowCard}>
      <div className="flex shrink-0 flex-col gap-1">
        <h2 className={cardTitle}>Workspace name</h2>
      </div>
      <form onSubmit={submit} className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:grow sm:justify-end">
        <input
          value={name}
          maxLength={80}
          onChange={(e) => {
            setDraft(e.target.value);
            rename.reset();
          }}
          aria-label="Workspace name"
          className="h-9 min-w-0 grow rounded-lg border border-[#200D0D24] px-3 text-[13px]/4 font-medium text-ink outline-none focus:border-ink sm:max-w-72"
        />
        <Button type="submit" variant="outline" size="md" loading={rename.isPending} disabled={!name.trim() || name.trim() === current.name}>
          Save
        </Button>
      </form>
      {rename.isError ? <QueryError error={rename.error} /> : null}
    </Card>
  );
}

function PauseCard() {
  const pause = usePause();
  const setPause = useSetPause();
  const paused = pause.data?.paused ?? false;
  return (
    <Card className={rowCard}>
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
    <Card className={rowCard}>
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
      <div className="flex flex-col gap-1 px-4 pb-4 pt-5 sm:px-6">
        <h2 className={cardTitle}>Do-not-contact list</h2>
        <p className={muted}>Nobody on this list is stored again or emailed, whoever finds them. Unsubscribes and complaints are added automatically.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-t-[#200D0D14] px-4 py-3.5 sm:flex-nowrap sm:px-6">
        <form onSubmit={submit} className="flex min-w-0 grow basis-full items-center gap-2 sm:basis-auto">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@company.com"
            aria-label="Email to suppress"
            className="h-9 min-w-0 grow rounded-lg border border-[#200D0D24] px-3 text-[13px]/4 text-ink outline-none placeholder:text-[#200D0D73] focus:border-ink"
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
          className="h-9 w-full rounded-lg border border-[#200D0D1A] px-3 text-[13px]/4 outline-none placeholder:text-[#200D0D73] focus:border-ink sm:w-48"
        />
      </div>
      {add.isError ? <QueryError className="mx-4 mb-3 sm:mx-6" error={add.error} /> : null}
      {list.isError ? (
        <QueryError className="mx-4 mb-5 sm:mx-6" error={list.error} what="the do-not-contact list" onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <div className="border-t border-t-[#200D0D14] px-4 py-4 sm:px-6">
          <Skeleton className="h-5 w-64 max-w-full" />
        </div>
      ) : rows.length ? (
        rows.map((r) => (
          <div key={r.email} className="flex items-center gap-4 border-t border-t-[#200D0D0F] px-4 py-3 sm:px-6">
            {/* Phones: reason and date go under the address; from `sm` the three sit in one row. */}
            <div className="flex min-w-0 grow flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-4">
              <div className="truncate text-[13px]/4 text-ink sm:grow">{r.email}</div>
              <div className="flex gap-2 sm:contents">
                <div className="text-xs/4 font-medium text-muted sm:w-28">{r.reason}</div>
                <div className="text-xs/4 font-medium text-muted sm:w-28">{longDate(r.created_at)}</div>
              </div>
            </div>
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
    <Card className={rowCard}>
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className={cardTitle}>Account</h2>
        <p className={muted}>
          Signed in as <span className="text-ink">{user?.email ?? "—"}</span>
        </p>
      </div>
      <Button variant="soft" size="md" onClick={() => void signOut()}>
        Sign out
      </Button>
    </Card>
  );
}
