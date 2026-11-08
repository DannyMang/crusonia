// The demo backend against a real Postgres (a Neon dev branch, never production), Naive and AgentMail mocked at fetch.
// Skipped unless TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL=<dev branch url> bun test test/demo-backend.integration.test.ts
// Covers the CSV import preview/commit (mapping, duplicates, invalid rows, consent, cohort), versioned workflow
// definitions (REST), a run pinning a version (variant, cohort, the agent's brief, the evidence gate), run history
// counts per variant, and follow-ups (scheduled on approval, cancelled by a real reply, never by a delivery event).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getSql, type Sql } from "../src/db.ts";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";
import type { FetchFn } from "../src/providers/http.ts";
import { createLead } from "../src/services/crm.ts";
import { createDraft } from "../src/services/drafts.ts";
import { createFollowUp, sendDueFollowUps } from "../src/services/followups.ts";
import { handleAgentMailEvent } from "../src/services/inbound.ts";
import { saveResearch } from "../src/services/leads.ts";
import { approveAndSend } from "../src/services/send.ts";
import { OWNER_WORKSPACE_ID } from "../src/services/workflow-defs.ts";
import { listRuns, runWorkflow } from "../src/services/workflow-runs.ts";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const run = crypto.randomUUID().slice(0, 8);
const mail = (name: string) => `${name}@itdemo-${run}.dev`;
const domain = (name: string) => `${name}-${run}-itdemo.dev`;
const cohort = `IT demo ${run}`;
const token = `it-demo-${run}`;
const env: Env = {
  PUBLIC_URL: "https://example.test",
  DATABASE_URL: url,
  MCP_TOKEN: token,
  NAIVE_API_KEY: "nv_test",
  NAIVE_AGENT_ID: "agt_test",
  AGENTMAIL_API_KEY: "am_test",
  AGENTMAIL_INBOX_ID: "crusonia@agentmail.to",
};
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
let sql: Sql;

