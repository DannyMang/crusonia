// Review at /app/leads/review(/:id) (Paper: "Final · Research · Review queue"). The queue is every lead the agent
// sent for review (stage needs_review, with its reason) and every open agent question (answered right in the
// queue). The focus pane holds the agent's summary with numbered sources, Links & contacts, the decision (Confirm
// fit / Not a fit with a reason saved as a note / Fix a fact), notes, and what the agent did with its full trace.
// Keys: J / K move, F fit, N not a fit (then 1-5 pick the reason), E fix a fact.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { ApprovalListItem, Lead, LeadFull } from "../../api.ts";
import { useApi } from "../../auth.tsx";
import { Page } from "../../components/AppShell.tsx";
import { isTypingTarget } from "../../components/approvals/controls.tsx";
import { questionOf } from "../../components/approvals/model.ts";
import { AgentSteps } from "../../components/leads/AgentSteps.tsx";
import { CitedText, LinksAndContacts, NoteComposer, NoteList, SourceRows } from "../../components/leads/core.tsx";
import { EmptyState, QueryError, Skeleton } from "../../components/ui.tsx";
import { cx, timeLeft } from "../../lib/format.ts";
import { keys, useApprovals, useInvalidateLead, useLead, useLeads } from "../../queries.ts";

const REASONS = ["Too late a stage", "Too big", "Not software", "Has a sales team already"] as const;

type Item = { id: string; lead: Lead | null; question: ApprovalListItem | null; at: number };

