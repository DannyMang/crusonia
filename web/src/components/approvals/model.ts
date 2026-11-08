// Pure helpers for approvals: how a row is labelled, grouped and searched. Agent payloads are untrusted, so
// everything read from `payload` is type-checked and only ever rendered as text.
import type { ApprovalListItem } from "../../api.ts";
import { hostOf } from "../../lib/format.ts";

/** Rows expiring within this window go in "Expiring soon" and show their time left in red. */
export const SOON_MS = 15 * 60_000;

export const msLeft = (a: { expires_at: string }, now: number) => new Date(a.expires_at).getTime() - now;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

export const workflowOf = (a: ApprovalListItem) => str(a.payload?.workflow);
export const toolNameOf = (a: ApprovalListItem) => str(a.payload?.name);

export type QuestionField = { key: string; label: string; multiple: boolean; options: string[] };

export function questionOf(a: ApprovalListItem): { prompt: string; fields: QuestionField[] } {
  const q = a.payload?.question as { prompt?: unknown; fields?: unknown } | undefined;
  const fields = Array.isArray(q?.fields) ? q.fields : [];
  return {
    prompt: str(q?.prompt) ?? a.summary.replace(/^Agent asks:\s*/, ""),
    fields: fields
      .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === "object" && typeof (f as { key?: unknown }).key === "string")
      .map((f) => ({
        key: f.key as string,
        label: str(f.label) ?? (f.key as string),
        multiple: f.multiple === true,
        options: Array.isArray(f.options) ? f.options.map((o) => (typeof o === "string" ? o : JSON.stringify(o))) : [],
      })),
  };
}

/** Left-hand name in a queue row: the person, else the company, else who it goes to. */
export function rowTitle(a: ApprovalListItem): string {
  return a.lead?.name || a.lead?.company || a.recipient || (a.kind === "send" ? "Unknown recipient" : "Agent request");
}

/** Muted text next to the name (the company, when the name is a person). */
export function rowSubtitle(a: ApprovalListItem): string | null {
  return a.lead?.name ? (a.lead.company ?? hostOf(a.lead.email?.split("@")[1])) : null;
}

export function rowTag(a: ApprovalListItem): string {
  if (a.kind === "tool") return "Tool call";
  if (a.kind === "question") return "Question";
  return a.draft?.variant ? `Variant ${a.draft.variant}` : "Email";
}

/** Second-line context: the workflow when the agent named one, else what is being decided. */
export function rowContext(a: ApprovalListItem): string {
  const wf = workflowOf(a);
  if (a.kind === "tool") return [toolNameOf(a), wf].filter(Boolean).join(" · ") || a.summary;
  if (a.kind === "question") return wf ?? questionOf(a).prompt;
  return wf ?? a.draft?.subject ?? a.summary;
}

export function matchesSearch(a: ApprovalListItem, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return [a.code, a.recipient, a.lead?.name, a.lead?.company, a.lead?.email, a.draft?.subject, workflowOf(a), toolNameOf(a)].some((v) => v?.toLowerCase().includes(s));
}

/** The approval lifetime in whole minutes when every row agrees (it is one server setting), else null. */
export function ttlMinutes(list: ApprovalListItem[]): number | null {
  const ttls = new Set(list.map((a) => Math.round((new Date(a.expires_at).getTime() - new Date(a.created_at).getTime()) / 60_000)));
  if (ttls.size !== 1) return null;
  const [n] = [...ttls];
  return n && n > 0 ? n : null;
}

export const jsonText = (v: unknown) => {
  if (v === undefined) return "";
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
};

/** Only http(s) links from scraped or agent data become clickable. */
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** "fieldnote.io/careers" from "https://www.fieldnote.io/careers/". */
export function shortUrl(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url.includes("://") ? url : `https://${url}`);
    return (hostOf(u.href) + u.pathname).replace(/\/$/, "");
  } catch {
    return url;
  }
}
