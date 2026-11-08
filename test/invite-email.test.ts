// The invite email template: whatever a person typed can't become markup, a link or a second header line.
import { describe, expect, test } from "bun:test";
import { escapeHtml, inviteEmail, safeName } from "../src/services/invite-email.ts";

const base = { role: "member" as const, email: "new@acme.com", url: "https://app.example/invite/inv_abc", expiresInDays: 7 };

describe("safeName", () => {
  test("keeps ordinary names and trims them", () => {
    expect(safeName("  Acme   Inc ")).toBe("Acme Inc");
    expect(safeName("Bäckerei Müller & Söhne")).toBe("Bäckerei Müller & Söhne");
  });
  test("anything a mail client could link is dropped, not shown", () => {
    for (const bad of ["http://evil.test", "see www.evil.test now", "evil.io", "Win at evil.co.uk", "me@evil.test", "https://x"]) expect(safeName(bad)).toBeNull();
  });
  test("control, zero-width and bidi characters and newlines are gone; long names are cut", () => {
    expect(safeName("Acme\r\nBcc: victim")).toBe("Acme Bcc: victim");
    const zeroWidth = String.fromCharCode(0x200b);
    const bidi = String.fromCharCode(0x202e);
    expect(safeName(`A${zeroWidth}c${bidi}me`)).toBe("A c me");
    // Hiding a dot behind a zero-width character doesn't sneak a domain through as "evil.test".
    expect(safeName(`evil.${zeroWidth}test`)).toBe("evil. test");
    expect(safeName("x".repeat(200))!.length).toBe(60);
    expect(safeName("   ")).toBeNull();
    expect(safeName(null)).toBeNull();
  });
});

describe("inviteEmail", () => {
  test("it says who asked for it, by their verified address, and that it isn't from the people who run Crusonia", () => {
    const mail = inviteEmail({ ...base, workspaceName: "Acme", inviterName: "Dan", inviterEmail: "dan@acme.com" });
    expect(mail.text).toContain("Dan (dan@acme.com) invited you to join Acme on Crusonia as a member.");
    expect(mail.html).toContain("Dan (dan@acme.com) invited you");
    for (const part of [mail.text, mail.html]) expect(part).toContain("The people who run Crusonia");
    // The address is shown, never linked: the one link is still the invite.
    expect([...mail.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual([base.url]);
  });

  test("the address can't carry markup or a second line", () => {
    const mail = inviteEmail({ ...base, workspaceName: "Acme", inviterName: "Dan", inviterEmail: "<b>dan@acme.com\r\nBcc: x" });
    expect(mail.html).not.toContain("<b>dan");
    expect(mail.text).not.toMatch(/acme\.com\s*\r?\nBcc/);
  });

  test("names are escaped in the HTML part, and only the one link goes anywhere", () => {
    const mail = inviteEmail({ ...base, workspaceName: `<img src=x onerror=alert(1)> & "co"`, inviterName: "<b>Dan</b>" });
    expect(mail.html).not.toContain("<img");
    expect(mail.html).not.toContain("<b>Dan");
    expect(mail.html).toContain("&lt;b&gt;Dan&lt;/b&gt;");
    expect(mail.html).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;co&quot;");
    expect([...mail.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual([base.url]);
    expect(mail.text).toContain(base.url);
  });

  test("a link in a name never reaches the email: the template says something generic", () => {
    const mail = inviteEmail({ ...base, workspaceName: "Claim your prize at evil.test", inviterName: "http://evil.test" });
    for (const part of [mail.subject, mail.text, mail.html]) expect(part).not.toContain("evil.test");
    expect(mail.subject).toBe("A teammate invited you to a Crusonia workspace");
    expect(mail.text).toContain("A teammate invited you to join a Crusonia workspace as a member.");
  });

  test("the subject is one line, and the email says who it works for and when it ends", () => {
    const mail = inviteEmail({ ...base, role: "admin", workspaceName: "Acme\nBcc: x", inviterName: "Dan\r\nX: y" });
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.subject).toBe("Dan X: y invited you to Acme Bcc: x on Crusonia");
    expect(mail.text).toContain("as an admin");
    expect(mail.text).toContain("expires in 7 days");
    expect(mail.text).toContain("only works for new@acme.com");
  });

  test("escapeHtml covers the characters that open an attribute or a tag", () => {
    expect(escapeHtml(`<a href="x" title='y'>&`)).toBe("&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;");
  });
});
