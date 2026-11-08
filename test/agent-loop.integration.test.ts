// Agent loop v2 against a real Postgres (a Neon dev branch, never production), Naive and Apify mocked at fetch.
// Skipped unless TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL=<dev branch url> bun test test/agent-loop.integration.test.ts
// Covers batch writes (add_leads inline research, save_research), company dedupe and exclusion memory, channel rules
// and the manual task queue, Apify metering idempotency, the auto-confirm path, notes and traces.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { recordApifyRun, settleApifyRun, settleApifyUsage, settleSessionUsage } from "../src/billing/usage.ts";
import { getSql, type Sql } from "../src/db.ts";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";
import type { FetchFn } from "../src/providers/http.ts";
import { approveAndSend } from "../src/services/send.ts";
import { createLead } from "../src/services/crm.ts";
import { createDraft } from "../src/services/drafts.ts";
import { addLeads, getLeadDetail, saveResearch, scoreLead } from "../src/services/leads.ts";
import { addNote, deleteNote, editNote, excludeLead, recentOwnerNotes, unexcludeLead } from "../src/services/notes.ts";
import { getQualificationWorkflow, saveQualificationWorkflow } from "../src/services/qualification.ts";
import { getFindRun, getRunDetail, startFindLeads } from "../src/services/runs.ts";
import { searchLeads } from "../src/services/crm.ts";
import { listTasks, markTaskSent, skipTask } from "../src/services/tasks.ts";
import { exportTrace, getTrace, pruneTraces } from "../src/services/traces.ts";
import { handleSessionIdle, startResearch } from "../src/services/workflows.ts";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const run = crypto.randomUUID().slice(0, 8);
const domain = (name: string) => `${name}-${run}-itloop.dev`;
const sid = (name: string) => `ses_loop_${run}_${name}`;
const owner = `it-loop-${run}`;
const viewer = { principal: { kind: "owner_token" as const } };
const env: Env = { PUBLIC_URL: "https://example.test", NAIVE_API_KEY: "nv_test", NAIVE_AGENT_ID: "agt_test", APIFY_TOKEN: "apify_test" };
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

const found = (name: string, extra: Record<string, unknown> = {}) => ({
  name: `${name} Person`,
  title: "CEO",
  company: `${name} Inc`,
  domain: domain(name),
  source: "it_loop",
  source_url: `https://${domain(name)}/about`,
  ...extra,
});

async function failure(p: Promise<unknown>): Promise<string> {
  const e = (await p.then(() => undefined, (err) => err)) as { code?: string; status?: number; message?: string } | undefined;
  expect(e).toBeDefined();
  return `${e!.status ?? ""}${e!.status ? " " : ""}${e!.code}`;
}

