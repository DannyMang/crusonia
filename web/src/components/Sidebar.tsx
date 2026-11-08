// The dashboard sidebar, identical on every screen (Paper: "Dashboard · Home" > Sidebar).
import { useEffect, useRef, useState, type ComponentType, type SVGProps } from "react";
import { NavLink, useNavigate } from "react-router";
import { useSession } from "../auth.tsx";
import { cx, initials } from "../lib/format.ts";
import { usePause, usePendingCount, useProfile, useSetPause } from "../queries.ts";
import {
  ApprovalsIcon,
  ChevronUpDown,
  ExperimentsIcon,
  HomeIcon,
  IntegrationsIcon,
  LeadsIcon,
  Logo,
  RepliesIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
  TerminalIcon,
  WorkflowsIcon,
} from "./icons.tsx";

type Item = { to: string; label: string; icon: ComponentType<SVGProps<SVGSVGElement>>; end?: boolean; badge?: number };

function NavItem({ to, label, icon: Icon, end, badge }: Item) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cx(
          "flex h-8.75 shrink-0 items-center gap-5.25 rounded-lg pl-5.25 pr-2.5 text-[15px]/4.5 font-medium transition-colors",
          isActive ? "bg-lime text-ink" : "text-[#200D0DC7] hover:bg-[#200D0D08]",
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon className={isActive ? "text-ink" : "text-[rgb(32_13_13/78%)]"} />
          <span className="grow">{label}</span>
          {badge ? (
            <span
              className={cx(
                "flex h-5 min-w-5.5 items-center justify-center rounded-full px-1.75 font-mono text-[11px]/3 font-semibold",
                isActive ? "bg-white text-ink" : "bg-ink text-white",
              )}
            >
              {badge}
            </span>
          ) : null}
        </>
      )}
    </NavLink>
  );
}

function SendsSwitch() {
  const pause = usePause();
  const setPause = useSetPause();
  const paused = pause.data?.paused ?? false;
  const known = pause.isSuccess;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={known ? !paused : undefined}
      disabled={!known || setPause.isPending}
      onClick={() => setPause.mutate(!paused)}
      title={paused ? "Sends are paused. Click to turn them back on." : "Click to pause every outgoing email"}
      className={cx(
        "flex h-11 shrink-0 items-center gap-2.5 rounded-lg border pl-3 pr-2.5 text-left",
        paused ? "border-[#200D0D1A] bg-pill" : "border-panel-line bg-panel",
      )}
    >
      <SendIcon className={paused ? "text-[#200D0D80]" : "text-green"} />
      <span className="flex grow flex-col gap-px">
        <span className="text-[13px]/4 font-semibold text-ink">{!known ? "Sends" : paused ? "Sends: paused" : "Sends: on"}</span>
        <span className="text-[11px]/3.5 font-medium text-[#200D0D99]">{paused ? "Nothing goes out until resumed" : "Pause all outgoing email"}</span>
      </span>
      <span className={cx("flex h-5 w-8.5 shrink-0 rounded-full p-0.5 transition-colors", paused || !known ? "justify-start bg-[#200D0D33]" : "justify-end bg-green")}>
        <span className="size-4 shrink-0 rounded-full bg-white" />
      </span>
    </button>
  );
}

