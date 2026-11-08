// In-page anchors for the landing. The nav and "Or connect your agent" scroll to these; every other link on the
// page goes to a real route (/sign-in, /sign-up).
import type { MouseEvent } from "react";

export const SECTIONS = {
  howItWorks: "how-it-works",
  connect: "connect-your-agent",
} as const;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return false;
  el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
  return true;
}

/** onClick for `<a href="#id">`: smooth scroll, without touching history (React Router owns history.state). */
export function scrollOnClick(id: string) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    if (scrollToId(id)) e.preventDefault();
  };
}
