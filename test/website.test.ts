// The website parser shared by the landing form, the sign-up hand-off and onboarding step 1 (reading a website
// starts a paid crawl), plus the server's own guard in normalizeUrl.
import { describe, expect, test } from "bun:test";
import { normalizeUrl } from "../src/services/web.ts";
import { cleanWebsite, parseWebsite, signUpTarget, websiteProblemMessage } from "../web/src/lib/website.ts";

describe("parseWebsite", () => {
  test.each([
    ["acme.com", "acme.com"],
    ["  acme.com  ", "acme.com"],
    ["Acme.COM", "acme.com"],
    ["www.acme.com", "acme.com"],
    ["WWW.Acme.com", "acme.com"],
    ["https://www.Acme.com/about/", "acme.com"],
    ["http://acme.com/pricing?ref=x#top", "acme.com"],
    ["acme.com/about?utm=1", "acme.com"],
    ["acme.com.", "acme.com"],
    ["acme.co.uk/", "acme.co.uk"],
    ["app.acme.io", "app.acme.io"],
    ["my-company.dev", "my-company.dev"],
    ["123.agency", "123.agency"],
    ["bücher.de", "xn--bcher-kva.de"],
    ["пример.рф", "xn--e1afmkfd.xn--p1ai"],
  ])("%p -> %p", (raw, domain) => {
    expect(parseWebsite(raw)).toEqual({ ok: true, domain });
    expect(cleanWebsite(raw)).toBe(domain);
  });

  test.each([
    ["dan@gmail.com", "email"],
    ["https://dan@gmail.com", "email"],
    ["mailto:dan@gmail.com", "email"],
    ["foo@bar", "email"],
    ["hello world", "spaces"],
    ["ex ample.com", "spaces"],
    ["acme .com", "spaces"],
    ["", "empty"],
    ["   ", "empty"],
  ] as const)("%p is rejected (%s)", (raw, problem) => {
    expect(parseWebsite(raw)).toEqual({ ok: false, problem });
    expect(cleanWebsite(raw)).toBeNull();
  });

  test.each([
    "notadomain",
    "localhost",
    "http://localhost:3000",
    "Example.com:8080/x?y=1",
    "javascript:alert(1)",
    "!!!",
    "acme.c",
    "acme.123",
    "192.168.0.1",
    "http://[::1]/",
    "-acme.com",
    "acme-.com",
    "acme..com",
    "under_score.com",
    ".com",
    "https://",
    `${"a".repeat(64)}.com`,
    `${"abcdefghij.".repeat(25)}com`,
  ])("%p is not a website", (raw) => {
    expect(parseWebsite(raw)).toEqual({ ok: false, problem: "invalid" });
  });

  test("null and undefined are empty", () => {
    expect(parseWebsite(null)).toEqual({ ok: false, problem: "empty" });
    expect(parseWebsite(undefined)).toEqual({ ok: false, problem: "empty" });
  });

  test("every problem has a message that shows an example", () => {
    for (const p of ["empty", "email", "spaces", "invalid"] as const) expect(websiteProblemMessage(p)).toContain("acme.com");
    expect(websiteProblemMessage("email")).toContain("email address");
  });
});

describe("landing form target", () => {
  test("a website goes to sign-up with the clean domain", () => {
    expect(signUpTarget("https://www.Example.com/about")).toEqual({ href: "/sign-up?website=example.com" });
  });
  test("empty is plain sign-up (no website yet)", () => {
    expect(signUpTarget("  ")).toEqual({ href: "/sign-up" });
  });
  test("junk is an inline error, not a trimmed domain", () => {
    for (const raw of ["dan@gmail.com", "hello world", "notadomain", "javascript:alert(1)", "Example.com:8080"]) {
      expect(signUpTarget(raw)).toHaveProperty("error");
    }
  });
});

describe("server normalizeUrl", () => {
  test("refuses an email address typed as a URL", () => {
    expect(() => normalizeUrl("https://dan@gmail.com")).toThrow(/email address/);
    expect(() => normalizeUrl("dan@gmail.com")).toThrow(/email address/);
    expect(() => normalizeUrl("https://user:pass@acme.com")).toThrow(/email address/);
  });
  test("still accepts a plain website", () => {
    expect(normalizeUrl("acme.com").hostname).toBe("acme.com");
    expect(normalizeUrl("https://acme.com/about").pathname).toBe("/about");
  });
});
