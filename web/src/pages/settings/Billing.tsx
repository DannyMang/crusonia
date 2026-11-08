// Settings · Billing at /app/settings/billing (Paper: naive > "Settings · Billing"). Everything comes from
// GET /api/billing: balance, plan, expiring credit, ledger, and the plans and packs (src/billing/catalog.ts).
// Buying opens Stripe Checkout and "Manage billing" opens the Stripe Customer Portal; both are full-page redirects.
// Stripe sends people back here with ?checkout=success|cancelled (src/billing/checkout.ts). Credits arrive through
// the Stripe webhook, which can lag the redirect by a few seconds, so after a success the page polls briefly until
// the new ledger row shows up.
import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { isApiError, type Billing as BillingData, type CheckoutInput, type LedgerEntry } from "../../api.ts";
import { useApi } from "../../auth.tsx";
import { Page } from "../../components/AppShell.tsx";
import { CheckIcon, Spinner } from "../../components/icons.tsx";
import { Card, EmptyState, QueryError, RingSpinner, Skeleton } from "../../components/ui.tsx";
import { hasLiveSubscription, ledgerLine, planLabel, planStatus, PLAN_TAGS, priceAmount, signedCredits, type StatusChip } from "../../lib/billing.ts";
import { clock, cx, longDate, num, plural, shortDate, usd } from "../../lib/format.ts";
import { useBilling } from "../../queries.ts";
import { CrumbBar } from "../connect/CrumbBar.tsx";
import { SettingsTabs } from "./SettingsTabs.tsx";

/** Poll /api/billing this often after a successful Checkout, for at most POLL_FOR_MS. */
const POLL_EVERY_MS = 2_000;
const POLL_FOR_MS = 30_000;
/** A pack or plan row this close before the return counts as the purchase that just went through. */
const PURCHASE_WINDOW_MS = 3 * 60_000;

const sectionTitle = "text-[15px]/4.5 font-medium text-ink";
const sectionNote = "text-[13px]/4 font-medium text-[#200D0D80]";
const label = "text-[13px]/4 font-medium text-[#200D0D80]";
/** The design's square-ish secondary button (Manage billing, Buy). */
const outlineButton =
  "inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-lg border border-[#200D0D26] bg-white px-4 text-[13px]/4 font-medium text-ink transition-colors hover:bg-[#200D0D08] disabled:cursor-default disabled:opacity-50";

type Action = { kind: "checkout"; key: string } | { kind: "portal" };

