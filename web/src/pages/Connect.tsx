// Dashboard · Connect your agent (Paper artboard "Dashboard · Connect your agent"): MCP endpoint, per-agent setup,
// API keys for MCP clients and the tool list. A key created here is shown once and filled into step 01; it lives
// only in this page's memory.
import { useState } from "react";
import { Page } from "../components/AppShell.tsx";
import { Card } from "../components/ui.tsx";
import { isApiError } from "../api.ts";
import { useApiKeys, useStatus } from "../queries.ts";
import { ApiKeysCard, type CreatedKey } from "./connect/ApiKeys.tsx";
import { CopyChip, CrumbBar } from "./connect/CrumbBar.tsx";
import { MCP_URL, SetupCard, TOOL_COUNT } from "./connect/Setup.tsx";

// The tools /mcp registers (src/mcp/server.ts), with one-line descriptions.
const TOOLS: { name: string; description: string }[] = [
  { name: "get_status", description: "Providers, sends on or off, queue counts" },
  { name: "read_website", description: "Crawl a domain and return clean page text" },
  { name: "search_web", description: "Google search for buying signals and news" },
  { name: "save_profile", description: "Save your ideal customer, segments and signals" },
  { name: "get_profile", description: "Read the saved profile before prospecting" },
  { name: "add_leads", description: "Add companies or people to the lead list" },
  { name: "list_leads", description: "List leads, newest first, filtered by stage" },
  { name: "get_lead", description: "One lead with its evidence, score and drafts" },
  { name: "save_evidence", description: "Attach a fact and its source URL to a lead" },
  { name: "score_lead", description: "Score a lead against your profile, with reasons" },
  { name: "create_draft", description: "Write an email that waits for your approval" },
  { name: "list_pending_approvals", description: "Drafts waiting for your yes, edit or skip" },
];

export default function Connect() {
  const [created, setCreated] = useState<CreatedKey | null>(null);
  // Keep the secret for step 01 even after the "copy it now" box is dismissed, until the user leaves the page.
  const [token, setToken] = useState<string | null>(null);
  // The Worker reports its own public URL; the constant covers loading and older deployments.
  const status = useStatus();
  const mcpUrl = status.data?.mcp_url || MCP_URL;
  const keyList = useApiKeys();
  const keysShipped = !(isApiError(keyList.error) && keyList.error.missingRoute);
  return (
    <>
      <CrumbBar here="Connect your agent" />
      <Page>
        <div className="flex flex-col gap-6 px-12 pb-14 pt-8">
          <div className="flex items-end justify-between gap-8">
            <div className="flex flex-col gap-2">
              <h1 className="text-xl/5.75 font-medium tracking-[-0.01em] text-ink">Connect your agent</h1>
              <p className="w-130 max-w-full text-[13px]/4.5 font-medium text-muted">
                Run Crusonia from Claude Code, Cursor or Codex. Your agent gets the same tools the dashboard uses, over MCP, with sends still waiting for your
                approval.
              </p>
            </div>
            <div className="flex shrink-0 flex-col gap-1.5">
              <div className="text-xs/4 font-medium text-faint">MCP endpoint</div>
              <div className="flex h-8.5 shrink-0 items-center gap-2.5 rounded-lg bg-[#200D0D0A] pl-3 pr-1.5">
                <code className="text-xs/4 font-medium text-ink">{mcpUrl}</code>
                <CopyChip text={mcpUrl} />
              </div>
            </div>
          </div>

          <div className="flex items-start gap-6">
            <div className="flex min-w-0 grow basis-0 flex-col gap-4">
              <SetupCard token={token} mcpUrl={mcpUrl} keysShipped={keysShipped} />
              <ApiKeysCard
                created={created}
                onCreated={(k) => {
                  setCreated(k);
                  if (k) setToken(k.key);
                }}
              />
            </div>
            <ToolsCard />
          </div>
        </div>
      </Page>
    </>
  );
}

function ToolsCard() {
  return (
    <Card className="flex w-90 shrink-0 flex-col px-6 pb-2.5 pt-6">
      <div className="flex items-center gap-2 pb-1.5">
        <h2 className="text-[15px]/4.5 font-medium text-ink">Available tools</h2>
        <span className="flex h-4.5 items-center rounded-full bg-[#200D0D14] px-1.5 text-xs/3 font-medium text-faint">{TOOL_COUNT}</span>
      </div>
      <p className="pb-2.5 text-[13px]/4.5 font-medium text-muted">What your agent can call. Anything that sends waits in Approvals.</p>
      <ul className="flex flex-col">
        {TOOLS.map((t) => (
          <li key={t.name} className="flex flex-col gap-0.75 border-t border-t-[#200D0D0F] py-2.5">
            <code className="text-[13px]/4.5 font-medium text-ink">{t.name}</code>
            <span className="text-xs/4 font-medium text-muted">{t.description}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
