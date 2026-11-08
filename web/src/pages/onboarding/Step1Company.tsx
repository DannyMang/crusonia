// Onboarding · 1 Your company (Paper artboard 2K2B-0): the website (or a description) the agent reads on
// step 2. Nothing paid happens here; Continue only stores the input and moves on.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { cleanWebsite, clearWebsite, peekWebsite } from "../../components/auth/flow.ts";
import type { Profile } from "../../api.ts";
import { ChevronRight } from "../../components/icons.tsx";
import { getOnboarding, patchOnboarding, resetOnboarding } from "../../components/onboarding/store.ts";
import { ArrowIcon, bigButton, PencilIcon, StepTitle } from "../../components/onboarding/ui.tsx";
import { cx, plural, timeAgo } from "../../lib/format.ts";
import { useProfile } from "../../queries.ts";

/** "fieldnote.io/about" from whatever was typed or pasted ("https://www.Fieldnote.io/about/"). */
function cleanUrl(raw: string) {
  return raw
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/\/+$/, "");
}

function validHost(v: string) {
  try {
    const u = new URL(`https://${v}`);
    return /\.[a-z]{2,}$/i.test(u.hostname) && !/\s/.test(v);
  } catch {
    return false;
  }
}

export default function Step1Company() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const stored = getOnboarding();
  // The website typed on the landing page: ?website= (signed-in visitors) or remembered through sign-up.
  const [incoming] = useState(() => cleanWebsite(params.get("website")) ?? peekWebsite());
  const [mode, setMode] = useState<"url" | "describe">(stored.description && !stored.url && !incoming ? "describe" : "url");
  const [url, setUrl] = useState(() => incoming ?? cleanUrl(stored.url ?? ""));
  const [description, setDescription] = useState(stored.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const profile = useProfile();

  // The visitor already asked for this site on the landing page, so go straight to reading it (step 2 starts
  // the crawl and the proposal once). With a saved profile we only prefill: they can review it instead.
  const started = useRef(false);
  useEffect(() => {
    if (!incoming || started.current || profile.isPending) return;
    started.current = true;
    clearWebsite();
    if (profile.data) return;
    const full = `https://${incoming}`;
    const s = getOnboarding();
    if (s.url !== full || s.description) resetOnboarding({ url: full });
    navigate("/onboarding/2", { replace: true });
  }, [incoming, profile.isPending, profile.data, navigate]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const s = getOnboarding();
    if (mode === "url") {
      const v = cleanUrl(url);
      if (!validHost(v)) {
        setError("Enter your website's address, like acme.com");
        return;
      }
      const full = `https://${v}`;
      // Same site as the run already in progress: pick that run up instead of paying for a new one.
      if (s.url !== full || s.description) resetOnboarding({ url: full });
    } else {
      const v = description.trim();
      if (v.length < 20) {
        setError("Tell us a bit more: what you sell and who it is for.");
        return;
      }
      if (s.description !== v || s.url) resetOnboarding({ description: v });
    }
    navigate("/onboarding/2");
  }

  return (
    <div className="flex grow justify-center px-6 pb-16 pt-20 lg:pt-33">
      <form className="flex w-full max-w-100 flex-col" onSubmit={submit} noValidate>
        <StepTitle step={1} title="What's your website?" subtitle="We'll read it and propose who to sell to. You confirm before a single lead is found." />
        <div className="flex flex-col gap-3 pt-8">
          {mode === "url" ? (
            <label
              className={cx(
                "flex h-12 shrink-0 cursor-text items-center rounded-[10px] border bg-white px-4 transition-[border-color,box-shadow]",
                error ? "border-[#B42318]" : "border-[#200D0D24] focus-within:border-ink focus-within:[box-shadow:#BDE68966_0px_0px_0px_3px]",
              )}
            >
              <span className="sr-only">Your website</span>
              <span aria-hidden className="text-sm/5 font-medium text-faint">
                https://
              </span>
              <input
                autoFocus
                name="website"
                inputMode="url"
                autoComplete="url"
                spellCheck={false}
                autoCapitalize="none"
                placeholder="yourcompany.com"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value.replace(/^[a-z]+:\/\//i, ""));
                  setError(null);
                }}
                aria-invalid={error ? true : undefined}
                className="h-full min-w-0 grow bg-transparent pl-0.5 text-sm/5 font-medium text-ink caret-ink outline-none placeholder:text-[#200D0D4D] focus-visible:outline-none"
              />
            </label>
          ) : (
            <label className="flex flex-col">
              <span className="sr-only">What you're building</span>
              <textarea
                autoFocus
                name="description"
                rows={5}
                placeholder="What you sell, who it's for, and who buys it today. A few sentences is enough."
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  setError(null);
                }}
                aria-invalid={error ? true : undefined}
                className={cx(
                  "w-full resize-y rounded-[10px] border bg-white px-4 py-3 text-sm/5.25 font-medium text-ink outline-none transition-[border-color,box-shadow] placeholder:font-[450] placeholder:text-[#200D0D66] focus-visible:outline-none",
                  error ? "border-[#B42318]" : "border-[#200D0D24] focus:border-ink focus:[box-shadow:#BDE68966_0px_0px_0px_3px]",
                )}
              />
            </label>
          )}
          {error ? (
            <div role="alert" className="-mt-1 text-[13px]/4.5 font-medium text-[#B42318]">
              {error}
            </div>
          ) : null}
          <button type="submit" className={bigButton}>
            Continue
            <ArrowIcon />
          </button>
        </div>
        <div className="flex flex-col gap-5 pt-5">
          <button
            type="button"
            onClick={() => {
              setMode((m) => (m === "url" ? "describe" : "url"));
              setError(null);
            }}
            className="flex items-center gap-2 self-start text-sm/4.5 font-medium text-ink underline decoration-[#200D0D4D] decoration-1 underline-offset-[3px] hover:decoration-ink"
          >
            <PencilIcon size={14} className="text-muted" />
            {mode === "url" ? "or tell us what you're building" : "or use your website instead"}
          </button>
          <div className="h-px shrink-0 bg-[#200D0D14]" />
          <Link to="/app/connect" className="flex items-start gap-3 rounded-[10px] border border-panel-line bg-panel px-4 py-3.5 transition-colors hover:border-[#C9DDB6]">
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="shrink-0">
              <rect x="2.25" y="3.75" width="13.5" height="11.25" rx="2" fill="none" stroke="#16A34A" strokeWidth="1.3" />
              <path d="M5.25 7.5l2.25 2.25-2.25 2.25M9 12h3.75" fill="none" stroke="#16A34A" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div className="flex grow basis-0 flex-col gap-0.75">
              <div className="text-sm/4.5 font-medium text-ink">Connect your agent instead</div>
              <div className="text-[13px]/4.5 font-medium text-muted">Already in Claude Code, Cursor or Codex? Set up from there over MCP.</div>
            </div>
            <ChevronRight className="self-center text-green" />
          </Link>
          {profile.data ? <SavedProfileCard profile={profile.data} /> : null}
        </div>
      </form>
    </div>
  );
}

