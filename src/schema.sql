-- Idempotent: runs on every boot.

create table if not exists leads (
  id             text primary key,
  email          text not null unique,
  name           text,
  company        text,
  website        text,
  sells          text,
  best_customers text,
  source         text not null,
  consent_text   text,
  consent_at     timestamptz,
  variant        text not null check (variant in ('A', 'B')),
  -- new | no_consent | researching | qualified | disqualified | needs_review | awaiting_approval
  -- | sent | replied | interested | not_interested | meeting_booked | unsubscribed
  stage          text not null default 'new',
  score          int,
  qualified      boolean,
  rationale      text,
  review_question text,
  reply_label    text,
  hubspot_id     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Leads found by agents (MCP `add_leads`) have no consent and often no email yet. They are deduped by
-- email when there is one, otherwise by company domain + lowercased name (empty name = the company itself).
-- Emails are stored lowercased. These statements are safe to re-run.
alter table leads alter column email drop not null;
alter table leads add column if not exists domain       text;
alter table leads add column if not exists title        text;
alter table leads add column if not exists linkedin_url text;
alter table leads add column if not exists source_url   text;
create unique index if not exists leads_no_email_uq
  on leads (domain, (coalesce(lower(name), ''))) where email is null;
create index if not exists leads_stage_idx on leads (stage, updated_at desc);

create table if not exists evidence (
  id         bigserial primary key,
  lead_id    text not null references leads(id) on delete cascade,
  claim      text not null,
  source_url text not null,
  created_at timestamptz not null default now()
);
create index if not exists evidence_lead_idx on evidence (lead_id, id);

create table if not exists lookalikes (
  id         bigserial primary key,
  lead_id    text not null references leads(id) on delete cascade,
  company    text not null,
  domain     text,
  why_fit    text not null,
  source_url text,
  created_at timestamptz not null default now()
);

-- Drafts are immutable: a rewrite is a new version that supersedes the old one.
create table if not exists drafts (
  id                  text primary key,
  lead_id             text not null references leads(id) on delete cascade,
  version             int not null,
  variant             text not null,
  subject             text not null,
  body                text not null,
  -- draft | pending_approval | rejected | sending | sent | send_failed | superseded | cancelled
  status              text not null default 'draft',
  provider_message_id text,
  provider_thread_id  text,
  error               text,
  created_at          timestamptz not null default now(),
  unique (lead_id, version)
);

-- One row per human decision the system is waiting on. `code` is what the owner types in iMessage.
create table if not exists approvals (
  code             text primary key,
  kind             text not null check (kind in ('send', 'tool', 'question')),
  lead_id          text references leads(id) on delete cascade,
  draft_id         text references drafts(id) on delete cascade,
  naive_session_id text,
  tool_call_id     text,
  summary          text not null,
  -- pending | approved | rejected | answered | expired
  status           text not null default 'pending',
  answer           text,
  decided_via      text,
  expires_at       timestamptz not null,
  decided_at       timestamptz,
  created_at       timestamptz not null default now()
);
create unique index if not exists approvals_tool_call_uq
  on approvals (naive_session_id, tool_call_id) where tool_call_id is not null;

create table if not exists messages (
  id                  bigserial primary key,
  lead_id             text references leads(id) on delete cascade,
  direction           text not null check (direction in ('in', 'out')),
  provider_message_id text unique,
  thread_id           text,
  from_addr           text,
  to_addr             text,
  subject             text,
  body                text,
  created_at          timestamptz not null default now()
);

create table if not exists naive_sessions (
  id          text primary key,
  lead_id     text references leads(id) on delete cascade,
  purpose     text not null,
  -- running | idle | done | error
  status      text not null default 'running',
  stop_reason text,
  last_seq    int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Append-only audit trail; the lead timeline and run history read from here.
create table if not exists events (
  id         bigserial primary key,
  lead_id    text,
  kind       text not null,
  data       jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists events_lead_idx on events (lead_id, id);

create table if not exists webhook_events (
  event_id    text primary key,
  source      text not null,
  received_at timestamptz not null default now()
);

create table if not exists suppressions (
  email      text primary key,
  reason     text not null,
  created_at timestamptz not null default now()
);

create table if not exists settings (
  key   text primary key,
  value jsonb not null
);
insert into settings (key, value) values ('paused', 'false') on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Core loop (REST API). Additive and idempotent: safe to re-run on an existing database.
-- ---------------------------------------------------------------------------

-- Keyset pagination for GET /api/leads (newest first; created_at never changes, unlike updated_at).
create index if not exists leads_created_idx on leads (created_at desc, id desc);

-- Approval binding and context. A send approval is bound to `recipient` (the exact address) and
-- `draft_id` (the exact immutable version). `payload` holds the tool call or question for kinds
-- 'tool' and 'question'; it came from the agent and is untrusted.
-- A closed approval that nobody decided is 'expired'; `decided_via` says why: 'timeout', 'superseded'
-- (a newer draft), 'reply_received', 'consent_revoked', 'complaint'.
alter table approvals add column if not exists recipient text;
alter table approvals add column if not exists payload jsonb not null default '{}';
create index if not exists approvals_pending_idx on approvals (expires_at) where status = 'pending';

-- Send bookkeeping: `sending_at` is when the draft was claimed for sending (the cron reconciles drafts
-- stuck in 'sending' against AgentMail); `delivered_at` comes from message.delivered.
alter table drafts add column if not exists sending_at timestamptz;
alter table drafts add column if not exists delivered_at timestamptz;
create index if not exists drafts_thread_idx on drafts (provider_thread_id) where provider_thread_id is not null;

-- Inbound reply classification: interested | not_interested | unsubscribe | out_of_office | other.
alter table messages add column if not exists label text;
create index if not exists messages_thread_idx on messages (thread_id) where thread_id is not null;

create index if not exists naive_sessions_status_idx on naive_sessions (status, updated_at);

-- ---------------------------------------------------------------------------
-- Web app API (dashboard, onboarding, workflows, experiments, API keys). Additive and idempotent.
-- ---------------------------------------------------------------------------

-- Naive sessions as workflow runs. `input` is what the owner started the run with (onboarding url or
-- description, find_leads count). `consumed_micro_usd` is Naive's running total for the session (null =
-- not reported yet). `events_seq` is how far the event cache below goes; it is separate from `last_seq`,
-- which belongs to the reconcile cron. `leads_processed` counts leads a find_leads run added or updated.
alter table naive_sessions add column if not exists input jsonb not null default '{}';
alter table naive_sessions add column if not exists consumed_micro_usd bigint;
alter table naive_sessions add column if not exists events_seq int not null default 0;
alter table naive_sessions add column if not exists events_synced_at timestamptz;
alter table naive_sessions add column if not exists last_event_at timestamptz;
alter table naive_sessions add column if not exists leads_processed int not null default 0;
create index if not exists naive_sessions_purpose_idx on naive_sessions (purpose, created_at desc);

-- Cached Naive session events for the run view (GET /api/workflows/runs/:id). Tool outputs and messages
-- came from the agent and the web: untrusted, stored as data and truncated.
create table if not exists naive_session_events (
  session_id text not null references naive_sessions(id) on delete cascade,
  seq        int not null,
  type       text not null,
  data       jsonb not null default '{}',
  created_at timestamptz not null,
  primary key (session_id, seq)
);

-- A/B experiments. Arms are the lead variants A and B (stable per lead). Leads are enrolled explicitly
-- (leads.experiment_id); drafts created while the lead's experiment is running carry its id, and the
-- per-arm stats are computed from those drafts, their replies and reply labels.
create table if not exists experiments (
  id                      text primary key,
  name                    text not null,
  hypothesis              text,
  segment                 text,
  metric                  text not null default 'positive_reply_rate',
  stop_rule_sends_per_arm int,
  stop_rule_days          int,
  -- running | stopped
  status                  text not null default 'running' check (status in ('running', 'stopped')),
  variants                jsonb not null default '{}',
  created_at              timestamptz not null default now(),
  stopped_at              timestamptz
);
alter table leads add column if not exists experiment_id text references experiments(id) on delete set null;
alter table drafts add column if not exists experiment_id text references experiments(id) on delete set null;
create index if not exists leads_experiment_idx on leads (experiment_id) where experiment_id is not null;
create index if not exists drafts_experiment_idx on drafts (experiment_id, variant) where experiment_id is not null;

-- GET /api/replies: inbound messages, newest first.
create index if not exists messages_inbound_idx on messages (id desc) where direction = 'in';

-- Per-user API keys for /mcp and /api ("Connect your agent"). Only the SHA-256 of the key is stored;
-- `prefix` (crs_live_ + 8 chars) identifies it in the UI. A revoked key never authenticates again.
create table if not exists api_keys (
  id           text primary key,
  name         text not null,
  prefix       text not null,
  hash         text not null unique,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
