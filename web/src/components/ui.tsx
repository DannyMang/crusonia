// Shared building blocks in the veri style. Values come from the Paper designs (Dashboard · Home etc.).
import { useState, type ButtonHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Link, type LinkProps } from "react-router";
import { isApiError } from "../api.ts";
import { useSession } from "../auth.tsx";
import { cx } from "../lib/format.ts";
import { CheckIcon, CopyIcon, Spinner } from "./icons.tsx";

// ---------- buttons ----------

type Variant = "primary" | "outline" | "soft" | "ghost" | "danger" | "ink";
type Size = "sm" | "header" | "md" | "lg";

const variants: Record<Variant, string> = {
  // lime pill: Approve, Add leads, Continue
  primary: "bg-lime text-ink hover:bg-[#b3de7a] disabled:opacity-60",
  // ink outline: Review, Import CSV
  outline: "bg-white text-ink border border-ink hover:bg-[#200D0D08] disabled:opacity-60",
  // hairline outline: Manage, Copy, Edit
  soft: "bg-white text-ink border border-[#200D0D24] hover:bg-[#200D0D08] disabled:opacity-60",
  ghost: "text-ink hover:bg-[#200D0D0A] disabled:opacity-60",
  // Reject, Revoke
  danger: "bg-white text-[#B42318] border border-[#B4231833] hover:bg-[#FDECEB] disabled:opacity-60",
  // confirm step of a two-click action ("Send now?")
  ink: "bg-ink text-white hover:bg-[#3A2424] disabled:opacity-60",
};

const sizes: Record<Size, string> = {
  sm: "h-7.5 px-3.5 rounded-full text-[13px]/4 font-medium gap-1.5",
  // page-header actions (lead detail, workflow run)
  header: "h-8 px-4 rounded-full text-sm/4.5 font-medium gap-2",
  md: "h-9 px-4 rounded-full text-sm/4.5 font-medium gap-2",
  lg: "h-12 px-5 rounded-[10px] text-[15px]/4.5 font-semibold gap-2.5",
};

export function buttonClass(variant: Variant = "primary", size: Size = "sm", extra?: string) {
  return cx("inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-colors", variants[variant], sizes[size], extra);
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean };

export function Button({ variant = "primary", size = "sm", loading, className, children, disabled, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} className={buttonClass(variant, size, className)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Spinner size={12} /> : null}
      {children}
    </button>
  );
}

export function ButtonLink({ variant = "primary", size = "sm", className, ...rest }: LinkProps & { variant?: Variant; size?: Size }) {
  return <Link className={buttonClass(variant, size, className)} {...rest} />;
}

// ---------- pills ----------

export type Tone = "lime" | "limeSoft" | "highlight" | "green" | "gray" | "red" | "outline" | "ink" | "amber";

const tones: Record<Tone, string> = {
  lime: "bg-lime text-ink",
  limeSoft: "bg-[#BDE68973] text-ink",
  highlight: "bg-highlight text-ink",
  green: "bg-[#16A34A1F] text-[#166534]",
  gray: "bg-pill text-[#200D0DB3]",
  red: "bg-[#FDECEB] text-[#B42318]",
  amber: "bg-[#FEF3C7] text-[#92400E]",
  outline: "bg-white text-[#200D0DB3] border border-[#200D0D24]",
  ink: "bg-ink text-white",
};

