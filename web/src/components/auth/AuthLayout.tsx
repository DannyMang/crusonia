// Presentational pieces for the "Sign in" / "Sign up" artboards: the 720px form column with the help band,
// and the 720px gradient image (hidden below 1024px). No Clerk hooks in here, so the static (no publishable
// key) variant and the Clerk custom flows share exactly the same markup.
import { useEffect, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { Link } from "react-router";
import { cx } from "../../lib/format.ts";
import { Logo } from "../icons.tsx";
import { BrandLogo } from "../BrandLogo.tsx";

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-white text-xs/4 text-ink">
      <div className="flex min-h-screen w-full shrink-0 flex-col bg-white lg:w-1/2">
        {/* The design's bottom 101px help band is left out: there is no support page to link to yet. Its
            height stays as bottom padding so the form sits where the artboard has it. */}
        <div className="flex grow flex-col justify-center px-6 pb-[125px] pt-6">
          <div className="mx-auto flex w-full max-w-90 flex-col">{children}</div>
        </div>
      </div>
      <div aria-hidden className="hidden min-h-screen w-1/2 shrink-0 bg-[#D7F8A8] bg-[url(/auth-gradient.webp)] bg-cover bg-center lg:block" />
    </div>
  );
}

export function AuthBrand() {
  return (
    <div className="flex items-center gap-2 self-start">
      <Logo size={32} />
      <span className="text-[22px]/5.5 font-semibold tracking-[-0.03em] text-ink">crusonia</span>
    </div>
  );
}

export function AuthHeading({ title, subtitle }: { title: ReactNode; subtitle: ReactNode }) {
  return (
    <>
      <h1 className="pt-7 text-[32px]/9.25 font-bold tracking-[-0.04em] text-ink">{title}</h1>
      <p className="pt-2 text-[15px]/4.5 font-[450] text-faint">{subtitle}</p>
    </>
  );
}

export type Provider = "github" | "google";

export const ALL_PROVIDERS: Provider[] = ["github", "google"];
const PROVIDER_LABEL: Record<Provider, string> = { github: "Continue with GitHub", google: "Continue with Google" };

/** `providers: null` means Clerk has not said which ones are on yet: a neutral placeholder, never a guess. */
export function ProviderButtons({
  onProvider,
  pending,
  disabled,
  providers = ALL_PROVIDERS,
}: {
  onProvider?: (p: Provider) => void;
  pending?: string | null;
  disabled?: boolean;
  providers?: Provider[] | null;
}) {
  if (providers === null) return <ProviderSkeleton />;
  if (!providers.length) return null;
  return (
    <div className="flex flex-col gap-3 pt-7.25">
      {providers.map((p) => (
        <ProviderButton key={p} provider={p} label={PROVIDER_LABEL[p]} onClick={onProvider} loading={pending === p} disabled={disabled || Boolean(pending)} />
      ))}
    </div>
  );
}

function ProviderButton({ provider, label, onClick, loading, disabled }: { provider: Provider; label: string; onClick?: (p: Provider) => void; loading?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => onClick?.(provider)}
      disabled={disabled}
      aria-busy={loading || undefined}
      className="flex h-12 shrink-0 items-center justify-center gap-2.5 rounded-[10px] border border-[#200D0D24] bg-white text-[15px]/4.5 font-semibold text-ink transition-colors hover:bg-[#200D0D06] disabled:cursor-default disabled:opacity-60 disabled:hover:bg-white"
    >
      {loading ? <Spin /> : provider === "github" ? <GitHubIcon /> : <GoogleIcon />}
      {label}
    </button>
  );
}

function ProviderSkeleton() {
  return (
    <div className="flex flex-col gap-3 pt-7.25" role="status" aria-label="Loading sign-in options">
      {ALL_PROVIDERS.map((p) => (
        <div key={p} aria-hidden className="h-12 rounded-[10px] bg-[#200D0D0A] [animation:crusonia-pulse_1.6s_ease-in-out_infinite]" />
      ))}
    </div>
  );
}

/** True when Clerk is still not loaded after `ms` (its script blocked, offline, an outage). */
export function useLoadTimedOut(isLoaded: boolean, ms = 8000): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (isLoaded) return;
    const t = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(t);
  }, [isLoaded, ms]);
  return late && !isLoaded;
}

