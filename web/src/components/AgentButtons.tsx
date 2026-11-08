// "Add to Cursor / Claude Code / Codex" buttons (Paper: "Landing S3 · Add-to button states"), used on the landing
// (large) and on Settings · Connect your agent (row). Press-and-release bounce and the lime "Copied"
// state live in index.css (.agent-button), so they honor prefers-reduced-motion without JS.
import { useEffect, useRef, useState } from "react";
import { claudeCodeCommand, codexCommand, copyText, cursorInstallUrl } from "../lib/agent-install.ts";
import { cx } from "../lib/format.ts";
import { publicLogoAllowed } from "../lib/public-logos.ts";
import { BrandLogo } from "./BrandLogo.tsx";

type Size = "lg" | "row";

const base: Record<Size, string> = {
  lg: "h-15 justify-center gap-3 pr-6.5 pl-5.5 text-base/5 shadow-[0_10px_24px_#200D0D0F] sm:justify-start",
  row: "h-11 justify-center gap-2.5 pr-4.5 pl-3.5 text-sm/4.5 sm:justify-start",
};
const button = (size: Size) =>
  cx(
    "agent-button flex shrink-0 items-center rounded-full border border-[#200D0D26] bg-white font-semibold text-ink hover:border-[#200D0D4D]",
    base[size],
  );
const markSize: Record<Size, number> = { lg: 24, row: 20 };

/** How long the lime "Copied" state holds before it fades back. */
const COPIED_MS = 1_300;

function CheckMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="shrink-0">
      <path d="M5.5 12.5L10 17L18.5 7.5" fill="none" stroke="#200D0D" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CursorButton({ mcpUrl, size = "lg" }: { mcpUrl?: string; size?: Size }) {
  return (
    <a href={cursorInstallUrl(mcpUrl)} className={button(size)} title="Opens Cursor to install the crusonia MCP server">
      <BrandLogo name="cursor" size={markSize[size]} />
      Add to Cursor
    </a>
  );
}

function CopyCommandButton({ agent, command, size, publicPage, onCopied }: { agent: "claude" | "codex"; command: string; size: Size; publicPage?: boolean; onCopied: (msg: string) => void }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const name = agent === "claude" ? "Claude Code" : "Codex";
  const label = `Add to ${name}`;

  async function copy() {
    // Feedback first: the button turns lime on the click itself, not after the clipboard answers.
    clearTimeout(timer.current);
    setCopied(true);
    if (await copyText(command)) {
      onCopied(`${name} command copied. Paste it in your terminal.`);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } else {
      setCopied(false);
      // Nothing could write to the clipboard: let the visitor copy it by hand.
      window.prompt(`Run this in your terminal to add Crusonia to ${name}:`, command);
    }
  }

  return (
    <button type="button" onClick={copy} aria-label={label} title={`Copies: ${command}`} className={button(size)} data-copied={copied || undefined}>
      {/* Icon and label crossfade in one grid cell each, so the button keeps its width when it says "Copied".
          The button keeps its accessible name; the status line announces the copy. */}
      {!publicPage || publicLogoAllowed(agent) ? (
        <span className="grid shrink-0">
          <span className="agent-face agent-face-idle col-start-1 row-start-1">
            <BrandLogo name={agent} size={markSize[size]} />
          </span>
          <span aria-hidden className="agent-face agent-face-copied col-start-1 row-start-1">
            <CheckMark size={markSize[size]} />
          </span>
        </span>
      ) : null}
      <span className="grid text-left">
        <span className="agent-face agent-face-idle col-start-1 row-start-1">{label}</span>
        <span aria-hidden className="agent-face agent-face-copied col-start-1 row-start-1">
          Copied
        </span>
      </span>
    </button>
  );
}

/**
 * The three buttons plus a polite status line for screen readers. `mcpUrl`: the endpoint the Worker reports. `publicPage`:
 * on a page anyone can see, where some logos need their owner's approval first (lib/public-logos.ts).
 */
export function AgentButtons({ mcpUrl, size = "lg", className, publicPage }: { mcpUrl?: string; size?: Size; className?: string; publicPage?: boolean }) {
  const [status, setStatus] = useState("");
  return (
    <>
      <div className={className}>
        <CursorButton mcpUrl={mcpUrl} size={size} />
        <CopyCommandButton agent="claude" command={claudeCodeCommand(mcpUrl)} size={size} publicPage={publicPage} onCopied={setStatus} />
        <CopyCommandButton agent="codex" command={codexCommand(mcpUrl)} size={size} publicPage={publicPage} onCopied={setStatus} />
      </div>
      <p role="status" className="sr-only">
        {status}
      </p>
    </>
  );
}
