// Dashboard · Integrations (Paper artboard "Dashboard · Integrations"): one card per provider, derived from
// /api/status. "Connected" means the Worker has the provider's secret; a missing secret is named with how to add
// it (there is no API to store keys, so there is no token input). "Manage" opens the provider's own console.
import type { ReactNode } from "react";
import { Link } from "react-router";
import { isApiError, type CrmSyncTarget, type ProviderStatus, type Status } from "../api.ts";
import { clerkEnabled } from "../auth.tsx";
import { Page } from "../components/AppShell.tsx";
import { BrandTile, type BrandName } from "../components/BrandLogo.tsx";
import { Card, CopyButton, QueryError, Skeleton } from "../components/ui.tsx";
import { cx, num, timeAgo } from "../lib/format.ts";
import { useStatus } from "../queries.ts";
import { CodeWell, CrumbBar } from "./connect/CrumbBar.tsx";

type State = "connected" | "needs_key" | "soon" | "unknown" | "local";

/** Where each secret comes from (from .dev.vars.example), shown next to a missing key. */
const SECRET_HINT: Record<string, string> = {
  AGENTMAIL_API_KEY: "console.agentmail.to › API Keys",
  AGENTMAIL_INBOX_ID: "Written by `bun run setup --write` once the API key is set",
  HUBSPOT_ACCESS_TOKEN: "HubSpot › Settings › Integrations › Private Apps › Access token",
  NOTION_API_TOKEN: "Create one at notion.so/profile/integrations, then share the Leads database with it",
  NOTION_LEADS_DATABASE_ID: "Written by bun run setup --crm --write (creates the Crusonia leads database)",
  APIFY_TOKEN: "console.apify.com › Settings › API & Integrations › Personal API tokens",
  NAIVE_API_KEY: "Naive dashboard › Settings › API keys",
  NAIVE_AGENT_ID: "Create the agent in the Naive dashboard and use its id (agt_…)",
};

/** The secrets each provider reads (src/services/status.ts), used when the API does not list them. */
const SECRETS: Record<string, string[]> = {
  agentmail: ["AGENTMAIL_API_KEY", "AGENTMAIL_INBOX_ID"],
  hubspot: ["HUBSPOT_ACCESS_TOKEN"],
  notion: ["NOTION_API_TOKEN", "NOTION_LEADS_DATABASE_ID"],
  apify: ["APIFY_TOKEN"],
  naive: ["NAIVE_API_KEY"],
};

/** iMessage approvals run only for the owner workspace with the bridge on; everyone else sees "Coming soon". */
const imessageOn = (s: Status | undefined) => Boolean(s?.imessage?.active);

const providerState = (p: ProviderStatus | undefined, known: boolean): State => (!known || !p ? "unknown" : p.configured ? "connected" : "needs_key");

/** Naive also needs the agent id that runs research sessions (NAIVE_AGENT_ID), reported separately. */
function naiveInfo(s: Status | undefined, known: boolean): { state: State; missing: string[] } {
  const p = s?.providers.naive;
  const state = providerState(p, known);
  if (state === "needs_key") return { state, missing: secretsFor("naive", p) };
  if (state === "connected" && s?.naive_agent_configured === false) return { state: "needs_key", missing: ["NAIVE_AGENT_ID"] };
  return { state, missing: [] };
}

