// The dashboard sidebar, identical on every screen (Paper: "Final · Settings · Team" > Sidebar, "Final · Workspace
// switcher"). Below 1024px it moves into a drawer behind a top bar (MobileBar).
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ComponentType, type FormEvent, type SVGProps } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { isApiError } from "../api.ts";
import { useApi, useSession } from "../auth.tsx";
import { cx, initials, num, usd } from "../lib/format.ts";
import { openWorkspace } from "../lib/workspace.ts";
import { useBilling, usePause, usePendingCount, useSetPause, useWorkspaces } from "../queries.ts";
import {
  ApprovalsIcon,
  CheckIcon,
  ChevronRight,
  ChevronUpDown,
  HomeIcon,
  IntegrationsIcon,
  LeadsIcon,
  Logo,
  PlusIcon,
  RepliesIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
  WorkflowsIcon,
  XIcon,
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
                "flex h-5 min-w-5.5 items-center justify-center rounded-full px-1.75 tabular-nums text-[11px]/3 font-semibold",
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
        <span className="text-[11px]/3.5 font-medium text-muted">{paused ? "Nothing goes out until resumed" : "Pause all outgoing email"}</span>
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
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    // Esc closes the menu and puts focus back on the button that opened it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
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
      <button ref={button} type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex h-10 w-full shrink-0 items-center gap-2.5 rounded-lg pl-2.5 pr-2 text-left hover:bg-[#200D0D08]">
        {user?.imageUrl ? (
          <img src={user.imageUrl} alt="" className="size-7 shrink-0 rounded-full object-cover" />
        ) : (
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-highlight text-[11px]/3 font-semibold text-ink">
            {initials(user?.name ?? user?.email, "·")}
          </span>
        )}
        <span className="flex min-w-0 grow flex-col gap-px">
          <span className="truncate text-[13px]/4 font-medium text-ink">{user?.name ?? "Signed in"}</span>
          <span className="truncate tabular-nums text-[11px]/3.5 text-muted">{user?.email ?? ""}</span>
        </span>
        <ChevronUpDown className="text-[rgb(32_13_13/40%)]" />
      </button>
    </div>
  );
}

const ROLE_LABEL = { owner: "Owner", admin: "Admin", member: "Member" } as const;

const WorkspaceMark = ({ name }: { name: string }) => (
  <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-md bg-pill text-xs/3 font-semibold text-ink">
    {(name.trim()[0] ?? "?").toUpperCase()}
  </span>
);

