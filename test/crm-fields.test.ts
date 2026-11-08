// CRM sync field mapping and ownership rules (src/services/crm-fields.ts). Pure, no network.
import { describe, expect, test } from "bun:test";
import {
  companyToCandidate,
  consentMapping,
  contactIdentity,
  contactToCandidate,
  evidenceNoteBody,
  evidenceRef,
  inScope,
  LEAD_STATUS_FOR_STAGE,
  leadStatusFor,
  messageNoteBody,
  notionProperties,
  ownedProperties,
  parseNoteRefs,
  planCreate,
  planNotes,
  planUpdate,
  splitName,
  summarize,
  syncScope,
  type EvidenceRow,
  type MessageRow,
  type SyncLead,
} from "../src/services/crm-fields.ts";
import { planImport } from "../src/services/csv.ts";
import { LEAD_STAGES } from "../src/services/leads.ts";
import { syncLead } from "./helpers/fake-crm.ts";

const ALL = new Set(["crusonia_fit_score", "crusonia_fit_rationale", "crusonia_stage", "crusonia_last_outreach_at", "crusonia_source", "crusonia_lead_id"]);

describe("stage -> hs_lead_status", () => {
  test("every stage has a mapping, and leads without consent have none", () => {
    for (const stage of LEAD_STAGES) expect(stage in LEAD_STATUS_FOR_STAGE).toBe(true);
    expect(leadStatusFor("no_consent")).toBeNull();
  });

  test("the pipeline maps onto HubSpot's standard options", () => {
    const standard = new Set(["NEW", "OPEN", "IN_PROGRESS", "OPEN_DEAL", "UNQUALIFIED", "ATTEMPTED_TO_CONTACT", "CONNECTED", "BAD_TIMING"]);
    for (const v of Object.values(LEAD_STATUS_FOR_STAGE)) if (v) expect(standard.has(v)).toBe(true);
    expect(leadStatusFor("new")).toBe("NEW");
    expect(leadStatusFor("qualified")).toBe("OPEN");
    expect(leadStatusFor("awaiting_approval")).toBe("IN_PROGRESS");
    expect(leadStatusFor("sent")).toBe("ATTEMPTED_TO_CONTACT");
    expect(leadStatusFor("replied")).toBe("CONNECTED");
    expect(leadStatusFor("interested")).toBe("CONNECTED");
    expect(leadStatusFor("meeting_booked")).toBe("OPEN_DEAL");
    expect(leadStatusFor("disqualified")).toBe("UNQUALIFIED");
    expect(leadStatusFor("unsubscribed")).toBe("UNQUALIFIED");
    expect(leadStatusFor("something_new")).toBeNull();
  });
});

describe("HubSpot field mapping", () => {
  test("identity: name split, blanks dropped", () => {
    expect(splitName("Ada")).toEqual({ firstname: "Ada" });
    expect(splitName("  Ada  King Lovelace ")).toEqual({ firstname: "Ada", lastname: "King Lovelace" });
    expect(splitName(null)).toEqual({});
    expect(contactIdentity(syncLead({ title: null, website: "  " }))).toEqual({ email: "ada@acme.com", firstname: "Ada", lastname: "Lovelace", company: "Acme" });
  });

  test("owned properties: only those that exist in the portal; empty clears", () => {
    const lead = syncLead({ last_outreach_at: "2026-11-01T09:30:00Z", score: null });
    expect(ownedProperties(lead, ALL)).toEqual({
      crusonia_lead_id: "lead_1",
      crusonia_stage: "qualified",
      crusonia_source: "google_search",
      crusonia_fit_score: "",
      crusonia_fit_rationale: "Hiring SDRs. Just raised a Series A.",
      crusonia_last_outreach_at: "2026-11-01T09:30:00.000Z",
    });
    expect(ownedProperties(lead, new Set(["crusonia_stage"]))).toEqual({ crusonia_stage: "qualified" });
    expect(ownedProperties(lead, new Set())).toEqual({});
  });

  test("rationale summary: short text kept, long text cut at a sentence or word", () => {
    expect(summarize("  a\n\nb  ")).toBe("a b");
    const long = `${"Strong ICP fit with a growing sales team. ".repeat(20)}`;
    const s = summarize(long, 100);
    expect(s.length).toBeLessThanOrEqual(100);
    expect(s.endsWith(".")).toBe(true);
    const words = summarize("word ".repeat(100), 50);
    expect(words.length).toBeLessThanOrEqual(50);
    expect(words.endsWith("…")).toBe(true);
  });

  test("create sends everything we know, without blank owned values", () => {
    const desired = { identity: contactIdentity(syncLead()), owned: ownedProperties(syncLead({ score: null }), ALL), leadStatus: "OPEN" };
    const props = planCreate(desired);
    expect(props.email).toBe("ada@acme.com");
    expect(props.hs_lead_status).toBe("OPEN");
    expect("crusonia_fit_score" in props).toBe(false);
  });
});

