// /api/approvals mocks. Sample rows follow "Dashboard · Approvals" (send approvals bound to a draft).
import { http } from "msw";
import type { ApprovalListItem } from "../api.ts";
import { ago, ahead, body, fail, HOUR, isEmpty, MIN, ok } from "./util.ts";

type Seed = [code: string, leadId: string, name: string, company: string, email: string, variant: "A" | "B", workflow: string, expiresIn: number, createdAgo: number, subject: string];

const seeds: Seed[] = [
  ["K3P8", "lead_harbor", "Arjun Patel", "Harbor Labs", "arjun@harborlabs.dev", "A", "Lookalikes of closed-won", 9 * MIN, 1 * HOUR, "Outbound after the usage-pricing launch"],
  ["R9D1", "lead_quill", "Sofia Reyes", "Quillstack", "sofia@quillstack.com", "B", "Hiring-signal sweep", 13 * MIN, 58 * MIN, "Congrats on the Austin office"],
  ["A7F2", "lead_fieldnote", "Maya Chen", "Fieldnote", "maya@fieldnote.io", "B", "Hiring-signal sweep", 24 * MIN, 2 * HOUR + 10 * MIN, "Your first SDR at Fieldnote"],
  ["M4T6", "lead_northwind", "Lena Okafor", "Northwind Robotics", "lena@northwindrobotics.com", "A", "Qualify inbound sign-ups", 26 * MIN, 40 * MIN, "Following up on your sign-up"],
  ["H2W5", "lead_lumen", "Tom Becker", "Lumen Health", "tom@lumenhealth.com", "B", "Hiring-signal sweep", 28 * MIN, 30 * MIN, "Your outbound tool switch"],
  ["Q8N3", "lead_tess", "Priya Raman", "Tessellate AI", "priya@tessellate.ai", "A", "Lookalikes of closed-won", 29 * MIN, 12 * MIN, "Scaling the sales team after the Series B"],
];

const fieldnoteBody =
  "Hi Maya,\n\nSaw Fieldnote is hiring its first SDR, a few weeks after the Series A. Congrats on both.\n\nFirst SDRs usually lose their first month building lists instead of selling. Acme hands a new rep a researched, scored territory on day one, so first calls happen in week one.\n\nWould 20 minutes next Tuesday or Wednesday be useful? Happy to send a sample territory for your new hire first.\n\nDaniel";

export const sampleApprovals: ApprovalListItem[] = seeds.map(([code, leadId, name, company, email, variant, workflow, expiresIn, createdAgo, subject]) => ({
  code,
  kind: "send",
  status: "pending",
  summary: `${workflow}: send v2 to ${email}`,
  recipient: email,
  lead_id: leadId,
  draft_id: `drf_${code.toLowerCase()}`,
  naive_session_id: code === "A7F2" ? "ses_8f3k21" : `ses_${code.toLowerCase()}`,
  tool_call_id: null,
  payload: { workflow },
  answer: null,
  expires_at: ahead(expiresIn),
  decided_at: null,
  decided_via: null,
  created_at: ago(createdAgo),
  draft: {
    id: `drf_${code.toLowerCase()}`,
    version: 2,
    variant,
    subject,
    body: code === "A7F2" ? fieldnoteBody : `Hi ${name.split(" ")[0]},\n\n${subject}.\n\nDaniel`,
    status: "pending_approval",
  },
  lead: { id: leadId, email, name, company, stage: "awaiting_approval", has_consent: true },
}));

export const approvalsData = () => (isEmpty() ? [] : sampleApprovals);

export const approvalHandlers = [
  http.get("/api/approvals", ({ request }) => {
    const status = new URL(request.url).searchParams.get("status") ?? "pending";
    return ok({ data: status === "pending" ? approvalsData() : [] });
  }),
  http.get("/api/approvals/:code", ({ params }) => {
    const a = approvalsData().find((x) => x.code === String(params.code).toUpperCase());
    if (!a) return fail(404, "not_found", "Approval not found");
    const { draft: _d, lead: _l, ...approval } = a;
    return ok({ approval });
  }),
  // Approving a send would email a real person: the mock just reports it.
  http.post("/api/approvals/:code/approve", () => ok({ status: "sent", draft_id: "drf_mock", message_id: "msg_mock" })),
  http.post("/api/approvals/:code/reject", async ({ params, request }) => {
    const b = await body<{ reason?: string }>(request);
    return ok({ approval: { code: params.code, status: "rejected", answer: b.reason ?? null } });
  }),
  http.post("/api/approvals/:code/edit", async ({ params, request }) => {
    const b = await body<{ subject?: string; body?: string }>(request);
    return ok({ approval: { code: `${String(params.code).slice(0, 2)}X9`, status: "pending", expires_at: ahead(30 * MIN) }, draft: { version: 3, ...b } }, 201);
  }),
  http.post("/api/approvals/:code/answer", () => ok({ approval: { status: "answered" } })),
];
