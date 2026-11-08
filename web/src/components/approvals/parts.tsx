// Building blocks of the right pane on "Dashboard · Approvals": header, "Bound to" strip, action buttons.
import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Link } from "react-router";
import type { ApprovalListItem } from "../../api.ts";
import { cx, timeAgo, timeLeft } from "../../lib/format.ts";
import { Spinner } from "../icons.tsx";
import { errorCopy } from "../ui.tsx";
import { isTypingTarget, Kbd } from "./controls.tsx";
import { msLeft, SOON_MS, workflowOf } from "./model.ts";

/** Called after a decision: hides `code` from the queue, shows `message`, and moves on (to `replacement` after an edit). */
export type OnDecided = (code: string, message: string, replacement?: string) => void;

export function DetailHead({
  a,
  now,
  title,
  aside,
  sessionId = a.naive_session_id,
}: {
  a: ApprovalListItem;
  now: number;
  title: ReactNode;
  aside?: ReactNode;
  /** The Naive run behind this approval (send approvals reach it through their lead). */
  sessionId?: string | null;
}) {
  const wf = workflowOf(a);
  const urgent = msLeft(a, now) < SOON_MS;
  return (
    <div className="flex shrink-0 items-start justify-between gap-4 border-b border-b-[#200D0D1A] px-5 pb-3.5 pt-4">
      <div className="flex min-w-0 flex-col gap-1.25">
        <h2 className="truncate text-[15px]/5 font-semibold text-ink">
          {title}
          {aside ? <span className="font-medium text-muted"> · {aside}</span> : null}
        </h2>
        <div className="truncate text-xs/4 font-medium text-muted">
          {wf ? `${wf} · ` : null}
          {sessionId ? (
            <>
              <Link to={`/app/workflows/runs/${encodeURIComponent(sessionId)}`} className="hover:text-ink hover:underline">
                {sessionId}
              </Link>
              {" · "}
            </>
          ) : null}
          requested {timeAgo(a.created_at, now)}
          {a.naive_session_id ? " by the Naive agent" : ""}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <div className="flex h-7 items-center gap-1.5 rounded-full bg-pill px-2.5">
          <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden className="shrink-0">
            <circle cx="12" cy="12" r="9" fill="none" stroke="#200D0D" strokeWidth="2" />
            <path d="M12 7v5l3 2" fill="none" stroke="#200D0D" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span className="text-xs/4 font-medium text-ink">
            Expires in <span className={cx("tabular-nums font-semibold", urgent && "text-[#B42318]")}>{timeLeft(a.expires_at, now)}</span>
          </span>
        </div>
        <div className="flex h-7 items-center gap-1.5 rounded-full border border-[#200D0D26] px-2.5">
          <span className="text-xs/4 font-medium text-muted">Code</span>
          <span className="tabular-nums text-xs/4 font-semibold text-ink">{a.code}</span>
        </div>
      </div>
    </div>
  );
}

/** The "Bound to" strip: exactly what this approval covers. */
export function BindingStrip({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-4.5 overflow-hidden whitespace-nowrap border-b border-b-[#200D0D1A] bg-[#200D0D04] px-5 text-xs/4 font-[525] text-faint">
      <span className="flex shrink-0 items-center gap-1.5">
        <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden className="shrink-0">
          <rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="rgb(32 13 13 / 60%)" strokeWidth="2" />
          <path d="M8 11V7a4 4 0 018 0v4" fill="none" stroke="rgb(32 13 13 / 60%)" strokeWidth="2" />
        </svg>
        Bound to
      </span>
      {children}
    </div>
  );
}

export function Bound({ label, children, mono, className }: { label: string; children: ReactNode; mono?: boolean; className?: string }) {
  return (
    <span className={cx("shrink-0", className)}>
      {label} <span className={cx("text-ink", mono && "tabular-nums")}>{children}</span>
    </span>
  );
}

type Tone = "primary" | "confirm" | "plain" | "danger";

export function ActionButton({
  tone = "plain",
  kbd,
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; kbd?: string; loading?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-keyshortcuts={kbd}
      className={cx(
        "flex h-9 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-full text-sm/4.5 transition-colors disabled:opacity-60",
        kbd ? "pl-4 pr-2" : "px-4",
        tone === "primary" && "bg-lime font-semibold text-ink hover:bg-[#b3de7a]",
        tone === "confirm" && "bg-ink font-semibold text-white",
        tone === "plain" && "border border-[#200D0D26] font-medium text-ink hover:bg-[#200D0D08]",
        tone === "danger" && "border border-[#200D0D26] font-medium text-[#B42318] hover:bg-[#FDECEB]",
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={12} /> : null}
      {children}
      {kbd ? <Kbd tone={tone === "primary" ? "onLime" : tone === "confirm" ? "onInk" : "plain"}>{kbd}</Kbd> : null}
    </button>
  );
}

export function ActionBar({ children, note, error }: { children: ReactNode; note: ReactNode; error?: unknown }) {
  const e = error ? errorCopy(error, "this decision") : null;
  return (
    <div className="flex shrink-0 flex-col gap-2.5 border-t border-t-[#200D0D1A] px-5 pb-3.5 pt-3">
      <div className="flex min-h-9 items-center gap-2">{children}</div>
      {e ? (
        <div role="alert" className="text-xs/4 font-medium text-[#B42318]">
          {e.title}: {e.body}
        </div>
      ) : null}
      <div className="flex items-center gap-4 text-xs/4 font-medium text-muted">
        <span className="min-w-0">{note}</span>
        <span className="grow" />
        <span className="shrink-0">
          <span className="tabular-nums text-ink">J</span> / <span className="tabular-nums text-ink">K</span> next, previous
        </span>
      </div>
    </div>
  );
}

/** Single-key shortcuts for the open approval (ignored while typing). */
export function useKeys(map: Record<string, (() => void) | undefined>) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      const fn = ref.current[e.key.toLowerCase()];
      if (!fn) return;
      e.preventDefault();
      fn();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Two-step confirms fall back after a few seconds so a stray key press later cannot complete them. */
export function useDisarm(armed: boolean, disarm: () => void, ms = 5000) {
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(disarm, ms);
    return () => clearTimeout(t);
  }, [armed, disarm, ms]);
}

/** Inline "why are you rejecting" row shared by send and tool approvals. */
export function ReasonRow({
  value,
  onChange,
  onSubmit,
  onCancel,
  loading,
  submitLabel,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  loading: boolean;
  submitLabel: string;
  placeholder: string;
}) {
  return (
    <form
      className="flex grow items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
        maxLength={1000}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-9 min-w-0 grow rounded-full border border-[#200D0D26] px-4 text-sm/4.5 text-ink outline-none placeholder:text-[#200D0D73] focus:border-[#200D0D59]"
      />
      <ActionButton type="submit" tone="danger" loading={loading}>
        {submitLabel}
      </ActionButton>
      <ActionButton onClick={onCancel}>Cancel</ActionButton>
    </form>
  );
}