/** Which workspace you're in (Paper: "Final · Workspace switcher"). Switching is a full page load: see lib/workspace.ts. */
function WorkspaceSwitcher() {
  const api = useApi();
  const list = useWorkspaces();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    setCreating(false);
    setName("");
  };
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const create = useMutation({
    mutationFn: (n: string) => api.createWorkspace(n),
    // A new workspace is empty: start it like a new account.
    onSuccess: ({ workspace }) => openWorkspace(workspace.id, "/onboarding/1"),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) create.mutate(name.trim());
  }
  const rows = list.data?.data ?? [];
  const currentId = list.data?.current;
  const current = rows.find((w) => w.id === currentId);
  // Only the current one once a new one is being named, as designed.
  const shown = creating ? rows.filter((w) => w.id === currentId) : rows;
  if (list.isPending) return <span aria-hidden className="block h-8.5 shrink-0 rounded-lg bg-[#200D0D0A] [animation:crusonia-pulse_1.6s_ease-in-out_infinite]" />;
  if (!current) return null;
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`Workspace: ${current.name}. Switch workspace`}
        className="flex h-8.5 w-full items-center gap-2.5 rounded-lg pl-1.5 pr-2 text-left hover:bg-[#200D0D08]"
      >
        <WorkspaceMark name={current.name} />
        <span className="min-w-0 grow truncate text-[13px]/4 font-semibold text-ink">{current.name}</span>
        <ChevronUpDown className="shrink-0 text-[rgb(32_13_13/40%)]" />
      </button>
      {open ? (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 flex flex-col rounded-lg border border-[#200D0D1A] bg-white p-1 shadow-[0_8px_24px_-8px_#200D0D33]">
          <div className="flex max-h-72 flex-col overflow-y-auto">
            {shown.map((w) => {
              const here = w.id === currentId;
              return (
                <button
                  key={w.id}
                  type="button"
                  aria-current={here || undefined}
                  onClick={() => (here ? close() : openWorkspace(w.id))}
                  className={cx("flex h-11 shrink-0 items-center gap-2.5 rounded-md px-2 text-left", here ? "bg-[#200D0D08]" : "hover:bg-[#200D0D08]")}
                >
                  <WorkspaceMark name={w.name} />
                  <span className="flex min-w-0 grow flex-col gap-px">
                    <span className="truncate text-[13px]/4 font-medium text-ink">{w.name}</span>
                    <span className="text-[11px]/3.5 text-muted">{ROLE_LABEL[w.role]}</span>
                  </span>
                  <span className="flex size-4 shrink-0 items-center justify-center">{here ? <CheckIcon className="text-ink" /> : null}</span>
                </button>
              );
            })}
          </div>
          <div className="my-1 h-px shrink-0 bg-[#200D0D14]" />
          {creating ? (
            <form onSubmit={submit} className="flex flex-col gap-2 p-1.5">
              <input
                autoFocus
                value={name}
                maxLength={80}
                onChange={(e) => {
                  setName(e.target.value);
                  create.reset();
                }}
                placeholder="Workspace name"
                aria-label="Workspace name"
                className="h-8 rounded-md border border-[#200D0D1A] bg-white px-2.5 text-[13px]/4 font-medium text-ink outline-none placeholder:text-[#200D0D80] focus:border-ink"
              />
              {create.isError ? (
                <div role="alert" className="text-xs/4 font-medium text-[#B42318]">
                  {isApiError(create.error) && create.error.status < 500 ? create.error.message : "That didn't work. Try again."}
                </div>
              ) : null}
              <div className="flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setCreating(false);
                    setName("");
                    create.reset();
                  }}
                  className="flex h-6.75 items-center rounded-md border border-[#200D0D1A] bg-white px-2.5 text-xs/4 font-medium text-ink hover:bg-[#200D0D08]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!name.trim() || create.isPending || create.isSuccess}
                  className="flex h-6.75 items-center rounded-md bg-lime px-2.5 text-xs/4 font-medium text-ink hover:bg-[#b3de7a] disabled:cursor-default disabled:opacity-60"
                >
                  Create
                </button>
              </div>
            </form>
          ) : (
            <button type="button" onClick={() => setCreating(true)} className="flex h-9 shrink-0 items-center gap-2.5 rounded-md px-2 text-left hover:bg-[#200D0D08]">
              <span className="flex size-6 shrink-0 items-center justify-center text-ink">
                <PlusIcon />
              </span>
              <span className="text-[13px]/4 font-medium text-ink">Create workspace</span>
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The balance, always visible (Paper: "Settings · Billing" > Sidebar > Credits pill). Opens the billing page. */
function CreditsPill() {
  const billing = useBilling();
  const b = billing.data;
  return (
    <NavLink
      to="/app/settings/billing"
      aria-label={b ? `${num(b.balance)} credits (${usd(b.balance_usd)}). Open billing` : "Credits. Open billing"}
      title="Credit balance. Open billing"
      className="flex h-8.5 shrink-0 items-center gap-2 rounded-full bg-pill pl-3 pr-2.5 transition-colors hover:bg-[#E9E6E1]"
    >
      <CreditIcon />
      {b ? (
        <span className={cx("whitespace-nowrap tabular-nums text-[13px]/4 font-semibold", b.balance < 0 ? "text-[#B42318]" : "text-ink")}>{num(b.balance)} credits</span>
      ) : billing.isPending ? (
        <span aria-hidden className="block h-3.5 w-20 rounded bg-[#200D0D0F] [animation:crusonia-pulse_1.6s_ease-in-out_infinite]" />
      ) : (
        <span className="text-[13px]/4 font-semibold text-ink">Credits</span>
      )}
      <span className="grow" />
      {b ? <span className="tabular-nums text-xs/4 font-medium text-muted">{usd(b.balance_usd)}</span> : null}
      <ChevronRight width={12} height={12} className="text-[rgb(32_13_13/40%)]" />
    </NavLink>
  );
}

const CreditIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className="shrink-0">
    <circle cx="7" cy="7" r="5.6" fill="none" stroke="#200D0D" strokeWidth="1.3" />
    <path d="M7 4.2v5.6" fill="none" stroke="#200D0D" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

/** ⌘K / Ctrl+K jumps to lead search. */
function useSearchShortcut() {
  const navigate = useNavigate();
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
}

/** Everything in the sidebar; the desktop column and the phone drawer render the same thing. */
function SidebarContent({ drawer }: { drawer?: boolean }) {
  const pending = usePendingCount();
  const navigate = useNavigate();
  return (
    <>
      <NavLink to="/app" className="flex h-14.75 shrink-0 items-center gap-2.5 px-4.5">
        <Logo />
        <span className="text-[17px]/5 font-semibold tracking-[-0.02em] text-ink">crusonia</span>
      </NavLink>

      <div className="flex shrink-0 flex-col gap-1.5 px-2 pb-3">
        <WorkspaceSwitcher />
        <CreditsPill />
        <button
          type="button"
          onClick={() => navigate("/app/leads?focus=search")}
          className="flex h-8.5 shrink-0 items-center gap-2 rounded-lg border border-[#200D0D1A] bg-white pl-2.75 pr-2.5 text-left hover:bg-[#200D0D05]"
        >
          <SearchIcon className="text-[rgb(32_13_13/40%)]" />
          <span className="grow text-[13px]/4 font-medium text-ink">Search</span>
          {drawer ? null : <kbd className="flex rounded-sm border border-[#200D0D1A] px-1.5 py-0.5 font-sans text-xs/3 text-faint">⌘K</kbd>}
        </button>
      </div>

      <nav className="flex grow flex-col gap-3 overflow-y-auto px-2 pt-1" aria-label="Main">
        <div className="flex flex-col">
          <NavItem to="/app" end label="Home" icon={HomeIcon} />
          <NavItem to="/app/leads" label="Leads" icon={LeadsIcon} />
          <NavItem to="/app/outreach" label="Outreach" icon={ApprovalsIcon} badge={pending} />
          <NavItem to="/app/workflows" label="Workflows" icon={WorkflowsIcon} />
          <NavItem to="/app/replies" label="Replies" icon={RepliesIcon} />
        </div>
        <div className="flex flex-col border-t border-t-[#200D0D14] pt-3.25">
          <NavItem to="/app/integrations" label="Integrations" icon={IntegrationsIcon} />
          <NavItem to="/app/settings" label="Settings" icon={SettingsIcon} />
        </div>
      </nav>

      <div className="flex shrink-0 flex-col gap-1.5 border-t border-t-[#200D0D1A] px-2 pb-3 pt-2.25">
        <SendsSwitch />
        <UserMenu />
      </div>
    </>
  );
}

/** The 240px column, from `lg` (1024px) up. Below that, MobileBar takes its place. */
export function Sidebar() {
  useSearchShortcut();
  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col self-start border-r border-r-[#16A34A29] bg-white text-xs/4 lg:flex">
      <SidebarContent />
    </aside>
  );
}

/**
 * Below `lg`: a top bar with the menu button, the logo and the approvals count, and the sidebar in a drawer.
 * The drawer is a modal <dialog>, so focus stays inside, Esc closes it and the page behind cannot scroll;
 * it also closes on navigation and on a click outside it.
 */
export function MobileBar() {
  const pending = usePendingCount();
  const ref = useRef<HTMLDialogElement>(null);
  const { pathname, search } = useLocation();
  const close = () => ref.current?.close();
  useEffect(() => close(), [pathname, search]);
  return (
    <>
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-b-[#16A34A29] bg-white px-2 lg:hidden">
        <button
          type="button"
          onClick={() => ref.current?.showModal()}
          aria-label="Open menu"
          aria-haspopup="dialog"
          className="flex size-10 items-center justify-center rounded-lg text-ink hover:bg-[#200D0D08]"
        >
          <MenuIcon />
        </button>
        <NavLink to="/app" className="flex items-center gap-2">
          <Logo size={28} />
          <span className="text-base/5 font-semibold tracking-[-0.02em] text-ink">crusonia</span>
        </NavLink>
        <span className="grow" />
        {pending ? (
          <NavLink
            to="/app/outreach"
            aria-label={`${pending} waiting in Outreach`}
            className="flex h-8 items-center gap-1.5 rounded-full bg-ink px-3 tabular-nums text-xs/4 font-semibold text-white"
          >
            <ApprovalsIcon width={14} height={14} />
            {pending}
          </NavLink>
        ) : null}
      </header>
      <dialog
        ref={ref}
        aria-label="Menu"
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
        className="fixed inset-y-0 left-0 m-0 h-auto max-h-none w-72 max-w-[calc(100%-48px)] overflow-hidden border-r border-r-[#16A34A29] bg-white p-0 text-xs/4 text-ink shadow-[0_0_40px_#200D0D33] backdrop:bg-[#200D0D59] lg:hidden"
      >
        <div className="flex h-full flex-col">
          <SidebarContent drawer />
          <button
            type="button"
            onClick={close}
            aria-label="Close menu"
            className="absolute right-2 top-2.5 flex size-10 items-center justify-center rounded-lg text-ink hover:bg-[#200D0D08]"
          >
            <XIcon />
          </button>
        </div>
      </dialog>
    </>
  );
}

const MenuIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
    <path d="M3.5 6h13M3.5 10h13M3.5 14h13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);
