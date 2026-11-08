import { describe, expect, test } from "bun:test";
import { CsvError, mapHeaders, parseCsv, planImport, toCandidates, type ExistingLead } from "../src/services/csv.ts";

describe("parseCsv", () => {
  test("quotes, escaped quotes, embedded commas and newlines, CRLF, BOM, blank lines", () => {
    const text = '﻿name,email,note\r\n"Lovelace, Ada",ada@x.com,"said ""hi""\nthen left"\r\n\r\nBob,bob@y.com,\n';
    expect(parseCsv(text)).toEqual([
      ["name", "email", "note"],
      ["Lovelace, Ada", "ada@x.com", 'said "hi"\nthen left'],
      ["Bob", "bob@y.com", ""],
    ]);
  });

  test("detects semicolon and tab delimiters", () => {
    expect(parseCsv("email;name\na@x.com;A")).toEqual([["email", "name"], ["a@x.com", "A"]]);
    expect(parseCsv("email\tname\na@x.com\tA")).toEqual([["email", "name"], ["a@x.com", "A"]]);
  });

  test("throws on an unterminated quote with its line", () => {
    expect(() => parseCsv('email\n"a@x.com')).toThrow(CsvError);
    expect(() => parseCsv('email\n"a@x.com')).toThrow("line 2");
  });
});

describe("mapHeaders", () => {
  test("matches common aliases case- and punctuation-insensitively", () => {
    const map = mapHeaders(["Work Email", "First Name", "Last Name", "Company Name", "Website", "Opted In", "Consent Date", "Job Title"]);
    expect(map).toEqual({ email: 0, first_name: 1, last_name: 2, company: 3, website: 4, consent: 5, consent_at: 6, title: 7 });
  });

  test("explicit mapping wins and must name an existing column", () => {
    expect(mapHeaders(["Primary", "Email"], { email: "primary" }).email).toBe(0);
    expect(() => mapHeaders(["Email"], { email: "Mail Address" })).toThrow(CsvError);
  });
});

describe("toCandidates", () => {
  const at = "2026-11-07T12:00:00.000Z";
  const rows = (lines: string) => parseCsv(lines);

  test("normalises email, joins first + last name, derives domain", () => {
    const r = rows("email,first name,last name,website\n Ada@Acme.COM ,Ada,Lovelace,https://www.acme.com/about");
    const [c] = toCandidates(r, mapHeaders(r[0]!), at);
    expect(c).toMatchObject({ row: 2, email: "ada@acme.com", name: "Ada Lovelace", domain: "acme.com" });
    expect(c!.consent).toBeUndefined();
  });

  test("domain falls back to a work email, never a freemail one", () => {
    const r = rows("email\nbob@initech.io\nbob@gmail.com");
    const [a, b] = toCandidates(r, mapHeaders(r[0]!), at);
    expect(a!.domain).toBe("initech.io");
    expect(b!.domain).toBeUndefined();
  });

  test("consent column: truthy values grant, others do not; text and date are kept", () => {
    const r = rows("email,consent,consent text,consent date\na@x.com,Yes,Waitlist form,2026-10-01\nb@x.com,no,,\nc@x.com,TRUE,,");
    const [a, b, c] = toCandidates(r, mapHeaders(r[0]!), at);
    expect(a!.consent).toEqual({ text: "Waitlist form", at: "2026-10-01T00:00:00.000Z" });
    expect(b!.consent).toBeUndefined();
    expect(c!.consent).toEqual({ text: "CSV import: consent=TRUE", at });
  });

  test("without a consent column, consent text alone grants; no email means no consent", () => {
    const r = rows("email,consent source,website\na@x.com,Signed up at the meetup,\n,Signed up,acme.com");
    const [a, b] = toCandidates(r, mapHeaders(r[0]!), at);
    expect(a!.consent?.text).toBe("Signed up at the meetup");
    expect(b!.consent).toBeUndefined();
  });

  test("keeps the raw value of an invalid email so it can be reported", () => {
    const r = rows("email\nnot-an-email");
    const [c] = toCandidates(r, mapHeaders(r[0]!), at);
    expect(c).toMatchObject({ email: undefined, rawEmail: "not-an-email" });
  });
});

