// "yourcompany.com  [Find my first leads]": the website pill in the hero and the closing section. Submitting
// goes to /sign-up?website=<domain>, which onboarding picks up; empty, it is just /sign-up. One pill from
// `sm` up; on phones the field and the button stack so the placeholder is never cut off.
import { useId, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { cx } from "../lib/format.ts";

/** "https://www.Acme.com/about?x" -> "acme.com". */
export function toDomain(raw: string): string {
  const v = raw
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^www\./i, "");
  return (v.split(/[/?#\s]/)[0] ?? "").toLowerCase();
}

export function signUpHref(website: string): string {
  const domain = toDomain(website);
  return domain ? `/sign-up?website=${encodeURIComponent(domain)}` : "/sign-up";
}

export function WebsiteForm({ variant }: { variant: "hero" | "closing" }) {
  const navigate = useNavigate();
  const [website, setWebsite] = useState("");
  const id = useId();
  const hero = variant === "hero";

  function submit(e: FormEvent) {
    e.preventDefault();
    navigate(signUpHref(website));
  }

  return (
    <form
      onSubmit={submit}
      className={cx(
        "flex w-full flex-col gap-2.5",
        "sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:rounded-full sm:border sm:border-[#200D0D26] sm:bg-white sm:pl-5.5",
        "sm:transition-colors sm:has-[input:focus-visible]:border-[#200D0D66]",
        hero ? "sm:h-14.5 sm:w-115 sm:pr-1.25" : "sm:h-15 sm:w-130 sm:pr-1.5",
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
        onChange={(e) => setWebsite(e.target.value)}
        className={cx(
          "h-14 min-w-0 rounded-full border border-[#200D0D26] bg-white px-5.5 text-[15px]/4.5 font-medium text-ink outline-none placeholder:text-[#200D0D80] focus-visible:border-[#200D0D66]",
          "shadow-[0_10px_24px_#200D0D0F]",
          "sm:h-auto sm:grow sm:rounded-none sm:border-0 sm:bg-transparent sm:px-0 sm:shadow-none",
        )}
      />
      <button
        type="submit"
        className={cx(
          "flex h-12 shrink-0 items-center justify-center rounded-full bg-lime px-6 text-base/5 font-semibold tracking-[0.32px] text-ink transition-colors hover:bg-[#B3DE7C]",
          hero && "shadow-[0_12px_28px_#16A34A3D]",
        )}
      >
        Find my first leads
      </button>
    </form>
  );
}