export default function Billing() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const checkout = params.get("checkout");
  const [arrivedAt] = useState(() => Date.now());
  const [timedOut, setTimedOut] = useState(false);
  const [landedSeen, setLandedSeen] = useState(false);

  const polling = checkout === "success" && !landedSeen && !timedOut;
  const billing = useBilling({ poll: polling ? POLL_EVERY_MS : false });
  const b = billing.data;

  // The purchase that brought them back: the newest pack or plan row from just before the return (or after).
  const landed = useMemo(() => (checkout === "success" && b ? recentPurchase(b.ledger, arrivedAt) : undefined), [checkout, b, arrivedAt]);
  useEffect(() => {
    if (landed) setLandedSeen(true);
  }, [landed]);
  useEffect(() => {
    if (checkout !== "success") return;
    const t = setTimeout(() => setTimedOut(true), POLL_FOR_MS);
    return () => clearTimeout(t);
  }, [checkout]);

  // Checkout and the portal hand back a Stripe URL. The clicked button stays busy until the browser leaves, and
  // every other billing button waits too, so one click never opens two Stripe sessions.
  const [pending, setPending] = useState<Action | null>(null);
  useEffect(() => {
    // Back from Stripe via the back button: the page may come from the bfcache with a button still busy.
    const onShow = (e: PageTransitionEvent) => e.persisted && setPending(null);
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);
  const leave = ({ url }: { url: string }) => window.location.assign(url);
  const portal = useMutation({ mutationFn: () => api.billingPortal(), onSuccess: leave, onError: () => setPending(null) });
  const buy = useMutation({
    mutationFn: (input: CheckoutInput) => api.checkout(input),
    onSuccess: leave,
    onError: (err) => {
      // Subscribed since this page loaded (another tab): plan changes happen in the portal.
      if (isApiError(err) && err.code === "already_subscribed") openPortal();
      else setPending(null);
    },
  });
  function openPortal() {
    setPending({ kind: "portal" });
    portal.mutate();
  }
  function startCheckout(input: CheckoutInput) {
    setPending({ kind: "checkout", key: "plan" in input ? input.plan : input.pack });
    buy.mutate(input);
  }
  const busy = (a: Action) => pending?.kind === a.kind && (a.kind === "portal" || (pending.kind === "checkout" && pending.key === a.key));
  const anyBusy = pending !== null;
  const actionError =
    (buy.isError && !(isApiError(buy.error) && buy.error.code === "already_subscribed") ? buy.error : null) ?? (portal.isError ? portal.error : null);

  const dismiss = () => {
    const next = new URLSearchParams(params);
    next.delete("checkout");
    setParams(next, { replace: true });
  };

  const configured = b?.billing.configured ?? false;
  const subscribed = b ? hasLiveSubscription(b) : false;

  return (
    <>
      <CrumbBar parent={{ label: "Settings", to: "/app/settings" }} here="Billing" />
      <Page>
        <div className="flex w-240 max-w-full flex-col gap-4 px-12 pb-14 pt-8">
          <SettingsTabs />

          <div className="flex items-end justify-between gap-6 pb-2 pt-3">
            <div className="flex flex-col gap-2">
              <h1 className="text-xl/5.75 font-medium tracking-[-0.01em] text-ink">Billing</h1>
              <p className="w-140 max-w-full text-[13px]/4.5 font-medium text-[#200D0D99]">
                Credits pay for hosted agent work, at 1 credit = $0.01. Payments, invoices and cards are handled by Stripe.
              </p>
            </div>
            {b?.has_customer && configured ? (
              <button type="button" className={outlineButton} onClick={openPortal} disabled={anyBusy} aria-busy={busy({ kind: "portal" }) || undefined}>
                {busy({ kind: "portal" }) ? <Spinner size={12} /> : null}
                Manage billing
                <ExternalIcon />
              </button>
            ) : null}
          </div>

          {checkout === "success" ? <SuccessBanner landed={landed} billing={b} waiting={polling} onDismiss={dismiss} /> : null}
          {checkout === "cancelled" ? (
            <Banner tone="neutral" title="Checkout cancelled" body="Nothing was charged. Pick a pack or plan whenever you are ready." onDismiss={dismiss} />
          ) : null}
          {actionError ? <QueryError error={actionError} what="Payments" /> : null}
          {b && !configured ? (
            <Banner
              tone="calm"
              title="Payments are coming online"
              body="Buying credits and changing plans need Stripe on this deployment. Your balance and history below are up to date."
            />
          ) : null}

          {billing.isError && !b ? (
            <QueryError error={billing.error} what="Billing" onRetry={() => void billing.refetch()} />
          ) : !b ? (
            <LoadingState />
          ) : (
            <>
              <BalanceCard b={b} />

              <Card className="flex flex-col gap-4 p-6">
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                  <h2 className={sectionTitle}>Buy credits</h2>
                  <p className={sectionNote}>One-time top-ups at the same rate. Pack credits never expire.</p>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row">
                  {b.packs.map((p) => (
                    <div key={p.key} className="flex grow basis-0 items-center justify-between gap-3 rounded-[10px] border border-[#200D0D1A] py-4.5 pl-5 pr-4.5">
                      <div className="flex flex-col gap-1">
                        <div className="tabular-nums text-[26px]/7.5 font-semibold tracking-[-0.03em] text-ink">{p.price}</div>
                        <div className="tabular-nums text-[13px]/4 font-medium text-[#200D0D99]">{num(p.credits)} credits</div>
                      </div>
                      <button
                        type="button"
                        className={outlineButton}
                        disabled={!configured || anyBusy}
                        aria-busy={busy({ kind: "checkout", key: p.key }) || undefined}
                        aria-label={`Buy ${num(p.credits)} credits for ${p.price}`}
                        onClick={() => startCheckout({ pack: p.key })}
                      >
                        {busy({ kind: "checkout", key: p.key }) ? <Spinner size={12} /> : null}
                        Buy
                      </button>
                    </div>
                  ))}
                </div>
              </Card>

              <Card className="flex flex-col gap-4 p-6">
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                  <h2 className={sectionTitle}>Monthly plans</h2>
                  <p className={sectionNote}>Each plan adds its price back as credit every month. Change or cancel in Manage billing.</p>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row">
                  {b.plans
                    .filter((p) => p.kind === "subscription")
                    .map((p) => {
                      const name = planLabel(p.name);
                      const tag = p.current ? null : PLAN_TAGS[p.key];
                      // Subscribed: switching happens in the Stripe portal (Checkout refuses a second subscription).
                      const action: Action = subscribed ? { kind: "portal" } : { kind: "checkout", key: p.key };
                      const working = busy(action);
                      const canAct = configured && (!subscribed || b.has_customer);
                      return (
                        <div
                          key={p.key}
                          className={cx("flex grow basis-0 flex-col gap-3.5 rounded-[10px] p-5", p.current ? "border-[1.5px] border-ink" : "border border-[#200D0D1A]")}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <h3 className="text-[17px]/5.5 font-semibold tracking-[-0.01em] text-ink">{name}</h3>
                            {p.current ? (
                              <span className="flex h-5.5 items-center rounded-full bg-lime px-2.5 text-xs/4 font-medium text-ink">Current plan</span>
                            ) : tag ? (
                              <span className="flex h-5.5 items-center rounded-full border border-[#200D0D14] px-2.5 text-xs/4 font-medium text-[#200D0D99]">{tag}</span>
                            ) : null}
                          </div>
                          <div className="flex items-baseline gap-1.5">
                            <span className="tabular-nums text-[32px]/9 font-semibold tracking-[-0.035em] text-ink">{priceAmount(p.price)}</span>
                            <span className="text-sm/4.5 font-medium text-[#200D0D99]">per month</span>
                          </div>
                          <p className="text-[13px]/5 font-medium text-[#200D0D99]">{p.description}</p>
                          {p.current ? (
                            <div className="mt-auto flex h-9 items-center justify-center rounded-lg bg-pill text-[13px]/4 font-medium text-[#200D0D99]">You're on {name}</div>
                          ) : (
                            <button
                              type="button"
                              className="mt-auto inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-lime text-[13px]/4 font-medium text-ink transition-colors hover:bg-[#b3de7a] disabled:cursor-default disabled:opacity-50"
                              disabled={!canAct || anyBusy}
                              aria-busy={working || undefined}
                              onClick={() => (action.kind === "portal" ? openPortal() : startCheckout({ plan: p.key }))}
                            >
                              {working ? <Spinner size={12} /> : null}
                              {subscribed ? `Switch to ${name}` : `Upgrade to ${name}`}
                            </button>
                          )}
                        </div>
                      );
                    })}
                </div>
              </Card>

              <Activity b={b} />
            </>
          )}
        </div>
      </Page>
    </>
  );
}