describe("planImport (dedupe by email, then company domain + name)", () => {
  const at = "2026-11-07T12:00:00.000Z";
  const lead = (over: Partial<ExistingLead>): ExistingLead => ({
    id: "lead_x", email: null, name: null, title: null, company: null, domain: null, website: null,
    linkedin_url: null, sells: null, best_customers: null, consent_at: null, ...over,
  });
  const plan = (csv: string, existing: ExistingLead[] = [], suppressed: string[] = []) => {
    const r = parseCsv(csv);
    return planImport(toCandidates(r, mapHeaders(r[0]!), at), existing, new Set(suppressed));
  };

  test("creates new emails, skips in-file duplicates (case-insensitive) and invalid emails", () => {
    const p = plan("email,name\na@x.com,A\nA@X.com,A again\nbad,B\nc@y.com,C");
    expect(p.rows.map((r) => r.status)).toEqual(["created", "skipped", "skipped", "created"]);
    expect(p.rows[1]).toMatchObject({ reason: "duplicate_in_file" });
    expect(p.rows[2]).toMatchObject({ reason: "invalid_email" });
    expect(p.creates.map((c) => c.email)).toEqual(["a@x.com", "c@y.com"]);
  });

  test("an existing email is updated by filling blanks only, and granted consent", () => {
    const existing = [lead({ id: "lead_a", email: "a@acmeco.dev", name: "Ada (edited)", company: null })];
    const p = plan("email,name,company,consent\na@acmeco.dev,Ada,Acme,yes", existing);
    expect(p.rows[0]).toMatchObject({ status: "updated", lead_id: "lead_a", matched_by: "email", fields: ["company", "domain", "consent"] });
    expect(p.updates.get("lead_a")).toMatchObject({ company: "Acme", consent_text: "CSV import: consent=yes", consent_at: at });
    expect(p.updates.get("lead_a")!.name).toBeUndefined();
  });

  test("an existing lead with nothing new is reported as unchanged", () => {
    const existing = [lead({ id: "lead_a", email: "a@acmeco.dev", name: "Ada", domain: "acmeco.dev", consent_at: new Date() })];
    expect(plan("email,name,consent\na@acmeco.dev,Ada,yes", existing).rows[0]).toMatchObject({ status: "skipped", reason: "unchanged" });
  });

  test("a row with an email attaches it to the email-less lead with the same domain and name", () => {
    const existing = [lead({ id: "lead_c", domain: "acme.com", name: "Ada Lovelace" })];
    const p = plan("email,name\nada@acme.com,ada lovelace", existing);
    expect(p.rows[0]).toMatchObject({ status: "updated", lead_id: "lead_c", matched_by: "domain" });
    expect(p.updates.get("lead_c")!.email).toBe("ada@acme.com");
    expect(p.creates).toHaveLength(0);
  });

  test("rows without email dedupe on domain + name, create otherwise, and need a domain", () => {
    const existing = [lead({ id: "lead_co", domain: "acme.com", name: null }), lead({ id: "lead_p", domain: "acme.com", name: "Bob" })];
    const p = plan("name,company,website\n,Acme Inc,acme.com\nbob,,https://acme.com\nCarol,,acme.com\nDan,Nowhere,", existing);
    expect(p.rows[0]).toMatchObject({ status: "updated", lead_id: "lead_co", fields: ["company", "website"] });
    expect(p.rows[1]).toMatchObject({ status: "updated", lead_id: "lead_p", fields: ["website"] });
    expect(p.rows[2]).toMatchObject({ status: "created", key: "d:acme.com|carol" });
    expect(p.rows[3]).toMatchObject({ status: "skipped", reason: "missing_email_and_domain" });
  });

  test("suppressed addresses are never created, but existing leads still get blanks filled", () => {
    const existing = [lead({ id: "lead_s", email: "s@x.com" })];
    const p = plan("email,company\nnew@x.com,X\ns@x.com,X", existing, ["new@x.com", "s@x.com"]);
    expect(p.rows[0]).toMatchObject({ status: "skipped", reason: "suppressed" });
    expect(p.rows[1]).toMatchObject({ status: "updated", lead_id: "lead_s" });
  });
});
