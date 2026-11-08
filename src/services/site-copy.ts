// What read_website returns for Crusonia's own site. A Worker cannot fetch its own hostname (the
// request comes back 404), and the landing is a client-rendered SPA whose ASSETS index.html holds no copy, so
// onboarding Crusonia itself (dogfooding) reads this text instead. The landing strings are copied from
// web/src/landing/*.tsx: test/read-website.test.ts fails when one of them no longer appears there. Pricing comes
// from the same shared catalog as /pricing and /api/billing.
import { packCatalog, planCatalog } from "../billing/catalog.ts";

export type SitePage = { path: string; title: string; description: string | null; text: string };

/** Landing copy, in page order. Each line must appear verbatim in web/src/landing/*.tsx. */
export const LANDING_LINES = [
  "A go-to-market team",
  "that grows on its own.",
  "Tell us what you're building",
  "Infrastructure for",
  "all your GTM needs.",
  "Builds the workflow",
  "Researches each account, scores the fit and writes the draft. Every day, with no one pushing it.",
  "Connects your stack",
  "HubSpot, Notion, your inbox and web data from Apify, wired together through one agent.",
  "Keeps the data clean",
  "Every company and contact has a source, gets deduplicated, and is refreshed when it goes stale.",
  "Asks before it sends",
  "Every draft waits for your approval, with its sources. Nothing goes out on its own.",
  "Connect your agent in one click, then run your whole GTM from it.",
  "Grow your company offline.",
  "Your agent researches, drafts and follows up overnight. You wake up to replies, and nothing goes out without your yes.",
] as const;

const LANDING_TITLE = "Crusonia · A go-to-market team that grows on its own";

function pricingText(): string {
  const plans = planCatalog().map((p) => `${p.name} (${p.price}): ${p.description}`);
  const packs = packCatalog().map((p) => `${p.name} (${p.price}): ${p.description}`);
  return ["Pricing", "Plans", ...plans, "Credit packs", ...packs].join("\n");
}

export function siteCopy(): SitePage[] {
  return [
    {
      path: "/",
      title: LANDING_TITLE,
      description: null,
      text: [
        `${LANDING_LINES[0]} ${LANDING_LINES[1]}`,
        `No website yet? ${LANDING_LINES[2]}.`,
        `${LANDING_LINES[3]} ${LANDING_LINES[4]}`,
        ...[5, 7, 9, 11].map((i) => `${LANDING_LINES[i]}: ${LANDING_LINES[i + 1]}`),
        `Set-up fast. ${LANDING_LINES[13]} Add to Claude Code or Codex.`,
        `${LANDING_LINES[14]} ${LANDING_LINES[15]}`,
      ].join("\n"),
    },
    { path: "/pricing", title: "Crusonia · Pricing", description: null, text: pricingText() },
  ];
}
