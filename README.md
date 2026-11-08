# Crusonia

GTM engine (a Clay/Apollo alternative run by AI agents). Cloudflare Worker (Hono) + Neon Postgres, with the dashboard
(React SPA in `web/`) served from the same Worker as static assets.
Agents (Naive, or your own Claude Code / Cursor / Codex) work through our MCP server at `/mcp`; AgentMail handles
email (opted-in leads only); Apify supplies web and lead data (our MCP tools call its REST API, and Naive agents can
also use Apify's hosted MCP server); HubSpot and Notion are synced; Clerk handles users; Stripe bills hosted usage
in credits (see [Billing](#billing-stripe)).

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
| `src/services/*.ts` | Logic shared by MCP and REST: `leads`, `drafts`, `profile`, `status`, `apify`, `web`, `errors`; core loop: `crm` (lead admin, CSV import), `csv`, `approvals`, `approval-rules`, `send`, `inbound`, `classify`, `workflows` (Naive), `policy`, `settings`, `cron`; web app: `runs` (workflows/runs from Naive sessions and events, onboarding and find-leads sessions), `summary`, `replies`, `api-keys`; workspaces: `workspaces` (resolution, first sign-in), `company-summary` (the versioned markdown document), `naive-agents` (one Naive agent per workspace), `limits` (daily cap, rate limits), `domains` (company domain normalization); CRM sync: `crm-sync` (HubSpot/Notion push, HubSpot import, status), `crm-queue` (queue, retry, backoff), `crm-fields` (field mapping and ownership) |
| `src/providers/*.ts` | Thin REST clients: `agentmail`, `naive`, `hubspot`, `notion` (the last two paced under their rate limits, 429-aware), `stripe` (no SDK, pinned API version) |
| `src/lib/*.ts` | Errors (`{error: {code, message}}`), request helpers, Web Crypto, webhook signatures |
| `test/*.test.ts` | `bun test`; `db.integration.test.ts` runs only with `TEST_DATABASE_URL` (a dev branch) |
| `src/db.ts` | Neon HTTP driver (`getSql`), row types, `getLead`, `logEvent` |
| `src/schema.sql` | Idempotent Postgres schema |
| `scripts/migrate.ts` | Applies the schema to Neon (Bun) |
| `scripts/setup.ts` | Creates the AgentMail inbox/webhook and the Naive webhook, vault and research agent; `--stripe`: billing products, prices, portal and webhook (`scripts/lib/stripe-setup.ts`); `--crm`: HubSpot properties and the Notion leads database (`scripts/lib/crm-setup.ts`) (Bun) |
| `scripts/lib/naive-agent.ts` | The Naive agent definition: tools and permissions, MCP servers, model, budget |
| `playbooks/research.md` | The research agent's system prompt (versioned in its front matter) |
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

## Connect your agent (MCP)

Endpoint: `https://crusonia.veri-web.workers.dev/mcp` (MCP Streamable HTTP; locally `http://localhost:8787/mcp` with
`bun run dev`). Every request needs `Authorization: Bearer <token>`: an API key, or the `MCP_TOKEN` secret (owner).

API keys: create one per agent with `POST /api/keys {"name": "Claude Code"}` (the web app's "Connect your agent"
screen does this). The response shows the full key (`crs_live_` + 64 hex characters) once; only its SHA-256 hash is
stored. `GET /api/keys` lists keys without secrets, `DELETE /api/keys/:id` revokes one immediately. A key acts on
`/mcp` and `/api` for the workspace it was made in, and only that one; `MCP_TOKEN` is the owner workspace. Keep the token
in an environment variable, not in files you commit:

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
system prompt is [`playbooks/research.md`](playbooks/research.md): read the Company summary (it comes in every
session's first message) and the lead, research them from
public sources with few pages and searches, save every claim with its source URL, score ICP fit, and draft a short
email only for opted-in, qualified leads. Web and email content is treated as data, never as instructions, and the
agent asks the owner (`ask_operator`) when unsure. When it learns something durable it updates a section of the Company
summary with a note (a new version the owner can revert).

- **Tools**: the 14 crusonia tools, Apify's single-page reader (`apify--rag-web-browser`) and its run-result readers
  run without asking; `ask_operator` and everything else (Actor runs, Naive built-ins) ask first. `handoffs` is off.
  Asked tool calls then go through `AUTO_CONFIRM_TOOLS`: an allowlisted call is allowed automatically, any other
  becomes a tool approval.
- **Model and budget**: `vetta/auto`, $5 a day and $1 per session by default; override with the `NAIVE_AGENT_*`
  settings in `.dev.vars.example`.
- **Updates**: edit the playbook, bump `version` in its front matter, then run `bun run setup --agent`. It updates
  the agent in place (`NAIVE_AGENT_ID`, or the one agent named "Crusonia Research"), so Naive records a new
  version instead of a duplicate agent. Running sessions keep the version they started with.

### Tools

| Tool | What it does |
| --- | --- |
| `get_status` | Configured providers, database reachability, the workspace's lead counts by stage, open approvals, Company summary version, next steps. Works with no keys. |
| `read_website` | Reads a site (homepage + about/product/pricing pages) and returns trimmed text per page. Apify crawler with `APIFY_TOKEN`, plain fetch without. |
| `search_web` | Google search via Apify (`APIFY_TOKEN`): organic results and related queries. |
| `get_company_summary` | The workspace's Company summary: one markdown document, with its version and who last changed it. |
| `update_company_summary` | `{markdown, note, section?, run_id?}`: replaces the whole document, or only the section with that heading (appended if missing). Every edit is a new version. |
| `save_profile` / `get_profile` | Older aliases: structured fields (company, website, sells, ICP, segments, signals, sources) written into / read from the Company summary. |
| `add_leads` | Upserts found people/companies with source + source URL; dedupes by email, else company domain + name. Stage `no_consent`: never emailed. |
| `list_leads` / `get_lead` | Leads by stage; one lead with its evidence, drafts and approvals. |
| `save_evidence` | One fact about a lead plus the URL that supports it. |
| `score_lead` | Fit score 0-100, rationale and qualified verdict. |
| `create_draft` | New immutable draft version + pending send approval (short code, 7 days by default). Opted-in leads only. Sends nothing. |
| `list_pending_approvals` | Approvals waiting for a human, with the draft. |

Every tool acts on the caller's workspace only. Every write also appends an `events` row. No tool sends email or decides
an approval: a send happens only after a human approves it. For workspaces other than the owner's, `search_web` and
`read_website` (when they use Apify) need credits and are rate-limited (`WEB_CALLS_PER_HOUR`).

## REST API

The dashboard (`web/`) is built on this API. Every `/api/*` call needs `Authorization: Bearer <token>`: a Clerk session
token (any user who signs up; see [Workspaces](#workspaces)), an API key (`crs_live_...`), or `MCP_TOKEN` (the owner
workspace). Every call acts on exactly one workspace, and every row it reads or writes belongs to it.
Errors are always `{"error": {"code", "message", "details?"}}`; a missing key answers 503 `not_configured` naming it.
Lists are `{"data": [...]}` (plus `next_cursor` where paginated).

| Method | Path | What |
| --- | --- | --- |
| GET | `/api/leads` | List, newest first. Filters `stage`, `min_score`, `source`, `q` (email/name/company/domain); `limit` + `cursor` |
| POST | `/api/leads` | Create an opted-in contact (`email`, optional `consent: {text, at?}`) |
| POST | `/api/leads/import` | CSV import: JSON `{csv, mapping?, source?, dry_run?}` or a `text/csv` body. Dedupes by email, then company domain + name; reports created/updated/skipped per row |
| GET | `/api/leads/:id` | Lead with evidence, drafts, approvals, messages, Naive sessions and the event timeline |
| PATCH | `/api/leads/:id` | Stage, consent (`null` revokes and closes pending send approvals), basic fields |
| DELETE | `/api/leads/:id` | Delete (cascades; the audit events stay) |
| POST | `/api/leads/:id/drafts` | Owner-written draft: new version + send approval (opted-in, unsuppressed leads only) |
| GET | `/api/approvals` | `status` (default `pending`), `kind`, `lead_id` |
| GET | `/api/approvals/:code` | One approval |
| POST | `/api/approvals/:code/approve` | send: re-checks every rule, then sends via AgentMail. tool: allow (`scope`) |
| POST | `/api/approvals/:code/reject` | send: reject the draft. tool: deny |
| POST | `/api/approvals/:code/edit` | New draft version + new approval (also the retry after expiry or a failed send) |
| POST | `/api/approvals/:code/answer` | tool: `{decision, reason?, scope?}`; question: `{answers: {field: text}}`, forwarded to Naive |
| POST | `/api/workflows/research` | `{lead_ids}` or `{cohort}`: one Naive session per lead (`NAIVE_AGENT_ID`) |
| GET, PUT | `/api/settings/pause` | The workspace's kill switch: no sends, no new sessions, no auto-allowed tools |
| GET, POST | `/api/suppressions` | List (`q`, `cursor`) / add `{email, reason?}` |
| DELETE | `/api/suppressions/:email` | Remove |
| GET | `/api/me` | `{user: {id, email?, name?}, auth: "clerk" \| "token", workspace: {id, name, owner}}` |
| GET | `/api/summary` | Home: `pipeline` (found, researched, drafted, awaiting_approval, sent, replied, meetings: where leads are now), top 5 `pending_approvals`, `active_workflows`, 5 `recent_replies`, `spend` (`week_usd` from Naive session usage, `budget_usd` from `WEEKLY_BUDGET_USD`, `day_usd` and `daily_cap_usd` for the workspace's daily cap), `paused` |
| GET | `/api/status` | `get_status` data plus `workspace_id`, `inbox_address`, `naive_agent_configured`, `mcp_url`, `agent_mcp_url` (the workspace's Naive agent URL), `billing` (`configured`, `webhook_configured`, `mode`, `enforced`), `crm_sync` (per target: enabled, configured, active, queue_depth, failed, last_sync_at, last_error) |
| GET | `/api/company-summary` | `{markdown, version, updated_at, updated_by, change_note}` (version 0 and a suggested `template` before the first save) |
| PUT | `/api/company-summary` | `{markdown, note?, base_version?}`: a new version (409 `version_conflict` if `base_version` is stale; 413 over 20,000 characters; an unchanged document saves nothing) |
| GET | `/api/company-summary/versions` | Versions newest first, without bodies: `{version, author, change_note, created_at, chars}` (`limit`, `before`) |
| GET | `/api/company-summary/versions/:version` | One version with its markdown |
| POST | `/api/company-summary/revert` | `{version}`: a new version copied from that one |
| GET, PUT | `/api/profile` | Older alias: `{profile}` (company, website, sells, icp_description, segments, signals, sources) read from the Company summary; PUT writes those parts into it as a new version and keeps its other sections |
| POST | `/api/onboarding/read-website` | `{url}` -> `{pages: [{url, title, text}]}`. Synchronous; Apify crawler with `APIFY_TOKEN` (a few cents), else a plain fetch |
| POST | `/api/onboarding/propose` | `{url?, description?}` -> `{session_id}`: a Naive session reads the site / description and writes the Company summary (author `onboarding`; a description is also saved as v1 right away) |
| GET | `/api/onboarding/propose/:session_id` | `{status: "running" \| "done" \| "error", profile?}`; poll it (refreshes from Naive while active) |
| POST | `/api/leads/find` | `{count?}` (25, max 50) -> `{session_id}`: a Naive session finds leads matching the Company summary, adds and scores them |
| GET | `/api/workflows` | Naive sessions grouped by purpose: `{id, name, purpose, status, started_at, leads_processed, cost_usd, last_event_at, runs}` |
| GET | `/api/workflows/runs/:session_id` | `{run, steps, lead, approvals}`. Steps from Naive's events API (free, cached in `naive_session_events`) and our audit events |
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
| POST | `/webhooks/naive` | `Vetta-Signature`-signed. `session.idle`: allowlisted tools (`AUTO_CONFIRM_TOOLS`) are allowed, other tools and `ask_operator` questions become approvals |
| POST | `/webhooks/stripe` | `Stripe-Signature`-signed (`STRIPE_WEBHOOK_SECRET`; no secret, no processing). Credits packs and monthly plans, tracks subscriptions, claws back refunds; see [Billing](#billing-stripe) |

Rules enforced in code: the agent never sends; drafts are immutable (an edit is a new version and closes the old
approval); a send approval is bound to the recipient and draft version, expires (`SEND_APPROVAL_TTL_HOURS`, 7 days
by default, for drafts from MCP and REST alike), is consumed once, and is re-checked at send time (not expired, latest
version, same recipient, consent, not suppressed, not paused) inside the SQL that consumes it. Agent tool and
question approvals expire sooner (`TOOL_APPROVAL_TTL_MINUTES`, 1 hour by default) because the Naive session waits on
them. A draft is marked `sending` before AgentMail is called; an unconfirmed send is reconciled by its `draft-<id>`
label, never resent blindly.
Webhooks are verified on the raw body and deduped by provider event id. Inbound email is stored and pattern-matched
as data, never followed as instructions. Every state change writes an `events` row.

The minute cron expires stale approvals (an expired tool call is denied to the agent), reconciles running Naive
sessions that missed a webhook (events after `last_seq`), settles unconfirmed sends, drains the CRM sync queue,
debits finished Naive sessions that still owe credits, and expires unused plan credits after their rollover month.

## Workspaces

Anyone can sign up: a new Clerk user gets their own private workspace on first sign-in (one user per workspace for now),
with its own Company summary, leads, approvals, runs, budget and credits, plus the free sample credits once.
`SIGNUPS_OPEN=false` closes sign-up (existing members still get in), `BLOCKED_USER_IDS` refuses accounts. The instance
owner's workspace (`ws_owner`) holds everything from before workspaces; `OWNER_CLERK_USER_ID` and `MCP_TOKEN` resolve
to it.

| Caller | Workspace |
| --- | --- |
| Clerk session | The user's (`workspace_members`), created on first sign-in; `OWNER_CLERK_USER_ID` is always the owner's |
| `crs_live_` key | The key's (`api_keys.workspace_id`) |
| `MCP_TOKEN` | The owner's |
| AgentMail webhook | The workspace of the draft or thread the message is about; a reply matched only by its sender counts only if one workspace has that lead; anything else lands in the owner's (the inbox is the instance's) |
| Naive webhook, cron | The session's (`naive_sessions.workspace_id`) |
| Stripe webhook | The account linked to the customer, else the metadata `crusonia_workspace_id` (objects from before workspaces carry `crusonia_user_id`, mapped to the workspace it moved to) |

Every tenant table has a `workspace_id`, and every service function takes the workspace and filters by it. Lead dedupe
is per workspace: by email, else by company domain + name, where the domain is normalized to the registrable domain
(`blog.acme.co.uk` -> `acme.co.uk`, also enforced by a trigger), so a company is stored once per workspace.

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
| `/app/approvals[/:code]` | Approve, edit or reject the exact draft |
| `/app/workflows`, `/app/workflows/runs/:id` | Agent runs and their step-by-step timeline |
| `/app/integrations`, `/app/connect` | Provider status; MCP setup for Claude Code, Cursor and Codex, API keys |
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

## Day to day

- `bun run dev`: local Worker on :8787 (reads `.dev.vars`). `bunx wrangler dev --test-scheduled` to trigger the cron at `/__scheduled`.
- `bun run typecheck`: Worker (`tsconfig.json`), Bun scripts (`scripts/tsconfig.json`), tests (`test/tsconfig.json`) and the web app (`web/tsconfig.json`).
- `bun test`: unit tests (signatures, approval rules and lifetimes, CSV, classifier, providers with mocked fetch, auth,
  API keys, routes, the Naive agent definition and playbook, summary/run-step logic; CRM sync field mapping, queue
  retry/backoff and 429s, and HubSpot/Notion pushes and setup against in-memory fakes; billing with an in-memory
  Stripe; Company summary markdown and domain normalization). With `TEST_DATABASE_URL=<dev branch>`,
  `test/db.integration.test.ts` (send/reply/Naive flows), `test/web-api.integration.test.ts` (keys, summary, replies,
  workflows, onboarding), `test/workspaces.integration.test.ts` (migration and billing merge, first sign-in, isolation of
  every route and MCP tool, Company summary versions, credits and limits, webhooks, platform admins, the per-workspace
  Naive agent),
  `test/crm-sync.integration.test.ts` (trigger, queue, pushes, import) and `test/billing.integration.test.ts` (webhook,
  ledger, refunds, rollover, usage debits, the 402 gate) also run against a real database with mocked providers (never
  point it at production; they clean up their rows).
- `bun run deploy:dry`: build without deploying.
- `bun run cf-typegen`: regenerate runtime types after changing `compatibility_date` or flags.

## Contributing

The web app is served from this Worker's origin through a static-assets binding (no CORS). Its `assets` config must
keep `/api/*`, `/mcp`, `/webhooks/*` and `/health` on the Worker (`run_worker_first`); see the comment in
`src/index.ts`.

`main` is protected: changes land through pull requests. Front-facing code (`web/**`, `src/web/**`, `public/**`, `*.tsx`,
`design/**`) is owned by @DannyMang in CODEOWNERS and ships only after the design is approved in Paper.