/** The newest pack or plan grant written since shortly before Stripe sent the customer back. */
function recentPurchase(ledger: LedgerEntry[], arrivedAt: number): LedgerEntry | undefined {
  return ledger.find((e) => (e.reason === "pack" || e.reason === "plan") && e.amount > 0 && new Date(e.created_at).getTime() >= arrivedAt - PURCHASE_WINDOW_MS);
}

function SuccessBanner({ landed, billing, waiting, onDismiss }: { landed?: LedgerEntry; billing?: BillingData; waiting: boolean; onDismiss: () => void }) {
  let body: ReactNode;
  if (landed) {
    const plan = landed.reason === "plan" ? billing?.plans.find((p) => p.key === landed.data?.plan) : undefined;
    body = plan
      ? `${planLabel(plan.name)} is on, and its ${num(landed.amount)} monthly credits are in.`
      : `Your ${num(landed.amount)} credits are in.`;
  } else if (waiting) {
    body = (
      <span className="inline-flex items-center gap-2">
        <RingSpinner />
        Adding your credits. Stripe confirms each payment separately, so this can take a few seconds.
      </span>
    );
  } else {
    body = "Stripe has not confirmed the payment to us yet. Your credits appear here as soon as it does; there is nothing else to do.";
  }
  return <Banner tone="success" title="Payment received. Thank you!" body={body} onDismiss={onDismiss} />;
}

