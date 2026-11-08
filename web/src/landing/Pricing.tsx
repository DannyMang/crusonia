// Public pricing at /pricing (Paper: naive > "Pricing · proposal"): the tier cards, the self-host note and "How
// billing works". Tiers, prices and credit amounts come from src/billing/catalog.ts, the same code that builds
// GET /api/billing, imported directly because /api/billing needs a signed-in caller; nothing here is typed by hand.
// The proposal's "Plan limits" matrix and per-operation rate card are left out: plans.ts does not define or enforce
// those numbers yet (only agent time is metered), so they would be promises the product does not keep.
// CTAs: signed out -> /sign-up; signed in -> Stripe Checkout for that plan (Free -> /app).
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { isApiError, type CatalogPlan } from "../api.ts";
import { useApi, useSession } from "../auth.tsx";
import { Spinner } from "../components/icons.tsx";
import { errorCopy } from "../components/ui.tsx";
import { creditFacts, hasLiveSubscription, leadsFor, packCatalog, planCatalog, planLabel, PLAN_TAGS, priceAmount, TYPICAL_LEAD_CREDITS } from "../lib/billing.ts";
import { cx, num } from "../lib/format.ts";
import { useBilling, usePublicConfig } from "../queries.ts";
import { GITHUB_URL, GitHubMark, SiteNav } from "./SiteNav.tsx";

const TITLE = "Pricing · Crusonia";

const PLANS = planCatalog();
const PACKS = packCatalog();
const CREDIT = creditFacts();
const SMALLEST_PACK = PACKS[0]!;
const FEATURED = "pro";

const credits$ = (credits: number) => `$${num(Math.round(credits * CREDIT.usd))}`;
const rollover = CREDIT.included_rollover_months ? `${CREDIT.included_rollover_months} mo` : "No";

