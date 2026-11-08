// "Connect your agent" > Setup card: the API key line, then one block per client (Claude Code, Cursor, Codex) with
// its exact command or config and a Copy button, and a real server check.
import { useState, type ReactNode } from "react";
import { isApiError } from "../../api.ts";
import { useApi } from "../../auth.tsx";
import { Card, errorCopy } from "../../components/ui.tsx";
import { cx, timeAgo } from "../../lib/format.ts";
import { CodeWell, CopyChip } from "./CrumbBar.tsx";

export const MCP_URL = "https://crusonia.veri-web.workers.dev/mcp";
export const TOOL_COUNT = 12;

// Exact commands and config from the README, for the endpoint the Worker reports. Copy puts the one-line
// command on the clipboard; the panel shows it wrapped with shell line continuations (which also work if
// someone selects and pastes the shown text).
const commands = (url: string) => ({
  claude: `claude mcp add --transport http --scope user crusonia ${url} --header 'Authorization: Bearer \${CRUSONIA_MCP_TOKEN}'`,
  claudeShown: `claude mcp add --transport http --scope user crusonia \\\n  ${url} \\\n  --header 'Authorization: Bearer \${CRUSONIA_MCP_TOKEN}'`,
  cursor: JSON.stringify({ mcpServers: { crusonia: { url, headers: { Authorization: "Bearer ${env:CRUSONIA_MCP_TOKEN}" } } } }, null, 2),
  codex: `codex mcp add crusonia --url ${url} --bearer-token-env-var CRUSONIA_MCP_TOKEN`,
  codexShown: `codex mcp add crusonia --url ${url} \\\n  --bearer-token-env-var CRUSONIA_MCP_TOKEN`,
});

/** Inline command or identifier: Inter (owner rule: no monospace), ink so it stands out from muted copy. */
const C = ({ children }: { children: ReactNode }) => <code className="font-medium text-ink">{children}</code>;

const clients = (url: string): { name: string; where?: string; text: string; shown?: string; note: ReactNode }[] => {
  const c = commands(url);
  return [
  {
    name: "Claude Code",
    text: c.claude,
    shown: c.claudeShown,
    note: (
      <>
        Adds Crusonia for all your projects. Keep the single quotes: Claude Code reads the key when it connects. Check with <C>claude mcp list</C>.
      </>
    ),
  },
  {
    name: "Cursor",
    where: ".cursor/mcp.json",
    text: c.cursor,
    note: <>Save it in your repo, then turn on crusonia under Cursor Settings › MCP. Cursor reads the key from the shell it was started from.</>,
  },
  {
    name: "Codex",
    text: c.codex,
    shown: c.codexShown,
    note: (
      <>
        Codex stores only the variable's name and reads the key when it connects. Run <C>/mcp</C> in Codex to see crusonia and its {TOOL_COUNT} tools.
      </>
    ),
  },
];
};

/** `token`: a key created on this page in this session, filled into the export line. */
export function SetupCard({ token, mcpUrl = MCP_URL, keysShipped = true }: { token: string | null; mcpUrl?: string; keysShipped?: boolean }) {
  const exportLine = `export CRUSONIA_MCP_TOKEN=${token ?? "<your key>"}`;
  return (
    <Card className="flex flex-col gap-5 p-6">
      <div className="flex flex-col gap-2.5">
        <h2 className="text-[15px]/4.5 font-medium text-ink">Setup</h2>
        <p className="text-[13px]/4.5 font-medium text-muted">
          Put your API key in <C>CRUSONIA_MCP_TOKEN</C>
          {token ? " (filled in with the key you just created)" : keysShipped ? " (create one under API keys)" : " (the owner token for now)"}, then add Crusonia to your
          agent. Add the line to{" "}
          <C>~/.zshrc</C> so new shells have it.
        </p>
        <CodeWell display={exportLine} />
      </div>

      {clients(mcpUrl).map((c) => (
        <section key={c.name} aria-label={c.name} className="flex flex-col gap-2.5 border-t border-t-[#200D0D14] pt-5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-6.5 shrink-0 items-center rounded-full bg-lime px-3 text-[13px]/4 font-medium text-ink">{c.name}</span>
            <span className="grow text-xs/4 font-medium text-muted">{c.where ?? ""}</span>
            <CopyChip text={c.text} />
          </div>
          <pre className="whitespace-pre-wrap rounded-[10px] bg-[#200D0D0A] px-4 py-3 text-[13px]/5 text-ink [overflow-wrap:anywhere]">{c.shown ?? c.text}</pre>
          <p className="text-xs/4.25 font-medium text-faint">{c.note}</p>
        </section>
      ))}

      <TestConnection />
    </Card>
  );
}

