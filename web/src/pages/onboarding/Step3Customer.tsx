// Onboarding · 3 Your ideal customer (Paper artboard 2L8A-0): the proposed (or saved, or empty) profile,
// editable in place. "Find my first 3 leads" saves it (PUT /api/profile) and then starts the paid search
// (POST /api/leads/find {count: 3}) on that one click. Unchecked signals are not saved.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { isApiError } from "../../api.ts";
import { useApi } from "../../auth.tsx";
import { BrandTile, type BrandName } from "../../components/BrandLogo.tsx";
import { QueryError, Skeleton } from "../../components/ui.tsx";
import {
  emptyDraft,
  fromProfile,
  isDraft,
  keptSegments,
  keptSignals,
  newKey,
  segmentHasContent,
  toInput,
  type ProfileDraft,
  type SegmentDraft,
  type SignalDraft,
} from "../../components/onboarding/draft.ts";
import { AutoTextarea, BoxInput, Checkbox, InlineInput, RolesInput } from "../../components/onboarding/fields.tsx";
import { getOnboarding, patchOnboarding, useOnboarding } from "../../components/onboarding/store.ts";
import { ArrowIcon, bigButton, FromSources, PencilIcon, StepTitle } from "../../components/onboarding/ui.tsx";
import { cx } from "../../lib/format.ts";
import { keys, useOwnerWorkspace, useProfile } from "../../queries.ts";

const TARGET = 3;
const card = "flex flex-col rounded-xl border border-[#200D0D1A] bg-white";
const cardTitle = "text-[15px]/4.5 font-medium text-ink";

/** Where step 3 starts: unsaved edits, then this run's proposal, then (unless "fill it in yourself") the saved profile. */
function initialDraft(): ProfileDraft | null {
  const s = getOnboarding();
  if (isDraft(s.draft)) return s.draft;
  if (s.proposal) return fromProfile(s.proposal, "proposal", s.url);
  if (s.manual || (s.propose?.status === "done" && s.proposal === null)) return emptyDraft(s.url);
  return null;
}

export default function Step3Customer() {
  const profile = useProfile();
  const [draft, setDraft] = useState<ProfileDraft | null>(initialDraft);

  // No draft from this tab: start from the saved profile, or empty if there is none (or the route is not live).
  const calmError = isApiError(profile.error) && (profile.error.notConfigured || profile.error.missingRoute || profile.error.status === 404);
  useEffect(() => {
    if (draft) return;
    if (profile.data !== undefined) setDraft(profile.data ? fromProfile(profile.data, "saved") : emptyDraft(getOnboarding().url));
    else if (calmError) setDraft(emptyDraft(getOnboarding().url));
  }, [draft, profile.data, calmError]);

  // Keep edits across a reload or a trip back to step 1.
  useEffect(() => {
    if (draft) patchOnboarding({ draft });
  }, [draft]);

  const title = draft?.origin === "empty" ? "Who buys from you?" : draft?.origin === "saved" ? "Your ideal customer" : "Here's who we think buys from you";

  return (
    <div className="flex grow justify-center px-6 pb-18 pt-14">
      <div className="flex w-full max-w-260 flex-col gap-8">
        <StepTitle step={3} title={title} />
        {draft ? (
          <Editor draft={draft} setDraft={setDraft} />
        ) : profile.isError && !calmError ? (
          <QueryError error={profile.error} what="your saved profile" onRetry={() => void profile.refetch()} />
        ) : (
          <EditorSkeleton />
        )}
      </div>
    </div>
  );
}

type SetDraft = React.Dispatch<React.SetStateAction<ProfileDraft | null>>;

