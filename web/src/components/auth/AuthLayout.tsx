// Presentational pieces for the "Sign in" / "Sign up" artboards: the 720px form column with the help band,
// and the 720px gradient image (hidden below 1024px). No Clerk hooks in here, so the static (no publishable
// key) variant and the Clerk custom flows share exactly the same markup.
import type { FormEvent, InputHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router";
import { cx } from "../../lib/format.ts";
import { Logo } from "../icons.tsx";

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

export function ProviderButtons({
  onProvider,
  pending,
  disabled,
  providers = ALL_PROVIDERS,
}: {
  onProvider?: (p: Provider) => void;
  pending?: string | null;
  disabled?: boolean;
  providers?: Provider[];
}) {
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
          code ? "font-medium tracking-[0.3em] tabular-nums" : "font-[450]",
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
  /** Social providers turned on in the Clerk instance (default: both, as designed). */
  providers?: Provider[];
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

export function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden className="shrink-0">
      <path
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.7 7.7 0 0 1 8 4.07c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
        fill="#200D0D"
      />
    </svg>
  );
}

export function GoogleIcon() {
  return (
    <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden className="shrink-0">
      <path d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" fill="#4285F4" />
      <path d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.71H.96v2.33A8.997 8.997 0 0 0 9 18Z" fill="#34A853" />
      <path d="M3.97 10.71A5.41 5.41 0 0 1 3.69 9c0-.59.1-1.17.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.04l3.01-2.33Z" fill="#FBBC05" />
      <path d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A8.997 8.997 0 0 0 .96 4.96l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" fill="#EA4335" />
    </svg>
  );
}