type Check =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; ms: number; at: number }
  | { kind: "reachable"; ms: number; at: number }
  | { kind: "error"; title: string; body: string };

/** Calls GET /api/status from this browser and reports latency. It checks the server, not the agent's config. */
function TestConnection() {
  const api = useApi();
  const [check, setCheck] = useState<Check>({ kind: "idle" });
  async function run() {
    setCheck({ kind: "running" });
    const t0 = performance.now();
    try {
      await api.status();
      setCheck({ kind: "ok", ms: Math.round(performance.now() - t0), at: Date.now() });
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      // A 404 "No route" comes from the Worker itself after auth, so the server is up; only the endpoint is new.
      if (isApiError(err) && err.missingRoute) setCheck({ kind: "reachable", ms, at: Date.now() });
      else {
        const c = errorCopy(err, "the server");
        setCheck({ kind: "error", title: c.title, body: c.body });
      }
    }
  }
  const failed = check.kind === "error";
  const passed = check.kind === "ok" || check.kind === "reachable";
  const scope = "This checks Crusonia's server from this browser, not your agent's config.";
  const title =
    check.kind === "ok"
      ? `GET /api/status OK · ${check.ms}ms`
      : check.kind === "reachable"
        ? `Server reachable · ${check.ms}ms`
        : check.kind === "error"
          ? "GET /api/status failed"
          : check.kind === "running"
            ? "Checking…"
            : "Not checked yet";
  const body =
    check.kind === "ok"
      ? `${capitalize(timeAgo(check.at))} · ${scope}`
      : check.kind === "reachable"
        ? `${capitalize(timeAgo(check.at))} · The status endpoint ships with the next backend update. ${scope}`
        : check.kind === "error"
          ? `${check.title}: ${check.body}`
          : scope;
  return (
    <div
      className={cx(
        "flex items-center gap-3 rounded-[10px] border py-3.5 pl-4 pr-3.5",
        failed ? "border-[#B4231829] bg-[#FDECEB80]" : passed ? "border-panel-line bg-panel" : "border-[#200D0D14] bg-[#200D0D05]",
      )}
    >
      <span
        aria-hidden
        className={cx(
          "flex size-5 shrink-0 items-center justify-center rounded-full",
          passed ? "bg-green" : failed ? "bg-[#B42318]" : "border-[1.5px] border-[#200D0D33] bg-white",
        )}
      >
        {passed ? (
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M2.5 6.25l2.25 2.25L9.5 3.75" fill="none" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : failed ? (
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M6 3v3.5M6 8.75v.01" fill="none" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        ) : null}
      </span>
      <div role="status" aria-live="polite" className="flex min-w-0 grow basis-0 flex-col gap-0.5">
        <div className="text-[13px]/4.5 font-medium tabular-nums text-ink">{title}</div>
        <div className="text-xs/4 font-medium text-muted">{body}</div>
      </div>
      <button
        type="button"
        onClick={() => void run()}
        disabled={check.kind === "running"}
        className="flex h-8 shrink-0 items-center rounded-lg border border-[#200D0D26] bg-white px-3.5 text-[13px]/4 font-medium text-ink hover:bg-[#200D0D08] disabled:opacity-60"
      >
        Test connection
      </button>
    </div>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
