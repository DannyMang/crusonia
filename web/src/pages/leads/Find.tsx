// Find leads at /app/leads/find (Paper: "Final · Finding leads · Sample, then scale"). The run sheet shows what
// the agent searches for (segments and signals from the Company summary) and starts runs: first a sample of 5 to
// rate, then the full batch once every pick is rated. The list shows the latest find run's leads as compact rows
// (fit chip, why_summary, notes, 👍/👎; a 👎 asks why and saves the reason as a note), with "Already in your
// leads" for companies Crusonia knew. A row opens the company popover: full reasoning with numbered sources,
// notes, "Add a note…", and "Find more like {company}".
// Data: GET /api/leads/find/:session_id (find_status per lead), with notes_count / rating from GET /api/leads;
// on a deployment without the find-run route, the leads created since the run started. Runs: POST /api/leads/find
// {count, like_lead_id?}.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { isApiError, type FindRunLead, type Lead, type Profile, type Run } from "../../api.ts";
import { useApi } from "../../auth.tsx";
import { Page } from "../../components/AppShell.tsx";
import { CheckLineIcon, CloseIcon, NoteBubbleIcon, PlusLineIcon, SearchLineIcon, ThumbDownIcon, ThumbUpIcon } from "../../components/core-icons.tsx";
import { CitedText, FitChip, NoteComposer, NoteList, SourceLines } from "../../components/leads/core.tsx";
import { ButtonLink, LiveChip, QueryError, RingSpinner, Skeleton } from "../../components/ui.tsx";
import { cx, plural, shortDate, usd } from "../../lib/format.ts";
import { keys, useFindRun, useInvalidateLead, useLead, useProfile, useWorkflows } from "../../queries.ts";

const SAMPLE = 5;
const SCALE = [10, 25, 50] as const;

export default function FindLeads() {
  const [params, setParams] = useSearchParams();
  const workflows = useWorkflows();
  const profile = useProfile();
  const latest = workflows.data?.find((w) => w.id === "find_leads")?.runs[0];
  const runId = params.get("run") ?? latest?.id ?? null;
  const openId = params.get("lead");
  const sample = useSample(runId, latest?.id === runId ? latest : undefined);
  const run = sample.run;
  const active = run ? run.status === "running" || run.status === "idle" : false;

  const setOpen = (id: string | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (id) next.set("lead", id);
        else next.delete("lead");
        return next;
      },
      { replace: true },
    );
  const showRun = (id: string) => setParams({ run: id }, { replace: false });

  return (
    <Page className="gap-6 px-4 pb-14 pt-6 sm:px-8 sm:pt-8">
      <header className="flex h-10 shrink-0 items-center justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl/7 font-semibold tracking-[-0.01em] text-ink">Find leads</h1>
          <Link to="/app/leads" className="text-[13px]/4 font-medium text-muted hover:text-ink">
            All leads
          </Link>
        </div>
        {run && run.cost_usd !== null ? (
          <div className="flex h-8 shrink-0 items-center gap-2 rounded-full border border-[#200D0D1A] px-3">
            <span className={cx("size-1.5 shrink-0 rounded-full", active ? "bg-green" : "bg-[#200D0D4D]")} />
            <span className="whitespace-nowrap text-[13px]/4 font-medium tabular-nums text-ink">{usd(run.cost_usd)} spent</span>
          </div>
        ) : null}
      </header>

      <div className="flex flex-col items-start gap-5 lg:flex-row">
        <RunSheet profile={profile.data} profileLoading={profile.isPending} profileError={profile.error} leads={sample.leads} hasRun={Boolean(run)} active={active} onStarted={showRun} />
        <SampleList
          run={run}
          leads={sample.leads}
          loading={sample.loading || workflows.isPending}
          error={sample.error ?? workflows.error}
          active={active}
          openId={openId}
          onOpen={setOpen}
          onFindMore={showRun}
        />
      </div>
    </Page>
  );
}

// ---------- data ----------

/**
 * The run's leads: GET /api/leads/find/:id, or (before that ships) the leads created since the run started. The
 * find-run rows carry no notes_count / rating, so those come from GET /api/leads (one request, merged by id).
 */
