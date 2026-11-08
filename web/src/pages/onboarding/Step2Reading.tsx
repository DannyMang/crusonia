// Onboarding · 2 Reading your site (Paper artboard 2KLD-0). The user pressed Continue on step 1, so this is
// where the paid calls start: POST /api/onboarding/read-website (Apify crawl) and POST /api/onboarding/propose
// (Naive session), each at most once per run (see components/onboarding/store.ts). The proposal is polled
// with GET /api/onboarding/propose/:session_id until it is done; a reload resumes the same session.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { ApiError, type Profile } from "../../api.ts";
import { useApi } from "../../auth.tsx";
import { ChevronRight } from "../../components/icons.tsx";
import { QueryError } from "../../components/ui.tsx";
import {
  ensureStarted,
  hasValidInput,
  isComingOnline,
  patchOnboarding,
  siteHost,
  sourceLabel,
  startPropose,
  useOnboarding,
  type Onboarding,
  type StoredError,
} from "../../components/onboarding/store.ts";
import { ArrowIcon, bigButton, DoneDot, Ring, SourceList, StepTitle } from "../../components/onboarding/ui.tsx";
import { cx } from "../../lib/format.ts";

const SLOW_AFTER_MS = 3 * 60_000;

/** Turns a stored error back into an ApiError, so QueryError words it (503 not_configured reads calm). */
const asError = (e: StoredError) => new ApiError(e.status, e.code, e.message);