function Banner({ tone, title, body, onDismiss }: { tone: "success" | "neutral" | "calm"; title: string; body: ReactNode; onDismiss?: () => void }) {
  return (
    <div
      role="status"
      className={cx(
        "flex items-start gap-3 rounded-[10px] py-3.5 pl-4 pr-3.5",
        tone === "neutral" ? "border border-[#200D0D1A] bg-white" : "border border-panel-line bg-panel",
      )}
    >
      {tone === "success" ? (
        <span className="mt-px flex size-4.5 shrink-0 items-center justify-center rounded-full bg-green text-white">
          <CheckIcon className="size-3" />
        </span>
      ) : (
        <span className={cx("mt-1.75 size-1.5 shrink-0 rounded-full", tone === "calm" ? "bg-green" : "bg-[#200D0D66]")} />
      )}
      <div className="flex grow flex-col gap-0.5">
        <div className="text-sm/5 font-semibold text-ink">{title}</div>
        <div className="text-[13px]/5 font-medium text-[#200D0D99]">{body}</div>
      </div>
      {onDismiss ? (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="-m-1 flex size-6 shrink-0 items-center justify-center rounded-md text-[#200D0D80] hover:bg-[#200D0D0A]">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

const chipTone: Record<StatusChip["tone"], string> = {
  lime: "bg-lime text-ink",
  amber: "bg-[#FEF3C7] text-[#92400E]",
  gray: "bg-pill text-[#200D0DB3]",
  red: "bg-[#FDECEB] text-[#B42318]",
};

function BalanceCard({ b }: { b: BillingData }) {
  const current = b.plans.find((p) => p.current);
  const status = planStatus(b);
  const next = b.expiring[0];
  return (
    <Card className="flex flex-col overflow-clip md:flex-row">
      <div className="flex shrink-0 flex-col gap-1.5 pb-6.5 pl-6 pr-7 pt-6 md:w-105">
        <div className={label}>Credit balance</div>
        <div className="flex items-baseline gap-2.5 pt-1">
          <span className={cx("tabular-nums text-[56px]/15 font-semibold tracking-[-0.035em]", b.balance < 0 ? "text-[#B42318]" : "text-ink")}>{num(b.balance)}</span>
          <span className="text-[15px]/5 font-medium text-[#200D0D99]">credits</span>
        </div>
        <div className="tabular-nums text-sm/5 font-medium text-[#200D0D99]">
          {usd(b.balance_usd)} of usage at 1 credit = {usd(b.credit.usd)}
        </div>
      </div>
      <dl className="flex grow flex-col border-t border-t-[#200D0D1A] px-6 py-2.5 md:border-l md:border-t-0 md:border-l-[#200D0D1A]">
        <FactRow label="Plan">
          <dd className="flex min-w-0 grow items-center gap-2.5">
            <span className="shrink-0 text-[15px]/4.5 font-semibold text-ink">{planLabel(b.plan.name)}</span>
            {status ? <span className={cx("flex h-5.5 shrink-0 items-center rounded-full px-2.5 text-xs/4 font-medium", chipTone[status.tone])}>{status.label}</span> : null}
            <span className="grow" />
            <span className="shrink-0 tabular-nums text-[13px]/4 font-medium text-[#200D0D99]">
              {current && current.monthly_credits > 0 ? `${num(current.monthly_credits)} credits a month` : "No monthly fee"}
            </span>
          </dd>
        </FactRow>
        {b.plan.current_period_end ? (
          <FactRow label={b.plan.cancel_at_period_end || b.plan.status === "canceled" ? "Ends" : "Renews"}>
            <dd className="tabular-nums text-[15px]/4.5 font-semibold text-ink">{longDate(b.plan.current_period_end)}</dd>
          </FactRow>
        ) : null}
        <FactRow label="Expiring soon" last>
          {next ? (
            <dd className="flex items-center gap-2.5">
              <span className="tabular-nums text-[15px]/4.5 font-semibold text-ink">{num(next.credits)} credits</span>
              <span className="tabular-nums text-[13px]/4 font-medium text-[#200D0D99]">
                on {shortDate(next.expires_at)}
                {b.expiring.length > 1 ? ` · ${plural(b.expiring.length - 1, "more batch", "more batches")} later` : ""}
              </span>
            </dd>
          ) : (
            <dd className="text-[13px]/4 font-medium text-[#200D0D99]">Nothing. Pack credits and the free sample never expire.</dd>
          )}
        </FactRow>
      </dl>
    </Card>
  );
}

function FactRow({ label: text, last, children }: { label: string; last?: boolean; children: ReactNode }) {
  return (
    <div className={cx("flex min-h-12 shrink-0 items-center gap-2.5 py-2", !last && "border-b border-b-[#200D0D14]")}>
      <dt className={cx(label, "w-30 shrink-0")}>{text}</dt>
      {children}
    </div>
  );
}

function Activity({ b }: { b: BillingData }) {
  return (
    <Card className="flex flex-col px-6 pb-2 pt-6">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 pb-3.5">
        <h2 className={sectionTitle}>Recent activity</h2>
        <p className={sectionNote}>The last 20 changes to your balance</p>
      </div>
      {b.ledger.length ? (
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="h-8 border-b border-b-[#200D0D1A] text-xs/4 font-medium text-[#200D0D80]">
              <th scope="col" className="w-35 pr-4 font-medium">
                Date
              </th>
              <th scope="col" className="pr-4 font-medium">
                What
              </th>
              <th scope="col" className="w-30 text-right font-medium">
                Credits
              </th>
            </tr>
          </thead>
          <tbody>
            {b.ledger.map((e, i) => {
              const line = ledgerLine(e, b);
              return (
                <tr key={e.id} className={cx("h-13", i < b.ledger.length - 1 && "border-b border-b-[#200D0D0F]")}>
                  <td className="whitespace-nowrap pr-4 tabular-nums text-[13px]/4 font-medium text-[#200D0D99]">
                    {shortDate(e.created_at)}, {clock(e.created_at)}
                  </td>
                  <td className="py-2 pr-4">
                    <div className="text-sm/4.5 font-medium text-ink">{line.title}</div>
                    {line.detail ? <div className="text-xs/4 font-medium text-[#200D0D80]">{line.detail}</div> : null}
                  </td>
                  <td className={cx("text-right tabular-nums text-sm/4.5 font-semibold", e.amount > 0 ? "text-[#15803D]" : "text-ink")}>{signedCredits(e.amount)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <EmptyState className="border-t border-t-[#200D0D14] py-10" title="No activity yet" body="Purchases, monthly plan credit and agent usage show up here as they happen." />
      )}
    </Card>
  );
}

function LoadingState() {
  return (
    <div aria-busy="true" aria-label="Loading billing" className="flex flex-col gap-4">
      <Card className="flex items-center gap-6 p-6">
        <div className="flex w-90 flex-col gap-3">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-14 w-56" />
          <Skeleton className="h-4 w-60" />
        </div>
        <div className="flex grow flex-col gap-4">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      </Card>
      <Card className="flex gap-3 p-6">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-19 grow" />
        ))}
      </Card>
      <Card className="flex gap-3 p-6">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-48 grow" />
        ))}
      </Card>
    </div>
  );
}

function ExternalIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="shrink-0">
      <path d="M4.5 2.5h5v5M9.5 2.5L3 9" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