export default function Integrations() {
  const status = useStatus();
  const s = status.data;
  const known = Boolean(s);
  const loading = status.isPending;
  const missing = isApiError(status.error) && status.error.missingRoute;

  const states: State[] = s
    ? [
        providerState(s.providers.agentmail, true),
        providerState(s.providers.hubspot, true),
        providerState(s.providers.notion, true),
        providerState(s.providers.apify, true),
        naiveInfo(s, true).state,
        clerkEnabled ? "connected" : "local",
      ]
    : [];
  const connected = states.filter((x) => x === "connected").length + (imessageOn(s) ? 1 : 0);
  const needs = states.filter((x) => x === "needs_key").length;

  return (
    <>
      <CrumbBar here="Integrations" />
      <Page>
        <div className="flex w-240 max-w-full flex-col gap-4 px-4 pb-14 pt-6 sm:px-12 sm:pt-8">
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-2">
            <div className="flex min-w-0 max-w-full flex-col gap-2">
              <h1 className="text-xl/5.75 font-medium tracking-[-0.01em] text-ink">Integrations</h1>
              <p className="w-140 max-w-full text-[13px]/4.5 font-medium text-muted">
                The tools your Crusonia agent works through. Keys are stored encrypted and only used for the job listed on each card.
              </p>
            </div>
            {s ? (
              <div className="shrink-0 text-[13px]/4 font-medium text-muted">
                {connected} connected · {needs} {needs === 1 ? "needs" : "need"} a key{imessageOn(s) ? "" : " · 1 coming soon"}
              </div>
            ) : loading ? (
              <Skeleton className="h-4 w-60" />
            ) : null}
          </div>

          {status.isError ? (
            <QueryError
              error={status.error}
              what="Integration status"
              onRetry={() => void status.refetch()}
            />
          ) : null}
          {missing ? (
            <p className="-mt-1 text-xs/4 font-medium text-faint">
              Until then the cards below describe each integration without its live status.
            </p>
          ) : null}

          {loading ? (
            [0, 1, 2, 3].map((i) => <CardSkeleton key={i} />)
          ) : (
            <>
              <AgentMailCard status={s} known={known} />
              <HubSpotCard status={s} known={known} />
              <NotionCard status={s} known={known} />
              <ApifyCard status={s} known={known} />
              <PlatformCard status={s} known={known} />
            </>
          )}

          <p className="pt-1 text-xs/4 font-medium text-faint">
            Missing a tool? Your own coding agent can call Crusonia alongside any other MCP server.{" "}
            <Link to="?connect=1" className="text-ink underline decoration-[#200D0D4D] decoration-1 underline-offset-[3px] hover:decoration-ink">
              Connect your agent
            </Link>
          </p>
        </div>
      </Page>
    </>
  );
}

// ---------- building blocks ----------

function StatusPill({ state }: { state: State }) {
  const base = "inline-flex h-5.5 shrink-0 items-center whitespace-nowrap rounded-full px-2.5 text-xs/4 font-medium";
  if (state === "connected") return <span className={cx(base, "bg-lime text-ink")}>Connected</span>;
  if (state === "needs_key")
    return (
      <span className={cx(base, "gap-1.5 border border-[#200D0D33] bg-white text-ink")}>
        <span className="size-1.5 shrink-0 rounded-full bg-ink" />
        Needs key
      </span>
    );
  if (state === "soon") return <span className={cx(base, "bg-pill text-muted")}>Coming soon</span>;
  if (state === "local") return <span className={cx(base, "bg-pill text-muted")}>Local dev</span>;
  return <span className={cx(base, "bg-pill text-muted")}>Status unknown</span>;
}


/** External link to the provider's own console (there is no management API in Crusonia). */
function Manage({ href, what }: { href: string; what: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={`Opens ${what} in a new tab`}
      className="flex h-8 shrink-0 items-center rounded-lg border border-[#200D0D26] bg-white px-4 text-[13px]/4 font-medium text-ink hover:bg-[#200D0D08]"
    >
      Manage<span className="sr-only"> (opens {what} in a new tab)</span>
    </a>
  );
}

function ProviderCard({
  tile,
  name,
  state,
  manage,
  description,
  children,
}: {
  tile: BrandName;
  name: string;
  state: State;
  manage?: { href: string; what: string };
  description: string;
  children?: ReactNode;
}) {
  return (
    <Card className="flex flex-col gap-3 p-4 sm:p-6">
      <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-2.5 sm:h-8 sm:flex-nowrap">
        <BrandTile name={tile} />
        <h2 className="text-[15px]/4.5 font-medium text-ink">{name}</h2>
        <StatusPill state={state} />
        <span className="grow" />
        {state === "connected" && manage ? <Manage {...manage} /> : null}
      </div>
      <p className="text-[13px]/4.5 font-medium text-muted">{description}</p>
      {children}
    </Card>
  );
}

const fieldLabel = "text-[13px]/4 text-muted";

/** Names the missing secret(s) and how to add them to the Worker. Replaces the design's token input on purpose:
 *  the API has no endpoint to store keys, so an input would only pretend to save. */
