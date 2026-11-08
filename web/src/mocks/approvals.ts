// /api/approvals mocks. Sample rows follow "Dashboard · Approvals": send approvals bound to a draft, plus one
// tool call and one agent question so every kind renders. Decisions are kept in memory so the queue updates
// after approve / reject / edit / answer (a reload resets them).
import { http } from "msw";
import type { Approval, ApprovalKind, ApprovalListItem, ApprovalStatus } from "../api.ts";
import { ago, ahead, body, fail, HOUR, isEmpty, MIN, ok } from "./util.ts";

/** Approvals expire this long after they are requested (APPROVAL_TTL_MINUTES, default 30). */
const TTL = 30 * MIN;

type Seed = [code: string, leadId: string, name: string, company: string, email: string, variant: "A" | "B", expiresIn: number, subject: string];

// Matches the awaiting_approval leads in ./leads.ts. Real send approvals come from create_draft: they carry no
// Naive session id and an empty payload (the run is found through the lead).
const seeds: Seed[] = [
  ["K3P8", "lead_harbor", "Arjun Patel", "Harbor Labs", "arjun@harborlabs.dev", "A", 9 * MIN, "Outbound after the usage-pricing launch"],
  ["R9D1", "lead_quill", "Sofia Reyes", "Quillstack", "sofia@quillstack.com", "B", 13 * MIN, "Congrats on the Austin office"],
  ["A7F2", "lead_fieldnote", "Maya Chen", "Fieldnote", "maya@fieldnote.io", "B", 24 * MIN, "Your first SDR at Fieldnote"],
  ["M4T6", "lead_bright", "Sam Ortiz", "Brightloop", "sam@brightloop.io", "A", 26 * MIN, "Following up on your sign-up"],
  ["H2W5", "lead_cinder", "Rae Kim", "Cinder Analytics", "rae@cinderanalytics.com", "B", 28 * MIN, "Your outbound tool switch"],
  ["Q8N3", "lead_tess", "Dana Okafor", "Tessellate AI", "dana@tessellate.ai", "A", 29 * MIN, "Scaling the sales team after the Series B"],
];

const fieldnoteBody =
  "Hi Maya,\n\nSaw Fieldnote is hiring its first SDR, a few weeks after the Series A. Congrats on both.\n\nFirst SDRs usually lose their first month building lists instead of selling. Acme hands a new rep a researched, scored territory on day one, so first calls happen in week one.\n\nWould 20 minutes next Tuesday or Wednesday be useful? Happy to send a sample territory for your new hire first.\n\nDaniel";

const sendApprovals: ApprovalListItem[] = seeds.map(([code, leadId, name, company, email, variant, expiresIn, subject]) => ({
  code,
  kind: "send",
  status: "pending",
  summary: `Send v2 to ${email}`,
  recipient: email,
  lead_id: leadId,
  draft_id: `drf_${code.toLowerCase()}`,
  naive_session_id: null,
  tool_call_id: null,
  payload: {},
  answer: null,
  expires_at: ahead(expiresIn),
  decided_at: null,
  decided_via: null,
  // Texted to the owner over iMessage (texted_at, asked of the backend with owner_phone_hint).
  texted_at: code === "R9D1" || code === "M4T6" ? ago(TTL - expiresIn - MIN) : null,
  created_at: ago(TTL - expiresIn),
  draft: {
    id: `drf_${code.toLowerCase()}`,
    version: 2,
    variant,
    subject,
    body:
      code === "A7F2"
        ? fieldnoteBody
        : code === "R9D1"
          ? "Hi Sofia, thanks for joining the Fieldnote waitlist. Saw Quillstack is opening an Austin office with 3 AE roles. When founders hand calls to new reps, the notes are usually the first thing to slip. Fieldnote records each call and writes the next steps into HubSpot, so your new AEs start with your context, not a blank CRM. Want early access for the Austin team?\n\nDaniel, Fieldnote"
          : `Hi ${name.split(" ")[0]},\n\n${subject}.\n\nDaniel`,
    status: "pending_approval",
  },
  lead: { id: leadId, email, name, company, stage: "awaiting_approval", has_consent: true },
}));

