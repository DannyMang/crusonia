# Crusonia

GTM engine (a Clay/Apollo alternative run by AI agents). Cloudflare Worker (Hono) + Neon Postgres, with the dashboard
(React SPA in `web/`) served from the same Worker as static assets.
Agents (Naive, or your own Claude Code / Cursor / Codex) work through our MCP server at `/mcp`; AgentMail handles
email (opted-in leads only); Apify supplies web and lead data (our MCP tools call its REST API, and Naive agents can
also use Apify's hosted MCP server); HubSpot and Notion are synced; Clerk handles users; Stripe bills hosted usage
in credits (see [Billing](#billing-stripe)); the owner can approve drafts by iMessage through Photon (see
[iMessage approvals](#imessage-approvals-photon)).

Live: https://crusonia.veri-web.workers.dev/health · MCP: https://crusonia.veri-web.workers.dev/mcp

## Layout

| Path | What |
| --- | --- |
| `src/index.ts` | Worker entry: Hono app (`/`, `/health`, `/mcp`, `/api`, `/webhooks`) + minute cron; hands other paths to the web app's `ASSETS` binding when present |
| `src/env.ts` | `Env` type (vars + secrets) and `requireEnv` |
| `src/auth.ts` | Bearer tokens for `/mcp` and `/api`: an API key (`crs_live_...`, looked up by SHA-256) or `MCP_TOKEN` (constant-time compare) |
| `src/mcp/route.ts` | `/mcp`: MCP Streamable HTTP (stateless, JSON responses), fresh server per request |
| `src/mcp/server.ts` | MCP tool definitions: a thin layer over `src/services` |
| `src/api/*.ts` | REST routers: `auth` (Clerk, API key or `MCP_TOKEN`), `leads`, `approvals`, `workflows`, `settings`, signed `webhooks`; web app: `dashboard` (me, summary, status, replies), `onboarding` (Company summary, profile, read-website, propose), `keys`; `billing` (Stripe); `integrations` (CRM sync); `admin` (platform admins, read-only) |
| `src/billing/*.ts` | Stripe billing: `plans` (tiers, packs, the credit definition: the one file to edit), `accounts` (billing owner, ledger, 402 gate), `checkout` (Checkout and Customer Portal), `webhook` (Stripe events), `usage` (debits for finished Naive sessions), `expiry` (plan credit rollover), `overview`, `constants` |
| `src/services/*.ts` | Logic shared by MCP and REST: `leads`, `drafts`, `profile`, `status`, `apify`, `web`, `errors`; core loop: `crm` (lead admin, CSV import), `csv`, `approvals`, `approval-rules`, `send`, `inbound`, `classify`, `workflows` (Naive), `policy`, `settings`, `cron`; web app: `runs` (workflows/runs from Naive sessions and events, onboarding and find-leads sessions), `summary`, `replies`, `api-keys`; workspaces: `workspaces` (resolution, first sign-in), `team` (members, roles, creating workspaces), `invites` and `invite-email` (teammate invites), `company-summary` (the versioned markdown document), `naive-agents` (one Naive agent per workspace), `limits` (daily cap, rate limits), `domains` (company domain normalization); CRM sync: `crm-sync` (HubSpot/Notion push, HubSpot import, status), `crm-queue` (queue, retry, backoff), `crm-fields` (field mapping and ownership); `imessage` (notice queue for the bridge, owner commands, message wording) |
| `src/providers/*.ts` | Thin REST clients: `agentmail`, `naive`, `hubspot`, `notion` (the last two paced under their rate limits, 429-aware), `stripe` (no SDK, pinned API version) |
| `src/lib/*.ts` | Errors (`{error: {code, message}}`), request helpers, Web Crypto, webhook signatures |
| `test/*.test.ts` | `bun test`; `db.integration.test.ts` runs only with `TEST_DATABASE_URL` (a dev branch) |
| `src/db.ts` | Neon HTTP driver (`getSql`), row types, `getLead`, `logEvent` |
| `src/schema.sql` | Idempotent Postgres schema |
| `scripts/migrate.ts` | Applies the schema to Neon (Bun) |
| `scripts/setup.ts` | Creates the AgentMail inbox/webhook and the Naive webhook, vault and research agent; `--stripe`: billing products, prices, portal and webhook (`scripts/lib/stripe-setup.ts`); `--crm`: HubSpot properties and the Notion leads database (`scripts/lib/crm-setup.ts`) (Bun) |
| `scripts/lib/naive-agent.ts` | The Naive agent definition: tools and permissions, MCP servers, model, budget |
| `playbooks/research.md` | The research agent's system prompt (versioned in its front matter) |
| `bridge/` | iMessage bridge (Bun, Photon Spectrum): its own package, Dockerfile, tests and `deploy/aws.sh`. See [iMessage approvals](#imessage-approvals-photon) |
| `web/` | Dashboard SPA (React + Vite + Tailwind, Clerk sign-in), built to `web/dist` and served as static assets. See [Web app](#web-app) |
| `wrangler.jsonc` | Worker config (cron every minute, `PUBLIC_URL`, static assets with `/api`, `/mcp`, `/webhooks`, `/health` routed to the Worker first) |
| `worker-configuration.d.ts` | Generated runtime types (`bun run cf-typegen`) |

## Setup, in order

1. **Keys**: `cp .dev.vars.example .dev.vars` and fill in what you have. Each key says where to get it.
   Generate `MCP_TOKEN` with `openssl rand -hex 32`.
2. **Migrate**: `bun run migrate` (reads `DATABASE_URL` from the environment or `.dev.vars`; safe to re-run).
3. **Deploy**: `bun run deploy`. The workers.dev URL is already in `wrangler.jsonc` as `PUBLIC_URL`;
   update it if the URL ever changes.
4. **Upload secrets**: `bun run secrets` (= `wrangler secret bulk .dev.vars`). Never pass secrets as CLI arguments.
5. **Provider setup**: `bun run setup --write` creates the AgentMail inbox + webhook, the Naive webhook + vault
   credentials and the Naive research agent, and writes `AGENTMAIL_INBOX_ID`, `AGENTMAIL_WEBHOOK_SECRET`,
   `NAIVE_WEBHOOK_SECRET`, `NAIVE_VAULT_ID`, `NAIVE_AGENT_ID` into `.dev.vars` (drop `--write` to only print them).
   Idempotent; providers without a key are skipped. See [The research agent](#the-research-agent).
6. **Upload again and redeploy**: `bun run secrets && bun run deploy`.
7. **Billing (optional)**: see [Billing (Stripe)](#billing-stripe).
8. **CRM sync (optional)**: off until you turn it on; see [CRM sync](#crm-sync).
9. **iMessage approvals (optional)**: off until you turn it on; see [iMessage approvals](#imessage-approvals-photon).

### Staging

A second Worker, `crusonia-staging` (`env.staging` in `wrangler.jsonc`, its own `PUBLIC_URL`), for demos and
testing against real providers without touching production. Its secrets live in `.dev.vars.staging` (gitignored):
point `DATABASE_URL` at a Neon dev branch, use a Stripe test key and a separate `MCP_TOKEN`.

1. `bun scripts/migrate.ts --env staging` (reads `DATABASE_URL` from `.dev.vars.staging`).
2. `bun run deploy:staging`, then `bun run secrets:staging`.
3. `bun run setup --env staging --write`: its own AgentMail webhook (on the same inbox), Naive webhook, vault and
   agent ("Crusonia Research (staging)", so setup never repoints the production agent), written to
   `.dev.vars.staging`. `bun run setup --env staging --stripe` writes `.dev.vars.staging.stripe.test`. Upload both
   (`bun run secrets:staging`, `bunx wrangler secret bulk .dev.vars.staging.stripe.test --env staging`).

Naive delivers every webhook to every registered endpoint, so each Worker sees the other's sessions. Both ignore
sessions they did not start (logged as `naive_unknown_session`). A shared AgentMail inbox means production also
stores staging's inbound replies, as unmatched messages.

## Connect your agent (MCP)

Endpoint: `https://crusonia.veri-web.workers.dev/mcp` (MCP Streamable HTTP; locally `http://localhost:8787/mcp` with
`bun run dev`). Every request needs `Authorization: Bearer <token>`: an API key, or the `MCP_TOKEN` secret (owner).

API keys: create one per agent with `POST /api/keys {"name": "Claude Code"}` (the web app's Settings › API keys, or
"Create key" in the Connect your agent popover). The response shows the full key (`crs_live_` + 64 hex characters)
once; only its SHA-256 hash is stored. `GET /api/keys` lists keys without secrets, `DELETE /api/keys/:id` revokes one
immediately. A key acts on `/mcp` and `/api` for the workspace it was made in, and only that one; `MCP_TOKEN` is the
owner workspace. Keep the token in an environment variable, not in files you commit:

```sh
export CRUSONIA_MCP_TOKEN='crs_live_...'   # an API key (or MCP_TOKEN), e.g. in ~/.zshrc
```

**Claude Code**: add it for all your projects. Keep the single quotes: Claude Code stores the literal
`${CRUSONIA_MCP_TOKEN}` and expands it when it connects, so the token never lands in `~/.claude.json`.
`--header` must come after the URL.

```sh
claude mcp add --transport http --scope user crusonia https://crusonia.veri-web.workers.dev/mcp \
  --header 'Authorization: Bearer ${CRUSONIA_MCP_TOKEN}'
```

Or share it with the team through a project `.mcp.json` (same `${VAR}` expansion; each person approves it once):

```json
{
  "mcpServers": {
    "crusonia": {
      "type": "http",
      "url": "https://crusonia.veri-web.workers.dev/mcp",
      "headers": { "Authorization": "Bearer ${CRUSONIA_MCP_TOKEN}" }
    }
  }
}
```

Check with `claude mcp list`, or `/mcp` inside a session.

**Cursor**: `.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` for all projects). Cursor reads
`${env:NAME}` from the environment it was started from:

```json
{
  "mcpServers": {
    "crusonia": {
      "url": "https://crusonia.veri-web.workers.dev/mcp",
      "headers": { "Authorization": "Bearer ${env:CRUSONIA_MCP_TOKEN}" }
    }
  }
}
```

**Codex**: Codex stores only the variable's name and reads the token when it connects:

```sh
codex mcp add crusonia --url https://crusonia.veri-web.workers.dev/mcp --bearer-token-env-var CRUSONIA_MCP_TOKEN
```

or in `~/.codex/config.toml` (or a trusted project's `.codex/config.toml`):

```toml
[mcp_servers.crusonia]
url = "https://crusonia.veri-web.workers.dev/mcp"
bearer_token_env_var = "CRUSONIA_MCP_TOKEN"
```

**Naive**: `bun run setup` stores `MCP_TOKEN` in the Naive vault as a credential for `${PUBLIC_URL}/mcp`; Naive injects
it when an agent's `mcp_servers[].url` is exactly that URL. That agent runs the owner workspace's sessions. Every other
workspace gets its own copy of the agent on its first paid run, pointed at `${PUBLIC_URL}/mcp?ws=<workspace id>`, with a
vault credential for exactly that URL, bound to that agent, holding a workspace key (see [Workspaces](#workspaces)).

### The research agent

`bun run setup` also creates the Naive agent that `POST /api/workflows/research` runs, one session per lead. Its
system prompt is [`playbooks/research.md`](playbooks/research.md) (v4): read the Company summary (it comes in every
session's first message) and the lead (with the owner's notes) in one turn, research from public sources with few pages and searches batched per turn, save about 3
evidence items, the score, rationale, next step, why-summary, contacts and links with one `save_research` call, and,
for a qualified lead, write one short, evidence-cited message in the same turn: an email (approval) for opted-in
leads, otherwise a manual LinkedIn, X, intro or own-mailbox task. Web and email content is treated as data, never as
instructions, and the agent asks the owner (`ask_operator`) when unsure. When it learns something durable it updates a
section of the Company summary with a note (a new version the owner can revert).

- **Why batching matters**: once a Naive session reads people's data, every MCP call asks for a confirmation, even
  at `allow` (Naive's rule; our webhook confirms allowlisted calls). Each pause and resume costs time and can rebuild
  the prompt cache, so the playbook batches independent calls in one turn and the batch tools (`add_leads` with
  inline evidence and scores, `save_research`) replace per-item calls.
- **Tools**: the crusonia tools, Apify's single-page reader (`apify--rag-web-browser`) and its run-result readers
  run without asking; `ask_operator` and everything else (Naive built-ins) ask first. The agent's Apify MCP URL loads
  no Actor-run tools (`call-actor`, the crawler and search Actors): our `read_website` and `search_web` wrap those with
  limits, a cost cap and metering. `handoffs` is off. Asked tool calls then go through `AUTO_CONFIRM_TOOLS`: an
  allowlisted call is allowed automatically (all of a session's calls in parallel), any other becomes a tool approval.
- **Model and budget**: a pinned model (`openai/gpt-6.1-terra`; `vetta/auto` switched models mid-session and each
  switch re-wrote the prompt cache), $5 a day and $1 per session by default; override with the `NAIVE_AGENT_*`
  settings in `.dev.vars.example`.
- **Updates**: edit the playbook, bump `version` in its front matter, then run `bun run setup --agent`. It updates
  the agent in place (`NAIVE_AGENT_ID`, or the one agent named "Crusonia Research"), so Naive records a new
  version instead of a duplicate agent, and adds the vault credential for the agent's Apify MCP URL when that URL
  changed (needs `NAIVE_VAULT_ID`, `APIFY_TOKEN` and an admin-scoped key). Running sessions keep the version they
  started with.

### Tools

| Tool | What it does |
| --- | --- |
| `get_status` | Configured providers, database reachability, the workspace's lead counts by stage, open approvals, Company summary version, next steps. Works with no keys. |
| `read_website` | Reads a site (homepage + about/product/pricing pages, never sign-in/sign-up) and returns trimmed text per page. Apify crawler with `APIFY_TOKEN`, retried with JavaScript rendering when a site returns no text (SPAs); plain fetch without. Crusonia's own host is read from its landing copy. |
| `search_web` | Google search via Apify (`APIFY_TOKEN`): organic results and related queries. |
| `get_company_summary` | The workspace's Company summary: one markdown document, with its version and who last changed it. |
| `update_company_summary` | `{markdown, note, section?, run_id?}`: replaces the whole document, or only the section with that heading (appended if missing). Every edit is a new version. |
| `save_profile` / `get_profile` | Structured aliases of the Company summary (company, website, sells, ICP, segments, signals, sources). `save_profile` takes a `change_note`; `get_profile` also returns the markdown, the owner's recent notes on leads and the companies future runs skip. |
| `add_leads` | Upserts found companies and people, one lead per company (keyed by the normalized company domain, never a job board or other host): new contacts, links and evidence merge into a known company; disqualified or excluded companies are skipped. Optional inline `evidence`, `score`/`qualified`/`rationale` and `why_summary`. Returns `created` / `merged` / `known` / `skipped` per lead. No consent: never emailed. New leads record the run that found them (`cohort`). |
| `list_leads` / `get_lead` | Leads by stage; one lead with its contacts, links, why-summary, evidence (numbered), drafts, approvals and notes. |
| `save_research` | One call per researched lead: evidence (about 3, deduped), score, qualified, rationale, next step, why-summary (citing evidence by number), contacts and links. Returns the channels it may be drafted on. |
| `save_evidence` / `score_lead` | Fix a single evidence item or score. |
| `create_draft` | `channel` `email` (default): opted-in leads only, new immutable version + pending send approval (7 days by default). `linkedin`, `x`, `intro`, `email_manual`: qualified leads, consent not needed, saved as a task the owner sends personally; must cite saved evidence (`citations`). Sends nothing. |
| `list_pending_approvals` | Approvals waiting for a human, with the draft. |
| `list_tasks` | The manual outreach queue: open tasks with the lead, text, citations and the profile to open. |
| `add_note` | A note on a lead for the owner and later agents. |

Every tool acts on the caller's workspace only. Every write also appends an `events` row. No tool sends anything or
decides an approval: an email goes out only after a human approves it, and a manual message only when the owner sends
it themselves. For workspaces other than the owner's, `search_web` and `read_website` (when they use Apify) need
credits and are rate-limited (`WEB_CALLS_PER_HOUR`).

## REST API

The dashboard (`web/`) is built on this API. Every `/api/*` call needs `Authorization: Bearer <token>`: a Clerk session
token (any user who signs up; see [Workspaces](#workspaces)), an API key (`crs_live_...`), or `MCP_TOKEN` (the owner
workspace). Every call acts on exactly one workspace, and every row it reads or writes belongs to it.
Errors are always `{"error": {"code", "message", "details?"}}`; a missing key answers 503 `not_configured` naming it.
Lists are `{"data": [...]}` (plus `next_cursor` where paginated).

| Method | Path | What |
| --- | --- | --- |
| GET | `/api/leads` | List, newest first. Filters `stage`, `min_score`, `source`, `q` (email/name/company/domain); `limit` + `cursor`. Each row has `notes_count` and `rating` (`up` / `down` / null: the latest thumbs note) |
| POST | `/api/leads` | Create an opted-in contact (`email`, optional `consent: {text, at?}`) |
| POST | `/api/leads/import` | CSV import: JSON `{csv, mapping?, source?, dry_run?}` or a `text/csv` body. Dedupes by email, then company domain + name; reports created/updated/skipped per row |
| GET | `/api/leads/:id` | Lead (with `contacts`, `links`, `why_summary`, `next_step`) with evidence (numbered `n`), drafts, approvals, notes, messages, Naive sessions and the event timeline |
| GET, POST | `/api/leads/:id/notes` | Notes on the lead, newest first / add `{body, kind?}` (`note`, or `thumbs_down` / `thumbs_up` with the reason as body) |
| PATCH, DELETE | `/api/leads/:id/notes/:note_id` | Edit `{body}` / delete one of your own notes |
| POST, DELETE | `/api/leads/:id/exclude` | Exclude the company `{reason?}` (future runs skip it; the reason is kept as a thumbs-down note) / un-exclude it |
| PATCH | `/api/leads/:id` | Stage, consent (`null` revokes and closes pending send approvals), basic fields |
| DELETE | `/api/leads/:id` | Delete (cascades; the audit events stay) |
| POST | `/api/leads/:id/drafts` | Owner-written draft: new version + send approval (opted-in, unsuppressed leads only) |
| GET | `/api/tasks` | Manual outreach tasks: `status` (`open` default, `sent`, `skipped`, `superseded`, `all`), `channel`, `lead_id`, `limit`. Each has the text, `citations`, `target_url` and `open_url` (profile, or a `mailto:` for `email_manual`), and the lead; plus `open_total` |
| GET | `/api/tasks/:id` | One task |
| POST | `/api/tasks/:id/sent` | `{body?, note?}`: the owner sent it (`body` = the text actually sent). Records an outbound message on the task's channel and moves the lead to `sent`; once |
| POST | `/api/tasks/:id/skip` | `{reason?}`: not sending it; the stage is unchanged |
| POST | `/api/tasks/:id/regenerate` | `{instructions?}` -> `{session_id}`: a Naive session writes a new version on the same channel (paid like research) |
| GET | `/api/approvals` | `status` (default `pending`), `kind`, `lead_id`. Rows carry `texted_at` (when the iMessage notice went out, else null) |
| GET | `/api/approvals/:code` | One approval |
| POST | `/api/approvals/:code/approve` | send: re-checks every rule, then sends via AgentMail. tool: allow (`scope`) |
| POST | `/api/approvals/:code/reject` | send: reject the draft. tool: deny |
| POST | `/api/approvals/:code/edit` | New draft version + new approval (also the retry after expiry or a failed send) |
| POST | `/api/approvals/:code/answer` | tool: `{decision, reason?, scope?}`; question: `{answers: {field: text}}`, forwarded to Naive |
| POST | `/api/workflows/research` | `{lead_ids}` or `{cohort}`: one Naive session per lead (`NAIVE_AGENT_ID`) |
| GET, PUT | `/api/settings/pause` | The workspace's kill switch: no sends, no new sessions, no auto-allowed tools |
| GET, POST | `/api/suppressions` | List (`q`, `cursor`) / add `{email, reason?}` |
| DELETE | `/api/suppressions/:email` | Remove |
| GET | `/api/me` | `{user: {id, email?, name?}, auth: "clerk" \| "token", workspace: {id, name, owner, role}}` |
| GET, POST | `/api/workspaces` | The caller's workspaces with their role in each (`current`, `data`) / create one `{name}`. See [Teams](#teams) |
| PATCH | `/api/workspaces/current` | Rename `{name}` (owner, admin) |
| GET | `/api/team/members` | The workspace's members, with names and emails from Clerk |
| PATCH, DELETE | `/api/team/members/:userId` | Change a role `{role}` / remove (owner, admin) |
| POST | `/api/team/leave` | Leave the workspace (409 `last_owner` for the last owner) |
| GET, POST | `/api/team/invites` | Open invites / invite `{email, role?}` (owner, admin; 429 `invite_rate_limited`) |
| POST | `/api/team/invites/:id/resend` | New link, new 7 days; the old link stops working (owner, admin) |
| DELETE | `/api/team/invites/:id` | Revoke (owner, admin) |
| GET | `/api/invites/:token` | No auth: what the invite link shows (404 `invite_not_found`; 410 `invite_used`, `invite_revoked`, `invite_expired`) |
| POST | `/api/invites/:token/accept` | Clerk session only: join (403 `invite_email_mismatch`) |
| GET | `/api/summary` | Home: `pipeline` (cumulative: how many leads got at least to found, researched, drafted, sent, replied, meetings; plus `awaiting_approval` now), `pipeline_now` (where leads are now, one bucket each), `tasks_open`, top 5 `pending_approvals`, `pending_approvals_total`, `pending_sends_total` (send approvals only), `active_workflows`, 5 `recent_replies`, `spend` (`week_usd` and `week_credits`: credits charged in the last 7 days; `provider_usd`: the raw Naive + Apify cost behind them; `budget_usd` from `WEEKLY_BUDGET_USD`; `day_usd` and `daily_cap_usd` for the workspace's daily cap), `paused` |
| GET | `/api/status` | `get_status` data plus `workspace_id`, `inbox_address`, `naive_agent_configured`, `mcp_url`, `agent_mcp_url` (the workspace's Naive agent URL), `billing` (`configured`, `webhook_configured`, `mode`, `enforced`), `crm_sync` (per target: enabled, configured, active, queue_depth, failed, last_sync_at, last_error), `imessage` (owner workspace only: `enabled`, `active`, `missing`, `owner_phone_hint` (last 4 digits only), `bridge` as last reported with `online`, `undeliverable_notices`) |
| GET | `/api/company-summary` | `{markdown, version, updated_at, updated_by, change_note}` (version 0 and a suggested `template` before the first save) |
| PUT | `/api/company-summary` | `{markdown, note?, base_version?}`: a new version (409 `version_conflict` if `base_version` is stale; 413 over 20,000 characters; an unchanged document saves nothing) |
| GET | `/api/company-summary/versions` | Versions newest first, without bodies: `{version, author, change_note, created_at, chars}` (`limit`, `before`) |
| GET | `/api/company-summary/versions/:version` | One version with its markdown |
| POST | `/api/company-summary/revert` | `{version}`: a new version copied from that one |
| GET, PUT | `/api/profile` | Older alias: `{profile}` (company, website, sells, icp_description, segments, signals, sources) read from the Company summary; PUT writes those parts into it as a new version and keeps its other sections |
| POST | `/api/onboarding/read-website` | `{url, max_pages?, render_js?}` -> `{pages: [{url, title, text}], mode, rendered?, note?}`. Synchronous; Apify crawler with `APIFY_TOKEN` (a few cents, metered), retried with JavaScript rendering when it finds no text, else a plain fetch |
| POST | `/api/onboarding/propose` | `{url?, description?}` -> `{session_id}`: a Naive session reads the site / description and writes the Company summary (author `onboarding`; a description is also saved as v1 right away) |
| GET | `/api/onboarding/propose/:session_id` | `{status: "running" \| "done" \| "error", profile?}`; poll it (refreshes from Naive while active) |
| POST | `/api/leads/find` | `{count?, like_lead_id?}` (25, max 50) -> `{session_id}`: a Naive session finds leads matching the Company summary (or companies like that lead), adds and scores them |
| GET | `/api/leads/find/:session_id` | `{run, leads}`: the leads that find run touched, each with `find_status` `created` / `merged` / `known` (from its add_leads results in the stored trace) |
| GET | `/api/workflows` | Naive sessions grouped by purpose: `{id, name, purpose, status, started_at, leads_processed, cost_usd, last_event_at, runs}` |
| GET | `/api/workflows/runs/:session_id` | `{run, steps, lead, approvals}`: the clean timeline. Steps from Naive's events and our audit events, sorted by time; a tool call that waited for a confirmation is one step with `approval: {decision, via, code?, waited_ms}`, and pauses only the auto-confirm policy resolved are left out |
| GET | `/api/workflows/runs/:session_id/trace` | The full trace: stored Naive events (`after_seq`, `limit` up to 1000; `has_more`, `next_after_seq`), plus the run, our audit events, approvals and `spend` (Naive cost, credits debited, Apify runs). Kept `TRACE_RETENTION_DAYS` (180) |
| GET | `/api/workflows/runs/:session_id/trace/export` | The whole trace as a JSON file download |
| GET | `/api/replies` | Inbound replies with their lead: `{id, lead_id, from, subject, preview, label, received_at}`; `limit`, `cursor`, `label`, `lead_id` |
| GET, POST | `/api/keys` | API keys for `/mcp` and `/api`: list (no secrets) / create `{name}` (full key returned once) |
| DELETE | `/api/keys/:id` | Revoke |
| GET | `/api/billing` | The caller's `plan` (key, status, `current_period_end`, `cancel_at_period_end`), `balance` (credits) and `balance_usd`, `expiring` included credits, the last 20 `ledger` rows, and the `plans` and `packs` with display prices |
| POST | `/api/billing/checkout` | `{plan}` or `{pack}` -> `{url}`: a Stripe Checkout Session (subscription or one-time). 409 `already_subscribed` for a second plan |
| POST | `/api/billing/portal` | -> `{url}`: the Stripe Customer Portal (change or cancel the plan, invoices, payment methods) |
| GET | `/api/integrations/crm` | CRM sync per target (`hubspot`, `notion`): `enabled`, `configured`, `active`, `missing`, `scope`, `last_success_at`, `last_error`, `queue {pending, due, failed}`, `recent_errors`, `warnings`; HubSpot also `import` (running job) and `last_import` |
| POST | `/api/integrations/sync` | `{target, lead_ids?}`: queue those leads (even outside the scope) or every lead in the scope. 409 `sync_disabled` while the target's switch is off |
| POST | `/api/integrations/hubspot/import` | Queue the HubSpot import (contacts, then companies, 100 per minute). Needs only the token; 409 while one runs. CRM sync is the owner workspace's only (403 `owner_only` elsewhere) |
| GET | `/api/admin/runs?workspace=` | Platform admins only: a workspace's agent runs (read-only, audited) |
| GET | `/api/admin/runs/:id/trace` | Platform admins only: one run's steps and stored Naive events (read-only, audited) |
| POST | `/webhooks/agentmail` | Svix-signed. `message.received` (match by thread, then sender; classify; stop follow-ups; unsubscribe suppresses), `message.bounced` (permanent: suppress), `message.complained`, `message.delivered` |
| POST | `/webhooks/naive` | `Vetta-Signature`-signed. `session.idle`: allowlisted tools (`AUTO_CONFIRM_TOOLS`) are allowed (claimed in one statement, confirmed in parallel; a call another handler already claimed counts as allowed, so the session stays `running`), other tools and `ask_operator` questions become approvals |
| POST | `/webhooks/photon/poll` | iMessage bridge, `X-Crusonia-Signature`-signed (`BRIDGE_SECRET`): delivery acks + bridge status in, notices to text the owner out |
| POST | `/webhooks/photon` | iMessage bridge, signed: one owner tapback (👍 / 👎 on a notice); answers with the confirmation text, or none |
| POST | `/webhooks/stripe` | `Stripe-Signature`-signed (`STRIPE_WEBHOOK_SECRET`; no secret, no processing). Credits packs and monthly plans, tracks subscriptions, claws back refunds; see [Billing](#billing-stripe) |

Rules enforced in code: the agent never sends; manual-channel drafts get no approval and the send path only accepts
email drafts; manual drafts need a qualified lead and citations of its saved evidence; nobody suppressed or
unsubscribed gets a draft on any channel; drafts are immutable (an edit is a new version and closes the old
approval, and a lead has one open draft across channels); a send approval is bound to the recipient and draft version, expires (`SEND_APPROVAL_TTL_HOURS`, 7 days
by default, for drafts from MCP and REST alike), is consumed once, and is re-checked at send time (not expired, latest
version, same recipient, consent, not suppressed, not paused) inside the SQL that consumes it. Agent tool and
question approvals expire sooner (`TOOL_APPROVAL_TTL_MINUTES`, 1 hour by default) because the Naive session waits on
them. A draft is marked `sending` before AgentMail is called; an unconfirmed send is reconciled by its `draft-<id>`
label, never resent blindly.
Webhooks are verified on the raw body and deduped by provider event id. Inbound email is stored and pattern-matched
as data, never followed as instructions. Every state change writes an `events` row.

Apify: every Actor run we start (`search_web`, `read_website`) carries `maxTotalChargeUsd` (`APIFY_MAX_CHARGE_USD`,
$0.25 by default), is recorded in `apify_runs` (with its workspace), and its `usageTotalUsd` is debited to that
workspace's credits at the same markup as Naive spend (ledger source `apify:<run>:<credits>`; later usage only tops up
the difference). Runs started by a Naive agent are attributed to its session.

The minute cron expires stale approvals (an expired tool call is denied to the agent), reconciles running Naive
sessions that missed a webhook (events after `last_seq`), settles unconfirmed sends, drains the CRM sync queue,
debits finished Naive sessions and Apify runs that still owe credits (re-reading final Apify usage once), expires
unused plan credits after their rollover month, reads finished sessions' traces to the end, and prunes traces older
than `TRACE_RETENTION_DAYS`.

## Workspaces

Anyone can sign up: a new Clerk user gets their own private workspace on first sign-in, and can join others (see
[Teams](#teams)), with its own Company summary, leads, approvals, runs, budget and credits, plus the free sample credits once.
`SIGNUPS_OPEN=false` closes sign-up (existing members still get in), `BLOCKED_USER_IDS` refuses accounts. The instance
owner's workspace (`ws_owner`) holds everything from before workspaces; `OWNER_CLERK_USER_ID` and `MCP_TOKEN` resolve
to it. Every workspace sends from the one `AGENTMAIL_INBOX_ID` (the owner's address), so only the owner's workspace
sends email; list other workspace ids in `SEND_WORKSPACE_IDS` to let them send too (otherwise approving their email
draft answers 403 `sending_not_enabled`).

API keys go to agents, so the REST routes that make a person's decisions refuse them with 403 `human_required`:
deciding approvals, creating or revoking keys, setting a lead's consent, removing a suppression, and billing
(`src/api/guards.ts`). A Clerk session (the app) or `MCP_TOKEN` can do all of these.

| Caller | Workspace |
| --- | --- |
| Clerk session | One of the user's (`workspace_members`): the one in `X-Crusonia-Workspace` if they belong to it (403 `not_a_member` otherwise, checked on every request), else their oldest; the owner workspace by default for `OWNER_CLERK_USER_ID`; created on first sign-in for a user with none |
| `crs_live_` key | The key's (`api_keys.workspace_id`); a header naming another one is refused (403) |
| `MCP_TOKEN` | The owner's |
| AgentMail webhook | The workspace of the draft or thread the message is about; a reply matched only by its sender counts only if one workspace has that lead; anything else lands in the owner's (the inbox is the instance's) |
| Naive webhook, cron | The session's (`naive_sessions.workspace_id`) |
| Stripe webhook | The account linked to the customer, else the metadata `crusonia_workspace_id` (objects from before workspaces carry `crusonia_user_id`, mapped to the workspace it moved to) |

Every tenant table has a `workspace_id`, and every service function takes the workspace and filters by it. Lead dedupe
is per workspace: by email, else by company domain + name, where the domain is normalized to the registrable domain
(`blog.acme.co.uk` -> `acme.co.uk`, also enforced by a trigger), so a company is stored once per workspace.

### Teams

A workspace can have several people, and a person can be in several workspaces. We use our own `workspace_members` and
`workspace_invites` tables rather than Clerk Organizations: it needs no Clerk dashboard change, the membership check sits
next to the data it protects, and the invite email is ours (`AGENTMAIL_INBOX_ID`).

| Role | Can |
|---|---|
| `member` | The everyday work: leads, drafts, approvals, runs, the Company summary. Can read but not manage billing, API keys, the team or integrations |
| `admin` | Also billing, API keys, integrations and the team; can't change or remove an owner, or make one |
| `owner` | Everything. Only an owner can make or change an owner. The last owner can't leave or be demoted (409 `last_owner`) |

The app names the current workspace with `X-Crusonia-Workspace`. It's only a request: the membership is read from the
database on every request, with no cache, so someone removed is out on their next call. API keys and `MCP_TOKEN` are bound
to their workspace, and an agent can't reach `/api/team`. Removing someone (or them leaving) also revokes the API keys they
made and the invites they sent there.

**Invites.** A token is 32 random bytes, sent only in the email and stored only as a hash. It works once, for 7 days, and
only for a signed-in Clerk user with the invited address among their verified emails (read from Clerk). Resending mints a
new token and the old link stops working. Accepting works while `SIGNUPS_OPEN=false`, and makes no workspace of the
invitee's own.

The email goes out from the instance's inbox as a fixed template, from any workspace (unlike outreach, `SEND_WORKSPACE_IDS`
doesn't apply), so it's locked down: no custom message, names are escaped, a name that looks like a link isn't shown,
addresses on the workspace's or the instance's do-not-contact list are refused (so a complaint stops them everywhere),
nothing goes out while the workspace is paused, and the link is built from `PUBLIC_URL`. Limits over 24 hours, shared by
invites and resends: `INVITES_PER_WORKSPACE_PER_DAY` (20), `INVITES_PER_USER_PER_DAY` (30, across workspaces),
`INVITES_PER_EMAIL_PER_DAY` (3, across workspaces), `INVITES_PER_INSTANCE_PER_DAY` (200).

**Making workspaces.** Up to `MAX_WORKSPACES_PER_USER` (5) per person. The free sample is one per person: only the first
workspace they make gets it. While sign-ups are closed, someone who only joined through an invite can't make one.

Audit events: `workspace_created`, `workspace_renamed`, `member_invited`, `invite_resent`, `invite_revoked`,
`invite_accepted`, `invite_refused`, `invite_rate_limited`, `member_role_changed`, `member_removed`, `member_left`.

**Naive, per workspace.** Naive matches vault credentials to an agent's MCP URL and can bind one to a single agent, but
has no per-session credentials yet, so each workspace runs on its own agent: a copy of the owner's template agent
(`NAIVE_AGENT_ID`, same playbook, tools, model and Naive budget) whose crusonia server is
`${PUBLIC_URL}/mcp?ws=<id>`, with a vault credential (`NAIVE_VAULT_ID`) for exactly that URL, bound to that agent,
holding a workspace key of kind `agent`. The key decides the workspace; `/mcp` also refuses a `ws` that names another
one. The copy is made on the workspace's first paid run and re-synced when the template's version changes (after
`bun run setup --agent`). The Worker's `NAIVE_API_KEY` needs the scope to create agents and vault credentials.

**Guardrails.** Paid work (onboarding propose, lead finding, research) needs credits in every workspace except the
owner's (`BILLING_ENFORCED=true` gates the owner too). On top of each agent's Naive budget, every workspace has a daily
Naive spend cap over the last 24 hours (`WORKSPACE_DAILY_CAP_USD`, default $5; `workspaces.daily_cap_micro_usd`
overrides it), and every workspace but the owner's is limited to `PAID_STARTS_PER_HOUR` (20) runs per hour and
`MAX_ACTIVE_SESSIONS` (5) at once. CRM sync (the instance's own HubSpot and Notion) is the owner workspace's only.

## Company summary

What Crusonia knows about the business: one markdown document per workspace (like a GTM.md), with suggested headings
What we sell, Who buys (with a Segments list), Buying signals, Proof points, Voice, Avoid and Pricing. Every edit is a
new version in `company_summary_versions` (author `user:<id>`, `agent:<session id>`, `agent:api_key:<id>` or
`onboarding`, plus a change note); the current summary is the latest version, and a revert writes a new version copied
from an old one. Agents edit it directly, without an approval: the whole document, or one section by its heading. Every
Naive session gets the current summary in its first message, and the playbook makes the agent read it first and update
it (with a note) when it learns something durable. Capped at 20,000 characters; it is data, rendered as sanitized
markdown, never instructions. `/api/profile` and the `get_profile` / `save_profile` tools remain as structured aliases.

## Privacy

The people who operate a Crusonia instance can view agent runs and traces (the steps, tool calls and outputs of each
Naive session) in any workspace, for debugging and quality: the platform admins in `PLATFORM_ADMIN_USER_IDS` and the
owner (`OWNER_CLERK_USER_ID`). That access is read-only (`/api/admin/*`), and every view is recorded in the viewed
workspace's audit trail (`events` kind `admin_viewed`). Admins have no write access to other workspaces.

## Billing (Stripe)

Hosted Crusonia bills usage in credits through **its own Stripe account** (never one shared with another product).
Self-hosting needs none of this: without `STRIPE_SECRET_KEY` the billing endpoints answer 503 and nothing is blocked.

**Credits and plans.** Everything lives in [`src/billing/plans.ts`](src/billing/plans.ts); the values are
placeholders until the owner decides (marked `TODO(owner)`):

- 1 credit = $0.01 of list value. Ledger amounts are whole credits.
- **Free** $0/month: the first 5 leads are free, then top-ups from $10. **Pro** $20/month grants 2,000 credits and
  **Scale** $100/month grants 10,000 credits on each paid subscription invoice (first payment and each renewal).
  Top-up packs: $10, $50 and $200 for 1,000, 5,000 and 20,000 credits.
- A free sample of 300 credits (about 5 leads) is granted once per billing account; `BILLING_FREE_CREDITS` changes
  it, `0` turns it off.
- Usage: when a Naive session finishes, the billing owner that started it is debited its reported spend
  (`naive_sessions.consumed_micro_usd`) times 2, rounded up: $0.30 of agent spend = 60 credits. A session that
  resumes and spends more is topped up; nothing is debited twice. Data calls (Apify) are not metered yet.
- The amount paid never decides the credits (coupons, tax and rounding change what is paid, not what is granted).
- Unused included plan credits roll over for one month after the period they were granted for, then expire (the
  minute cron writes an `expire` row for what is left). Usage spends the soonest-expiring credits first. Top-up packs
  and the free sample never expire.
- Plan changes in the portal apply without proration; the new plan's credits arrive with its next paid invoice.

To change pricing: edit `plans.ts`, run `bun run setup --stripe`, deploy. Prices are found by `lookup_key`, so no
Stripe ids live in this repo; a changed amount gets a new price that takes over the lookup key (existing
subscribers keep their old price, which still maps to its plan through its metadata).

**Who pays.** The workspace (whichever way its people or agents sign in). Each workspace has one billing account and one
Stripe customer, created by us and found by workspace only (never matched by email). Every object we create carries
metadata `app: crusonia` and `crusonia_workspace_id` (objects from before workspaces carry `crusonia_user_id`) (customers, Checkout Sessions, subscriptions through
`subscription_data.metadata`, payment intents), and the webhook ignores objects without `app: crusonia`.

**Ledger.** `credit_ledger` is append-only (a trigger refuses updates and deletes); the balance is the sum per owner.
Each row's `source` makes it idempotent: `signup:<owner>`, `checkout:<session>`, `invoice:<invoice>` (with
`expires_at`), `usage:<naive session>`, `refund:<charge>:<amount refunded>`, `expire:<grant source>`.

**Webhook events** (`POST /webhooks/stripe`, signature verified on the raw body, deduped by event id in
`webhook_events`, every event written to `events`):

| Event | Effect |
| --- | --- |
| `checkout.session.completed` | Credit pack: credited only when `payment_status` is `paid`. Subscription: links the subscription |
| `checkout.session.async_payment_succeeded` | Credits a pack whose payment settled later (same source: never twice) |
| `invoice.paid` | Grants the plan's monthly credits for `subscription_create` and `subscription_cycle` invoices, once per invoice |
| `customer.subscription.created` / `.updated` / `.deleted` | Plan, status, period end and cancel-at-period-end on the account (older events never overwrite newer ones) |
| `charge.refunded` | Claws back the purchase's credits in proportion to the amount refunded, minus any that already expired (packs by PaymentIntent, plan invoices through the Invoice Payments API) |

**Turn it on (test mode first).**

1. Create Crusonia's Stripe account, stay in test mode, and put its test secret key in `.dev.vars` as
   `STRIPE_SECRET_KEY=sk_test_...` (or a restricted `rk_test_` key, see below).
2. `bun run migrate` (adds `billing_accounts`, `credit_ledger` and `naive_sessions.billing_owner_id`).
3. `bun run setup --stripe`: creates or updates the products and prices, the Customer Portal configuration (switch
   plan, cancel at period end, invoices, payment methods) and the webhook endpoint `${PUBLIC_URL}/webhooks/stripe`
   for the events above, pinned to the API version in `src/providers/stripe.ts`. The webhook signing secret is
   written to `.dev.vars.stripe.test` (mode 600, gitignored) and never printed. Add `--verify-checkout` to create
   and expire one test Checkout Session. Safe to re-run; `--rotate-webhook-secret` replaces the endpoint and secret.
4. Upload both secrets and deploy: `bun run secrets` (uploads `STRIPE_SECRET_KEY` from `.dev.vars`),
   `bunx wrangler secret bulk .dev.vars.stripe.test`, `bun run deploy`. For `wrangler dev`, copy the
   `STRIPE_WEBHOOK_SECRET` line into `.dev.vars`.
5. Try it: `POST /api/billing/checkout {"pack": "small"}`, open the URL, pay with test card `4242 4242 4242 4242`,
   then `GET /api/billing` shows 1,000 more credits.
6. When you want limits: set `BILLING_ENFORCED=true` (a var or secret). Starting paid work (onboarding propose,
   `POST /api/leads/find`, research workflows) then answers 402 `insufficient_credits` when the caller's balance is
   0 or less. It is off by default so the owner's own use never blocks, and `MCP_TOKEN` always bypasses it.

**Going live.** Activate the Stripe account (business and bank details), create a live restricted key (`rk_live_`)
and put it in `.dev.vars` as `STRIPE_SECRET_KEY`, then run `bun run setup --stripe --live` (setup refuses a live key
without `--live`), upload `.dev.vars.stripe.live` and the key as in step 4, and deploy. A restricted key needs write
access to Products, Prices, Customer portal and Webhook endpoints for setup, and write access to Customers, Checkout
Sessions and Customer portal plus read access to Prices and Invoices (invoice payments, for refunds) for the Worker.

## CRM sync

Crusonia keeps HubSpot and a Notion database up to date with its leads, and imports HubSpot contacts and companies.
Both targets are **off by default**: nothing is written to HubSpot or Notion until `HUBSPOT_SYNC_ENABLED` /
`NOTION_SYNC_ENABLED` is `true`. The HubSpot import only reads HubSpot and works with just the token.

### Field ownership

HubSpot owns relationship data; Crusonia owns research and operational history. The rules
(`src/services/crm-fields.ts`):

| Field | Owner | Rule |
| --- | --- | --- |
| `email`, `firstname`, `lastname`, `jobtitle`, `company`, `website`; company `name`, `domain` | HubSpot | Set when Crusonia creates the record; afterwards only filled in where HubSpot is blank, never overwritten |
| `crusonia_fit_score`, `crusonia_fit_rationale` (summary, 500 chars), `crusonia_stage`, `crusonia_last_outreach_at`, `crusonia_source`, `crusonia_lead_id` | Crusonia | Overwritten whenever they differ. Custom properties in a "Crusonia" group, created by `bun run setup --crm` |
| `hs_lead_status` | Shared | Our stage's status is written only while HubSpot holds nothing or the value Crusonia wrote last (kept in `leads.hubspot_state`). Once someone changes it in HubSpot, Crusonia leaves it alone |
| `lifecyclestage`, owners, deals, everything else | HubSpot | Never written |
| Evidence | Crusonia | One HubSpot note per claim, with its source URL. Identical claims (same text and URL) share one note |
| Sent emails and replies | Crusonia | Logged as **notes** (not email engagements): one object type and one dedupe path for everything we log, and a note says plainly that Crusonia sent it. Bodies are escaped excerpts; inbound mail stays untrusted data |
| Our leads' evidence, score, stage, variant, consent | Crusonia | The HubSpot import never overwrites them: it fills blank fields, links the HubSpot ids, and grants consent only through a mapped opt-in property |
| Notion columns (Company, Contact, Email, Stage, Fit, Signal, Evidence count, Last activity, Source, Crusonia link, Lead ID) | Crusonia | Overwritten on the next change. Add your own columns freely; the sync never touches them |

Stage to `hs_lead_status`: `new` NEW; `researching`, `qualified`, `needs_review` OPEN; `awaiting_approval`
IN_PROGRESS; `sent` ATTEMPTED_TO_CONTACT; `replied`, `interested` CONNECTED; `meeting_booked` OPEN_DEAL;
`disqualified`, `not_interested`, `unsubscribed` UNQUALIFIED. `no_consent` sets nothing: those leads are only
researched, so their relationship status is not ours to set. Signal (Notion) is the lead's first evidence claim,
usually the buying signal that surfaced it.

Each note carries a `[crusonia:<ref>]` marker. If a sync dies after creating a note but before saving its id, the
retry finds the note by that marker instead of adding a second one. External ids live on our rows (`leads.hubspot_id`,
`hubspot_company_id`, `notion_page_id`, `evidence.hubspot_note_id`, `messages.hubspot_note_id`), so every push is an
upsert; a Notion page is also found by its Lead ID column if its id was lost.

### What syncs, and when

- **Which leads** (`HUBSPOT_SYNC_SCOPE` / `NOTION_SYNC_SCOPE`, default `qualified`): opted-in contacts, leads scored
  as qualified, leads in the send flow (awaiting approval, sent, replied, ..., unsubscribed), and (HubSpot only)
  records that came from HubSpot once Crusonia has scored them. Agent-found leads that were never qualified stay out
  of your CRM. `all` syncs every lead.
- **Triggers**: every state change already writes an `events` row; a trigger on it queues the lead when it is
  created or updated, scored, gets evidence, gets a draft, is emailed, replies, or changes stage or consent. A burst
  of events collapses into one queued sync per lead and target. Events from the HubSpot import itself queue nothing,
  so imported contacts are not pushed straight back.
- **Queue** (`crm_sync_queue`: target, entity, lead_id, attempts, last_error, next_attempt_at): the minute cron syncs
  `CRM_SYNC_BATCH_SIZE` leads per target (default 5) and one import page. Calls are paced under each provider's
  limit (HubSpot 220 ms apart, Notion about 3 per second). A 429 honors Retry-After (HubSpot's 10 s window when it
  sends none) without counting an attempt; other failures retry with backoff (1, 2, 4, ... minutes, 8 attempts),
  then the row is marked `failed` until the lead changes again or you sync it manually. Data errors (HTTP 400) fail
  at once. An unchanged lead costs no write (HubSpot) or no call at all (Notion).
- **Companies**: a person lead's company is upserted by domain and associated with the contact. Without the
  companies scopes, contacts and notes still sync and the status shows a warning.

### Turn it on

1. **HubSpot private app scopes** (Settings > Integrations > Private Apps > your app > Scopes):
   `crm.objects.contacts.read` and `.write` (contacts and notes), `crm.objects.companies.read` and `.write`
   (companies and associations), `crm.schemas.contacts.write` and `crm.schemas.companies.write` (setup creates the
   crusonia_* properties). The import needs only the read scopes.
2. **Notion**: share a page with the integration (page menu > Connections > your integration) and put the page id in
   `NOTION_PARENT_PAGE_ID` in `.dev.vars`.
3. `bun run setup --crm --write`: creates the HubSpot properties and the "Crusonia leads" database under that page,
   and writes `NOTION_LEADS_DATABASE_ID` into `.dev.vars`. Safe to re-run: it reuses what exists and adds what is
   missing (new stage options, missing columns). Without it, HubSpot sync still writes standard fields and notes.
4. Set `HUBSPOT_SYNC_ENABLED=true` and/or `NOTION_SYNC_ENABLED=true` in `.dev.vars`, then `bun run secrets`. From then
   on changes sync within a minute or two. To push existing leads, `POST /api/integrations/sync {"target": "hubspot"}`.
5. Optional: `POST /api/integrations/hubspot/import` pulls HubSpot contacts and companies into leads. Imported
   contacts get **no consent** (stage `no_consent`, never emailed) unless you map an opt-in property with
   `HUBSPOT_CONSENT_PROPERTY` (and `HUBSPOT_CONSENT_VALUES`); a contact that opted out in HubSpot never gets consent.

Watch it in `GET /api/integrations/crm`. Deleting a lead in Crusonia does not delete anything in HubSpot or Notion.
On the Workers Free plan (50 subrequests per invocation) keep `CRM_SYNC_BATCH_SIZE` small.

## Web app

The dashboard, onboarding and sign-in screens live in `web/` (React 19, React Router, Tailwind v4, React Query,
Clerk). Designs are in Paper (approved before code). The Worker serves `web/dist` as static assets: `/api/*`, `/mcp`,
`/webhooks/*` and `/health` run the Worker first, every other path without a file falls back to `index.html`.

| Route | Screen |
| --- | --- |
| `/sign-in`, `/sign-up` | Clerk custom flows (GitHub, Google, email code) |
| `/onboarding/1`..`4` | Your company, reading your site, your ideal customer, first leads |
| `/app` | Home: pipeline, drafts waiting for you, active workflows, spend, replies |
| `/app/leads`, `/app/leads/:id` | Leads (filters, CSV import, add) and lead detail (evidence, timeline, draft) |
| `/app/outreach[/:code]`, `/app/outreach/tasks` (`/app/approvals[/:code]` redirects) | Approve, edit or reject the exact draft; manual tasks |
| `/app/workflows`, `/app/workflows/runs/:id` | Agent runs and their step-by-step timeline |
| `/app/integrations` | Provider status |
| `/app/settings/agent` (`/app/settings/keys`, `/app/connect` and `?connect=1` redirect here) | Connect your agent: add to Cursor, Claude Code or Codex in one click; API keys: create, copy once, revoke, last used |
| `/app/replies`, `/app/settings` | Inbound replies; pause switch, do-not-contact list, account |

```sh
cd web && bun install           # once (build:web also installs)
bun run dev:web:mock            # :5173 with MSW sample data, no sign-in (`?mock=empty` for the empty state)
bun run dev                     # Worker on :8787, then in another shell:
bun run dev:web                 # :5173, proxies /api to the Worker (VITE_CLERK_PUBLISHABLE_KEY in web/.env.local)
```

Locally without Clerk, set `sessionStorage['crusonia.devToken']` to your `MCP_TOKEN` in the browser console to call
the real API from `vite dev` (development builds only; it is compiled out of production builds).

Build and ship: `VITE_CLERK_PUBLISHABLE_KEY` (publishable, safe in the bundle) must be set when building, e.g. in
`web/.env.local` (gitignored). `bun run deploy:preview` uploads a version without deploying it and serves it at
`app-crusonia.<subdomain>.workers.dev` (it uses production's secrets and database). Anyone who signs in gets their own
workspace (see [Workspaces](#workspaces)). Note: while an uploaded version is newer than the deployed one,
`wrangler secret put` refuses to run; use `wrangler versions secret put` or deploy first.

## iMessage approvals (Photon)

The owner can approve drafts and agent requests from their phone. No notices go out until `IMESSAGE_ENABLED=true`.
Switching it off stops new notices but not the phone: a 👍 or 👎 on a notice already delivered is still applied. To stop
that too, stop the bridge.

```
Worker  <── signed polls and tapbacks ──  bridge (bridge/, one small box)  ── gRPC ──  Photon Spectrum  ──  owner's iPhone
```

Photon's Stable SDK sends iMessages over gRPC from Node or Bun; it has no HTTP send API, and a Worker cannot hold the
connection. So a small Bun service, the **bridge**, holds it. The bridge is **outbound-only**: it accepts no connections,
so its box has no open port, no TLS certificate and no inbound firewall rule.

- **Notices.** Every ~5 s the bridge calls `POST /webhooks/photon/poll`. The Worker queues one notice per approval opened in
  the last 24 hours, plus one reminder when an approval is in the last quarter of its life (at most its last 12 hours). It
  leases up to 5 notices at a time with their text, and records the bridge's delivery acks, including the iMessage id of
  each delivered bubble (`imessage_outbox`). A lease that is never acked is retried after 2 minutes, 5 attempts at most.
- **Guards.** At most 6 notices go out per 10 minutes (`IMESSAGE_NOTICE_CAP`). Notices beyond the cap are not texted one
  by one: they collapse into a single `+N more approvals waiting: open Crusonia (…).` text, sent at most
  once per window. Approvals that belong to integration-test fixtures are never texted, so suites on a shared database
  can't flood the phone (`IMESSAGE_INCLUDE_TEST_DATA=true` turns that off). Fixtures are leads with an `it_*` source,
  recipients on reserved example domains (`example.com`, `*.test`, `*.example`, …) and `ses_it_*` agent sessions.
- **Tapbacks.** The bridge posts the owner's 👍 or 👎 on a notice to `POST /webhooks/photon`. The Worker applies it through
  the same services as the REST API and answers with a confirmation, which the bridge texts back (at most one per 10
  minutes).

What the owner sees:

```
Request 7KXM · draft v1 to Dana Okafor (Fieldnote) <dana@fieldnote.example>:
"Quick question about Fieldnote"

Hi Dana, ...

Tap 👍 to send, 👎 to reject.
```

The first line names the request (the approval's code) and the exact draft version. When a draft the owner was already
texted about gets a new version, its old request closes and the new notice opens with
`That draft changed; here's the new one (v1 is closed).` Tool requests read
`Request 9PQR · agent wants to run apify.run_actor (lead: ...).` with `Args: ...` and `Tap 👍 to allow, 👎 to deny.`
Questions read `Request 9PQR · agent asks (lead: ...): "..."` and `Answer it in the app.`

**Thumbs only.** A 👍 or 👎 on a notice is the only input:

| Owner does | Effect |
| --- | --- |
| 👍 on a notice | Approves exactly that request and draft version (sends the email, or allows the tool call) |
| 👎 on a notice | Rejects the draft, or denies the tool call |
| Anything else | Nothing, and no reply: texts, other tapbacks, read receipts, typing, attachments |

Editing, answering questions and pausing happen in the app.

**Never answer anything but a thumb.** The SDK delivers read receipts as messages with content type `read`, the owner as
sender and a new id each time. A reply to one gets read, which sends another receipt: that loop once texted the owner over
and over. So the bridge drops everything except the owner's 👍 / 👎, and as a hard stop it texts at most one non-notice
message per 10 minutes.

### Security model

- **Owner only.** The bridge acts only on direct messages from `OWNER_PHONE` (plus optional `OWNER_ALIASES`, such as the
  owner's Apple ID email). Everything else is logged with a masked handle and dropped. It only ever texts `OWNER_PHONE`,
  and the Worker's notices carry no recipient. Setting `OWNER_PHONE` on the Worker too makes `/webhooks/photon` refuse
  any other sender.
- **Signed calls.** Every bridge call is signed with HMAC-SHA256 over `<timestamp>.<path>.<raw body>`, using `BRIDGE_SECRET`:
  - Headers: `X-Crusonia-Timestamp` and `X-Crusonia-Signature: v1=<hex>`.
  - The 5-minute window rejects replays.
  - The signed path binds a signature to its route, so a poll signature is not valid for a tapback.
  - Tapbacks are deduped by iMessage event id in `webhook_events`; a retried delivery gets the first reply and acts only
    once.
- **Same rules as the app.** Decisions go through the approval services: expiry, single use, latest draft version, same
  recipient, consent, suppression and pause are all re-checked when the decision is applied. Each is recorded with
  `decided_via = 'imessage'` and an `events` row.
- **Tapbacks are bound to the bubble.** Each notice stores the iMessage id of its bubble and the draft version it showed.
  A 👍 on an older version's bubble hits a closed approval and sends nothing. Plain text replies can't be tied to a bubble
  (Photon), which is why text decides nothing.
- **Untrusted text.** Agent-written tool arguments and questions, and lead fields from CSVs or scraping, are flattened to
  one line, capped and labeled ("Agent asks").
- **A leaked box can do only what the bridge does:** text the owner, and send tapbacks on bubbles it knows. The box
  holds no database URL, no API key and no Worker secret other than `BRIDGE_SECRET`, and the Photon credentials live
  nowhere else. To rotate: set a new `BRIDGE_SECRET` on the Worker, then recreate the box.
- **Photon limits.** 5,000 messages per server per day, and 50 new conversations per line per day. On Free and Pro
  plans the shared line only messages registered users: add the owner's number under **Users** in the Photon dashboard,
  or sends fail with "Target not allowed for this project".

### Turn it on

1. **Photon** (Stable, app.photon.codes): open your project's **Settings** for the project ID and secret, add the owner's
   number under **Users**, and text the line once from that phone. Conversations the user starts deliver better.
2. **Secret:** `openssl rand -hex 32` into a private file as `BRIDGE_SECRET=...`. The same value goes to the Worker and
   the bridge.
3. **Worker:**
   - `bun run migrate` (adds `imessage_outbox`).
   - Set the secrets `BRIDGE_SECRET`, `IMESSAGE_ENABLED=true` and optionally `OWNER_PHONE`.
   - Deploy.
   - `GET /api/status` shows `imessage.bridge.online` once the bridge polls.
4. **Bridge** on AWS Lightsail, $5/month (`nano_3_0`: 512 MB, public IPv4 included):

   ```sh
   GIT_REF=<pushed commit sha> CREDS_FILE=<file with SPECTRUM_PROJECT_ID/SECRET, OWNER_PHONE> \
   BRIDGE_SECRET_FILE=<file with BRIDGE_SECRET> SEND_TEST_MESSAGE=1 bridge/deploy/aws.sh up
   ```

   - The script creates one Ubuntu instance tagged `project=crusonia`, closes every port, and requires IMDSv2 with hop
     limit 1.
   - A first-boot script installs Docker, builds the bridge at that commit and runs it: `--restart always`, read-only
     root filesystem, no capabilities.
   - It also writes the five settings to a root-only env file and, with `SEND_TEST_MESSAGE=1`, texts the owner once.
   - There is no SSH. Check the conversation read-only with
     `cd bridge && bun --env-file=<creds> deploy/check-history.ts`.
   - Before a real `up`, validate the first-boot script locally: `bridge/deploy/test-bootstrap.sh` runs it in a privileged
     `ubuntu:24.04` container (Docker in Docker) and can never text anyone.
   - `WORKER_URL` picks the Worker the bridge serves (for example a staging Worker for a rehearsal; production later). Each
     Worker has its own `BRIDGE_SECRET`. There is one bridge, so point it at one Worker at a time.
   - Ship a new commit or rotate secrets with `bridge/deploy/aws.sh recreate` (the bridge keeps no state), and remove
     everything with `bridge/deploy/aws.sh down --yes`.
   - The settings travel in the instance's launch script, which AWS keeps as instance data, and processes on the box can
     read them from the metadata service (the container cannot, because of the hop limit).
   - Any Docker host works the same way: `docker build bridge` and run it with `--env-file` (see
     `bridge/.env.example`). It never needs a published port.

Locally, without Photon:

```sh
cd bridge && bun install && bun test
SPECTRUM_MODE=mock OWNER_PHONE=+15550001111 BRIDGE_SECRET=<32+ chars> WORKER_URL=http://localhost:8787 bun src/index.ts
BRIDGE_SECRET=<same> bun src/cli.ts tap +15550001111 <bubble id> 👍   # simulate a tapback; prints the reply
```

## Day to day

- `bun run dev`: local Worker on :8787 (reads `.dev.vars`). `bunx wrangler dev --test-scheduled` to trigger the cron at `/__scheduled`.
- `bun run typecheck`: Worker (`tsconfig.json`), Bun scripts (`scripts/tsconfig.json`), tests (`test/tsconfig.json`) and the web app (`web/tsconfig.json`).
- `bun test`: unit tests (signatures, approval rules and lifetimes, CSV, classifier, providers with mocked fetch, auth,
  API keys, routes, the Naive agent definition and playbook, summary/run-step logic; CRM sync field mapping, queue
  retry/backoff and 429s, and HubSpot/Notion pushes and setup against in-memory fakes; billing with an in-memory
  Stripe; Company summary markdown and domain normalization; iMessage wording, signatures and webhook checks; and the
  bridge's own tests in `bridge/test`). With `TEST_DATABASE_URL=<dev branch>`, `test/db.integration.test.ts`
  (send/reply/Naive flows), `test/web-api.integration.test.ts` (keys, summary, replies, workflows, onboarding),
  `test/organizations.integration.test.ts` (a user in two workspaces, spoofed headers, invite tokens, roles, the last
  owner, rate limits, one free sample per person), `test/workspaces.integration.test.ts` (migration and billing merge, first sign-in, isolation of every route and MCP
  tool, Company summary versions, cohorts and workflow versions, credits and limits, webhooks, platform admins, the
  per-workspace Naive agent), `test/crm-sync.integration.test.ts` (trigger, queue, pushes, import),
  `test/billing.integration.test.ts` (webhook, ledger, refunds, rollover, usage debits, the 402 gate) and
  `test/imessage.integration.test.ts` (bridge poll, owner commands and tapbacks through the real approval services)
  also run against a real database with mocked providers (never point it at production; they clean up their rows).
- `bun run deploy:dry`: build the web app and the Worker without deploying. `bun run deploy` builds the web app first too.
- `bun run cf-typegen`: regenerate runtime types after changing `compatibility_date` or flags.

## Contributing

The web app is served from this Worker's origin through a static-assets binding (no CORS). Its `assets` config must
keep `/api/*`, `/mcp`, `/webhooks/*` and `/health` on the Worker (`run_worker_first`); see the comment in
`src/index.ts`.

`main` is protected: changes land through pull requests. Front-facing code (`web/**`, `src/web/**`, `public/**`, `*.tsx`,
`design/**`) is owned by @DannyMang in CODEOWNERS and ships only after the design is approved in Paper.
