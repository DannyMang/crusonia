// Lead detail at /app/leads/:id (Paper: "Final · Research · Lead detail", Concept B "Cited narrative"). The header
// carries the fit and Re-research (a paid run, confirmed in a dialog). The left card is the agent's case for the
// lead: the rationale citing its evidence as [n], the numbered sources, Links & contacts, notes ("Add a note…",
// Enter saves) and what the agent did. The right card is the draft waiting on the owner: a manual task (copy,
// open profile, mark sent) or an email draft (approve, edit, reject). Everything comes from GET /api/leads/:id
// plus GET /api/tasks for the open task.
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { isApiError, type Lead, type LeadFull } from "../api.ts";
import { useApi } from "../auth.tsx";
import { Page } from "../components/AppShell.tsx";
import { AgentSteps } from "../components/leads/AgentSteps.tsx";
import { FitChip, CitedText, LinksAndContacts, NoteComposer, NoteList, SourceRows } from "../components/leads/core.tsx";
import { Dialog } from "../components/leads/Overlay.tsx";
import { CharCount, CitedBody, channelOf, TaskActions } from "../components/outreach/task.tsx";
import { Button, ButtonLink, Card, QueryError, Skeleton, StageBadge } from "../components/ui.tsx";
import { cx, leadTitle, plural, replyBody, shortDate } from "../lib/format.ts";
import { useLead, useTasks } from "../queries.ts";
import { DraftCard, useInvalidateLead, type ApproveMutation } from "./leads/DraftCard.tsx";
import { groupOf } from "./leads/shared.ts";

const muted = "text-muted";

export default function LeadDetail() {
  const { id = "" } = useParams();
  const lead = useLead(id);
  const api = useApi();
  const invalidate = useInvalidateLead(id);
  const approve: ApproveMutation = useMutation({ mutationFn: (code: string) => api.approve(code), onSettled: invalidate });

  if (lead.isError) {
    const e = lead.error;
    if (isApiError(e) && e.status === 404 && !e.missingRoute) return <NotFoundLead />;
    return (
      <Page className="gap-6 px-4 py-6 sm:px-8 sm:py-8">
        <Breadcrumb lead={null} />
        <QueryError error={e} what="this lead" onRetry={() => void lead.refetch()} />
      </Page>
    );
  }
  if (!lead.data) return <Loading />;
  return <Detail data={lead.data} approve={approve} />;
}