// A Naive tool call outside the auto-confirm policy, and an ask_operator question (agent payloads are untrusted data).
const agentApprovals: ApprovalListItem[] = [
  {
    code: "T5K2",
    kind: "tool",
    status: "pending",
    summary: 'Agent wants to run read_website with {"url":"https://juniperfreight.com","max_pages":40}',
    recipient: null,
    lead_id: "lead_juniper",
    draft_id: null,
    naive_session_id: "ses_in3",
    tool_call_id: "call_rw_51",
    payload: { name: "read_website", args: { url: "https://juniperfreight.com", max_pages: 40, include: ["/careers", "/blog", "/about"] } },
    answer: null,
    expires_at: ahead(18 * MIN),
    decided_at: null,
    decided_via: null,
    created_at: ago(TTL - 18 * MIN),
    draft: null,
    lead: { id: "lead_juniper", email: "ana@juniperfreight.com", name: "Ana Ruiz", company: "Juniper Freight", stage: "researching", has_consent: true },
  },
  {
    code: "Q2C7",
    kind: "question",
    status: "pending",
    summary: "Agent asks: Orbit Ledger lists two people who could own outbound. Who should the first email go to?",
    recipient: null,
    lead_id: "lead_orbit",
    draft_id: null,
    naive_session_id: "ses_ob4",
    tool_call_id: "call_ask_7",
    payload: {
      name: "ask_operator",
      question: {
        prompt: "Orbit Ledger lists two people who could own outbound: a new CFO (joined from Ramp) and a Head of Growth. Who should the first email go to, and is there anything it should mention?",
        fields: [
          { key: "contact", label: "Who gets the first email?", options: ["New CFO", "Head of Growth", "Skip this lead"] },
          { key: "note", label: "Anything the draft should mention?" },
        ],
      },
    },
    answer: null,
    expires_at: ahead(21 * MIN),
    decided_at: null,
    decided_via: null,
    created_at: ago(TTL - 21 * MIN),
    draft: null,
    lead: { id: "lead_orbit", email: null, name: null, company: "Orbit Ledger", stage: "researching", has_consent: false },
  },
];

export const sampleApprovals: ApprovalListItem[] = [...sendApprovals, ...agentApprovals];

// Decided earlier: feeds the "approved today · expired" counts on the Approvals screen.
const decided = (code: string, status: ApprovalStatus, decidedAgo: number, kind: ApprovalKind = "send"): ApprovalListItem => ({
  ...sendApprovals[0]!,
  code,
  kind,
  status,
  expires_at: ago(decidedAgo - 10 * MIN),
  created_at: ago(decidedAgo + 5 * MIN),
  decided_at: ago(decidedAgo),
  decided_via: status === "expired" ? "timeout" : "api",
});
const history: ApprovalListItem[] = [
  decided("B6J1", "approved", 25 * MIN),
  decided("C3X8", "approved", 1 * HOUR),
  decided("D9P4", "approved", 2 * HOUR, "tool"),
  decided("E2L7", "approved", 3 * HOUR),
  decided("F5W3", "approved", 4 * HOUR),
  decided("G8N2", "expired", 50 * MIN),
  decided("J4R6", "expired", 2 * HOUR + 30 * MIN),
  decided("L1T9", "rejected", 90 * MIN),
];

// ---------- in-memory decisions ----------

const outcome = new Map<string, { status: ApprovalStatus; answer: string | null }>();
const created: ApprovalListItem[] = [];

function all(): ApprovalListItem[] {
  if (isEmpty()) return [];
  return [...sampleApprovals, ...created, ...history].map((a) => {
    const o = outcome.get(a.code);
    return o ? { ...a, status: o.status, answer: o.answer, decided_at: a.decided_at ?? new Date().toISOString(), decided_via: a.decided_via ?? "api" } : a;
  });
}

/** Pending approvals (also used by the /api/summary mock). */
export const approvalsData = () => all().filter((a) => a.status === "pending");

const find = (code: unknown) => all().find((a) => a.code === String(code).toUpperCase());
const strip = ({ draft: _d, lead: _l, ...a }: ApprovalListItem): Approval => a;
let nextCode = 0;

