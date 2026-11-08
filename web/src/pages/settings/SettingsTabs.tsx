// The Settings sub-navigation (Paper: "Settings · Company summary" > Settings tabs): General, Company summary, Billing, API keys
// (Paper: "Final · Connect agent popover" > Manage keys).
import { NavLink } from "react-router";
import { cx } from "../../lib/format.ts";

const TABS = [
  { to: "/app/settings", label: "General", end: true },
  { to: "/app/settings/company", label: "Company summary", end: false },
  { to: "/app/settings/billing", label: "Billing", end: false },
  { to: "/app/settings/keys", label: "API keys", end: false },
] as const;

export function SettingsTabs() {
  return (
    <nav aria-label="Settings" className="flex h-9 shrink-0 items-end gap-4 border-b border-b-[#200D0D1A] sm:gap-6">
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            cx(
              "-mb-px flex h-9 shrink-0 items-center whitespace-nowrap text-sm/4.5",
              isActive ? "border-b-[1.5px] border-b-ink font-semibold text-ink" : "pb-0.5 font-medium text-muted hover:text-ink",
            )
          }
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