export default function Review() {
  const { id } = useParams();
  const navigate = useNavigate();
  const leads = useLeads({ stage: "needs_review", limit: 100 });
  const questions = useApprovals({ status: "pending", kind: "question" });
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());

  const items = useMemo(() => {
    const byId = new Map<string, Item>();
    for (const l of leads.data?.data ?? []) byId.set(l.id, { id: l.id, lead: l, question: null, at: new Date(l.updated_at).getTime() });
    for (const q of questions.data?.data ?? []) {
      const key = q.lead_id ?? `q:${q.code}`;
      const prev = byId.get(key);
      byId.set(key, { id: key, lead: prev?.lead ?? null, question: q, at: Math.max(prev?.at ?? 0, new Date(q.created_at).getTime()) });
    }
    return [...byId.values()].filter((i) => !hidden.has(i.id)).sort((a, b) => b.at - a.at);
  }, [leads.data, questions.data, hidden]);

  const selected = items.find((i) => i.id === id) ?? null;
  const first = items[0]?.id;
  useEffect(() => {
    if (!id && first) navigate(`/app/leads/review/${encodeURIComponent(first)}`, { replace: true });
  }, [id, first, navigate]);

  const go = (next: string | undefined) => navigate(next ? `/app/leads/review/${encodeURIComponent(next)}` : "/app/leads/review", { replace: true });
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const move = (delta: number) => {
    const list = itemsRef.current;
    const i = list.findIndex((x) => x.id === id);
    const next = list[Math.min(list.length - 1, Math.max(0, i + delta))];
    if (next && next.id !== id) go(next.id);
  };
  const done = (leadId: string) => {
    const list = itemsRef.current;
    const i = list.findIndex((x) => x.id === leadId);
    const rest = list.filter((x) => x.id !== leadId);
    setHidden((h) => new Set(h).add(leadId));
    go((rest[i] ?? rest[i - 1])?.id);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "j" || k === "k") {
        e.preventDefault();
        move(k === "j" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const loading = leads.isPending || questions.isPending;
  const error = leads.error ?? questions.error;

  return (
    <Page className="gap-6 px-4 pb-14 pt-6 sm:px-8 sm:pt-8">
      <header className="flex h-10 shrink-0 items-center justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl/7 font-semibold tracking-[-0.01em] text-ink">Review</h1>
          {!loading ? <span className="text-sm/4.5 font-[450] text-muted">{items.length === 1 ? "1 lead" : `${items.length} leads`}</span> : null}
        </div>
        <div className="hidden items-center gap-3 md:flex" aria-hidden>
          {(
            [
              ["J K", "move"],
              ["F", "fit"],
              ["N", "not a fit"],
              ["E", "fix a fact"],
            ] as const
          ).map(([k, label]) => (
            <span key={k} className="flex items-center gap-1.5">
              <kbd className="flex h-5 items-center rounded-sm border border-[#200D0D26] px-1.5 font-sans text-[11px]/3.5 font-semibold text-ink">{k}</kbd>
              <span className="text-xs/4 text-muted">{label}</span>
            </span>
          ))}
        </div>
      </header>

      {error ? (
        <QueryError error={error} what="the review queue" onRetry={() => void leads.refetch()} />
      ) : !loading && !items.length ? (
        <div className="rounded-xl border border-[#200D0D1A]">
          <EmptyState title="Nothing to review" />
        </div>
      ) : (
        <div className="flex flex-col items-start gap-5 lg:flex-row">
          <Queue items={items} selectedId={selected?.id} loading={loading} />
          {selected?.lead || selected?.question?.lead_id ? (
            <Focus key={selected.id} leadId={selected.lead?.id ?? selected.question!.lead_id!} onDone={done} />
          ) : selected ? (
            <div className="w-full min-w-0 grow basis-0 rounded-xl border border-[#200D0D1A]">
              <EmptyState title="Answer it in the queue" />
            </div>
          ) : loading ? (
            <FocusSkeleton />
          ) : null}
        </div>
      )}
    </Page>
  );
}

// ---------- queue ----------

function Queue({ items, selectedId, loading }: { items: Item[]; selectedId: string | undefined; loading: boolean }) {
  return (
    <nav aria-label="Needs you" className="flex w-full shrink-0 flex-col overflow-clip rounded-xl border border-[#200D0D1A] lg:w-95">
      <div className="flex h-9 shrink-0 items-center bg-[#200D0D06] px-4 text-xs/4 font-medium text-muted">Needs you</div>
      {loading ? (
        <div className="flex flex-col gap-2 border-t border-t-[#200D0D14] px-4 py-3.5">
          <Skeleton className="h-4.5 w-32" />
          <Skeleton className="h-5.5 w-24" />
        </div>
      ) : (
        items.map((item) => <QueueItem key={item.id} item={item} selected={item.id === selectedId} />)
      )}
    </nav>
  );
}

function QueueItem({ item, selected }: { item: Item; selected: boolean }) {
  const { lead, question } = item;
  const name = lead?.company ?? question?.lead?.company ?? lead?.domain ?? question?.lead?.name ?? "Agent question";
  const who = lead ? (lead.name ? [lead.name, lead.title].filter(Boolean).join(" · ") : "No contact yet") : null;
  const reason = lead?.stage === "needs_review" ? lead.review_question : null;
  return (
    <div
      className={cx(
        "flex flex-col gap-1.5 border-t border-t-[#200D0D14] py-3.5",
        selected ? "border-l-[3px] border-l-ink bg-panel pl-3.25 pr-4" : "px-4 hover:bg-[#200D0D05]",
      )}
    >
      <Link to={`/app/leads/review/${encodeURIComponent(item.id)}`} replace aria-current={selected ? "true" : undefined} className="flex items-center justify-between gap-3">
        <span className="truncate text-sm/4.5 font-medium text-ink">{name}</span>
        {question ? (
          <span className="shrink-0 text-xs/4 text-muted">expires in {timeLeft(question.expires_at)}</span>
        ) : who ? (
          <span className="shrink-0 truncate text-xs/4 text-muted">{who}</span>
        ) : null}
      </Link>
      {reason ? (
        <div className="flex gap-1.5">
          <ReasonChip reason={reason} />
        </div>
      ) : null}
      {question ? <QuestionInline q={question} /> : null}
    </div>
  );
}

/** "stale: …" reads dashed (the design's softer chip); everything else is an ink outline. */
function ReasonChip({ reason }: { reason: string }) {
  const stale = /^stale\b/i.test(reason);
  return (
    <span
      className={cx(
        "inline-flex h-5.5 max-w-full items-center truncate rounded-full px-2.25 text-xs/4 font-medium text-ink",
        stale ? "border border-dashed border-[#200D0D59]" : "border border-ink",
      )}
      title={reason}
    >
      <span className="truncate">{reason}</span>
    </span>
  );
}

/** An agent question with one multiple-choice field is answered with one press; anything else opens in Outreach. */
function QuestionInline({ q }: { q: ApprovalListItem }) {
  const api = useApi();
  const qc = useQueryClient();
  const { prompt, fields } = questionOf(q);
  const field = fields.length === 1 && fields[0]!.options.length ? fields[0]! : null;
  const answer = useMutation({
    mutationFn: (option: string) => api.answer(q.code, { answers: { [field!.key]: field!.multiple ? [option] : option } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["approvals"] }),
  });
  return (
    <>
      <div className="flex gap-1.5">
        <span className="inline-flex h-5.5 items-center rounded-full bg-lime px-2.25 text-xs/4 font-medium text-ink">agent asks</span>
      </div>
      <p className="text-[13px]/4.5 font-[450] text-ink [overflow-wrap:anywhere]">{prompt || q.summary}</p>
      {field ? (
        <div className="flex flex-wrap gap-1.5">
          {field.options.map((o) => (
            <button
              key={o}
              type="button"
              disabled={answer.isPending}
              onClick={() => answer.mutate(o)}
              className={cx(
                "flex h-7 items-center rounded-full border border-ink px-3 text-xs/4 font-medium disabled:opacity-60",
                answer.variables === o ? "bg-ink text-white" : "bg-white text-ink hover:bg-[#200D0D08]",
              )}
            >
              {o}
            </button>
          ))}
        </div>
      ) : (
        <Link to={`/app/outreach/${encodeURIComponent(q.code)}`} className="w-fit text-xs/4 font-medium text-ink underline decoration-1 underline-offset-2">
          Answer
        </Link>
      )}
      {answer.isError ? <QueryError error={answer.error} what="the answer" /> : null}
    </>
  );
}

// ---------- focus ----------

function Focus({ leadId, onDone }: { leadId: string; onDone: (id: string) => void }) {
  const full = useLead(leadId);
  if (full.isError) return <QueryError error={full.error} what="this lead" className="w-full min-w-0 grow basis-0" />;
  if (!full.data) return <FocusSkeleton />;
  return <FocusLead full={full.data} onDone={onDone} />;
}

function FocusLead({ full, onDone }: { full: LeadFull; onDone: (id: string) => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = useInvalidateLead();
  const { lead, evidence } = full;
  const notes = full.notes ?? [];
  const [asking, setAsking] = useState(false);
  // A number key only picks a reason; Enter (or a click) commits it, so stray typing never disqualifies a lead.
  const [picked, setPicked] = useState<number | null>(null);
  const [other, setOther] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  const noteRef = useRef<HTMLInputElement>(null);
  const research = full.sessions.find((s) => s.purpose === "research") ?? full.sessions[0];
  const text = lead.rationale || lead.why_summary;

  const decide = useMutation({
    mutationFn: async (d: { fit: boolean; reason: string }) => {
      await api.addNote(lead.id, { kind: d.fit ? "thumbs_up" : "thumbs_down", body: d.reason });
      return api.patchLead(lead.id, { stage: d.fit ? "qualified" : "disqualified" });
    },
    onSuccess: () => {
      invalidate(lead.id);
      void qc.invalidateQueries({ queryKey: keys.summary });
      onDone(lead.id);
    },
  });
  const notFit = (reason: string) => !decide.isPending && decide.mutate({ fit: false, reason });
  const confirm = () => !decide.isPending && decide.mutate({ fit: true, reason: "Confirmed fit" });
  const fix = () => {
    setFixing(true);
    setAsking(false);
    requestAnimationFrame(() => noteRef.current?.focus());
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "f") confirm();
      else if (k === "n") setAsking(true);
      else if (k === "e") fix();
      else if (k === "escape" && asking) {
        setAsking(false);
        setPicked(null);
      } else if (asking && /^[1-5]$/.test(k)) {
        const i = Number(k) - 1;
        if (i < REASONS.length) setPicked(i);
        else setOther("");
      } else if (k === "enter" && asking && picked !== null) notFit(REASONS[picked]!);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <article aria-label={lead.company ?? "Lead"} className="flex w-full min-w-0 grow basis-0 flex-col overflow-clip rounded-xl border border-[#200D0D1A] text-xs/4">
      <header className="flex flex-col gap-1.5 border-b border-b-[#200D0D14] px-5.5 pb-4 pt-4.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <Link to={`/app/leads/${encodeURIComponent(lead.id)}`} className="truncate text-xl/6.5 font-semibold tracking-[-0.01em] text-ink hover:underline">
              {lead.company ?? lead.domain}
            </Link>
            {lead.stage === "needs_review" ? <span className="flex h-5.5 shrink-0 items-center rounded-full border border-ink px-2.25 text-xs/4 font-medium text-ink">Needs review</span> : null}
          </div>
          {lead.score !== null ? (
            <span className="shrink-0 text-[13px]/4 font-semibold tabular-nums text-ink">
              {lead.score}
              <span className="font-[450] text-muted"> / 100</span>
            </span>
          ) : null}
        </div>
        <p className="text-[13px]/4.5 font-[450] text-muted">{[lead.domain, lead.name ? [lead.name, lead.title].filter(Boolean).join(", ") : null].filter(Boolean).join(" · ")}</p>
      </header>

      <section className="flex flex-col gap-3 border-b border-b-[#200D0D14] px-5.5 py-4.5">
        {text ? (
          <p className="text-base/5.75 font-medium text-ink [overflow-wrap:anywhere]">
            <CitedText text={text} evidence={evidence} />
          </p>
        ) : (
          <p className="text-[13px]/5 text-muted">{lead.review_question ?? "No summary saved"}</p>
        )}
        {evidence.length ? <SourceRows evidence={evidence} /> : null}
        <div className="flex flex-col gap-3 border-t border-t-[#200D0D14] pt-4">
          <h3 className="text-[13px]/4.5 font-semibold text-ink">Links &amp; contacts</h3>
          <LinksAndContacts lead={lead} />
        </div>
      </section>

      <section className="flex flex-col gap-3 border-b border-b-[#200D0D14] px-5.5 py-4.5">
        <div className="flex flex-wrap gap-2">
          <DecideButton k="F" onClick={confirm} disabled={decide.isPending}>
            Confirm fit
          </DecideButton>
          <DecideButton k="N" onClick={() => setAsking((v) => !v)} pressed={asking} disabled={decide.isPending}>
            Not a fit
          </DecideButton>
          <DecideButton k="E" onClick={fix} pressed={fixing} quiet>
            Fix a fact
          </DecideButton>
        </div>
        <div className="flex flex-col gap-2">
          {notes.length ? <NoteList notes={notes} variant="inline" /> : null}
          <NoteComposer
            leadId={lead.id}
            inputRef={noteRef}
            placeholder={fixing ? "Which fact is wrong, and what's right?" : "Add a note…"}
            onSaved={() => setFixing(false)}
          />
        </div>
        {asking ? (
          <div className="flex flex-col gap-2.5 rounded-[10px] border border-panel-line bg-panel px-4 py-3.5">
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-[13px]/4.5 font-semibold text-ink">Why isn't it a fit?</h4>
              {picked !== null ? (
                <kbd className="flex h-5.5 items-center rounded-[5px] border border-[#200D0D26] bg-white px-1.75 font-sans text-[11px]/3.5 font-semibold text-muted">Enter</kbd>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {REASONS.map((r, i) => (
                <button
                  key={r}
                  type="button"
                  disabled={decide.isPending}
                  onClick={() => notFit(r)}
                  aria-pressed={picked === i}
                  className={cx(
                    "flex h-7 items-center rounded-full px-3 text-xs/4 font-medium disabled:opacity-60",
                    picked === i || decide.variables?.reason === r ? "bg-ink text-white" : "border border-[#200D0D26] bg-white text-ink hover:bg-[#200D0D08]",
                  )}
                >
                  {i + 1} {r}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setOther("")}
                className={cx("flex h-7 items-center rounded-full px-3 text-xs/4 font-medium", other !== null ? "bg-ink text-white" : "border border-[#200D0D26] bg-white text-ink hover:bg-[#200D0D08]")}
              >
                5 Other…
              </button>
            </div>
            {other !== null ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (other.trim()) notFit(other.trim());
                }}
                className="flex items-center gap-2"
              >
                <input
                  autoFocus
                  value={other}
                  onChange={(e) => setOther(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && setOther(null)}
                  placeholder="Why not?"
                  aria-label="Why isn't it a fit?"
                  maxLength={4000}
                  className="h-8.5 min-w-0 grow rounded-lg border border-[#200D0D33] bg-white px-3 text-[13px]/4 text-ink outline-none placeholder:text-[#200D0D73] focus:border-ink"
                />
                <button type="submit" disabled={!other.trim() || decide.isPending} className="flex h-8.5 shrink-0 items-center rounded-full bg-ink px-3.5 text-[13px]/4 font-medium text-white disabled:opacity-60">
                  Not a fit
                </button>
              </form>
            ) : null}
          </div>
        ) : null}
        {decide.isError ? <QueryError error={decide.error} what="the decision" /> : null}
      </section>

      {research ? <AgentSteps sessionId={research.id} /> : null}
    </article>
  );
}

function DecideButton({ k, children, onClick, pressed, disabled, quiet }: { k: string; children: string; onClick: () => void; pressed?: boolean; disabled?: boolean; quiet?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      aria-keyshortcuts={k}
      className={cx(
        "flex h-9 items-center gap-2 rounded-full px-3.5 text-sm/4.5 font-medium text-ink transition-colors disabled:opacity-60",
        pressed ? "bg-lime" : quiet ? "border border-[#200D0D1A] hover:bg-[#200D0D08]" : "border border-ink hover:bg-[#200D0D08]",
      )}
    >
      {children}
      <span className="text-[11px]/4.5 font-semibold text-muted">{k}</span>
    </button>
  );
}

function FocusSkeleton() {
  return (
    <div className="flex w-full min-w-0 grow basis-0 flex-col gap-3 rounded-xl border border-[#200D0D1A] px-5.5 py-4.5">
      <Skeleton className="h-6.5 w-48" />
      <Skeleton className="h-4.5 w-72" />
      <Skeleton className="mt-3 h-5 w-full" />
      <Skeleton className="h-5 w-5/6" />
    </div>
  );
}
