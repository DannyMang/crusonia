// Throwaway email addresses: a free sample is one per person, and these make a new "person" in seconds. A short list of the
// big public services, not an arms race: the instance cap holds the money whatever gets through. Lowercase domains; a
// subdomain of one counts too. Pure.
const DISPOSABLE = new Set([
  "10minutemail.com",
  "20minutemail.com",
  "burnermail.io",
  "byom.de",
  "discard.email",
  "dispostable.com",
  "dropmail.me",
  "emailondeck.com",
  "fakeinbox.com",
  "getairmail.com",
  "getnada.com",
  "grr.la",
  "guerrillamail.biz",
  "guerrillamail.com",
  "guerrillamail.de",
  "guerrillamail.info",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamailblock.com",
  "harakirimail.com",
  "inboxkitten.com",
  "jetable.org",
  "linshiyouxiang.net",
  "mail-temp.com",
  "maildrop.cc",
  "mailinator.com",
  "mailnesia.com",
  "mailsac.com",
  "mintemail.com",
  "moakt.com",
  "mohmal.com",
  "mytemp.email",
  "nada.email",
  "sharklasers.com",
  "spam4.me",
  "spamgourmet.com",
  "temp-mail.io",
  "temp-mail.org",
  "tempail.com",
  "tempmail.com",
  "tempmail.net",
  "tempmailo.com",
  "tempr.email",
  "throwawaymail.com",
  "tmpmail.org",
  "trashmail.com",
  "trashmail.de",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
]);

const domainOf = (email: string) => email.trim().toLowerCase().split("@").pop() ?? "";

export function isDisposableEmail(email: string): boolean {
  const labels = domainOf(email).split(".");
  for (let i = 0; i < labels.length - 1; i++) if (DISPOSABLE.has(labels.slice(i).join("."))) return true;
  return false;
}

/**
 * The address a mailbox really is, to count one free sample per person: lowercase, no +tag, and for Gmail no dots
 * (dan+1@gmail.com and d.a.n@googlemail.com are all dan@gmail.com). Pure.
 */
export function canonicalEmail(email: string): string {
  const [rawLocal = "", rawDomain = ""] = email.trim().toLowerCase().split(/@(?=[^@]*$)/);
  const domain = rawDomain === "googlemail.com" ? "gmail.com" : rawDomain;
  const local = rawLocal.split("+")[0] ?? "";
  return `${domain === "gmail.com" ? local.replaceAll(".", "") : local}@${domain}`;
}
