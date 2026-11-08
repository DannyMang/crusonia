// Outreach at /app/outreach (Paper: "Final · Outreach · Approvals" and "Final · Outreach · Tasks"), two tabs:
// - Approvals: what the agent wants to send by email, one exact draft version per request code. Approve & send
//   takes two presses (it emails a real person); Edit saves a new version, which gets a new code and replaces the
//   approval; Reject takes an optional reason. A texted approval shows "iMessage", and with iMessage on the phone
//   panel shows the thread. Tool calls and agent questions open the existing detail views.
// - Tasks: the manual queue (LinkedIn, X, warm intro, own mailbox): copy the text, open the profile, send it
//   yourself, mark it sent or skip it; after sending, record the outcome. Recent replies sit on the right.
// Routes: /app/outreach(/:code) and /app/outreach/tasks(/:id); /app/approvals(/:code) redirects here.
// Keys (Approvals): J / K move, A approve, E edit, R reject.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router";
import type { ApprovalListItem, Reply, Task } from "../api.ts";
import { useApi } from "../auth.tsx";
import { Page } from "../components/AppShell.tsx";
import { QuestionDetail, ToolDetail } from "../components/approvals/AgentDetail.tsx";
import { isTypingTarget, useNow } from "../components/approvals/controls.tsx";
import type { OnDecided } from "../components/approvals/parts.tsx";
import { MailIcon, ThumbUpIcon } from "../components/core-icons.tsx";
import { fitOf } from "../components/leads/core.tsx";
import { Logo } from "../components/icons.tsx";
import { CharCount, CitedBody, channelOf, TaskActions } from "../components/outreach/task.tsx";
import { EmptyState, QueryError, ReplyLabel, Skeleton } from "../components/ui.tsx";
import { clock, cx, shortDate, timeLeft } from "../lib/format.ts";
import { sourceLabel } from "../lib/citations.ts";
import { keys, useApprovals, useReplies, useStatus, useTasks } from "../queries.ts";

type Tab = "approvals" | "tasks";

/** /app/approvals(/:code) from older links, texts and emails. */
export function ApprovalsRedirect() {
  const { code } = useParams();
  return <Navigate to={code ? `/app/outreach/${encodeURIComponent(code)}` : "/app/outreach"} replace />;
}

export default function Outreach() {
  const { pathname } = useLocation();
  const tab: Tab = pathname.startsWith("/app/outreach/tasks") ? "tasks" : "approvals";
  const approvals = useApprovals({ status: "pending" });
  const tasks = useTasks("open");
  const pending = approvals.data?.data.length;
  const open = tasks.data?.open_total ?? tasks.data?.data.length;
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <Page className="gap-5 px-4 pb-14 pt-6 sm:px-8 sm:pt-8">
      <header className="flex h-10 shrink-0 items-center justify-between gap-4">
        <h1 className="text-xl/7 font-semibold tracking-[-0.01em] text-ink">Outreach</h1>
        <div className="flex items-center gap-2">{tab === "approvals" ? <IMessagePill /> : <TasksPill />}</div>
      </header>
      <div className="flex shrink-0 items-end justify-between gap-4 border-b border-b-[#200D0D14]">
        <nav aria-label="Outreach" className="flex items-center gap-6">
          <TabLink to="/app/outreach" active={tab === "approvals"} count={pending}>
            Approvals
          </TabLink>
          <TabLink to="/app/outreach/tasks" active={tab === "tasks"} count={open}>
            Tasks
          </TabLink>
        </nav>
        {tab === "approvals" ? <div className="hidden pb-2.5 text-xs/4 text-muted md:block">J / K move · A approve · E edit · R reject</div> : null}
      </div>
      {tab === "approvals" ? <ApprovalsTab onToast={setToast} /> : <TasksTab onToast={setToast} />}
      {toast ? (
        <div role="status" className="fixed bottom-6 left-[calc(50%+120px)] z-20 flex h-10 -translate-x-1/2 items-center rounded-full bg-ink px-4.5 text-[13px]/4 font-medium text-white shadow-lg">
          {toast}
        </div>
      ) : null}
    </Page>
  );
}

