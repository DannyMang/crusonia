// Auth for the dashboard. Production: Clerk (the API verifies the Clerk session token sent as
// `Authorization: Bearer <token>`, fetched fresh with getToken() per request).
// Local development only (`import.meta.env.DEV`, compiled out of production builds):
//   - `bun run dev:mock` (VITE_MSW=1): MSW answers /api, so no sign-in is needed;
//   - sessionStorage `crusonia.devToken` = the MCP_TOKEN from .dev.vars: talk to `wrangler dev` without Clerk.
import { ClerkProvider, useAuth, useClerk, useUser } from "@clerk/react";
import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { createApi, type Api, type TokenGetter } from "./api.ts";

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

type AuthState = {
  isLoaded: boolean;
  isSignedIn: boolean;
  user: AuthUser | null;
  getToken: TokenGetter;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

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

const devState: AuthState = {
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

function ClerkBridge({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const { user } = useUser();
  const clerk = useClerk();
  const state = useMemo<AuthState>(
    () =>
      devBypass
        ? devState
        : {
            isLoaded,
            isSignedIn: Boolean(isSignedIn),
            user: user
              ? {
                  id: user.id,
                  name: user.fullName ?? user.firstName ?? null,
                  email: user.primaryEmailAddress?.emailAddress ?? null,
                  imageUrl: user.imageUrl ?? null,
                }
              : null,
            getToken: () => getToken(),
            signOut: () => clerk.signOut({ redirectUrl: "/sign-in" }),
          },
    [isLoaded, isSignedIn, user, getToken, clerk],
  );
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

/** Must sit inside the router (Clerk navigates with React Router). */
export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  if (CLERK_PUBLISHABLE_KEY) {
    return (
      <ClerkProvider
        publishableKey={CLERK_PUBLISHABLE_KEY}
        routerPush={(to) => navigate(to)}
        routerReplace={(to) => navigate(to, { replace: true })}
        signInUrl="/sign-in"
        signUpUrl="/sign-up"
        signInFallbackRedirectUrl="/app"
        signUpFallbackRedirectUrl="/onboarding/1"
        afterSignOutUrl="/sign-in"
      >
        <ClerkBridge>{children}</ClerkBridge>
      </ClerkProvider>
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
          Build the app with <code className="tabular-nums text-[13px]">VITE_CLERK_PUBLISHABLE_KEY</code> set, or run{" "}
          <code className="tabular-nums text-[13px]">bun run dev:mock</code> to try it with sample data.
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
    const target = next && next.startsWith("/") && !next.startsWith("//") ? next : fallback;
    // A signed-in visitor from the landing page (/sign-up?website=…) keeps the website for onboarding.
    return <Navigate to={website && !next ? `${target}?website=${encodeURIComponent(website)}` : target} replace />;
  }
  return <>{children}</>;
}
