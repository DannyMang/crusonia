// The frame of /terms and /privacy: the name, the title, a date, and plain text. Both are drafts for the owner to review,
// so they say so. No footer. The three strings below are placeholders the owner fills in; they are deliberately not links.
import { useEffect, type ReactNode } from "react";
import { Link } from "react-router";
import { Logo } from "../../components/icons.tsx";

export const LEGAL_UPDATED = "November 8, 2026";
export const LEGAL_CONTACT = "[contact email]";
export const LEGAL_ENTITY = "[company name]";
export const LEGAL_JURISDICTION = "[jurisdiction]";

const link = "text-ink underline decoration-[#200D0D4D] underline-offset-[3px] hover:decoration-ink";

export const TextLink = ({ to, children }: { to: string; children: ReactNode }) => (
  <Link to={to} className={link}>
    {children}
  </Link>
);

export const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="flex flex-col gap-2">
    <h2 className="text-[15px]/5.5 font-semibold text-ink">{title}</h2>
    <div className="flex flex-col gap-2 text-[15px]/6 font-[450] text-muted">{children}</div>
  </section>
);

export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} · Crusonia`;
    return () => {
      document.title = previous;
    };
  }, [title]);
  return (
    <div className="min-h-screen bg-white px-6 pb-20 pt-10 text-ink [font-synthesis:none] sm:pt-14">
      <div className="mx-auto flex w-full max-w-160 flex-col gap-8">
        <Link to="/" aria-label="Crusonia home" className="flex items-center gap-2 self-start">
          <Logo size={28} />
          <span className="text-lg/6 font-semibold tracking-[-0.03em]">crusonia</span>
        </Link>
        <header className="flex flex-col gap-1.5">
          <h1 className="text-[32px]/9.25 font-bold tracking-[-0.04em]">{title}</h1>
          <p className="text-[13px]/5 font-medium text-faint">Draft, last updated {LEGAL_UPDATED}</p>
        </header>
        {children}
      </div>
    </div>
  );
}
