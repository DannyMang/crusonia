// Sign up (Paper artboard 2LXP-0). Clerk Core 3 custom flow (signal API): GitHub / Google via signUp.sso()
// landing on /onboarding/1, or email: signUp.create({ emailAddress }) -> verifications.sendEmailCode() ->
// verifyEmailCode({ code }) -> finalize(). If Clerk still needs a first/last name it asks for them here.
// `#clerk-captcha` is where Clerk mounts its bot protection. The design's terms line is left out: there are
// no Terms or Privacy pages to link to yet.
import { useAuth, useSignUp } from "@clerk/react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { clerkEnabled } from "../../auth.tsx";
import { AuthBrand, AuthField, AuthHeading, AuthShell, CodeForm, FormError, PrimaryButton, StartForm, SwitchLine, type Provider } from "../../components/auth/AuthLayout.tsx";
import { clerkMessage, goTo, isEmail, rememberAfterAuth } from "../../components/auth/flow.ts";

const TITLE = "Welcome to Crusonia!";
const SUBTITLE = "Your first 25 leads, from just your website";
const AFTER_SIGN_UP = "/onboarding/1";

const footer = <SwitchLine className="pt-5" text="Already have an account?" to="/sign-in" label="Sign in" />;

export default function SignUp() {
  return clerkEnabled ? <ClerkSignUp /> : <StaticSignUp />;
}

function StaticSignUp() {
  return <StartForm title={TITLE} subtitle={SUBTITLE} email="" disabled note="Sign-up is not configured in this build." footer={footer} />;
}

type Pending = Provider | "email" | "verify" | "resend" | "details" | null;
const NAME_FIELDS = new Set(["first_name", "last_name"]);

function ClerkSignUp() {
  const { signUp, errors } = useSignUp();
  const { isLoaded } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState<"start" | "code" | "details">("start");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const [emailHint, setEmailHint] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Back from /sso-callback with a verified account that still needs a name: ask for it here.
  const status = signUp?.status;
  const unverified = signUp?.unverifiedFields?.length ?? 0;
  useEffect(() => {
    if (status === "missing_requirements" && signUp?.id && unverified === 0) setStep("details");
  }, [status, unverified, signUp?.id]);

  const emailError = clerkMessage(errors.fields.emailAddress);
  const codeError = clerkMessage(errors.fields.code);
  const nameError = clerkMessage(errors.fields.firstName) ?? clerkMessage(errors.fields.lastName);
  const globalError = clerkMessage(errors.global?.[0]) ?? clerkMessage(errors.fields.captcha) ?? clerkMessage(errors.fields.legalAccepted);
  const formError = globalError ?? (emailError || codeError || nameError ? null : message);

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
    if (missing.length && missing.every((f) => NAME_FIELDS.has(f))) {
      setStep("details");
      return;
    }
    setMessage(
      missing.length
        ? `Creating your account also needs: ${missing.map((f) => f.replace(/_/g, " ")).join(", ")}, which this screen does not support yet. Continue with GitHub or Google instead.`
        : "Creating your account needs another step that this screen does not support yet. Continue with GitHub or Google instead.",
    );
  }

  async function onProvider(p: Provider) {
    setPending(p);
    setMessage(null);
    rememberAfterAuth(AFTER_SIGN_UP);
    const { error } = await signUp.sso({ strategy: p === "github" ? "oauth_github" : "oauth_google", redirectUrl: AFTER_SIGN_UP, redirectCallbackUrl: "/sso-callback" });
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
    const updated = await signUp.update({ firstName: firstName.trim() || undefined, lastName: lastName.trim() || undefined });
    if (updated.error) {
      setMessage(clerkMessage(updated.error));
      setPending(null);
      return;
    }
    await complete();
  }

  if (step === "details") {
    const missing = new Set(signUp.missingFields ?? []);
    return (
      <AuthShell>
        <AuthBrand />
        <AuthHeading title="One more thing" subtitle="What should we call you?" />
        <form
          className="flex flex-col gap-3 pt-7.25"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void onDetails();
          }}
        >
          {missing.has("first_name") || !missing.size ? (
            <AuthField id="auth-first" label="First name" placeholder="First name" autoComplete="given-name" autoFocus value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          ) : null}
          {missing.has("last_name") ? (
            <AuthField id="auth-last" label="Last name" placeholder="Last name" autoComplete="family-name" value={lastName} onChange={(e) => setLastName(e.target.value)} />
          ) : null}
          {nameError ? <FormError>{nameError}</FormError> : null}
          <PrimaryButton loading={pending === "details"} disabled={(missing.has("first_name") && !firstName.trim()) || (missing.has("last_name") && !lastName.trim())}>
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
      pending={pending === "github" || pending === "google" || pending === "email" ? pending : null}
      disabled={!isLoaded}
      emailError={emailHint ?? emailError}
      formError={formError}
      afterButton={<div id="clerk-captcha" />}
      footer={footer}
    />
  );
}
