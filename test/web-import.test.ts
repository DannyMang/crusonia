// CSV parsing and column mapping for the import screen (web/src/lib/csv.ts, web/src/lib/import-mapping.ts).
import { describe, expect, test } from "bun:test";
import { csvColumns, csvRowCount, parseCsv } from "../web/src/lib/csv.ts";
import { assignField, guessMapping, IMPORT_FIELDS, importFields, toMapping } from "../web/src/lib/import-mapping.ts";

describe("parseCsv", () => {
  test("quotes, escaped quotes, CRLF and blank lines", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n\r\n1,2')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["1", "2"],
    ]);
  });
  test("header and row count", () => {
    const csv = "﻿Email address , Name\nme@x.io,Me\nyou@x.io,You\n";
    expect(csvColumns(csv)).toEqual(["Email address", "Name"]);
    expect(csvRowCount(csv)).toBe(2);
  });
});

describe("consent columns are for owners and admins", () => {
  test("a member doesn't get the consent fields, and a guess on a consent column isn't sent", () => {
    expect(importFields(true)).toEqual(IMPORT_FIELDS);
    expect(importFields(false)).not.toContain("consent");
    expect(importFields(false)).not.toContain("consent_at");
    const map = guessMapping(["Email", "Opted in", "Opt-in date"]);
    expect(toMapping(map)).toEqual({ email: "Email", consent: "Opted in", consent_at: "Opt-in date" });
    expect(toMapping(map, importFields(false))).toEqual({ email: "Email" });
  });
});

describe("guessMapping", () => {
  test("the Paper example columns", () => {
    expect(guessMapping(["Email address", "Full name", "Company", "Website", "Job title", "Opted in", "Opt-in date", "Badge ID"])).toEqual({
      "Email address": "email",
      "Full name": "name",
      Company: "company",
      Website: "domain",
      "Job title": "title",
      "Opted in": "consent",
      "Opt-in date": "consent_at",
      "Badge ID": "",
    });
  });
  test("each field goes to one column", () => {
    expect(guessMapping(["Email", "Work email"])).toEqual({ Email: "email", "Work email": "" });
  });
  test("assigning a field moves it off the other column", () => {
    const m = assignField({ A: "email", B: "" }, "B", "email");
    expect(m).toEqual({ A: "", B: "email" });
    expect(toMapping(m)).toEqual({ email: "B" });
  });
});
