// Small pieces shared by the onboarding steps (values from the Paper "Onboarding · 1-4" artboards).
import type { ReactNode } from "react";
import { cx } from "../../lib/format.ts";
import { sourceLabel } from "./store.ts";

/** "STEP 2 OF 4", the 32px title and the gray subtitle. */
export function StepTitle({ step, title, subtitle, icon }: { step: number; title: ReactNode; subtitle: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col">
      <div className="pb-3.5 text-xs/4 font-medium uppercase tracking-[0.08em] text-[#200D0D8C]">Step {step} of 4</div>
      <div className="flex items-center gap-3.5">
        {icon}
        <h1 className="text-[32px]/9.25 font-bold tracking-[-0.04em] text-ink">{title}</h1>
      </div>
      <div className="pt-2 text-[15px]/5.5 font-[450] text-[#200D0D8C]">{subtitle}</div>
    </div>
  );
}

/** The design's ring spinner: ink arc on a 15% ink track. */
export function Ring({ size = 14, width = 2, className }: { size?: number; width?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cx("inline-block shrink-0 rounded-full border-[#200D0D26] border-t-ink [animation:crusonia-spin_0.8s_linear_infinite]", className)}
      style={{ width: size, height: size, borderWidth: width }}
    />
  );
}

/** Green filled circle with a white check (done pages, done steps). */
export function DoneDot({ size = 18, check = 10 }: { size?: number; check?: number }) {
  return (
    <span className="flex shrink-0 items-center justify-center rounded-full bg-green" style={{ width: size, height: size }}>
      <WhiteCheck size={check} />
    </span>
  );
}

export function WhiteCheck({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden className="shrink-0">
      <path d="M2.5 6.25l2.25 2.25L9.5 3.75" fill="none" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ArrowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0">
      <path d="M3.5 8h9M8.5 4l4 4-4 4" fill="none" stroke="#200D0D" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PencilIcon({ size = 13, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className={cx("shrink-0", className)}>
      <path d="M10.5 2.5l3 3L6 13H3v-3l7.5-7.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export function LinkGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden className="shrink-0">
      <path d="M6.5 9.5l3-3M7 4.5l1-1a2.83 2.83 0 014 4l-1 1M9 11.5l-1 1a2.83 2.83 0 01-4-4l1-1" fill="none" stroke="#200D0D80" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** A source page as small gray text, linked to the page itself. */
function SourceLink({ url, site }: { url: string; site?: string }) {
  const label = sourceLabel(url, site);
  const safe = /^https?:\/\//i.test(url);
  return safe ? (
    <a href={url} target="_blank" rel="noopener noreferrer" title={url} className="text-xs/4 font-medium text-[#200D0D80] hover:text-ink hover:underline">
      {label}
    </a>
  ) : (
    <span className="text-xs/4 font-medium text-[#200D0D80]">{label}</span>
  );
}

/** "From fieldnote.io/ and /customers" next to a profile field. Renders nothing without sources. */
export function FromSources({ urls, site, className }: { urls: string[]; site?: string; className?: string }) {
  const unique = [...new Set(urls)];
  if (!unique.length) return null;
  const shown = unique.slice(0, 2);
  return (
    <div className={cx("flex min-w-0 shrink-0 items-center gap-1.5", className)}>
      <LinkGlyph />
      <span className="text-xs/4 font-medium text-[#200D0D80]">From</span>
      {shown.map((u, i) => (
        <span key={u} className="flex items-center gap-1.5">
          {i > 0 ? <span className="text-xs/4 font-medium text-[#200D0D80]">and</span> : null}
          <SourceLink url={u} site={site} />
        </span>
      ))}
      {unique.length > shown.length ? <span className="text-xs/4 font-medium text-[#200D0D80]">+{unique.length - shown.length}</span> : null}
    </div>
  );
}

/** "fieldnote.io/ · /pricing" under a found value (step 2). */
export function SourceList({ urls, site }: { urls: string[]; site?: string }) {
  const unique = [...new Set(urls)];
  if (!unique.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 text-xs/4 font-medium text-[#200D0D80]">
      {unique.map((u, i) => (
        <span key={u} className="flex items-center gap-1.5">
          {i > 0 ? <span aria-hidden>·</span> : null}
          <SourceLink url={u} site={site} />
        </span>
      ))}
    </div>
  );
}

/** The large lime button from the designs (Continue, Find my first 25 leads, Go to dashboard). */
export const bigButton =
  "inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-[10px] bg-lime px-5.5 text-[15px]/4.5 font-semibold text-ink transition-colors hover:bg-[#b3de7a] disabled:cursor-default disabled:opacity-60";
