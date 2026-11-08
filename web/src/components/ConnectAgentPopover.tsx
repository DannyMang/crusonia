// Connect your agent (Paper: "Final · Connect agent popover"): a small floating button at the bottom right of every
// /app page, opening a compact popover with the one-click Add to Cursor / Claude Code / Codex buttons (shared with the
// landing) and an API key line. It replaces the old /app/connect page; that path and any `?connect=1` link open it.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { useApi } from "../auth.tsx";
import { exportLine, MCP_URL, TOKEN_ENV } from "../lib/agent-install.ts";
import { cx } from "../lib/format.ts";
import type { CreatedKey } from "../pages/settings/ApiKeys.tsx";
import { keys, useStatus } from "../queries.ts";
import { AgentButtons } from "./AgentButtons.tsx";
import { BrandLogo } from "./BrandLogo.tsx";
import { CopyButton, errorCopy } from "./ui.tsx";

/** The workflow builder keeps its zoom controls in the bottom-right corner, so the button steps aside there. */
export const HIDE_TRIGGER = /^\/app\/workflows\/(new|[^/]+)$/;

/** Default name for a key made here, e.g. "Agent key · Nov 8"; renamed or revoked in Settings › API keys. */
const keyName = () => `Agent key · ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

export function ConnectAgentPopover() {
  const [open, setOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const { pathname } = useLocation();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const panelId = useId();

  // A key made here is kept while the app is open (the popover can close and reopen), never stored.
  const api = useApi();
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: () => api.createKey(keyName()),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.keys }),
  });

  // ?connect=1 (and the old /app/connect, which redirects to /app?connect=1) opens it, then the param is dropped.
  useEffect(() => {
    if (params.get("connect") !== "1") return;
    setOpen(true);
    const next = new URLSearchParams(params);
    next.delete("connect");
    setParams(next, { replace: true });
  }, [params, setParams]);

  // Focus moves into the popover when it opens; Esc or a click outside closes it.
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !trigger.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const hideTrigger = HIDE_TRIGGER.test(pathname) && !open;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2.5 sm:bottom-6 sm:right-6">
      {open ? (
        <div
          ref={panel}
          id={panelId}
          role="dialog"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="pointer-events-auto flex w-84 max-w-[calc(100vw-32px)] flex-col gap-3.5 rounded-2xl border border-[#200D0D1A] bg-white p-4.5 text-ink shadow-[0_20px_48px_#200D0D1F] outline-none"
        >
          <div className="flex h-6 items-center justify-between">
            <h2 id={titleId} className="text-[15px]/5 font-semibold tracking-[-0.01em]">
              Connect your agent
            </h2>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
              aria-label="Close"
              className="flex size-6 items-center justify-center rounded-md text-muted hover:bg-[#200D0D0A] hover:text-ink"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <PanelButtons />
          <KeyLine created={create.data ?? null} pending={create.isPending} error={create.error} onCreate={() => create.mutate()} onNavigate={() => setOpen(false)} />
        </div>
      ) : null}
      {hideTrigger ? null : (
        <button
          ref={trigger}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-haspopup="dialog"
          className={cx(
            "pointer-events-auto flex h-11 items-center gap-2.5 rounded-full border bg-white pl-2 pr-4 text-sm/4.5 font-semibold text-ink shadow-[0_10px_24px_#200D0D14] transition-colors",
            open ? "border-[#200D0D4D]" : "border-[#200D0D26] hover:border-[#200D0D4D]",
          )}
        >
          <span aria-hidden className="flex items-center">
            {(["cursor", "claude", "codex"] as const).map((name, i) => (
              <span key={name} className={cx("flex size-7 items-center justify-center rounded-full border border-[#200D0D1A] bg-white", i > 0 && "-ml-2")}>
                <BrandLogo name={name} size={16} />
              </span>
            ))}
          </span>
          Connect your agent
        </button>
      )}
    </div>
  );
}

/** The three Add-to buttons, pointed at the MCP endpoint this Worker reports (staging has its own). */
function PanelButtons() {
  const status = useStatus();
  return <AgentButtons size="md" mcpUrl={status.data?.mcp_url || MCP_URL} className="flex flex-col gap-2" />;
}

function KeyLine({
  created,
  pending,
  error,
  onCreate,
  onNavigate,
}: {
  created: CreatedKey | null;
  pending: boolean;
  error: unknown;
  onCreate: () => void;
  onNavigate: () => void;
}) {
  const err = error ? errorCopy(error, "API keys") : null;
  return (
    <div className="flex flex-col gap-2.5 border-t border-t-[#200D0D14] pt-3.5">
      <div className="flex h-7.5 items-center justify-between gap-3">
        <span className="text-[13px]/4 font-medium">{created ? "Your key, shown once" : "API key"}</span>
        <div className="flex shrink-0 items-center gap-3">
          <Link
            to="/app/settings/keys"
            onClick={onNavigate}
            className="text-[13px]/4 font-medium underline decoration-[#200D0D4D] underline-offset-[3px] hover:decoration-ink"
          >
            Manage keys
          </Link>
          {created ? null : (
            <button
              type="button"
              onClick={onCreate}
              disabled={pending}
              className="flex h-7.5 items-center rounded-full bg-lime px-3 text-[13px]/4 font-medium hover:bg-[#b3de7a] disabled:opacity-60"
            >
              {pending ? "Creating…" : "Create key"}
            </button>
          )}
        </div>
      </div>
      {created ? (
        <div className="flex h-9 items-center gap-2 rounded-lg bg-[#200D0D0A] pl-3 pr-1.5" title={`Sets ${TOKEN_ENV} for your agent`}>
          <code className="min-w-0 grow truncate text-xs/4 font-medium">{exportLine(created.key)}</code>
          <CopyButton text={exportLine(created.key)} className="h-6" />
        </div>
      ) : null}
      {err ? (
        <p role="alert" className={cx("text-xs/4 font-medium", err.calm ? "text-muted" : "text-[#B42318]")}>
          {err.title}. {err.body}
        </p>
      ) : null}
    </div>
  );
}
