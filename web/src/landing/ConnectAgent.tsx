// S3 "Set-up fast." (Paper: Landing v2 > S3 · Connect agent): one click per agent.
// - Cursor: Cursor's MCP install deeplink (cursor.com/docs: cursor://anysphere.cursor-deeplink/mcp/install
//   ?name=<name>&config=<base64 of the server's JSON config>). Cursor opens and asks to install crusonia.
// - Claude Code and Codex have no install links, so the button copies the exact `mcp add` command.
// All three read the API key from CRUSONIA_MCP_TOKEN when they connect; the full setup (with key creation) is in
// the app under Connect your agent.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "../lib/format.ts";
import { SECTIONS } from "./sections.ts";

export const MCP_URL = "https://crusonia.veri-web.workers.dev/mcp";

const cursorConfig = { url: MCP_URL, headers: { Authorization: "Bearer ${env:CRUSONIA_MCP_TOKEN}" } };
export const CURSOR_INSTALL_URL =
  "cursor://anysphere.cursor-deeplink/mcp/install?name=crusonia&config=" + encodeURIComponent(btoa(JSON.stringify(cursorConfig)));

export const CLAUDE_CODE_COMMAND =
  "claude mcp add --transport http --scope user crusonia " + MCP_URL + " --header 'Authorization: Bearer ${CRUSONIA_MCP_TOKEN}'";
export const CODEX_COMMAND = "codex mcp add crusonia --url " + MCP_URL + " --bearer-token-env-var CRUSONIA_MCP_TOKEN";

// Monochrome ink marks on a 24px grid, as in the design.
const markProps = { width: 24, height: 24, viewBox: "0 0 24 24", "aria-hidden": true, className: "shrink-0" } as const;

const CursorMark = () => (
  <svg {...markProps}>
    <path d="M12 1.6L21 6.8V17.2L12 22.4L3 17.2V6.8Z" fill="#200D0D" />
    <path d="M12 12L21 6.8V17.2L12 22.4Z" fill="#200D0DB8" />
    <path d="M4.6 7.7L19.4 7.7L12 20.4Z" fill="#FFFFFF" />
    <path d="M12 12L19.4 7.7L12 20.4Z" fill="#200D0D2E" />
  </svg>
);

const ClaudeMark = () => (
  <svg {...markProps}>
    <path
      d="M12.17 10.81L13.46 1.60M12.74 11.05L17.05 5.54M13.11 11.55L20.90 8.40M13.19 12.17L19.53 13.06M12.95 12.74L20.04 18.28M12.45 13.11L15.22 19.97M11.83 13.19L10.64 21.70M11.26 12.95L7.20 18.15M10.89 12.45L2.36 15.90M10.81 11.83L3.68 10.83M11.05 11.26L4.59 6.21M11.55 10.89L9.00 4.58"
      fill="none"
      stroke="#200D0D"
      strokeWidth="2.3"
      strokeLinecap="round"
    />
  </svg>
);

const CodexMark = () => (
  <svg {...markProps}>
    <path d="M7 19.4A4.5 4.5 0 0 1 6.4 10.44A6 6 0 0 1 17.6 9A4.6 4.6 0 0 1 17 19.4Z" fill="#200D0D" />
    <path d="M8.3 12.6L10.7 14.6L8.3 16.6" fill="none" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12.6 16.6H15.8" fill="none" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const CheckMark = () => (
  <svg {...markProps}>
    <path d="M5.5 12.5L10 17L18.5 7.5" fill="none" stroke="#200D0D" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const button =
  "flex h-15 shrink-0 items-center justify-center gap-3 rounded-full border border-[#200D0D26] bg-white pr-6.5 pl-5.5 text-base/5 font-semibold text-ink shadow-[0_10px_24px_#200D0D0F] transition-colors hover:border-[#200D0D4D] sm:justify-start";

async function copyText(text: string): Promise<boolean> {
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

function CopyCommandButton({ mark, label, agent, command, onCopied }: { mark: ReactNode; label: string; agent: string; command: string; onCopied: (msg: string) => void }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    if (await copyText(command)) {
      setCopied(true);
      onCopied(`${agent} command copied. Paste it in your terminal.`);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } else {
      // Nothing could write to the clipboard: let the visitor copy it by hand.
      window.prompt(`Run this in your terminal to add Crusonia to ${agent}:`, command);
    }
  }

  return (
    <button type="button" onClick={copy} aria-label={label} title={`Copies: ${command}`} className={button}>
      {copied ? <CheckMark /> : mark}
      {/* Both labels share one grid cell so the button keeps its width when it says "Copied". The button keeps
          its accessible name; the status line below announces the copy. */}
      <span className="grid text-left">
        <span className={cx("col-start-1 row-start-1", copied && "invisible")}>{label}</span>
        <span aria-hidden className={cx("col-start-1 row-start-1", !copied && "invisible")}>
          Copied
        </span>
      </span>
    </button>
  );
}

export function ConnectAgent() {
  const [status, setStatus] = useState("");
  return (
    <section
      id={SECTIONS.connect}
      aria-labelledby="connect-title"
      className="flex flex-col gap-10 border-t border-[#200D0D0F] bg-white px-5 pt-24 pb-28 sm:gap-12 sm:px-10 lg:px-20 lg:pt-30 lg:pb-36"
    >
      <div className="flex flex-col items-start gap-4.5">
        <h2 id="connect-title" className="text-[40px]/[46px] font-semibold tracking-[-1px] sm:text-[60px]/16.5 sm:tracking-[-1.2px]">
          Set-up fast.
        </h2>
        <p className="text-[18px]/[27px] font-[525] text-[#200D0D99] sm:text-[20.2px]/[29.2px]">Connect your agent in one click, then run your whole GTM from it.</p>
      </div>
      <div className="flex flex-col gap-3.5 sm:flex-row sm:flex-wrap sm:items-center">
        <a href={CURSOR_INSTALL_URL} className={button} title="Opens Cursor to install the crusonia MCP server">
          <CursorMark />
          Add to Cursor
        </a>
        <CopyCommandButton mark={<ClaudeMark />} label="Add to Claude Code" agent="Claude Code" command={CLAUDE_CODE_COMMAND} onCopied={setStatus} />
        <CopyCommandButton mark={<CodexMark />} label="Add to Codex" agent="Codex" command={CODEX_COMMAND} onCopied={setStatus} />
      </div>
      <p role="status" className="sr-only">
        {status}
      </p>
    </section>
  );
}
