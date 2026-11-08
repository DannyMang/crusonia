// Agent loop v2, pure parts: outreach channels, citations, company domains, the cumulative funnel, timeline folding,
// read_website's SPA retry and own-host copy, and Apify run caps (providers mocked at fetch).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.ts";
import { checkSendApproval, type SendCheckInput } from "../src/services/approval-rules.ts";
import { maxChargeUsd, runActor, type ApifyRun } from "../src/services/apify.ts";
import { checkChannel, citationProblems, openUrl, taskTitle, type ChannelLead } from "../src/services/channels.ts";
import { draftInputSchema } from "../src/services/drafts.ts";
import { normalizeDomain, registrableDomain, whyNoDomain } from "../src/services/domains.ts";
import { leadInputSchema, linkKind, renumberCitations, researchInputSchema } from "../src/services/leads.ts";
import { buildSteps, findLeadsMessage, findStatusesFromEvents, type AuditEvent, type StoredEvent } from "../src/services/runs.ts";
import { missingEvidenceQuestion, missingRequirements, qualificationWorkflowSchema, workflowBrief } from "../src/services/qualification.ts";
import { LANDING_LINES, siteCopy } from "../src/services/site-copy.ts";
import { researchMessage } from "../src/services/workflows.ts";
import { cumulativePipeline } from "../src/services/summary.ts";
import { DEFAULT_TRACE_RETENTION_DAYS, traceRetentionDays } from "../src/services/traces.ts";
import { isOwnHost, readWebsite } from "../src/services/web.ts";
import type { FetchFn } from "../src/providers/http.ts";

const lead = (over: Partial<ChannelLead> = {}): ChannelLead => ({
  id: "lead_1",
  email: null,
  name: "Ada Lovelace",
  company: "Acme",
  linkedin_url: null,
  consent_at: null,
  stage: "qualified",
  qualified: true,
  suppressed: false,
  ...over,
});

