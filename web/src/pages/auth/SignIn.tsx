// Sign in (Paper artboard 2LWH-0). Clerk Core 3 custom flow (signal API): GitHub / Google via signIn.sso(),
// or email: signIn.create({ identifier }) -> emailCode.sendCode() -> emailCode.verifyCode({ code }) ->
// finalize() to `redirect_url` (same-origin paths only) or /app. Without a publishable key the same layout
// renders disabled, so Clerk hooks never run outside <ClerkProvider>.
import { useAuth, useClerk, useSignIn } from "@clerk/react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { clerkEnabled } from "../../auth.tsx";
import { ALL_PROVIDERS, AuthLoadFailed, CodeForm, StartForm, SwitchLine, useLoadTimedOut, type Provider } from "../../components/auth/AuthLayout.tsx";
import { clerkMessage, enabledProviders, goTo, isEmail, providerOffMessage, rememberAfterAuth, safeNext } from "../../components/auth/flow.ts";

const TITLE = "Welcome back";
const SUBTITLE = "Sign in to your Crusonia workspace";
const TWO_FACTOR = "This account has two-step verification turned on, which this screen does not support yet.";

const footer = <SwitchLine className="pt-5" text="New to Crusonia?" to="/sign-up" label="Create an account" />;

export default function SignIn() {
  return clerkEnabled ? <ClerkSignIn /> : <StaticSignIn />;
}

function StaticSignIn() {
  return <StartForm title={TITLE} subtitle={SUBTITLE} email="" disabled note="Sign-in is not configured in this build." footer={footer} />;
}

type Pending = Provider | "email" | "verify" | "resend" | null;

function ClerkSignIn() {
  const { signIn, errors } = useSignIn();
  const { isLoaded } = useAuth();
  const clerk = useClerk();
  const providers = enabledProviders(clerk, ALL_PROVIDERS, isLoaded);
  const loadFailed = useLoadTimedOut(isLoaded);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("redirect_url")) ?? "/app";

  const [step, setStep] = useState<"start" | "code">("start");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const [emailHint, setEmailHint] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Sent back here by /sso-callback because the account needs a second factor.
  const status = signIn?.status;
  useEffect(() => {
    if (status === "needs_second_factor") setMessage(TWO_FACTOR);
  }, [status]);

  // Only errors from the action just taken (Clerk keeps the last error on the resource across steps).
  const identifierError = step === "start" ? clerkMessage(errors.fields.identifier) : null;
  const codeError = step === "code" ? clerkMessage(errors.fields.code) : null;
  const formError = identifierError || codeError ? null : message;

  async function onProvider(p: Provider) {
    setPending(p);
    setMessage(null);
    rememberAfterAuth(next);
    const { error } = await signIn.sso({ strategy: p === "github" ? "oauth_github" : "oauth_google", redirectUrl: next, redirectCallbackUrl: "/sso-callback" });
    // On success the browser is already leaving for GitHub / Google.
    if (error) {
      setMessage(providerOffMessage(error, p) ?? clerkMessage(error) ?? "Could not reach the sign-in provider. Try again.");
      setPending(null);
    }
  }

  async function onEmail() {
    if (!isEmail(email)) {
      setEmailHint("Enter your work email, like you@company.com");
      return;
    }
    setPending("email");
    setMessage(null);
    setNote(null);
    const created = await signIn.create({ identifier: email.trim() });
    if (created.error) {
      setMessage(clerkMessage(created.error));
      setPending(null);
      return;
    }
    const sent = await signIn.emailCode.sendCode();
    setPending(null);
    if (sent.error) {
      setMessage(clerkMessage(sent.error));
      return;
    }
    setStep("code");
  }

  async function onVerify() {
    setPending("verify");
    setMessage(null);
    setNote(null);
    const verified = await signIn.emailCode.verifyCode({ code });
    if (verified.error) {
      setMessage(clerkMessage(verified.error));
      setPending(null);
      return;
    }
    if (signIn.status === "complete") {
      const done = await signIn.finalize({ navigate: goTo(navigate, next) });
      if (done.error) {
        setMessage(clerkMessage(done.error));
        setPending(null);
      }
      return;
    }
    setPending(null);
    setMessage(signIn.status === "needs_second_factor" ? TWO_FACTOR : "Signing in needs another step that this screen does not support yet. Continue with GitHub or Google instead.");
  }

  async function onResend() {
    setPending("resend");
    setMessage(null);
    const { error } = await signIn.emailCode.sendCode();
    setPending(null);
    if (error) setMessage(clerkMessage(error));
    else setNote(`We sent a new code to ${email.trim()}.`);
  }

  async function onBack() {
    await signIn.reset();
    setStep("start");
    setCode("");
    setMessage(null);
    setNote(null);
  }

  if (loadFailed) return <AuthLoadFailed title={TITLE} subtitle={SUBTITLE} footer={footer} />;

  if (step === "code") {
    return (
      <CodeForm
        email={email.trim()}
        code={code}
        onCodeChange={setCode}
        onSubmit={() => void onVerify()}
        onResend={() => void onResend()}
        onBack={() => void onBack()}
        pending={pending === "verify" || pending === "resend" ? pending : null}
        codeError={codeError}
        formError={formError}
        note={note}
      />
    );
  }

  return (
    <StartForm
      title={TITLE}
      subtitle={SUBTITLE}
      email={email}
      onEmailChange={(v) => {
        setEmail(v);
        setEmailHint(null);
      }}
      onSubmit={() => void onEmail()}
      onProvider={(p) => void onProvider(p)}
      providers={providers}
      pending={pending === "github" || pending === "google" || pending === "email" ? pending : null}
      disabled={!isLoaded}
      emailError={emailHint ?? identifierError}
      formError={formError}
      footer={footer}
    />
  );
}
