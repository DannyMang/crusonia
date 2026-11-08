// Outreach channels and the rules a draft must pass before it is stored. Pure, so they are unit tested.
//
//   email         AgentMail, only to opted-in leads, only after the owner approves the exact version (unchanged).
//   email_manual  The owner sends it from their own mailbox: needs the lead's email, not consent.
//   linkedin      The owner sends it on LinkedIn: needs the person's LinkedIn profile URL.
//   x             The owner sends it as an X DM: needs the person's public X profile URL.
//   intro         A short forwardable blurb for a warm introduction; a profile URL is optional.
//
// Every manual channel is a task in the owner's queue: copy the text, open the profile, mark it sent or skip it.
// Nothing ever sends a manual draft: it gets no approval, and the send path only accepts email drafts. Manual
// drafts are for scored, qualified leads, must cite the lead's saved evidence, and never go to anyone who
// unsubscribed or is on the suppression list.
import { z } from "zod";

export const DRAFT_CHANNELS = ["email", "email_manual", "linkedin", "x", "intro"] as const;
export type DraftChannel = (typeof DRAFT_CHANNELS)[number];
export const MANUAL_CHANNELS = ["email_manual", "linkedin", "x", "intro"] as const satisfies readonly DraftChannel[];
export type ManualChannel = (typeof MANUAL_CHANNELS)[number];

export const isManualChannel = (channel: string): channel is ManualChannel => (MANUAL_CHANNELS as readonly string[]).includes(channel);

export const CHANNEL_LABEL: Record<DraftChannel, string> = {
  email: "Email",
  email_manual: "Email from your mailbox",
  linkedin: "LinkedIn message",
  x: "X message",
  intro: "Warm intro request",
};

export const citationSchema = z.object({
  text: z.string().trim().min(3).max(500).describe("The factual phrase or sentence from the body, copied exactly."),
  source_url: z.httpUrl().max(2048).describe("The source_url of the lead's saved evidence that supports it."),
});
export type Citation = z.infer<typeof citationSchema>;

export type ChannelLead = {
  id: string;
  email: string | null;
  name?: string | null;
  company?: string | null;
  linkedin_url: string | null;
  consent_at: Date | string | null;
  stage: string;
  qualified: boolean | null;
  suppressed: boolean;
};

export type ChannelCheck = { ok: true; recipient: string | null; target_url: string | null } | { ok: false; message: string };

const fail = (message: string): ChannelCheck => ({ ok: false, message });

function hostOf(raw: string | null | undefined): { url: string; host: string } | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return { url: u.href, host: u.hostname.toLowerCase().replace(/^(www|mobile|m)\./, "") };
  } catch {
    return null;
  }
}

/**
 * Whether this lead may get a draft on this channel, and who/where it goes. The email rules (and their messages)
 * are the ones createDraft always had: an email, recorded consent, not unsubscribed or suppressed.
 */
export function checkChannel(lead: ChannelLead, input: { channel: DraftChannel; profile_url?: string | null }): ChannelCheck {
  const { channel } = input;
  if (channel === "email") {
    if (!lead.email) return fail(`Lead ${lead.id} has no email address, so there is nothing to send to.`);
    if (!lead.consent_at) {
      return fail(
        `Lead ${lead.id} has no recorded consent (agent-found leads never do). Crusonia only emails people who opted in, so drafts are only for leads with has_consent: true. For a lead without consent, draft a manual message instead (channel linkedin, x, intro or email_manual).`,
      );
    }
    if (lead.suppressed || lead.stage === "unsubscribed") return fail(`Lead ${lead.id} unsubscribed or is on the suppression list: do not contact.`);
    return { ok: true, recipient: lead.email, target_url: null };
  }

  if (lead.suppressed || lead.stage === "unsubscribed") return fail(`Lead ${lead.id} unsubscribed or is on the suppression list: do not contact on any channel.`);
  if (lead.qualified !== true) {
    return fail(`Lead ${lead.id} is not scored qualified. Research it and save a qualified verdict (save_research) before drafting a manual message.`);
  }
  switch (channel) {
    case "email_manual":
      if (!lead.email) return fail(`Lead ${lead.id} has no email address for the owner to write to. Use linkedin, x or intro instead; never guess an address.`);
      return { ok: true, recipient: lead.email, target_url: null };
    case "linkedin": {
      const target = hostOf(input.profile_url ?? lead.linkedin_url);
      if (!target) return fail(`Lead ${lead.id} has no LinkedIn profile URL. Pass profile_url (a linkedin.com page you read), or pick another channel.`);
      if (target.host !== "linkedin.com" && !target.host.endsWith(".linkedin.com")) return fail(`profile_url must be a linkedin.com URL for channel linkedin (got ${target.host}).`);
      return { ok: true, recipient: null, target_url: target.url };
    }
    case "x": {
      const target = hostOf(input.profile_url);
      if (!target) return fail("Channel x needs profile_url: the person's public X profile (x.com/<handle>) from a page you read.");
      if (target.host !== "x.com" && target.host !== "twitter.com") return fail(`profile_url must be an x.com or twitter.com URL for channel x (got ${target.host}).`);
      return { ok: true, recipient: null, target_url: target.url };
    }
    case "intro": {
      if (input.profile_url && !hostOf(input.profile_url)) return fail("profile_url must be an http(s) URL.");
      return { ok: true, recipient: null, target_url: hostOf(input.profile_url)?.url ?? null };
    }
  }
}

const normText = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

export function normalizeUrlForMatch(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    return `${u.protocol}//${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return raw.trim();
  }
}

/**
 * Problems with a draft's citations: each must quote the body and point at evidence saved for the lead. Manual
 * drafts need at least one (`required`). Empty = fine.
 */
export function citationProblems(body: string, citations: Citation[], evidenceUrls: Iterable<string>, required: boolean): string[] {
  const problems: string[] = [];
  if (required && citations.length === 0) {
    problems.push("Cite the saved evidence behind the message: citations [{text, source_url}] for every factual sentence.");
  }
  const saved = new Set([...evidenceUrls].map(normalizeUrlForMatch));
  const haystack = normText(body);
  for (const c of citations) {
    if (!haystack.includes(normText(c.text))) problems.push(`Citation text is not in the body: "${c.text.slice(0, 80)}"`);
    if (!saved.has(normalizeUrlForMatch(c.source_url))) problems.push(`Citation source is not saved evidence for this lead: ${c.source_url} (save it first).`);
  }
  return problems;
}

/** The task title for manual channels without a subject, e.g. "LinkedIn message to Adam Cohen". */
export function taskTitle(channel: DraftChannel, lead: Pick<ChannelLead, "name" | "company">): string {
  const who = lead.name ?? lead.company ?? "the lead";
  return `${CHANNEL_LABEL[channel]} to ${who}${lead.name && lead.company ? ` (${lead.company})` : ""}`.slice(0, 200);
}

/** Where the owner sends a task: the profile to open, or a mailto: link that only opens their mail client. */
export function openUrl(task: { channel: string; target_url: string | null; subject: string; body: string }, leadEmail: string | null): string | null {
  if (task.target_url) return task.target_url;
  if (task.channel === "email_manual" && leadEmail) {
    return `mailto:${encodeURIComponent(leadEmail)}?subject=${encodeURIComponent(task.subject)}&body=${encodeURIComponent(task.body)}`;
  }
  return null;
}