suite("agent loop v2 (database, mocked Naive and Apify)", () => {
  beforeAll(() => {
    sql = getSql(url);
  });

  afterAll(async () => {
    if (!sql) return;
    const ids = (await sql`select id from leads where source = 'it_loop' or domain like ${`%-${run}-itloop.dev`} or email like ${`%-${run}@itloop.dev`}`).map(
      (r) => r.id as string,
    );
    await sql.transaction([
      sql`delete from events where lead_id = any(${ids}::text[]) or data->>'session_id' like ${`ses_loop_${run}%`}
            or data->>'apify_run_id' like ${`run_loop_${run}%`} or data->>'owner_id' = ${owner}`,
      sql`delete from leads where id = any(${ids}::text[])`,
      sql`delete from naive_sessions where id like ${`ses_loop_${run}%`}`,
      sql`delete from apify_runs where run_id like ${`run_loop_${run}%`}`,
      sql`delete from webhook_events where event_id like ${`%ses_loop_${run}%`}`,
    ]);
    await sql.transaction([sql`set local crusonia.allow_ledger_delete = 'on'`, sql`delete from credit_ledger where owner_id = ${owner}`]);
  });

  test("add_leads: one lead per company, inline evidence + score + why-summary, contacts and links merged, never twice", async () => {
    const first = await addLeads(sql, [
      {
        ...found("acme"),
        website: `https://www.${domain("acme")}/about`,
        evidence: [
          { claim: "Hiring a first SDR", source_url: `https://${domain("acme")}/jobs/sdr` },
          { claim: "Seed round in 2026", source_url: `https://news.example/${run}/acme` },
        ],
        score: 85,
        qualified: true,
        rationale: "Seed-stage and hiring its first SDR.",
        why_summary: "Acme just raised a seed round [2] and is hiring its first SDR [1].",
        links: [{ url: `https://github.com/acme-${run}`, source_url: `https://${domain("acme")}/about` }],
      },
      // The same company, found on its careers subdomain in the same call: merged, not a second lead.
      { ...found("acme"), name: "Bea Builder", title: "CTO", domain: `careers.${domain("acme")}` },
      // A job board is not the company's domain.
      { ...found("lever"), domain: undefined, website: "https://jobs.lever.co/whoever" },
    ]);
    expect(first.counts).toEqual({ created: 1, merged: 1, known: 0, skipped: 1 });
    expect(first.results[2]!.reason).toContain("lever.co hosts other companies' pages");
    const id = first.results[0]!.id!;
    expect(first.results[1]!.id).toBe(id);
    expect(first.results[0]).toMatchObject({ status: "created", stage: "qualified", scored: true, evidence_saved: 2 });

    const detail = await getLeadDetail(sql, id);
    expect(detail.lead).toMatchObject({ domain: domain("acme"), stage: "qualified", has_consent: false, score: 85 });
    expect(detail.evidence.map((e) => [e.n, e.claim])).toEqual([[1, "Hiring a first SDR"], [2, "Seed round in 2026"]]);
    expect(detail.lead.why_summary).toBe("Acme just raised a seed round [2] and is hiring its first SDR [1].");
    expect(detail.lead.contacts!.map((c) => [c.name, c.title])).toEqual([["acme Person", "CEO"], ["Bea Builder", "CTO"]]);
    expect(detail.lead.contacts![0]!.found_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(detail.lead.links!.map((l) => l.kind).sort()).toEqual(["github", "website"]);

    // A later run: a new person and new evidence are merged into the same company; its score and summary stay.
    const second = await addLeads(sql, [
      {
        ...found("acme"),
        name: "Cy Closer",
        domain: `https://${domain("acme")}/team`,
        evidence: [
          { claim: "Seed round in 2026", source_url: `https://news.example/${run}/acme` },
          { claim: "Opened a New York office", source_url: `https://${domain("acme")}/blog/nyc` },
        ],
        score: 20,
        qualified: false,
        rationale: "A lighter look.",
        why_summary: "New office [2].",
      },
    ]);
    expect(second.counts).toEqual({ created: 0, merged: 1, known: 0, skipped: 0 });
    const after = await getLeadDetail(sql, id);
    expect(after.lead).toMatchObject({ score: 85, stage: "qualified", why_summary: "Acme just raised a seed round [2] and is hiring its first SDR [1]." });
    expect(after.evidence.map((e) => e.claim)).toEqual(["Hiring a first SDR", "Seed round in 2026", "Opened a New York office"]);
    expect(after.lead.contacts!.map((c) => c.name)).toContain("Cy Closer");

    // Nothing new: known.
    const third = await addLeads(sql, [found("acme")]);
    expect(third.counts).toEqual({ created: 0, merged: 0, known: 1, skipped: 0 });
    expect(third.results[0]!.reason).toContain("nothing new");
  });

  test("disqualified and owner-excluded companies are remembered and skipped until un-excluded", async () => {
    const { results } = await addLeads(sql, [{ ...found("agency"), score: 15, qualified: false, rationale: "An agency, not software." }]);
    const id = results[0]!.id!;
    expect(results[0]).toMatchObject({ status: "created", stage: "disqualified" });
    const again = await addLeads(sql, [{ ...found("agency"), name: "New Person", evidence: [{ claim: "x", source_url: "https://a.example/x" }] }]);
    expect(again.results[0]).toMatchObject({ status: "known", id });
    expect(again.results[0]!.reason).toContain("excluded");
    expect((await getLeadDetail(sql, id)).evidence).toHaveLength(0);

    const { results: r2 } = await addLeads(sql, [found("excl")]);
    await excludeLead(sql, { leadId: r2[0]!.id!, reason: "Competitor", author: "user:owner" });
    expect((await addLeads(sql, [{ ...found("excl"), name: "Other" }])).results[0]!.status).toBe("known");
    await unexcludeLead(sql, { leadId: r2[0]!.id!, author: "user:owner" });
    expect((await addLeads(sql, [{ ...found("excl"), name: "Other" }])).results[0]!.status).toBe("merged");
    // Un-excluding a disqualified lead makes it unscored again.
    expect(await unexcludeLead(sql, { leadId: id, author: "user:owner" })).toMatchObject({ stage: "no_consent" });
  });

  test("save_research: one call stores evidence (deduped), score, next step, why-summary, contacts and links; stages are consistent", async () => {
    const { results } = await addLeads(sql, [{ ...found("res"), name: undefined, title: undefined }]);
    const id = results[0]!.id!;
    expect(results[0]!.stage).toBe("no_consent");
    const ev = { claim: "Hiring 2 AEs", source_url: `https://${domain("res")}/jobs` };
    const saved = await saveResearch(sql, {
      lead_id: id,
      evidence: [ev, ev, { claim: "Uses Clay", source_url: `https://${domain("res")}/stack` }],
      score: 72,
      qualified: true,
      rationale: "Fits the ICP.",
      next_step: "LinkedIn note to the founder",
      why_summary: "Hiring AEs [1] and on Clay [3].",
      contacts: [{ name: "Dee Founder", title: "Founder", x_url: "https://x.com/dee", source_url: `https://${domain("res")}/about` }],
      links: [{ url: "https://www.linkedin.com/company/res-co", source_url: `https://${domain("res")}/about` }],
    });
    expect(saved).toMatchObject({ evidence_saved: 2, contacts_added: 1, links_added: 1, lead: { stage: "qualified", has_consent: false, next_step: "LinkedIn note to the founder" } });
    expect(saved.draft_channels).toEqual(["linkedin", "x", "intro"]);
    expect(saved.lead.why_summary).toBe("Hiring AEs [1] and on Clay [2].");
    const again = await saveResearch(sql, { lead_id: id, evidence: [ev], score: 30, qualified: false, rationale: "Changed my mind.", contacts: [], links: [] });
    expect(again).toMatchObject({ evidence_saved: 0, contacts_added: 0, lead: { stage: "disqualified" } });

    // score_lead on a found lead follows the same rule (found -> qualified/disqualified).
    const { results: r2 } = await addLeads(sql, [found("score")]);
    expect((await scoreLead(sql, { lead_id: r2[0]!.id!, score: 10, qualified: false, rationale: "No." })).stage).toBe("disqualified");
  });

  test("channels: email keeps consent + approval; manual drafts are tasks that never send", async () => {
    // An opted-in lead: the email path is unchanged (a pending send approval).
    const optedIn = await createLead(sql, { email: `opt-${run}@itloop.dev`, name: "Opted In", source: "it_loop", consent: { text: "it opt-in" } }, "test");
    const email = await createDraft(sql, { lead_id: optedIn.id, subject: "Hello", body: "Body" }, { ttlMinutes: 60, via: "api", actor: "test" });
    expect(email.approval).toMatchObject({ kind: "send", status: "pending", recipient: `opt-${run}@itloop.dev` });
    expect(email.draft).toMatchObject({ channel: "email", status: "pending_approval" });

    // A found, qualified lead without consent: email is refused, a LinkedIn task is fine with citations.
    const { results } = await addLeads(sql, [
      {
        ...found("task"),
        linkedin_url: "https://www.linkedin.com/in/task-person",
        evidence: [{ claim: "Hiring a first SDR", source_url: `https://${domain("task")}/jobs` }],
        score: 80,
        qualified: true,
        rationale: "Fits.",
      },
    ]);
    const id = results[0]!.id!;
    expect(await failure(createDraft(sql, { lead_id: id, subject: "Hi", body: "Body" }, { ttlMinutes: 60 }))).toBe("invalid");
    const body = "Saw you're hiring a first SDR. Happy to share what worked for teams like yours.";
    expect(await failure(createDraft(sql, { lead_id: id, channel: "linkedin", body }, { ttlMinutes: 60 }))).toBe("invalid"); // no citations
    const task = await createDraft(
      sql,
      { lead_id: id, channel: "linkedin", body, citations: [{ text: "hiring a first SDR", source_url: `https://${domain("task")}/jobs` }] },
      { ttlMinutes: 60 },
    );
    expect(task).toMatchObject({ approval: null, task: true, draft: { channel: "linkedin", status: "open", target_url: "https://www.linkedin.com/in/task-person" } });
    expect((await sql`select count(*)::int as n from approvals where draft_id = ${task.draft.id}`)[0]!.n).toBe(0);

    const open = await listTasks(sql, { lead_id: id });
    expect(open.data.map((t) => [t.id, t.channel, t.open_url])).toEqual([[task.draft.id, "linkedin", "https://www.linkedin.com/in/task-person"]]);

    // A new version supersedes the open task.
    const v2 = await createDraft(sql, { lead_id: id, channel: "intro", body, citations: [{ text: "hiring a first SDR", source_url: `https://${domain("task")}/jobs` }] }, { ttlMinutes: 60 });
    expect((await listTasks(sql, { lead_id: id, status: "all" })).data.map((t) => [t.version, t.status])).toEqual([[2, "open"], [1, "superseded"]]);
    expect(await failure(markTaskSent(sql, task.draft.id, {}, "test"))).toBe("conflict");

    // Marking it sent records an outbound message on its channel and moves the lead to sent; only once.
    const sent = await markTaskSent(sql, v2.draft.id, { body: `${body} (edited)` }, "test");
    expect(sent).toMatchObject({ lead_stage: "sent", task: { status: "sent" } });
    const [msg] = await sql`select direction, channel, body, provider_message_id from messages where lead_id = ${id}`;
    expect(msg).toMatchObject({ direction: "out", channel: "intro", body: `${body} (edited)`, provider_message_id: null });
    expect(await failure(markTaskSent(sql, v2.draft.id, {}, "test"))).toBe("conflict");
    expect(await failure(skipTask(sql, v2.draft.id, {}, "test"))).toBe("conflict");

    // A manual draft supersedes an open email approval, which then cannot send.
    const both = await createDraft(sql, { lead_id: optedIn.id, channel: "email_manual", subject: "Hi", body: "Body" }, { ttlMinutes: 60 }).then(
      () => "created",
      (e: { code?: string }) => e.code,
    );
    expect(both).toBe("invalid"); // not scored qualified yet
    await scoreLead(sql, { lead_id: optedIn.id, score: 90, qualified: true, rationale: "Opted in and fits." });
    await sql`insert into evidence (lead_id, claim, source_url) values (${optedIn.id}, 'Signed up', 'https://example.test/signup')`;
    await createDraft(sql, { lead_id: optedIn.id, channel: "email_manual", subject: "Hi", body: "You signed up last week.", citations: [{ text: "signed up", source_url: "https://example.test/signup" }] }, { ttlMinutes: 60 });
    expect((await sql`select status, decided_via from approvals where code = ${email.approval.code}`)[0]).toMatchObject({ status: "expired", decided_via: "superseded" });
    expect(await failure(approveAndSend({ sql, env: { ...env, AGENTMAIL_API_KEY: "am", AGENTMAIL_INBOX_ID: "it@agentmail.to" }, actor: "test" }, email.approval.code))).toBe(
      "409 approval_not_pending",
    );
  });

  test("tasks over HTTP: list, skip", async () => {
    const { results } = await addLeads(sql, [{ ...found("http"), score: 70, qualified: true, rationale: "Fits.", evidence: [{ claim: "Uses Clay", source_url: `https://${domain("http")}/stack` }] }]);
    const id = results[0]!.id!;
    const t = await createDraft(sql, { lead_id: id, channel: "intro", body: "They use Clay today.", citations: [{ text: "use Clay", source_url: `https://${domain("http")}/stack` }] }, { ttlMinutes: 60 });
    const http = (path: string, init: RequestInit = {}) =>
      worker.fetch(
        new Request(`https://example.test${path}`, { ...init, headers: { Authorization: `Bearer tok-${run}`, "Content-Type": "application/json" } }),
        { PUBLIC_URL: "https://example.test", DATABASE_URL: url, MCP_TOKEN: `tok-${run}` },
        {} as ExecutionContext,
      );
    const list = (await (await http(`/api/tasks?lead_id=${id}`)).json()) as { data: { id: string }[]; open_total: number };
    expect(list.data.map((x) => x.id)).toEqual([t.draft.id]);
    const skipped = await http(`/api/tasks/${t.draft.id}/skip`, { method: "POST", body: JSON.stringify({ reason: "Not now" }) });
    expect(skipped.status).toBe(200);
    expect(((await skipped.json()) as { task: { status: string } }).task.status).toBe("skipped");
    expect((await http(`/api/tasks/${t.draft.id}/sent`, { method: "POST", body: "{}" })).status).toBe(409);
    expect((await http(`/api/leads/${id}/notes`, { method: "POST", body: JSON.stringify({ body: "Agency, not software", kind: "thumbs_down" }) })).status).toBe(201);
  });

  test("Apify metering: one debit per run at the usage markup, top-ups only, idempotent; session debits unaffected", async () => {
    const runId = `run_loop_${run}_a`;
    const base = { actor: "apify/google-search-scraper", maxChargeUsd: 0.25, billingOwnerId: owner, sessionId: sid("meter"), via: "mcp" };
    await recordApifyRun(sql, { ...base, run: { id: runId, status: "RUNNING" } });
    expect(await settleApifyRun(sql, runId)).toBe(0); // no usage yet
    await recordApifyRun(sql, { ...base, run: { id: runId, status: "SUCCEEDED", usageTotalUsd: 0.0045 } });
    expect(await settleApifyRun(sql, runId)).toBe(1); // ceil(4500 x 2 / 10,000)
    expect(await settleApifyRun(sql, runId)).toBe(0);
    // A late RUNNING report never replaces the final state, and usage never goes down.
    await recordApifyRun(sql, { ...base, run: { id: runId, status: "RUNNING", usageTotalUsd: 0.001 } });
    expect((await sql`select status, usage_micro_usd::int as u from apify_runs where run_id = ${runId}`)[0]).toEqual({ status: "SUCCEEDED", u: 4500 });

    // The cron re-reads final usage once (Apify finalizes it after the run) and debits only the difference.
    await sql`update apify_runs set finished_at = now() - interval '5 minutes' where run_id = ${runId}`;
    const apify = provider((c) => (c.url.includes(`/actor-runs/${runId}`) ? Response.json({ data: { id: runId, status: "SUCCEEDED", usageTotalUsd: 0.0123 } }) : undefined));
    const cron = await settleApifyUsage(sql, env, apify.fn);
    expect(cron.refreshed).toBeGreaterThanOrEqual(1);
    const rows = await sql`select amount::int as amount, source from credit_ledger where owner_id = ${owner} and source like ${`apify:${runId}:%`} order by id`;
    expect(rows).toEqual([{ amount: -1, source: `apify:${runId}:1` }, { amount: -2, source: `apify:${runId}:3` }]);
    expect(await settleApifyRun(sql, runId)).toBe(0);
    expect((await sql`select usage_final from apify_runs where run_id = ${runId}`)[0]!.usage_final).toBe(true);

    // Runs without a billing owner are recorded, never debited. A session's own debit ignores Apify rows.
    await recordApifyRun(sql, { ...base, billingOwnerId: null, run: { id: `${runId}_free`, status: "SUCCEEDED", usageTotalUsd: 0.5 } });
    expect(await settleApifyRun(sql, `${runId}_free`)).toBe(0);
    await sql`insert into naive_sessions (id, purpose, status, consumed_micro_usd, billing_owner_id) values (${sid("meter")}, 'research', 'done', 100000, ${owner})`;
    expect(await settleSessionUsage(sql, sid("meter"))).toBe(20);
  });

  test("auto-confirm: parallel, idempotent; a call another handler claimed counts as allowed, so the session stays running", async () => {
    const sessionId = sid("idle");
    await sql`insert into naive_sessions (id, purpose, status) values (${sessionId}, 'find_leads', 'running')`;
    const pendingActions = [1, 2, 3].map((n) => ({ kind: "tool" as const, tool_call_id: `c${n}`, name: "crusonia.search_web", args: { query: `q${n}` } }));
    const nv = provider((c) => (c.url.endsWith("/tool_confirmations") ? Response.json({}) : undefined));
    const first = await handleSessionIdle(sql, env, { sessionId, stopReason: "awaiting_approval", pendingActions }, nv.fn);
    expect(first.auto_allowed).toHaveLength(3);
    expect(nv.calls.map((c) => c.body.tool_call_id).sort()).toEqual(["c1", "c2", "c3"]);

    // A second handler (the poll, or a duplicate webhook) sees the same parked calls before Naive resumes.
    const second = await handleSessionIdle(sql, env, { sessionId, stopReason: "awaiting_approval", pendingActions }, nv.fn);
    expect(second.auto_allowed).toHaveLength(3);
    expect(nv.calls).toHaveLength(3);
    expect((await sql`select status from naive_sessions where id = ${sessionId}`)[0]!.status).toBe("running");
    expect((await sql`select count(*)::int as n from events where kind = 'naive_idle' and data->>'session_id' = ${sessionId}`)[0]!.n).toBe(1);
    expect((await sql`select count(*)::int as n from events where kind = 'naive_tool_auto_allowed' and data->>'session_id' = ${sessionId}`)[0]!.n).toBe(3);

    // A failed confirmation is released so a retry can confirm it.
    const flaky = provider((c) => (c.body?.tool_call_id === "c5" ? new Response("{}", { status: 400 }) : Response.json({})));
    const actions = [4, 5].map((n) => ({ kind: "tool" as const, tool_call_id: `c${n}`, name: "crusonia.get_lead", args: {} }));
    await expect(handleSessionIdle(sql, env, { sessionId, stopReason: "awaiting_approval", pendingActions: actions }, flaky.fn)).rejects.toThrow();
    expect((await sql`select event_id from webhook_events where event_id like ${`autoconfirm:${sessionId}:%`} order by 1`).map((r) => r.event_id)).toEqual(
      ["c1", "c2", "c3", "c4"].map((c) => `autoconfirm:${sessionId}:${c}`),
    );
  });

  test("notes: authors edit and delete their own; owner notes across leads are what agents steer by", async () => {
    const { results } = await addLeads(sql, [found("notes")]);
    const id = results[0]!.id!;
    const mine = await addNote(sql, { leadId: id, author: "user:owner", body: "Agency, not software", kind: "thumbs_down" });
    await addNote(sql, { leadId: id, author: `agent:${sid("x")}`, body: "Two domains: .io is the product" });
    expect(await failure(editNote(sql, { leadId: id, noteId: mine.id, author: "user:someone-else", body: "x" }))).toBe("invalid");
    expect((await editNote(sql, { leadId: id, noteId: mine.id, author: "user:owner", body: "An agency, not software" })).body).toBe("An agency, not software");
    const detail = await getLeadDetail(sql, id);
    expect(detail.notes.map((n) => [n.author.split(":")[0], n.kind])).toEqual([["agent", "note"], ["user", "thumbs_down"]]);
    expect((await recentOwnerNotes(sql, 50)).some((n) => n.lead_id === id && n.body === "An agency, not software")).toBe(true);
    expect(await failure(deleteNote(sql, { leadId: id, noteId: mine.id, author: "user:someone-else" }))).toBe("invalid");
    await deleteNote(sql, { leadId: id, noteId: mine.id, author: "user:owner" });
    expect((await getLeadDetail(sql, id)).notes).toHaveLength(1);
  });

  test("qualification workflow: research gets it, missing required evidence pauses the lead in needs_review instead of a score", async () => {
    const before = (await sql`select value from settings where key = 'qualification_workflow'`)[0]?.value ?? null;
    try {
      const v1 = await saveQualificationWorkflow(sql, { name: `IT ${run}`, evidence_requirements: [{ id: "hiring", description: "A sales hire in the last 90 days" }] }, "test");
      const v2 = await saveQualificationWorkflow(
        sql,
        { name: `IT ${run}`, research_questions: [{ id: "owner", question: "Who runs outbound?" }], evidence_requirements: [{ id: "hiring", description: "A sales hire in the last 90 days" }, { id: "stack", description: "Their tools", required: false }], completion_criteria: ["All required evidence sourced"] },
        "test",
      );
      expect(v2.version).toBe(v1.version + 1);
      expect((await getQualificationWorkflow(sql))?.version).toBe(v2.version);

      const { results } = await addLeads(sql, [found("review")]);
      const id = results[0]!.id!;
      // Research sessions get the workflow in their first message.
      const nv = provider((c) => (c.url.endsWith("/v1/sessions") ? Response.json({ id: sid("review"), status: "running" }) : undefined));
      await startResearch(sql, env, { lead_ids: [id] }, "test", nv.fn);
      expect(nv.calls[0]!.body.message).toContain("[hiring] (required) A sales hire in the last 90 days");
      expect((await sql`select input from naive_sessions where id = ${sid("review")}`)[0]!.input).toEqual({ workflow_version: v2.version });
      await sql`update naive_sessions set status = 'done' where id = ${sid("review")}`;

      // A score without the required evidence is not stored: the lead pauses with a question.
      const paused = await saveResearch(sql, {
        lead_id: id,
        evidence: [{ claim: "Uses Clay", source_url: `https://${domain("review")}/stack`, requirement: "stack" }],
        score: 90,
        qualified: true,
        rationale: "Looks great.",
        contacts: [],
        links: [],
      });
      expect(paused).toMatchObject({ needs_review: true, missing_requirements: [{ id: "hiring" }], lead: { stage: "needs_review", score: null } });
      expect(paused.lead.review_question).toContain("A sales hire in the last 90 days");
      expect(paused.draft_channels).toEqual([]);
      expect(await failure(scoreLead(sql, { lead_id: id, score: 90, qualified: true, rationale: "x" }))).toBe("invalid");
      expect(await failure(createDraft(sql, { lead_id: id, channel: "intro", body: "They use Clay.", citations: [{ text: "use Clay", source_url: `https://${domain("review")}/stack` }] }, { ttlMinutes: 60 }))).toBe("invalid");

      // The run view explains it.
      const runView = await getRunDetail(sql, { PUBLIC_URL: "https://example.test" }, sid("review"));
      expect(runView.lead).toMatchObject({ stage: "needs_review" });
      expect(runView.steps.some((st) => st.summary.startsWith("Needs review: Missing required evidence"))).toBe(true);

      // With the evidence (tagged with its requirement), the lead is scored and the question cleared.
      const done = await saveResearch(sql, {
        lead_id: id,
        evidence: [{ claim: "Hired a first AE in October", source_url: `https://${domain("review")}/blog/ae`, requirement: "hiring" }],
        score: 88,
        qualified: true,
        rationale: "Hired an AE.",
        contacts: [],
        links: [],
      });
      expect(done).toMatchObject({ lead: { stage: "qualified", score: 88, review_question: null } });
      expect("needs_review" in done).toBe(false);

      // The agent's own question pauses a lead too, even with every requirement met.
      const asked = await saveResearch(sql, { lead_id: id, review_question: "Is acme.io the same company?", contacts: [], links: [], evidence: [] });
      expect(asked).toMatchObject({ needs_review: true, lead: { stage: "needs_review", review_question: "Is acme.io the same company?" } });
    } finally {
      if (before) await sql`update settings set value = ${JSON.stringify(before)}::jsonb where key = 'qualification_workflow'`;
      else await sql`delete from settings where key = 'qualification_workflow'`;
      await sql`delete from events where kind = 'qualification_workflow_saved' and data->>'actor' = 'test' and data->'workflow'->>'name' = ${`IT ${run}`}`;
    }
  });

  test("leads list: notes_count and the latest rating per row", async () => {
    const { results } = await addLeads(sql, [found("rated"), found("plain")]);
    const [rated, plain] = results.map((r) => r.id!);
    await addNote(sql, { leadId: rated!, author: "user:owner", body: "Agency", kind: "thumbs_down" });
    await addNote(sql, { leadId: rated!, author: "user:owner", body: "Actually a product company", kind: "thumbs_up" });
    await addNote(sql, { leadId: rated!, author: "user:owner", body: "Call next week" });
    const page = await searchLeads(sql, { q: `-${run}-itloop.dev`, limit: 200 });
    const row = (id: string) => page.data.find((l) => l.id === id) as { notes_count: number; rating: string | null } | undefined;
    expect(row(rated!)).toMatchObject({ notes_count: 3, rating: "up" });
    expect(row(plain!)).toMatchObject({ notes_count: 0, rating: null });
  });

  test("find runs: like_lead_id shapes the brief; GET /api/leads/find/:id lists the leads the run touched with their status", async () => {
    const before = (await sql`select value from settings where key = 'profile'`)[0]?.value ?? null;
    try {
      if (!before) await sql`insert into settings (key, value) values ('profile', ${JSON.stringify({ company: "IT", sells: "x", icp_description: "y" })}::jsonb)`;
      const { results } = await addLeads(sql, [found("like")]);
      const likeId = results[0]!.id!;
      const nv = provider((c) => (c.method === "POST" && c.url.endsWith("/v1/sessions") ? Response.json({ id: sid("find"), status: "running" }) : undefined));
      expect(await failure(startFindLeads(sql, env, 5, "test", nv.fn, { likeLeadId: "lead_missing" }))).toBe("404 not_found");
      const { session_id } = await startFindLeads(sql, env, 5, "test", nv.fn, { likeLeadId: likeId });
      expect(session_id).toBe(sid("find"));
      expect(nv.calls[0]!.body.message).toContain(`companies like lead ${likeId}`);
      expect((await sql`select input from naive_sessions where id = ${session_id}`)[0]!.input).toEqual({ count: 5, like_lead_id: likeId });

      // The run's add_leads call, as the trace stores it.
      const added = await addLeads(sql, [found("found1"), found("like")]);
      const output = JSON.stringify(added, null, 2);
      const events = provider((c) =>
        c.url.includes(`/sessions/${session_id}/events`)
          ? Response.json({
              data: Number(new URL(c.url).searchParams.get("after_seq")) > 0 ? [] : [
                { seq: 1, type: "tool.completed", data: { tool_call_id: "a1", name: "crusonia.add_leads", output, is_error: false }, created_at: new Date().toISOString() },
              ],
              has_more: false,
              next_cursor: null,
            })
          : undefined,
      );
      const res = await getFindRun(sql, env, session_id, events.fn);
      expect(res.run).toMatchObject({ id: session_id, purpose: "find_leads" });
      expect(Object.fromEntries(res.leads.map((l) => [l.domain, l.find_status]))).toEqual({ [domain("found1")]: "created", [domain("like")]: "known" });
      await expect(getFindRun(sql, env, sid("nope"))).rejects.toMatchObject({ status: 404 });
    } finally {
      if (!before) await sql`delete from settings where key = 'profile'`;
    }
  });

  test("traces: the full event trace is stored and paginated, exported, and pruned after the retention window", async () => {
    const sessionId = sid("trace");
    await sql`insert into naive_sessions (id, purpose, status, consumed_micro_usd, created_at, updated_at)
              values (${sessionId}, 'find_leads', 'done', 250000, now() - interval '1 hour', now() - interval '1 hour')`;
    const big = "y".repeat(80_000);
    const all = Array.from({ length: 7 }, (_, i) => ({
      seq: i + 1,
      type: i === 3 ? "span.harness_load.start" : i === 2 ? "message.delta" : "tool.completed",
      data: { tool_call_id: `t${i}`, name: "crusonia.read_website", output: i === 1 ? big : "ok", is_error: false },
      created_at: new Date(Date.now() - 3_600_000 + i * 1000).toISOString(),
    }));
    const nv = provider((c) => {
      if (!c.url.includes(`/sessions/${sessionId}/events`)) return undefined;
      const after = Number(new URL(c.url).searchParams.get("after_seq"));
      const page = all.filter((e) => e.seq > after).slice(0, 3);
      return Response.json({ data: page, has_more: page.length === 3 && page.at(-1)!.seq < 7, next_cursor: null });
    });
    const first = await getTrace(sql, env, viewer, sessionId, { limit: 2 }, nv.fn);
    expect(first.sync).toMatchObject({ ok: true, complete: true });
    expect(first.events.map((e) => (e as { seq: number }).seq)).toEqual([1, 2]);
    expect(first.has_more).toBe(true);
    expect(((first.events[1] as unknown as { data: { output: string } }).data.output).length).toBeLessThan(64_100);
    const rest = await getTrace(sql, env, viewer, sessionId, { afterSeq: first.next_after_seq!, limit: 100 }, nv.fn);
    // Everything but the streaming delta is kept, spans included.
    expect(rest.events.map((e) => (e as { seq: number }).seq)).toEqual([4, 5, 6, 7]);
    expect(rest.spend.naive_usd).toBe(0.25);
    const exported = await exportTrace(sql, env, viewer, sessionId, nv.fn);
    expect(exported).toMatchObject({ format: "crusonia.trace.v1", truncated: false });
    expect(exported.events).toHaveLength(6);
    // The clean timeline still reads from the same events.
    expect((await getRunDetail(sql, env, sessionId, nv.fn)).steps.length).toBeGreaterThan(0);

    await sql`update naive_sessions set created_at = now() - interval '400 days' where id = ${sessionId}`;
    expect(await pruneTraces(sql, { ...env, TRACE_RETENTION_DAYS: "365" })).toBeGreaterThanOrEqual(6);
    expect((await sql`select count(*)::int as n from naive_session_events where session_id = ${sessionId}`)[0]!.n).toBe(0);
  });
});