/** Shown instead of the form when Clerk did not load: a plain error and a way to try again. */
export function AuthLoadFailed({ title, subtitle, footer }: { title: ReactNode; subtitle: ReactNode; footer: ReactNode }) {
  return (
    <AuthShell>
      <AuthBrand />
      <AuthHeading title={title} subtitle={subtitle} />
      <div className="flex flex-col gap-3 pt-7.25">
        <FormError>Sign-in could not load. Check your connection, then try again.</FormError>
        <PrimaryButton type="button" onClick={() => window.location.reload()}>
          Try again
        </PrimaryButton>
      </div>
      {footer}
    </AuthShell>
  );
}

export function OrDivider() {
  return (
    <div className="flex items-center gap-3" role="separator" aria-label="or">
      <span className="h-px grow basis-0 bg-[#200D0D14]" />
      <span className="text-xs/4 font-[525] text-faint">or</span>
      <span className="h-px grow basis-0 bg-[#200D0D14]" />
    </div>
  );
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string | null; code?: boolean };

/** 48px input with an inline error under it (Clerk `errors.fields.*`). The label is for screen readers. */
export function AuthField({ label, error, code, id, className, ...rest }: FieldProps) {
  const errId = error && id ? `${id}-error` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={errId}
        className={cx(
          "h-12 w-full shrink-0 rounded-[10px] border bg-white px-4 text-[15px]/4.5 text-ink outline-none transition-[border-color,box-shadow] placeholder:font-[450] placeholder:text-[#200D0D73] focus-visible:outline-none disabled:opacity-60",
          code ? "font-medium tabular-nums" : "font-[450]",
          error ? "border-[#B42318] focus:[box-shadow:#B4231826_0px_0px_0px_3px]" : "border-[#200D0D24] focus:border-ink focus:[box-shadow:#BDE68966_0px_0px_0px_3px]",
          className,
        )}
        {...rest}
      />
      {error ? <FieldError id={errId}>{error}</FieldError> : null}
    </div>
  );
}

export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <div id={id} role="alert" className="text-[13px]/4.5 font-[525] text-[#B42318]">
      {children}
    </div>
  );
}

/** Errors that are not about one field (Clerk `errors.global`, network, unsupported second factor). */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-[10px] border border-[#B4231829] bg-[#FDECEB80] px-3.5 py-3 text-[13px]/4.5 font-[525] text-ink">
      <span className="mt-1.75 size-1.5 shrink-0 rounded-full bg-[#B42318]" />
      <div>{children}</div>
    </div>
  );
}

/** Calm note (e.g. "Sign-in is not configured in this build", "We sent a new code"). */
export function FormNote({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="flex items-start gap-2.5 rounded-[10px] border border-panel-line bg-panel px-3.5 py-3 text-[13px]/4.5 font-[525] text-muted">
      <span className="mt-1.75 size-1.5 shrink-0 rounded-full bg-green" />
      <div>{children}</div>
    </div>
  );
}

export function PrimaryButton({ children, loading, disabled, type = "submit", onClick }: { children: ReactNode; loading?: boolean; disabled?: boolean; type?: "submit" | "button"; onClick?: () => void }) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className="flex h-12 shrink-0 items-center justify-center gap-2 rounded-[10px] bg-lime text-[15px]/4.5 font-semibold text-ink transition-colors hover:bg-[#b3de7a] disabled:cursor-default disabled:opacity-60 disabled:hover:bg-lime"
    >
      {loading ? <Spin /> : null}
      {children}
    </button>
  );
}

/** "New to Crusonia? Create an account" */
export function SwitchLine({ text, to, label, className }: { text: string; to: string; label: string; className?: string }) {
  return (
    <div className={cx("flex flex-wrap gap-1 text-[13px]/4.5 font-[525]", className)}>
      <span className="text-muted">{text}</span>
      <Link to={to} className="text-ink underline decoration-1 [text-underline-position:from-font] hover:decoration-2">
        {label}
      </Link>
    </div>
  );
}

export function TextButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-[13px]/4.5 font-[525] text-ink underline decoration-1 [text-underline-position:from-font] hover:decoration-2 disabled:cursor-default disabled:opacity-60"
    >
      {children}
    </button>
  );
}

// ---------- the two screens' shared form ----------

