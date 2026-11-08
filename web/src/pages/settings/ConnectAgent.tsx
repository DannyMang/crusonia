// Settings · Connect your agent at /app/settings/agent (Paper: "Settings · Connect your agent"): the one-click Add to
// Claude Code / Codex buttons (shared with the landing) and the API keys agents use: create (full key shown
// once), revoke, last used. /app/settings/keys, /app/connect and any ?connect=1 link redirect here.
import { useState } from "react";
import { isApiError } from "../../api.ts";
import { AgentButtons } from "../../components/AgentButtons.tsx";
import { Page } from "../../components/AppShell.tsx";
import { MCP_URL } from "../../lib/agent-install.ts";
import { useApiKeys, useRole, useStatus } from "../../queries.ts";
import { CrumbBar } from "../connect/CrumbBar.tsx";
import { ApiKeysCard, limeButton, type CreatedKey } from "./ApiKeys.tsx";
import { SettingsTabs } from "./SettingsTabs.tsx";

export default function SettingsConnectAgent() {
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [creating, setCreating] = useState(false);
  const status = useStatus();
  const list = useApiKeys();
  const missing = isApiError(list.error) && list.error.missingRoute;
  // Members can see the keys (their names label notes) but can't make or revoke them.
  const { role } = useRole();
  const member = role === "member";
  return (
    <>
      <CrumbBar here="Connect your agent" parent={{ label: "Settings", to: "/app/settings" }} />
      <Page>
        <div className="flex w-240 max-w-full flex-col gap-4 px-4 pb-14 pt-6 sm:px-12 sm:pt-8">
          <SettingsTabs />
          <h1 className="pb-1 pt-3 text-xl/5.75 font-medium tracking-[-0.01em] text-ink">Connect your agent</h1>
          {/* The endpoint this Worker reports: staging has its own. */}
          {member ? null : <AgentButtons size="row" mcpUrl={status.data?.mcp_url || MCP_URL} className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap" />}
          <div className="flex items-center justify-between gap-4 pt-4">
            <h2 className="text-[15px]/4.5 font-medium text-ink">API keys</h2>
            {!missing && !member ? (
              <button type="button" className={limeButton} onClick={() => setCreating(true)} disabled={creating || list.isPending}>
                Create key
              </button>
            ) : null}
          </div>
          <ApiKeysCard created={created} onCreated={setCreated} creating={creating} onCreating={setCreating} readOnly={member} />
        </div>
      </Page>
    </>
  );
}
