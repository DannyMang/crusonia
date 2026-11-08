// The Settings sub-navigation (Paper: "Final · Settings · Team" > Settings tabs): General, Company summary, Team,
// Connect your agent, Billing. Tighter on phones; the row scrolls sideways when they don't fit. Members don't see
// Connect your agent: it's for making API keys, which they can't.
import { useEffect, useRef } from "react";
import { NavLink } from "react-router";
import { cx } from "../../lib/format.ts";
import { useRole } from "../../queries.ts";

const TABS = [
  { to: "/app/settings", label: "General", end: true },
  { to: "/app/settings/company", label: "Company summary", end: false },
  { to: "/app/settings/team", label: "Team", end: false },
  { to: "/app/settings/agent", label: "Connect your agent", end: false },
  { to: "/app/settings/billing", label: "Billing", end: false },
] as const;

export function SettingsTabs() {
  const nav = useRef<HTMLElement>(null);
  const { role } = useRole();
  // Keep the current tab in view when the row is scrolled sideways.
  useEffect(() => {
    const row = nav.current;
    const active = row?.querySelector<HTMLElement>('[aria-current="page"]');
    if (row && active) row.scrollLeft = Math.max(0, active.offsetLeft + active.offsetWidth - row.clientWidth);
  }, []);
  return (
    // The hairline is an inset shadow so the scrolling row can't clip the active tab's underline, which sits on it.
    <nav
      ref={nav}
      aria-label="Settings"
      className="relative flex h-9 shrink-0 items-end gap-2 overflow-x-auto shadow-[inset_0_-1px_0_#200D0D1A] [scrollbar-width:none] sm:gap-6 [&::-webkit-scrollbar]:hidden"
    >
      {TABS.filter((t) => role !== "member" || t.to !== "/app/settings/agent").map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            cx(
              "flex h-9 shrink-0 items-center whitespace-nowrap text-[13px]/4.5 focus-visible:-outline-offset-2 sm:text-sm/4.5",
              isActive ? "font-semibold text-ink shadow-[inset_0_-1.5px_0_var(--color-ink)]" : "pb-0.5 font-medium text-muted hover:text-ink",
            )
          }
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
