// Sign up (Paper artboard 2LXP-0). Clerk Core 3 custom flow (signal API): GitHub / Google via signUp.sso()
// landing on /onboarding/1, or email: signUp.create({ emailAddress }) -> verifications.sendEmailCode() ->
// verifyEmailCode({ code }) -> finalize(). If Clerk still needs a first/last name it asks for them here.
// `#clerk-captcha` is where Clerk mounts its bot protection. The design's terms line is left out: there are
// no Terms or Privacy pages to link to yet.
import { useAuth, useClerk, useSignUp } from "@clerk/react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { clerkEnabled } from "../../auth.tsx";
import { ALL_PROVIDERS, AuthBrand, AuthField, AuthHeading, AuthLoadFailed, AuthShell, CodeForm, FormError, PrimaryButton, StartForm, SwitchLine, useLoadTimedOut, type Provider } from "../../components/auth/AuthLayout.tsx";
import { clerkMessage, enabledProviders, goTo, isEmail, providerOffMessage, rememberAfterAuth, rememberWebsite } from "../../components/auth/flow.ts";

const TITLE = "Welcome to Crusonia!";
const SUBTITLE = "Your first 25 leads, from just your website";
const AFTER_SIGN_UP = "/onboarding/1";

const footer = <SwitchLine className="pt-5" text="Already have an account?" to="/sign-in" label="Sign in" />;

export default function SignUp() {
  // From the landing page: keep the visitor's website for onboarding step 1 (survives the OAuth round trip).
  const [params] = useSearchParams();
  const website = params.get("website");
  useEffect(() => rememberWebsite(website), [website]);
  return clerkEnabled ? <ClerkSignUp /> : <StaticSignUp />;
}

function StaticSignUp() {
  return <StartForm title={TITLE} subtitle={SUBTITLE} email="" disabled note="Sign-up is not configured in this build." footer={footer} />;
}

type Pending = Provider | "email" | "verify" | "resend" | "details" | null;
/** What the "One more thing" step can collect. Anything else Clerk asks for is reported, not attempted. */
const DETAIL_FIELDS = new Set(["first_name", "last_name", "password"]);
const canCollect = (missing: readonly string[]) => missing.length > 0 && missing.every((f) => DETAIL_FIELDS.has(f));

