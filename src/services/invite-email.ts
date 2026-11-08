// The invite email: a fixed transactional template. Everything in it that a person typed (a workspace name, their own
// name) is untrusted: it goes out from the instance's own inbox, to an address the sender chose, so it must not be
// able to carry markup, a link or a pitch. Names are cleaned here and escaped for the HTML part; there is no custom
// message. Pure, so `bun test` covers it.

const MAX_NAME = 60;
// C0/C1 controls, zero-width characters and bidi overrides. Line and paragraph separators count as whitespace below.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
// Anything a mail client could turn into a link: a scheme, www., an address, or a bare domain.
const LINKISH = /:\/\/|www\.|@|[a-z0-9-]\.[a-z]{2,}/i;

/** A name that is safe to show in the email, or null when there is nothing safe to show (the template says something generic). */
export function safeName(raw: string | null | undefined): string | null {
  const name = (raw ?? "").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  if (!name || LINKISH.test(name)) return null;
  return name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1).trimEnd()}…` : name;
}

export const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export type InviteEmailInput = {
  workspaceName: string | null | undefined;
  inviterName: string | null | undefined;
  role: "admin" | "member";
  /** The invited address. The invite only works for it. */
  email: string;
  /** PUBLIC_URL + /invite/<token>: never built from anything in the request. */
  url: string;
  expiresInDays: number;
};

export function inviteEmail(input: InviteEmailInput): { subject: string; text: string; html: string } {
  const workspace = safeName(input.workspaceName);
  const inviter = safeName(input.inviterName);
  const who = inviter ?? "A teammate";
  const where = workspace ?? "a Crusonia workspace";
  const onCrusonia = workspace ? `${workspace} on Crusonia` : where;
  const as = input.role === "admin" ? "an admin" : "a member";
  const validity = `This link works once and expires in ${input.expiresInDays} days. It only works for ${input.email}.`;
  const ignore = "If you weren't expecting this, you can ignore it.";

  const text = [`${who} invited you to join ${onCrusonia} as ${as}.`, "", `Accept the invite: ${input.url}`, "", validity, ignore].join("\n");

  const e = escapeHtml;
  const html = `<!doctype html>
<html><body style="margin:0;padding:32px 16px;background:#ffffff;color:#200D0D;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;"><tr><td>
<p style="margin:0 0 24px;font-size:17px;line-height:20px;font-weight:600;letter-spacing:-0.02em;">crusonia</p>
<p style="margin:0 0 24px;font-size:15px;line-height:22px;">${e(who)} invited you to join ${e(onCrusonia)} as ${as}.</p>
<p style="margin:0 0 24px;"><a href="${e(input.url)}" style="display:inline-block;padding:10px 16px;background:#200D0D;color:#ffffff;border-radius:8px;font-size:14px;line-height:18px;font-weight:600;text-decoration:none;">Accept invite</a></p>
<p style="margin:0;font-size:13px;line-height:20px;color:#200D0D99;">${e(validity)} ${e(ignore)}</p>
</td></tr></table>
</body></html>`;

  return { subject: `${who} invited you to ${onCrusonia}`, text, html };
}