describe("channels: email keeps its rules, manual channels never need consent but never auto-send", () => {
  test("email needs an email address and recorded consent, and nobody suppressed or unsubscribed", () => {
    expect(checkChannel(lead(), { channel: "email" })).toMatchObject({ ok: false, message: expect.stringContaining("no email address") });
    expect(checkChannel(lead({ email: "ada@acme.dev" }), { channel: "email" })).toMatchObject({ ok: false, message: expect.stringContaining("no recorded consent") });
    const consented = lead({ email: "ada@acme.dev", consent_at: new Date() });
    expect(checkChannel(consented, { channel: "email" })).toEqual({ ok: true, recipient: "ada@acme.dev", target_url: null });
    expect(checkChannel({ ...consented, suppressed: true }, { channel: "email" }).ok).toBe(false);
    expect(checkChannel({ ...consented, stage: "unsubscribed" }, { channel: "email" }).ok).toBe(false);
    // Email does not require a score (opted-in contacts can be emailed before research), as before.
    expect(checkChannel({ ...consented, qualified: null }, { channel: "email" }).ok).toBe(true);
  });

  test("manual channels need a qualified lead, and refuse anyone suppressed or unsubscribed on every channel", () => {
    for (const channel of ["email_manual", "linkedin", "x", "intro"] as const) {
      expect(checkChannel(lead({ qualified: false, email: "a@acme.dev" }), { channel, profile_url: "https://x.com/ada" }).ok).toBe(false);
      expect(checkChannel(lead({ suppressed: true, email: "a@acme.dev" }), { channel, profile_url: "https://x.com/ada" }).ok).toBe(false);
      expect(checkChannel(lead({ stage: "unsubscribed", email: "a@acme.dev" }), { channel, profile_url: "https://x.com/ada" }).ok).toBe(false);
    }
  });

  test("each manual channel needs its own target: a LinkedIn or X profile, or an email for the owner's mailbox", () => {
    expect(checkChannel(lead(), { channel: "linkedin" }).ok).toBe(false);
    expect(checkChannel(lead({ linkedin_url: "https://www.linkedin.com/in/ada" }), { channel: "linkedin" })).toEqual({
      ok: true,
      recipient: null,
      target_url: "https://www.linkedin.com/in/ada",
    });
    expect(checkChannel(lead(), { channel: "linkedin", profile_url: "https://evil.example/in/ada" }).ok).toBe(false);
    expect(checkChannel(lead(), { channel: "x" }).ok).toBe(false);
    expect(checkChannel(lead(), { channel: "x", profile_url: "https://twitter.com/ada" })).toMatchObject({ ok: true, target_url: "https://twitter.com/ada" });
    expect(checkChannel(lead(), { channel: "x", profile_url: "https://www.linkedin.com/in/ada" }).ok).toBe(false);
    expect(checkChannel(lead(), { channel: "email_manual" }).ok).toBe(false);
    // No consent needed: the owner sends it from their own mailbox.
    expect(checkChannel(lead({ email: "ada@acme.dev" }), { channel: "email_manual" })).toMatchObject({ ok: true, recipient: "ada@acme.dev" });
    expect(checkChannel(lead(), { channel: "intro" })).toEqual({ ok: true, recipient: null, target_url: null });
  });

  test("citations quote the body and point at saved evidence; manual drafts need at least one", () => {
    const body = "Saw Acme is hiring its first SDR. Happy to share how others handled that.";
    const saved = ["https://acme.dev/jobs/sdr/"];
    expect(citationProblems(body, [], saved, true)).toHaveLength(1);
    expect(citationProblems(body, [], saved, false)).toEqual([]);
    expect(citationProblems(body, [{ text: "hiring its first  SDR", source_url: "https://www.acme.dev/jobs/sdr" }], saved, true)).toEqual([]);
    const bad = citationProblems(body, [{ text: "raised $10M", source_url: "https://news.example/acme" }], saved, true);
    expect(bad.join(" ")).toContain("not in the body");
    expect(bad.join(" ")).toContain("not saved evidence");
  });

  test("the send path refuses a manual draft even if an approval pointed at it", () => {
    const base: SendCheckInput = {
      approval: { kind: "send", status: "pending", expires_at: new Date(Date.now() + 60_000), draft_id: "d1", recipient: "a@acme.dev" },
      draft: { id: "d1", status: "pending_approval", version: 1, channel: "email" },
      latestVersion: 1,
      lead: { email: "a@acme.dev", consent_at: new Date() },
      suppressed: false,
      paused: false,
      now: new Date(),
    };
    expect(checkSendApproval(base)).toEqual({ ok: true });
    expect(checkSendApproval({ ...base, draft: { ...base.draft!, channel: "linkedin" } })).toMatchObject({ ok: false, code: "manual_channel" });
    // Rows from before channels existed are email drafts.
    expect(checkSendApproval({ ...base, draft: { id: "d1", status: "pending_approval", version: 1 } })).toEqual({ ok: true });
  });

  test("tasks open the profile, or a mailto: link that only opens the owner's mail client", () => {
    expect(openUrl({ channel: "linkedin", target_url: "https://linkedin.com/in/ada", subject: "s", body: "b" }, null)).toBe("https://linkedin.com/in/ada");
    expect(openUrl({ channel: "email_manual", target_url: null, subject: "Hi Ada", body: "Line 1" }, "ada@acme.dev")).toBe("mailto:ada%40acme.dev?subject=Hi%20Ada&body=Line%201");
    expect(openUrl({ channel: "intro", target_url: null, subject: "s", body: "b" }, null)).toBeNull();
    expect(taskTitle("linkedin", { name: "Ada", company: "Acme" })).toBe("LinkedIn message to Ada (Acme)");
  });

  test("the create_draft schema defaults to email and requires a subject for email channels only", () => {
    expect(draftInputSchema.parse({ lead_id: "l", subject: "Hi", body: "b" }).channel).toBe("email");
    expect(draftInputSchema.safeParse({ lead_id: "l", body: "b" }).success).toBe(false);
    expect(draftInputSchema.safeParse({ lead_id: "l", channel: "email_manual", body: "b" }).success).toBe(false);
    expect(draftInputSchema.safeParse({ lead_id: "l", channel: "linkedin", body: "b" }).success).toBe(true);
  });
});

