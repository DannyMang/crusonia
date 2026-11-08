-- Idempotent: safe to re-run (`bun run migrate`). Tenant tables get their `workspace_id` in the "Workspaces"
-- section at the end of this file, after every table exists.

-- A workspace is one customer's private space: its Company summary, leads, approvals, budget and credits.
-- 'ws_owner' is the instance owner's workspace (MCP_TOKEN, OWNER_CLERK_USER_ID, and every row that existed
-- before workspaces). Per-workspace settings are columns here: `paused` (the kill switch), `daily_cap_micro_usd`
-- (Naive spend cap per rolling day; null = WORKSPACE_DAILY_CAP_USD) and the workspace's own Naive agent.
create table if not exists workspaces (
  id         text primary key,
  name       text not null,
  created_at timestamptz not null default now()
);
alter table workspaces add column if not exists paused boolean not null default false;
alter table workspaces add column if not exists daily_cap_micro_usd bigint;
-- The workspace's Naive agent (src/services/naive-agents.ts): a copy of the owner's template agent whose crusonia
-- MCP server URL is /mcp?ws=<id>, with a vault credential bound to that agent holding a workspace API key.
-- Null for the owner workspace, which uses NAIVE_AGENT_ID and the MCP_TOKEN credential.
alter table workspaces add column if not exists naive_agent_id text;
alter table workspaces add column if not exists naive_credential_id text;
alter table workspaces add column if not exists naive_api_key_id text;
alter table workspaces add column if not exists naive_mcp_url text;
alter table workspaces add column if not exists naive_template_version int;
alter table workspaces add column if not exists naive_synced_at timestamptz;
alter table workspaces add column if not exists naive_provisioning_at timestamptz;
insert into workspaces (id, name) values ('ws_owner', 'Owner') on conflict (id) do nothing;

-- Who belongs to a workspace. A user can belong to several; the web app names one per request (X-Crusonia-Workspace),
-- and src/services/workspaces.ts checks it against this table on every request.
create table if not exists workspace_members (
  workspace_id  text not null references workspaces(id),
  clerk_user_id text not null,
  role          text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at    timestamptz not null default now(),
  primary key (workspace_id, clerk_user_id)
);
-- Before teams: one workspace per user, and only owner and member.
drop index if exists workspace_members_user_uq;
create index if not exists workspace_members_user_idx on workspace_members (clerk_user_id, created_at);
alter table workspace_members drop constraint if exists workspace_members_role_check;
alter table workspace_members add constraint workspace_members_role_check check (role in ('owner', 'admin', 'member'));
alter table workspace_members alter column role set default 'member';
-- scripts/migrate.ts passes OWNER_CLERK_USER_ID as the session setting crusonia.owner_clerk_user_id (never in
-- this file: it stays out of the repo). Without it the owner joins on first sign-in (src/services/workspaces.ts).
insert into workspace_members (workspace_id, clerk_user_id, role)
select 'ws_owner', current_setting('crusonia.owner_clerk_user_id', true), 'owner'
where coalesce(current_setting('crusonia.owner_clerk_user_id', true), '') <> ''
on conflict do nothing;

