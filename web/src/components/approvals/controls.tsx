// Small helpers for the Outreach screen: a ticking clock and the check that keeps single-key shortcuts out of
// text fields.
import { useEffect, useState } from "react";

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
