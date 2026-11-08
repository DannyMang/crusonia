// Dashboard · Lead detail (Paper artboard "Dashboard · Lead detail"): header with Re-research / Suppress /
// Approve & send, stats, company + contact + why fit + consent on the left, evidence and the agent timeline in
// the middle, the draft and CRM sync on the right. Everything comes from GET /api/leads/:id.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { isApiError, type Approval, type Evidence, type Lead, type LeadFull, type Message } from "../api.ts";
import { useApi } from "../auth.tsx";
import { Page } from "../components/AppShell.tsx";
import { Dialog } from "../components/leads/Overlay.tsx";
import { Button, ButtonLink, Card, CopyButton, errorCopy, QueryError, ReplyLabel, Skeleton, StageBadge } from "../components/ui.tsx";
import { cx, duration, hostOf, initials, leadTitle, longDate, plural, shortDate, timeAgo, timeLeft } from "../lib/format.ts";
import { keys, useLead } from "../queries.ts";
import { DraftCard, SendButton, useInvalidateLead, type ApproveMutation } from "./leads/DraftCard.tsx";
import { displayUrl, groupOf, safeHref, sourceLabel, stamp } from "./leads/shared.ts";
import { Timeline } from "./leads/Timeline.tsx";

const sectionTitle = "text-[15px]/4.5 font-semibold tracking-[-0.01em] text-ink";
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
      <Page className="gap-6 px-4 py-6 sm:px-12 sm:py-10">
        <Breadcrumb lead={null} />
        <QueryError error={e} what="this lead" onRetry={() => void lead.refetch()} />
      </Page>
    );
  }
  if (!lead.data) return <Loading />;
  return <Detail data={lead.data} approve={approve} />;
}

function Detail({ data, approve }: { data: LeadFull; approve: ApproveMutation }) {
  const { lead, evidence, drafts, approvals, messages, timeline } = data;
  const pending = approvals.filter((a) => a.status === "pending");
  const sendApproval = pending.find((a) => a.kind === "send");
  return (
    <Page className="gap-6 px-4 py-6 sm:px-12 sm:py-10">
      <Header lead={lead} sendApproval={sendApproval} approve={approve} />
      {approve.isError ? <QueryError error={approve.error} what="sending" /> : null}
      <Stats lead={lead} evidence={evidence} pending={pending} />
      {/* Three columns from 1280px. Below that the draft sits beside the facts and the evidence and timeline run full width
          underneath. Phones stack facts, draft, then evidence and timeline in one column. */}
      <div className="flex flex-col gap-7 sm:grid sm:grid-cols-[16rem_minmax(0,1fr)] sm:items-start xl:flex xl:flex-row">
        <div className="flex w-full shrink-0 flex-col gap-5.5 sm:w-64">
          <CompanyFacts lead={lead} lookalikes={data.lookalikes} />
          <ContactFacts lead={lead} />
          <WhyFit lead={lead} />
          <ConsentBox lead={lead} />
        </div>
        <div className="order-last col-span-2 row-start-2 flex min-w-0 grow basis-0 flex-col gap-7 sm:order-none">
          <EvidenceList evidence={evidence} />
          <Timeline events={timeline} pending={pending} />
          {messages.length ? <Conversation messages={messages} /> : null}
        </div>
        <div className="flex w-full shrink-0 flex-col gap-5 xl:w-91">
          <DraftCard lead={lead} drafts={drafts} approval={sendApproval} approve={approve} />
          <CrmSync lead={lead} />
        </div>
      </div>
    </Page>
  );
}

// ---------- header ----------

function Breadcrumb({ lead }: { lead: Lead | null }) {
  return (
    <nav aria-label="Breadcrumb" className="flex gap-2 text-[13px]/4 font-medium">
      <Link to="/app/leads" className={cx(muted, "hover:text-ink hover:underline")}>
        Leads
      </Link>
      {lead ? (
        <>
          <span className={muted} aria-hidden>
            /
          </span>
          {groupOf(lead.stage).key === "needs" ? (
            <Link to="/app/leads?stage=awaiting_approval" className={cx(muted, "hover:text-ink hover:underline")}>
              {groupOf(lead.stage).title}
            </Link>
          ) : (
            <span className={muted}>{groupOf(lead.stage).title}</span>
          )}
          <span className={muted} aria-hidden>
            /
          </span>
          <span aria-current="page" className="text-ink">
            {leadTitle(lead)}
          </span>
        </>
      ) : null}
    </nav>
  );
}