create table if not exists leads (
  id             text primary key,
  -- Unique per workspace (leads_ws_email_uq, Workspaces section).
  email          text,
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
-- (A company, a lead without an email, is unique per workspace on its domain: leads_ws_company_uq in the Workspaces
-- section.)
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
-- Instance-wide keys only (CRM sync state). Per-workspace settings are columns on `workspaces`.

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

-- A/B experiments: no longer used by the code (the feature was removed); the table and columns are kept as they are.
-- Arms are the lead variants A and B (stable per lead). Leads are enrolled explicitly
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

-- ---------------------------------------------------------------------------
-- Billing (Stripe). Additive and idempotent. Tiers and the credit definition live in src/billing/plans.ts.
-- ---------------------------------------------------------------------------

-- One row per billing owner: the Clerk user id, or 'owner' for MCP_TOKEN and API-key callers.
-- The Stripe customer is created by us for this owner (never matched by email). `plan` is the plans.ts key of
-- the current monthly plan (null = pay as you go). `subscription_event_at` is the `created` time of the last
-- subscription event applied, so an older event delivered late never overwrites a newer state.
create table if not exists billing_accounts (
  owner_id               text primary key,
  stripe_customer_id     text unique,
  stripe_subscription_id text,
  plan                   text,
  -- Stripe subscription status: active | trialing | past_due | unpaid | canceled | incomplete | incomplete_expired | paused
  subscription_status    text,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  subscription_event_at  timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- Append-only credit ledger. `amount` is in whole credits (1 credit = $0.01 of list value), signed:
-- + grant | pack | plan, - usage | refund | expire. The balance is sum(amount) per owner (may go negative after a
-- refund or a long session). Plan grants carry `expires_at` (the period end plus the rollover month); usage spends
-- the soonest-expiring credits first and the cron writes off what is left at expiry. `source` makes every write
-- idempotent:
--   signup:<owner>          free sample (once per owner)
--   checkout:<session id>   credit pack bought through Checkout (payment mode)
--   invoice:<invoice id>    monthly plan credits for a paid subscription invoice
--   usage:<naive session>   hosted agent spend x markup when the session finishes (+ `:<micro-usd>` top-ups if
--                           the session resumes and spends more)
--   apify:<run id>:<total credits>   an Apify Actor run's usage x markup (a later row tops up if usage grew)
--   refund:<charge>:<cumulative amount refunded>   claw-back of the purchase in `purchase_source`
--   expire:<grant source>   the unused rest of an expired plan grant (`purchase_source`)
--   adjustment:<anything>   manual correction (insert by hand)
create table if not exists credit_ledger (
  id                    bigserial primary key,
  owner_id              text not null,
  amount                bigint not null check (amount <> 0),
  reason                text not null check (reason in ('grant', 'pack', 'plan', 'usage', 'refund', 'expire', 'adjustment')),
  source                text not null unique,
  -- usage rows: the Naive session; refund and expire rows: the source of the purchase they reduce
  session_id            text,
  purchase_source       text,
  -- plan grants: when the unused rest expires (null = never)
  expires_at            timestamptz,
  -- purchases paid through a Checkout payment: the PaymentIntent a later refund points to
  stripe_payment_intent text,
  data                  jsonb not null default '{}',
  created_at            timestamptz not null default now()
);
create index if not exists credit_ledger_owner_idx on credit_ledger (owner_id, id desc);
create index if not exists credit_ledger_session_idx on credit_ledger (session_id) where session_id is not null;
create index if not exists credit_ledger_purchase_idx on credit_ledger (purchase_source) where purchase_source is not null;
create index if not exists credit_ledger_pi_idx on credit_ledger (stripe_payment_intent) where stripe_payment_intent is not null;
create index if not exists credit_ledger_expires_idx on credit_ledger (expires_at) where expires_at is not null;

-- Enforce append-only: corrections are new rows. Deletes are allowed only inside a transaction that sets
-- `crusonia.allow_ledger_delete = 'on'` (test cleanup on a dev branch).
create or replace function credit_ledger_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('crusonia.allow_ledger_delete', true) = 'on' then
    return old;
  end if;
  -- The one-time workspaces backfill: setting workspace_id on a row that has none, nothing else.
  if tg_op = 'UPDATE' and (to_jsonb(old)->>'workspace_id') is null and (to_jsonb(new)->>'workspace_id') is not null
     and (to_jsonb(new) - 'workspace_id') = (to_jsonb(old) - 'workspace_id') then
    return new;
  end if;
  raise exception 'credit_ledger is append-only: add a correcting row instead';
end
$$;
drop trigger if exists credit_ledger_append_only on credit_ledger;
create trigger credit_ledger_append_only before update or delete on credit_ledger
  for each row execute function credit_ledger_append_only();

-- Who pays for a Naive session (the billing owner of the caller that started it). Null for sessions started
-- before billing existed: those are never debited.
alter table naive_sessions add column if not exists billing_owner_id text;
create index if not exists naive_sessions_billing_idx on naive_sessions (status, updated_at) where billing_owner_id is not null;

-- ---------------------------------------------------------------------------
-- CRM sync (HubSpot, Notion). Additive and idempotent. See "CRM sync" in README.md.
-- ---------------------------------------------------------------------------

-- External ids live on our rows so every push is an upsert. `hubspot_id` (the contact) predates this section.
-- `hubspot_state` remembers what we last wrote to fields we share with HubSpot users (hs_lead_status) and the
-- contact/company pair we associated, so a later sync never clobbers a value someone changed in HubSpot.
-- `notion_hash` is a hash of the last properties written to the lead's Notion page (unchanged = no call).
-- Sync never touches `updated_at`.
alter table leads add column if not exists hubspot_company_id text;
alter table leads add column if not exists hubspot_state jsonb not null default '{}';
alter table leads add column if not exists hubspot_synced_at timestamptz;
alter table leads add column if not exists notion_page_id text;
alter table leads add column if not exists notion_hash text;
alter table leads add column if not exists notion_synced_at timestamptz;
create index if not exists leads_hubspot_idx on leads (hubspot_id) where hubspot_id is not null;
-- The HubSpot note that carries this evidence row or email. Identical evidence (same claim + URL) shares a note.
alter table evidence add column if not exists hubspot_note_id text;
alter table messages add column if not exists hubspot_note_id text;

-- Work for the minute cron. One row per (target, entity, lead): a burst of events for a lead collapses into one
-- sync. entity 'lead' pushes the lead's current state; 'import' is the HubSpot import job (lead_id null, its
-- cursor and counters in `payload`). `version` goes up on every enqueue, so a change that lands while the row is
-- being processed is synced again instead of being lost. 'failed' = gave up after MAX_ATTEMPTS (or a permanent
-- error); the next event or manual sync for that lead re-queues it.
create table if not exists crm_sync_queue (
  id              bigserial primary key,
  target          text not null check (target in ('hubspot', 'notion')),
  entity          text not null check (entity in ('lead', 'import')),
  lead_id         text references leads(id) on delete cascade,
  reason          text,
  payload         jsonb not null default '{}',
  status          text not null default 'pending' check (status in ('pending', 'failed')),
  attempts        int not null default 0,
  last_error      text,
  next_attempt_at timestamptz not null default now(),
  locked_until    timestamptz,
  version         int not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists crm_sync_queue_key on crm_sync_queue (target, entity, (coalesce(lead_id, '')));
create index if not exists crm_sync_queue_due_idx on crm_sync_queue (target, entity, next_attempt_at) where status = 'pending';

-- Enqueue from the audit trail: every state change already writes an `events` row in the same transaction, so a
-- trigger on it catches every write path (MCP, REST, webhooks, CSV) with no extra code in them and no lost
-- updates. Only for targets listed in settings 'crm_sync_targets', which the cron mirrors from
-- HUBSPOT_SYNC_ENABLED / NOTION_SYNC_ENABLED: nothing is queued while sync is off. Events written by the HubSpot
-- import itself (data.via = 'hubspot_import') are skipped, so imported contacts are not pushed straight back.
create or replace function crm_sync_enqueue() returns trigger language plpgsql as $$
declare
  targets text[];
begin
  if new.lead_id is null or not (new.kind = any (array[
       'lead_added', 'lead_updated', 'lead_email_found', 'lead_scored', 'evidence_saved', 'lead_stage_changed',
       'lead_consent_granted', 'lead_consent_revoked', 'research_started', 'draft_created', 'email_sent',
       'email_received', 'reply_classified', 'email_complained'])) then
    return null;
  end if;
  if coalesce(new.data->>'via', '') = 'hubspot_import' then
    return null;
  end if;
  -- CRM sync uses the instance's own HubSpot / Notion (env), so it covers the owner workspace only.
  if new.workspace_id is distinct from 'ws_owner' then
    return null;
  end if;
  select array(select jsonb_array_elements_text(value)) into targets
  from settings where key = 'crm_sync_targets' and jsonb_typeof(value) = 'array';
  if targets is null or cardinality(targets) = 0 then
    return null;
  end if;
  insert into crm_sync_queue as q (workspace_id, target, entity, lead_id, reason)
  select new.workspace_id, t, 'lead', new.lead_id, new.kind
  from unnest(targets) t
  where t in ('hubspot', 'notion') and exists (select 1 from leads where id = new.lead_id)
  on conflict (target, entity, (coalesce(lead_id, ''))) do update set
    reason = excluded.reason,
    version = q.version + 1,
    attempts = case when q.status = 'failed' then 0 else q.attempts end,
    next_attempt_at = case when q.status = 'failed' then now() else q.next_attempt_at end,
    status = 'pending',
    updated_at = now();
  return null;
end
$$;
drop trigger if exists events_crm_sync on events;
create trigger events_crm_sync after insert on events for each row execute function crm_sync_enqueue();

-- ---------------------------------------------------------------------------
-- iMessage approvals (Photon). Additive and idempotent. See "iMessage approvals (Photon)" in README.md.
-- ---------------------------------------------------------------------------

-- Texts for the owner, pulled by the bridge (POST /webhooks/photon/poll). One row per notice, keyed so each approval
-- is announced once ('approval:<code>') and reminded at most once ('warn:<code>'). `leased_at` is when a poll handed
-- it to the bridge (a lease that is never acked expires after 2 minutes); `delivered_at` when the bridge confirmed the
-- text went out. Rows whose approval closed are never sent. Decisions made by text have approvals.decided_via = 'imessage'.
-- Tapbacks: `message_id` is the iMessage id of the delivered bubble (reported by the bridge) and `draft_id` the exact
-- draft version it showed, so a 👍 on that bubble approves that approval and version only.
create table if not exists imessage_outbox (
  id            text primary key,
  approval_code text not null references approvals(code) on delete cascade,
  kind          text not null check (kind in ('approval', 'expiry_warning')),
  draft_id      text,
  created_at    timestamptz not null default now(),
  leased_at     timestamptz,
  attempts      int not null default 0,
  delivered_at  timestamptz,
  message_id    text,
  last_error    text
);
create index if not exists imessage_outbox_due_idx on imessage_outbox (created_at) where delivered_at is null;
-- Send cap (src/services/imessage.ts): notices beyond the cap are not texted one by one; they are marked skipped
-- ('rate_limited') and collapse into one "+N more approvals waiting" text.
alter table imessage_outbox add column if not exists skipped_at timestamptz;
alter table imessage_outbox add column if not exists skip_reason text;
create unique index if not exists imessage_outbox_message_uq on imessage_outbox (message_id) where message_id is not null;

-- ---------------------------------------------------------------------------
-- Agent loop v2: outreach channels and the manual task queue, batched research, Apify metering.
-- Additive and idempotent. Scoped by workspace in the Workspaces section below (apify_runs, lead_notes).
-- ---------------------------------------------------------------------------

-- A draft's channel. 'email' goes out through AgentMail only after a send approval, and only to opted-in leads
-- (unchanged). Every other channel is a manual task the owner sends personally and then marks sent or skipped:
-- 'email_manual' (from the owner's own mailbox), 'linkedin', 'x', 'intro' (a forwardable blurb for a warm
-- introduction). Manual drafts never get an approval and nothing ever sends them. Their status is
-- open -> sent | skipped | superseded. One open draft per lead across channels: a new version of any channel
-- supersedes the older open one. `target_url` is the profile the owner opens to send it (LinkedIn or X).
-- `citations` links factual phrases in the body to the lead's saved evidence: [{text, source_url}].
alter table drafts add column if not exists channel text not null default 'email';
alter table drafts drop constraint if exists drafts_channel_check;
alter table drafts add constraint drafts_channel_check check (channel in ('email', 'email_manual', 'linkedin', 'x', 'intro'));
alter table drafts add column if not exists target_url text;
alter table drafts add column if not exists citations jsonb not null default '[]';
alter table drafts add column if not exists closed_at timestamptz;
create index if not exists drafts_tasks_idx on drafts (status, created_at desc) where channel <> 'email';

-- Outbound messages the owner sent by hand (a marked-sent task) carry their channel; email rows are 'email'.
alter table messages add column if not exists channel text not null default 'email';

-- The agent's suggested next step after research (save_research), e.g. "LinkedIn note to the CEO about the
-- SDR job post".
alter table leads add column if not exists next_step text;

-- Every Apify Actor run Crusonia starts (search_web, read_website). `usage_micro_usd` is the run's
-- usageTotalUsd in micro-USD; Apify finalizes it shortly after the run ends, so the cron re-reads it once
-- (`usage_final`). The billing owner is debited usage x the markup in src/billing/plans.ts, like Naive spend:
-- ledger rows `apify:<run id>:<total credits>`, `debited_credits` is what was debited so far (top-ups only).
create table if not exists apify_runs (
  run_id           text primary key,
  actor            text not null,
  status           text not null,
  usage_micro_usd  bigint,
  usage_final      boolean not null default false,
  max_charge_usd   numeric,
  billing_owner_id text,
  session_id       text,
  via              text,
  debited_credits  bigint not null default 0,
  created_at       timestamptz not null default now(),
  finished_at      timestamptz,
  updated_at       timestamptz not null default now()
);
create index if not exists apify_runs_open_idx on apify_runs (updated_at) where usage_final = false;

-- One lead per company. Agent-found leads without an email are keyed by the company's normalized domain
-- (src/services/domains.ts): add_leads merges into the existing row instead of adding a second one.
-- `contacts`: named people at the company, only from public pages the agent read:
-- [{name, title, linkedin_url, x_url, github_url, source_url, found_at}], merged by name (name/title/linkedin_url
-- stay the first-seen person). `links`: the company's links [{kind: website|linkedin|github|x|other, url, source_url,
-- found_at}], merged by URL. No other enrichment (funding, headcount...) is stored unless a cited evidence item says it.
-- `why_summary`: the agent's 2-4 sentence "why we picked this", citing the lead's evidence by number (oldest first).
-- `excluded_at`: the owner excluded the company; like a disqualified lead it is remembered and skipped by future
-- runs until the owner un-excludes it. Per workspace, a company is unique on its normalized domain (leads_ws_company_uq
-- in the Workspaces section).
alter table leads add column if not exists contacts jsonb not null default '[]';
alter table leads add column if not exists links jsonb not null default '[]';
alter table leads add column if not exists why_summary text;
alter table leads add column if not exists excluded_at timestamptz;
alter table leads add column if not exists excluded_reason text;
create index if not exists leads_domain_idx on leads (domain) where domain is not null;

