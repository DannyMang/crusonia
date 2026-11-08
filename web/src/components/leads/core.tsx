// Pieces shared by the core lead screens (Paper: "Final · Finding leads", "Final · Research · Review queue",
// "Final · Research · Lead detail"): the fit chip, agent text with numbered citations, the numbered sources,
// Links & contacts, and notes with an "Add a note…" field that saves on Enter.
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode, type Ref } from "react";
import type { Evidence, Lead, LeadContact, LeadLink, LeadNote } from "../../api.ts";
import { useApi } from "../../auth.tsx";
import { citedParts, hostOf, sourceLabel } from "../../lib/citations.ts";
import { cx, shortDate } from "../../lib/format.ts";
import { useInvalidateLead } from "../../queries.ts";
import { GitHubIcon, GlobeIcon, LinkedInIcon, XBrandIcon } from "../core-icons.tsx";
import { AuthorAvatar, useDescribeAuthor } from "../people.tsx";
import { QueryError } from "../ui.tsx";

// ---------- fit ----------

export type Fit = { label: string; short: string; tone: "strong" | "possible" | "weak" | "none" };

/** Strong at 80+, possible at 60+, weak below or when the agent said no; none before scoring. */
export function fitOf(lead: Pick<Lead, "score" | "qualified">): Fit {
  if (lead.score === null || lead.score === undefined) return { label: "Not scored", short: "Not scored", tone: "none" };
  if (lead.qualified === false || lead.score < 60) return { label: "Weak fit", short: "Weak", tone: "weak" };
  if (lead.score >= 80) return { label: "Strong fit", short: "Strong", tone: "strong" };
  return { label: "Possible fit", short: "Possible", tone: "possible" };
}

const fitTone: Record<Fit["tone"], string> = {
  strong: "bg-lime text-ink",
  possible: "border border-[#200D0D1A] text-muted",
  weak: "bg-pill text-muted",
  none: "border border-dashed border-[#200D0D33] text-muted",
};

/** "Strong fit" (rows), or "Strong · 87" with `withScore` (lead detail header). */
export function FitChip({ lead, size = "sm", withScore, className }: { lead: Pick<Lead, "score" | "qualified">; size?: "xs" | "sm" | "md"; withScore?: boolean; className?: string }) {
  const fit = fitOf(lead);
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-full font-medium",
        size === "xs" ? "h-5 px-2 text-[11px]/3.5 font-semibold" : size === "md" ? "h-6 px-2.5 text-[13px]/4" : "h-5.5 px-2.25 text-xs/4",
        fitTone[fit.tone],
        className,
      )}
    >
      {withScore && lead.score !== null ? `${fit.short} · ${lead.score}` : fit.label}
    </span>
  );
}

// ---------- citations ----------

const byNumber = (evidence: Evidence[]) => {
  const map = new Map<number, Evidence>();
  evidence.forEach((e, i) => map.set(e.n ?? i + 1, e));
  return map;
};

/**
 * Agent text that cites evidence as [1], [2]. `bracket` (review, lead detail): green "[1]" after the phrase;
 * `sup` (popover): a small underlined number. Each number opens its source. `plain`: markers removed (rows).
 */
export function CitedText({ text, evidence = [], variant = "bracket", className }: { text: string; evidence?: Evidence[]; variant?: "bracket" | "sup" | "plain"; className?: string }) {
  const sources = byNumber(evidence);
  const parts = citedParts(text);
  if (variant === "plain") {
    return (
      <span className={className}>
        {parts
          .map((p) => (p.t === "text" ? p.v : ""))
          .join("")
          .replace(/\s+([.,;:])/g, "$1")
          .replace(/\s{2,}/g, " ")}
      </span>
    );
  }
  return (
    <span className={className}>
      {parts.map((p, i) => {
        if (p.t === "text") return p.v;
        const ev = sources.get(p.n);
        const label = variant === "sup" ? String(p.n) : `[${p.n}]`;
        const cls = variant === "sup" ? "text-[11px] underline decoration-1 underline-offset-2" : "text-green-dark";
        return ev ? (
          <a key={i} href={ev.source_url} target="_blank" rel="noopener noreferrer nofollow" title={sourceLabel(ev.source_url)} className={cx(cls, "hover:text-ink")}>
            {label}
          </a>
        ) : (
          <span key={i} className={cls}>
            {label}
          </span>
        );
      })}
    </span>
  );
}