function Editor({ draft, setDraft }: { draft: ProfileDraft; setDraft: SetDraft }) {
  // CRM sync runs only for the owner workspace: elsewhere there's nothing to connect yet.
  const owner = useOwnerWorkspace() === true;
  const update = (fn: (d: ProfileDraft) => ProfileDraft) => setDraft((d) => (d ? fn(d) : d));
  const [errors, setErrors] = useState<{ sells?: string; icp?: string; segment?: string }>({});
  const site = draft.website;
  const icpSources = draft.otherSources.filter((s) => s.field === "icp_description").map((s) => s.url);
  const sellsSources = draft.otherSources.filter((s) => s.field === "sells").map((s) => s.url);
  const icpRef = useRef<HTMLTextAreaElement>(null);
  const sellsRef = useRef<HTMLTextAreaElement>(null);

  function validate() {
    const next: typeof errors = {};
    if (draft.askSells && !draft.sells.trim()) next.sells = "Say what you sell in a sentence or two.";
    if (!draft.icp_description.trim()) next.icp = "Describe your ideal customer first. The agent searches with this.";
    next.segment = draft.segments.find((s) => !s.name.trim() && segmentHasContent(s))?.key;
    setErrors(next);
    if (next.sells) sellsRef.current?.focus();
    else if (next.icp) icpRef.current?.focus();
    else if (next.segment) document.getElementById(`seg-${next.segment}-name`)?.focus();
    return !next.sells && !next.icp && !next.segment;
  }

  return (
    <div className="flex flex-col items-start gap-6 lg:flex-row">
      <div className="flex w-full min-w-0 grow basis-0 flex-col gap-4">
        {draft.askSells ? (
          <TextCard
            label="What you sell"
            id="profile-sells"
            textareaRef={sellsRef}
            value={draft.sells}
            placeholder="What you sell, who it is for and the outcome it delivers."
            onChange={(v) => {
              update((d) => ({ ...d, sells: v }));
              setErrors((e) => ({ ...e, sells: undefined }));
            }}
            error={errors.sells}
            sources={<FromSources urls={sellsSources} site={site} />}
          />
        ) : null}
        <TextCard
          label="Ideal customer"
          id="profile-icp"
          textareaRef={icpRef}
          value={draft.icp_description}
          placeholder="Industries, company size, stage and the people you sell to. For example: seed to Series A B2B software companies, 10 to 80 people, where the founder still runs sales."
          onChange={(v) => {
            update((d) => ({ ...d, icp_description: v }));
            setErrors((e) => ({ ...e, icp: undefined }));
          }}
          error={errors.icp}
          sources={<FromSources urls={icpSources} site={site} />}
        />
        <Segments
          segments={draft.segments}
          site={site}
          errorKey={errors.segment}
          onChange={(segments) => {
            update((d) => ({ ...d, segments }));
            setErrors((e) => ({ ...e, segment: undefined }));
          }}
        />
        <Signals signals={draft.signals} site={site} onChange={(signals) => update((d) => ({ ...d, signals }))} />
      </div>
      <aside className="flex w-full shrink-0 flex-col gap-4 lg:w-85">
        {owner ? <Sharpen /> : null}
        <RunCard draft={draft} validate={validate} />
        <Link to="/onboarding/1" className="flex items-center justify-center gap-1.5 text-[13px]/4 font-medium text-muted hover:text-ink">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden className="shrink-0">
            <path d="M10 4L6 8l4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back to your website
        </Link>
      </aside>
    </div>
  );
}

// ---------- ideal customer / what you sell ----------

function TextCard({
  label,
  id,
  value,
  placeholder,
  onChange,
  error,
  sources,
  textareaRef,
}: {
  label: string;
  id: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  error?: string;
  sources: ReactNode;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <section className={cx(card, "gap-3 p-6")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className={cardTitle}>
          {label}
        </label>
        {sources}
      </div>
      <label
        htmlFor={id}
        className={cx(
          "flex cursor-text gap-3 rounded-lg border py-3 pl-3.5 pr-3 transition-[border-color,box-shadow]",
          error ? "border-[#B42318]" : "border-[#200D0D1A] hover:border-[#200D0D33] focus-within:border-ink focus-within:[box-shadow:#BDE68966_0px_0px_0px_3px]",
        )}
      >
        <AutoTextarea
          ref={textareaRef}
          id={id}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          className="min-h-5.25 grow basis-0 text-sm/5.25 font-medium text-ink placeholder:font-[450] placeholder:text-[#200D0D66]"
        />
        <PencilIcon size={14} className="mt-0.5 text-[#200D0D66]" />
      </label>
      {error ? (
        <div role="alert" className="text-[13px]/4.5 font-medium text-[#B42318]">
          {error}
        </div>
      ) : null}
    </section>
  );
}

// ---------- segments ----------

function CountChip({ n }: { n: number }) {
  return <span className="flex h-4.5 items-center rounded-full bg-[#200D0D14] px-1.5 text-xs/3 font-medium tabular-nums text-muted">{n}</span>;
}

function AddButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex h-7 shrink-0 items-center rounded-md border border-[#200D0D1A] px-2.5 text-xs/4 font-medium text-ink hover:bg-[#200D0D08]">
      {children}
    </button>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="-my-1 -mr-1.5 flex size-6 shrink-0 items-center justify-center rounded-md text-[#200D0D66] hover:bg-[#200D0D0A] hover:text-ink">
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
        <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </button>
  );
}