function Header({ lead, sendApproval, approve }: { lead: Lead; sendApproval: Approval | undefined; approve: ApproveMutation }) {
  const [dialog, setDialog] = useState<"research" | "suppress" | null>(null);
  const suppressed = Boolean(useSuppression(lead.email).data);
  const source = safeHref(lead.source_url);
  const subtitle: ReactNode[] = [lead.name, lead.title, `found ${shortDate(lead.created_at)}`].filter(Boolean) as string[];
  return (
    <div className="flex flex-col gap-2.5">
      <Breadcrumb lead={lead} />
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-3 xl:flex-nowrap">
        <h1 className="min-w-0 truncate text-2xl/7.5 font-semibold tracking-[-0.02em] text-ink">{leadTitle(lead)}</h1>
        {lead.domain && lead.domain !== leadTitle(lead) ? <div className={cx("shrink-0 text-[13px]/4", muted)}>{lead.domain}</div> : null}
        <StageBadge stage={lead.stage} size="lg" />
        <div className="grow" />
        <div className="flex min-w-0 flex-wrap gap-2 sm:shrink-0">
          {lead.stage === "replied" || lead.stage === "interested" ? <MeetingButton lead={lead} /> : null}
          <Button
            variant="outline"
            size="header"
            onClick={() => setDialog("research")}
            disabled={lead.stage === "unsubscribed"}
            title={lead.stage === "unsubscribed" ? "Unsubscribed leads are never researched again" : "Starts a paid research run"}
          >
            Re-research
          </Button>
          <Button
            variant="outline"
            size="header"
            onClick={() => setDialog("suppress")}
            disabled={!lead.email || suppressed}
            title={!lead.email ? "No email address to suppress yet" : suppressed ? `${lead.email} is already on the suppression list` : undefined}
          >
            {suppressed ? "Suppressed" : "Suppress"}
          </Button>
          {sendApproval ? <SendButton approval={sendApproval} approve={approve} label="Approve & send" /> : null}
        </div>
      </div>
      <div className="text-sm/4.5 font-medium text-[#200D0D9E]">
        {subtitle.join(" · ")} via {sourceLabel(lead.source)}
        {source ? (
          <>
            {" "}
            from{" "}
            <a href={source} target="_blank" rel="noopener noreferrer" className="text-ink hover:underline">
              {hostOf(source)}
            </a>
          </>
        ) : null}
      </div>
      <ResearchDialog lead={lead} open={dialog === "research"} onClose={() => setDialog(null)} />
      <SuppressDialog lead={lead} open={dialog === "suppress"} onClose={() => setDialog(null)} />
    </div>
  );
}

/** Owner-set stage after a reply turns into a meeting (PATCH stage=meeting_booked). */
function MeetingButton({ lead }: { lead: Lead }) {
  const api = useApi();
  const invalidate = useInvalidateLead(lead.id);
  const mark = useMutation({ mutationFn: () => api.patchLead(lead.id, { stage: "meeting_booked" }), onSuccess: invalidate });
  return (
    <>
      {mark.isError ? (
        <span role="alert" title={errorCopy(mark.error, "updating leads").body} className="self-center text-xs/4 font-medium text-[#B42318]">
          {errorCopy(mark.error, "updating leads").title}
        </span>
      ) : null}
      <Button variant="outline" size="header" loading={mark.isPending} onClick={() => mark.mutate()} title="Moves this lead to Meeting booked">
        Mark meeting booked
      </Button>
    </>
  );
}

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
      description={
        started
          ? "The agent re-checks sources, updates the evidence and rescores the lead. New steps show up in the timeline."
          : "The agent re-checks every source, looks for new signals and rescores the lead. Nothing is emailed."
      }
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
            ? "Research is already running for this lead. Its steps show up in the timeline as they happen."
            : skipped?.reason === "unsubscribed"
              ? "This lead unsubscribed, so Crusonia never researches or contacts them again."
              : failed
                ? `The run could not start: ${failed.error}`
                : "Nothing started for this lead."}
        </div>
      ) : (
        <>
          <div className="flex items-start gap-2.5 rounded-[10px] border border-[#200D0D1A] bg-pill px-3.5 py-3 text-[13px]/5 font-medium text-ink">
            <span className="mt-1.75 size-1.5 shrink-0 rounded-full bg-ink" />
            <span>This starts a paid agent run (web search and scraping) billed to your workspace.</span>
          </div>
          {research.isError ? <QueryError error={research.error} what="re-research" /> : null}
        </>
      )}
    </Dialog>
  );
}

