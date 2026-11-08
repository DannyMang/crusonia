// The editable profile on step 3. Segments and signals carry their own source URLs, so removing or
// reordering them keeps every "From …" label attached to the right item when the profile is saved.
import type { Profile, ProfileInput, ProfileSource } from "../../api.ts";
import { siteHost } from "./store.ts";

export type SegmentDraft = { key: string; name: string; company_size: string; industry: string; roles: string[]; sources: string[] };
export type SignalDraft = { key: string; name: string; description: string; checked: boolean; sources: string[] };

export type ProfileDraft = {
  version: 1;
  /** Where the starting values came from (changes the heading). */
  origin: "proposal" | "saved" | "empty";
  company: string;
  website: string;
  sells: string;
  /** No "what you sell" came with the profile, so step 3 asks for it. */
  askSells: boolean;
  icp_description: string;
  segments: SegmentDraft[];
  signals: SignalDraft[];
  /** Sources for the non-list fields (sells, icp_description, …). */
  otherSources: ProfileSource[];
  /** Not edited here, but PUT replaces the whole profile, so it is sent back unchanged. */
  notes: string | null;
};

let n = 0;
export const newKey = () => `k${Date.now().toString(36)}${(n++).toString(36)}`;

const indexed = /^(segments|signals)\.(\d+)/;

function urlsFor(sources: ProfileSource[], list: "segments" | "signals", i: number) {
  return sources.filter((s) => {
    const m = indexed.exec(s.field);
    return m?.[1] === list && Number(m[2]) === i;
  }).map((s) => s.url);
}

export function fromProfile(p: Profile, origin: ProfileDraft["origin"], fallbackWebsite?: string): ProfileDraft {
  const sources = p.sources ?? [];
  return {
    version: 1,
    origin,
    company: p.company ?? "",
    website: p.website || fallbackWebsite || "",
    sells: p.sells ?? "",
    askSells: !p.sells?.trim(),
    icp_description: p.icp_description ?? "",
    segments: (p.segments ?? []).map((s, i) => ({
      key: newKey(),
      name: s.name ?? "",
      company_size: s.company_size ?? "",
      industry: s.industry ?? "",
      roles: (s.roles ?? []).filter(Boolean),
      sources: urlsFor(sources, "segments", i),
    })),
    signals: (p.signals ?? []).map((s, i) => ({ key: newKey(), name: s.name ?? "", description: s.description ?? "", checked: true, sources: urlsFor(sources, "signals", i) })),
    otherSources: sources.filter((s) => !indexed.test(s.field)),
    notes: p.notes ?? null,
  };
}

export function emptyDraft(website?: string): ProfileDraft {
  return { version: 1, origin: "empty", company: "", website: website ?? "", sells: "", askSells: true, icp_description: "", segments: [], signals: [], otherSources: [], notes: null };
}

export function isDraft(v: unknown): v is ProfileDraft {
  return Boolean(v && typeof v === "object" && (v as ProfileDraft).version === 1 && Array.isArray((v as ProfileDraft).segments));
}

/** Segments are saved by name; an unnamed one with other fields filled in fails validation on step 3. */
export const keptSegments = (d: ProfileDraft) => d.segments.filter((s) => s.name.trim());
export const segmentHasContent = (s: SegmentDraft) => Boolean(s.industry.trim() || s.company_size.trim() || s.roles.length);
export const keptSignals = (d: ProfileDraft) => d.signals.filter((s) => s.checked && s.name.trim());

/** The body for PUT /api/profile (the whole profile, no updated_at). Unchecked and empty signals are dropped. */
export function toInput(d: ProfileDraft): ProfileInput {
  const segments = keptSegments(d);
  const signals = keptSignals(d);
  const orNull = (v: string) => v.trim() || null;
  return {
    company: orNull(d.company) ?? (siteHost(d.website) || null),
    website: orNull(d.website),
    sells: d.sells.trim(),
    icp_description: d.icp_description.trim(),
    segments: segments.map((s) => ({ name: s.name.trim(), company_size: orNull(s.company_size), industry: orNull(s.industry), roles: s.roles.map((r) => r.trim()).filter(Boolean) })),
    signals: signals.map((s) => ({ name: s.name.trim(), description: orNull(s.description) })),
    sources: [
      ...d.otherSources,
      ...segments.flatMap((s, i) => s.sources.map((url) => ({ field: `segments.${i}`, url }))),
      ...signals.flatMap((s, i) => s.sources.map((url) => ({ field: `signals.${i}`, url }))),
    ],
    notes: d.notes,
  };
}
