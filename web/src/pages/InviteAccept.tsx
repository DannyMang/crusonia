// The link in an invite email, /invite/:token (Paper: "Final · Accept invite" and its states). Signed out: sign in or
// create an account, then back here. Signed in: one click to join. Whether the signed-in account may accept is the
// API's call (the invited address must be one of its verified emails), so a wrong account finds out on Accept.
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { isApiError, type InvitePreview } from "../api.ts";
import { FullPageSpinner, useApi, useSession } from "../auth.tsx";
import { AuthBrand, AuthHeading, AuthShell, FormError, PrimaryButton } from "../components/auth/AuthLayout.tsx";
import { openWorkspace } from "../lib/workspace.ts";

const secondary = "flex h-12 shrink-0 items-center justify-center rounded-[10px] border border-[#200D0D24] bg-white text-[15px]/4.5 font-semibold text-ink transition-colors hover:bg-[#200D0D06]";

const CLOSED: Record<string, string> = {
  invite_expired: "This invite has expired",
  invite_revoked: "This invite was revoked",
  invite_used: "This invite was already used",
  invite_not_found: "This invite link isn't valid",
};

const invitedAs = (invite: InvitePreview) => `${invite.inviter_name ?? "A teammate"} invited you as ${invite.role === "admin" ? "an admin" : "a member"}`;

export default function InviteAccept() {
  const { token = "" } = useParams();
  const api = useApi();
  const { isLoaded } = useSession();
  const preview = useQuery({ queryKey: ["invite", token], queryFn: () => api.invitePreview(token), retry: false, refetchOnWindowFocus: false });
  if (preview.isPending || !isLoaded) return <FullPageSpinner />;
  if (preview.isError) {
    const code = isApiError(preview.error) ? preview.error.code : "";
    return <Closed title={CLOSED[code] ?? "This invite didn't load"} known={code in CLOSED} />;
  }
  return <Open token={token} invite={preview.data.invite} />;
}

function Closed({ title, known }: { title: string; known: boolean }) {
  return (
    <AuthShell>
      <AuthBrand />
      <AuthHeading title={title} subtitle={known ? "Ask your teammate for a new one" : "Check your connection, then reload"} />
      <div className="flex flex-col pt-7.25">
        <Link to="/app" className={secondary}>
          Open Crusonia
        </Link>
      </div>
    </AuthShell>
  );
}

function Open({ token, invite }: { token: string; invite: InvitePreview }) {
  const api = useApi();
  const { isSignedIn, user, signOut } = useSession();
  const [switching, setSwitching] = useState(false);
  const here = `/invite/${token}`;
  const back = new URLSearchParams({ redirect_url: here, email: invite.email }).toString();
  const accept = useMutation({
    mutationFn: () => api.acceptInvite(token),
    onSuccess: (r) => openWorkspace(r.workspace.id),
  });
  const failure = isApiError(accept.error) ? accept.error : null;
  const wrongAccount = failure?.code === "invite_email_mismatch";
  if (failure?.status === 410) return <Closed title={CLOSED[failure.code] ?? "This invite has expired"} known />;

  if (wrongAccount) {
    return (
      <AuthShell>
        <AuthBrand />
        <AuthHeading title={`Join ${invite.workspace_name}`} subtitle={`This invite is for ${invite.email}`} />
        <div className="flex flex-col gap-3 pt-7.25">
          <FormError>You're signed in as {user?.email ?? "another account"}</FormError>
          <PrimaryButton
            type="button"
            loading={switching}
            onClick={() => {
              setSwitching(true);
              void signOut(`/sign-in?${back}`);
            }}
          >
            Switch account
          </PrimaryButton>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <AuthBrand />
      <AuthHeading title={`Join ${invite.workspace_name}`} subtitle={invitedAs(invite)} />
      {isSignedIn ? (
        <div className="flex flex-col gap-3 pt-7.25">
          {accept.isError ? <FormError>{failure && failure.status < 500 ? failure.message : "That didn't work. Try again."}</FormError> : null}
          <PrimaryButton type="button" loading={accept.isPending || accept.isSuccess} onClick={() => accept.mutate()}>
            Accept invite
          </PrimaryButton>
        </div>
      ) : (
        <div className="flex flex-col gap-3 pt-7.25">
          <div className="flex h-12 shrink-0 items-center rounded-[10px] bg-pill px-4 text-[15px]/4.5 font-[450] text-ink">
            <span className="truncate">{invite.email}</span>
          </div>
          <Link to={`/sign-in?${back}`} className="flex h-12 shrink-0 items-center justify-center rounded-[10px] bg-lime text-[15px]/4.5 font-semibold text-ink transition-colors hover:bg-[#b3de7a]">
            Sign in to accept
          </Link>
          <Link to={`/sign-up?${back}`} className={secondary}>
            Create an account
          </Link>
        </div>
      )}
    </AuthShell>
  );
}
