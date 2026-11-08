// Settings · Team at /app/settings/team (Paper: "Final · Settings · Team"): invite by email, members with their roles,
// pending invites. Everyone can see who is here; owners and admins change things. The buttons follow the role, but the
// API decides (src/services/team.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { isApiError, type InviteRole, type TeamInvite, type TeamMember, type WorkspaceRole } from "../../api.ts";
import { useApi, useSession } from "../../auth.tsx";
import { Page } from "../../components/AppShell.tsx";
import { ChevronDown } from "../../components/icons.tsx";
import { Card, QueryError, Skeleton } from "../../components/ui.tsx";
import { cx, initials, longDate } from "../../lib/format.ts";
import { forgetWorkspace } from "../../lib/workspace.ts";
import { keys, useRole } from "../../queries.ts";
import { CrumbBar } from "../connect/CrumbBar.tsx";
import { SettingsTabs } from "./SettingsTabs.tsx";

const ROLE_LABEL: Record<WorkspaceRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };

const columnLabel = "text-xs/4 font-medium text-faint";
const heading = "pt-4 text-[15px]/4.5 font-medium text-ink";
const smallButton = "inline-flex h-6.75 shrink-0 items-center rounded-md px-2.5 text-xs/4 transition-colors disabled:cursor-default disabled:opacity-60";
const softButton = cx(smallButton, "border border-[#200D0D1A] bg-white font-medium text-ink hover:bg-[#200D0D08]");
const dangerButton = cx(smallButton, "bg-[#D92D20] text-white hover:bg-[#B42318]");

/** What the API said, in its own words: its team errors are written for people. */
const message = (err: unknown) => (isApiError(err) && err.status < 500 ? err.message : "That didn't work. Try again.");

export default function SettingsTeam() {
  const { canManage } = useRole();
  return (
    <>
      <CrumbBar here="Team" parent={{ label: "Settings", to: "/app/settings" }} />
      <Page>
        <div className="flex w-240 max-w-full flex-col gap-4 px-4 pb-14 pt-6 sm:px-12 sm:pt-8">
          <SettingsTabs />
          <h1 className="pb-1 pt-3 text-xl/5.75 font-medium tracking-[-0.01em] text-ink">Team</h1>
          {canManage ? <InviteForm /> : null}
          <h2 className={heading}>Members</h2>
          <Members />
          {canManage ? <PendingInvites /> : null}
        </div>
      </Page>
    </>
  );
}

function InviteForm() {
  const api = useApi();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("member");
  const invite = useMutation({
    mutationFn: () => api.createInvite(email.trim(), role),
    onSuccess: () => {
      setEmail("");
      void qc.invalidateQueries({ queryKey: keys.invites });
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    if (email.trim()) invite.mutate();
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            invite.reset();
          }}
          placeholder="Email address"
          aria-label="Email address to invite"
          className="h-8.75 min-w-0 grow rounded-lg border border-[#200D0D1A] bg-white px-3 text-sm/4.5 font-medium text-ink outline-none placeholder:text-[#200D0D80] focus:border-ink"
        />
        <div className="flex items-center gap-2">
          <RoleSelect label="Role for the invite" value={role} options={["member", "admin"]} onChange={(r) => setRole(r as InviteRole)} size="md" />
          <button type="submit" disabled={invite.isPending || !email.trim()} aria-busy={invite.isPending || undefined} className="flex h-8.75 shrink-0 grow items-center justify-center rounded-lg bg-lime px-5 text-sm/4.5 font-medium text-ink transition-colors hover:bg-[#b3de7a] disabled:cursor-default disabled:opacity-60 sm:grow-0">
            {invite.isPending ? "Sending" : "Invite"}
          </button>
        </div>
      </div>
      {invite.isError ? <RowError>{message(invite.error)}</RowError> : null}
    </form>
  );
}

function RoleSelect({
  label,
  value,
  options,
  onChange,
  disabled,
  size = "sm",
}: {
  label: string;
  value: WorkspaceRole;
  options: readonly WorkspaceRole[];
  onChange: (role: WorkspaceRole) => void;
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <span className={cx("relative inline-flex shrink-0", size === "md" ? "w-28" : "w-24")}>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as WorkspaceRole)}
        className={cx(
          "w-full appearance-none border border-[#200D0D1A] bg-white pr-7 font-medium text-ink outline-none focus:border-ink disabled:opacity-60",
          size === "md" ? "h-8.75 rounded-lg pl-3 text-sm/4.5" : "h-6.75 rounded-md pl-2.5 text-[13px]/4",
        )}
      >
        {options.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABEL[r]}
          </option>
        ))}
      </select>
      <ChevronDown width={12} height={12} aria-hidden className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[rgb(32_13_13/50%)]" />
    </span>
  );
}

