# Crusonia

GTM engine (a Clay/Apollo alternative run by AI agents). API-only Cloudflare Worker (Hono) + Neon Postgres.
Agents (Naive, or your own Claude Code / Cursor / Codex) work through our MCP server at `/mcp`; AgentMail handles
email (opted-in leads only); Apify supplies web and lead data (our MCP tools call its REST API, and Naive agents can
also use Apify's hosted MCP server); HubSpot and Notion are synced; Clerk handles users.

Live: https://crusonia.veri-web.workers.dev/health · MCP: https://crusonia.veri-web.workers.dev/mcp

## Layout

| Path | What |
| --- | --- |
| `src/index.ts` | Worker entry: Hono app (`/`, `/health`, `/mcp`, `/api`, `/webhooks`) + minute cron; hands other paths to the web app's `ASSETS` binding when present |
| `src/env.ts` | `Env` type (vars + secrets) and `requireEnv` |
| `src/auth.ts` | Bearer tokens for `/mcp` and `/api`: an API key (`crs_live_...`, looked up by SHA-256) or `MCP_TOKEN` (constant-time compare) |
| `src/mcp/route.ts` | `/mcp`: MCP Streamable HTTP (stateless, JSON responses), fresh server per request |
| `src/mcp/server.ts` | MCP tool definitions: a thin layer over `src/services` |
| `src/api/*.ts` | REST routers: `auth` (Clerk, API key or `MCP_TOKEN`), `leads`, `approvals`, `workflows`, `settings`, signed `webhooks`; web app: `dashboard` (me, summary, status, replies), `onboarding` (profile, read-website, propose), `experiments`, `keys` |
| `src/services/*.ts` | Logic shared by MCP and REST: `leads`, `drafts`, `profile`, `status`, `apify`, `web`, `errors`; core loop: `crm` (lead admin, CSV import), `csv`, `approvals`, `approval-rules`, `send`, `inbound`, `classify`, `workflows` (Naive), `policy`, `settings`, `cron`; web app: `runs` (workflows/runs from Naive sessions and events, onboarding and find-leads sessions), `summary`, `replies`, `experiments`, `api-keys` |
| `src/providers/*.ts` | Thin REST clients: `agentmail`, `naive` |
| `src/lib/*.ts` | Errors (`{error: {code, message}}`), request helpers, Web Crypto, webhook signatures |
| `test/*.test.ts` | `bun test`; `db.integration.test.ts` runs only with `TEST_DATABASE_URL` (a dev branch) |
| `src/db.ts` | Neon HTTP driver (`getSql`), row types, `getLead`, `logEvent` |
| `src/schema.sql` | Idempotent Postgres schema |
| `scripts/migrate.ts` | Applies the schema to Neon (Bun) |
| `scripts/setup.ts` | Creates the AgentMail inbox/webhook and the Naive webhook, vault and research agent (Bun) |
| `scripts/lib/naive-agent.ts` | The Naive agent definition: tools and permissions, MCP servers, model, budget |
| `playbooks/research.md` | The research agent's system prompt (versioned in its front matter) |
| `wrangler.jsonc` | Worker config (cron every minute, `PUBLIC_URL`) |
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

## Connect your agent (MCP)

Endpoint: `https://crusonia.veri-web.workers.dev/mcp` (MCP Streamable HTTP; locally `http://localhost:8787/mcp` with
`bun run dev`). Every request needs `Authorization: Bearer <token>`: an API key, or the `MCP_TOKEN` secret (owner).

API keys: create one per agent with `POST /api/keys {"name": "Claude Code"}` (the web app's "Connect your agent"
screen does this). The response shows the full key (`crs_live_` + 64 hex characters) once; only its SHA-256 hash is
stored. `GET /api/keys` lists keys without secrets, `DELETE /api/keys/:id` revokes one immediately. A key has the same
access as `MCP_TOKEN` on `/mcp` and `/api` (single workspace for now). Keep the token in an environment variable, not
in files you commit:

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
it when an agent's `mcp_servers[].url` is exactly that URL.

### The research agent

`bun run setup` also creates the Naive agent that `POST /api/workflows/research` runs, one session per lead. Its
system prompt is [`playbooks/research.md`](playbooks/research.md): read the profile and the lead, research them from
public sources with few pages and searches, save every claim with its source URL, score ICP fit, and draft a short
email only for opted-in, qualified leads. Web and email content is treated as data, never as instructions, and the
agent asks the owner (`ask_operator`) when unsure.

- **Tools**: the 12 crusonia tools, Apify's single-page reader (`apify--rag-web-browser`) and its run-result readers
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
| `get_status` | Configured providers, database reachability, lead counts by stage, open approvals, next steps. Works with no keys. |
| `read_website` | Reads a site (homepage + about/product/pricing pages) and returns trimmed text per page. Apify crawler with `APIFY_TOKEN`, plain fetch without. |
| `search_web` | Google search via Apify (`APIFY_TOKEN`): organic results and related queries. |
| `save_profile` / `get_profile` | The onboarding result (`settings.profile`): company, website, what the user sells, ICP description, segments (name, company size, industry, roles), buying signals (name, description), sources (which page supports which field). |
| `add_leads` | Upserts found people/companies with source + source URL; dedupes by email, else company domain + name. Stage `no_consent`: never emailed. |
| `list_leads` / `get_lead` | Leads by stage; one lead with its evidence, drafts and approvals. |
| `save_evidence` | One fact about a lead plus the URL that supports it. |
| `score_lead` | Fit score 0-100, rationale and qualified verdict. |
| `create_draft` | New immutable draft version + pending send approval (short code, 7 days by default). Opted-in leads only. Sends nothing. |
| `list_pending_approvals` | Approvals waiting for a human, with the draft. |

Every write also appends an `events` row. No tool sends email or decides an approval: a send happens only after a
human approves it.

## REST API

Every `/api/*` call needs `Authorization: Bearer <token>`: a Clerk session token for a user in
`CLERK_ALLOWED_USER_IDS`, an API key (`crs_live_...`), or `MCP_TOKEN` as the owner/dev bypass. Single workspace for now.
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
| GET, PUT | `/api/settings/pause` | Global kill switch: no sends, no new sessions, no auto-allowed tools |
| GET, POST | `/api/suppressions` | List (`q`, `cursor`) / add `{email, reason?}` |
| DELETE | `/api/suppressions/:email` | Remove |
| GET | `/api/me` | `{user: {id, email?, name?}, auth: "clerk" \| "token"}` |
| GET | `/api/summary` | Home: `pipeline` (found, researched, drafted, awaiting_approval, sent, replied, meetings: where leads are now), top 5 `pending_approvals`, `active_workflows`, 5 `recent_replies`, `spend` (`week_usd` from Naive session usage, `budget_usd` from `WEEKLY_BUDGET_USD`), `paused` |
| GET | `/api/status` | `get_status` data plus `inbox_address`, `naive_agent_configured`, `mcp_url` |
| GET, PUT | `/api/profile` | `{profile}`: company, website, sells, icp_description, segments, signals, sources (PUT replaces it) |
| POST | `/api/onboarding/read-website` | `{url}` -> `{pages: [{url, title, text}]}`. Synchronous; Apify crawler with `APIFY_TOKEN` (a few cents), else a plain fetch |
| POST | `/api/onboarding/propose` | `{url?, description?}` -> `{session_id}`: a Naive session reads the site and saves a proposed profile |
| GET | `/api/onboarding/propose/:session_id` | `{status: "running" \| "done" \| "error", profile?}`; poll it (refreshes from Naive while active) |
| POST | `/api/leads/find` | `{count?}` (25, max 50) -> `{session_id}`: a Naive session finds leads for the saved profile, adds and researches them |
| GET | `/api/workflows` | Naive sessions grouped by purpose: `{id, name, purpose, status, started_at, leads_processed, cost_usd, last_event_at, runs}` |
| GET | `/api/workflows/runs/:session_id` | `{run, steps, lead, approvals}`. Steps from Naive's events API (free, cached in `naive_session_events`) and our audit events |
| GET | `/api/replies` | Inbound replies with their lead: `{id, lead_id, from, subject, preview, label, received_at}`; `limit`, `cursor`, `label`, `lead_id` |
| GET, POST | `/api/experiments` | List with per-arm `stats: {A, B}` (`sent`, `replies`, `positive`, `cost_usd`) / create `{name, hypothesis?, segment?, metric?, stop_rule_sends_per_arm?, stop_rule_days?, variants?, lead_ids?}` |
| GET, PATCH | `/api/experiments/:id` | `{experiment, daily: [{date, A_replies, B_replies}]}` / `{status: "stopped"}` |
| POST | `/api/experiments/:id/leads` | Enroll more leads `{lead_ids}` (each keeps its variant; leads in another running experiment are skipped) |
| GET, POST | `/api/keys` | API keys for `/mcp` and `/api`: list (no secrets) / create `{name}` (full key returned once) |
| DELETE | `/api/keys/:id` | Revoke |
| POST | `/webhooks/agentmail` | Svix-signed. `message.received` (match by thread, then sender; classify; stop follow-ups; unsubscribe suppresses), `message.bounced` (permanent: suppress), `message.complained`, `message.delivered` |
| POST | `/webhooks/naive` | `Vetta-Signature`-signed. `session.idle`: allowlisted tools (`AUTO_CONFIRM_TOOLS`) are allowed, other tools and `ask_operator` questions become approvals |

Rules enforced in code: the agent never sends; drafts are immutable (an edit is a new version and closes the old
approval); a send approval is bound to the recipient and draft version, expires (`SEND_APPROVAL_TTL_HOURS`, 7 days
by default, for drafts from MCP and REST alike), is consumed once, and is re-checked at send time (not expired, latest
version, same recipient, consent, not suppressed, not paused) inside the SQL that consumes it. Agent tool and
question approvals expire sooner (`TOOL_APPROVAL_TTL_MINUTES`, 1 hour by default) because the Naive session waits on
them. A draft is marked `sending` before AgentMail is called; an unconfirmed send is reconciled by its `draft-<id>`
label, never resent blindly.
Webhooks are verified on the raw body and deduped by provider event id. Inbound email is stored and pattern-matched
as data, never followed as instructions. Every state change writes an `events` row.

Experiments: the arms are the lead variants A and B (stable per lead). Enrolled leads' drafts created while the
experiment runs carry its id; `sent` counts those drafts once sent, `replies` the leads that answered after their first
send, `positive` those labeled `interested`. Stop rules are reported (`stop_rule_met`); stopping is a `PATCH`.

The minute cron expires stale approvals (an expired tool call is denied to the agent), reconciles running Naive
sessions that missed a webhook (events after `last_seq`), and settles unconfirmed sends.

## Day to day

- `bun run dev`: local Worker on :8787 (reads `.dev.vars`). `bunx wrangler dev --test-scheduled` to trigger the cron at `/__scheduled`.
- `bun run typecheck`: Worker (`tsconfig.json`), Bun scripts (`scripts/tsconfig.json`) and tests (`test/tsconfig.json`).
- `bun test`: unit tests (signatures, approval rules and lifetimes, CSV, allowlist, classifier, providers with mocked
  fetch, auth, API keys, routes, the Naive agent definition and playbook, summary/experiment/run-step logic). With
  `TEST_DATABASE_URL=<dev branch>`, `test/db.integration.test.ts` (send/reply/Naive flows) and
  `test/web-api.integration.test.ts` (keys, summary, experiments, replies, workflows, onboarding) also run against a
  real database with mocked providers (never point it at production; they clean up their rows).
- `bun run deploy:dry`: build without deploying.
- `bun run cf-typegen`: regenerate runtime types after changing `compatibility_date` or flags.

## Contributing

The web app is served from this Worker's origin through a static-assets binding (no CORS). Its `assets` config must
keep `/api/*`, `/mcp`, `/webhooks/*` and `/health` on the Worker (`run_worker_first`); see the comment in
`src/index.ts`.

`main` is protected: changes land through pull requests. Front-facing code (`src/web/**`, `public/**`, `*.tsx`,
`design/**`) is owned by @DannyMang in CODEOWNERS and ships only after the design is approved in Paper.