-- Notes on a lead, from the owner (`user:<id>`) or an agent (`agent:<session id>`, or `agent:mcp`). kind
-- 'thumbs_down' / 'thumbs_up' is the owner's rating of a pick, with the reason as the body. Agents read a lead's notes
-- (get_lead) and the owner's recent notes across leads (get_profile) before finding or researching. Authors edit and
-- delete only their own notes.
create table if not exists lead_notes (
  id         bigserial primary key,
  lead_id    text not null references leads(id) on delete cascade,
  author     text not null,
  kind       text not null default 'note' check (kind in ('note', 'thumbs_down', 'thumbs_up')),
  body       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists lead_notes_lead_idx on lead_notes (lead_id, id desc);
create index if not exists lead_notes_author_idx on lead_notes (id desc) where author like 'user:%';

-- Pause on missing evidence: evidence items name the qualification workflow requirement they satisfy (settings key
-- 'qualification_workflow:<workspace id>', src/services/qualification.ts). A lead missing required evidence is never scored: it
-- goes to needs_review with `review_question` (a column that predates this).
alter table evidence add column if not exists requirement text;

-- ---------------------------------------------------------------------------
-- Workspaces (multi-tenancy). Additive and idempotent. See "Workspaces" in README.md.
-- Every tenant table gets a NOT NULL workspace_id; rows that existed before workspaces belong to 'ws_owner'.
-- Uniqueness that used to be global is per workspace now (lead dedupe, suppressions, one billing account).
-- Instance-wide tables stay global: settings (CRM sync state) and webhook_events (provider event ids).
-- The experiments table (and leads/drafts.experiment_id) is no longer used by the code (the feature was removed);
-- it is kept as it is, not scoped and not dropped.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'leads', 'evidence', 'lookalikes', 'drafts', 'approvals', 'messages', 'naive_sessions', 'naive_session_events',
    'events', 'suppressions', 'api_keys', 'billing_accounts', 'credit_ledger', 'crm_sync_queue', 'imessage_outbox',
    'apify_runs', 'lead_notes'
  ] loop
    execute format('alter table %I add column if not exists workspace_id text references workspaces(id)', t);
    execute format('update %I set workspace_id = %L where workspace_id is null', t, 'ws_owner');
    execute format('alter table %I alter column workspace_id set not null', t);
  end loop;