const RowError = ({ children }: { children: ReactNode }) => (
  <div role="alert" className="text-[13px]/4.5 font-medium text-[#B42318]">
    {children}
  </div>
);

/** A click that takes effect only on a second one within 4 seconds. */
function useConfirm(): [boolean, () => void, () => void] {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return [armed, () => setArmed(true), () => setArmed(false)];
}

function Members() {
  const api = useApi();
  const { user } = useSession();
  const { role, isOwner, canManage } = useRole();
  const list = useQuery({ queryKey: keys.members, queryFn: () => api.teamMembers() });
  const rows = list.data ?? [];
  const owners = rows.filter((m) => m.role === "owner").length;
  return (
    <Card className="flex flex-col px-4 pb-2 pt-4 sm:px-6 sm:pt-5">
      <div className="flex h-7 items-center border-b border-b-[#200D0D1A]">
        <div className={cx(columnLabel, "grow")}>Name</div>
        <div className={cx(columnLabel, "hidden w-35 shrink-0 sm:block")}>Role</div>
        <div className={cx(columnLabel, "hidden w-30 shrink-0 sm:block")}>Joined</div>
        <div className="hidden w-34 shrink-0 sm:block" />
      </div>
      {list.isPending ? (
        [0, 1].map((i) => (
          <div key={i} className="flex h-14 items-center gap-3 border-t border-t-[#200D0D0F] first:border-t-0">
            <Skeleton className="size-7 !rounded-full" />
            <Skeleton className="h-4.5 w-48" />
          </div>
        ))
      ) : list.isError ? (
        <QueryError error={list.error} what="the team" onRetry={() => void list.refetch()} className="my-3" />
      ) : (
        rows.map((m, i) => (
          <MemberRow
            key={m.user_id}
            member={m}
            you={m.user_id === user?.id}
            last={i === rows.length - 1}
            canManage={canManage}
            isOwner={isOwner}
            canLeave={role !== "owner" || owners > 1}
          />
        ))
      )}
    </Card>
  );
}

function MemberRow({ member: m, you, last, canManage, isOwner, canLeave }: { member: TeamMember; you: boolean; last: boolean; canManage: boolean; isOwner: boolean; canLeave: boolean }) {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.members });
  const change = useMutation({ mutationFn: (role: WorkspaceRole) => api.changeMemberRole(m.user_id, role), onSettled: refresh });
  const remove = useMutation({ mutationFn: () => api.removeMember(m.user_id), onSettled: refresh });
  const leave = useMutation({
    mutationFn: () => api.leaveWorkspace(),
    onSuccess: () => {
      forgetWorkspace();
      window.location.assign("/app");
    },
  });
  const [armedRemove, armRemove] = useConfirm();
  const [armedLeave, armLeave] = useConfirm();
  // An admin can't touch an owner; nobody changes their own role from this row.
  const editable = canManage && !you && (isOwner || m.role !== "owner");
  const error = change.error ?? remove.error ?? leave.error;
  const name = m.name ?? m.email ?? m.user_id;
  return (
    <div className={cx("flex flex-col py-2.5 sm:min-h-14 sm:justify-center sm:py-2", !last && "border-b border-b-[#200D0D1A]")}>
      <div className="flex flex-wrap items-center gap-y-2 sm:flex-nowrap">
        <div className="flex min-w-0 basis-full items-center gap-3 sm:grow sm:basis-0">
          {m.image_url ? (
            <img src={m.image_url} alt="" className="size-7 shrink-0 rounded-full object-cover" />
          ) : (
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-pill text-[11px]/3 font-semibold text-ink">{initials(name, "·")}</span>
          )}
          <div className="flex min-w-0 flex-col gap-px">
            <div className="truncate text-sm/4.5 font-medium text-ink">
              {name}
              {you ? <span className="text-muted"> (you)</span> : null}
            </div>
            {m.email && m.name ? <div className="truncate text-xs/4 font-medium text-faint">{m.email}</div> : null}
          </div>
        </div>
        <div className="w-35 shrink-0 max-sm:w-auto max-sm:pl-10">
          {editable ? (
            <RoleSelect
              label={`Role for ${name}`}
              value={m.role}
              options={isOwner ? ["owner", "admin", "member"] : ["admin", "member"]}
              disabled={change.isPending}
              onChange={(role) => change.mutate(role)}
            />
          ) : (
            <span className="text-[13px]/4 font-medium text-ink">{ROLE_LABEL[m.role]}</span>
          )}
        </div>
        <div className="hidden w-30 shrink-0 text-xs/4 font-medium text-muted sm:block">{longDate(m.joined_at)}</div>
        <div className="flex shrink-0 justify-end max-sm:ml-auto sm:w-34">
          {you && canLeave ? (
            <button type="button" className={softButton} disabled={leave.isPending} onClick={() => (armedLeave ? leave.mutate() : armLeave())}>
              {armedLeave ? "Leave?" : "Leave"}
            </button>
          ) : editable ? (
            <button type="button" className={dangerButton} disabled={remove.isPending} aria-label={armedRemove ? `Confirm removing ${name}` : `Remove ${name}`} onClick={() => (armedRemove ? remove.mutate() : armRemove())}>
              {armedRemove ? "Remove?" : "Remove"}
            </button>
          ) : null}
        </div>
      </div>
      {error ? <RowError>{message(error)}</RowError> : null}
    </div>
  );
}