describe("company domains: one per company, never a host", () => {
  test("lowercase, no www or path, registrable", () => {
    expect(normalizeDomain("https://WWW.Acme.com/about?x=1")).toBe("acme.com");
    expect(normalizeDomain("careers.acme.com")).toBe("acme.com");
    expect(normalizeDomain("https://shop.acme.co.uk/")).toBe("acme.co.uk");
    expect(normalizeDomain("acme.github.io")).toBe("acme.github.io");
    expect(registrableDomain("a.b.acme.com.au")).toBe("acme.com.au");
    expect(normalizeDomain("not a domain")).toBeNull();
  });

  test("job boards, social networks and other hosts are never a company's domain", () => {
    for (const host of ["https://jobs.lever.co/acme", "boards.greenhouse.io/acme", "https://www.indeed.com/cmp/acme", "https://www.linkedin.com/company/acme", "jobs.ashbyhq.com/acme", "https://x.com/acme", "gmail.com", "https://www.ycombinator.com/companies/acme", "https://standout.work/jobs/1"]) {
      expect(normalizeDomain(host)).toBeNull();
    }
    expect(whyNoDomain("https://jobs.lever.co/acme")).toContain("lever.co hosts other companies' pages");
    expect(whyNoDomain("acme.com")).toBeNull();
  });

  test("add_leads input: score, qualified and rationale come together; why_summary, contacts and links are optional", () => {
    const base = { domain: "acme.com", source: "google_search", source_url: "https://acme.com" };
    expect(leadInputSchema.safeParse({ ...base, score: 80 }).success).toBe(false);
    expect(leadInputSchema.safeParse({ ...base, score: 80, qualified: true, rationale: "Fits." }).success).toBe(true);
    const parsed = leadInputSchema.parse({ ...base, why_summary: "Hiring an SDR [1]." });
    expect(parsed).toMatchObject({ evidence: [], contacts: [], links: [] });
    expect(researchInputSchema.safeParse({ lead_id: "l", score: 10, qualified: false, rationale: "No." }).success).toBe(true);
  });

  test("why-summary citations are renumbered to the lead's evidence list; unsaved ones are dropped", () => {
    expect(renumberCitations("Hiring [1]. Funded [2, 3].", [4, 5, 6])).toBe("Hiring [4]. Funded [5, 6].");
    expect(renumberCitations("Hiring [1] and more [3].", [2, undefined])).toBe("Hiring [2] and more.");
  });

  test("links are classified by host", () => {
    expect(linkKind("https://www.linkedin.com/company/acme", "acme.com")).toBe("linkedin");
    expect(linkKind("https://github.com/acme", "acme.com")).toBe("github");
    expect(linkKind("https://twitter.com/acme", "acme.com")).toBe("x");
    expect(linkKind("https://docs.acme.com", "acme.com")).toBe("website");
    expect(linkKind("https://news.example/acme", "acme.com")).toBe("other");
  });
});

describe("summary funnel", () => {
  test("is cumulative: each step is at least the next one", () => {
    expect(cumulativePipeline({ found: 5, researched: 2, qualified: 0, drafted: 0, sent: 1, replied: 0, meetings: 1 }, 2)).toEqual({
      found: 5,
      researched: 2,
      qualified: 1,
      drafted: 1,
      awaiting_approval: 2,
      sent: 1,
      replied: 1,
      meetings: 1,
    });
  });
});

