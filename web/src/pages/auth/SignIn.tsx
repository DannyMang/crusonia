// Sign in (Paper artboard 2LWH-0). Clerk Core 3 custom flow (signal API): GitHub / Google via signIn.sso(),
// or email: signIn.create({ identifier }) -> emailCode.sendCode() -> emailCode.verifyCode({ code }) ->
// finalize() to `redirect_url` (same-origin paths only) or /app. Without a publishable key the same layout
// renders disabled, so Clerk hooks never run outside <ClerkProvider>.
import { useAuth, useSignIn } from "@clerk/react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { clerkEnabled } from "../../auth.tsx";
import { CodeForm, StartForm, SwitchLine, type Provider } from "../../components/auth/AuthLayout.tsx";
import { clerkMessage, goTo, isEmail, rememberAfterAuth, safeNext } from "../../components/auth/flow.ts";

const TITLE = "Welcome back";
const SUBTITLE = "Sign in to your Crusonia workspace";
const TWO_FACTOR = "This account has two-step verification turned on, which this screen does not support yet. Continue with GitHub or Google instead.";

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

  const identifierError = clerkMessage(errors.fields.identifier);
  const codeError = clerkMessage(errors.fields.code);
  const globalError = clerkMessage(errors.global?.[0]);
  // A returned error that Clerk did not attach to a field (network, runtime) still needs saying.
  const formError = globalError ?? (identifierError || codeError ? null : message);

  async function onProvider(p: Provider) {
    setPending(p);
    setMessage(null);
    rememberAfterAuth(next);
    const { error } = await signIn.sso({ strategy: p === "github" ? "oauth_github" : "oauth_google", redirectUrl: next, redirectCallbackUrl: "/sso-callback" });
    // On success the browser is already leaving for GitHub / Google.
    if (error) {
      setMessage(clerkMessage(error) ?? "Could not reach the sign-in provider. Try again.");
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
      pending={pending === "github" || pending === "google" || pending === "email" ? pending : null}
      disabled={!isLoaded}
      emailError={emailHint ?? identifierError}
      formError={formError}
      footer={footer}
    />
  );
}
