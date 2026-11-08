import { QueryClientProvider } from "@tanstack/react-query";
import { Component, lazy, Suspense, useEffect, useLayoutEffect, useSyncExternalStore, type ComponentType, type LazyExoticComponent, type ReactNode } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router";
import { AuthProvider, FullPageSpinner, RedirectIfSignedIn, RequireAuth } from "./auth.tsx";
import Landing from "./landing/Landing.tsx";
import { PHONE_QUERY, zoomFor } from "./lib/zoom.ts";
import { queryClient } from "./queries.ts";

// Every route but the landing page is its own chunk (React.lazy), so "/" loads only the landing. Inside the
// app the other pages are fetched in the background once the shell is up, so moving around stays instant.
type Loader = () => Promise<{ default: ComponentType }>;

const pages = {
  AppShell: () => import("./components/AppShell.tsx").then((m) => ({ default: m.AppShell })),
  Approvals: () => import("./pages/Approvals.tsx"),
  SignIn: () => import("./pages/auth/SignIn.tsx"),
  SignUp: () => import("./pages/auth/SignUp.tsx"),
  SsoCallback: () => import("./pages/auth/SsoCallback.tsx"),
  Connect: () => import("./pages/Connect.tsx"),
  Experiments: () => import("./pages/Experiments.tsx"),
  Home: () => import("./pages/Home.tsx"),
  Integrations: () => import("./pages/Integrations.tsx"),
  LeadDetail: () => import("./pages/LeadDetail.tsx"),
  Leads: () => import("./pages/Leads.tsx"),
  NotFound: () => import("./pages/NotFound.tsx"),
  OnboardingLayout: () => import("./pages/onboarding/Layout.tsx"),
  Step1Company: () => import("./pages/onboarding/Step1Company.tsx"),
  Step2Reading: () => import("./pages/onboarding/Step2Reading.tsx"),
  Step3Customer: () => import("./pages/onboarding/Step3Customer.tsx"),
  Step4Leads: () => import("./pages/onboarding/Step4Leads.tsx"),
  Pricing: () => import("./landing/Pricing.tsx"),
  Replies: () => import("./pages/Replies.tsx"),
  Settings: () => import("./pages/Settings.tsx"),
  SettingsBilling: () => import("./pages/settings/Billing.tsx"),
  WorkflowRun: () => import("./pages/WorkflowRun.tsx"),
  Workflows: () => import("./pages/Workflows.tsx"),
} satisfies Record<string, Loader>;

const L = {} as Record<keyof typeof pages, LazyExoticComponent<ComponentType>>;
for (const [name, load] of Object.entries(pages) as [keyof typeof pages, Loader][]) L[name] = lazy(load);

/** Fetch every page chunk while the browser is idle (they are cached, so this costs one download each). */
function usePreloadPages() {
  useEffect(() => {
    const run = () => Object.values(pages).forEach((load) => void load().catch(() => {}));
    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(run, { timeout: 3000 });
      return () => window.cancelIdleCallback(id);
    }
    const t = setTimeout(run, 1500);
    return () => clearTimeout(t);
  }, []);
}

/** A page inside the app shell: a quiet spinner in the main column while its chunk loads the first time. */
function PageSpinner() {
  return (
    <div className="grid min-h-[60vh] place-items-center" aria-busy="true" aria-label="Loading">
      <span className="size-5 rounded-full border-2 border-hairline border-t-ink [animation:crusonia-spin_0.8s_linear_infinite]" />
    </div>
  );
}

const page = (C: LazyExoticComponent<ComponentType>) => (
  <Suspense fallback={<PageSpinner />}>
    <C />
  </Suspense>
);
const screen = (C: LazyExoticComponent<ComponentType>) => (
  <Suspense fallback={<FullPageSpinner />}>
    <C />
  </Suspense>
);

/**
 * A page's code that does not arrive (offline, or a tab opened before a deploy replaced the chunks; main.tsx
 * reloads once for that) ends here instead of a blank screen.
 */
class LoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="grid min-h-screen place-items-center bg-white px-6 text-ink">
        <div role="alert" className="flex max-w-sm flex-col items-center gap-2 text-center">
          <h1 className="text-[15px]/5 font-semibold tracking-[-0.01em]">This page did not load</h1>
          <p className="text-[13px]/5 font-medium text-muted">Check your connection, then reload.</p>
          <button type="button" onClick={() => window.location.reload()} className="mt-2 inline-flex h-7.5 items-center rounded-full bg-lime px-3.5 text-[13px]/4 font-medium text-ink transition-colors hover:bg-[#b3de7a]">
            Reload
          </button>
        </div>
      </div>
    );
  }
}

function subscribePhone(onChange: () => void) {
  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** Sets the route's page scale on <html> (lib/zoom.ts) before paint, so a page never flashes at the wrong size. */
function AppZoom() {
  const { pathname } = useLocation();
  const phone = useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE_QUERY).matches);
  const zoom = zoomFor(pathname, phone);
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (zoom === 1) {
      root.style.removeProperty("zoom");
      root.style.removeProperty("--app-zoom");
      root.removeAttribute("data-app-zoom");
    } else {
      root.style.setProperty("zoom", String(zoom));
      root.style.setProperty("--app-zoom", String(zoom));
      root.setAttribute("data-app-zoom", "");
    }
  }, [zoom]);
  return null;
}

const Protected = () => {
  usePreloadPages();
  return (
    <RequireAuth>
      <Outlet />
    </RequireAuth>
  );
};

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppZoom />
        <LoadBoundary>
          <AuthProvider>
            <Routes>
              {/* Public landing page (web/src/landing/); it sends signed-in visitors to /app. */}
              <Route index element={<Landing />} />
              {/* Public pricing (web/src/landing/Pricing.tsx); tiers come from src/billing/catalog.ts. */}
              <Route path="pricing" element={screen(L.Pricing)} />

              <Route path="sign-in/*" element={<RedirectIfSignedIn>{screen(L.SignIn)}</RedirectIfSignedIn>} />
              <Route path="sign-up/*" element={<RedirectIfSignedIn fallback="/onboarding/1">{screen(L.SignUp)}</RedirectIfSignedIn>} />
              <Route path="sso-callback" element={screen(L.SsoCallback)} />

              <Route element={<Protected />}>
                <Route path="onboarding" element={screen(L.OnboardingLayout)}>
                  <Route index element={<Navigate to="1" replace />} />
                  <Route path="1" element={page(L.Step1Company)} />
                  <Route path="2" element={page(L.Step2Reading)} />
                  <Route path="3" element={page(L.Step3Customer)} />
                  <Route path="4" element={page(L.Step4Leads)} />
                </Route>

                <Route path="app" element={screen(L.AppShell)}>
                  <Route index element={page(L.Home)} />
                  <Route path="leads" element={page(L.Leads)} />
                  <Route path="leads/:id" element={page(L.LeadDetail)} />
                  <Route path="approvals" element={page(L.Approvals)} />
                  <Route path="approvals/:code" element={page(L.Approvals)} />
                  <Route path="workflows" element={page(L.Workflows)} />
                  <Route path="workflows/runs/:id" element={page(L.WorkflowRun)} />
                  <Route path="experiments" element={page(L.Experiments)} />
                  <Route path="experiments/:id" element={page(L.Experiments)} />
                  <Route path="replies" element={page(L.Replies)} />
                  <Route path="integrations" element={page(L.Integrations)} />
                  <Route path="connect" element={page(L.Connect)} />
                  <Route path="settings" element={page(L.Settings)} />
                  {/* Stripe Checkout success/cancel and the portal return here (src/billing/constants.ts BILLING_APP_PATH). */}
                  <Route path="settings/billing" element={page(L.SettingsBilling)} />
                  <Route path="*" element={page(L.NotFound)} />
                </Route>
              </Route>

              <Route path="*" element={screen(L.NotFound)} />
            </Routes>
          </AuthProvider>
        </LoadBoundary>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
