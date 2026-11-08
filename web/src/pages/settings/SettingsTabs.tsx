// The Settings sub-navigation (Paper: "Settings · Billing" > Settings tabs): General and Billing.
import { NavLink } from "react-router";
import { cx } from "../../lib/format.ts";

const TABS = [
  { to: "/app/settings", label: "General", end: true },
  { to: "/app/settings/billing", label: "Billing", end: false },
] as const;

export function SettingsTabs() {
  return (
    <nav aria-label="Settings" className="flex h-9 shrink-0 items-end gap-6 border-b border-b-[#200D0D1A]">
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            cx(
              "-mb-px flex h-9 items-center text-sm/4.5",
              isActive ? "border-b-[1.5px] border-b-ink font-semibold text-ink" : "pb-0.5 font-medium text-[#200D0D99] hover:text-ink",
            )
          }
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