function Segments({ segments, site, errorKey, onChange }: { segments: SegmentDraft[]; site: string; errorKey?: string; onChange: (s: SegmentDraft[]) => void }) {
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const set = (key: string, patch: Partial<SegmentDraft>) => onChange(segments.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  return (
    <section className={cx(card, "gap-3 p-6")} aria-label="Segments">
      <div className="flex items-center gap-2">
        <h2 className={cardTitle}>Segments</h2>
        <CountChip n={segments.length} />
        <span className="grow basis-0" />
        <AddButton
          onClick={() => {
            const key = newKey();
            onChange([...segments, { key, name: "", company_size: "", industry: "", roles: [], sources: [] }]);
            setFocusKey(key);
          }}
        >
          + Add segment
        </AddButton>
      </div>
      {segments.length ? (
        segments.map((s, i) => (
          <SegmentCard
            key={s.key}
            s={s}
            i={i}
            site={site}
            autoFocus={focusKey === s.key}
            nameError={errorKey === s.key}
            set={(patch) => set(s.key, patch)}
            remove={() => onChange(segments.filter((x) => x.key !== s.key))}
          />
        ))
      ) : (
        <p className="rounded-[10px] border border-dashed border-[#200D0D26] px-4 py-3.5 text-[13px]/5 font-medium text-muted">
          No segments yet. A segment is one group you sell to, like “Seed-stage devtools, 10 to 50 people, founders and heads of growth”. Optional, but
          it helps the agent search.
        </p>
      )}
    </section>
  );
}

function SegmentCard({
  s,
  i,
  site,
  autoFocus,
  nameError,
  set,
  remove,
}: {
  s: SegmentDraft;
  i: number;
  site: string;
  autoFocus: boolean;
  nameError: boolean;
  set: (p: Partial<SegmentDraft>) => void;
  remove: () => void;
}) {
  const id = `seg-${s.key}`;
  return (
    <div className={cx("flex flex-col gap-3 rounded-[10px] border p-4", nameError ? "border-[#B42318]" : "border-[#200D0D1A]")}>
      <div className="flex items-center gap-2">
        <span className="w-4.5 shrink-0 text-xs/4 font-medium tabular-nums text-muted">{String(i + 1).padStart(2, "0")}</span>
        <label className="flex min-w-0 cursor-text items-center gap-2">
          <span className="sr-only">Segment name</span>
          <InlineInput
            id={`${id}-name`}
            autoFocus={autoFocus}
            value={s.name}
            aria-invalid={nameError || undefined}
            placeholder="Name this segment"
            onChange={(e) => set({ name: e.target.value })}
            className="max-w-full text-[15px]/4.5 font-semibold tracking-[-0.01em]"
          />
          <PencilIcon size={13} className="text-[#200D0D66]" />
        </label>
        <span className="grow basis-0" />
        <FromSources urls={s.sources} site={site} className="hidden sm:flex" />
        <RemoveButton label="Remove segment" onClick={remove} />
      </div>
      {nameError ? (
        <div role="alert" className="-mt-1 pl-6.5 text-[13px]/4.5 font-medium text-[#B42318]">
          Name this segment, or remove it.
        </div>
      ) : null}
      <div className="flex flex-col gap-2.5 pl-6.5 sm:flex-row">
        <div className="flex w-full shrink-0 flex-col gap-1.25 sm:w-30">
          <label htmlFor={`${id}-size`} className="text-xs/4 font-medium text-faint">
            Company size
          </label>
          <BoxInput id={`${id}-size`} value={s.company_size} placeholder="10–50" onChange={(e) => set({ company_size: e.target.value })} />
        </div>
        <div className="flex w-full shrink-0 flex-col gap-1.25 sm:w-40">
          <label htmlFor={`${id}-industry`} className="text-xs/4 font-medium text-faint">
            Industry
          </label>
          <BoxInput id={`${id}-industry`} value={s.industry} placeholder="Developer tools" onChange={(e) => set({ industry: e.target.value })} />
        </div>
        <div className="flex min-w-0 grow basis-0 flex-col gap-1.25">
          <label htmlFor={`${id}-roles`} className="text-xs/4 font-medium text-faint">
            Roles
          </label>
          <RolesInput id={`${id}-roles`} roles={s.roles} onChange={(roles) => set({ roles })} />
        </div>
      </div>
    </div>
  );
}

// ---------- buying signals ----------

function Signals({ signals, site, onChange }: { signals: SignalDraft[]; site: string; onChange: (s: SignalDraft[]) => void }) {
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const set = (key: string, patch: Partial<SignalDraft>) => onChange(signals.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const kept = signals.filter((s) => s.checked && s.name.trim()).length;
  return (
    <section className={cx(card, "px-6 pb-2 pt-6")} aria-label="Buying signals">
      <div className="flex items-center gap-2 pb-1.5">
        <h2 className={cardTitle}>Buying signals</h2>
        <CountChip n={kept} />
        <span className="grow basis-0" />
        <AddButton
          onClick={() => {
            const key = newKey();
            onChange([...signals, { key, name: "", description: "", checked: true, sources: [] }]);
            setFocusKey(key);
          }}
        >
          + Add signal
        </AddButton>
      </div>
      {signals.length ? (
        signals.map((s) => (
          <div key={s.key} className="flex items-start gap-3 border-t border-t-[#200D0D0F] py-3.5">
            <Checkbox checked={s.checked} onChange={(checked) => set(s.key, { checked })} label={`Use “${s.name || "this signal"}”`} />
            <div className={cx("flex min-w-0 grow basis-0 flex-col gap-1 transition-opacity", !s.checked && "opacity-50")}>
              <label className="flex min-w-0 cursor-text items-center gap-2">
                <span className="sr-only">Signal name</span>
                <InlineInput
                  autoFocus={focusKey === s.key}
                  value={s.name}
                  placeholder="Name the signal, e.g. Hiring first SDR"
                  onChange={(e) => set(s.key, { name: e.target.value })}
                  className="max-w-full text-sm/4.5 font-semibold"
                />
                <PencilIcon size={13} className="text-[#200D0D66]" />
              </label>
              <label className="block">
                <span className="sr-only">What it looks like</span>
                <AutoTextarea
                  value={s.description}
                  placeholder="What it looks like, e.g. an SDR job post at a company with no sales team yet"
                  onChange={(e) => set(s.key, { description: e.target.value })}
                  className="-mx-1 rounded-md px-1 text-[13px]/4.5 font-medium text-muted placeholder:text-[#200D0D4D] hover:bg-[#200D0D08] focus:[box-shadow:0_0_0_1px_#200D0D,0_0_0_4px_#BDE68966]"
                />
              </label>
            </div>
            <FromSources urls={s.sources} site={site} className="hidden sm:flex" />
          </div>
        ))
      ) : (
        <p className="mb-4 rounded-[10px] border border-dashed border-[#200D0D26] px-4 py-3.5 text-[13px]/5 font-medium text-muted">
          No signals yet. A signal is something you can see from outside that says a company may buy now, like “hiring their first SDR” or “raised
          a Series A in the last 90 days”.
        </p>
      )}
    </section>
  );
}

// ---------- right column ----------

function Sharpen() {
  return (
    <section className={cx(card, "gap-3.5 p-6")} aria-label="Make it sharper">
      <div className="flex items-center gap-2">
        <h2 className={cardTitle}>Make it sharper</h2>
        <span className="flex h-5 items-center rounded-full bg-pill px-2 text-[11px]/3.5 font-medium text-muted">Optional</span>
      </div>
      <ConnectRow logo="hubspot" label="Connect HubSpot" />
      <ConnectRow logo="notion" label="Connect Notion" />
    </section>
  );
}

function ConnectRow({ logo, label }: { logo: BrandName; label: string }) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2.5 rounded-[10px] border border-[#200D0D1A] pl-2.5 pr-2">
      <BrandTile name={logo} size={26} mark={16} />
      <span className="grow basis-0 text-sm/4.5 font-medium text-ink">{label}</span>
      <Link to="/app/integrations" className="flex h-7.5 items-center rounded-lg border border-[#200D0D26] px-3 text-[13px]/4 font-medium text-ink hover:bg-[#200D0D08]" aria-label={label}>
        Connect
      </Link>
    </div>
  );
}

type Phase = "idle" | "saving" | "finding";

function RunCard({ draft, validate }: { draft: ProfileDraft; validate: () => boolean }) {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const run = useOnboarding().leads;
  const [phase, setPhase] = useState<Phase>("idle");
  const [saveError, setSaveError] = useState<unknown>(null);
  const [findError, setFindError] = useState<unknown>(null);
  const busy = useRef(false);
  const segments = keptSegments(draft).length;
  const signals = keptSignals(draft).length;
  const findCalm = isApiError(findError) && (findError.notConfigured || findError.missingRoute);

  async function save(): Promise<boolean> {
    try {
      const saved = await api.saveProfile(toInput(draft));
      if (saved) qc.setQueryData(keys.profile, saved);
      else void qc.invalidateQueries({ queryKey: keys.profile });
      void qc.invalidateQueries({ queryKey: keys.status });
      return true;
    } catch (err) {
      setSaveError(err);
      return false;
    }
  }

  async function start() {
    if (busy.current || !validate()) return;
    busy.current = true;
    setSaveError(null);
    setFindError(null);
    try {
      setPhase("saving");
      if (!(await save())) return;
      // A search from this onboarding is already running: save the edits, do not pay for a second one.
      if (run) {
        patchOnboarding({ draft: undefined });
        navigate("/onboarding/4");
        return;
      }
      setPhase("finding");
      try {
        const res = await api.findLeads(TARGET);
        patchOnboarding({ leads: { sessionId: res.session_id, target: TARGET, startedAt: Date.now() }, draft: undefined });
        navigate("/onboarding/4");
      } catch (err) {
        setFindError(err);
      }
    } finally {
      busy.current = false;
      setPhase("idle");
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-panel-line bg-panel p-6" aria-label="Summary">
      <dl className="flex flex-col gap-2.5 text-[13px]/4 font-medium">
        <div className="flex justify-between">
          <dt className="text-muted">Segments</dt>
          <dd className="text-ink">{segments}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Buying signals</dt>
          <dd className="text-ink">{signals}</dd>
        </div>
      </dl>
      {saveError ? <QueryError error={saveError} what="saving your profile" /> : null}
      {findCalm ? (
        <div role="status" className="flex flex-col gap-3 rounded-[10px] border border-panel-line bg-white px-4 py-3.5">
          <div className="flex flex-col gap-0.5 text-[13px]/5">
            <div className="font-semibold text-ink">Your profile is saved</div>
            <div className="font-medium text-muted">Finding leads needs the Naive agent; coming online. Your agents start from this profile as soon as it is live.</div>
          </div>
          <Link to="/app" className={cx(bigButton, "h-10 text-sm/4.5")}>
            Go to dashboard
            <ArrowIcon />
          </Link>
        </div>
      ) : (
        <>
          {findError ? <QueryError error={findError} what="finding leads" /> : null}
          <button type="button" className={cx(bigButton, "w-full")} onClick={() => void start()} disabled={phase !== "idle"} aria-busy={phase !== "idle" || undefined}>
            {phase === "saving" ? "Saving your profile…" : phase === "finding" ? "Starting the search…" : run ? "Save and see your leads" : `Find my first ${TARGET} leads`}
            {phase === "idle" ? <ArrowIcon /> : null}
          </button>
          <p className="text-center text-xs/4.25 font-medium text-muted">Research only. Nothing sends without your OK.</p>
        </>
      )}
    </section>
  );
}

function EditorSkeleton() {
  return (
    <div className="flex flex-col items-start gap-6 lg:flex-row" aria-busy="true" aria-label="Loading your profile">
      <div className="flex w-full grow basis-0 flex-col gap-4">
        {[96, 280, 200].map((h) => (
          <div key={h} className={cx(card, "gap-3 p-6")}>
            <Skeleton className="h-4.5 w-40" />
            <Skeleton className="w-full" />
            <div style={{ height: h - 60 }} />
          </div>
        ))}
      </div>
      <div className="flex w-full shrink-0 flex-col gap-4 lg:w-85">
        <Skeleton className="h-60 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    </div>
  );
}