/** Small status label (h-5, 11px semibold), e.g. "needs you", "Interested", "Unsubscribed". `mono` = tabular digits. */
export function Pill({ tone = "lime", className, children, mono }: { tone?: Tone; className?: string; children: ReactNode; mono?: boolean }) {
  return (
    <span
      className={cx(
        "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[11px]/3.5 font-semibold",
        mono && "tabular-nums",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Live state chip with a spinner ("researching", "drafting", "running"). */
export function LiveChip({ children, spinning = true, className }: { children: ReactNode; spinning?: boolean; className?: string }) {
  return (
    <span className={cx("inline-flex h-5.75 shrink-0 items-center gap-1.5 rounded-full bg-[#BDE68973] px-3 text-[13px]/4 font-medium text-ink", className)}>
      {spinning ? <RingSpinner /> : null}
      {children}
    </span>
  );
}

/** The two-tone ring from the designs (25% ink track, ink arc). */
export function RingSpinner({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden className="shrink-0 [animation:crusonia-spin_0.9s_linear_infinite]">
      <circle cx="5" cy="5" r="3.5" fill="none" stroke="rgb(32 13 13 / 25%)" strokeWidth="1.5" />
      <path d="M5 1.5A3.5 3.5 0 0 1 8.5 5" fill="none" stroke="#200D0D" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

const STAGE: Record<string, { label: string; tone: Tone; live?: boolean }> = {
  new: { label: "New", tone: "outline" },
  no_consent: { label: "Found", tone: "outline" },
  researching: { label: "Researching", tone: "highlight", live: true },
  qualified: { label: "Researched", tone: "outline" },
  disqualified: { label: "Not a fit", tone: "gray" },
  needs_review: { label: "Needs review", tone: "amber" },
  awaiting_approval: { label: "Awaiting approval", tone: "lime" },
  sent: { label: "Sent · no reply yet", tone: "gray" },
  replied: { label: "Replied", tone: "highlight" },
  interested: { label: "Interested", tone: "lime" },
  not_interested: { label: "Not now", tone: "outline" },
  unsubscribed: { label: "Unsubscribed", tone: "red" },
  meeting_booked: { label: "Meeting booked", tone: "green" },
};

export const stageLabel = (stage: string) => STAGE[stage]?.label ?? stage.replace(/_/g, " ");

const badgeSizes = {
  sm: "h-5.5 px-2.25 text-xs/4", // table rows
  md: "h-5.5 px-2.5 text-[13px]/4",
  lg: "h-6.5 px-3 text-[13px]/4", // page headers
};

/** Lead stage badge (Leads table, lead detail header). */
export function StageBadge({ stage, className, size = "md" }: { stage: string; className?: string; size?: keyof typeof badgeSizes }) {
  const s = STAGE[stage] ?? { label: stageLabel(stage), tone: "outline" as Tone };
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full font-medium",
        badgeSizes[size],
        s.tone === "outline" ? "border border-[#200D0D24] bg-white text-[#200D0DB3]" : tones[s.tone],
        className,
      )}
    >
      {s.live ? <RingSpinner /> : null}
      {s.label}
    </span>
  );
}

const REPLY: Record<string, { label: string; tone: Tone }> = {
  meeting: { label: "Meeting", tone: "green" },
  interested: { label: "Interested", tone: "highlight" },
  not_interested: { label: "Not now", tone: "gray" },
  unsubscribe: { label: "Unsubscribed", tone: "red" },
  unsubscribed: { label: "Unsubscribed", tone: "red" },
  out_of_office: { label: "Out of office", tone: "gray" },
  other: { label: "Other", tone: "gray" },
};

export function ReplyLabel({ label }: { label: string | null | undefined }) {
  const r = REPLY[label ?? "other"] ?? { label: label ?? "Other", tone: "gray" as Tone };
  return <Pill tone={r.tone}>{r.label}</Pill>;
}

// ---------- surfaces ----------

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("rounded-xl border border-[#200D0D1A] bg-white", className)}>{children}</div>;
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cx("block rounded-md bg-[#200D0D0D] [animation:crusonia-pulse_1.6s_ease-in-out_infinite]", className)} />;
}