describe("field ownership on an existing record", () => {
  const desired = (over: Partial<SyncLead> = {}, leadStatus: string | null = "OPEN") => ({
    identity: contactIdentity(syncLead(over)),
    owned: ownedProperties(syncLead(over), ALL),
    leadStatus,
  });

  test("identity fields are only filled where HubSpot is blank, never overwritten", () => {
    const plan = planUpdate({ email: "ada@acme.com", firstname: "Augusta", lastname: "", jobtitle: null, company: "Acme Corp" }, desired(), {});
    expect(plan.properties.firstname).toBeUndefined();
    expect(plan.properties.company).toBeUndefined();
    expect(plan.properties.lastname).toBe("Lovelace");
    expect(plan.properties.jobtitle).toBe("CTO");
  });

  test("Crusonia-owned fields are overwritten when they differ, compared the way HubSpot returns them", () => {
    const current = {
      crusonia_fit_score: "82",
      crusonia_stage: "researching",
      crusonia_lead_id: "lead_1",
      crusonia_source: "google_search",
      crusonia_fit_rationale: "Hiring SDRs. Just raised a Series A.",
      crusonia_last_outreach_at: "2026-11-01T09:30:00Z",
      email: "ada@acme.com",
      firstname: "Ada",
      lastname: "Lovelace",
      jobtitle: "CTO",
      company: "Acme",
      website: "https://acme.com",
      hs_lead_status: "OPEN",
    };
    const plan = planUpdate(current, desired({ last_outreach_at: "2026-11-01T09:30:00.000Z" }), { lead_status: "OPEN" });
    expect(plan.properties).toEqual({ crusonia_stage: "qualified" });
    // Nothing differs -> nothing to write.
    expect(planUpdate({ ...current, crusonia_stage: "qualified" }, desired({ last_outreach_at: "2026-11-01T09:30:00.000Z" }), { lead_status: "OPEN" }).properties).toEqual({});
  });

  test("hs_lead_status: written when blank or still ours; left alone once someone changed it", () => {
    expect(planUpdate({ hs_lead_status: null }, desired({}, "ATTEMPTED_TO_CONTACT"), {})).toMatchObject({
      properties: { hs_lead_status: "ATTEMPTED_TO_CONTACT" },
      leadStatus: "ATTEMPTED_TO_CONTACT",
    });
    expect(planUpdate({ hs_lead_status: "OPEN" }, desired({}, "ATTEMPTED_TO_CONTACT"), { lead_status: "OPEN" }).properties.hs_lead_status).toBe("ATTEMPTED_TO_CONTACT");
    const human = planUpdate({ hs_lead_status: "BAD_TIMING" }, desired({}, "ATTEMPTED_TO_CONTACT"), { lead_status: "OPEN" });
    expect(human.properties.hs_lead_status).toBeUndefined();
    expect(human.leadStatus).toBe("OPEN");
    expect(human.skipped[0]).toContain("BAD_TIMING");
    // A stage with no status (no consent) never touches it.
    expect(planUpdate({ hs_lead_status: "CONNECTED" }, desired({}, null), {}).properties).not.toHaveProperty("hs_lead_status");
  });
});

describe("scope", () => {
  test("qualified scope: consent, qualified, engaged stages, or HubSpot records Crusonia scored", () => {
    const base = { email: "a@x.com", domain: "x.com", consent_at: null, qualified: null, stage: "no_consent", hubspot_id: null, hubspot_company_id: null, score: null };
    expect(inScope(base, "hubspot", "qualified")).toBe(false);
    expect(inScope({ ...base, consent_at: new Date() }, "hubspot", "qualified")).toBe(true);
    expect(inScope({ ...base, qualified: true }, "notion", "qualified")).toBe(true);
    expect(inScope({ ...base, qualified: false, score: 20 }, "notion", "qualified")).toBe(false);
    expect(inScope({ ...base, stage: "sent" }, "notion", "qualified")).toBe(true);
    expect(inScope({ ...base, hubspot_id: "1" }, "hubspot", "qualified")).toBe(false);
    expect(inScope({ ...base, hubspot_id: "1", score: 30 }, "hubspot", "qualified")).toBe(true);
    expect(inScope({ ...base, hubspot_id: "1", score: 30 }, "notion", "qualified")).toBe(false);
    expect(inScope(base, "notion", "all")).toBe(true);
    expect(inScope({ ...base, email: null, domain: null }, "notion", "all")).toBe(false);
    expect(syncScope("ALL")).toBe("all");
    expect(syncScope(undefined)).toBe("qualified");
    expect(syncScope("everything")).toBe("qualified");
  });
});

