// One-click agent setup, shared by the landing ("Set-up fast.") and Settings · Connect your agent.
// - Cursor: Cursor's MCP install deeplink (cursor.com/docs: cursor://anysphere.cursor-deeplink/mcp/install
//   ?name=<name>&config=<base64 of the server's JSON config>). Cursor opens and asks to install crusonia.
// - Claude Code and Codex have no install links, so their buttons copy the exact `mcp add` command.
// All three read the API key from CRUSONIA_MCP_TOKEN when they connect (keys: Settings › API keys).

/**
 * This deployment's MCP endpoint, from the origin that served the page: production's on production, staging's on staging.
 * Inside the app the Worker reports the same URL (`/api/status` mcp_url).
 */
export const MCP_URL = `${location.origin}/mcp`;

export const TOKEN_ENV = "CRUSONIA_MCP_TOKEN";

/** The shell line that sets a new key where the commands below read it. */
export const exportLine = (key: string) => `export ${TOKEN_ENV}=${key}`;

export function cursorInstallUrl(url: string = MCP_URL) {
  const config = { url, headers: { Authorization: `Bearer \${env:${TOKEN_ENV}}` } };
  return "cursor://anysphere.cursor-deeplink/mcp/install?name=crusonia&config=" + encodeURIComponent(btoa(JSON.stringify(config)));
}

export const claudeCodeCommand = (url: string = MCP_URL) =>
  `claude mcp add --transport http --scope user crusonia ${url} --header 'Authorization: Bearer \${${TOKEN_ENV}}'`;

export const codexCommand = (url: string = MCP_URL) => `codex mcp add crusonia --url ${url} --bearer-token-env-var ${TOKEN_ENV}`;

/** Clipboard write with the legacy fallback; false when nothing could write (the caller then shows the text). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API missing or blocked: try the legacy path below.
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
