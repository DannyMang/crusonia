// Clerk, loaded on demand by AuthProvider (auth.tsx): the landing page does not need it unless the visitor
// may already be signed in, so @clerk/react and Clerk's scripts stay off "/" for new visitors.
import { ClerkProvider, useAuth, useClerk, useUser } from "@clerk/react";
import { useMemo, type ReactNode } from "react";
import type { NavigateFunction } from "react-router";
import { AuthContext, devBypass, devState, type AuthState } from "./auth.tsx";
import { forgetWorkspace } from "./lib/workspace.ts";

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
                  // Clerk's generated placeholder is purple; without a real photo the sidebar shows initials.
                  imageUrl: user.hasImage ? user.imageUrl : null,
                }
              : null,
            getToken: () => getToken(),
            signOut: (redirectUrl = "/sign-in") => {
              forgetWorkspace();
              return clerk.signOut({ redirectUrl });
            },
          },
    [isLoaded, isSignedIn, user, getToken, clerk],
  );
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export default function ClerkAuth({ publishableKey, navigate, children }: { publishableKey: string; navigate: NavigateFunction; children: ReactNode }) {
  return (
    <ClerkProvider
      publishableKey={publishableKey}
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