export const approvalHandlers = [
  http.get("/api/approvals", ({ request }) => {
    const q = new URL(request.url).searchParams;
    const status = q.get("status") ?? "pending";
    const kind = q.get("kind");
    const leadId = q.get("lead_id");
    const data = all()
      .filter((a) => a.status === status && (!kind || a.kind === kind) && (!leadId || a.lead_id === leadId))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return ok({ data });
  }),
  http.get("/api/approvals/:code", ({ params }) => {
    const a = find(params.code);
    return a ? ok({ approval: strip(a) }) : fail(404, "not_found", "Approval not found");
  }),
  // Approving a send would email a real person: the mock only records the decision.
  http.post("/api/approvals/:code/approve", async ({ params, request }) => {
    const a = find(params.code);
    if (!a) return fail(404, "not_found", "Approval not found");
    if (a.status !== "pending") return fail(409, "approval_not_pending", `Approval is ${a.status}`);
    if (a.kind === "question") return fail(409, "wrong_kind", "Questions are answered, not approved: POST /api/approvals/:code/answer");
    const { scope } = await body<{ scope?: string }>(request);
    outcome.set(a.code, { status: "approved", answer: a.kind === "tool" ? JSON.stringify({ decision: "allow", scope }) : null });
    return a.kind === "send" ? ok({ status: "sent", draft_id: a.draft_id, message_id: "msg_mock" }) : ok({ approval: strip(find(a.code)!) });
  }),
  http.post("/api/approvals/:code/reject", async ({ params, request }) => {
    const a = find(params.code);
    if (!a) return fail(404, "not_found", "Approval not found");
    if (a.status !== "pending") return fail(409, "approval_not_pending", `Approval is ${a.status}`);
    if (a.kind === "question") return fail(409, "wrong_kind", "Questions cannot be rejected; answer them with POST /api/approvals/:code/answer");
    const { reason } = await body<{ reason?: string }>(request);
    outcome.set(a.code, { status: "rejected", answer: reason ?? null });
    return ok({ approval: strip(find(a.code)!) });
  }),
  // Edit = a new draft version and a new approval code; the old approval is voided.
  http.post("/api/approvals/:code/edit", async ({ params, request }) => {
    const a = find(params.code);
    if (!a) return fail(404, "not_found", "Approval not found");
    if (a.kind !== "send" || !a.draft) return fail(409, "wrong_kind", `Only send approvals can be edited (this is ${a.kind})`);
    const edit = await body<{ subject?: string; body?: string }>(request);
    const code = `${a.code.slice(0, 2)}X${++nextCode % 10}`;
    const draft = { ...a.draft, id: `${a.draft.id}_v${a.draft.version + 1}`, version: a.draft.version + 1, subject: edit.subject ?? a.draft.subject, body: edit.body ?? a.draft.body };
    const next: ApprovalListItem = {
      ...a,
      code,
      status: "pending",
      draft_id: draft.id,
      summary: `Send v${draft.version} to ${a.recipient ?? "the lead"}`,
      expires_at: ahead(TTL),
      created_at: new Date().toISOString(),
      draft,
    };
    created.push(next);
    outcome.set(a.code, { status: "expired", answer: null });
    return ok({ draft: { ...draft, lead_id: a.lead_id, status: "pending_approval" }, approval: strip(next), superseded_approval_codes: [a.code] }, 201);
  }),
  http.post("/api/approvals/:code/answer", async ({ params, request }) => {
    const a = find(params.code);
    if (!a) return fail(404, "not_found", "Approval not found");
    if (a.status !== "pending") return fail(409, "approval_not_pending", `Approval is ${a.status}`);
    const b = await body<{ decision?: "allow" | "deny"; answers?: Record<string, unknown> }>(request);
    if (a.kind === "send") return fail(409, "wrong_kind", "Send approvals are approved, rejected or edited, not answered");
    if (a.kind === "tool") outcome.set(a.code, { status: b.decision === "allow" ? "approved" : "rejected", answer: JSON.stringify(b) });
    else {
      const fields = ((a.payload?.question as { fields?: { key: string }[] } | undefined)?.fields ?? []).map((f) => f.key);
      const missing = fields.filter((k) => !b.answers?.[k]);
      if (missing.length) return fail(400, "invalid_answers", `answers must have exactly one entry per question field (missing: ${missing.join(", ")})`);
      outcome.set(a.code, { status: "answered", answer: JSON.stringify(b.answers) });
    }
    return ok({ approval: strip(find(a.code)!) });
  }),
];