function MissingSecrets({ secrets }: { secrets: string[] }) {
  const commands = secrets.filter((k) => k !== "AGENTMAIL_INBOX_ID").map((k) => `wrangler secret put ${k}`);
  return (
    <>
      <div className="flex flex-col gap-1.5 pt-1">
        <div className={fieldLabel}>{secrets.length === 1 ? "Missing secret" : "Missing secrets"}</div>
        {secrets.map((k) => (
          <div key={k} className="flex flex-col items-start gap-1.5 sm:flex-row sm:items-center sm:gap-3">
            <div className="flex h-9.25 w-full min-w-0 shrink-0 items-center gap-2 rounded-lg border border-[#200D0D1A] px-3.5 sm:w-90">
              <span className="grow truncate text-[13px]/4.5 font-medium text-ink">{k}</span>
              <span className="shrink-0 text-xs/4 font-medium text-faint">not set</span>
            </div>
            {SECRET_HINT[k] ? <div className="text-[11px]/3.5 font-medium text-faint">{renderTicks(SECRET_HINT[k])}</div> : null}
          </div>
        ))}
      </div>
      {commands.length ? (
        <div className="flex flex-col gap-1.5 pt-1">
          <div className={fieldLabel}>Add {commands.length === 1 ? "it" : "them"} to the Worker</div>
          <CodeWell display={commands.join("\n")} className="w-fit max-w-full py-2.5 sm:min-w-90" />
          <div className="text-xs/4 font-medium text-faint">
            Or put {commands.length === 1 ? "it" : "them"} in <code className="font-medium text-ink">.dev.vars</code> and run{" "}
            <code className="font-medium text-ink">bun run secrets</code> (see the README). This card turns Connected on the next status check.
          </div>
        </div>
      ) : null}
    </>
  );
}