function TabLink({ to, active, count, children }: { to: string; active: boolean; count: number | undefined; children: string }) {
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={cx("-mb-px flex items-center gap-2", active ? "border-b-2 border-b-ink pb-2.25" : "pb-2.5 hover:text-ink")}
    >
      <span className={cx("text-sm/4.5", active ? "font-semibold text-ink" : "font-medium text-muted")}>{children}</span>
      {count !== undefined ? (
        <span className={cx("flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px]/3.5 font-semibold tabular-nums", active ? "bg-ink text-white" : "bg-pill text-ink")}>
          {count}
        </span>
      ) : null}
    </Link>
  );
}

const headerPill = "flex h-8 shrink-0 items-center gap-2 rounded-full border border-[#200D0D1A] px-3 text-[13px]/4 font-medium text-ink";

function IMessagePill() {
  const status = useStatus();
  const im = status.data?.imessage;
  if (!im?.active) return null;
  return (
    <span className={headerPill}>
      <span className={cx("size-1.5 rounded-full", im.bridge?.online === false ? "bg-[#200D0D4D]" : "bg-green")} />
      {im.owner_phone_hint ? `iMessage linked to ${im.owner_phone_hint}` : "iMessage on"}
    </span>
  );
}

function TasksPill() {
  const open = useTasks("open");
  const sent = useTasks("sent");
  if (!open.data) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const sentToday = (sent.data?.data ?? []).filter((t) => t.closed_at && new Date(t.closed_at) >= today).length;
  return (
    <span className={headerPill}>
      <span className="size-1.5 rounded-full bg-green" />
      {open.data.open_total} to send{sentToday ? ` · ${sentToday} sent today` : ""}
    </span>
  );
}

// ---------- approvals ----------