function SuppressDialog({ lead, open, onClose }: { lead: Lead; open: boolean; onClose: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const email = lead.email ?? "";
  const suppress = useMutation({
    mutationFn: () => api.addSuppression(email, "manual"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["suppressions"] });
      void qc.invalidateQueries({ queryKey: keys.lead(lead.id) });
    },
  });
  const close = () => {
    onClose();
    suppress.reset();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={suppress.isSuccess ? "Suppressed" : `Suppress ${email}?`}
      description={
        suppress.isSuccess
          ? `${email} is on the suppression list. Crusonia will never email it again.`
          : "Crusonia will never email this address again, whatever any agent drafts. You can undo this in Settings."
      }
      footer={
        suppress.isSuccess ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="soft" onClick={close}>
              Cancel
            </Button>
            <Button variant="danger" loading={suppress.isPending} onClick={() => suppress.mutate()}>
              Suppress {email}
            </Button>
          </>
        )
      }
    >
      {suppress.isError ? <QueryError error={suppress.error} what="the suppression list" /> : null}
    </Dialog>
  );
}

// ---------- stats ----------

// Four across from `sm`; phones show two rows of two, so the third stat starts a row without a divider.
const STAT_EDGE = {
  first: "pr-4",
  second: "border-l border-l-[#200D0D1A] pl-4 sm:px-4",
  third: "pr-4 sm:border-l sm:border-l-[#200D0D1A] sm:px-4",
  last: "border-l border-l-[#200D0D1A] pl-4",
};

function Stat({ title, value, unit, note, edge, text }: { title: string; value: string; unit?: string; note: string; edge: keyof typeof STAT_EDGE; text?: boolean }) {
  return (
    <div className={cx("flex min-w-0 grow basis-0 flex-col gap-1", STAT_EDGE[edge])}>
      <div className={cx("text-[13px]/4 font-medium", muted)}>{title}</div>
      <div className={cx("text-xl/6 font-semibold text-ink", text ? "tracking-[-0.01em]" : "tabular-nums")}>
        {value}
        {unit ? <span className={cx("text-[13px] font-medium", muted)}> {unit}</span> : null}
      </div>
      <div className={cx("truncate text-[13px]/4", muted)}>{note}</div>
    </div>
  );
}

function Stats({ lead, evidence, pending }: { lead: Lead; evidence: Evidence[]; pending: Approval[] }) {
  const hosts = new Set(evidence.map((e) => hostOf(e.source_url)));
  const latest = evidence.reduce<string | null>((m, e) => (!m || e.created_at > m ? e.created_at : m), null);
  const oldest = [...pending].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  return (
    <div className="grid grid-cols-2 gap-y-4 border-y border-y-[#200D0D1A] py-4 sm:flex">
      <Stat
        edge="first"
        title="Fit score"
        value={lead.score === null ? "—" : String(lead.score)}
        unit={lead.score === null ? undefined : "/100"}
        note={lead.qualified === null ? "not scored yet" : lead.qualified ? "qualified" : "below the bar"}
      />
      <Stat
        edge="second"
        title="Evidence"
        value={String(evidence.length)}
        unit={evidence.length === 1 ? "source" : "sources"}
        note={evidence.length ? `${plural(hosts.size, "site")} · latest ${timeAgo(latest)}` : "none yet"}
      />
      <Stat edge="third" text title="Draft variant" value={`Variant ${lead.variant}`} note="the version of the draft this contact gets" />
      <Stat
        edge="last"
        title="Waiting on you"
        value={oldest ? duration(Date.now() - new Date(oldest.created_at).getTime()) : "—"}
        note={oldest ? `code ${oldest.code} · expires in ${timeLeft(oldest.expires_at)}` : "nothing pending"}
      />
    </div>
  );
}

