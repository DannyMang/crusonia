// /privacy: a draft for the owner to review, not legal advice. Based on what the product stores and who it sends data to:
// the providers in src/env.ts, traces in src/services/traces.ts, operators' access in src/api/admin.ts.
import { LEGAL_CONTACT, LEGAL_ENTITY, LegalPage, Section, TextLink } from "./LegalPage.tsx";

const PROCESSORS: [string, string][] = [
  ["Cloudflare", "hosting"],
  ["Neon", "database"],
  ["Clerk", "sign-in"],
  ["Naive", "running the AI agents"],
  ["Apify", "reading public web pages"],
  ["AgentMail", "sending and receiving email"],
  ["Stripe", "payments, once they open"],
  ["HubSpot and Notion", "only if your workspace connects them"],
  ["Photon", "iMessage approvals, for the instance owner's own workspace only"],
];

export default function Privacy() {
  return (
    <LegalPage title="Privacy">
      <Section title="Who we are">
        <p>
          {LEGAL_ENTITY} runs the hosted Crusonia service. This notice says what we keep and why. The <TextLink to="/terms">Terms</TextLink> cover the rest.
        </p>
      </Section>
      <Section title="What we keep">
        <ul className="flex list-disc flex-col gap-1.5 pl-5">
          <li>
            <span className="font-medium text-ink">Your account:</span> your name, email and workspace. To give each person one free sample, we keep a one-way hash of your email.
          </li>
          <li>
            <span className="font-medium text-ink">Your Company summary:</span> what you tell us about your business, and what agents write from your website.
          </li>
          <li>
            <span className="font-medium text-ink">Leads:</span> companies and people you add or import, or that agents find on public web pages: names, job titles, work emails and links, with where each came from.
          </li>
          <li>
            <span className="font-medium text-ink">Agent traces:</span> a step-by-step record of what each agent run did.
          </li>
          <li>
            <span className="font-medium text-ink">Billing:</span> your credit balance and history. Card details stay with Stripe.
          </li>
        </ul>
      </Section>
      <Section title="How we use it">
        <p>Only to run the service for you, keep it secure and fix problems. We don't sell your data.</p>
      </Section>
      <Section title="Who can see it">
        <p>People in your workspace see your workspace&apos;s data. The people who operate Crusonia can read agent traces to debug and improve quality, and each time they do, it is recorded in your workspace&apos;s audit trail.</p>
        <p>These companies process data for us:</p>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {PROCESSORS.map(([name, what]) => (
            <li key={name}>
              <span className="font-medium text-ink">{name}:</span> {what}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="How long we keep it">
        <p>Agent traces are deleted after 180 days. Everything else stays until you ask us to delete your account.</p>
      </Section>
      <Section title="Your choices">
        <p>To see, correct or delete your data, or if an agent found you and you want to be removed, write to {LEGAL_CONTACT}.</p>
      </Section>
    </LegalPage>
  );
}