/** Shown when a profile is already saved: skip the paid read and review it on step 3. */
function SavedProfileCard({ profile }: { profile: Profile }) {
  const navigate = useNavigate();
  const bits = [
    profile.company || profile.website?.replace(/^https?:\/\//, "") || null,
    plural(profile.segments?.length ?? 0, "segment"),
    plural(profile.signals?.length ?? 0, "buying signal"),
    profile.updated_at ? `saved ${timeAgo(profile.updated_at)}` : null,
  ].filter(Boolean);
  return (
    <button
      type="button"
      onClick={() => {
        // Review what is saved, not an older proposal or draft from this tab.
        patchOnboarding({ proposal: undefined, draft: undefined, manual: false });
        navigate("/onboarding/3");
      }}
      className="flex items-start gap-3 rounded-[10px] border border-[#200D0D1A] bg-white px-4 py-3.5 text-left transition-colors hover:bg-[#200D0D05]"
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="shrink-0">
        <circle cx="9" cy="9" r="7" fill="none" stroke="#16A34A" strokeWidth="1.3" />
        <path d="M6 9.25l2.1 2.1L12.25 7" fill="none" stroke="#16A34A" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="flex grow basis-0 flex-col gap-0.75">
        <div className="text-sm/4.5 font-medium text-ink">Review your profile</div>
        <div className="text-[13px]/4.5 font-medium text-muted">You already have one: {bits.join(" · ")}.</div>
      </div>
      <ChevronRight className="self-center text-green" />
    </button>
  );
}