function ClerkSignUp() {
  const { signUp, errors } = useSignUp();
  const { isLoaded } = useAuth();
  const clerk = useClerk();
  const navigate = useNavigate();
  const providers = enabledProviders(clerk, ALL_PROVIDERS, isLoaded);
  const loadFailed = useLoadTimedOut(isLoaded);

  const [step, setStep] = useState<"start" | "code" | "details">("start");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPassword] = useState("");
  const [queued, setQueued] = useState<Provider | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [emailHint, setEmailHint] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // A sign-up already in this browser: continue it when it only needs what the details step collects (e.g.
  // back from GitHub/Google), otherwise discard it. Clerk's sso() and create() reuse an existing sign-up (a
  // PATCH), so a stale one would make the next attempt fail.
  const status = signUp?.status;
  const id = signUp?.id;
  const unverified = signUp?.unverifiedFields?.length ?? 0;
  const missingKey = (signUp?.missingFields ?? []).join(",");
  useEffect(() => {
    if (!id || pending || step !== "start" || status === "complete") return;
    if (status === "missing_requirements" && unverified === 0 && canCollect(missingKey.split(",").filter(Boolean))) {
      setMessage(null);
      setStep("details");
      return;
    }
    void signUp.reset();
  }, [id, status, unverified, missingKey, pending, step, signUp]);

  // A provider clicked while a stale sign-up was still being discarded starts once the reset has landed.
  useEffect(() => {
    if (!queued || id) return;
    setQueued(null);
    void startSso(queued);
    // startSso reads the current render's signUp, which is the fresh one once `id` is gone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued, id]);

  // Only errors from the action just taken are shown (Clerk keeps the last error on the resource, which would
  // otherwise follow the visitor from one step to the next).
  const emailError = step === "start" ? clerkMessage(errors.fields.emailAddress) : null;
  const codeError = step === "code" ? clerkMessage(errors.fields.code) : null;
  const nameError = step === "details" ? (clerkMessage(errors.fields.firstName) ?? clerkMessage(errors.fields.lastName) ?? clerkMessage(errors.fields.password)) : null;
  const formError = emailError || codeError || nameError ? null : message;

  /** After verification: finish, or ask for what Clerk still needs. */
  async function complete() {
    if (signUp.status === "complete") {
      const done = await signUp.finalize({ navigate: goTo(navigate, AFTER_SIGN_UP) });
      if (done.error) {
        setMessage(clerkMessage(done.error));
        setPending(null);
      }
      return;
    }
    setPending(null);
    const missing = signUp.missingFields ?? [];
    if (canCollect(missing)) {
      setMessage(null);
      setStep("details");
      return;
    }
    setMessage(
      missing.length
        ? `Creating your account also needs: ${missing.map((f) => f.replace(/_/g, " ")).join(", ")}, which this screen does not support yet.`
        : "Creating your account needs another step that this screen does not support yet.",
    );
  }

  async function startSso(p: Provider) {
    setPending(p);
    setMessage(null);
    rememberAfterAuth(AFTER_SIGN_UP);
    const { error } = await signUp.sso({ strategy: p === "github" ? "oauth_github" : "oauth_google", redirectUrl: AFTER_SIGN_UP, redirectCallbackUrl: "/sso-callback" });
    if (error) {
      setMessage(providerOffMessage(error, p) ?? clerkMessage(error) ?? "Could not reach the sign-in provider. Try again.");
      setPending(null);
    }
  }

  async function onProvider(p: Provider) {
    if (signUp.id) {
      // Start a new sign-up rather than PATCH the old one with an OAuth strategy (Clerk rejects that).
      setPending(p);
      setMessage(null);
      await signUp.reset();
      setQueued(p);
      return;
    }
    await startSso(p);
  }

  async function onEmail() {
    if (!isEmail(email)) {
      setEmailHint("Enter your work email, like you@company.com");
      return;
    }
    setPending("email");
    setMessage(null);
    setNote(null);
    const created = await signUp.create({ emailAddress: email.trim() });
    if (created.error) {
      setMessage(clerkMessage(created.error));
      setPending(null);
      return;
    }
    const sent = await signUp.verifications.sendEmailCode();
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
    const verified = await signUp.verifications.verifyEmailCode({ code });
    if (verified.error) {
      setMessage(clerkMessage(verified.error));
      setPending(null);
      return;
    }
    await complete();
  }

  async function onResend() {
    setPending("resend");
    setMessage(null);
    const { error } = await signUp.verifications.sendEmailCode();
    setPending(null);
    if (error) setMessage(clerkMessage(error));
    else setNote(`We sent a new code to ${email.trim()}.`);
  }

  async function onBack() {
    await signUp.reset();
    setStep("start");
    setCode("");
    setMessage(null);
    setNote(null);
  }

  async function onDetails() {
    setPending("details");
    setMessage(null);
    const missing = new Set(signUp.missingFields ?? []);
    if (missing.has("first_name") || missing.has("last_name")) {
      const updated = await signUp.update({ firstName: firstName.trim() || undefined, lastName: lastName.trim() || undefined });
      if (updated.error) {
        setMessage(clerkMessage(updated.error));
        setPending(null);
        return;
      }
    }
    if (missing.has("password")) {
      const set = await signUp.password({ password });
      if (set.error) {
        setMessage(clerkMessage(set.error));
        setPending(null);
        return;
      }
    }
    await complete();
  }

  if (loadFailed) return <AuthLoadFailed title={TITLE} subtitle={SUBTITLE} footer={footer} />;

  if (step === "details") {
    const missing = new Set(signUp.missingFields ?? []);
    const needsName = missing.has("first_name") || missing.has("last_name");
    const needsPassword = missing.has("password");
    return (
      <AuthShell>
        <AuthBrand />
        <AuthHeading title="One more thing" subtitle={needsName && !needsPassword ? "What should we call you?" : needsPassword && !needsName ? "Choose a password for your account." : "Your name and a password."} />
        <form
          className="flex flex-col gap-3 pt-7.25"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void onDetails();
          }}
        >
          {missing.has("first_name") ? (
            <AuthField id="auth-first" label="First name" placeholder="First name" autoComplete="given-name" autoFocus value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          ) : null}
          {missing.has("last_name") ? (
            <AuthField id="auth-last" label="Last name" placeholder="Last name" autoComplete="family-name" value={lastName} onChange={(e) => setLastName(e.target.value)} />
          ) : null}
          {needsPassword ? (
            <AuthField
              id="auth-password"
              label="Password"
              type="password"
              placeholder="Password (8+ characters)"
              autoComplete="new-password"
              autoFocus={!needsName}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          ) : null}
          {nameError ? <FormError>{nameError}</FormError> : null}
          <PrimaryButton
            loading={pending === "details"}
            disabled={(missing.has("first_name") && !firstName.trim()) || (missing.has("last_name") && !lastName.trim()) || (needsPassword && password.length < 8)}
          >
            Continue
          </PrimaryButton>
          {formError ? <FormError>{formError}</FormError> : null}
        </form>
        <div id="clerk-captcha" />
      </AuthShell>
    );
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
      >
        <div id="clerk-captcha" />
      </CodeForm>
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
      emailError={emailHint ?? emailError}
      formError={formError}
      afterButton={<div id="clerk-captcha" />}
      footer={footer}
    />
  );
}