function useSample(runId: string | null, fromList: Run | undefined) {
  const api = useApi();
  const live = fromList ? fromList.status === "running" || fromList.status === "idle" : true;
  const found = useFindRun(runId, live);
  const fallback = Boolean(runId) && isApiError(found.error) && found.error.missingRoute;
  const needsList = fallback || Boolean(found.data?.leads.some((l) => l.rating === undefined));
  const list = useQuery({
    queryKey: ["leads", { recent: runId }],
    queryFn: () => api.leads({ limit: 200 }),
    enabled: needsList,
    refetchInterval: live ? 10_000 : false,
  });
  return useMemo(() => {
    if (!runId) return { run: undefined, leads: [] as FindRunLead[], loading: false, error: null };
    const byId = new Map((list.data?.data ?? []).map((l) => [l.id, l] as const));
    if (found.data) {
      const leads = found.data.leads.map((l) => {
        const row = byId.get(l.id);
        return l.rating === undefined && row ? { ...l, notes_count: row.notes_count, rating: row.rating } : l;
      });
      return { run: found.data.run, leads, loading: false, error: null };
    }
    if (fallback) {
      const since = fromList ? new Date(fromList.started_at).getTime() : Date.now();
      const leads = (list.data?.data ?? []).filter((l) => new Date(l.created_at).getTime() >= since - 60_000).reverse();
      return { run: fromList, leads, loading: list.isPending, error: list.error };
    }
    return { run: fromList, leads: [] as FindRunLead[], loading: found.isPending, error: found.error };
  }, [runId, found.data, found.isPending, found.error, fallback, fromList, list.data, list.isPending, list.error]);
}

const ratingOf = (l: Lead) => l.rating ?? null;

/** why_summary without its [n] markers, for the 2-line row. */
const plainCited = (text: string) => text.replace(/\s*\[\d{1,3}\]/g, "").replace(/\s{2,}/g, " ").trim();


function tally(leads: FindRunLead[]) {
  const known = leads.filter((l) => l.find_status === "known").length;
  const rateable = leads.filter((l) => l.find_status !== "known");
  const good = rateable.filter((l) => ratingOf(l) === "up").length;
  const bad = rateable.filter((l) => ratingOf(l) === "down").length;
  return { known, good, bad, toGo: rateable.length - good - bad, rateable: rateable.length };
}

// ---------- run sheet ----------

