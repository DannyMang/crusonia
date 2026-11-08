import { describe, expect, test } from "bun:test";
import { checkSendApproval, type SendCheckInput } from "../src/services/approval-rules.ts";

const now = new Date("2026-11-07T12:00:00Z");
const valid = (): SendCheckInput => ({
  approval: { kind: "send", status: "pending", expires_at: new Date(now.getTime() + 60_000), draft_id: "draft_2", recipient: "ada@acme.com" },
  draft: { id: "draft_2", status: "pending_approval", version: 2 },
  latestVersion: 2,
  lead: { email: "Ada@Acme.com", consent_at: new Date("2026-10-01") },
  suppressed: false,
  paused: false,
  now,
});

const code = (input: SendCheckInput) => {
  const r = checkSendApproval(input);
  return r.ok ? "ok" : `${r.status} ${r.code}`;
};

describe("checkSendApproval", () => {
  test("a pending, unexpired approval for the latest version of an opted-in lead passes", () => {
    expect(code(valid())).toBe("ok");
  });

  test("only send approvals, only once", () => {
    expect(code({ ...valid(), approval: { ...valid().approval, kind: "tool" } })).toBe("409 wrong_kind");
    for (const status of ["approved", "rejected", "expired", "answered"]) {
      expect(code({ ...valid(), approval: { ...valid().approval, status } })).toBe("409 approval_not_pending");
    }
  });

  test("expiry is exclusive: at or after expires_at fails", () => {
    expect(code({ ...valid(), approval: { ...valid().approval, expires_at: now } })).toBe("410 approval_expired");
    expect(code({ ...valid(), approval: { ...valid().approval, expires_at: "2026-11-07T11:59:59Z" } })).toBe("410 approval_expired");
  });

  test("bound to the exact draft version", () => {
    expect(code({ ...valid(), draft: null })).toBe("409 draft_missing");
    expect(code({ ...valid(), draft: { ...valid().draft!, id: "draft_1" } })).toBe("409 draft_missing");
    expect(code({ ...valid(), latestVersion: 3 })).toBe("409 draft_superseded");
    expect(code({ ...valid(), draft: { ...valid().draft!, status: "sending" } })).toBe("409 draft_not_pending");
    expect(code({ ...valid(), draft: { ...valid().draft!, status: "sent" } })).toBe("409 draft_not_pending");
  });

  test("bound to the exact recipient (case-insensitive)", () => {
    expect(code({ ...valid(), lead: { ...valid().lead!, email: "ada@other.com" } })).toBe("409 recipient_mismatch");
    expect(code({ ...valid(), lead: { ...valid().lead!, email: null } })).toBe("409 recipient_mismatch");
    expect(code({ ...valid(), approval: { ...valid().approval, recipient: null } })).toBe("409 recipient_mismatch");
    expect(code({ ...valid(), lead: null })).toBe("409 lead_missing");
  });

  test("consent, suppression and the global pause are checked at send time", () => {
    expect(code({ ...valid(), lead: { ...valid().lead!, consent_at: null } })).toBe("403 no_consent");
    expect(code({ ...valid(), suppressed: true })).toBe("403 suppressed");
    expect(code({ ...valid(), paused: true })).toBe("423 paused");
  });
});
