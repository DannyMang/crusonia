// Onboarding frame (Paper "Onboarding · 1-4"): header with the logo, the 4-step progress pills and the
// account, then the step. Full page, no dashboard sidebar. The design's "Want a hand setting up?" band is
// left out on purpose: there is no booking page to link to yet.
import { Fragment } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { useSession } from "../../auth.tsx";
import { Logo } from "../../components/icons.tsx";
import { WhiteCheck } from "../../components/onboarding/ui.tsx";
import { cx } from "../../lib/format.ts";

const STEPS = ["Your company", "Reading your site", "Your ideal customer", "First leads"] as const;

export default function OnboardingLayout() {
  const { pathname } = useLocation();
  const current = Number(/\/onboarding\/(\d)/.exec(pathname)?.[1] ?? 1);
  return (
    <div className="flex min-h-screen flex-col bg-white text-xs/4 text-ink">
      <Header current={current} />
      <main className="flex grow flex-col">
        <Outlet />
      </main>
    </div>
  );
}

function Header({ current }: { current: number }) {
  const { user } = useSession();
  const email = user?.email ?? null;
  const letter = (email ?? user?.name ?? "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-b-[#200D0D0F] px-4 sm:px-8">
      <Link to="/app" className="flex shrink-0 items-center gap-2 xl:w-60" aria-label="Crusonia dashboard">
        <Logo size={32} />
        <span className="hidden text-xl/6 font-semibold tracking-[-0.02em] text-ink sm:inline">crusonia</span>
      </Link>
      <nav aria-label="Onboarding steps" className="flex min-w-0 items-center gap-1.5">
        {STEPS.map((label, i) => {
          const n = i + 1;
          return (
            <Fragment key={label}>
              {i > 0 ? <span aria-hidden className="hidden h-px w-4 shrink-0 bg-[#200D0D26] sm:block" /> : null}
              <StepPill n={n} label={label} state={n < current ? "done" : n === current ? "current" : "todo"} />
            </Fragment>
          );
        })}
      </nav>
      <div className="flex shrink-0 items-center justify-end gap-2.5 xl:w-60">
        {email ? <span className="hidden truncate text-[13px]/4 font-medium text-muted xl:block">{email}</span> : null}
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-highlight text-[13px]/4 font-semibold text-ink" aria-hidden>
          {letter}
        </span>
      </div>
    </header>
  );
}

function StepPill({ n, label, state }: { n: number; label: string; state: "done" | "current" | "todo" }) {
  const body = (
    <>
      {state === "done" ? (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-green">
          <WhiteCheck size={11} />
        </span>
      ) : (
        <span className={cx("flex size-5 shrink-0 items-center justify-center rounded-full text-[11px]/3.5 font-semibold", state === "current" ? "bg-white text-ink" : "bg-pill text-muted")}>
          {n}
        </span>
      )}
      <span className={cx("whitespace-nowrap text-[13px]/4 font-medium", state === "todo" ? "text-muted" : "text-ink", state === "current" ? "hidden sm:inline" : "hidden lg:inline")}>{label}</span>
    </>
  );
  const cls = cx("flex h-7.5 shrink-0 items-center gap-2 rounded-full pl-1.5 pr-1.5 sm:pr-3", state === "current" && "bg-lime", state !== "current" && "lg:pr-3");
  if (state === "done") {
    return (
      <Link to={`/onboarding/${n}`} className={cx(cls, "hover:bg-[#200D0D08]")} aria-label={`Step ${n}, ${label} (done)`}>
        {body}
      </Link>
    );
  }
  return (
    <span className={cls} aria-current={state === "current" ? "step" : undefined}>
      {body}
    </span>
  );
}