type Call = { method: string; url: string; body: any };
function provider(route: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  const fn: FetchFn = async (u, init = {}) => {
    const call = { method: init.method ?? "GET", url: u, body: init.body ? JSON.parse(init.body as string) : undefined };
    calls.push(call);
    return route(call) ?? new Response(JSON.stringify({ error: "unmocked" }), { status: 404 });
  };
  return { fn, calls };
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await worker.fetch(
    new Request(`https://example.test${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx,
  );
  return { status: res.status, json: await res.json() };
}

const CSV = [
  "Full name,Work email,Company,Website,Role,Opted in,Opt-in date,Campaign",
  `Ada Demo,${mail("ada")},Ada Co,https://www.${domain("ada")}/about,CEO,yes,2026-11-01,Webinar`,
  `Old Person,${mail("old")},Old Co,${domain("old")},CTO,no,,`,
  "Bad Email,not-an-email,Bad Co,,,yes,,",
  `,,Company Only,${domain("company")},,,,`,
  `Ada Again,${mail("ada").toUpperCase()},Ada Co,,,,,`,
].join("\n");
const MAPPING = {
  name: "Full name",
  email: "Work email",
  company: "Company",
  domain: "Website",
  title: "Role",
  consent: "Opted in",
  consent_at: "Opt-in date",
  source: "Campaign",
};

suite("demo backend (database, mocked Naive and AgentMail)", () => {
  let workflowId = "";
  let adaId = "";
  let companyId = "";
  let runId = "";

  beforeAll(() => {
    sql = getSql(url);
  });

  afterAll(async () => {
    if (!sql) return;
    const ids = (await sql`select id from leads where cohort = ${cohort} or email like ${`%@itdemo-${run}.dev`} or domain like ${`%-${run}-itdemo.dev`}`).map(
      (r) => r.id as string,
    );
    await sql.transaction([
      sql`delete from events where lead_id = any(${ids}::text[]) or data->>'cohort' = ${cohort} or data->>'workflow_id' in (select id from workflow_defs where name like ${`IT demo ${run}%`})`,
      sql`delete from workflow_defs where name like ${`IT demo ${run}%`}`,
      sql`delete from messages where lead_id = any(${ids}::text[]) or thread_id like ${`thr_itdemo_${run}%`}`,
      sql`delete from leads where id = any(${ids}::text[])`,
      sql`delete from naive_sessions where id like ${`ses_itdemo_${run}%`}`,
      sql`delete from webhook_events where event_id like ${`%itdemo_${run}%`}`,
    ]);
  });

  test("import preview: mapped rows, duplicates by email and in-file, invalid rows, consent per row; commit records the cohort", async () => {
    const old = await createLead(sql, { email: mail("old"), name: "Old Person", source: "it_demo" }, "test");
    const body = { csv: CSV, mapping: MAPPING, source: cohort, file_name: "demo.csv" };
    const { status, json: preview } = await api("POST", "/api/import/preview", body);
    expect(status).toBe(200);
    expect(preview.columns).toEqual(["Full name", "Work email", "Company", "Website", "Role", "Opted in", "Opt-in date", "Campaign"]);
    expect(preview.counts).toEqual({ new: 2, duplicate: 2, invalid: 1 });
    const [ada, oldRow, bad, company, again] = preview.rows;
    expect(ada).toMatchObject({
      row: 2,
      status: "new",
      email: mail("ada"),
      domain: domain("ada"),
      title: "CEO",
      consent: true,
      consent_at: "2026-11-01T00:00:00.000Z",
      source: "Webinar",
    });
    expect(oldRow).toMatchObject({ status: "duplicate", lead_id: old.id, consent: false, reason: "matches an existing lead by email" });
    expect(oldRow.existing_since).toBeTruthy();
    expect(bad).toMatchObject({ status: "invalid", reason: "email not valid" });
    expect(company).toMatchObject({ status: "new", email: null, domain: domain("company"), consent: false, source: cohort });
    expect(again).toMatchObject({ status: "duplicate", reason: "duplicate of an earlier row in this file" });
    // A preview writes nothing.
    expect((await sql`select count(*)::int as n from leads where cohort = ${cohort}`)[0]!.n).toBe(0);

    const { json: committed } = await api("POST", "/api/import/commit", body);
    expect(committed).toMatchObject({ created: 2, updated: 1, skipped: 2, cohort });
    const leads = await sql`select id, email, domain, stage, cohort, source, consent_text, consent_at, import_meta from leads where cohort = ${cohort} order by email nulls last`;
    expect(leads).toHaveLength(2);
    const [a, c] = leads;
    adaId = a!.id as string;
    companyId = c!.id as string;
    expect(a).toMatchObject({ email: mail("ada"), stage: "new", source: cohort, import_meta: { file: "demo.csv", row: 2, source: "Webinar" } });
    expect(String(a!.consent_text)).toContain("demo.csv, row 2");
    expect(new Date(a!.consent_at as string).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(c).toMatchObject({ email: null, domain: domain("company"), stage: "no_consent", consent_text: null });
    // The existing lead keeps its cohort; blank fields were filled, consent was not granted ("no").
    expect((await sql`select title, consent_at, cohort from leads where id = ${old.id}`)[0]).toMatchObject({ title: "CTO", consent_at: null });

    const again2 = (await api("POST", "/api/import/preview", body)).json;
    expect(again2.rows[0]).toMatchObject({ status: "duplicate", lead_id: adaId });
    expect(again2.counts.new).toBe(0);
  });

  test("workflow definitions: create (agent source), immutable versions, patch, validation", async () => {
    const created = await api("POST", "/api/workflow-definitions", {
      name: `IT demo ${run} qualification`,
      research_questions: ["Who runs outbound today?"],
      evidence_required: ["A dated hiring signal with a source URL"],
      done_when: "Every required evidence item has a source URL",
      variants: [
        { key: "A", label: "Hiring angle", angle: "Lead with the hiring signal" },
        { key: "B", label: "Cost angle", angle: "Lead with what a tool stack costs" },
      ],
    });
    expect(created.status).toBe(201);
    workflowId = created.json.workflow.id;
    expect(created.json.workflow).toMatchObject({ source: "claude_code", enabled: true, latest_version: 1, status: "done", last_run: null });
    expect(created.json.version).toMatchObject({
      version: 1,
      icp: { source: "company_summary" },
      research_questions: ["Who runs outbound today?"],
      evidence_required: ["A dated hiring signal with a source URL"],
    });
    expect(created.json.version.steps.map((s: { kind: string }) => s.kind)).toContain("research");

    const v2 = await api("POST", `/api/workflow-definitions/${workflowId}/versions`, {
      label: "Stricter",
      research_questions: ["Who runs outbound today?"],
      evidence_required: ["A dated hiring signal with a source URL", "Their current outbound tool"],
      done_when: "",
    });
    expect(v2.status).toBe(201);
    expect(v2.json.version).toMatchObject({ version: 2, label: "Stricter" });
    const got = (await api("GET", `/api/workflow-definitions/${workflowId}`)).json;
    expect(got.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(got.workflow.latest_version).toBe(2);
    // Versions are immutable in the database too.
    const err = await sql`update workflow_def_versions set label = 'x' where workflow_id = ${workflowId}`.then(() => null, (e: Error) => e);
    expect(err?.message).toContain("immutable");

    const bad = await api("POST", "/api/workflow-definitions", {
      name: `IT demo ${run} bad`,
      steps: [{ id: "a", kind: "research", title: "Research", next: ["nowhere"] }],
    });
    expect(bad.status).toBe(400);

    const off = (await api("PATCH", `/api/workflow-definitions/${workflowId}`, { enabled: false, cap_usd: 3 })).json;
    expect(off.workflow).toMatchObject({ enabled: false, status: "off", spend: { cap_usd: 3, period: "week" } });
    await api("PATCH", `/api/workflow-definitions/${workflowId}`, { enabled: true });
    expect((await api("GET", "/api/workflow-definitions")).json.data.some((d: { id: string }) => d.id === workflowId)).toBe(true);
  });

  test("a run pins version 1: variant, cohort and run on leads, sessions and drafts; the brief and the evidence gate follow it", async () => {
    let n = 0;
    const nv = provider((c) => (c.url.endsWith("/v1/sessions") ? Response.json({ id: `ses_itdemo_${run}_${++n}`, status: "running" }) : undefined));
    const out = await runWorkflow(sql, env, OWNER_WORKSPACE_ID, workflowId, { version: 1, cohort }, "test", { fetch: nv.fn });
    runId = out.run.id;
    expect(out.started).toHaveLength(2);
    expect(out.run).toMatchObject({ version: 1, cohort });

    const leads = await sql`select id, variant, workflow_id, workflow_version, workflow_run_id from leads where id = any(${[adaId, companyId]}::text[])`;
    for (const l of leads) expect(l).toMatchObject({ workflow_id: workflowId, workflow_version: 1, workflow_run_id: runId });
    const ada = leads.find((l) => l.id === adaId)!;
    const rows = await sql`select lead_id, variant, cohort, status, session_id from workflow_run_leads where run_id = ${runId}`;
    expect(rows.find((r) => r.lead_id === adaId)).toMatchObject({ variant: ada.variant, cohort, status: "started" });
    const sessions = await sql`select id, workflow_run_id, workflow_def_version, cohort from naive_sessions where workflow_run_id = ${runId}`;
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ workflow_def_version: 1, cohort });

    // The first message carries version 1 (one requirement, not v2's two) and the lead's variant angle.
    const message = nv.calls.find((c) => c.body?.metadata?.lead_id === adaId)!.body.message as string;
    expect(message).toContain("[e1] (required) A dated hiring signal with a source URL");
    expect(message).not.toContain("Their current outbound tool");
    expect(message).toContain(ada.variant === "A" ? "Lead with the hiring signal" : "Lead with what a tool stack costs");
    await sql`update naive_sessions set status = 'done' where workflow_run_id = ${runId}`;

    // Missing the run version's required evidence: paused for review, no score.
    const paused = await saveResearch(sql, {
      lead_id: adaId,
      evidence: [{ claim: "Uses a CRM", source_url: `https://${domain("ada")}/stack` }],
      score: 80,
      qualified: true,
      rationale: "Fits.",
      contacts: [],
      links: [],
    });
    expect(paused).toMatchObject({ needs_review: true, lead: { stage: "needs_review" } });
    const history = await listRuns(sql, OWNER_WORKSPACE_ID, workflowId);
    expect(history.needs_review.map((r) => r.lead_id)).toContain(adaId);

    const done = await saveResearch(sql, {
      lead_id: adaId,
      evidence: [{ claim: "Posted an SDR job on 2026-10-30", source_url: `https://${domain("ada")}/careers`, requirement: "e1" }],
      score: 82,
      qualified: true,
      rationale: "Hiring an SDR.",
      contacts: [],
      links: [],
    });
    expect(done).toMatchObject({ lead: { stage: "qualified" } });

    const draft = await createDraft(
      sql,
      { lead_id: adaId, subject: "Your SDR hire", body: "Saw the SDR role.", citations: [{ text: "SDR role", source_url: `https://${domain("ada")}/careers` }] },
      { ttlMinutes: 60, via: "test" },
    );
    const [stored] = await sql`select workflow_run_id, workflow_id, workflow_def_version, cohort, variant from drafts where id = ${draft.draft.id}`;
    expect(stored).toMatchObject({ workflow_run_id: runId, workflow_id: workflowId, workflow_def_version: 1, cohort, variant: ada.variant });
  });

  test("follow-ups: approving one early schedules it, delivered is not a reply, a real reply cancels it; history counts per variant", async () => {
    let sends = 0;
    const am = provider((c) =>
      c.url.endsWith("/messages/send") ? Response.json({ message_id: `<m${++sends}-itdemo_${run}@agentmail.to>`, thread_id: `thr_itdemo_${run}_${sends}` }) : undefined,
    );
    const [approval] = await sql`select code from approvals where lead_id = ${adaId} and kind = 'send' and status = 'pending'`;
    const sent = await approveAndSend({ sql, env, fetch: am.fn, actor: "test" }, approval!.code as string);
    expect(sent.status).toBe("sent");

    const follow = await createFollowUp(sql, OWNER_WORKSPACE_ID, adaId, { body: "Following up on the SDR role.", send_after_days: 3 }, { ttlMinutes: 60, actor: "test" });
    expect(follow.draft).toMatchObject({ status: "pending_approval", subject: "Re: Your SDR hire" });
    const scheduled = await approveAndSend({ sql, env, fetch: am.fn, actor: "test" }, follow.approval.code as string);
    expect(scheduled.status).toBe("scheduled");
    expect(sends).toBe(1); // nothing sent yet
    expect((await sql`select status from drafts where id = ${follow.draft.id}`)[0]!.status).toBe("scheduled");

    // A delivery event is not a reply.
    const msgId = (sent as { message_id: string }).message_id;
    await handleAgentMailEvent(sql, { event_id: `ev_itdemo_${run}_d`, event_type: "message.delivered", delivery: { message_id: msgId, recipients: [mail("ada")] } });
    expect((await sql`select stage from leads where id = ${adaId}`)[0]!.stage).toBe("sent");
    expect((await sql`select status from drafts where id = ${follow.draft.id}`)[0]!.status).toBe("scheduled");

    // A real inbound reply cancels the scheduled follow-up and moves the lead out of 'sent'.
    const reply = await handleAgentMailEvent(sql, {
      event_id: `ev_itdemo_${run}_r`,
      event_type: "message.received",
      message: {
        thread_id: `thr_itdemo_${run}_1`,
        message_id: `<r1-itdemo_${run}@itdemo.dev>`,
        from: `Ada Demo <${mail("ada")}>`,
        to: ["crusonia@agentmail.to"],
        subject: "Re: Your SDR hire",
        text: "Thanks, this is interesting. Can we talk next week?",
      },
    });
    expect(reply).toMatchObject({ handled: true, detail: { lead_id: adaId, matched_by: "thread" } });
    expect(["replied", "interested"]).toContain((await sql`select stage from leads where id = ${adaId}`)[0]!.stage as string);
    expect((await sql`select status from drafts where id = ${follow.draft.id}`)[0]!.status).toBe("cancelled");
    await sql`update drafts set scheduled_for = now() - interval '1 minute' where id = ${follow.draft.id}`;
    expect((await sendDueFollowUps(sql, env, am.fn)).sent).toBe(0);
    expect(sends).toBe(1);

    const history = await listRuns(sql, OWNER_WORKSPACE_ID, workflowId);
    const runRow = history.runs.find((r) => r.id === runId)!;
    expect(runRow.counts).toMatchObject({ found: 2, qualified: 1, drafted: 1, sent: 1 });
    expect(runRow.session_ids).toHaveLength(2);
    expect(runRow.timeline.some((t) => t.text.startsWith("Run started on 2 leads"))).toBe(true);
    expect(runRow.timeline.some((t) => t.text.startsWith("Reply received"))).toBe(true);
    expect(history.variants.version).toBe(1);
    const adaVariant = (await sql`select variant from leads where id = ${adaId}`)[0]!.variant as string;
    const arm = history.variants.arms.find((a) => a.key === adaVariant)!;
    expect(arm.counts).toMatchObject({ qualified: 1, drafted: 1, approved: 1, sent: 1, replied: 1 });
    expect(history.variants.arms.reduce((s, a) => s + a.counts.leads, 0)).toBe(2);
    expect(arm.label).toBe(adaVariant === "A" ? "Hiring angle" : "Cost angle");
  });
});