/** The numbered sources under a summary: "[1] Product page    harborlabs.dev · Nov 7". */
export function SourceRows({ evidence, rowClass = "h-7.5" }: { evidence: Evidence[]; rowClass?: string }) {
  return (
    <ol className="flex flex-col">
      {evidence.map((e, i) => (
        <li key={e.id} className={cx("flex items-center gap-3 border-t border-t-[#200D0D0F]", rowClass)}>
          <span className="w-6 shrink-0 text-xs/4 font-semibold text-green-dark">[{e.n ?? i + 1}]</span>
          <a href={e.source_url} target="_blank" rel="noopener noreferrer nofollow" className="min-w-0 grow basis-0 truncate text-[13px]/4 text-ink hover:underline">
            {e.claim}
          </a>
          <span className="max-w-[45%] shrink-0 truncate text-xs/4 text-muted">
            {sourceLabel(e.source_url)} · {shortDate(e.created_at)}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The popover's compact list: "1 jobs.lever.co/tandemlabs · read Nov 7". */
export function SourceLines({ evidence }: { evidence: Evidence[] }) {
  return (
    <ol className="flex flex-col gap-0.75 pt-0.5">
      {evidence.map((e, i) => (
        <li key={e.id} className="truncate text-xs/4 text-muted">
          <a href={e.source_url} target="_blank" rel="noopener noreferrer nofollow" className="font-semibold text-ink underline decoration-1 underline-offset-2">
            {e.n ?? i + 1}
          </a>{" "}
          <a href={e.source_url} target="_blank" rel="noopener noreferrer nofollow" className="hover:text-ink">
            {sourceLabel(e.source_url)}
          </a>{" "}
          · read {shortDate(e.created_at)}
        </li>
      ))}
    </ol>
  );
}

// ---------- links & contacts ----------

const LINK_ICON: Record<string, (p: { size?: number }) => ReactNode> = {
  linkedin: (p) => <LinkedInIcon {...p} />,
  github: (p) => <GitHubIcon {...p} />,
  x: (p) => <XBrandIcon {...p} />,
  website: (p) => <GlobeIcon {...p} />,
  other: (p) => <GlobeIcon {...p} />,
};
const LINK_LABEL: Record<string, string> = { linkedin: "LinkedIn", github: "GitHub", x: "X" };
const KIND_ORDER = ["linkedin", "github", "x", "website", "other"];

function linkLabel(l: LeadLink) {
  return LINK_LABEL[l.kind] ?? hostOf(l.url) ?? l.url;
}

/** Company links (LinkedIn / GitHub / X / website) as chips, then the named people with their profile icons. */
export function LinksAndContacts({ lead }: { lead: Pick<Lead, "links" | "contacts" | "website" | "domain"> }) {
  const links = [...(lead.links ?? [])];
  if (!links.some((l) => l.kind === "website") && lead.website) links.push({ kind: "website", url: lead.website, source_url: lead.website });
  links.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const contacts = lead.contacts ?? [];
  if (!links.length && !contacts.length) return <p className="text-[13px]/4.5 text-muted">None found yet</p>;
  return (
    <div className="flex flex-col gap-3">
      {links.length ? (
        <div className="flex flex-wrap gap-1.5">
          {links.map((l) => (
            <a
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="flex h-7 items-center gap-1.5 rounded-full border border-[#200D0D1A] px-2.5 text-xs/4 font-medium text-ink hover:bg-[#200D0D08]"
            >
              {(LINK_ICON[l.kind] ?? LINK_ICON.other)!({})}
              {linkLabel(l)}
            </a>
          ))}
        </div>
      ) : null}
      {contacts.length ? (
        <ul className="flex flex-col">
          {contacts.map((c, i) => (
            <ContactRow key={`${c.name}-${i}`} c={c} first={i === 0} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ContactRow({ c, first }: { c: LeadContact; first: boolean }) {
  const profiles = [
    c.linkedin_url ? { href: c.linkedin_url, label: `${c.name} on LinkedIn`, icon: <LinkedInIcon size={14} /> } : null,
    c.x_url ? { href: c.x_url, label: `${c.name} on X`, icon: <XBrandIcon size={13} /> } : null,
    c.github_url ? { href: c.github_url, label: `${c.name} on GitHub`, icon: <GitHubIcon size={14} /> } : null,
  ].filter((p): p is NonNullable<typeof p> => p !== null);
  return (
    <li className={cx("flex h-9 items-center gap-3", !first && "border-t border-t-[#200D0D0F]")}>
      <span className="min-w-0 grow basis-0 truncate text-[13px]/4 font-medium text-ink">
        {c.name}
        {c.title ? <span className="text-muted"> · {c.title}</span> : null}
      </span>
      <span className="flex items-center gap-2.5">
        {profiles.map((p) => (
          <a key={p.href} href={p.href} target="_blank" rel="noopener noreferrer nofollow" aria-label={p.label} className="text-ink hover:opacity-70">
            {p.icon}
          </a>
        ))}
      </span>
    </li>
  );
}

// ---------- notes ----------

const RATED: Record<string, string> = { thumbs_down: "rated down", thumbs_up: "rated up" };

/** Stacked (popover): avatar, "Name · Nov 7", then the note. Inline (review, detail): one run of text. */
export function NoteList({ notes, variant = "stacked" }: { notes: LeadNote[]; variant?: "stacked" | "inline" }) {
  const describe = useDescribeAuthor();
  return (
    <ul className={cx("flex flex-col", variant === "stacked" ? "gap-2.5" : "gap-2")}>
      {notes.map((n) => {
        const a = describe(n.author);
        const meta = [shortDate(n.created_at), RATED[n.kind]].filter(Boolean).join(" · ");
        return (
          <li key={n.id} className="flex items-start gap-2">
            <AuthorAvatar author={a} />
            {variant === "stacked" ? (
              <div className="flex min-w-0 flex-col gap-px">
                <div className="text-xs/4 text-muted">
                  <span className="font-semibold text-ink">{a.name}</span> · {meta}
                </div>
                <p className="whitespace-pre-wrap text-[13px]/4.75 text-ink [overflow-wrap:anywhere]">{n.body}</p>
              </div>
            ) : (
              <p className="min-w-0 text-[13px]/5 text-ink [overflow-wrap:anywhere]">
                <span className="font-semibold">{a.name}</span> <span className="text-muted">· {meta}</span> {n.body}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * "Add a note…": Enter saves (Shift+Enter is ignored: notes are one line here). `button` adds the design's Save
 * pill (popover); otherwise an "Enter" hint sits in the field (review, lead detail).
 */
export function NoteComposer({
  leadId,
  button,
  placeholder = "Add a note…",
  inputRef,
  kind = "note",
  onSaved,
  className,
}: {
  leadId: string;
  button?: boolean;
  placeholder?: string;
  inputRef?: Ref<HTMLInputElement>;
  kind?: LeadNote["kind"];
  onSaved?: (note: LeadNote) => void;
  className?: string;
}) {
  const api = useApi();
  const invalidate = useInvalidateLead();
  const [text, setText] = useState("");
  const add = useMutation({
    mutationFn: (body: string) => api.addNote(leadId, { body, kind: kind as "note" }),
    onSuccess: ({ note }) => {
      setText("");
      invalidate(leadId);
      onSaved?.(note);
    },
  });
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (body && !add.isPending) add.mutate(body);
  };
  return (
    <form onSubmit={submit} className={cx("flex flex-col gap-1.5", className)}>
      <div className="flex items-center gap-2">
        <label className={cx("flex min-w-0 grow items-center gap-2 rounded-lg border bg-white", button ? "h-8.5 border-[#200D0D1A] px-3" : "h-9.5 border-[#200D0D33] pl-3 pr-2")}>
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={placeholder}
            aria-label={placeholder.replace(/…$/, "")}
            maxLength={4000}
            className="min-w-0 grow bg-transparent text-[13px]/4 text-ink outline-none placeholder:text-[#200D0D73]"
          />
          {button ? null : (
            <kbd className="flex h-5.5 shrink-0 items-center rounded-[5px] border border-[#200D0D26] px-1.75 font-sans text-[11px]/3.5 font-semibold text-muted">
              {add.isPending ? "Saving" : "Enter"}
            </kbd>
          )}
        </label>
        {button ? (
          <button
            type="submit"
            disabled={!text.trim() || add.isPending}
            className="flex h-8.5 shrink-0 items-center rounded-full border border-ink bg-white px-3.5 text-[13px]/4 font-medium text-ink hover:bg-[#200D0D08] disabled:opacity-50"
          >
            {add.isPending ? "Saving…" : "Save"}
          </button>
        ) : null}
      </div>
      {add.isError ? <QueryError error={add.error} what="the note" /> : null}
    </form>
  );
}

/** Who's who line under a company name: "domain · Arjun Patel, VP Revenue". */
export function leadMeta(lead: Pick<Lead, "domain" | "name" | "title">, opts: { person?: boolean } = { person: true }): string {
  const who = opts.person && lead.name ? [lead.name, lead.title].filter(Boolean).join(", ") : null;
  return [lead.domain, who].filter(Boolean).join(" · ");
}
