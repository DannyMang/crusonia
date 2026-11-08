// /sso-callback: where GitHub / Google send the browser back. Clerk's <HandleSSOCallback> finishes the sign-in
// or sign-up (including transfers between the two) and calls back here to navigate with React Router.
// Lands on the page remembered before leaving (sign in: redirect_url or /app; sign up: /onboarding/1).
import { HandleSSOCallback } from "@clerk/react";
import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { clerkEnabled } from "../../auth.tsx";
import { goTo, takeAfterAuth } from "../../components/auth/flow.ts";

export default function SsoCallback() {
  if (!clerkEnabled) return <Navigate to="/sign-in" replace />;
  return <ClerkSsoCallback />;
}

function ClerkSsoCallback() {
  const navigate = useNavigate();
  // Opened directly (no OAuth in progress), Clerk has nothing to finish: offer a way out instead of spinning.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 12_000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="grid min-h-screen place-items-center bg-white p-8 text-ink" aria-busy={!slow}>
      <div className="flex flex-col items-center gap-3 text-center">
        <span aria-hidden className="size-5 rounded-full border-2 border-[#200D0D26] border-t-ink [animation:crusonia-spin_0.8s_linear_infinite]" />
        <div className="text-[13px]/4.5 font-medium text-muted" role="status">
          {slow ? "This is taking longer than it should." : "Signing you in…"}
        </div>
        {slow ? (
          <Link to="/sign-in" className="text-[13px]/4.5 font-medium text-ink underline decoration-[#200D0D4D] underline-offset-[3px] hover:decoration-ink">
            Back to sign in
          </Link>
        ) : null}
        <HandleSSOCallback
          navigateToApp={(params) => goTo(navigate, takeAfterAuth() ?? "/app")(params)}
          navigateToSignIn={() => navigate("/sign-in", { replace: true })}
          navigateToSignUp={() => navigate("/sign-up", { replace: true })}
        />
      </div>
    </div>
  );
}