end
$$;

-- Company domains are normalized so a company is stored once per workspace: lowercase, no scheme, path, port or
-- `www.`, reduced to the registrable domain ('blog.acme.co.uk' -> 'acme.co.uk'). Same rules as
-- src/services/domains.ts (keep the suffix lists in sync). A trigger applies it to every leads write, whatever the
-- code path; a value that doesn't parse as a domain is kept as written.
create or replace function crusonia_registrable_domain(v text) returns text language plpgsql immutable as $$
declare
  h text;
  labels text[];
  n int;
begin
  if v is null then
    return null;
  end if;
  h := lower(btrim(v));
  h := regexp_replace(h, '^[a-z][a-z0-9+.-]*://', '');
  h := split_part(split_part(split_part(h, '/', 1), '?', 1), '#', 1);
  h := regexp_replace(h, '^.*@', '');
  h := regexp_replace(h, ':[0-9]*$', '');
  h := regexp_replace(h, '\.$', '');
  h := regexp_replace(h, '^www[0-9]*\.', '');
  if h !~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' then
    return null;
  end if;
  labels := string_to_array(h, '.');
  n := array_length(labels, 1);
  if n <= 2 then
    return h;
  end if;
  if (labels[n - 1] || '.' || labels[n]) = any (array[
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
    'co.nz', 'org.nz', 'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'or.kr', 'com.br', 'net.br', 'org.br', 'com.mx', 'com.ar',
    'com.co', 'com.pe', 'co.in', 'net.in', 'org.in', 'co.za', 'org.za', 'com.sg', 'com.my', 'com.hk', 'com.tw',
    'com.cn', 'net.cn', 'org.cn', 'com.tr', 'co.il', 'org.il', 'com.ua', 'co.id', 'com.ph', 'com.vn', 'com.pk',
    'com.ng', 'com.eg', 'com.sa', 'co.th', 'co.ke',
    'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'herokuapp.com', 'workers.dev', 'pages.dev', 'web.app',
    'firebaseapp.com', 'appspot.com', 'azurewebsites.net', 'cloudfront.net', 'blogspot.com', 'wordpress.com',
    'substack.com', 'notion.site', 'webflow.io', 'framer.website', 'framer.app', 'myshopify.com', 'wixsite.com',
    'squarespace.com', 'carrd.co', 'bubbleapps.io', 'replit.app', 'fly.dev', 'onrender.com', 'railway.app',
    'glitch.me', 'readthedocs.io']) then
    return array_to_string(labels[n - 2:n], '.');
  end if;
  return labels[n - 1] || '.' || labels[n];
end
$$;

create or replace function leads_normalize_domain() returns trigger language plpgsql as $$
begin
  new.domain := coalesce(crusonia_registrable_domain(new.domain), new.domain);
  return new;
end
$$;
drop trigger if exists leads_normalize_domain on leads;
create trigger leads_normalize_domain before insert or update of domain on leads
  for each row execute function leads_normalize_domain();

-- Backfill: a lead without an email is the company (one per normalized domain per workspace; named people at it are
-- its `contacts`). Email-less leads that share a normalized domain in one workspace are merged into the oldest: their
-- evidence, approvals, messages, sessions, notes and events move over, a named person becomes a contact, blank fields
-- are filled, a 'lead_merged' event records it, and the duplicate is deleted. Then every domain is normalized.
do $$
declare
  d record;
