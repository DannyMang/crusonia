// "yourcompany.com  [Find my first leads]": the website pill in the hero and the closing section. Submitting
// goes to /sign-up?website=<domain>, which onboarding picks up; empty, it is just /sign-up. Anything that is
// not a website (an email, "hello world") stays in the field with an inline error instead of being trimmed
// into some other domain. One pill from `sm` up; on phones the field and the button stack so the placeholder
// is never cut off.
import { useId, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { cx } from "../lib/format.ts";
import { signUpTarget } from "../lib/website.ts";

export function WebsiteForm({ variant }: { variant: "hero" | "closing" }) {
  const navigate = useNavigate();
  const [website, setWebsite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const errorId = `${id}-error`;
  const hero = variant === "hero";

  function submit(e: FormEvent) {
    e.preventDefault();
    const target = signUpTarget(website);
    if ("error" in target) setError(target.error);
    else navigate(target.href);
  }

  return (
    // The wrapper has the pill's width, so an error wraps under the field instead of widening the hero column.
    <div className={cx("flex w-full flex-col gap-2", hero ? "sm:w-115" : "sm:w-130")}>
      <form
        onSubmit={submit}
        noValidate
        className={cx(
          "flex w-full flex-col gap-2.5",
          "sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:rounded-full sm:border sm:bg-white sm:pl-5.5",
          error ? "sm:border-[#B42318]" : "sm:border-[#200D0D26] sm:has-[input:focus-visible]:border-[#200D0D66]",
          // The pill is the field from `sm` up, so it carries the 2px focus ring (same as :focus-visible in index.css).
          "sm:transition-colors sm:has-[input:focus-visible]:outline-2 sm:has-[input:focus-visible]:outline-offset-2 sm:has-[input:focus-visible]:outline-green",
          hero ? "sm:h-14.5 sm:pr-1.25" : "sm:h-15 sm:pr-1.5",
          "sm:shadow-[0_10px_24px_#200D0D0F]",
        )}
      >
        <label htmlFor={id} className="sr-only">
          Your company's website
        </label>
        <input
          id={id}
          name="website"
          type="text"
          inputMode="url"
          autoComplete="url"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="yourcompany.com"
          value={website}
          onChange={(e) => {
            setWebsite(e.target.value);
            setError(null);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={cx(
            // Phones: the input is its own pill and takes the global 2px focus ring; from `sm` the form draws it.
            "h-14 min-w-0 rounded-full border bg-white px-5.5 text-[15px]/4.5 font-medium text-ink placeholder:text-[#200D0D80] sm:outline-none",
            error ? "border-[#B42318]" : "border-[#200D0D26] focus-visible:border-[#200D0D66]",
            "shadow-[0_10px_24px_#200D0D0F]",
            "sm:h-auto sm:grow sm:rounded-none sm:border-0 sm:bg-transparent sm:px-0 sm:shadow-none",
          )}
        />
        <button
          type="submit"
          className={cx(
            "flex h-12 shrink-0 items-center justify-center rounded-full bg-lime px-6 text-base/5 font-semibold text-ink transition-colors hover:bg-[#B3DE7C]",
            hero && "shadow-[0_12px_28px_#16A34A3D]",
          )}
        >
          Find my first leads
        </button>
      </form>
      {error ? (
        <p id={errorId} role="alert" className={cx("text-sm/5 font-medium text-[#B42318]", hero ? "px-5.5" : "px-5.5 text-center")}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