export type StartFormProps = {
  title: ReactNode;
  subtitle: ReactNode;
  email: string;
  onEmailChange?: (v: string) => void;
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  onProvider?: (p: Provider) => void;
  /** Social providers turned on in the Clerk instance (default: both, as designed); null while Clerk loads. */
  providers?: Provider[] | null;
  pending?: Provider | "email" | null;
  /** Everything disabled (static build, Clerk still loading). */
  disabled?: boolean;
  emailError?: string | null;
  formError?: ReactNode;
  note?: ReactNode;
  /** Sign up: terms line + Clerk's bot protection mount point. */
  afterButton?: ReactNode;
  footer: ReactNode;
};

export function StartForm(p: StartFormProps) {
  return (
    <AuthShell>
      <AuthBrand />
      <AuthHeading title={p.title} subtitle={p.subtitle} />
      <ProviderButtons onProvider={p.onProvider} providers={p.providers} pending={p.pending === "email" ? "email" : p.pending} disabled={p.disabled || p.pending === "email"} />
      <form
        className={cx("flex flex-col gap-3", p.providers && !p.providers.length ? "pt-7.25" : "pt-5")}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          p.onSubmit?.(e);
        }}
      >
        {p.providers && !p.providers.length ? null : <OrDivider />}
        <AuthField
          id="auth-email"
          label="Work email"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          placeholder="Work email"
          value={p.email}
          onChange={(e) => p.onEmailChange?.(e.target.value)}
          disabled={p.disabled}
          error={p.emailError}
        />
        <PrimaryButton loading={p.pending === "email"} disabled={p.disabled || Boolean(p.pending)}>
          Continue with email
        </PrimaryButton>
        {p.formError ? <FormError>{p.formError}</FormError> : null}
        {p.note ? <FormNote>{p.note}</FormNote> : null}
      </form>
      {p.afterButton}
      {p.footer}
    </AuthShell>
  );
}

export type CodeFormProps = {
  email: string;
  code: string;
  onCodeChange: (v: string) => void;
  onSubmit: () => void;
  onResend: () => void;
  onBack: () => void;
  pending?: "verify" | "resend" | null;
  codeError?: string | null;
  formError?: ReactNode;
  note?: ReactNode;
  children?: ReactNode;
};

/** Second step of the email flow: the 6-digit code Clerk emailed. */
export function CodeForm(p: CodeFormProps) {
  return (
    <AuthShell>
      <AuthBrand />
      <AuthHeading
        title="Check your email"
        subtitle={
          <>
            We sent a 6-digit code to <span className="text-ink">{p.email}</span>
          </>
        }
      />
      <form
        className="flex flex-col gap-3 pt-7.25"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          p.onSubmit();
        }}
      >
        <AuthField
          id="auth-code"
          label="Verification code"
          name="code"
          autoComplete="one-time-code"
          inputMode="numeric"
          placeholder="Enter the code"
          maxLength={6}
          code
          autoFocus
          value={p.code}
          onChange={(e) => p.onCodeChange(e.target.value.replace(/\D/g, ""))}
          error={p.codeError}
        />
        <PrimaryButton loading={p.pending === "verify"} disabled={Boolean(p.pending) || p.code.length < 6}>
          Continue
        </PrimaryButton>
        {p.formError ? <FormError>{p.formError}</FormError> : null}
        {p.note ? <FormNote>{p.note}</FormNote> : null}
      </form>
      {p.children}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-5">
        <TextButton onClick={p.onResend} disabled={Boolean(p.pending)}>
          {p.pending === "resend" ? "Sending…" : "Send a new code"}
        </TextButton>
        <TextButton onClick={p.onBack} disabled={p.pending === "verify"}>
          Use a different email
        </TextButton>
      </div>
    </AuthShell>
  );
}

// ---------- icons ----------

function Spin() {
  return <span aria-hidden className="size-4 shrink-0 rounded-full border-2 border-[#200D0D26] border-t-ink [animation:crusonia-spin_0.8s_linear_infinite]" />;
}

/** GitHub's and Google's own marks, unmodified (web/src/assets/logos/LOGOS.md). */
export function GitHubIcon() {
  return <BrandLogo name="github" size={18} />;
}

export function GoogleIcon() {
  return <BrandLogo name="google" size={18} />;
}