// ---------- left column ----------

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <div className={cx("shrink-0 text-[13px]/4 font-medium", muted)}>{label}</div>
      <div className="min-w-0 break-words text-right text-[13px]/4 font-medium text-ink">{children}</div>
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-ink hover:underline">
      {children}
    </a>
  );
}

function Block({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className={cx("text-[13px]/4 font-medium", muted)}>{label}</div>
      <div className="whitespace-pre-line break-words text-[13px]/4.5 font-medium text-ink">{text}</div>
    </div>
  );
}

function CompanyFacts({ lead, lookalikes }: { lead: Lead; lookalikes: LeadFull["lookalikes"] }) {
  const website = safeHref(lead.website);
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className={sectionTitle}>Company</h2>
      {lead.company ? <Row label="Name">{lead.company}</Row> : null}
      <Row label="Domain">{lead.domain ? <span className="text-xs/4">{lead.domain}</span> : <span className={muted}>—</span>}</Row>
      {website ? (
        <Row label="Website">
          <ExternalLink href={website}>{displayUrl(website)}</ExternalLink>
        </Row>
      ) : null}
      <Row label="Source">{sourceLabel(lead.source)}</Row>
      {lead.sells ? <Block label="Sells" text={lead.sells} /> : null}
      {lead.best_customers ? <Block label="Best customers" text={lead.best_customers} /> : null}
      {lookalikes.length ? (
        <div className="flex flex-col gap-1">
          <div className={cx("text-[13px]/4 font-medium", muted)}>Lookalikes</div>
          {lookalikes.slice(0, 4).map((l) => (
            <div key={l.id} className="text-[13px]/4.5 font-medium text-ink">
              {l.company}
              <span className={muted}> · {l.why_fit}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ContactFacts({ lead }: { lead: Lead }) {
  const linkedin = safeHref(lead.linkedin_url);
  const has = Boolean(lead.name || lead.email);
  return (
    <section className="flex flex-col gap-2.5 border-t border-t-[#200D0D14] pt-4.5">
      <h2 className={sectionTitle}>Contact</h2>
      {has ? (
        <>
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-pill text-xs/3 font-semibold text-ink">
              {initials(lead.name ?? lead.email, "?")}
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="truncate text-sm/4.5 font-medium text-ink">{lead.name ?? lead.email}</div>
              {lead.title ? <div className={cx("truncate text-xs/4 font-medium", muted)}>{lead.title}</div> : null}
            </div>
          </div>
          {lead.email ? (
            <div className="flex items-center justify-between gap-2">
              <div className={cx("shrink-0 text-[13px]/4 font-medium", muted)}>Email</div>
              <div className="flex min-w-0 items-center gap-1">
                <span className="min-w-0 truncate text-xs/4 text-ink">{lead.email}</span>
                <CopyButton text={lead.email} label="Copy email" iconOnly className="-my-1 -mr-1.5" />
              </div>
            </div>
          ) : (
            <Row label="Email">
              <span className={muted}>not found yet</span>
            </Row>
          )}
          {linkedin ? (
            <Row label="LinkedIn">
              <ExternalLink href={linkedin}>Profile</ExternalLink>
            </Row>
          ) : null}
        </>
      ) : (
        <div className={cx("text-[13px]/5 font-medium", muted)}>No contact yet. The agent adds a person once it finds the right one.</div>
      )}
    </section>
  );
}

function WhyFit({ lead }: { lead: Lead }) {
  return (
    <section className="flex flex-col gap-2.5 border-t border-t-[#200D0D14] pt-4.5">
      <div className="flex items-baseline justify-between">
        <h2 className={sectionTitle}>
          Why fit{lead.score !== null ? <span className="tabular-nums"> {lead.score}</span> : null}
        </h2>
        {lead.qualified !== null ? (
          <div className={cx("text-xs/4 font-medium", lead.qualified ? "text-green-dark" : muted)}>{lead.qualified ? "qualified" : "not qualified"}</div>
        ) : null}
      </div>
      {lead.rationale ? (
        <p className="whitespace-pre-line break-words text-[13px]/5 font-medium text-ink">{lead.rationale}</p>
      ) : (
        <p className={cx("text-[13px]/5 font-medium", muted)}>Not scored yet. The agent explains its score here once research is done.</p>
      )}
      {lead.review_question ? (
        <div className="flex flex-col gap-0.5 rounded-[10px] border border-[#92400E26] bg-[#FEF3C780] px-3 py-2.5">
          <div className="text-xs/4 font-semibold text-[#92400E]">The agent asks</div>
          <div className="whitespace-pre-line break-words text-[13px]/4.5 font-medium text-ink">{lead.review_question}</div>
        </div>
      ) : null}
    </section>
  );
}

function useSuppression(email: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: keys.suppressions(email ?? ""),
    queryFn: () => api.suppressions({ q: email!, limit: 10 }),
    enabled: Boolean(email),
    select: (page) => page.data.find((s) => s.email.toLowerCase() === email!.toLowerCase()) ?? null,
  });
}

function ConsentBox({ lead }: { lead: Lead }) {
  const supp = useSuppression(lead.email);
  const suppressed = Boolean(supp.data);
  const ok = lead.has_consent && !suppressed && lead.stage !== "unsubscribed";
  return (
    <div className={cx("flex flex-col gap-2.5 rounded-[10px] border p-3.5", ok ? "border-panel-line bg-panel" : "border-[#200D0D1A] bg-[#200D0D06]")}>
      <div className="flex items-center gap-2">
        {ok ? (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0">
            <circle cx="8" cy="8" r="6.5" fill="#16A34A" />
            <path d="M5 8.2l2 2 4-4.2" fill="none" stroke="#FFFFFF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0">
            <circle cx="8" cy="8" r="6.5" fill="#B42318" />
            <path d="M5.5 8h5" stroke="#FFFFFF" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        )}
        <div className="text-[13px]/4 font-semibold text-ink">
          {ok ? "Okay to email" : suppressed || lead.stage === "unsubscribed" ? "Suppressed: never emailed" : "No consent: never emailed"}
        </div>
      </div>
      <div className="flex flex-col gap-0.5">
        <div className={cx("text-xs/4 font-medium", muted)}>Consent</div>
        {lead.has_consent ? (
          <>
            <div className="whitespace-pre-line break-words text-[13px]/4.25 font-medium text-ink">{lead.consent_text ?? "Recorded"}</div>
            {lead.consent_at ? (
              <div className={cx("text-[11px]/3.75 tabular-nums", muted)}>
                {longDate(lead.consent_at)} · {stamp(lead.consent_at).split(", ").at(-1)}
              </div>
            ) : null}
          </>
        ) : (
          <div className="text-[13px]/4.25 font-medium text-ink">
            No opt-in on file. Crusonia only emails people who asked to hear from you, so this lead is researched but never contacted.
          </div>
        )}
      </div>
      <div className={cx("flex flex-col gap-0.5 border-t pt-2.5", ok ? "border-t-panel-line" : "border-t-[#200D0D14]")}>
        <div className={cx("text-xs/4 font-medium", muted)}>Suppression</div>
        {!lead.email ? (
          <div className="text-[13px]/4.25 font-medium text-ink">No email address yet</div>
        ) : supp.isPending ? (
          <Skeleton className="h-4 w-32" />
        ) : supp.isError ? (
          <div className={cx("text-[13px]/4.25 font-medium", muted)}>Couldn't check the suppression list right now</div>
        ) : supp.data ? (
          <>
            <div className="text-[13px]/4.25 font-medium text-ink">Suppressed · {supp.data.reason.replace(/_/g, " ")}</div>
            <div className={cx("text-xs/4 font-medium", muted)}>since {longDate(supp.data.created_at)} · never contacted again</div>
          </>
        ) : (
          <>
            <div className="text-[13px]/4.25 font-medium text-ink">Not suppressed</div>
            <div className={cx("wrap-anywhere text-xs/4 font-medium", muted)}>{lead.email} is not on the suppression list</div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- middle column ----------

const EVIDENCE_SHOWN = 3;

function EvidenceList({ evidence }: { evidence: Evidence[] }) {
  const [all, setAll] = useState(false);
  const items = [...evidence].sort((a, b) => a.id - b.id);
  const shown = all ? items : items.slice(0, EVIDENCE_SHOWN);
  const rest = items.slice(EVIDENCE_SHOWN);
  return (
    <section className="flex flex-col overflow-clip rounded-xl border border-[#200D0D1A]">
      <div className="flex items-baseline justify-between px-4 pb-3 pt-3.5">
        <div className="flex items-baseline gap-2.5">
          <h2 className={sectionTitle}>Evidence</h2>
          <div className={cx("text-[13px]/4 font-medium", muted)}>{items.length ? `${plural(items.length, "claim")} · each with a source` : "none yet"}</div>
        </div>
      </div>
      {items.length ? (
        <ol>
          {shown.map((e, i) => {
            const href = safeHref(e.source_url);
            return (
              <li key={e.id} className="flex gap-3 border-t border-t-[#200D0D14] px-4 py-3">
                <div className="flex size-5 shrink-0 items-center justify-center rounded-md bg-lime text-[11px]/3 font-semibold tabular-nums text-ink">{i + 1}</div>
                <div className="flex min-w-0 grow basis-0 flex-col gap-0.75">
                  <div className="break-words text-[13px]/4.25 font-medium text-ink">{e.claim}</div>
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer" className="truncate text-[11px]/3.75 text-ink hover:underline" title={href}>
                      {displayUrl(href)}
                    </a>
                  ) : (
                    <div className={cx("truncate text-[11px]/3.75", muted)}>{e.source_url}</div>
                  )}
                  <div className={cx("text-xs/4 font-medium", muted)}>saved {timeAgo(e.created_at)}</div>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="flex flex-col gap-1 border-t border-t-[#200D0D14] px-4 py-5">
          <div className="text-[13px]/4 font-semibold text-ink">No evidence yet</div>
          <div className={cx("text-xs/4.5 font-medium", muted)}>
            When the agent researches this lead, every claim it makes lands here with the page that backs it up. Drafts only cite claims from this list.
          </div>
        </div>
      )}
      {rest.length ? (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          aria-expanded={all}
          className="flex h-9 shrink-0 items-center gap-2 border-t border-t-[#200D0D14] bg-[#200D0D06] px-4 text-left"
        >
          <span className="whitespace-nowrap text-xs/4 font-medium text-ink hover:underline">{all ? "Show fewer" : `Show ${rest.length} more`}</span>
          {!all ? (
            <span className={cx("truncate text-xs/4", muted)}>
              {[...new Set(rest.map((e) => hostOf(e.source_url)))].slice(0, 4).join(" · ")}
            </span>
          ) : null}
        </button>
      ) : null}
    </section>
  );
}

function Conversation({ messages }: { messages: Message[] }) {
  const items = [...messages].sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(-6);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2.5">
        <h2 className={sectionTitle}>Conversation</h2>
        <div className={cx("text-[13px]/4 font-medium", muted)}>{plural(messages.length, "message")}</div>
      </div>
      <div className="flex flex-col overflow-clip rounded-xl border border-[#200D0D1A]">
        {items.map((m, i) => (
          <div key={m.id} className={cx("flex flex-col gap-1 px-4 py-3", i > 0 && "border-t border-t-[#200D0D14]")}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 truncate text-xs/4 font-semibold text-ink">
                {m.direction === "out" ? `You → ${m.to_addr ?? "lead"}` : (m.from_addr ?? "Reply")}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {m.direction === "in" && m.label ? <ReplyLabel label={m.label} /> : null}
                <time dateTime={m.created_at} className="text-[11px]/3.5 font-medium tabular-nums text-faint">
                  {stamp(m.created_at)}
                </time>
              </div>
            </div>
            {m.subject ? <div className="truncate text-[13px]/4 font-medium text-ink">{m.subject}</div> : null}
            {m.body ? <p className={cx("line-clamp-4 whitespace-pre-line break-words text-xs/4.5 font-medium", muted)}>{m.body}</p> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------- right column ----------

function CrmSync({ lead }: { lead: Lead }) {
  return (
    <Card className="flex flex-col overflow-clip">
      <div className="flex items-center justify-between px-4 pb-3 pt-3.5">
        <h2 className={sectionTitle}>CRM sync</h2>
        <div className="flex items-center gap-1.5">
          <span className={cx("size-1.75 shrink-0 rounded-full", lead.hubspot_id ? "bg-green" : "bg-[#200D0D40]")} />
          <span className={cx("text-xs/4 font-medium", lead.hubspot_id ? "text-green-dark" : muted)}>{lead.hubspot_id ? "In HubSpot" : "Not synced yet"}</span>
        </div>
      </div>
      <div className="flex items-center gap-2.5 border-t border-t-[#200D0D14] px-4 py-2.5">
        <div className={cx("grow text-[13px]/4 font-medium", lead.hubspot_id ? "text-ink" : muted)}>HubSpot contact</div>
        {lead.hubspot_id ? (
          <>
            <span className={cx("text-[11px]/3.5 tabular-nums", muted)}>#{lead.hubspot_id}</span>
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden className="shrink-0">
              <path d="M4 8.5l2.5 2.5L12 5.5" fill="none" stroke="#16A34A" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </>
        ) : (
          <span className={cx("text-[11px]/3.5 font-medium", muted)}>not synced yet</span>
        )}
      </div>
      <div className={cx("border-t border-t-[#200D0D14] px-4 py-2.5 text-xs/4 font-medium", muted)}>
        {lead.hubspot_id ? "Stage changes sync to this HubSpot contact." : (
          <>
            Connect HubSpot in{" "}
            <Link to="/app/integrations" className="text-ink underline decoration-[#200D0D4D] underline-offset-2 hover:decoration-ink">
              Integrations
            </Link>{" "}
            to sync leads.
          </>
        )}
      </div>
    </Card>
  );
}

// ---------- states ----------

function NotFoundLead() {
  return (
    <Page className="gap-6 px-4 py-6 sm:px-12 sm:py-10">
      <Breadcrumb lead={null} />
      <Card className="flex flex-col items-center gap-2 px-6 py-14 text-center">
        <div className="text-[15px]/5 font-semibold tracking-[-0.01em] text-ink">We couldn't find that lead</div>
        <div className={cx("max-w-md text-[13px]/5 font-medium", muted)}>It may have been deleted, or the link is incomplete. Every lead you have is on the Leads page.</div>
        <ButtonLink to="/app/leads" className="mt-2">
          Back to Leads
        </ButtonLink>
      </Card>
    </Page>
  );
}

function Loading() {
  return (
    <Page className="gap-6 px-4 py-6 sm:px-12 sm:py-10" >
      <div className="flex flex-col gap-2.5" aria-busy="true" aria-label="Loading lead">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-7.5 w-80 max-w-full" />
        <Skeleton className="h-4.5 w-120 max-w-full" />
      </div>
      <Skeleton className="h-25 w-full" />
      <div className="flex flex-col gap-7 sm:flex-row sm:items-start">
        <Skeleton className="h-96 w-full shrink-0 sm:w-64" />
        <Skeleton className="h-96 grow" />
        <Skeleton className="h-96 w-full shrink-0 sm:w-91" />
      </div>
    </Page>
  );
}