function Detail({ data, approve }: { data: LeadFull; approve: ApproveMutation }) {
  const { lead, evidence, drafts, approvals } = data;
  const notes = data.notes ?? [];
  const tasks = useTasks("open");
  const task = tasks.data?.data.find((t) => t.lead_id === lead.id);
  const sendApproval = approvals.find((a) => a.status === "pending" && a.kind === "send");
  const emailDrafts = drafts.filter((d) => !d.channel || d.channel === "email");
  const research = data.sessions.find((s) => s.purpose === "research");
  const text = lead.rationale || lead.why_summary;
  const sources = evidence.map((e) => e.source_url);
  const replies = (data.messages ?? []).filter((m) => m.direction === "in");

  return (
    <Page className="gap-6 px-4 pb-14 pt-6 sm:px-8 sm:pt-8">
      <Header lead={lead} />
      {approve.isError ? <QueryError error={approve.error} what="sending" /> : null}
      <div className="flex flex-col items-start gap-5 lg:flex-row">
        <article className="flex w-full min-w-0 grow basis-0 flex-col overflow-clip rounded-xl border border-[#200D0D1A]">
          <div className="flex flex-col gap-4 px-6 py-5.5">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-[15px]/4.5 font-medium text-ink">Why {leadTitle(lead)} fits</h2>
              {evidence.length ? (
                <span className="shrink-0 text-xs/4 text-muted">
                  {shortDate(evidence.at(-1)!.created_at)} · {plural(evidence.length, "source")}
                </span>
              ) : null}
            </div>
            {text ? (
              <p className="text-[17px]/7.25 font-[450] text-ink [overflow-wrap:anywhere]">
                <CitedText text={text} evidence={evidence} />
              </p>
            ) : (
              <p className="text-[13px]/5 text-muted">{lead.stage === "researching" ? "Research is running" : "Not researched yet"}</p>
            )}
            {evidence.length ? (
              <div className="border-b border-b-[#200D0D14]">
                <SourceRows evidence={evidence} rowClass="h-9.75" />
              </div>
            ) : null}
            <section className={cx("flex flex-col gap-3", !evidence.length && "border-t border-t-[#200D0D14] pt-4")}>
              <h3 className="text-[13px]/4.5 font-semibold text-ink">Links &amp; contacts</h3>
              <LinksAndContacts lead={lead} />
            </section>
            <section className="flex flex-col gap-2.5 border-t border-t-[#200D0D14] pt-4">
              <h3 className="text-[13px]/4.5 font-semibold text-ink">Notes</h3>
              {notes.length ? <NoteList notes={notes} variant="inline" /> : null}
              <NoteComposer leadId={lead.id} />
            </section>
          </div>
          {research ? <AgentSteps sessionId={research.id} /> : null}
        </article>

        {task || emailDrafts.length || sendApproval || replies.length ? (
          <div className="flex w-full shrink-0 flex-col gap-5 lg:w-110">
            {replies.map((m) => (
              <section key={m.id} aria-label="Reply" className="flex flex-col overflow-clip rounded-xl border border-[#200D0D1A]">
                <div className="flex items-center justify-between gap-3 border-b border-b-[#200D0D14] px-5 py-4">
                  <h2 className="text-[15px]/4.5 font-medium text-ink">Reply</h2>
                  <span className="shrink-0 text-xs/4 text-muted">{shortDate(m.created_at)}</span>
                </div>
                <p className="whitespace-pre-wrap px-5 py-4.5 text-sm/5.5 font-[450] text-ink [overflow-wrap:anywhere]">{replyBody(m.body)}</p>
              </section>
            ))}
            {task ? (
              <section aria-label={channelOf(task.channel).label} className="flex flex-col overflow-clip rounded-xl border border-[#200D0D1A]">
                <div className="flex items-baseline gap-2 border-b border-b-[#200D0D14] px-5 py-4">
                  <h2 className="text-[15px]/4.5 font-medium text-ink">{channelOf(task.channel).label}</h2>
                  {task.lead.name ? <span className="truncate text-xs/4 text-muted">for {task.lead.name}</span> : null}
                </div>
                <div className="flex flex-col gap-3 px-5 py-4.5">
                  <CharCount task={task} />
                  {task.channel === "email_manual" && task.subject ? <p className="text-sm/5 font-semibold text-ink">{task.subject}</p> : null}
                  <CitedBody body={task.body} citations={task.citations} sources={sources} className="text-sm/5.5 font-[450] text-ink" />
                </div>
                <div className="border-t border-t-[#200D0D14] bg-[#200D0D06] px-5 py-3.5">
                  <TaskActions task={task} compact />
                </div>
              </section>
            ) : null}
            {emailDrafts.length || sendApproval ? <DraftCard lead={lead} drafts={emailDrafts} approval={sendApproval} approve={approve} /> : null}
          </div>
        ) : null}
      </div>
    </Page>
  );
}

// ---------- header ----------

function Breadcrumb({ lead }: { lead: Lead | null }) {
  const review = lead?.stage === "needs_review";
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-[13px]/4">
      <Link to="/app/leads" className={cx(muted, "font-[450] hover:text-ink hover:underline")}>
        Leads
      </Link>
      {lead ? (
        <>
          <span className={muted} aria-hidden>
            /
          </span>
          {review ? (
            <Link to={`/app/leads/review/${encodeURIComponent(lead.id)}`} className={cx(muted, "font-[450] hover:text-ink hover:underline")}>
              Review
            </Link>
          ) : (
            <span className={cx(muted, "font-[450]")}>{groupOf(lead.stage).title}</span>
          )}
          <span className={muted} aria-hidden>
            /
          </span>
          <span aria-current="page" className="font-medium text-ink">
            {leadTitle(lead)}
          </span>
        </>
      ) : null}
    </nav>
  );
}