describe("notes", () => {
  const ev = (id: string, claim: string, url: string, note: string | null = null): EvidenceRow => ({
    id,
    claim,
    source_url: url,
    created_at: `2026-11-0${id}T00:00:00Z`,
    hubspot_note_id: note,
  });

  test("evidence saved twice (same claim and URL, any spacing or case) becomes one note", async () => {
    const plan = await planNotes(
      [ev("1", "Hiring 3 SDRs", "https://acme.com/jobs"), ev("2", "  hiring 3  sdrs ", "HTTPS://acme.com/jobs"), ev("3", "Raised Series A", "https://news.example/acme")],
      [],
    );
    expect(plan.create).toHaveLength(2);
    expect(plan.create[0]!.evidenceIds).toEqual(["1", "2"]);
    expect(plan.create[1]!.evidenceIds).toEqual(["3"]);
    expect(plan.reuse).toEqual([]);
  });

  test("a duplicate of evidence already in HubSpot reuses that note; synced rows are skipped", async () => {
    const plan = await planNotes([ev("1", "Hiring 3 SDRs", "https://acme.com/jobs", "note_9"), ev("2", "Hiring 3 SDRs", "https://acme.com/jobs")], []);
    expect(plan.create).toEqual([]);
    expect(plan.reuse).toEqual([{ ids: ["2"], noteId: "note_9" }]);
  });

  test("each note carries its source URL and a ref marker that parses back", async () => {
    const ref = await evidenceRef("Hiring 3 SDRs", "https://acme.com/jobs");
    const body = evidenceNoteBody({ claim: "Hiring 3 SDRs", source_url: "https://acme.com/jobs" }, ref);
    expect(body).toContain('<a href="https://acme.com/jobs">');
    expect(parseNoteRefs(body)).toEqual([ref]);
    expect(parseNoteRefs("no marker here")).toEqual([]);
  });

  test("untrusted content is escaped; javascript: URLs are not linked", () => {
    const body = evidenceNoteBody({ claim: "<script>alert(1)</script>", source_url: "javascript:alert(1)" }, "ev1");
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
    expect(body).not.toContain("href=");
    const reply = messageNoteBody({ direction: "in", subject: "Re: <b>hi</b>", body: "<img src=x onerror=alert(1)>Yes, let's talk\nThursday?", label: "interested" }, "msg5");
    expect(reply).toContain("Reply received (interested)");
    expect(reply).not.toContain("<img");
    expect(reply).toContain("Yes, let&#39;s talk<br>Thursday?");
    expect(parseNoteRefs(reply)).toEqual(["msg5"]);
  });

  test("sent emails and replies become notes in time order; long bodies are cut", async () => {
    const msgs: MessageRow[] = [
      { id: "7", direction: "out", subject: "Hello", body: "x".repeat(5000), label: null, created_at: "2026-11-03T00:00:00Z", hubspot_note_id: null },
      { id: "8", direction: "in", subject: "Re: Hello", body: "Sure", label: "interested", created_at: "2026-11-04T00:00:00Z", hubspot_note_id: null },
      { id: "9", direction: "out", subject: "Old", body: "done", label: null, created_at: "2026-11-02T00:00:00Z", hubspot_note_id: "n1" },
    ];
    const plan = await planNotes([ev("1", "Claim", "https://a.example")], msgs);
    expect(plan.create.map((n) => n.ref)).toEqual([plan.create[0]!.ref, "msg7", "msg8"]);
    expect(plan.create[1]!.messageId).toBe("7");
    expect(plan.create[1]!.body.length).toBeLessThan(1700);
  });
});