describe("run timeline folding (shaped like the first production run)", () => {
  const t = (ms: number) => new Date(Date.UTC(2026, 10, 8, 3, 56, 0, ms)).toISOString();
  const waiting = (name: string) => `${name} is waiting for approval`;
  // get_profile is parked on a confirmation, auto-allowed by policy, then runs; read_website waits for the owner;
  // a model request is stored with an earlier timestamp than the event before it.
  const events: StoredEvent[] = [
    { seq: 1, type: "message.accepted", data: {}, created_at: t(0) },
    { seq: 2, type: "message.completed", data: { role: "user", content: "Research lead lead_1 for Crusonia." }, created_at: t(10) },
    { seq: 4, type: "tool.started", data: { tool_call_id: "c1", name: "crusonia.get_profile", args: {} }, created_at: t(4000) },
    { seq: 5, type: "tool.completed", data: { tool_call_id: "c1", name: "crusonia.get_profile", output: waiting("crusonia.get_profile"), is_error: true }, created_at: t(4000) },
    { seq: 6, type: "span.model_request.end", data: { resolved_model: "openai/gpt-6.1-terra", token_usage: { input: 100 }, consumed_micro_usd: 48000 }, created_at: t(1000) },
    { seq: 7, type: "tool.confirm", data: { tool_call_id: "c1", name: "crusonia.get_profile", args: {} }, created_at: t(4000) },
    { seq: 8, type: "session.idle", data: { stop_reason: "awaiting_approval" }, created_at: t(5000) },
    { seq: 9, type: "tool.confirm.resolved", data: { tool_call_id: "c1", decision: "allow" }, created_at: t(13000) },
    { seq: 10, type: "session.running", data: {}, created_at: t(13000) },
    { seq: 11, type: "tool.started", data: { tool_call_id: "c1", name: "crusonia.get_profile", args: {} }, created_at: t(17000) },
    { seq: 12, type: "tool.completed", data: { tool_call_id: "c1", name: "crusonia.get_profile", output: '{"profile":{}}', is_error: false }, created_at: t(17200) },
    { seq: 13, type: "tool.started", data: { tool_call_id: "c2", name: "crusonia.read_website", args: { url: "https://acme.com" } }, created_at: t(20000) },
    { seq: 14, type: "tool.completed", data: { tool_call_id: "c2", name: "crusonia.read_website", output: [{ type: "text", text: waiting("crusonia.read_website") }], is_error: true }, created_at: t(20000) },
    { seq: 15, type: "tool.confirm", data: { tool_call_id: "c2", name: "crusonia.read_website", args: { url: "https://acme.com" } }, created_at: t(20000) },
    { seq: 16, type: "session.idle", data: { stop_reason: "awaiting_approval" }, created_at: t(21000) },
  ];
  const audit: AuditEvent[] = [
    { id: 1, kind: "research_started", data: { session_id: "s" }, created_at: t(500) },
    { id: 2, kind: "naive_tool_auto_allowed", data: { session_id: "s", tool: "crusonia.get_profile", tool_call_id: "c1" }, created_at: t(12900) },
    { id: 3, kind: "naive_idle", data: { session_id: "s", stop_reason: "awaiting_approval", auto_allowed: 1 }, created_at: t(12950) },
    { id: 4, kind: "approval_requested", data: { session_id: "s", code: "ABCD", tool: "crusonia.read_website" }, created_at: t(22000) },
  ];

  test("a confirmed call is one step: no fake failure, no auto-allow noise, no policy-only pause", () => {
    const steps = buildSteps(events, audit, [{ code: "ABCD", kind: "tool", status: "pending", tool_call_id: "c2", decided_via: null }]);
    expect(steps.map((s) => `${s.type}:${s.summary}`)).toEqual([
      "message:Instruction: Research lead lead_1 for Crusonia.",
      "crusonia:Research started",
      "model:openai/gpt-6.1-terra: 100 tokens",
      "tool:get_profile",
      "approval:Needs approval: read_website (https://acme.com)",
      "status:Waiting for the owner to approve a tool call",
      "crusonia:Approval ABCD requested for crusonia.read_website",
    ]);
    const profile = steps.find((s) => s.tool === "get_profile")!;
    expect(profile).toMatchObject({ is_error: false, duration_ms: 200, output: '{"profile":{}}', approval: { decision: "allow", via: "policy", waited_ms: 13000 } });
    expect(steps.some((s) => s.summary.includes("(failed)"))).toBe(false);
    expect(steps.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const times = steps.map((s) => Date.parse(s.started_at!));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  test("an owner decision stays visible on the step, and a denial reads as denied", () => {
    const decided = [
      ...events,
      { seq: 17, type: "tool.confirm.resolved", data: { tool_call_id: "c2", decision: "deny" }, created_at: t(30000) },
    ];
    const steps = buildSteps(decided, audit, [{ code: "ABCD", kind: "tool", status: "rejected", tool_call_id: "c2", decided_via: "api" }]);
    expect(steps.find((s) => s.tool === "read_website")).toMatchObject({ type: "tool", summary: "read_website: https://acme.com (denied)", is_error: true, approval: { via: "owner", code: "ABCD" } });
  });
});

describe("read_website", () => {
  type Call = { url: string; body: any };
  function apify(pages: (renderJs: boolean) => unknown[]) {
    const calls: Call[] = [];
    const fn: FetchFn = async (u, init = {}) => {
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url: u, body });
      if (u.includes("/acts/apify~website-content-crawler/runs")) {
        const render = body.crawlerType === "playwright:adaptive";
        const run: ApifyRun = { id: `run_${calls.length}`, status: "SUCCEEDED", defaultDatasetId: render ? "ds_js" : "ds_plain", usageTotalUsd: 0.004 };
        return Response.json({ data: run });
      }
      if (u.includes("/datasets/ds_js/items")) return Response.json(pages(true));
      if (u.includes("/datasets/ds_plain/items")) return Response.json(pages(false));
      return new Response("unmocked", { status: 404 });
    };
    return { fn, calls };
  }
  const env = { PUBLIC_URL: "https://crusonia.example.workers.dev", APIFY_TOKEN: "apify_test" };
  const spa = (renderJs: boolean) =>
    renderJs
      ? [
          { url: "https://spa.dev/", metadata: { title: "SPA" }, text: "We build software for logistics teams. ".repeat(10) },
          { url: "https://spa.dev/sign-in", metadata: { title: "Sign in" }, text: "Welcome back. ".repeat(30) },
        ]
      : [{ url: "https://spa.dev/", metadata: { title: "SPA" }, text: "You need to enable JavaScript." }];

  test("an empty plain crawl is retried with JavaScript rendering; sign-in pages are dropped; every run is capped", async () => {
    const { fn, calls } = apify(spa);
    const res = await readWebsite(env, { url: "spa.dev", max_pages: 3, render_js: false }, { fetchFn: fn });
    expect(res).toMatchObject({ mode: "apify", rendered: true });
    expect(res.pages.map((p) => p.url)).toEqual(["https://spa.dev/"]);
    const runs = calls.filter((c) => c.url.includes("/runs?"));
    expect(runs.map((c) => c.body.crawlerType)).toEqual(["cheerio", "playwright:adaptive"]);
    for (const r of runs) {
      expect(new URL(r.url).searchParams.get("maxTotalChargeUsd")).toBe("0.25");
      expect(r.body.excludeUrlGlobs).toContainEqual({ glob: "**/sign-in" });
    }
  });

  test("render_js renders from the start: one run", async () => {
    const { fn, calls } = apify(spa);
    const res = await readWebsite({ ...env, APIFY_MAX_CHARGE_USD: "0.1" }, { url: "https://spa.dev", max_pages: 3, render_js: true }, { fetchFn: fn });
    expect(res.rendered).toBe(true);
    const runs = calls.filter((c) => c.url.includes("/runs?"));
    expect(runs).toHaveLength(1);
    expect(new URL(runs[0]!.url).searchParams.get("maxTotalChargeUsd")).toBe("0.1");
  });

  test("Crusonia's own host (and its preview hosts) is read from the landing copy, never fetched", async () => {
    const fn: FetchFn = async () => {
      throw new Error("must not fetch");
    };
    for (const url of ["https://crusonia.example.workers.dev", "app-crusonia.example.workers.dev/pricing"]) {
      const res = await readWebsite(env, { url, max_pages: 5, render_js: false }, { fetchFn: fn });
      expect(res.mode).toBe("own_site");
      expect(res.pages[0]!.text.length).toBeGreaterThan(200);
    }
    const pricing = await readWebsite(env, { url: "crusonia.example.workers.dev/pricing", max_pages: 1, render_js: false }, { fetchFn: fn });
    expect(pricing.pages.map((p) => p.url)).toEqual(["https://crusonia.example.workers.dev/pricing"]);
    expect(isOwnHost(env, new URL("https://other.example.workers.dev"))).toBe(false);
  });

  test("when every reader fails, the error says what the provider did first", async () => {
    const fn: FetchFn = async (u) => (u.includes("api.apify.com") ? new Response('{"error":{"type":"x","message":"over limit"}}', { status: 402 }) : new Response("nope", { status: 404 }));
    const err = await readWebsite(env, { url: "acme.dev", max_pages: 2, render_js: false }, { fetchFn: fn }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain("returned HTTP 404");
    expect(err?.message).toContain("Apify crawl failed");
    expect(err?.message).toContain("out of credit");
  });

  test("the landing copy matches the landing page source", () => {
    const dir = new URL("../web/src/landing/", import.meta.url);
    const source = readdirSync(dir).filter((f) => f.endsWith(".tsx")).map((f) => readFileSync(new URL(f, dir), "utf8")).join("\n");
    for (const line of LANDING_LINES) expect(source).toContain(line);
    expect(siteCopy().map((p) => p.path)).toEqual(["/", "/pricing"]);
  });
});

describe("Apify runs", () => {
  test("a run still going at the deadline is aborted, and the meter sees it start and end", async () => {
    const seen: string[] = [];
    const urls: string[] = [];
    const fn: FetchFn = async (u, init = {}) => {
      urls.push(`${init.method} ${new URL(u).pathname}`);
      if (u.includes("/abort")) return Response.json({ data: { id: "r1", status: "ABORTED", usageTotalUsd: 0.01 } });
      await new Promise((r) => setTimeout(r, 20));
      return Response.json({ data: { id: "r1", status: "RUNNING" } });
    };
    const err = await runActor("tok", "apify/google-search-scraper", {}, {
      timeoutSecs: 1,
      graceSecs: 0,
      maxChargeUsd: 0.25,
      fetchFn: fn,
      meter: { onRun: async (_a, run) => void seen.push(run.status) },
    }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain("aborted");
    expect(urls[0]).toBe("POST /v2/acts/apify~google-search-scraper/runs");
    expect(urls.at(-1)).toBe("POST /v2/actor-runs/r1/abort");
    expect(seen[0]).toBe("RUNNING");
    expect(seen.at(-1)).toBe("ABORTED");
  });

  test("the cost cap and trace retention come from the environment with sane defaults", () => {
    expect(maxChargeUsd({})).toBe(0.25);
    expect(maxChargeUsd({ APIFY_MAX_CHARGE_USD: "1.5" })).toBe(1.5);
    expect(maxChargeUsd({ APIFY_MAX_CHARGE_USD: "-1" })).toBe(0.25);
    expect(traceRetentionDays({})).toBe(DEFAULT_TRACE_RETENTION_DAYS);
    expect(traceRetentionDays({ TRACE_RETENTION_DAYS: "30" })).toBe(30);
    expect(traceRetentionDays({ TRACE_RETENTION_DAYS: "0" })).toBe(180);
  });
});

describe("MCP tools", () => {
  test("create_draft, save_research and add_leads advertise channels, batching and why-summaries; bad input is refused before the database", async () => {
    const server = createMcpServer({ PUBLIC_URL: "https://example.test" });
    const client = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    const schema = (name: string) => JSON.stringify(tools.find((t) => t.name === name)?.inputSchema);
    expect(schema("create_draft")).toContain("linkedin");
    expect(schema("create_draft")).toContain("citations");
    expect(schema("save_research")).toContain("why_summary");
    expect(schema("save_research")).toContain("contacts");
    expect(schema("add_leads")).toContain("evidence");
    expect(schema("add_leads")).toContain("links");
    expect(schema("save_profile")).toContain("change_note");
    const res = await client.callTool({ name: "create_draft", arguments: { lead_id: "lead_x", channel: "email", body: "hi" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("subject");
    await client.close();
  });
});

describe("qualification workflow: pause on missing evidence", () => {
  const workflow = {
    ...qualificationWorkflowSchema.parse({
      name: "Seed GTM",
      research_questions: [{ id: "owner", question: "Who runs outbound today?" }],
      evidence_requirements: [
        { id: "stage", description: "Funding stage (seed to Series A)" },
        { id: "hiring", description: "A sales or GTM hire in the last 90 days" },
        { id: "stack", description: "Tools they use", required: false },
      ],
      completion_criteria: ["Every required requirement has a source"],
    }),
    version: 2,
    updated_at: "2026-11-08T00:00:00Z",
  };

  test("required requirements without evidence are the gaps; optional ones never block", () => {
    expect(missingRequirements(workflow, ["stage"]).map((g) => g.id)).toEqual(["hiring"]);
    expect(missingRequirements(workflow, ["stage", "hiring", null])).toEqual([]);
    expect(missingRequirements(null, [])).toEqual([]);
    expect(missingEvidenceQuestion([{ id: "hiring", description: "A sales hire" }])).toContain("Missing required evidence: A sales hire");
    expect(qualificationWorkflowSchema.safeParse({ evidence_requirements: [{ id: "Has Space", description: "x" }] }).success).toBe(false);
  });

  test("the research message carries the workflow (not hardcoded, no extra call), or says there is none", () => {
    const msg = researchMessage("lead_1", workflow);
    expect(msg).toStartWith("Research lead lead_1 for Crusonia.");
    for (const part of ['"Seed GTM" v2', "[owner] Who runs outbound today?", "[hiring] (required) A sales or GTM hire", "[stack] (optional)", "Every required requirement has a source", "review_question"]) {
      expect(msg).toContain(part);
    }
    expect(researchMessage("lead_1")).toContain("No qualification workflow is set");
    expect(workflowBrief(null)).toBeNull();
  });

  test("save_research takes a review question instead of a score; manual drafts wait while a lead is in review", () => {
    expect(researchInputSchema.safeParse({ lead_id: "l", review_question: "Which Acme is it?" }).success).toBe(true);
    expect(researchInputSchema.safeParse({ lead_id: "l" }).success).toBe(false);
    expect(checkChannel(lead({ stage: "needs_review" }), { channel: "intro" })).toMatchObject({ ok: false, message: expect.stringContaining("waiting for review") });
  });
});

describe("lead finding", () => {
  test("a find run's leads and dedupe status come from its add_leads results; the strongest status wins", () => {
    const out = (results: unknown[]) => JSON.stringify({ results, counts: {} });
    const ev = (seq: number, output: unknown, name = "crusonia.add_leads", is_error = false): StoredEvent => ({ seq, type: "tool.completed", data: { name, output, is_error }, created_at: "2026-11-08T00:00:00Z" });
    const statuses = findStatusesFromEvents([
      ev(1, out([{ id: "a", status: "created" }, { id: "b", status: "known" }, { status: "skipped", reason: "no domain" }])),
      ev(2, [{ type: "text", text: out([{ id: "b", status: "merged" }, { id: "a", status: "merged" }]) }]),
      ev(3, out([{ id: "c", status: "added" }, { id: "d", status: "updated" }])), // older results
      ev(4, out([{ id: "x", status: "created" }]), "crusonia.add_leads", true),
      ev(5, out([{ id: "y", status: "created" }]), "crusonia.list_leads"),
      ev(6, "{ truncated"),
    ]);
    expect(Object.fromEntries(statuses)).toEqual({ a: "created", b: "merged", c: "created", d: "merged" });
  });

  test("find companies like a lead: the brief names the lead by id only and asks the agent to read it", () => {
    const summary = { markdown: "# Acme\n\n## Who buys\nSeed-stage SaaS.", version: 1, updated_at: null, updated_by: null, change_note: null };
    const msg = findLeadsMessage(10, summary, "run_like", { likeLeadId: "lead_abc" });
    expect(msg).toStartWith("Find up to 10 new leads");
    expect(msg).toContain("companies like lead lead_abc");
    expect(msg).toContain("get_lead");
    expect(findLeadsMessage(10, summary, "run_plain")).not.toContain("companies like");
  });
});