function PendingInvites() {
  const api = useApi();
  const list = useQuery({ queryKey: keys.invites, queryFn: () => api.teamInvites() });
  const rows = list.data ?? [];
  if (list.isPending || (list.isSuccess && !rows.length)) return null;
  return (
    <>
      <h2 className={heading}>Pending invites</h2>
      <Card className="flex flex-col px-4 pb-2 pt-4 sm:px-6 sm:pt-5">
        <div className="flex h-7 items-center border-b border-b-[#200D0D1A]">
          <div className={cx(columnLabel, "grow")}>Email</div>
          <div className={cx(columnLabel, "hidden w-35 shrink-0 sm:block")}>Role</div>
          <div className={cx(columnLabel, "hidden w-30 shrink-0 sm:block")}>Expires</div>
          <div className="hidden w-34 shrink-0 sm:block" />
        </div>
        {list.isError ? <QueryError error={list.error} what="invites" onRetry={() => void list.refetch()} className="my-3" /> : rows.map((inv, i) => <InviteRow key={inv.id} invite={inv} last={i === rows.length - 1} />)}
      </Card>
    </>
  );
}

function InviteRow({ invite: inv, last }: { invite: TeamInvite; last: boolean }) {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.invites });
  const resend = useMutation({ mutationFn: () => api.resendInvite(inv.id), onSuccess: refresh });
  const revoke = useMutation({ mutationFn: () => api.revokeInvite(inv.id), onSettled: refresh });
  const [armed, arm] = useConfirm();
  const expired = inv.status === "expired";
  const error = resend.error ?? revoke.error;
  return (
    <div className={cx("flex flex-col py-2.5 sm:min-h-14 sm:justify-center sm:py-2", !last && "border-b border-b-[#200D0D1A]")}>
      <div className="flex flex-wrap items-center gap-y-2 sm:flex-nowrap">
        <div className={cx("min-w-0 basis-full truncate text-sm/4.5 font-medium sm:grow sm:basis-0", expired ? "text-faint" : "text-ink")} title={inv.email}>
          {inv.email}
        </div>
        <div className={cx("w-35 shrink-0 text-[13px]/4 font-medium max-sm:w-auto", expired ? "text-faint" : "text-ink")}>{ROLE_LABEL[inv.role]}</div>
        <div className="hidden w-30 shrink-0 text-xs/4 font-medium text-muted sm:block">
          {expired ? <span className="inline-flex h-5 items-center rounded-full bg-pill px-2 text-[11px]/3.5 font-semibold text-[#200D0DB3]">Expired</span> : longDate(inv.expires_at)}
        </div>
        <div className="flex shrink-0 justify-end gap-2 max-sm:ml-auto sm:w-34">
          <button type="button" className={softButton} disabled={resend.isPending || resend.isSuccess} onClick={() => resend.mutate()}>
            {resend.isSuccess ? "Sent" : "Resend"}
          </button>
          <button type="button" className={dangerButton} disabled={revoke.isPending} aria-label={armed ? `Confirm revoking the invite to ${inv.email}` : `Revoke the invite to ${inv.email}`} onClick={() => (armed ? revoke.mutate() : arm())}>
            {armed ? "Revoke?" : "Revoke"}
          </button>
        </div>
      </div>
      {error ? <RowError>{message(error)}</RowError> : null}
    </div>
  );
}