describe("Notion mapping", () => {
  test("one page per lead with every column", () => {
    const props = notionProperties(syncLead({ last_activity_at: "2026-11-07T10:00:00Z" }), "https://crusonia.example/") as Record<string, any>;
    expect(props.Company.title[0].text.content).toBe("Acme");
    expect(props.Contact.rich_text[0].text.content).toBe("Ada Lovelace · CTO");
    expect(props.Email).toEqual({ email: "ada@acme.com" });
    expect(props.Stage).toEqual({ select: { name: "qualified" } });
    expect(props.Fit).toEqual({ number: 82 });
    expect(props.Signal.rich_text[0].text.content).toBe("Hiring 3 SDRs (job post)");
    expect(props["Evidence count"]).toEqual({ number: 2 });
    expect(props["Last activity"]).toEqual({ date: { start: "2026-11-07T10:00:00.000Z" } });
    expect(props.Source.rich_text[0].text.content).toBe("google_search");
    expect(props["Crusonia link"]).toEqual({ url: "https://crusonia.example/app/leads/lead_1" });
    expect(props["Lead ID"].rich_text[0].text.content).toBe("lead_1");
  });

  test("company-only lead: title falls back to the domain; empty values are cleared", () => {
    const props = notionProperties(
      syncLead({ email: null, name: null, title: null, company: null, score: null, signal: null, last_activity_at: null }),
      "https://x.example",
    ) as Record<string, any>;
    expect(props.Company.title[0].text.content).toBe("acme.com");
    expect(props.Contact).toEqual({ rich_text: [] });
    expect(props.Email).toEqual({ email: null });
    expect(props.Fit).toEqual({ number: null });
    expect(props["Last activity"]).toEqual({ date: null });
  });

  test("long text is truncated to Notion's limits", () => {
    const props = notionProperties(syncLead({ signal: "s".repeat(5000) }), "https://x.example") as Record<string, any>;
    expect(props.Signal.rich_text[0].text.content.length).toBeLessThanOrEqual(300);
  });
});

describe("HubSpot import mapping", () => {
  const contact = (props: Record<string, string | null>, id = "51") => ({ id, properties: props, associations: { companies: { results: [{ id: "900" }] } } });
  const at = "2026-11-08T00:00:00.000Z";

  test("consent defaults to none: no mapping, no consent, whatever the contact's properties say", () => {
    expect(consentMapping({})).toBeNull();
    expect(consentMapping({ HUBSPOT_CONSENT_PROPERTY: "  " })).toBeNull();
    const c = contactToCandidate(contact({ email: "Ada@Acme.com", firstname: "Ada", lastname: "L", opted_in: "true", hs_email_optout: "false" }), 1, null, at);
    expect(c.consent).toBeUndefined();
    expect(c).toMatchObject({ email: "ada@acme.com", name: "Ada L", domain: "acme.com", hubspot_id: "51", hubspot_company_id: "900" });
    // The dedupe plan then creates it without consent (stage no_consent).
    const plan = planImport([c], []);
    expect(plan.creates[0]!.consent).toBeUndefined();
  });

  test("an explicitly mapped opt-in property grants consent; opt-out always wins", () => {
    const mapping = consentMapping({ HUBSPOT_CONSENT_PROPERTY: "newsletter_opt_in" });
    expect(contactToCandidate(contact({ email: "a@acme.com", newsletter_opt_in: "Yes" }), 1, mapping, at).consent).toEqual({
      text: "HubSpot import: newsletter_opt_in=Yes",
      at,
    });
    expect(contactToCandidate(contact({ email: "a@acme.com", newsletter_opt_in: "no" }), 1, mapping, at).consent).toBeUndefined();
    expect(contactToCandidate(contact({ email: "a@acme.com", newsletter_opt_in: "true", hs_email_optout: "true" }), 1, mapping, at).consent).toBeUndefined();
    const custom = consentMapping({ HUBSPOT_CONSENT_PROPERTY: "hs_legal_basis", HUBSPOT_CONSENT_VALUES: "Freely given consent from contact" });
    expect(contactToCandidate(contact({ email: "a@acme.com", hs_legal_basis: "Legitimate interest – prospect/lead;Freely given consent from contact" }), 1, custom, at).consent).toBeDefined();
    expect(contactToCandidate(contact({ email: "a@acme.com", hs_legal_basis: "Legitimate interest – prospect/lead" }), 1, custom, at).consent).toBeUndefined();
    // Consent belongs to an address.
    expect(contactToCandidate(contact({ email: null, newsletter_opt_in: "yes", company: "Acme", website: "acme.com" }), 1, mapping, at).consent).toBeUndefined();
  });

  test("companies become company-only leads keyed by domain", () => {
    expect(companyToCandidate({ id: "900", properties: { name: "Acme", domain: "WWW.Acme.com", website: null } }, 3)).toEqual({
      row: 3,
      company: "Acme",
      website: undefined,
      domain: "acme.com",
      hubspot_company_id: "900",
    });
  });

  test("import never overwrites: an existing lead only gets blanks filled", () => {
    const c = contactToCandidate(contact({ email: "ada@acme.com", firstname: "Augusta", jobtitle: "CEO", company: "Acme" }), 1, null, at);
    const plan = planImport([c], [{ id: "lead_1", email: "ada@acme.com", name: "Ada Lovelace", title: null, company: "Acme Inc", domain: "acme.com", website: null, linkedin_url: null, sells: null, best_customers: null, consent_at: null }]);
    expect(plan.updates.get("lead_1")).toEqual({ title: "CEO" });
  });
});