begin
  for d in
    select id, keeper from (
      select id, first_value(id) over (
               partition by workspace_id, coalesce(crusonia_registrable_domain(domain), domain)
               order by created_at, id) as keeper
      from leads where email is null and domain is not null
    ) r
    where id <> keeper
  loop
    update evidence set lead_id = d.keeper where lead_id = d.id;
    update lookalikes set lead_id = d.keeper where lead_id = d.id;
    update approvals set lead_id = d.keeper where lead_id = d.id;
    update messages set lead_id = d.keeper where lead_id = d.id;
    update naive_sessions set lead_id = d.keeper where lead_id = d.id;
    update drafts set lead_id = d.keeper,
           version = version + (select coalesce(max(version), 0) from drafts where lead_id = d.keeper)
    where lead_id = d.id;
    update events set lead_id = d.keeper where lead_id = d.id;
    update lead_notes set lead_id = d.keeper where lead_id = d.id;
    delete from crm_sync_queue where lead_id = d.id;
    update leads k set contacts = k.contacts || jsonb_build_array(jsonb_build_object(
      'name', x.name, 'title', x.title, 'linkedin_url', x.linkedin_url, 'x_url', null, 'github_url', null,
      'source_url', coalesce(x.source_url, x.website, ''), 'found_at', to_char(x.created_at, 'YYYY-MM-DD')))
    from leads x
    where k.id = d.keeper and x.id = d.id and coalesce(x.name, '') <> '' and lower(x.name) <> lower(coalesce(k.name, ''))
      and not exists (select 1 from jsonb_array_elements(k.contacts) c where lower(c->>'name') = lower(x.name));
    update leads k set
      title = coalesce(k.title, x.title), company = coalesce(k.company, x.company), website = coalesce(k.website, x.website),
      linkedin_url = coalesce(k.linkedin_url, x.linkedin_url), score = coalesce(k.score, x.score),
      qualified = coalesce(k.qualified, x.qualified), rationale = coalesce(k.rationale, x.rationale),
      hubspot_id = coalesce(k.hubspot_id, x.hubspot_id), hubspot_company_id = coalesce(k.hubspot_company_id, x.hubspot_company_id),
      notion_page_id = coalesce(k.notion_page_id, x.notion_page_id), updated_at = now()
    from leads x where k.id = d.keeper and x.id = d.id;
    insert into events (workspace_id, lead_id, kind, data)
    select workspace_id, d.keeper, 'lead_merged', jsonb_build_object('merged_lead_id', d.id, 'domain', domain, 'reason', 'domain_normalized')
    from leads where id = d.id;
    delete from leads where id = d.id;
  end loop;
end
$$;
update leads set domain = crusonia_registrable_domain(domain)
where crusonia_registrable_domain(domain) is not null and domain is distinct from crusonia_registrable_domain(domain);

-- Lead dedupe per workspace: a person by email; a company (a lead without an email) by its normalized domain, so the
-- same company is never logged twice in a workspace. People at a company repeat freely (with their emails, or as the
-- company's contacts).
alter table leads drop constraint if exists leads_email_key;
drop index if exists leads_no_email_uq;
drop index if exists leads_ws_no_email_uq;
create unique index if not exists leads_ws_email_uq on leads (workspace_id, email);
create unique index if not exists leads_ws_company_uq on leads (workspace_id, domain) where email is null;
create index if not exists leads_ws_created_idx on leads (workspace_id, created_at desc, id desc);
create index if not exists leads_ws_stage_idx on leads (workspace_id, stage, updated_at desc);

-- What the demo's run history reads (per workspace, like everything above): each lead keeps its A/B `variant`
-- (deterministic from its email or domain + name, never reassigned) and its `cohort`, the batch that first brought it
-- in ('import:<id>' for a CSV import, 'run:<session id>' for an agent run, 'hubspot_import:<time>', 'manual'); set
-- once on insert, never changed. Leads from before cohorts get '<source>:<day added>'. Runs record the workflow
-- version they ran (playbook and agent version), and a draft written in a run records that run and its version.
alter table leads add column if not exists cohort text;
update leads set cohort = source || ':' || to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') where cohort is null;
-- The qualification workflow is per workspace (settings key 'qualification_workflow:<workspace id>'); the owner keeps
-- the one saved before workspaces.
insert into settings (key, value)
select 'qualification_workflow:ws_owner', value from settings where key = 'qualification_workflow'
on conflict (key) do nothing;
create index if not exists leads_ws_cohort_idx on leads (workspace_id, cohort);
alter table naive_sessions add column if not exists workflow_version text;
alter table drafts add column if not exists workflow_version text;
alter table drafts add column if not exists session_id text;
alter table workspaces add column if not exists naive_workflow_version text;

-- The do-not-contact list is per workspace.
alter table suppressions drop constraint if exists suppressions_pkey;
create unique index if not exists suppressions_ws_email_uq on suppressions (workspace_id, email);

create index if not exists approvals_ws_idx on approvals (workspace_id, status, created_at desc);
create index if not exists drafts_ws_lead_idx on drafts (workspace_id, lead_id);
create index if not exists messages_ws_inbound_idx on messages (workspace_id, id desc) where direction = 'in';
create index if not exists naive_sessions_ws_idx on naive_sessions (workspace_id, purpose, created_at desc);
create index if not exists events_ws_idx on events (workspace_id, id desc);
create index if not exists events_ws_kind_idx on events (workspace_id, kind, created_at);
create index if not exists credit_ledger_ws_idx on credit_ledger (workspace_id, id desc);
create index if not exists lead_notes_ws_idx on lead_notes (workspace_id, id desc);
create index if not exists drafts_ws_tasks_idx on drafts (workspace_id, status, created_at desc) where channel <> 'email';

-- API keys: 'user' keys are made in "Connect your agent"; an 'agent' key is the one a workspace's Naive agent
-- uses (held only in the Naive vault, see src/services/naive-agents.ts). Both act only on their workspace.
alter table api_keys add column if not exists kind text not null default 'user';
create index if not exists api_keys_ws_idx on api_keys (workspace_id, created_at desc);

-- The pause switch moved from settings to workspaces.paused (copied once, then the old key is removed).
update workspaces set paused = true
where id = 'ws_owner' and exists (select 1 from settings where key = 'paused' and value = 'true'::jsonb);
delete from settings where key = 'paused';

-- Company summary: what Crusonia knows about the business, as one markdown document per workspace (like a GTM.md).
-- Only the current text is stored: a save overwrites it, and there is no history. `version` counts saves, for the
-- stale-write check. Agents edit it directly. `updated_by`: 'user:<clerk id>', 'agent:<naive session id>' (or
-- 'agent:api_key:<id>' / 'agent:mcp_token' for an agent outside Naive), or 'onboarding'. Capped at 20,000 characters;
-- the web app renders it as sanitized markdown.
create table if not exists company_summaries (
  workspace_id text primary key references workspaces(id),
  content_md   text not null check (char_length(content_md) <= 20000),
  version      int not null default 1 check (version > 0),
  updated_by   text not null,
  updated_at   timestamptz not null default now()
);
-- Before that, company_summary_versions kept one immutable row per edit. A database that still has it keeps each
-- workspace's latest row and loses every older version, on purpose (the owner's decision). A rerun finds no table.
do $$
begin
  if to_regclass('company_summary_versions') is not null then
    insert into company_summaries (workspace_id, content_md, version, updated_by, updated_at)
    select distinct on (workspace_id) workspace_id, content_md, version, author, created_at
    from company_summary_versions
    order by workspace_id, version desc
    on conflict (workspace_id) do nothing;
    drop table company_summary_versions;
  end if;
