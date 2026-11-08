// Small controls for the Outreach screen: key hints, a ticking clock and the check that keeps single-key shortcuts
// out of text fields.
import { useEffect, useState, type ReactNode } from "react";
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

/** True when a key press is meant for a text field (or carries a modifier), so single-key shortcuts stay out of the way. */
export function isTypingTarget(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return true;
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
}

/** Keyboard hint inside buttons ("A", "E", "R"). */
export function Kbd({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "onLime" | "onInk" }) {
  return (
    <kbd
      className={cx(
        "flex size-5 shrink-0 items-center justify-center rounded-[5px] tabular-nums text-[11px]/3.5",
        tone === "onLime" && "bg-[#FFFFFF99] font-semibold text-ink",
        tone === "onInk" && "bg-[#FFFFFF2E] font-semibold text-white",
        tone === "plain" && "border border-[#200D0D1F] font-medium text-muted",
      )}
    >
      {children}
    </kbd>
  );
}