export default function Pricing() {
  useEffect(() => {
    const previous = document.title;
    document.title = TITLE;
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <div className="min-h-screen bg-white text-ink [font-synthesis:none]">
      <SiteNav page="pricing" />
      <main className="mx-auto flex w-full max-w-[1440px] flex-col gap-20 px-5 pb-24 pt-12 sm:px-10 lg:gap-28 lg:px-20 lg:pb-36 lg:pt-18">
        <h1 className="sr-only">Crusonia pricing</h1>
        <section aria-label="Plans" className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 lg:flex-row">
            {PLANS.map((p) => (
              <TierCard key={p.key} plan={p} />
            ))}
          </div>
          <div className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-[#200D0D14] px-7 py-5 md:flex-row md:items-center md:gap-6">
            <p className="flex flex-col gap-1 text-[15px]/5.5 md:flex-row md:items-center md:gap-3.5">
              <span className="font-semibold text-ink">Rather run it yourself?</span>
              <span className="font-medium text-muted">
                Crusonia is MIT open source. Self-host it free on your own Cloudflare and Neon, with your own provider keys and no caps.
              </span>
            </p>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="flex shrink-0 items-center gap-2">
              <GitHubMark size={16} />
              <span className="text-[15px]/5.5 font-semibold text-ink underline decoration-1 underline-offset-4">Get the code</span>
            </a>
          </div>
        </section>

        <section aria-labelledby="billing-title" className="flex flex-col gap-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
            <h2 id="billing-title" className="text-[32px]/10 font-semibold tracking-[-0.035em] sm:text-[40px]/11">
              How billing works
            </h2>
            <p className="text-[15px]/5.5 font-medium text-muted">1 credit = {`$${CREDIT.usd.toFixed(2)}`} · same rates on every plan</p>
          </div>
          <ol className="flex flex-col overflow-clip rounded-[20px] border border-[#200D0D14] bg-white md:flex-row">
            <Step n={1} title="Start with credit">
              Free starts with {num(CREDIT.free_sample_credits)} credits, then top up from {SMALLEST_PACK.price}. Paid plans add their price back as credit every
              month.
            </Step>
            <Step n={2} title="Meter as it works">
              Hosted agent time is drawn from credit as it runs, at {CREDIT.usage_markup}× its provider cost. A researched lead is about {TYPICAL_LEAD_CREDITS}{" "}
              credits.
            </Step>
            <Step n={3} title="Stop and it stops" last>
              Nothing sends without your yes, and one switch pauses every email and new agent run.
            </Step>
          </ol>
        </section>
      </main>
    </div>
  );
}

function Step({ n, title, last, children }: { n: number; title: string; last?: boolean; children: ReactNode }) {
  return (
    <li className={cx("flex grow basis-0 flex-col gap-2.5 px-6 py-7", !last && "border-b border-[#200D0D14] md:border-b-0 md:border-r")}>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink text-[13px]/4 font-bold text-white">{n}</span>
      <h3 className="pt-2 text-[19px]/6 font-semibold tracking-[-0.015em] text-ink">{title}</h3>
      <p className="text-sm/5.25 font-medium text-muted">{children}</p>
    </li>
  );
}

type Bullet = { value: string; text: string };

function bulletsFor(p: CatalogPlan): Bullet[] {
  const mcp = { value: "MCP", text: "for Claude Code, Cursor, Codex" };
  if (p.kind === "free")
    return [
      { value: num(CREDIT.free_sample_credits), text: "free credits to start" },
      { value: SMALLEST_PACK.price, text: `buys ${num(SMALLEST_PACK.credits)} credits that never expire` },
      mcp,
    ];
  return [
    { value: num(p.monthly_credits), text: "credits every month" },
    { value: rollover, text: "rollover for unused credit" },
    { value: SMALLEST_PACK.price, text: "top-ups at the same rate" },
    mcp,
  ];
}

function blurb(p: CatalogPlan): string {
  if (p.kind === "free") {
    const n = leadsFor(CREDIT.free_sample_credits);
    return `We host it. Your first ${num(CREDIT.free_sample_credits)} credits are free, about ${n} researched leads; after that, ${SMALLEST_PACK.price} buys ${num(SMALLEST_PACK.credits)} credits.`;
  }
  const leads = `${num(p.monthly_credits)} credits a month, about ${num(leadsFor(p.monthly_credits))} researched leads.`;
  return p.key === FEATURED ? `The fee comes back as credit at the same rates: ${leads}` : `Room for several plays at once, at the same rates: ${leads}`;
}

function TierCard({ plan: p }: { plan: CatalogPlan }) {
  const featured = p.key === FEATURED;
  const tag = PLAN_TAGS[p.key];
  const name = planLabel(p.name);
  return (
    <div
      className={cx(
        "flex min-w-0 grow basis-0 flex-col gap-6 rounded-[20px] bg-white px-7 pb-7 pt-7.5",
        featured ? "border-[1.5px] border-ink" : "border border-[#200D0D14]",
      )}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-[22px]/7 font-semibold tracking-[-0.02em] text-ink">{name}</h2>
        {tag ? (
          <span className={cx("rounded-full px-2.75 py-1.25 text-xs/4 font-medium", featured ? "bg-lime text-ink" : "border border-[#200D0D14] text-muted")}>{tag}</span>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="text-6xl/14.25 font-semibold tracking-tighter text-ink">{priceAmount(p.price)}</div>
        <div className="text-sm/4.5 font-medium text-muted">
          {p.kind === "free" ? `no monthly fee · credits from ${SMALLEST_PACK.price}` : `per month · includes ${credits$(p.monthly_credits)} of credit`}
        </div>
      </div>
      <p className="shrink-0 text-[15px]/5.5 font-medium text-muted lg:h-16.5">{blurb(p)}</p>
      <TierCta plan={p} featured={featured} />
      {featured ? (
        <div className="flex items-center gap-2 rounded-xl border border-[#200D0D14] bg-white p-3.5" aria-label={`${priceAmount(p.price)} fee becomes ${num(p.monthly_credits)} credits, about ${num(leadsFor(p.monthly_credits))} researched leads`}>
          <Figure value={priceAmount(p.price)} label="Fee" />
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="shrink-0">
            <path d="M3 9h11M10 5l4 4-4 4" fill="none" stroke="#200D0D" strokeWidth="1.5" />
          </svg>
          <Figure value={num(p.monthly_credits)} label="Credits" />
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="shrink-0">
            <path d="M3 7h12M3 11h12" fill="none" stroke="#200D0D" strokeWidth="1.5" />
          </svg>
          <Figure value={`~${num(leadsFor(p.monthly_credits))}`} label="Leads" />
        </div>
      ) : null}
      <ul className="flex flex-col gap-2.25 pt-1">
        {bulletsFor(p).map((b) => (
          <li key={b.text} className="flex items-center gap-2.5 text-sm/4.5">
            <span aria-hidden className="size-1.5 shrink-0 bg-ink" />
            <span className="font-semibold text-ink">{b.value}</span>
            <span className="font-medium text-muted">{b.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex grow basis-0 flex-col items-center gap-0.75">
      <span className="text-xl/6 font-semibold tracking-[-0.03em] text-ink">{value}</span>
      <span className="text-[13px]/4 font-medium text-muted">{label}</span>
    </div>
  );
}

const ctaClass = (featured: boolean) =>
  cx(
    "flex h-11.5 shrink-0 items-center justify-center gap-2 rounded-full text-[15px]/4.5 font-semibold text-ink transition-colors disabled:cursor-default disabled:opacity-60",
    featured ? "bg-lime hover:bg-[#b3de7a]" : "border border-[#200D0D33] bg-white hover:bg-[#200D0D08]",
  );

/** Signed out: /sign-up. Signed in: Free opens the app, paid plans go to Stripe Checkout (or billing when subscribed). */
function TierCta({ plan: p, featured }: { plan: CatalogPlan; featured: boolean }) {
  const { isLoaded, isSignedIn } = useSession();
  const signedIn = isLoaded && isSignedIn;
  const billing = useBilling({ enabled: signedIn });
  const api = useApi();
  const navigate = useNavigate();
  const [leaving, setLeaving] = useState(false);
  const checkout = useMutation({
    mutationFn: () => api.checkout({ plan: p.key }),
    onSuccess: ({ url }) => {
      setLeaving(true);
      window.location.assign(url);
    },
    onError: (err) => {
      if (isApiError(err) && err.code === "already_subscribed") navigate("/app/settings/billing");
    },
  });
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => e.persisted && setLeaving(false);
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  const name = planLabel(p.name);
  const b = billing.data;
  const current = b?.plans.find((x) => x.current)?.key;
  // Paid plans wait until this instance takes real payments: no Checkout to fail, and no "Start Pro" sign-up that can't pay.
  const closed = usePublicConfig().data?.payments_live === false && p.kind !== "free" && current !== p.key;

  if (closed)
    return (
      <button type="button" disabled className={ctaClass(featured)}>
        Opens soon
      </button>
    );
  if (!signedIn)
    return (
      <Link to="/sign-up" className={ctaClass(featured)}>
        {p.kind === "free" ? `Start with ${leadsFor(CREDIT.free_sample_credits)} free leads` : `Start ${name}, ${p.price}`}
      </Link>
    );
  if (current === p.key)
    return (
      <Link to="/app/settings/billing" className={ctaClass(false)}>
        Your plan · Manage billing
      </Link>
    );
  if (p.kind === "free" || !p.checkout)
    return (
      <Link to="/app" className={ctaClass(featured)}>
        Open the app
      </Link>
    );
  // Already on another paid plan: switching happens in the Stripe portal, from the billing page.
  if (b && hasLiveSubscription(b))
    return (
      <Link to="/app/settings/billing" className={ctaClass(featured)}>
        Switch to {name}
      </Link>
    );
  const err = checkout.isError && !(isApiError(checkout.error) && checkout.error.code === "already_subscribed") ? errorCopy(checkout.error, "payments") : null;
  return (
    <div className="flex flex-col gap-2">
      <button type="button" className={ctaClass(featured)} disabled={checkout.isPending || leaving} aria-busy={checkout.isPending || leaving || undefined} onClick={() => checkout.mutate()}>
        {checkout.isPending || leaving ? <Spinner size={12} /> : null}
        Start {name}, {p.price}
      </button>
      {err ? (
        <p role="alert" className="text-[13px]/5 font-medium text-muted">
          <span className="font-semibold text-ink">{err.title}.</span> {err.body}
        </p>
      ) : null}
    </div>
  );
}