export default function Step2Reading() {
  const api = useApi();
  const navigate = useNavigate();
  const s = useOnboarding();
  // Nothing paid starts without a valid website or a description; anything else goes back to step 1.
  const [hasInput] = useState(() => hasValidInput(s));

  // Start (or resume) the run once. ensureStarted marks each call as started before it goes out, so
  // StrictMode's second effect run and later remounts do not start another paid run.
  useEffect(() => {
    ensureStarted(api);
  }, [api]);

  const sessionId = s.propose && "sessionId" in s.propose ? s.propose.sessionId : undefined;
  const finished = s.propose?.status === "done" || s.propose?.status === "error";
  const status = useQuery({
    queryKey: ["onboarding", "propose", sessionId],
    queryFn: () => api.proposeStatus(sessionId!),
    enabled: Boolean(sessionId) && !finished,
    refetchInterval: (q) => (q.state.data?.status === "done" || q.state.data?.status === "error" ? false : 2000),
    refetchIntervalInBackground: true,
  });

  // Mirror what the poll returns into the stored run, so step 3 (and a reload) see the same proposal.
  const data = status.data;
  useEffect(() => {
    if (!data || !sessionId) return;
    if (data.status === "done") patchOnboarding({ propose: { status: "done", sessionId }, proposal: data.profile ?? null, draft: undefined, manual: false });
    else if (data.status === "error")
      patchOnboarding({ propose: { status: "error", sessionId, error: { status: 0, code: "agent_error", message: data.error || "The agent stopped before it finished." } } });
    else if (data.profile) patchOnboarding({ proposal: data.profile });
  }, [data, sessionId]);

  const pollError = status.error && !data ? status.error : null;

  if (!hasInput) return <Navigate to="/onboarding/1" replace />;

  const host = siteHost(s.url);
  const proposeError = s.propose?.status === "error" ? s.propose.error : undefined;
  const calm = isComingOnline(proposeError);
  const done = s.propose?.status === "done";
  const stopped = Boolean(proposeError) || s.propose?.status === "interrupted";
  const running = !done && !stopped;
  const slow = running && s.startedAt ? Date.now() - s.startedAt > SLOW_AFTER_MS : false;

  const fillYourself = () => {
    patchOnboarding({ manual: true, proposal: null, draft: undefined });
    navigate("/onboarding/3");
  };

  const title = s.url ? (done ? `Read ${host}` : `Reading ${host}`) : done ? "Read your description" : "Reading your description";
  return (
    <div className="flex grow justify-center px-6 pb-8 pt-14">
      <div className="flex w-full max-w-240 flex-col gap-7">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <StepTitle
            step={2}
            title={title}
            icon={running ? <Ring size={22} width={2.5} /> : done ? <DoneDot size={22} check={12} /> : null}
            subtitle={
              done
                ? "Everything here is a draft. Check it and edit it on the next step."
                : stopped
                  ? "You can fill in your profile yourself and come back to this later."
                  : "About a minute. Everything here is a draft you can edit on the next step."
            }
          />
          {done ? (
            <button type="button" className={bigButton} onClick={() => navigate("/onboarding/3")}>
              Review your profile
              <ArrowIcon />
            </button>
          ) : null}
        </div>

        <div className="flex flex-col items-start gap-6 lg:flex-row">
          {s.url ? <PagesCard s={s} /> : <DescriptionCard text={s.description ?? ""} />}
          <div className="flex w-full shrink-0 flex-col gap-4 lg:w-110">
            {calm ? (
              <ComingOnline onFill={fillYourself} />
            ) : (
              <FoundPanel
                profile={s.proposal ?? null}
                site={s.url || s.proposal?.website || undefined}
                running={running}
                done={done}
                problem={
                  proposeError ? (
                    <Problem
                      title="The agent stopped before it finished"
                      body={proposeError.message}
                      onRetry={() => {
                        startPropose(api);
                      }}
                      onFill={fillYourself}
                    />
                  ) : s.propose?.status === "interrupted" ? (
                    <Problem
                      title="This page reloaded before the agent started"
                      body="We did not start a second run on our own. Start it again, or fill in your profile yourself."
                      onRetry={() => startPropose(api)}
                      onFill={fillYourself}
                    />
                  ) : pollError ? (
                    <QueryError error={pollError} what="the agent's progress" onRetry={() => void status.refetch()} />
                  ) : running && data?.waiting_on ? (
                    <WaitingOnYou kind={data.waiting_on} approvals={data.pending_approvals ?? []} />
                  ) : null
                }
                note={running ? data?.note : undefined}
              />
            )}
          </div>
        </div>

        <div className="text-[13px]/4.5 font-medium text-muted">
          {slow ? (
            <>
              This is taking longer than usual. You can keep waiting, or{" "}
              <button type="button" onClick={fillYourself} className="text-ink underline decoration-[#200D0D4D] underline-offset-[3px] hover:decoration-ink">
                continue and fill it in yourself
              </button>
              .
            </>
          ) : running ? (
            "Fine to reload this page: it picks up the same run instead of starting a new one."
          ) : done ? (
            "Nothing is saved until you confirm your profile on the next step."
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------- left: the pages the crawl read ----------

function PagesCard({ s }: { s: Onboarding }) {
  const read = s.read;
  const pages = read?.status === "done" ? read.pages : [];
  const count = pages.length;
  return (
    <section className="flex w-full min-w-0 grow basis-0 flex-col rounded-xl border border-[#200D0D1A] bg-white px-6 pb-2.5 pt-6" aria-label="Pages read">
      <div className="flex items-center justify-between pb-3.5">
        <h2 className="text-[15px]/4.5 font-medium text-ink">Pages read</h2>
        <div className="text-[13px]/4 font-medium tabular-nums text-muted">
          {read?.status === "done" ? `${count} of ${count}` : read?.status === "pending" || !read ? "Starting" : null}
        </div>
      </div>
      <div className="flex h-1 shrink-0 overflow-hidden rounded-full bg-[#200D0D0F]">
        {read?.status === "done" ? (
          <div className="h-1 w-full rounded-full bg-lime" />
        ) : read?.status === "pending" || !read ? (
          <div className="h-1 w-1/5 rounded-full bg-lime [animation:onb-slide_1.6s_ease-in-out_infinite]" />
        ) : null}
      </div>
      <style>{`@keyframes onb-slide{0%{transform:translateX(-100%)}100%{transform:translateX(500%)}}`}</style>
      <div className="flex flex-col pt-2">
        {read?.status === "done" ? (
          count ? (
            pages.map((p, i) => (
              <PageRow key={`${p.url}-${i}`} first={i === 0} icon={<DoneDot />} path={sourceLabel(p.url, s.url)} url={p.url} title={p.title || "Read"} />
            ))
          ) : (
            <Note>
              We couldn't read any pages on {siteHost(s.url)}. Some sites block crawlers; the agent still works from the address, and you can add
              details on the next step.
            </Note>
          )
        ) : read?.status === "error" ? (
          <div className="py-3">
            <QueryError error={asError(read.error)} what="reading your pages" />
          </div>
        ) : read?.status === "interrupted" ? (
          <Note>The page list was interrupted by a reload. The agent's proposal on the right does not depend on it.</Note>
        ) : (
          <PageRow
            first
            icon={
              <span className="flex size-4.5 shrink-0 items-center justify-center">
                <Ring size={14} />
              </span>
            }
            path={`${siteHost(s.url)}/`}
            title="Reading…"
            active
          />
        )}
      </div>
    </section>
  );
}

function PageRow({ icon, path, url, title, first, active }: { icon: ReactNode; path: string; url?: string; title: string; first?: boolean; active?: boolean }) {
  return (
    <div className={cx("flex h-11 shrink-0 items-center gap-3", !first && "border-t border-t-[#200D0D0F]")}>
      {icon}
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" title={url} className="w-50 shrink-0 truncate text-[13px]/4.5 font-medium text-ink hover:underline">
          {path}
        </a>
      ) : (
        <span className="w-50 shrink-0 truncate text-[13px]/4.5 font-medium text-ink">{path}</span>
      )}
      <span className={cx("min-w-0 grow basis-0 truncate text-[13px]/4 font-medium", active ? "text-ink" : "text-muted")}>{title}</span>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="py-3 text-[13px]/5 font-medium text-muted">{children}</p>;
}

function DescriptionCard({ text }: { text: string }) {
  return (
    <section className="flex w-full min-w-0 grow basis-0 flex-col gap-3 rounded-xl border border-[#200D0D1A] bg-white px-6 py-6" aria-label="Your description">
      <h2 className="text-[15px]/4.5 font-medium text-ink">Your description</h2>
      <p className="whitespace-pre-wrap text-sm/5.25 font-medium text-[#200D0DB3]">{text}</p>
      <p className="text-[13px]/4.5 font-medium text-muted">No website to read, so the agent works from this.</p>
    </section>
  );
}

// ---------- right: what the agent proposes ----------

// Field labels in sentence case with no tracking (Paper "Onboarding · 2": What you sell, Who buys, Buying signals).
const eyebrow = "text-xs/4 font-medium text-muted";

function sourcesFor(profile: Profile | null, test: (field: string) => boolean) {
  return (profile?.sources ?? []).filter((x) => test(x.field)).map((x) => x.url);
}

function FoundPanel({
  profile,
  site,
  running,
  done,
  problem,
  note,
}: {
  profile: Profile | null;
  site?: string;
  running: boolean;
  done: boolean;
  problem: ReactNode;
  note?: string;
}) {
  const signals = (profile?.signals ?? []).filter((x) => x.name?.trim());
  return (
    <section className="flex flex-col gap-5 rounded-xl border border-panel-line bg-panel p-6" aria-label="What we found" aria-busy={running || undefined}>
      <div className="flex items-center justify-between">
        <h2 className="text-[15px]/4.5 font-medium text-ink">What we found</h2>
        {running ? (
          <div className="flex items-center gap-1.5" role="status">
            <span className="size-1.5 shrink-0 rounded-full bg-green [animation:crusonia-pulse_1.6s_ease-in-out_infinite]" />
            <span className="text-xs/4 font-medium text-green-dark">Updating</span>
          </div>
        ) : done ? (
          <div className="flex items-center gap-1.5">
            <span className="size-1.5 shrink-0 rounded-full bg-green" />
            <span className="text-xs/4 font-medium text-green-dark">Done</span>
          </div>
        ) : null}
      </div>
      {problem}
      {note ? <p className="-mt-2 text-[13px]/5 font-medium text-muted">{note}</p> : null}
      <Found label="What you sell" value={profile?.sells} running={running} sources={sourcesFor(profile, (f) => f === "sells")} site={site} />
      <div className="h-px shrink-0 bg-panel-line" />
      <Found label="Who buys" value={profile?.icp_description} running={running} sources={sourcesFor(profile, (f) => f === "icp_description" || f.startsWith("segments"))} site={site} />
      <div className="h-px shrink-0 bg-panel-line" />
      <div className="flex flex-col gap-1.5">
        <h3 className={eyebrow}>Buying signals</h3>
        {signals.length ? (
          <>
            <ul className="flex flex-col gap-1">
              {signals.map((x, i) => (
                <li key={`${x.name}-${i}`} className="text-[15px]/5.5 font-medium text-ink">
                  {x.name}
                </li>
              ))}
            </ul>
            <SourceList urls={sourcesFor(profile, (f) => f.startsWith("signals"))} site={site} />
          </>
        ) : running ? (
          <Bars />
        ) : (
          <Missing />
        )}
      </div>
    </section>
  );
}

function Found({ label, value, running, sources, site }: { label: string; value: string | null | undefined; running: boolean; sources: string[]; site?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className={eyebrow}>{label}</h3>
      {value?.trim() ? (
        <>
          <p className="whitespace-pre-wrap text-[15px]/5.5 font-medium text-ink">{value}</p>
          <SourceList urls={sources} site={site} />
        </>
      ) : running ? (
        <Bars />
      ) : (
        <Missing />
      )}
    </div>
  );
}

function Bars() {
  return (
    <div className="flex flex-col gap-2 pt-0.5" aria-label="Still reading">
      <span className="h-2.5 w-[86%] shrink-0 rounded-full bg-panel-line [animation:crusonia-pulse_1.6s_ease-in-out_infinite]" />
      <span className="h-2.5 w-[62%] shrink-0 rounded-full bg-panel-line [animation:crusonia-pulse_1.6s_ease-in-out_infinite]" />
    </div>
  );
}

function Missing() {
  return <p className="text-[13px]/5 font-medium text-muted">Nothing found. You can add it on the next step.</p>;
}

/** The agent paused on the owner (a tool approval or a question): answering it lets the run continue. */
function WaitingOnYou({ kind, approvals }: { kind: "approval" | "answer"; approvals: { code: string; kind: string; summary: string }[] }) {
  return (
    <div role="status" className="flex flex-col gap-2.5 rounded-[10px] border border-[#200D0D1A] bg-white px-4 py-3.5">
      <div className="flex flex-col gap-0.5 text-[13px]/5">
        <div className="font-semibold text-ink">{kind === "answer" ? "The agent has a question for you" : "The agent is waiting for your OK"}</div>
        <div className="font-medium text-muted">It continues as soon as you answer. This page keeps checking.</div>
      </div>
      {approvals.length ? (
        <ul className="flex flex-col gap-1.5">
          {approvals.map((a) => (
            <li key={a.code}>
              <Link to={`/app/outreach/${encodeURIComponent(a.code)}`} className="flex items-center gap-2 text-[13px]/4.5 font-medium text-ink hover:underline">
                <span className="shrink-0 font-semibold">{a.code}</span>
                <span className="min-w-0 truncate text-muted">{a.summary}</span>
                <ChevronRight className="ml-auto text-green" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <Link to="/app/outreach" className="flex items-center gap-1 self-start text-[13px]/4.5 font-medium text-ink hover:underline">
          Open approvals
          <ChevronRight className="text-green" />
        </Link>
      )}
    </div>
  );
}

function Problem({ title, body, onRetry, onFill }: { title: string; body: string; onRetry: () => void; onFill: () => void }) {
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-[10px] border border-[#B4231829] bg-white px-4 py-3.5">
      <div className="flex flex-col gap-0.5 text-[13px]/5">
        <div className="font-semibold text-ink">{title}</div>
        <div className="font-medium text-muted">{body}</div>
      </div>
      <div className="flex flex-wrap gap-2">
        {/* Starts a new paid session, so it only ever happens on this click. */}
        <button type="button" onClick={onRetry} className="h-8 rounded-lg border border-[#200D0D26] bg-white px-3 text-[13px]/4 font-medium text-ink hover:bg-[#200D0D08]">
          Try again
        </button>
        <button type="button" onClick={onFill} className="h-8 rounded-lg px-3 text-[13px]/4 font-medium text-ink underline decoration-[#200D0D4D] underline-offset-[3px] hover:decoration-ink">
          Fill it in yourself
        </button>
      </div>
    </div>
  );
}

/** 503 not_configured / route not deployed yet: nothing is wrong, the agent is just not live. */
function ComingOnline({ onFill }: { onFill: () => void }) {
  return (
    <section role="status" className="flex flex-col gap-4 rounded-xl border border-panel-line bg-panel p-6">
      <div className="flex items-center gap-2">
        <span className="size-1.5 shrink-0 rounded-full bg-green" />
        <h2 className="text-[15px]/4.5 font-medium text-ink">Finding leads needs the Naive agent; coming online</h2>
      </div>
      <p className="text-[13px]/5 font-medium text-muted">
        The agent that reads your site and proposes who to sell to is still being set up. Nothing is lost: fill in your profile yourself now, or
        connect your own agent over MCP and set up from there.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={cx(bigButton, "h-10 px-4 text-sm/4.5")} onClick={onFill}>
          Continue and fill it in yourself
          <ArrowIcon />
        </button>
        <Link to="/app?connect=1" className="inline-flex h-10 items-center rounded-[10px] border border-ink bg-white px-4 text-sm/4.5 font-semibold text-ink hover:bg-[#200D0D08]">
          Connect your agent
        </Link>
      </div>
    </section>
  );
}