function ApprovalsTab({ onToast }: { onToast: (m: string) => void }) {
  const { code: raw } = useParams();
  const code = raw?.toUpperCase();
  const navigate = useNavigate();
  const now = useNow(1000);
  const status = useStatus();
  const pending = useApprovals({ status: "pending" });
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const items = useMemo(
    () => (pending.data?.data ?? []).filter((a) => !hidden.has(a.code)).sort((x, y) => new Date(x.expires_at).getTime() - new Date(y.expires_at).getTime()),
    [pending.data, hidden],
  );
  const selected = items.find((a) => a.code === code) ?? null;
  const first = items[0]?.code;
  useEffect(() => {
    if (!code && first) navigate(`/app/outreach/${encodeURIComponent(first)}`, { replace: true });
  }, [code, first, navigate]);

  const select = (c: string | undefined) => navigate(c ? `/app/outreach/${encodeURIComponent(c)}` : "/app/outreach", { replace: true });
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const editingRef = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((k !== "j" && k !== "k") || isTypingTarget(e) || editingRef.current) return;
      const list = itemsRef.current;
      const i = list.findIndex((a) => a.code === code);
      const next = list[Math.min(list.length - 1, Math.max(0, i + (k === "j" ? 1 : -1)))];
      if (next && next.code !== code) {
        e.preventDefault();
        select(next.code);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onDecided: OnDecided = (decided, message, replacement) => {
    const list = itemsRef.current;
    const i = list.findIndex((a) => a.code === decided);
    const rest = list.filter((a) => a.code !== decided);
    setHidden((h) => new Set(h).add(decided));
    onToast(message);
    select(replacement ?? (rest[i] ?? rest[i - 1])?.code);
  };

  if (pending.isError) return <QueryError error={pending.error} what="approvals" onRetry={() => void pending.refetch()} />;
  if (pending.isPending) return <CardSkeleton />;
  if (!items.length)
    return (
      <div className="rounded-xl border border-[#200D0D1A]">
        <EmptyState title="Nothing waiting for you" />
      </div>
    );

  const rest = items.filter((a) => a.code !== selected?.code);
  // The phone shows the thread for an approval that was texted to the owner.
  const phone = Boolean(status.data?.imessage?.active) && selected?.kind === "send" && texted(selected);
  return (
    <div className="flex items-start gap-5">
      <div className="flex min-w-0 grow basis-0 flex-col gap-4">
        {selected ? (
          selected.kind === "send" ? (
            <SendCard key={selected.code} a={selected} now={now} onDecided={onDecided} editingRef={editingRef} />
          ) : (
            <div className="flex min-h-100 flex-col overflow-clip rounded-xl border border-[#200D0D1A]">
              {selected.kind === "tool" ? <ToolDetail a={selected} now={now} onDecided={onDecided} /> : <QuestionDetail a={selected} now={now} onDecided={onDecided} />}
            </div>
          )
        ) : code ? (
          <div className="rounded-xl border border-[#200D0D1A]">
            <EmptyState title={`${code} is no longer waiting`} action={<Link to="/app/outreach" className="text-[13px]/4 font-medium text-ink underline underline-offset-2">Open the next one</Link>} />
          </div>
        ) : null}
        {rest.length ? (
          <ul aria-label="Also waiting" className="flex flex-col overflow-clip rounded-xl border border-[#200D0D1A]">
            {rest.map((a, i) => (
              <li key={a.code} className={cx(i > 0 && "border-t border-t-[#200D0D14]")}>
                <Link to={`/app/outreach/${encodeURIComponent(a.code)}`} replace className="flex h-12 items-center gap-3 px-4 hover:bg-[#200D0D05]">
                  <span className="min-w-0 grow basis-0 truncate text-[13px]/4 font-medium text-ink">
                    {who(a)}
                    {a.lead?.company && a.lead.name ? <span className="font-normal text-muted"> · {a.lead.company}</span> : null}
                  </span>
                  <span className="shrink-0 text-xs/4 tabular-nums text-muted">
                    {a.code} · {texted(a) ? "iMessage" : a.kind === "send" ? `expires in ${timeLeft(a.expires_at, now)}` : a.kind === "tool" ? "Tool call" : "Question"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {phone && selected ? <PhonePanel a={selected} /> : null}
    </div>
  );
}

const who = (a: ApprovalListItem) => a.lead?.name ?? a.lead?.company ?? a.recipient ?? a.lead?.email ?? "Agent";
const texted = (a: ApprovalListItem) => Boolean(a.texted_at) || a.decided_via === "imessage";

function SendCard({ a, now, onDecided, editingRef }: { a: ApprovalListItem; now: number; onDecided: OnDecided; editingRef: { current: boolean } }) {
  const api = useApi();
  const qc = useQueryClient();
  const draft = a.draft;
  const [mode, setMode] = useState<"view" | "edit" | "reject">("view");
  const [armed, setArmed] = useState(false);
  const [subject, setSubject] = useState(draft?.subject ?? "");
  const [body, setBody] = useState(draft?.body ?? "");
  const [reason, setReason] = useState("");
  editingRef.current = mode !== "view";
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["approvals"] });
    void qc.invalidateQueries({ queryKey: keys.summary });
    if (a.lead_id) void qc.invalidateQueries({ queryKey: keys.lead(a.lead_id) });
  };
  const approve = useMutation({
    mutationFn: () => api.approve(a.code),
    onSuccess: () => {
      invalidate();
      onDecided(a.code, `Approved ${a.code}. Sending to ${a.recipient ?? who(a)}`);
    },
    onSettled: () => setArmed(false),
  });
  const reject = useMutation({
    mutationFn: () => api.reject(a.code, reason.trim() || undefined),
    onSuccess: () => {
      invalidate();
      onDecided(a.code, `Rejected ${a.code}`);
    },
  });
  const edit = useMutation({
    mutationFn: () => api.editApproval(a.code, { subject, body }),
    onSuccess: (res) => {
      invalidate();
      onDecided(a.code, `Saved as version ${res.draft?.version ?? (draft?.version ?? 1) + 1} · new code ${res.approval.code}`, res.approval.code);
    },
  });
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);

  const busy = approve.isPending || reject.isPending || edit.isPending;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && mode !== "view") {
        e.preventDefault();
        setMode("view");
        return;
      }
      if (isTypingTarget(e) || mode !== "view" || busy) return;
      const k = e.key.toLowerCase();
      if (k === "a") armed ? approve.mutate() : setArmed(true);
      else if (k === "e") startEdit();
      else if (k === "r") setMode("reject");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const startEdit = () => {
    setSubject(draft?.subject ?? "");
    setBody(draft?.body ?? "");
    setMode("edit");
  };
  const changed = subject !== (draft?.subject ?? "") || body !== (draft?.body ?? "");
  const next = (draft?.version ?? 1) + 1;
  const urgent = new Date(a.expires_at).getTime() - now < 15 * 60_000;

  return (
    <article aria-label={`Approval ${a.code}`} className="flex flex-col overflow-clip rounded-xl border border-[#200D0D1A]">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-4">
        <h2 className="min-w-0 truncate text-base/5 font-semibold text-ink">
          {who(a)}
          {a.lead?.company && a.lead.name ? <span className="font-[450] text-muted"> · {a.lead.company}</span> : null}
        </h2>
        <div className="flex shrink-0 items-center gap-1.5">
          {texted(a) ? <span className="flex h-6 items-center rounded-full bg-pill px-2.25 text-xs/4 font-medium text-ink">iMessage</span> : null}
          {draft ? <span className="flex h-6 items-center rounded-md border border-[#200D0D1A] px-2.25 text-xs/4 font-medium tabular-nums text-ink">v{draft.version}</span> : null}
          <span className="flex h-6 items-center rounded-md border border-[#200D0D1A] px-2.25 text-xs/4 font-medium tabular-nums text-ink">Code {a.code}</span>
          <span className={cx("flex h-6 items-center rounded-full bg-pill px-2.25 text-xs/4 font-medium tabular-nums", urgent ? "text-[#B42318]" : "text-ink")}>
            expires in {timeLeft(a.expires_at, now)}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-y border-y-panel-line bg-panel px-5 py-2.5">
        <span className="flex items-center gap-1.5 text-[13px]/4 font-medium text-ink">
          <MailIcon />
          Email via AgentMail
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[13px]/4 text-ink">
          <span className={cx("size-1.5 shrink-0 rounded-full", a.lead?.has_consent === false ? "bg-[#B42318]" : "bg-green")} />
          <span className="truncate">{a.lead?.has_consent === false ? "No consent on file" : `Opted in${a.recipient ? ` · ${a.recipient}` : ""}`}</span>
        </span>
      </div>
      {mode === "edit" ? (
        <form
          id={`edit-${a.code}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (changed && !edit.isPending) edit.mutate();
          }}
          className="flex flex-col gap-3 px-5 py-4.5"
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-xs/4 font-medium text-muted">Subject</span>
            <input
              autoFocus
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="h-9 rounded-lg border border-[#200D0D33] px-3 text-sm/5 font-semibold text-ink outline-none focus:border-ink"
            />
          </label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            aria-label="Body"
            rows={Math.min(18, Math.max(8, body.split("\n").length + 2))}
            className="resize-y rounded-[10px] border border-[#200D0D33] px-3.5 py-3 text-sm/5.5 text-ink outline-none focus:shadow-[0_0_0_3px_#BDE68966]"
          />
        </form>
      ) : (
        <div className="flex flex-col gap-3 px-5 py-4.5">
          <p className="text-sm/5 text-ink">
            <span className="text-muted">Subject</span> <span className="font-semibold">{draft?.subject ?? a.summary}</span>
          </p>
          {draft ? <p className="whitespace-pre-wrap text-sm/5.5 text-ink [overflow-wrap:anywhere]">{draft.body}</p> : null}
        </div>
      )}
      {mode === "reject" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            reject.mutate();
          }}
          className="flex items-center gap-2 border-t border-t-[#200D0D14] px-5 py-3.5"
        >
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why? (optional)"
            aria-label="Why reject?"
            maxLength={2000}
            className="h-9.5 min-w-0 grow rounded-lg border border-[#200D0D33] px-3 text-[13px]/4 text-ink outline-none placeholder:text-[#200D0D73] focus:border-ink"
          />
          <ActionPill tone="danger" type="submit" disabled={reject.isPending}>
            {reject.isPending ? "Rejecting…" : "Reject"}
          </ActionPill>
          <ActionPill tone="quiet" onClick={() => setMode("view")}>
            Cancel
          </ActionPill>
        </form>
      ) : (
        <div className="flex items-center gap-2 border-t border-t-[#200D0D14] px-5 py-3.5">
          {mode === "edit" ? (
            <>
              <ActionPill tone="primary" type="submit" form={`edit-${a.code}`} disabled={!changed || edit.isPending}>
                {edit.isPending ? "Saving…" : `Save as version ${next}`}
              </ActionPill>
              <ActionPill tone="quiet" onClick={() => setMode("view")}>
                Cancel
              </ActionPill>
            </>
          ) : (
            <>
              <ActionPill tone={armed ? "ink" : "primary"} onClick={() => (armed ? approve.mutate() : setArmed(true))} disabled={busy || !draft || a.lead?.has_consent === false}>
                {approve.isPending ? "Sending…" : armed ? "Send now?" : "Approve & send"}
              </ActionPill>
              <ActionPill tone="outline" onClick={startEdit} disabled={busy || !draft}>
                Edit
              </ActionPill>
              <ActionPill tone="danger" onClick={() => setMode("reject")} disabled={busy}>
                Reject
              </ActionPill>
            </>
          )}
        </div>
      )}
      {approve.isError || reject.isError || edit.isError ? <QueryError error={approve.error ?? reject.error ?? edit.error} what="this approval" className="mx-5 mb-4" /> : null}
    </article>
  );
}

function ActionPill({
  tone,
  children,
  ...rest
}: { tone: "primary" | "outline" | "danger" | "quiet" | "ink"; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        "flex h-9.5 shrink-0 items-center rounded-full px-4 text-sm/4.5 transition-colors disabled:opacity-50",
        tone === "primary" && "bg-lime px-4.5 font-semibold text-ink hover:bg-[#b3de7a]",
        tone === "ink" && "bg-ink px-4.5 font-semibold text-white hover:bg-[#3A2424]",
        tone === "outline" && "border border-ink font-medium text-ink hover:bg-[#200D0D08]",
        tone === "danger" && "border border-[#200D0D1A] font-medium text-[#B42318] hover:bg-[#FDECEB]",
        tone === "quiet" && "px-3 font-medium text-muted hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

/** The approval as it reads on the owner's phone (iMessage through Photon): the notice, the draft, and a decision made by text. */
function PhonePanel({ a }: { a: ApprovalListItem }) {
  const draft = a.draft;
  const at = a.texted_at ?? a.created_at;
  const preview = draft ? (draft.body.length > 150 ? `${draft.body.slice(0, 150).trimEnd()}…` : draft.body) : null;
  const byText = a.decided_via === "imessage";
  return (
    <aside aria-label="iMessage" className="hidden h-185 w-90 shrink-0 flex-col rounded-[56px] bg-[#1B1B1D] p-2.5 xl:flex">
      <div className="flex min-h-0 grow basis-0 flex-col overflow-clip rounded-[46px] bg-white">
        <div className="flex flex-col items-center gap-1 border-b border-b-[#E5E5EA] bg-[#F9F9F9] px-4 pb-2.5 pt-10">
          <span className="flex size-11 items-center justify-center rounded-full bg-lime">
            <Logo size={28} />
          </span>
          <span className="text-xs/3.5 font-medium text-black">Crusonia</span>
        </div>
        <div className="flex min-h-0 grow basis-0 flex-col gap-1.5 overflow-y-auto px-3 pb-2.5 pt-3.5">
          <span className="self-center pb-1 text-[11px]/3.5 font-medium text-[#6C6C70]">
            iMessage · {shortDate(at)} {clock(at)}
          </span>
          <Bubble>
            Draft for {who(a)}
            {a.lead?.company && a.lead.name ? ` at ${a.lead.company}` : ""}. {a.lead?.has_consent ? "Opted in. " : ""}Code {a.code}.
          </Bubble>
          {draft ? (
            <Bubble className="relative flex flex-col gap-1.5">
              <span className="text-xs/4 font-semibold text-[#3C3C43]">Subject: {draft.subject}</span>
              <span>{preview}</span>
              {byText && a.status === "approved" ? (
                <span className="absolute -right-3 -top-3.5 flex size-8 items-center justify-center rounded-full border-2 border-white bg-ink text-white">
                  <ThumbUpIcon size={15} />
                </span>
              ) : null}
            </Bubble>
          ) : null}
          <Bubble>Thumbs up to send, thumbs down to reject.</Bubble>
          {byText ? <Bubble>{a.status === "approved" ? `Approved ${a.code}.` : a.status === "rejected" ? `Rejected ${a.code}.` : `Answered ${a.code}.`}</Bubble> : null}
        </div>
      </div>
    </aside>
  );
}

function Bubble({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("max-w-64.5 self-start rounded-[18px] bg-[#E9E9EB] px-3 py-2 text-sm/4.75 text-black [overflow-wrap:anywhere]", className)}>{children}</div>;
}

// ---------- tasks ----------

function TasksTab({ onToast }: { onToast: (m: string) => void }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const open = useTasks("open");
  const sent = useTasks("sent");
  const replies = useReplies({ limit: 5 });
  const openList = open.data?.data ?? [];
  const weekAgo = Date.now() - 7 * 86_400_000;
  const sentList = (sent.data?.data ?? []).filter((t) => !t.closed_at || new Date(t.closed_at).getTime() >= weekAgo);
  const all = [...openList, ...sentList];
  const selected = all.find((t) => t.id === id) ?? null;
  const first = openList[0]?.id ?? sentList[0]?.id;
  useEffect(() => {
    if (!id && first) navigate(`/app/outreach/tasks/${encodeURIComponent(first)}`, { replace: true });
  }, [id, first, navigate]);

  const afterDone = (message: string) => {
    onToast(message);
    const rest = openList.filter((t) => t.id !== selected?.id);
    const i = openList.findIndex((t) => t.id === selected?.id);
    const next = rest[i] ?? rest[i - 1];
    navigate(next ? `/app/outreach/tasks/${encodeURIComponent(next.id)}` : "/app/outreach/tasks", { replace: true });
  };

  if (open.isError) return <QueryError error={open.error} what="tasks" onRetry={() => void open.refetch()} />;
  if (open.isPending) return <CardSkeleton />;

  return (
    <div className="flex flex-col items-start gap-5 xl:flex-row">
      <div className="flex w-full min-w-0 grow basis-0 flex-col items-start gap-5 lg:flex-row">
        <nav aria-label="Tasks" className="flex w-full shrink-0 flex-col overflow-clip rounded-xl border border-[#200D0D1A] lg:w-70">
          <ListHead label="To send" count={openList.length} />
          {openList.length ? (
            openList.map((t) => <TaskRow key={t.id} t={t} selected={t.id === selected?.id} />)
          ) : (
            <div className="border-b border-b-[#200D0D14] px-3.5 py-4 text-[13px]/4 font-medium text-muted">Nothing to send</div>
          )}
          {sentList.length ? (
            <>
              <ListHead label="Sent, waiting" count={sentList.length} />
              {sentList.map((t) => (
                <TaskRow key={t.id} t={t} selected={t.id === selected?.id} />
              ))}
            </>
          ) : null}
        </nav>
        {selected ? <TaskDetail key={selected.id} t={selected} onDone={afterDone} /> : openList.length || sentList.length ? null : (
          <div className="w-full min-w-0 grow basis-0 rounded-xl border border-[#200D0D1A]">
            <EmptyState title="No tasks" />
          </div>
        )}
      </div>
      <RepliesColumn replies={replies.data?.data} loading={replies.isPending} />
    </div>
  );
}

function ListHead({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between border-b border-b-[#200D0D14] bg-[#200D0D06] px-3.5 text-xs/4">
      <span className="font-medium text-muted">{label}</span>
      <span className="tabular-nums text-muted">{count}</span>
    </div>
  );
}

const taskWho = (t: Task) => [t.lead.name, t.lead.company].filter(Boolean).join(" · ") || t.lead.domain || "Lead";

function TaskRow({ t, selected }: { t: Task; selected: boolean }) {
  const sent = t.status === "sent";
  const fit = t.lead.score !== null ? fitOf({ score: t.lead.score, qualified: null }).label : null;
  const sub = sent ? `${channelOf(t.channel).short} · sent ${t.closed_at ? shortDate(t.closed_at) : ""}` : !t.lead.name && t.channel === "intro" ? "No contact yet" : [channelOf(t.channel).short, fit].filter(Boolean).join(" · ");
  return (
    <Link
      to={`/app/outreach/tasks/${encodeURIComponent(t.id)}`}
      replace
      aria-current={selected ? "true" : undefined}
      className={cx(
        "flex flex-col gap-0.75 border-b py-3",
        selected ? "border-b-panel-line border-l-[3px] border-l-ink bg-panel pl-2.75 pr-3.5" : "border-b-[#200D0D14] px-3.5 hover:bg-[#200D0D05]",
      )}
    >
      <span className={cx("truncate text-[13px]/4", selected ? "font-semibold text-ink" : sent ? "font-medium text-muted" : "font-medium text-ink")}>{taskWho(t)}</span>
      <span className="truncate text-xs/4 text-muted">{sub}</span>
    </Link>
  );
}

const OUTCOMES = [
  { stage: "replied", label: "Replied" },
  { stage: "interested", label: "Interested" },
  { stage: "not_interested", label: "Not interested" },
] as const;

function TaskDetail({ t, onDone }: { t: Task; onDone: (m: string) => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const name = t.lead.name ?? t.lead.company ?? "the lead";
  const ch = channelOf(t.channel);
  const cite = t.citations[0];
  const outcome = useMutation({
    mutationFn: (stage: (typeof OUTCOMES)[number]["stage"]) => api.patchLead(t.lead_id, { stage }),
    onSuccess: (_r, stage) => {
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      void qc.invalidateQueries({ queryKey: keys.lead(t.lead_id) });
      void qc.invalidateQueries({ queryKey: ["leads"] });
      void qc.invalidateQueries({ queryKey: keys.summary });
      t.lead.stage = stage;
    },
  });
  const current = outcome.variables ?? t.lead.stage;
  return (
    <article aria-label={`${ch.label} to ${name}`} className="flex w-full min-w-0 grow basis-0 flex-col overflow-clip rounded-xl border border-[#200D0D1A]">
      <div className="flex flex-col gap-1 px-5 py-4">
        <h2 className="text-base/5 font-semibold text-ink">
          {ch.label} to {name}
        </h2>
        <p className="text-[13px]/4.5 text-muted">
          <Link to={`/app/leads/${encodeURIComponent(t.lead_id)}`} className="hover:text-ink hover:underline">
            {[t.lead.title, t.lead.name ? t.lead.company : null].filter(Boolean).join(", ") || t.lead.domain}
          </Link>
        </p>
      </div>
      {cite ? (
        <div className="flex min-w-0 items-center gap-2.5 border-y border-y-panel-line bg-panel px-5 py-2.5">
          <span className="flex h-6 min-w-0 shrink items-center truncate rounded-full border border-panel-line bg-white px-2.25 text-xs/4 font-medium text-ink">
            <span className="truncate">{cite.text.charAt(0).toUpperCase() + cite.text.slice(1)}</span>
          </span>
          <a href={cite.source_url} target="_blank" rel="noopener noreferrer nofollow" className="shrink-0 truncate text-xs/4 text-muted hover:text-ink">
            {sourceLabel(cite.source_url)}
          </a>
        </div>
      ) : null}
      <div className={cx("flex flex-col gap-2.5 px-5 py-4.5", !cite && "border-t border-t-[#200D0D14]")}>
        <div className="rounded-[10px] border border-[#200D0D1A] px-4 py-3.5">
          {t.channel === "email_manual" && t.subject ? <p className="pb-2 text-sm/5 font-semibold text-ink">{t.subject}</p> : null}
          <CitedBody body={t.body} citations={t.citations} className="text-sm/5.5 text-ink" />
        </div>
        <CharCount task={t} />
      </div>
      <div className="border-t border-t-[#200D0D14] px-5 py-3.5">
        <TaskActions task={t} onDone={onDone} />
      </div>
      {t.status === "sent" ? (
        <div className="flex flex-col gap-2 border-t border-t-[#200D0D14] px-5 pb-4.5 pt-3.5">
          <h3 className="text-xs/4 font-medium text-muted">Outcome</h3>
          <div className="flex flex-wrap gap-1.5">
            {OUTCOMES.map((o) => (
              <button
                key={o.stage}
                type="button"
                aria-pressed={current === o.stage}
                disabled={outcome.isPending}
                onClick={() => outcome.mutate(o.stage)}
                className={cx(
                  "flex h-7 items-center rounded-full px-3 text-xs/4 font-medium disabled:opacity-60",
                  current === o.stage ? "bg-lime text-ink" : "border border-[#200D0D1A] text-ink hover:bg-[#200D0D08]",
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
          {outcome.isError ? <QueryError error={outcome.error} what="the outcome" /> : null}
        </div>
      ) : null}
    </article>
  );
}

function RepliesColumn({ replies, loading }: { replies: Reply[] | undefined; loading: boolean }) {
  const pending = useApprovals({ status: "pending" });
  const waiting = new Set((pending.data?.data ?? []).map((a) => a.lead_id).filter(Boolean));
  return (
    <aside aria-label="Replies" className="flex w-full shrink-0 flex-col gap-3 xl:w-75">
      <div className="flex items-baseline justify-between px-0.5 pt-0.5">
        <h2 className="text-[15px]/4.5 font-medium text-ink">Replies</h2>
        <Link to="/app/replies" className="text-xs/4 font-medium text-muted hover:text-ink">
          All
        </Link>
      </div>
      {loading ? (
        <Skeleton className="h-24 w-full rounded-xl" />
      ) : !replies?.length ? (
        <div className="rounded-xl border border-[#200D0D1A] px-4 py-3.5 text-[13px]/4.5 font-medium text-muted">No replies yet</div>
      ) : (
        replies.slice(0, 4).map((r) => (
          <Link key={r.id} to={r.lead_id ? `/app/leads/${encodeURIComponent(r.lead_id)}` : "/app/replies"} className="flex flex-col gap-2 rounded-xl border border-[#200D0D1A] px-4 py-3.5 hover:bg-[#200D0D05]">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[13px]/4 font-semibold text-ink">{[r.lead?.name, r.lead?.company].filter(Boolean).join(" · ") || r.from}</span>
              <ReplyLabel label={r.label} />
            </div>
            <p className="line-clamp-3 text-[13px]/4.75 text-ink">&ldquo;{r.preview}&rdquo;</p>
            {r.lead_id && waiting.has(r.lead_id) ? <span className="text-xs/4.25 text-muted">Reply waiting for approval</span> : null}
          </Link>
        ))
      )}
    </aside>
  );
}

function CardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[#200D0D1A] px-5 py-4.5">
      <Skeleton className="h-5 w-56" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  );
}