/** Calm empty state: production starts with no data, so this is a first-class screen, not an afterthought. */
export function EmptyState({
  title,
  body,
  action,
  icon,
  className,
}: {
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col items-center justify-center gap-2 px-6 py-12 text-center", className)}>
      {icon ? <div className="mb-1 flex size-9 items-center justify-center rounded-full bg-panel text-green">{icon}</div> : null}
      <div className="text-[15px]/5 font-semibold tracking-[-0.01em] text-ink">{title}</div>
      {body ? <div className="max-w-md text-[13px]/5 font-medium text-muted">{body}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** Explains an API error in plain words. `not_configured` (503) reads as "coming online", not as a failure. */
export function errorCopy(err: unknown, what = "this", userId?: string | null): { title: string; body: string; calm: boolean } {
  // "Tasks are coming online", "Your overview is coming online"; "status" and "finding leads" stay singular.
  const plural = /[^isu]s$/i.test(what) && !/^\w+ing\b/i.test(what);
  const coming = `${capitalize(what)} ${plural ? "are" : "is"} coming online`;
  if (isApiError(err)) {
    if (err.code === "schema_out_of_date")
      return { title: coming, body: "This needs a database update that has not run on this deployment yet.", calm: true };
    if (err.notConfigured) return { title: coming, body: notConfiguredHint(err.message), calm: true };
    if (err.code === "profile_missing") return { title: "Set up your ideal customer first", body: "Finding leads searches for the profile you save in onboarding.", calm: true };
    if (err.missingRoute) return { title: coming, body: "This part of Crusonia ships with the next backend update.", calm: true };
    if (err.status === 401) return { title: "Your session ended", body: "Sign in again to continue.", calm: false };
    if (err.code === "signups_closed")
      return { title: "Sign-ups are closed", body: "This Crusonia instance is not taking new accounts right now. Ask the owner for access.", calm: false };
    if (err.code === "email_not_verified" || err.code === "email_not_allowed" || err.code === "owner_email_unverified")
      return { title: err.code === "email_not_allowed" ? "Use your work email" : "Verify your email", body: err.message, calm: false };
    if (err.code === "instance_busy") return { title: "Crusonia is at capacity", body: "New agent runs start again soon. Everything you have is safe.", calm: true };
    if (err.code === "payments_not_live") return { title: "Top-ups open soon", body: "Your credits keep working in the meantime.", calm: true };
    if (err.code === "insufficient_credits") return { title: "You're out of credits", body: err.message, calm: true };
    if (err.code === "too_many_requests") return { title: "Too many requests", body: err.message, calm: true };
    if (err.code === "account_blocked") return { title: "No access", body: "This account cannot use this Crusonia instance.", calm: false };
    if (err.status === 403)
      return {
        title: "No access",
        body: userId ? `This account (${userId}) cannot do this in this workspace.` : "This account cannot do this in this workspace.",
        calm: false,
      };
    if (err.status === 404) return { title: "Not found", body: err.message, calm: false };
    if (err.status === 423) return { title: "Crusonia is paused", body: "Turn sends back on in the sidebar to start new work.", calm: true };
    return { title: "Something went wrong", body: err.message, calm: false };
  }
  return { title: "Something went wrong", body: err instanceof Error ? err.message : String(err), calm: false };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function notConfiguredHint(message: string) {
  if (/NAIVE|Naive agent/i.test(message)) return "Needs the Naive agent, which is still being set up. Nothing is lost in the meantime.";
  if (/APIFY/i.test(message)) return "Needs the Apify connection, which is still being set up.";
  if (/AGENTMAIL/i.test(message)) return "Needs the AgentMail inbox, which is still being set up.";
  if (/DATABASE/i.test(message) || /schema/i.test(message)) return "The database is being set up. Try again in a minute.";
  return "A connection this needs is still being set up.";
}

export function QueryError({ error, what, onRetry, className }: { error: unknown; what?: string; onRetry?: () => void; className?: string }) {
  const { user } = useSession();
  const c = errorCopy(error, what, user?.id);
  return (
    <div
      role={c.calm ? "status" : "alert"}
      className={cx(
        "flex items-start gap-3 rounded-[10px] px-4 py-3.5 text-[13px]/5",
        c.calm ? "border border-panel-line bg-panel" : "border border-[#B4231829] bg-[#FDECEB80]",
        className,
      )}
    >
      <span className={cx("mt-1.5 size-1.5 shrink-0 rounded-full", c.calm ? "bg-green" : "bg-[#B42318]")} />
      <div className="grow">
        <div className="font-semibold text-ink">{c.title}</div>
        <div className="font-medium text-muted">{c.body}</div>
      </div>
      {onRetry && !c.calm && !(isApiError(error) && error.status === 404) ? (
        <Button variant="soft" size="sm" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

// ---------- tabs ----------

/**
 * onKeyDown for a role="tablist" of buttons: Left / Right (wrapping), Home and End select the neighbouring tab
 * and move focus to it. Give the selected tab tabIndex 0 and the others -1, so Tab enters the list once.
 */
export function tabListKeys<T extends string>(ids: readonly T[], current: T, select: (id: T) => void) {
  return (e: ReactKeyboardEvent<HTMLElement>) => {
    const i = ids.indexOf(current);
    const n = ids.length;
    const next =
      e.key === "ArrowRight" ? ids[(i + 1) % n] : e.key === "ArrowLeft" ? ids[(i - 1 + n) % n] : e.key === "Home" ? ids[0] : e.key === "End" ? ids[n - 1] : undefined;
    if (next === undefined) return;
    e.preventDefault();
    select(next);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[ids.indexOf(next)]?.focus();
  };
}

// ---------- misc ----------

export function CopyButton({ text, label = "Copy", className, iconOnly }: { text: string; label?: string; className?: string; iconOnly?: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked (http, iframes); the text stays selectable.
    }
  }
  if (iconOnly) {
    return (
      <button type="button" onClick={copy} aria-label={copied ? "Copied" : label} className={cx("inline-flex size-6 items-center justify-center rounded-md text-faint hover:bg-[#200D0D0A]", className)}>
        {copied ? <CheckIcon className="text-green" /> : <CopyIcon />}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={copy}
      className={cx("inline-flex h-6.5 shrink-0 items-center rounded-md border border-[#200D0D1A] bg-white px-2 text-xs/4 font-medium text-ink hover:bg-[#200D0D08]", className)}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

/** IDs, emails and numbers: Inter with tabular figures (no monospace font anywhere, by owner rule). */
export function Mono({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cx("tabular-nums", className)}>{children}</span>;
}
