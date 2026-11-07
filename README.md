# Crusonia

GTM engine (a Clay/Apollo alternative run by AI agents). API-only Cloudflare Worker (Hono) + Neon Postgres.
Naive runs the agents and calls our MCP tools; AgentMail handles email (opted-in leads only); Monid is the data
provider gateway; HubSpot and Notion are synced; Clerk handles users.

Live: https://crusonia.veri-web.workers.dev/health

## Layout

| Path | What |
| --- | --- |
| `src/index.ts` | Worker entry: Hono app (`/`, `/health`) + no-op cron handler |
| `src/env.ts` | `Env` type (vars + secrets) and `requireEnv` |
| `src/db.ts` | Neon HTTP driver (`getSql`), row types, `getLead`, `logEvent` |
| `src/schema.sql` | Idempotent Postgres schema |
| `scripts/migrate.ts` | Applies the schema to Neon (Bun) |
| `scripts/setup.ts` | Creates the AgentMail inbox/webhook and Naive webhook/vault (Bun) |
| `wrangler.jsonc` | Worker config (cron every minute, `PUBLIC_URL`) |
| `worker-configuration.d.ts` | Generated runtime types (`bun run cf-typegen`) |

## Setup, in order

1. **Keys**: `cp .dev.vars.example .dev.vars` and fill in what you have. Each key says where to get it.
   Generate `MCP_TOKEN` with `openssl rand -hex 32`.
2. **Migrate**: `bun run migrate` (reads `DATABASE_URL` from the environment or `.dev.vars`; safe to re-run).
3. **Deploy**: `bun run deploy`. The workers.dev URL is already in `wrangler.jsonc` as `PUBLIC_URL`;
   update it if the URL ever changes.
4. **Upload secrets**: `bun run secrets` (= `wrangler secret bulk .dev.vars`). Never pass secrets as CLI arguments.
5. **Provider setup**: `bun run setup --write` creates the AgentMail inbox + webhook and the Naive webhook +
   vault credential, and writes `AGENTMAIL_INBOX_ID`, `AGENTMAIL_WEBHOOK_SECRET`, `NAIVE_WEBHOOK_SECRET`,
   `NAIVE_VAULT_ID` into `.dev.vars` (drop `--write` to only print them). Idempotent; providers without a key
   are skipped. Naive agent creation is still a TODO (needs the playbook and MCP tools).
6. **Upload again and redeploy**: `bun run secrets && bun run deploy`.

## Day to day

- `bun run dev`: local Worker on :8787 (reads `.dev.vars`). `bunx wrangler dev --test-scheduled` to trigger the cron at `/__scheduled`.
- `bun run typecheck`: Worker (`tsconfig.json`) and Bun scripts (`scripts/tsconfig.json`).
- `bun run deploy:dry`: build without deploying.
- `bun run cf-typegen`: regenerate runtime types after changing `compatibility_date` or flags.

## Contributing

`main` is protected: changes land through pull requests. Front-facing code (`src/web/**`, `public/**`, `*.tsx`,
`design/**`) is owned by @DannyMang in CODEOWNERS and ships only after the design is approved in Paper.
