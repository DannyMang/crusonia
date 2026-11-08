// Company domains, normalized so a company is stored once per workspace: lowercase, no scheme, path, port or
// `www.`, reduced to the registrable domain ("blog.acme.co.uk" -> "acme.co.uk", "app.acme.com" -> "acme.com").
// Pure. The same rules run in Postgres as crusonia_registrable_domain() (src/schema.sql), which a trigger applies
// to every leads row, so both must change together.
//
// The registrable domain uses a short list of public suffixes rather than the full Public Suffix List: the common
// two-label country suffixes, and hosting platforms where each subdomain is a different owner (acme.vercel.app is
// not vercel.app).

/** Suffixes under which the registrable domain is one more label. Keep in sync with crusonia_registrable_domain(). */
export const MULTI_LABEL_SUFFIXES = new Set([
  // country second levels
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "org.nz", "co.jp", "ne.jp", "or.jp", "co.kr", "or.kr", "com.br", "net.br", "org.br", "com.mx", "com.ar",
  "com.co", "com.pe", "co.in", "net.in", "org.in", "co.za", "org.za", "com.sg", "com.my", "com.hk", "com.tw",
  "com.cn", "net.cn", "org.cn", "com.tr", "co.il", "org.il", "com.ua", "co.id", "com.ph", "com.vn", "com.pk",
  "com.ng", "com.eg", "com.sa", "co.th", "co.ke",
  // hosting platforms (each subdomain is its own site)
  "github.io", "gitlab.io", "vercel.app", "netlify.app", "herokuapp.com", "workers.dev", "pages.dev", "web.app",
  "firebaseapp.com", "appspot.com", "azurewebsites.net", "cloudfront.net", "blogspot.com", "wordpress.com",
  "substack.com", "notion.site", "webflow.io", "framer.website", "framer.app", "myshopify.com", "wixsite.com",
  "squarespace.com", "carrd.co", "bubbleapps.io", "replit.app", "fly.dev", "onrender.com", "railway.app",
  "glitch.me", "readthedocs.io",
]);

/** "https://www.Blog.Acme.co.uk/about" -> "acme.co.uk". Null when it doesn't look like a domain. */
export function registrableDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  let host = value.trim().toLowerCase();
  if (!host) return null;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(host) ? host : `https://${host}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "").replace(/^www\d*\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join(".");
  return labels.slice(MULTI_LABEL_SUFFIXES.has(lastTwo) ? -3 : -2).join(".");
}
