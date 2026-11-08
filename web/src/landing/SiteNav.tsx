// The floating marketing nav shared by the landing page and /pricing (Paper: "Landing · v2" and "Pricing · proposal"
// > Floating nav). On the landing the section links scroll in place; elsewhere they go to "/#<section>", which the
// landing scrolls to on arrival. Every link goes somewhere real: sections, /pricing, /sign-in, /sign-up, /app and
// the public GitHub repo. Below `md` the section links (and Sign in, below `sm`) move into a menu.
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { useSession } from "../auth.tsx";
import { Logo } from "../components/icons.tsx";
import { cx } from "../lib/format.ts";
import { SECTIONS, scrollOnClick } from "./sections.ts";

export const GITHUB_URL = "https://github.com/DannyMang/crusonia";

const navLink = "text-base/5 font-medium text-ink transition-colors hover:text-[#200D0DB3]";

const menuLink = "flex h-12 items-center rounded-xl px-4 text-base/5 font-medium text-ink transition-colors hover:bg-[#200D0D08]";

export function SiteNav({ page }: { page: "landing" | "pricing" }) {
  const { isLoaded, isSignedIn } = useSession();
  const onLanding = page === "landing";
  const signedIn = isLoaded && isSignedIn && !onLanding;
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const ref = useRef<HTMLDivElement>(null);

  // The phone menu closes on Esc and on a click outside it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const section = (id: string, text: string, className = navLink) =>
    onLanding ? (
      <a
        href={`#${id}`}
        onClick={(e) => {
          setOpen(false);
          scrollOnClick(id)(e);
        }}
        className={className}
      >
        {text}
      </a>
    ) : (
      <Link to={{ pathname: "/", hash: `#${id}` }} className={className}>
        {text}
      </Link>
    );

  return (
    <header className={cx(onLanding ? "fixed inset-x-3 top-3 z-50 sm:inset-x-6 sm:top-5" : "relative z-50 px-3 pt-3 sm:px-6 sm:pt-5")}>
      <div ref={ref} className="relative">
        <nav aria-label="Main" className="flex h-14 items-center justify-between rounded-2xl bg-white pr-2 pl-4 shadow-[0_10px_30px_#200D0D1A] sm:h-16 sm:pr-3 sm:pl-6">
          <div className="flex items-center gap-11">
            {onLanding ? (
              <a
                href="#top"
                aria-label="Crusonia, back to top"
                className="flex items-center gap-2.5"
                onClick={(e) => {
                  e.preventDefault();
                  window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
                }}
              >
                <Logo size={34} className="size-7.5 sm:size-8.5" />
                <span className="text-lg/6 font-semibold sm:text-xl/6">crusonia</span>
              </a>
            ) : (
              <Link to="/" aria-label="Crusonia home" className="flex items-center gap-2.5">
                <Logo size={34} className="size-7.5 sm:size-8.5" />
                <span className="text-lg/6 font-semibold sm:text-xl/6">crusonia</span>
              </Link>
            )}
            <div className="hidden items-center gap-7 md:flex">
              {section(SECTIONS.howItWorks, "How it works")}
              {section(SECTIONS.connect, "Connect your agent")}
              <Link
                to="/pricing"
                aria-current={page === "pricing" ? "page" : undefined}
                className={cx(navLink, page === "pricing" && "font-semibold underline decoration-[1.5px] underline-offset-[6px]")}
              >
                Pricing
              </Link>
            </div>
          </div>
          <div className="flex items-center gap-1 sm:gap-2">
            {page === "pricing" ? (
              <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="hidden h-10.5 items-center gap-2 px-2.5 sm:px-3.5 md:flex" aria-label="Crusonia on GitHub">
                <GitHubMark size={18} />
                <span className="hidden text-base/5 font-medium text-ink sm:inline">GitHub</span>
              </a>
            ) : null}
            {signedIn ? (
              <Link to="/app" className="flex h-10.5 items-center rounded-lg bg-ink px-4 text-[15px]/5 font-bold text-white transition-colors hover:bg-[#3A2424] sm:px-5 sm:text-base/5">
                Open app
              </Link>
            ) : (
              <>
                <Link
                  to="/sign-in"
                  className="hidden h-10.5 items-center rounded-lg px-3 text-[15px]/5 font-semibold text-ink transition-colors hover:bg-[#200D0D08] sm:flex sm:border sm:border-[#200D0D26] sm:px-5 sm:text-base/5"
                >
                  Sign in
                </Link>
                <Link to="/sign-up" className="flex h-10.5 items-center rounded-lg bg-ink px-4 text-[15px]/5 font-bold text-white transition-colors hover:bg-[#3A2424] sm:px-5 sm:text-base/5">
                  Get started
                </Link>
              </>
            )}
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls={menuId}
              aria-label={open ? "Close menu" : "Open menu"}
              className="flex size-10.5 items-center justify-center rounded-lg text-ink transition-colors hover:bg-[#200D0D08] md:hidden"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
                {open ? (
                  <path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                ) : (
                  <path d="M3.5 6h13M3.5 10h13M3.5 14h13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                )}
              </svg>
            </button>
          </div>
        </nav>
        {open ? (
          <div id={menuId} className="absolute inset-x-0 top-full mt-2 flex flex-col rounded-2xl bg-white p-2 shadow-[0_10px_30px_#200D0D26] md:hidden">
            {section(SECTIONS.howItWorks, "How it works", menuLink)}
            {section(SECTIONS.connect, "Connect your agent", menuLink)}
            <Link to="/pricing" onClick={() => setOpen(false)} aria-current={page === "pricing" ? "page" : undefined} className={cx(menuLink, page === "pricing" && "font-semibold")}>
              Pricing
            </Link>
            {page === "pricing" ? (
              <a href={GITHUB_URL} target="_blank" rel="noreferrer" className={cx(menuLink, "gap-2.5")}>
                <GitHubMark size={18} />
                GitHub
              </a>
            ) : null}
            {signedIn ? null : (
              <Link to="/sign-in" className={cx(menuLink, "sm:hidden")}>
                Sign in
              </Link>
            )}
          </div>
        ) : null}
      </div>
    </header>
  );
}

export function GitHubMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className="shrink-0">
      <path
        fill="#200D0D"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}
