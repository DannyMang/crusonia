import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router";
import { AuthProvider, RedirectIfSignedIn, RequireAuth } from "./auth.tsx";
import { AppShell } from "./components/AppShell.tsx";
import Approvals from "./pages/Approvals.tsx";
import SignIn from "./pages/auth/SignIn.tsx";
import SignUp from "./pages/auth/SignUp.tsx";
import SsoCallback from "./pages/auth/SsoCallback.tsx";
import Connect from "./pages/Connect.tsx";
import Experiments from "./pages/Experiments.tsx";
import Home from "./pages/Home.tsx";
import Integrations from "./pages/Integrations.tsx";
import LeadDetail from "./pages/LeadDetail.tsx";
import Leads from "./pages/Leads.tsx";
import NotFound from "./pages/NotFound.tsx";
import OnboardingLayout from "./pages/onboarding/Layout.tsx";
import Step1Company from "./pages/onboarding/Step1Company.tsx";
import Step2Reading from "./pages/onboarding/Step2Reading.tsx";
import Step3Customer from "./pages/onboarding/Step3Customer.tsx";
import Step4Leads from "./pages/onboarding/Step4Leads.tsx";
import Replies from "./pages/Replies.tsx";
import Settings from "./pages/Settings.tsx";
import WorkflowRun from "./pages/WorkflowRun.tsx";
import Workflows from "./pages/Workflows.tsx";
import { queryClient } from "./queries.ts";

const Protected = () => (
  <RequireAuth>
    <Outlet />
  </RequireAuth>
);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            {/* "/" is reserved for the public landing page (web/src/landing/), which sends signed-in visitors to /app. */}

            <Route path="sign-in/*" element={<RedirectIfSignedIn><SignIn /></RedirectIfSignedIn>} />
            <Route path="sign-up/*" element={<RedirectIfSignedIn fallback="/onboarding/1"><SignUp /></RedirectIfSignedIn>} />
            <Route path="sso-callback" element={<SsoCallback />} />

            <Route element={<Protected />}>
              <Route path="onboarding" element={<OnboardingLayout />}>
                <Route index element={<Navigate to="1" replace />} />
                <Route path="1" element={<Step1Company />} />
                <Route path="2" element={<Step2Reading />} />
                <Route path="3" element={<Step3Customer />} />
                <Route path="4" element={<Step4Leads />} />
              </Route>

              <Route path="app" element={<AppShell />}>
                <Route index element={<Home />} />
                <Route path="leads" element={<Leads />} />
                <Route path="leads/:id" element={<LeadDetail />} />
                <Route path="approvals" element={<Approvals />} />
                <Route path="approvals/:code" element={<Approvals />} />
                <Route path="workflows" element={<Workflows />} />
                <Route path="workflows/runs/:id" element={<WorkflowRun />} />
                <Route path="experiments" element={<Experiments />} />
                <Route path="experiments/:id" element={<Experiments />} />
                <Route path="replies" element={<Replies />} />
                <Route path="integrations" element={<Integrations />} />
                <Route path="connect" element={<Connect />} />
                <Route path="settings" element={<Settings />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