end
$$;
-- The owner's onboarding profile (settings 'profile') becomes the owner's summary when there is none yet, rendered as
-- markdown under the same headings as src/services/company-summary.ts (profileToMarkdown). The settings row is kept for rollback.
insert into company_summaries (workspace_id, content_md, updated_by)
select 'ws_owner', left(md, 20000), 'onboarding'
from (
  select concat_ws(E'\n\n',
    '# ' || coalesce(nullif(p->>'company', ''), nullif(p->>'company_name', ''), 'Company summary'),
    'Website: ' || nullif(p->>'website', ''),
    '## What we sell',
    nullif(p->>'sells', ''),
    '## Who buys',
    coalesce(nullif(p->>'icp_description', ''), nullif(p->>'icp', '')),
    case when segs is not null then E'### Segments\n\n' || segs end,
    '## Buying signals',
    sigs,
    '## Proof points', '## Voice', '## Avoid', '## Pricing',
    case when nullif(p->>'notes', '') is not null then E'## Notes\n\n' || (p->>'notes') end,
    case when srcs is not null then E'## Sources\n\n' || srcs end
  ) as md
  from (
    select value as p,
      (select string_agg(case when jsonb_typeof(x) = 'string' then '- **' || (x #>> '{}') || '**'
                              else '- **' || coalesce(x->>'name', 'Segment') || '**'
                                   || coalesce(': ' || nullif(concat_ws('; ', nullif(x->>'company_size', ''), nullif(x->>'industry', ''),
                                        case when jsonb_typeof(x->'roles') = 'array' and jsonb_array_length(x->'roles') > 0
                                             then 'roles: ' || (select string_agg(r #>> '{}', ', ') from jsonb_array_elements(x->'roles') r) end), ''), '')
                         end, E'\n')
       from jsonb_array_elements(case when jsonb_typeof(value->'segments') = 'array' then value->'segments' else '[]'::jsonb end) x) as segs,
      (select string_agg(case when jsonb_typeof(x) = 'string' then '- **' || (x #>> '{}') || '**'
                              else '- **' || coalesce(x->>'name', 'Signal') || '**' || coalesce(': ' || nullif(x->>'description', ''), '') end, E'\n')
       from jsonb_array_elements(case when jsonb_typeof(value->'signals') = 'array' then value->'signals'
                                      when jsonb_typeof(value->'buying_signals') = 'array' then value->'buying_signals'
                                      else '[]'::jsonb end) x) as sigs,
      (select string_agg('- ' || (x->>'field') || ': ' || (x->>'url'), E'\n')
       from jsonb_array_elements(case when jsonb_typeof(value->'sources') = 'array' then value->'sources' else '[]'::jsonb end) x
       where x->>'field' is not null and x->>'url' is not null) as srcs
    from settings where key = 'profile' and jsonb_typeof(value) = 'object'
  ) prof
) rendered
where not exists (select 1 from company_summaries where workspace_id = 'ws_owner');

-- Billing moves from owner id to workspace: one billing account per workspace (owner_id stays as the legacy key;
-- new accounts use the workspace id). A workspace that had several accounts (the owner: 'owner' for MCP_TOKEN and
-- API keys, plus the owner's Clerk user id) is merged into one: the account with a subscription, else a Stripe
-- customer, else 'owner', else the oldest is kept; the others are deleted. Their ledger rows all stay (already
-- moved to the workspace above, each with its original source). The free sample is granted once per workspace,
-- so duplicate signup grants beyond the first are removed. Everything removed is recorded in a 'billing_merged'
-- event. Idempotent: a merged workspace has one account and one signup grant.
create or replace function crusonia_merge_billing(p_workspace text) returns jsonb language plpgsql as $$
declare
  keeper billing_accounts%rowtype;
  r billing_accounts%rowtype;
  merged jsonb := '[]'::jsonb;
  removed jsonb := '[]'::jsonb;
  prev text := current_setting('crusonia.allow_ledger_delete', true);
begin
  select * into keeper from billing_accounts where workspace_id = p_workspace
  order by (stripe_subscription_id is not null) desc, (stripe_customer_id is not null) desc, (owner_id = 'owner') desc,
           created_at, owner_id
  limit 1;
  if found then
    for r in select * from billing_accounts where workspace_id = p_workspace and owner_id <> keeper.owner_id loop
      merged := merged || jsonb_build_array(jsonb_build_object(
        'owner_id', r.owner_id, 'stripe_customer_id', r.stripe_customer_id, 'stripe_subscription_id', r.stripe_subscription_id,
        'plan', r.plan, 'subscription_status', r.subscription_status));
      delete from billing_accounts where owner_id = r.owner_id;
    end loop;
  end if;

  perform set_config('crusonia.allow_ledger_delete', 'on', true);
  with g as (
    select id, row_number() over (order by id) as rn from credit_ledger
    where workspace_id = p_workspace and reason = 'grant' and source like 'signup:%'
  ), d as (
    delete from credit_ledger l using g where l.id = g.id and g.rn > 1
    returning l.id, l.owner_id, l.amount, l.source, l.data, l.created_at
  )
  select coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb) into removed from d;
  perform set_config('crusonia.allow_ledger_delete', coalesce(prev, ''), true);

  if jsonb_array_length(merged) > 0 or jsonb_array_length(removed) > 0 then
    insert into events (workspace_id, lead_id, kind, data)
    values (p_workspace, null, 'billing_merged', jsonb_build_object(
      'kept_account', keeper.owner_id, 'stripe_customer_id', keeper.stripe_customer_id,
      'merged_accounts', merged, 'removed_duplicate_grants', removed));
  end if;
  return jsonb_build_object('kept_account', keeper.owner_id, 'merged_accounts', merged, 'removed_duplicate_grants', removed);
end
$$;
select crusonia_merge_billing(w.workspace_id)
from (select workspace_id from billing_accounts group by workspace_id having count(*) > 1
      union
      select workspace_id from credit_ledger where reason = 'grant' and source like 'signup:%'
      group by workspace_id having count(*) > 1) w;
create unique index if not exists billing_accounts_ws_uq on billing_accounts (workspace_id);

-- ---------------------------------------------------------------------------
-- Demo backend: import cohorts, versioned workflow definitions, workflow runs, follow-ups. Additive and idempotent.
-- Per workspace like everything above (the run tables reach their workspace through workflow_runs).
-- ---------------------------------------------------------------------------

-- `cohort`: the batch a lead first came in with. A CSV import (POST /api/import/commit) records its `source` label;
-- the run history groups by it. Set once, never changed. `import_meta`: where an imported contact came from
-- ({file, row, batch, source}: file name, 1-based row as a spreadsheet shows it, import batch id, the row's own
-- source column). The consent text and timestamp per contact stay in consent_text / consent_at.
alter table leads add column if not exists cohort text;
alter table leads add column if not exists import_meta jsonb;
-- leads_ws_cohort_idx (above) covers lookups by cohort.
drop index if exists leads_cohort_idx;

-- Qualification workflow definitions (src/services/workflow-defs.ts). A definition is a name, a trigger and a spend
-- cap; its content lives in immutable versions: the ICP (the Company summary by default), research questions,
-- evidence requirements, completion criteria ("done when"), the steps the builder shows, and the A/B variant arms
-- (each an optional angle the drafting agent receives). Editing = a new version; runs pin the version they used.
create table if not exists workflow_defs (
  id             text primary key,
  workspace_id   text not null references workspaces(id),
  name           text not null,
  source         text not null default 'user' check (source in ('user', 'claude_code', 'template')),
  enabled        boolean not null default true,
  trigger        jsonb not null default '{"kind": "manual", "label": "Run manually"}',
  spend_cap_usd  numeric,
  spend_period   text not null default 'week' check (spend_period in ('week', 'run')),
  latest_version int not null default 1,
  -- The workspace's default definition: what research follows for leads never run under a workflow, and what
  -- GET/PUT /api/workflows/qualification read and write.
  is_default     boolean not null default false,
  created_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists workflow_defs_ws_idx on workflow_defs (workspace_id, updated_at desc);
create unique index if not exists workflow_defs_default_uq on workflow_defs (workspace_id) where is_default;

create table if not exists workflow_def_versions (
  workflow_id        text not null references workflow_defs(id) on delete cascade,
  version            int not null,
  label              text,
  steps              jsonb not null default '[]',
  icp                jsonb not null default '{"source": "company_summary"}',
  research_questions jsonb not null default '[]',
  evidence_required  jsonb not null default '[]',
  done_when          text,
  variants           jsonb not null default '[]',
  created_by         text,
  created_at         timestamptz not null default now(),
  primary key (workflow_id, version)
);
create or replace function workflow_def_versions_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'workflow versions are immutable: create a new version instead';
end
$$;
drop trigger if exists workflow_def_versions_no_update on workflow_def_versions;
create trigger workflow_def_versions_no_update before update on workflow_def_versions
  for each row execute function workflow_def_versions_immutable();

-- A workspace's single qualification workflow (settings 'qualification_workflow:<workspace id>', from before
-- definitions) becomes its default definition, version 1, keeping the requirement ids. Runs once per workspace.
insert into workflow_defs (id, workspace_id, name, is_default, created_by)
select 'wf_q_' || substr(md5(s.key), 1, 16), w.id, coalesce(s.value->>'name', 'Qualification'), true, 'migration'
from settings s join workspaces w on s.key = 'qualification_workflow:' || w.id
where not exists (select 1 from workflow_defs d where d.workspace_id = w.id and d.is_default)
on conflict (id) do nothing;
insert into workflow_def_versions (workflow_id, version, label, research_questions, evidence_required, done_when, created_by)
select d.id, 1, 'Qualification workflow v' || coalesce(s.value->>'version', '1'),
       coalesce(s.value->'research_questions', '[]'), coalesce(s.value->'evidence_requirements', '[]'),
       nullif(array_to_string(array(select jsonb_array_elements_text(coalesce(s.value->'completion_criteria', '[]'))), E'\n'), ''),
       'migration'
from settings s join workflow_defs d on d.id = 'wf_q_' || substr(md5(s.key), 1, 16)
where s.key like 'qualification_workflow:%'
on conflict do nothing;

-- One run of a workflow version on a cohort or a set of leads. Each lead in it keeps the variant it had when the
-- run started and the research session started for it.
create table if not exists workflow_runs (
  id           text primary key,
  workspace_id text not null references workspaces(id),
  workflow_id  text not null references workflow_defs(id) on delete cascade,
  version      int not null,
  cohort       text,
  test         boolean not null default false,
  actor        text,
  started_at   timestamptz not null default now(),
  foreign key (workflow_id, version) references workflow_def_versions (workflow_id, version)
);
create index if not exists workflow_runs_wf_idx on workflow_runs (workflow_id, started_at desc);

create table if not exists workflow_run_leads (
  run_id     text not null references workflow_runs(id) on delete cascade,
  lead_id    text not null references leads(id) on delete cascade,
  variant    text not null,
  cohort     text,
  session_id text,
  -- started | skipped | failed
  status     text not null default 'started',
  reason     text,
  created_at timestamptz not null default now(),
  primary key (run_id, lead_id)
);
create index if not exists workflow_run_leads_lead_idx on workflow_run_leads (lead_id, created_at desc);

-- The workflow version a lead was last run under: its research brief and the missing-evidence gate follow it. Drafts
-- and research sessions record the run, version, cohort (and drafts their variant) current when they were created.
alter table leads add column if not exists workflow_id text;
alter table leads add column if not exists workflow_version int;
alter table leads add column if not exists workflow_run_id text;
alter table drafts add column if not exists workflow_run_id text;
alter table drafts add column if not exists workflow_id text;
alter table drafts add column if not exists workflow_def_version int;
alter table drafts add column if not exists cohort text;
alter table naive_sessions add column if not exists workflow_run_id text;
alter table naive_sessions add column if not exists workflow_id text;
alter table naive_sessions add column if not exists workflow_def_version int;
alter table naive_sessions add column if not exists cohort text;
create index if not exists drafts_workflow_run_idx on drafts (workflow_run_id) where workflow_run_id is not null;
create index if not exists naive_sessions_workflow_run_idx on naive_sessions (workflow_run_id) where workflow_run_id is not null;

create or replace function record_workflow_run() returns trigger language plpgsql as $$
begin
  if new.lead_id is not null and new.workflow_run_id is null then
    select l.workflow_run_id, l.workflow_id, l.workflow_version, l.cohort
      into new.workflow_run_id, new.workflow_id, new.workflow_def_version, new.cohort
    from leads l where l.id = new.lead_id;
  end if;
  return new;
end
$$;
drop trigger if exists drafts_record_workflow_run on drafts;
create trigger drafts_record_workflow_run before insert on drafts for each row execute function record_workflow_run();
drop trigger if exists naive_sessions_record_workflow_run on naive_sessions;
create trigger naive_sessions_record_workflow_run before insert on naive_sessions
  for each row execute function record_workflow_run();

-- Follow-ups (src/services/followups.ts): an email draft that follows up on a sent one, sent at `scheduled_for`. Each
-- needs its own send approval. Approving one that isn't due yet moves it to status 'scheduled'; the minute cron sends
-- it when due unless the lead replied, unsubscribed, the address was suppressed or Crusonia is paused. A real inbound
-- reply cancels every pending or scheduled follow-up of the lead (src/services/inbound.ts).
alter table drafts add column if not exists followup_of text references drafts(id) on delete cascade;
alter table drafts add column if not exists scheduled_for timestamptz;
create index if not exists drafts_scheduled_idx on drafts (scheduled_for) where status = 'scheduled';

-- Organizations: teammates join a workspace through an emailed invite (src/services/invites.ts). Additive and idempotent.
-- created_by: who made the workspace (the cap per user and the one free sample per user count it).
-- no_free_sample: a workspace its creator made after their first; ensureAccount grants it nothing.
alter table workspaces add column if not exists created_by text;
alter table workspaces add column if not exists no_free_sample boolean not null default false;
create index if not exists workspaces_created_by_idx on workspaces (created_by) where created_by is not null;
update workspaces w set created_by = (
  select m.clerk_user_id from workspace_members m where m.workspace_id = w.id and m.role = 'owner' order by m.created_at limit 1
) where w.created_by is null;

-- Only the SHA-256 of a token is stored; the token itself exists only in the email. An invite is single-use, expires,
-- and can only be accepted by a Clerk user with this verified email. One open invite per address per workspace.
create table if not exists workspace_invites (
  id           text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  email        text not null,
  role         text not null check (role in ('admin', 'member')),
  token_hash   text not null unique,
  invited_by   text not null,
  inviter_name text,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now(),
  last_sent_at timestamptz not null default now(),
  accepted_at  timestamptz,
  accepted_by  text,
  revoked_at   timestamptz
);
create unique index if not exists workspace_invites_open_uq on workspace_invites (workspace_id, email) where accepted_at is null and revoked_at is null;
create index if not exists workspace_invites_ws_idx on workspace_invites (workspace_id, created_at desc);

-- One row per invite email sent, for the daily limits (per workspace, per sender, per address, per instance).
create table if not exists invite_sends (
  id           bigserial primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  actor        text not null,
  email        text not null,
  created_at   timestamptz not null default now()
);
create index if not exists invite_sends_ws_idx on invite_sends (workspace_id, created_at);
create index if not exists invite_sends_actor_idx on invite_sends (actor, created_at);
create index if not exists invite_sends_email_idx on invite_sends (email, created_at);
create index if not exists invite_sends_created_idx on invite_sends (created_at);

-- ---------------------------------------------------------------------------
-- Autopilot (src/services/autopilot.ts): workflows start by themselves. Additive and idempotent.
-- ---------------------------------------------------------------------------

-- `autopilot`: the workspace's on/off switch; off means nothing starts by itself. `autopilot_provisioned_at`: when it got
-- its default workflow. A workspace that had a Company summary before this feature counts as provisioned and stays off
-- until the owner turns it on, so a deploy never starts spending on its own. Only the first migration does that.
alter table workspaces add column if not exists autopilot boolean not null default false;
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = current_schema()
                 and table_name = 'workspaces' and column_name = 'autopilot_provisioned_at') then
    alter table workspaces add column autopilot_provisioned_at timestamptz;
    update workspaces w set autopilot_provisioned_at = now()
    where exists (select 1 from company_summaries v where v.workspace_id = w.id);
  end if;
end
$$;
-- The next time the Operator runs by the clock. It also runs when something changes.
alter table workspaces add column if not exists autopilot_operator_next_at timestamptz;
-- The workspace's copy of the Operator agent (src/services/naive-agents.ts): agent, credential and key ids, versions.
alter table workspaces add column if not exists naive_operator jsonb;

-- `next_run_at`: when a schedule fires next (null: as soon as it can). `is_autopilot`: the workspace's default "Find and
-- qualify" workflow. `last_skip`: why the last due run didn't start, so a skip is logged once rather than every minute.
alter table workflow_defs add column if not exists next_run_at timestamptz;
alter table workflow_defs add column if not exists is_autopilot boolean not null default false;
alter table workflow_defs add column if not exists last_skip text;
create unique index if not exists workflow_defs_autopilot_uq on workflow_defs (workspace_id) where is_autopilot;
create index if not exists workflow_defs_due_idx on workflow_defs (next_run_at) where enabled and trigger->>'kind' = 'schedule';

-- A run with a find step goes finding -> researching -> done; every other run is researching from the start. `trigger`:
-- what started it (schedule, csv_import, reply, operator, or a person: manual).
alter table workflow_runs add column if not exists phase text not null default 'done';
alter table workflow_runs add column if not exists find_session_id text;
alter table workflow_runs add column if not exists trigger text not null default 'manual';
alter table workflow_runs add column if not exists finished_at timestamptz;
create index if not exists workflow_runs_active_idx on workflow_runs (workspace_id) where phase <> 'done';
-- One active run per workflow, whichever way it started.
create unique index if not exists workflow_runs_one_active_uq on workflow_runs (workflow_id) where phase <> 'done';