function RunSheet({
  profile,
  profileLoading,
  profileError,
  leads,
  hasRun,
  active,
  onStarted,
}: {
  profile: Profile | null | undefined;
  profileLoading: boolean;
  profileError: unknown;
  leads: FindRunLead[];
  hasRun: boolean;
  active: boolean;
  onStarted: (sessionId: string) => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [scale, setScale] = useState<number>(25);
  const [confirming, setConfirming] = useState(false);
  const t = tally(leads);
  const sampled = hasRun && t.rateable > 0;
  const count = sampled ? scale : SAMPLE;
  const find = useMutation({
    mutationFn: () => api.findLeads(count),
    onSuccess: ({ session_id }) => {
      setConfirming(false);
      void qc.invalidateQueries({ queryKey: keys.workflows });
      onStarted(session_id);
    },
    onError: () => setConfirming(false),
  });

  const label = "text-xs/4 font-medium text-muted";
  const ready = !sampled || t.toGo === 0;
  const start = () => {
    if (!confirming) {
      setConfirming(true);
      find.reset();
      return;
    }
    find.mutate();
  };

  return (
    <aside aria-label="Run sheet" className="flex w-full shrink-0 flex-col gap-4.5 rounded-xl border border-[#200D0D1A] p-5 lg:w-90">
      <h2 className="text-[15px]/4.5 font-medium text-ink">Run sheet</h2>
      {profileError ? (
        <QueryError error={profileError} what="your company summary" />
      ) : profileLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-6 w-56" />
        </div>
      ) : !profile ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-[13px]/4.75 font-[450] text-ink">Write your company summary first.</p>
          <ButtonLink to="/app/settings/company" variant="outline" size="md">
            Company summary
          </ButtonLink>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <div className={label}>How many</div>
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2 text-sm/5 font-medium text-ink">
              <span>Sample {SAMPLE}, then up to</span>
              <span role="radiogroup" aria-label="Then up to" className="flex gap-1">
                {SCALE.map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={scale === n}
                    onClick={() => setScale(n)}
                    className={cx("h-6.5 rounded-full px-2.5 text-xs/4 font-medium tabular-nums", scale === n ? "bg-ink text-white" : "border border-[#200D0D1A] text-ink hover:bg-[#200D0D08]")}
                  >
                    {n}
                  </button>
                ))}
              </span>
            </div>
          </div>
          {profile.segments.length ? (
            <div className="flex flex-col gap-2">
              <div className={label}>Segments</div>
              <ul className="flex flex-wrap gap-1.5">
                {profile.segments.map((s) => (
                  <li key={s.name} className="flex h-6.5 items-center rounded-full bg-lime px-2.5 text-xs/4 font-medium text-ink">
                    {s.name}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {profile.signals.length ? (
            <div className="flex flex-col gap-2">
              <div className={label}>Signals</div>
              <ul className="flex flex-col border-t border-t-[#200D0D0F]">
                {profile.signals.map((s) => (
                  <li key={s.name} className="flex flex-col gap-px border-b border-b-[#200D0D0F] py-2">
                    <span className="text-[13px]/4.5 font-medium text-ink">{s.name}</span>
                    {s.description ? <span className="text-xs/4 text-muted">{s.description}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {hasRun && t.known ? (
            <div className="flex flex-col gap-1">
              <div className={label}>Excluded</div>
              <p className="text-[13px]/4.75 font-[450] text-ink">{plural(t.known, "already known", "already known")}</p>
            </div>
          ) : null}
          <div className="flex flex-col gap-2 rounded-[10px] border border-panel-line bg-panel p-3.5">
            <button
              type="button"
              onClick={start}
              disabled={find.isPending || active || !ready}
              className={cx(
                "flex h-9.5 items-center justify-center gap-2 rounded-full px-4 text-sm/4.5 font-semibold transition-colors disabled:opacity-60",
                confirming ? "bg-ink text-white hover:bg-[#3A2424]" : "bg-lime text-ink hover:bg-[#b3de7a]",
              )}
            >
              {find.isPending ? <RingSpinner /> : null}
              {active ? "Running" : !ready ? `Rate ${plural(t.toGo, "more pick")} first` : confirming ? `Start · paid run` : sampled ? `Find ${count} more` : `Find a sample of ${SAMPLE}`}
            </button>
            {confirming ? (
              <button type="button" onClick={() => setConfirming(false)} className="text-xs/4 font-medium text-muted hover:text-ink">
                Cancel
              </button>
            ) : null}
            {find.isError ? <QueryError error={find.error} what="finding leads" /> : null}
          </div>
        </>
      )}
    </aside>
  );
}

// ---------- the sample ----------

function SampleList({
  run,
  leads,
  loading,
  error,
  active,
  openId,
  onOpen,
  onFindMore,
}: {
  run: Run | undefined;
  leads: FindRunLead[];
  loading: boolean;
  error: unknown;
  active: boolean;
  openId: string | null;
  onOpen: (id: string | null) => void;
  onFindMore: (sessionId: string) => void;
}) {
  const t = tally(leads);
  const sample = Number(run?.input?.count ?? leads.length) <= SAMPLE;
  const counts = [
    [t.good ? `${t.good} good` : null, t.bad ? `${t.bad} bad` : null, t.toGo ? `${t.toGo} to go` : null].filter(Boolean).join(", "),
    t.known ? `${t.known} already known` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section aria-label="Found leads" className="flex w-full min-w-0 grow basis-0 flex-col rounded-xl border border-[#200D0D1A]">
      <div className="flex min-h-13 items-center justify-between gap-3 border-b border-b-[#200D0D14] px-5 py-4">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h2 className="shrink-0 text-[15px]/4.5 font-medium text-ink">{run ? (sample ? `Sample · rate these ${leads.length || SAMPLE}` : `Found · ${leads.length}`) : "Sample"}</h2>
          {counts ? <span className="truncate text-[13px]/4 text-muted">{counts}</span> : null}
        </div>
        {active ? <LiveChip>Searching</LiveChip> : null}
      </div>
      {error ? (
        <QueryError error={error} what="this run" className="m-5" />
      ) : loading ? (
        <div className="flex flex-col gap-3 px-5 py-4">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ) : !run ? (
        <div className="px-5 py-10 text-center text-[13px]/5 font-medium text-muted">No runs yet</div>
      ) : !leads.length ? (
        <div className="px-5 py-10 text-center text-[13px]/5 font-medium text-muted">{active ? "Nothing yet" : "This run found no leads"}</div>
      ) : (
        <ul className="flex flex-col">
          {leads.map((l, i) => (
            <FindRow key={l.id} lead={l} last={i === leads.length - 1} open={openId === l.id} onOpen={() => onOpen(openId === l.id ? null : l.id)} onClose={() => onOpen(null)} onFindMore={onFindMore} />
          ))}
        </ul>
      )}
    </section>
  );
}

function FindRow({ lead, last, open, onOpen, onClose, onFindMore }: { lead: FindRunLead; last: boolean; open: boolean; onOpen: () => void; onClose: () => void; onFindMore: (id: string) => void }) {
  const api = useApi();
  const invalidate = useInvalidateLead();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [focusNote, setFocusNote] = useState(false);
  const rating = ratingOf(lead);
  const rate = useMutation({
    mutationFn: (r: { kind: "thumbs_up" | "thumbs_down"; body: string }) => api.addNote(lead.id, r),
    onSuccess: () => {
      setAsking(false);
      setReason("");
      invalidate(lead.id);
    },
  });
  const known = lead.find_status === "known";
  const down = rating === "down";

  if (known) {
    return (
      <li className={cx("flex items-center gap-3 bg-[#200D0D06] px-5 py-3", !last && "border-b border-b-[#200D0D14]", last && "rounded-b-xl")}>
        <div className="flex min-w-0 grow basis-0 flex-col gap-1.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <Link to={`/app/leads/${encodeURIComponent(lead.id)}`} className="truncate text-[15px]/5 font-semibold text-muted hover:text-ink">
              {lead.company ?? lead.domain}
            </Link>
            <span className="truncate text-xs/4 text-muted">{lead.domain}</span>
          </div>
          <span className="flex h-6 w-fit shrink-0 items-center gap-1.5 rounded-full border border-[#200D0D26] px-2.5 text-xs/4 font-medium text-ink">
            <CheckLineIcon />
            Already in your leads · found {shortDate(lead.created_at)}
          </span>
        </div>
      </li>
    );
  }

  const onReasonKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setAsking(false);
    }
  };

  return (
    <li
      className={cx(
        "relative flex flex-col gap-1.5 px-5 py-3.5",
        open ? "border-l-[3px] border-l-ink bg-panel pl-[17px]" : "",
        !last && (open ? "border-b border-b-panel-line" : "border-b border-b-[#200D0D14]"),
      )}
    >
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 grow basis-0 items-baseline gap-2">
          <button type="button" onClick={onOpen} aria-expanded={open} className={cx("shrink-0 text-left text-[15px]/5 font-semibold hover:underline", down ? "text-muted" : "text-ink")}>
            {lead.company ?? lead.domain ?? "Unnamed"}
          </button>
          <span className="truncate text-xs/4 text-muted">{[lead.domain, lead.name && lead.title ? `${lead.name}, ${lead.title}` : lead.name].filter(Boolean).join(" · ")}</span>
        </div>
        <FitChip lead={lead} />
        <div className="flex gap-1">
          <ThumbButton
            label="Good pick"
            pressed={rating === "up"}
            disabled={rate.isPending}
            onClick={() => rating !== "up" && rate.mutate({ kind: "thumbs_up", body: "Good fit" })}
            icon={<ThumbUpIcon />}
          />
          <ThumbButton label="Not a fit" pressed={down || asking} disabled={rate.isPending} onClick={() => setAsking((v) => !v)} icon={<ThumbDownIcon />} />
        </div>
      </div>
      {lead.why_summary ? (
        // Two lines at most, with "More" pinned to the end of the second line (a float pushed down by a spacer;
        // the flex parent gives the clamped text a definite height for the spacer's percentage).
        <div className="flex pr-19">
          <p
            className={cx(
              "line-clamp-2 text-[13px]/4.75 font-[450] before:float-right before:h-[calc(100%-19px)] before:content-['']",
              down ? "text-muted" : "text-ink",
            )}
          >
            <button type="button" onClick={onOpen} className="clear-right float-right ml-1 text-ink underline decoration-1 underline-offset-2">
              More
            </button>
            {plainCited(lead.why_summary)}
          </p>
        </div>
      ) : null}
      {asking ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            rate.mutate({ kind: "thumbs_down", body: reason.trim() || "Not a fit" });
          }}
          className="flex items-center gap-2 pt-1"
        >
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={onReasonKey}
            placeholder="Why not?"
            aria-label="Why not a fit?"
            maxLength={4000}
            className="h-8.5 min-w-0 grow rounded-lg border border-[#200D0D33] bg-white px-3 text-[13px]/4 text-ink outline-none placeholder:text-[#200D0D73] focus:border-ink"
          />
          <button type="submit" disabled={rate.isPending} className="flex h-8.5 shrink-0 items-center rounded-full bg-ink px-3.5 text-[13px]/4 font-medium text-white disabled:opacity-60">
            {rate.isPending ? "Saving…" : "Rate down"}
          </button>
        </form>
      ) : down ? (
        <DownNote leadId={lead.id} />
      ) : (
        <button
          type="button"
          onClick={() => {
            setFocusNote(!lead.notes_count);
            onOpen();
          }}
          className="flex w-fit items-center gap-1.5 text-xs/4 font-medium text-muted hover:text-ink"
        >
          {lead.notes_count ? <NoteBubbleIcon /> : <PlusLineIcon />}
          {lead.notes_count ? plural(lead.notes_count, "note") : "Add note"}
        </button>
      )}
      {rate.isError ? <QueryError error={rate.error} what="the rating" /> : null}
      {open ? <CompanyPopover lead={lead} focusNote={focusNote} onClose={onClose} onFindMore={onFindMore} /> : null}
    </li>
  );
}

function ThumbButton({ label, pressed, disabled, onClick, icon }: { label: string; pressed: boolean; disabled?: boolean; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "flex size-7.5 shrink-0 items-center justify-center rounded-full transition-colors",
        pressed ? "bg-ink text-white" : "border border-[#200D0D1A] bg-white text-ink hover:bg-[#200D0D08]",
      )}
    >
      {icon}
    </button>
  );
}

/** The 👎 reason under a rated-down row: "Daniel Ung · Nov 7 · rated down Agency, not software." */
function DownNote({ leadId }: { leadId: string }) {
  const api = useApi();
  const notes = useQuery({ queryKey: ["notes", leadId], queryFn: () => api.notes(leadId) });
  const n = notes.data?.find((x) => x.kind === "thumbs_down");
  return n ? <NoteList notes={[n]} variant="inline" /> : null;
}

// ---------- company popover ----------

function CompanyPopover({ lead, focusNote, onClose, onFindMore }: { lead: FindRunLead; focusNote: boolean; onClose: () => void; onFindMore: (id: string) => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const full = useLead(lead.id);
  const ref = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const evidence = full.data?.evidence ?? [];
  const notes = full.data?.notes ?? [];
  const name = lead.company ?? lead.domain ?? "this company";
  const more = useMutation({
    mutationFn: () => api.findLeads(10, { like_lead_id: lead.id }),
    onSuccess: ({ session_id }) => {
      void qc.invalidateQueries({ queryKey: keys.workflows });
      onFindMore(session_id);
    },
  });

  // The button that opened the popover gets focus back when Esc or Close dismisses it.
  const opener = useRef<HTMLElement | null>(null);
  if (opener.current === null && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) opener.current = document.activeElement;
  const dismiss = () => {
    onClose();
    if (opener.current?.isConnected) opener.current.focus();
  };
  useEffect(() => {
    if (focusNote) noteRef.current?.focus();
    else ref.current?.focus();
  }, [focusNote]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      onClose();
      if (opener.current?.isConnected) opener.current.focus();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !(t as HTMLElement).closest?.("[aria-expanded]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={name}
      tabIndex={-1}
      className="absolute right-4 top-[calc(100%-10px)] z-20 flex w-105 max-w-[calc(100vw-48px)] flex-col rounded-[14px] border border-[#200D0D1A] bg-white text-xs/4 shadow-[0_16px_40px_#200D0D24,0_2px_6px_#200D0D0F] outline-none"
    >
      <span aria-hidden className="absolute -top-1.75 left-14 size-3 origin-top-left rotate-45 border-l border-t border-[#200D0D1A] bg-white" />
      <div className="relative flex items-start justify-between gap-3 px-4.5 pb-3 pt-4">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-base/5 font-semibold text-ink">{name}</span>
            <FitChip lead={lead} size="xs" />
          </div>
          <span className="truncate text-xs/4 text-muted">{[lead.domain, lead.name ? [lead.name, lead.title].filter(Boolean).join(", ") : null].filter(Boolean).join(" · ")}</span>
        </div>
        <button type="button" onClick={dismiss} aria-label="Close" className="flex size-7 shrink-0 items-center justify-center rounded-full border border-[#200D0D1A] text-ink hover:bg-[#200D0D08]">
          <CloseIcon />
        </button>
      </div>
      <div className="flex flex-col gap-2 border-t border-t-[#200D0D14] px-4.5 py-3.5">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[13px]/4.5 font-semibold text-ink">Why we picked it</h3>
          <span className="shrink-0 text-xs/4 text-muted">Agent · {shortDate(lead.created_at)}</span>
        </div>
        {lead.why_summary || lead.rationale ? (
          <p className="text-[13px]/5 font-[450] text-ink [overflow-wrap:anywhere]">
            <CitedText text={(lead.why_summary || lead.rationale)!} evidence={evidence} variant="sup" />
          </p>
        ) : (
          <p className="text-[13px]/5 text-muted">No reasoning saved</p>
        )}
        {full.isPending ? <Skeleton className="h-4 w-48" /> : evidence.length ? <SourceLines evidence={evidence} /> : null}
      </div>
      <div className="flex flex-col gap-2.5 border-t border-t-[#200D0D14] px-4.5 py-3.5">
        <h3 className="text-[13px]/4.5 font-semibold text-ink">Notes{notes.length ? ` · ${notes.length}` : ""}</h3>
        {full.isError ? <QueryError error={full.error} what="notes" /> : notes.length ? <div className="max-h-56 overflow-y-auto"><NoteList notes={notes} /></div> : null}
        <NoteComposer leadId={lead.id} button inputRef={noteRef} className="pt-0.5" />
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-t-[#200D0D14] px-4.5 pb-3.5 pt-2.5">
        <button
          type="button"
          onClick={() => more.mutate()}
          disabled={more.isPending}
          className="flex h-8.5 min-w-0 items-center gap-1.5 rounded-full bg-lime px-3.5 text-[13px]/4 font-semibold text-ink hover:bg-[#b3de7a] disabled:opacity-60"
        >
          {more.isPending ? <RingSpinner /> : <SearchLineIcon />}
          <span className="truncate">Find more like {name}</span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => navigate(`/app/leads/${encodeURIComponent(lead.id)}`)}
            className="flex h-7.5 items-center rounded-full border border-[#200D0D1A] px-3.5 text-[13px]/4 font-medium text-ink hover:bg-[#200D0D08]"
          >
            Open
          </button>
          <button type="button" onClick={dismiss} className="flex h-7.5 items-center rounded-full border border-ink px-3.5 text-[13px]/4 font-medium text-ink hover:bg-[#200D0D08]">
            Close
          </button>
        </div>
      </div>
      {more.isError ? <QueryError error={more.error} what="finding more" className="mx-4.5 mb-3.5" /> : null}
    </div>
  );
}