function UserMenu() {
  const { user, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {open ? (
        <div className="absolute bottom-full left-0 right-0 mb-1 rounded-lg border border-[#200D0D1A] bg-white p-1 shadow-[0_8px_24px_-8px_#200D0D33]">
          <NavLink to="/app/settings" onClick={() => setOpen(false)} className="block rounded-md px-2.5 py-2 text-[13px]/4 font-medium hover:bg-[#200D0D08]">
            Settings
          </NavLink>
          <button type="button" onClick={() => void signOut()} className="block w-full rounded-md px-2.5 py-2 text-left text-[13px]/4 font-medium hover:bg-[#200D0D08]">
            Sign out
          </button>
        </div>
      ) : null}
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex h-10 w-full shrink-0 items-center gap-2.5 rounded-lg pl-2.5 pr-2 text-left hover:bg-[#200D0D08]">
        {user?.imageUrl ? (
          <img src={user.imageUrl} alt="" className="size-7 shrink-0 rounded-full object-cover" />
        ) : (
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-highlight text-[11px]/3 font-semibold text-ink">
            {initials(user?.name ?? user?.email, "·")}
          </span>
        )}
        <span className="flex min-w-0 grow flex-col gap-px">
          <span className="truncate text-[13px]/4 font-medium text-ink">{user?.name ?? "Signed in"}</span>
          <span className="truncate font-mono text-[11px]/3.5 text-[#200D0D99]">{user?.email ?? ""}</span>
        </span>
        <ChevronUpDown className="text-[rgb(32_13_13/40%)]" />
      </button>
    </div>
  );
}

export function Sidebar() {
  const pending = usePendingCount();
  const profile = useProfile();
  const navigate = useNavigate();
  const company = profile.data?.company?.trim() || "Workspace";

  // ⌘K / Ctrl+K jumps to lead search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        navigate("/app/leads?focus=search");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  return (
    <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col self-start border-r border-r-[#16A34A29] bg-white text-xs/4">
      <NavLink to="/app" className="flex h-14.75 shrink-0 items-center gap-2.5 px-4.5">
        <Logo />
        <span className="text-[17px]/5 font-semibold tracking-[-0.02em] text-ink">crusonia</span>
      </NavLink>

      <div className="flex shrink-0 flex-col gap-1.5 px-2 pb-3">
        <div className="flex h-8.5 shrink-0 items-center gap-2 rounded-lg border border-[#200D0D1A] bg-white pl-2 pr-2.5">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-ink text-[11px]/3 font-semibold text-white">
            {company.charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0 grow truncate text-[13px]/4 font-medium text-ink">
            {company} <span className="text-[#200D0D99]">· Crusonia</span>
          </span>
          <ChevronUpDown className="text-[rgb(32_13_13/40%)]" />
        </div>
        <button
          type="button"
          onClick={() => navigate("/app/leads?focus=search")}
          className="flex h-8.5 shrink-0 items-center gap-2 rounded-lg border border-[#200D0D1A] bg-white pl-2.75 pr-2.5 text-left hover:bg-[#200D0D05]"
        >
          <SearchIcon className="text-[rgb(32_13_13/40%)]" />
          <span className="grow text-[13px]/4 font-medium text-ink">Search</span>
          <kbd className="flex rounded-sm border border-[#200D0D1A] px-1.5 py-0.5 font-sans text-xs/3 text-[#200D0D59]">⌘K</kbd>
        </button>
      </div>

      <nav className="flex grow flex-col gap-3 overflow-y-auto px-2 pt-1" aria-label="Main">
        <div className="flex flex-col">
          <NavItem to="/app" end label="Home" icon={HomeIcon} />
          <NavItem to="/app/leads" label="Leads" icon={LeadsIcon} />
          <NavItem to="/app/approvals" label="Approvals" icon={ApprovalsIcon} badge={pending} />
          <NavItem to="/app/workflows" label="Workflows" icon={WorkflowsIcon} />
          <NavItem to="/app/experiments" label="Experiments" icon={ExperimentsIcon} />
          <NavItem to="/app/replies" label="Replies" icon={RepliesIcon} />
        </div>
        <div className="flex flex-col border-t border-t-[#200D0D14] pt-3.25">
          <NavItem to="/app/integrations" label="Integrations" icon={IntegrationsIcon} />
          <NavItem to="/app/connect" label="Connect your agent" icon={TerminalIcon} />
          <NavItem to="/app/settings" label="Settings" icon={SettingsIcon} />
        </div>
      </nav>

      <div className="flex shrink-0 flex-col gap-1.5 border-t border-t-[#200D0D1A] px-2 pb-3 pt-2.25">
        <SendsSwitch />
        <UserMenu />
      </div>
    </aside>
  );
}
