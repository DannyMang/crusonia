// S3 "Set-up fast." (Paper: Landing v2 > S3 · Connect agent): one click per agent.
// - Cursor: Cursor's MCP install deeplink (cursor.com/docs: cursor://anysphere.cursor-deeplink/mcp/install
//   ?name=<name>&config=<base64 of the server's JSON config>). Cursor opens and asks to install crusonia.
// - Claude Code and Codex have no install links, so the button copies the exact `mcp add` command.
// All three read the API key from CRUSONIA_MCP_TOKEN when they connect; the full setup (with key creation) is in
// the app under Connect your agent.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { SECTIONS } from "./sections.ts";

export const MCP_URL = "https://crusonia.veri-web.workers.dev/mcp";

const cursorConfig = { url: MCP_URL, headers: { Authorization: "Bearer ${env:CRUSONIA_MCP_TOKEN}" } };
export const CURSOR_INSTALL_URL =
  "cursor://anysphere.cursor-deeplink/mcp/install?name=crusonia&config=" + encodeURIComponent(btoa(JSON.stringify(cursorConfig)));

export const CLAUDE_CODE_COMMAND =
  "claude mcp add --transport http --scope user crusonia " + MCP_URL + " --header 'Authorization: Bearer ${CRUSONIA_MCP_TOKEN}'";
export const CODEX_COMMAND = "codex mcp add crusonia --url " + MCP_URL + " --bearer-token-env-var CRUSONIA_MCP_TOKEN";

// Each tool's official mark in its brand color (owner, Nov 8: "use the right colors"), 24px grid. Paths from the
// Simple Icons set (simpleicons.org, CC0), which tracks each brand's own assets: Cursor (#000000), Claude (#D97757)
// and OpenAI for Codex (black, per openai.com/brand).
const markProps = { width: 24, height: 24, viewBox: "0 0 24 24", "aria-hidden": true, className: "shrink-0" } as const;

const CursorMark = () => (
  <svg {...markProps}>
    <path fill="#000000" d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
  </svg>
);

const ClaudeMark = () => (
  <svg {...markProps}>
    <path fill="#D97757" d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
  </svg>
);

const CodexMark = () => (
  <svg {...markProps}>
    <path fill="#000000" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
  </svg>
);

const CheckMark = () => (
  <svg {...markProps}>
    <path d="M5.5 12.5L10 17L18.5 7.5" fill="none" stroke="#200D0D" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// Press-and-release bounce and the copied state live in index.css (.agent-button), so they can honor
// prefers-reduced-motion without JS.
const button =
  "agent-button flex h-15 shrink-0 items-center justify-center gap-3 rounded-full border border-[#200D0D26] bg-white pr-6.5 pl-5.5 text-base/5 font-semibold text-ink shadow-[0_10px_24px_#200D0D0F] hover:border-[#200D0D4D] sm:justify-start";

/** How long the lime "Copied" state holds before it fades back. */
const COPIED_MS = 1_300;

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
    // Feedback first: the button turns lime on the click itself, not after the clipboard answers.
    clearTimeout(timer.current);
    setCopied(true);
    if (await copyText(command)) {
      onCopied(`${agent} command copied. Paste it in your terminal.`);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } else {
      setCopied(false);
      // Nothing could write to the clipboard: let the visitor copy it by hand.
      window.prompt(`Run this in your terminal to add Crusonia to ${agent}:`, command);
    }
  }

  return (
    <button type="button" onClick={copy} aria-label={label} title={`Copies: ${command}`} className={button} data-copied={copied || undefined}>
      {/* Icon and label crossfade in one grid cell each, so the button keeps its width when it says "Copied".
          The button keeps its accessible name; the status line below announces the copy. */}
      <span className="grid shrink-0">
        <span className="agent-face agent-face-idle col-start-1 row-start-1">{mark}</span>
        <span aria-hidden className="agent-face agent-face-copied col-start-1 row-start-1">
          <CheckMark />
        </span>
      </span>
      <span className="grid text-left">
        <span className="agent-face agent-face-idle col-start-1 row-start-1">{label}</span>
        <span aria-hidden className="agent-face agent-face-copied col-start-1 row-start-1">
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
