// Auth for the dashboard. Production: Clerk (the API verifies the Clerk session token sent as
// `Authorization: Bearer <token>`, fetched fresh with getToken() per request). Clerk itself lives in
// auth-clerk.tsx and is loaded on demand, so the landing page skips it for visitors who are not signed in.
// Local development only (`import.meta.env.DEV`, compiled out of production builds):
//   - `bun run dev:mock` (VITE_MSW=1): MSW answers /api, so no sign-in is needed;
//   - sessionStorage `crusonia.devToken` = the MCP_TOKEN from .dev.vars: talk to `wrangler dev` without Clerk.
import { createContext, lazy, Suspense, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { createApi, type Api, type TokenGetter } from "./api.ts";
import { safeNext } from "./lib/safe-next.ts";

const ClerkAuth = lazy(() => import("./auth-clerk.tsx"));

export const CLERK_PUBLISHABLE_KEY: string | undefined = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || undefined;
export const clerkEnabled = Boolean(CLERK_PUBLISHABLE_KEY);

function devToken(): string | null {
  try {
    return sessionStorage.getItem("crusonia.devToken");
  } catch {
    return null;
  }
}

/** True only in `vite dev` with mocks on or a dev token set. Always false in production builds. */
export const devBypass: boolean = import.meta.env.DEV && (import.meta.env.VITE_MSW === "1" || Boolean(devToken()));

export type AuthUser = { id: string | null; name: string | null; email: string | null; imageUrl: string | null };

export type AuthState = {
  isLoaded: boolean;
  isSignedIn: boolean;
  user: AuthUser | null;
  getToken: TokenGetter;
  /** Back to /sign-in, or `redirectUrl`. */
  signOut: (redirectUrl?: string) => Promise<void>;
};

export const AuthContext = createContext<AuthState | null>(null);

export function useSession(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useSession must be used inside <AuthProvider>");
  return ctx;
}

/** The typed API client, authenticated as the current session. Stable across renders. */
export function useApi(): Api {
  const { getToken } = useSession();
  const ref = useRef(getToken);
  ref.current = getToken;
  return useMemo(() => createApi(() => ref.current()), []);
}

export const devState: AuthState = {
  isLoaded: true,
  isSignedIn: true,
  user: { id: null, name: "Local dev", email: "dev@localhost", imageUrl: null },
  getToken: async () => devToken() ?? "msw",
  signOut: async () => {
    try {
      sessionStorage.removeItem("crusonia.devToken");
    } catch {
      // ignore
    }
  },
};

const signedOut: AuthState = {
  isLoaded: true,
  isSignedIn: false,
  user: null,
  getToken: async () => null,
  signOut: async () => {},
};
const checking: AuthState = { ...signedOut, isLoaded: false };

/**
 * Clerk's "this browser has signed in here" cookie: __client_uat (or a suffixed variant) holds the time of the
 * last sign-in and is "0" after signing out. Readable on this host, so it tells the landing page whether
 * loading Clerk can change anything.
 */
function maybeSignedIn(): boolean {
  try {
    return document.cookie.split(";").some((c) => {
      const [name, value] = c.trim().split("=");
      return /^__client_uat(_|$)/.test(name ?? "") && Boolean(value) && value !== "0";
    });
  } catch {
    return true;
  }
}

/**
 * Must sit inside the router (Clerk navigates with React Router). On the landing and pricing pages a visitor without
 * Clerk's session cookie is simply signed out, and Clerk (its SDK and its scripts) is not loaded. Every other
 * page, or a visitor who may be signed in, loads it; once loaded it stays.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // Public marketing pages: the landing and /pricing.
  const landing = pathname === "/" || pathname === "/pricing";
  const [clerkNeeded, setClerkNeeded] = useState(() => !landing || maybeSignedIn());
  if (!clerkNeeded && !landing) setClerkNeeded(true);

  if (CLERK_PUBLISHABLE_KEY) {
    if (!clerkNeeded) return <AuthContext.Provider value={devBypass ? devState : signedOut}>{children}</AuthContext.Provider>;
    // While Clerk's code loads, the landing page renders as "checking" (it only redirects once signed in is
    // known); other pages may use Clerk's hooks directly, so they wait.
    const loading = landing ? <AuthContext.Provider value={checking}>{children}</AuthContext.Provider> : <FullPageSpinner />;
    return (
      <Suspense fallback={loading}>
        <ClerkAuth publishableKey={CLERK_PUBLISHABLE_KEY} navigate={navigate}>
          {children}
        </ClerkAuth>
      </Suspense>
    );
  }
  if (devBypass) return <AuthContext.Provider value={devState}>{children}</AuthContext.Provider>;
  return <MissingConfig />;
}

function MissingConfig() {
  return (
    <div className="grid min-h-screen place-items-center p-8">
      <div className="max-w-md text-[15px]/6">
        <div className="font-semibold">Sign-in is not configured</div>
        <p className="mt-2 text-muted">
          Build the app with <code className="text-[13px]">VITE_CLERK_PUBLISHABLE_KEY</code> set, or run{" "}
          <code className="text-[13px]">bun run dev:mock</code> to try it with sample data.
        </p>
      </div>
    </div>
  );
}

export function FullPageSpinner() {
  return (
    <div className="grid min-h-screen place-items-center" aria-busy="true" aria-label="Loading">
      <span className="size-5 rounded-full border-2 border-hairline border-t-ink [animation:crusonia-spin_0.8s_linear_infinite]" />
    </div>
  );
}

/** Gate for signed-in routes: waits for Clerk, then sends signed-out visitors to /sign-in and back after. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useSession();
  const location = useLocation();
  if (!isLoaded) return <FullPageSpinner />;
  if (!isSignedIn) {
    const back = location.pathname + location.search;
    return <Navigate to={`/sign-in?redirect_url=${encodeURIComponent(back)}`} replace />;
  }
  return <>{children}</>;
}

/** For /sign-in and /sign-up: a signed-in visitor goes on to `redirect_url`, else `fallback` (the app). */
export function RedirectIfSignedIn({ children, fallback = "/app" }: { children: ReactNode; fallback?: string }) {
  const { isLoaded, isSignedIn } = useSession();
  const location = useLocation();
  if (devBypass) return <>{children}</>;
  if (isLoaded && isSignedIn) {
    const next = new URLSearchParams(location.search).get("redirect_url");
    const website = new URLSearchParams(location.search).get("website");
    const target = safeNext(next) ?? fallback;
    // A signed-in visitor from the landing page (/sign-up?website=…) keeps the website for onboarding.
    return <Navigate to={website && !next ? `${target}?website=${encodeURIComponent(website)}` : target} replace />;
  }
  return <>{children}</>;
}
