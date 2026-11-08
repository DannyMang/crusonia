// Small controls shared by the Approvals and Workflows screens (filter chips, search field, key hints, a ticking
// clock). Candidates for components/ui.tsx once both screens settle.
import { useEffect, useState, type ReactNode, type Ref } from "react";
import { cx } from "../../lib/format.ts";

/** Re-renders every `ms` so countdowns ("expires in 24m") and "updated 4s ago" stay current. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** "updated 4s ago" for a React Query `dataUpdatedAt`. */
export function updatedAgo(at: number, now: number): string {
  if (!at) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `updated ${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `updated ${m}m ago` : `updated ${Math.floor(m / 60)}h ago`;
}

/** True when a key press is meant for a text field (or carries a modifier), so single-key shortcuts stay out of the way. */
export function isTypingTarget(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return true;
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
}

export type ChipOption = { value: string; label: string };

/**
 * Lime filter chip ("Workflow  Any"). A transparent native <select> covers the chip, so it is keyboard and
 * screen-reader friendly without a custom listbox.
 */
export function FilterChip({ label, value, options, onChange }: { label: string; value: string; options: ChipOption[]; onChange: (v: string) => void }) {
  const current = options.find((o) => o.value === value)?.label ?? "Any";
  return (
    <label className="relative flex h-7.5 shrink-0 cursor-pointer items-center gap-1.25 rounded-full bg-lime px-3 hover:bg-[#b3de7a] focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-green">
      <span className="text-[13px]/4 text-[#200D0D99]">{label}</span>
      <span className="text-[13px]/4 font-medium text-ink">{current}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className="absolute inset-0 cursor-pointer appearance-none opacity-0">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
  className,
  inputRef,
  hint,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
  hint?: ReactNode;
}) {
  return (
    <div className={cx("flex shrink-0 items-center gap-2 rounded-[10px] border border-[#200D0D1A] px-3 focus-within:border-[#200D0D40]", className)}>
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden className="shrink-0">
        <circle cx="11" cy="11" r="7" fill="none" stroke="rgb(32 13 13 / 45%)" strokeWidth="2" />
        <path d="M20 20l-3.5-3.5" fill="none" stroke="rgb(32 13 13 / 45%)" strokeWidth="2" />
      </svg>
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onChange("");
            e.currentTarget.blur();
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-full min-w-0 grow bg-transparent text-[13px]/4 text-ink outline-none placeholder:text-[#200D0D73] [&::-webkit-search-cancel-button]:hidden"
      />
      {hint}
    </div>
  );
}

/** Keyboard hint inside buttons ("A", "E", "R"). */
export function Kbd({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "onLime" | "onInk" }) {
  return (
    <kbd
      className={cx(
        "flex size-5 shrink-0 items-center justify-center rounded-[5px] tabular-nums text-[11px]/3.5",
        tone === "onLime" && "bg-[#FFFFFF99] font-semibold text-ink",
        tone === "onInk" && "bg-[#FFFFFF2E] font-semibold text-white",
        tone === "plain" && "border border-[#200D0D1F] font-medium text-[#200D0D99]",
      )}
    >
      {children}
    </kbd>
  );
}

/** "/" focuses the screen's search field. */
export function useSlashToFocus(ref: { current: HTMLInputElement | null }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || isTypingTarget(e)) return;
      e.preventDefault();
      ref.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ref]);
}