function Header({ lead }: { lead: Lead }) {
  const [researching, setResearching] = useState(false);
  const who = [lead.name, lead.title, lead.domain].filter(Boolean).join(" · ");
  return (
    <header className="flex shrink-0 flex-col gap-2">
      <Breadcrumb lead={lead} />
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="truncate text-2xl/7.5 font-semibold tracking-[-0.02em] text-ink">{leadTitle(lead)}</h1>
          {lead.score !== null ? <FitChip lead={lead} size="md" withScore /> : null}
          {lead.stage === "needs_review" || lead.stage === "researching" ? <StageBadge stage={lead.stage} /> : null}
        </div>
        <button
          type="button"
          onClick={() => setResearching(true)}
          disabled={lead.stage === "unsubscribed"}
          className="flex h-9 shrink-0 items-center rounded-full border border-ink px-4 text-sm/4.5 font-medium text-ink hover:bg-[#200D0D08] disabled:opacity-50"
        >
          Re-research
        </button>
      </div>
      {who ? <p className="text-sm/4.75 font-[450] text-muted">{who}</p> : null}
      <ResearchDialog lead={lead} open={researching} onClose={() => setResearching(false)} />
    </header>
  );
}

// ---------- re-research ----------

type ResearchResult = {
  started?: { lead_id: string; session_id: string }[];
  skipped?: { lead_id: string; reason: string }[];
  failed?: { lead_id: string; error: string }[];
};

function ResearchDialog({ lead, open, onClose }: { lead: Lead; open: boolean; onClose: () => void }) {
  const api = useApi();
  const invalidate = useInvalidateLead(lead.id);
  const research = useMutation({
    mutationFn: () => api.request<ResearchResult>("POST", "/api/workflows/research", { body: { lead_ids: [lead.id] } }),
    onSuccess: invalidate,
  });
  const close = () => {
    onClose();
    research.reset();
  };
  const r = research.data;
  const started = r?.started?.[0];
  const skipped = r?.skipped?.[0];
  const failed = r?.failed?.[0];
  return (
    <Dialog
      open={open}
      onClose={close}
      title={started ? "Research started" : `Research ${leadTitle(lead)} again?`}
      footer={
        started ? (
          <>
            <Button variant="soft" onClick={close}>
              Close
            </Button>
            <ButtonLink to={`/app/workflows/runs/${encodeURIComponent(started.session_id)}`} onClick={close}>
              Watch the run
            </ButtonLink>
          </>
        ) : r ? (
          <Button variant="soft" onClick={close}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="soft" onClick={close}>
              Cancel
            </Button>
            <Button loading={research.isPending} disabled={research.isError} onClick={() => research.mutate()}>
              Start paid research
            </Button>
          </>
        )
      }
    >
      {started ? null : r ? (
        <div role="status" className="rounded-[10px] border border-[#200D0D1A] bg-pill px-3.5 py-3 text-[13px]/5 font-medium text-ink">
          {skipped?.reason === "session_open"
            ? "Research is already running for this lead."
            : skipped?.reason === "unsubscribed"
              ? "This lead unsubscribed."
              : failed
                ? `The run could not start: ${failed.error}`
                : "Nothing started for this lead."}
        </div>
      ) : (
        <>
          <div className="flex items-start gap-2.5 rounded-[10px] border border-[#200D0D1A] bg-pill px-3.5 py-3 text-[13px]/5 font-medium text-ink">
            <span className="mt-1.75 size-1.5 shrink-0 rounded-full bg-ink" />
            <span>A paid agent run, billed to your workspace. Nothing is emailed.</span>
          </div>
          {research.isError ? <QueryError error={research.error} what="re-research" /> : null}
        </>
      )}
    </Dialog>
  );
}

// ---------- states ----------

function NotFoundLead() {
  return (
    <Page className="gap-6 px-4 py-6 sm:px-8 sm:py-8">
      <Breadcrumb lead={null} />
      <Card className="flex flex-col items-center gap-2 px-6 py-14 text-center">
        <div className="text-[15px]/5 font-semibold tracking-[-0.01em] text-ink">We couldn't find that lead</div>
        <ButtonLink to="/app/leads" className="mt-2">
          Back to Leads
        </ButtonLink>
      </Card>
    </Page>
  );
}

function Loading() {
  return (
    <Page className="gap-6 px-4 py-6 sm:px-8 sm:py-8">
      <div className="flex flex-col gap-2.5" aria-busy="true" aria-label="Loading lead">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-7.5 w-80" />
        <Skeleton className="h-4.5 w-120" />
      </div>
      <div className="flex items-start gap-5">
        <Skeleton className="h-96 grow" />
        <Skeleton className="h-96 w-110 shrink-0" />
      </div>
    </Page>
  );
}
