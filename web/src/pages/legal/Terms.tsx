// /terms: a draft for the owner to review, not legal advice. It says what the product really does today: free credits,
// paid top-ups not open yet, agents that can be wrong, and no email going out without a person's approval.
import { ContactLink, LEGAL_ENTITY, LEGAL_JURISDICTION, LegalPage, Section, TextLink } from "./LegalPage.tsx";

export default function Terms() {
  return (
    <LegalPage title="Terms">
      <Section title="What Crusonia is">
        <p>
          Crusonia is run by {LEGAL_ENTITY}. AI agents find and research companies from public web pages and draft outreach for you. By using the hosted service you agree to these
          terms and our <TextLink to="/privacy">Privacy</TextLink> notice.
        </p>
      </Section>
      <Section title="Check what the agents do">
        <p>Agents make mistakes. Their research, scores and drafts can be wrong, so read them before you rely on them. You decide what gets sent, and you are responsible for it.</p>
      </Section>
      <Section title="Your account">
        <p>You need a verified email address. Keep your sign-in and API keys safe: what happens under them is your responsibility. Everyone gets one free sample, so don't make extra accounts to get more.</p>
      </Section>
      <Section title="Credits">
        <p>Credits pay for hosted agent work. Free credits have no cash value and can't be transferred. Paid top-ups aren't open yet; when they are, their prices and refund terms will be set out here first.</p>
      </Section>
      <Section title="Fair use">
        <p>
          Don't use Crusonia to send spam, contact people who asked you not to, invite people you have no reason to invite, break the law or anyone's rights, or get around its limits. You are responsible for having a lawful basis to
          contact the people in your workspace.
        </p>
      </Section>
      <Section title="Your data">
        <p>What you put in Crusonia stays yours. We use it only to run the service for you.</p>
      </Section>
      <Section title="Limits and changes">
        <p>
          The service has spending and rate limits, and new agent runs can wait when it is at capacity. We may change or stop the service, and may suspend accounts that break these terms. If we change these terms, we will update this page and its date.
        </p>
      </Section>
      <Section title="No guarantees">
        <p>
          The service is provided as is, without warranties. As far as the law allows, we aren't liable for indirect losses, and our total liability is limited to what you paid us in the 12 months before the claim. These terms are governed by the laws of {LEGAL_JURISDICTION}.
        </p>
      </Section>
      <Section title="Open source">
        <p>Crusonia's code is under the MIT license. If you host it yourself, that license applies and these terms don't.</p>
      </Section>
      <Section title="Contact">
        <p>
          <ContactLink />
        </p>
      </Section>
    </LegalPage>
  );
}
