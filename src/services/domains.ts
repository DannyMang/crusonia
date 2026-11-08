// Company domains. Pure. One normalized domain per company is what keeps Crusonia from logging the same company
// twice: lowercase, no scheme, path or `www.`, reduced to the registrable domain (careers.acme.co.uk -> acme.co.uk),
// and never the domain of a site that only hosts the company: a job board, a social network, an ATS, a free
// mailbox. A lead found on jobs.lever.co/acme needs acme's own domain, not lever.co.

// Two-label public suffixes (a registrable domain under them has three labels). Not the whole Public Suffix List:
// the common country second-level domains plus hosting platforms where each subdomain is a different owner.
const MULTI_LABEL_SUFFIXES = new Set([
  // country second-level domains
  "co.uk", "org.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk", "me.uk", "net.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "co.nz", "org.nz", "net.nz",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "co.kr", "or.kr", "co.in", "net.in", "org.in", "firm.in",
  "com.br", "net.br", "org.br", "com.mx", "org.mx", "com.ar", "com.co", "com.pe", "com.cl", "com.uy",
  "com.cn", "net.cn", "org.cn", "com.hk", "com.tw", "com.sg", "com.my", "com.ph", "com.vn", "co.id", "co.th",
  "co.za", "org.za", "co.il", "org.il", "com.tr", "com.eg", "com.sa", "com.pk", "com.ng", "co.ke", "com.ua",
  "com.pl", "com.es", "com.pt", "com.gr", "co.at", "or.at", "com.ru",
  // hosting platforms: acme.github.io and other.github.io are different owners
  "github.io", "gitlab.io", "vercel.app", "netlify.app", "herokuapp.com", "workers.dev", "pages.dev", "web.app",
  "firebaseapp.com", "webflow.io", "framer.website", "framer.app", "notion.site", "carrd.co", "wixsite.com",
  "myshopify.com", "substack.com", "squarespace.com", "bubbleapps.io", "replit.app", "fly.dev", "onrender.com",
]);

// Registrable domains that host many companies' pages (job boards, ATSs, social networks, directories, code hosts)
// or personal mailboxes: never a company's own domain.
export const HOST_DOMAINS = new Set([
  // job boards and applicant tracking systems
  "lever.co", "greenhouse.io", "ashbyhq.com", "workable.com", "smartrecruiters.com", "recruitee.com", "bamboohr.com",
  "breezy.hr", "jobvite.com", "teamtailor.com", "personio.de", "personio.com", "workday.com", "myworkdayjobs.com",
  "icims.com", "taleo.net", "jazzhr.com", "applytojob.com", "pinpointhq.com", "dover.com", "rippling-ats.com",
  "indeed.com", "glassdoor.com", "ziprecruiter.com", "monster.com", "simplyhired.com", "careerbuilder.com",
  "wellfound.com", "angel.co", "workatastartup.com", "builtin.com", "builtinnyc.com", "builtinsf.com", "builtinla.com",
  "builtinboston.com", "builtinchicago.com", "builtinaustin.com", "builtinseattle.com", "builtincolorado.com",
  "otta.com", "welcometothejungle.com", "standout.work", "hired.com", "dice.com", "remoteok.com", "weworkremotely.com",
  "remotive.com", "jobs.com", "joinhandshake.com", "levels.fyi",
  // social networks, directories and publishing hosts
  "linkedin.com", "lnkd.in", "x.com", "twitter.com", "facebook.com", "instagram.com", "youtube.com", "tiktok.com",
  "threads.net", "reddit.com", "medium.com", "github.com", "gitlab.com", "producthunt.com", "crunchbase.com",
  "ycombinator.com", "pitchbook.com", "cbinsights.com", "techcrunch.com", "g2.com", "capterra.com", "trustpilot.com",
  "wikipedia.org", "bloomberg.com", "zoominfo.com", "apollo.io", "rocketreach.co", "signalhire.com", "f6s.com",
  "google.com", "goo.gl", "bit.ly", "linktr.ee", "calendly.com", "notion.so", "docs.google.com", "eventbrite.com", "lu.ma", "meetup.com",
  // personal mailboxes
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de",
  "mail.com", "yandex.com", "yandex.ru", "zoho.com", "fastmail.com", "hey.com", "qq.com", "163.com", "web.de",
]);

/** "careers.acme.co.uk" -> "acme.co.uk", "acme.github.io" -> "acme.github.io". */
export function registrableDomain(host: string): string {
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return labels.slice(MULTI_LABEL_SUFFIXES.has(lastTwo) ? -3 : -2).join(".");
}

/** A URL, host or domain as its lowercased host (no scheme, path, port, trailing dot or `www.`), or null. */
export function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  let host = value.trim().toLowerCase();
  if (!host) return null;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(host) ? host : `https://${host}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\d*\./, "").replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

export function isHostDomain(domain: string): boolean {
  return HOST_DOMAINS.has(domain) || HOST_DOMAINS.has(registrableDomain(domain));
}

/**
 * The company's normalized domain from a domain, website URL or host: registrable, lowercased, no `www.` or path.
 * Null when there is none, or when it is a job board, social network or other host domain (see `whyNoDomain`).
 */
export function normalizeDomain(value: string | null | undefined): string | null {
  const host = hostOf(value);
  if (!host) return null;
  const domain = registrableDomain(host);
  return isHostDomain(domain) ? null : domain;
}

/** Why `normalizeDomain(value)` is null, for error messages; null when it is not. */
export function whyNoDomain(value: string | null | undefined): string | null {
  const host = hostOf(value);
  if (!host) return value ? `"${value}" is not a domain or website` : null;
  const domain = registrableDomain(host);
  return isHostDomain(domain) ? `${domain} hosts other companies' pages (a job board, social network or directory), so it is not the company's domain` : null;
}