/** `code` spans in hint strings. */
function renderTicks(text: string) {
  return text.split(/(`[^`]+`)/).map((part, i) =>
    part.startsWith("`") ? (
      <code key={i} className="text-ink">
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}

function Fact({ title, value, first }: { title: string; value: ReactNode; first?: boolean }) {
  // Phones share the row equally; from `sm` the facts keep the design's fixed widths.
  return (
    <div
      className={cx(
        "flex min-w-0 grow basis-0 flex-col gap-1 sm:shrink-0 sm:grow-0 sm:basis-auto",
        first ? "sm:w-42.5" : "border-l border-l-[#200D0D1A] pl-3 sm:w-32.5 sm:pl-4.75",
      )}
    >
      <div className="text-[13px]/4 font-medium text-faint">{title}</div>
      <div className="text-[15px]/4.5 font-semibold text-ink">{value}</div>
    </div>
  );
}

/** Read-only CRM sync state from /api/status `crm_sync`: is it writing, when it last synced, what is queued. */
function SyncFacts({ sync, switchName }: { sync: CrmSyncTarget | undefined; switchName: string }) {
  if (!sync) return null;
  const state = sync.active ? "On" : sync.configured ? "Off" : "Needs key";
  const queue =
    sync.queue_depth === null ? "—" : sync.failed ? `${num(sync.queue_depth)} · ${num(sync.failed)} failed` : sync.queue_depth ? `${num(sync.queue_depth)} pending` : "Empty";
  return (
    <div className="flex flex-col gap-2.5 border-t border-t-[#200D0D1A] pt-3.5">
      <div className="flex">
        <Fact first title="Sync" value={state} />
        <Fact title="Last sync" value={sync.last_sync_at ? timeAgo(sync.last_sync_at) : "Never"} />
        <Fact title="Queue" value={queue} />
      </div>
      {sync.configured && !sync.enabled ? (
        <div className="text-[13px]/4.5 font-medium text-muted">
          Nothing is written until <span className="text-ink">{switchName}=true</span> is set on the Worker.
        </div>
      ) : null}
      {sync.last_error ? (
        <div className="text-[13px]/4.5 font-medium text-[#B42318]">
          Last error: <span className="break-all">{sync.last_error}</span>
        </div>
      ) : null}
    </div>
  );
}

// ---------- cards ----------

type CardProps = { status: Status | undefined; known: boolean };

function secretsFor(key: string, p: ProviderStatus | undefined) {
  return p?.missing?.length ? p.missing : (SECRETS[key] ?? []);
}

function AgentMailCard({ status, known }: CardProps) {
  const p = status?.providers.agentmail;
  const state = providerState(p, known);
  const inbox = status?.inbox_address;
  return (
    <ProviderCard
      tile="agentmail"
      name="AgentMail"
      state={state}
      manage={{ href: "https://console.agentmail.to", what: "the AgentMail console" }}
      description="Email inbox for outreach and replies. Crusonia only sends to contacts who opted in or that you approved."
    >
      {state === "connected" ? (
        <div className="flex flex-col gap-4 pt-1 sm:flex-row">
          <div className="flex w-full min-w-0 flex-col gap-1.5 sm:w-90">
            <div className={fieldLabel}>Inbox</div>
            <div className="flex h-9.25 shrink-0 items-center gap-2 rounded-lg border border-[#200D0D1A] pl-3.5 pr-1.5">
              {inbox ? (
                <>
                  <span className="grow truncate text-[13px]/4.5 font-medium text-ink">{inbox}</span>
                  <CopyButton text={inbox} label="Copy inbox address" iconOnly />
                </>
              ) : (
                <span className="grow text-[13px]/4.5 font-medium text-faint">Address not reported yet</span>
              )}
            </div>
          </div>
          <div className="flex w-full min-w-0 flex-col gap-1.5 sm:w-90">
            <div className={fieldLabel}>Sending</div>
            <div className="flex h-9.25 shrink-0 items-center gap-2 rounded-lg border border-[#200D0D1A] px-3.5">
              <span className="grow truncate text-sm/4.5 font-medium text-ink">Opted-in contacts only</span>
            </div>
          </div>
        </div>
      ) : state === "needs_key" ? (
        <MissingSecrets secrets={secretsFor("agentmail", p)} />
      ) : null}
    </ProviderCard>
  );
}

function HubSpotCard({ status, known }: CardProps) {
  const p = status?.providers.hubspot;
  const state = providerState(p, known);
  return (
    <ProviderCard
      tile="hubspot"
      name="HubSpot"
      state={state}
      manage={{ href: "https://app.hubspot.com", what: "HubSpot" }}
      description="Keeps contacts and companies in sync, so approved leads land in your CRM and existing customers are never prospected."
    >
      {state === "connected" ? (
        <>
          <div className="flex border-t border-t-[#200D0D1A] pt-3.5">
            <Fact first title="Objects" value="Contacts, Companies" />
            <Fact title="Direction" value="Two-way" />
          </div>
          <SyncFacts sync={status?.crm_sync?.hubspot} switchName="HUBSPOT_SYNC_ENABLED" />
        </>
      ) : state === "needs_key" ? (
        <MissingSecrets secrets={secretsFor("hubspot", p)} />
      ) : null}
    </ProviderCard>
  );
}

function NotionCard({ status, known }: CardProps) {
  const p = status?.providers.notion;
  const state = providerState(p, known);
  return (
    <ProviderCard
      tile="notion"
      name="Notion"
      state={state}
      manage={{ href: "https://www.notion.so/profile/integrations", what: "your Notion integrations" }}
      description="Writes every lead, its evidence and score into a Notion database your team already reads."
    >
      {state === "connected" ? (
        <SyncFacts sync={status?.crm_sync?.notion} switchName="NOTION_SYNC_ENABLED" />
      ) : state === "needs_key" ? (
        <MissingSecrets secrets={secretsFor("notion", p)} />
      ) : null}
    </ProviderCard>
  );
}

const ACTORS = ["website-content-crawler", "google-search-scraper"];

function ApifyCard({ status, known }: CardProps) {
  const p = status?.providers.apify;
  const state = providerState(p, known);
  return (
    <ProviderCard
      tile="apify"
      name="Apify"
      state={state}
      manage={{ href: "https://console.apify.com", what: "the Apify console" }}
      description="Web and lead data. The agent reads your site and prospects' sites, searches Google for signals and pulls contacts."
    >
      {state === "needs_key" ? (
        <MissingSecrets secrets={secretsFor("apify", p)} />
      ) : (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <div className={cx(fieldLabel, "pr-1")}>Actors</div>
          {ACTORS.map((a) => (
            <span key={a} className="flex h-6.5 items-center rounded-full bg-pill px-2.5 text-xs/4 font-medium text-ink">
              {a}
            </span>
          ))}
          <span className="grow" />
          <span className="text-xs/4 font-medium text-muted">
            Used by <code>read_website</code> and <code>search_web</code>
          </span>
        </div>
      )}
    </ProviderCard>
  );
}

function PlatformRow({
  tile,
  name,
  description,
  state,
  action,
  extra,
  last,
}: {
  tile: BrandName;
  name: string;
  description: string;
  state: State;
  action?: ReactNode;
  extra?: ReactNode;
  last?: boolean;
}) {
  return (
    // Phones: tile, name, status and action on one line, the description under them.
    <div className={cx("flex min-h-15 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-2 py-3 sm:flex-nowrap", !last && "border-b border-b-[#200D0D1A]")}>
      <BrandTile name={tile} />
      <div className="min-w-0 grow text-sm/4.5 font-medium text-ink sm:w-33 sm:shrink-0 sm:grow-0">{name}</div>
      <div className="order-1 flex min-w-0 grow basis-full flex-col gap-1.5 pl-9.5 sm:order-none sm:basis-0 sm:pl-0">
        <div className="text-[13px]/4 font-medium text-muted">{description}</div>
        {extra}
      </div>
      <div className="flex shrink-0 sm:w-29">
        <StatusPill state={state} />
      </div>
      <div className="flex shrink-0 justify-end sm:w-23">{action}</div>
    </div>
  );
}

function PlatformCard({ status, known }: CardProps) {
  const { state: naiveState, missing: naiveMissing } = naiveInfo(status, known);
  return (
    <Card className="flex flex-col px-4 pb-2 pt-4 sm:px-6 sm:pt-6">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 pb-2">
        <h2 className="text-[15px]/4.5 font-medium text-ink">Platform</h2>
        <div className="text-[13px]/4 font-medium text-faint">Runs the agent, signs you in, and {imessageOn(status) ? "" : "(soon) "}asks for approvals by text</div>
      </div>
      <PlatformRow
        tile="naive"
        name="Naive"
        state={naiveState}
        description="Agent runtime. Runs research, scoring and drafting jobs."
        extra={
          naiveState === "needs_key" && naiveMissing.length ? (
            <div className="flex flex-col gap-1 text-xs/4 font-medium text-faint">
              {naiveMissing.map((k) => (
                <div key={k} className="flex items-center gap-2">
                  <span>
                    Missing <code className="font-medium text-ink">{k}</code>: <code className="font-medium text-ink">wrangler secret put {k}</code>
                  </span>
                  <CopyButton text={`wrangler secret put ${k}`} label={`Copy the command for ${k}`} iconOnly className="size-5" />
                </div>
              ))}
              {SECRET_HINT[naiveMissing[0]!] ? <span className="text-[11px]/3.5">{SECRET_HINT[naiveMissing[0]!]}</span> : null}
            </div>
          ) : undefined
        }
      />
      <PlatformRow
        tile="clerk"
        name="Clerk"
        state={clerkEnabled ? "connected" : "local"}
        description={clerkEnabled ? "Sign-in for your team and the dashboard." : "Sign-in for your team. This local build skips sign-in."}
        action={clerkEnabled ? <Manage href="https://dashboard.clerk.com" what="the Clerk dashboard" /> : undefined}
      />
      <PlatformRow
        last
        tile="photon"
        name="Photon iMessage"
        state={imessageOn(status) ? "connected" : "soon"}
        description={
          imessageOn(status) && status?.imessage?.owner_phone_hint
            ? `Approve or edit drafts by replying to a text. Linked to ${status.imessage.owner_phone_hint}.`
            : "Approve or edit drafts by replying to a text."
        }
      />
    </Card>
  );
}

function CardSkeleton() {
  return (
    <Card className="flex flex-col gap-3 p-4 sm:p-6">
      <div className="flex h-8 items-center gap-2.5">
        <Skeleton className="size-7 rounded-[7px]" />
        <Skeleton className="h-4.5 w-24" />
        <Skeleton className="h-5.5 w-20 rounded-full" />
      </div>
      <Skeleton className="h-4.5 w-3/4" />
      <Skeleton className="h-9.25 w-90 max-w-full" />
    </Card>
  );
}
