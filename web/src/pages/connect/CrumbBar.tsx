// Pieces shared by the setup screens (Integrations, Connect your agent): the "<workspace> › <page>" bar and the
// mono snippet well with a Copy button.
import { Link } from "react-router";
import { CopyButton } from "../../components/ui.tsx";
import { cx } from "../../lib/format.ts";
import { useProfile } from "../../queries.ts";

/** Full width so its hairline runs edge to edge; the text sits in the same 1200px column as <Page>. */
export function CrumbBar({ here }: { here: string }) {
  const profile = useProfile();
  // Same source as the sidebar's workspace switcher, so both always agree.
  const workspace = profile.data?.company?.trim() || "Workspace";
  return (
    <div className="shrink-0 border-b border-b-[#200D0D1A]">
      <nav aria-label="Breadcrumb" className="mx-auto flex h-12.5 w-full max-w-[1200px] items-center gap-2 px-12 text-sm/4.5">
        <Link to="/app" className="text-faint hover:text-ink">
          {workspace}
        </Link>
        <span aria-hidden className="font-medium text-[#200D0D66]">
          ›
        </span>
        <span aria-current="page" className="font-medium text-ink">
          {here}
        </span>
      </nav>
    </div>
  );
}

/** Command or config on the soft gray well (Inter, by owner rule: no monospace). `copy` is what lands on the clipboard when it differs from what is shown. */
export function CodeWell({ display, copy, className }: { display: string; copy?: string; className?: string }) {
  return (
    <div className={cx("flex items-start gap-3 rounded-[10px] bg-[#200D0D0A] py-3 pl-4 pr-2.5", className)}>
      <pre className="min-w-0 grow basis-0 whitespace-pre-wrap text-[13px]/5 text-ink [overflow-wrap:anywhere]">{display}</pre>
      <CopyChip text={copy ?? display} />
    </div>
  );
}

/** The design's small white "Copy" chip (h-6, hairline border). */
export function CopyChip({ text, label = "Copy" }: { text: string; label?: string }) {
  return <CopyButton text={text} label={label} className="h-6" />;
}
