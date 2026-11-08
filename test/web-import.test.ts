// CSV parsing and column mapping for the import screen (web/src/lib/csv.ts, web/src/lib/import-mapping.ts).
import { describe, expect, test } from "bun:test";
import { csvColumns, csvRowCount, parseCsv } from "../web/src/lib/csv.ts";
import { assignField, guessMapping, toMapping } from "../web/src/lib/import-mapping.ts";

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
