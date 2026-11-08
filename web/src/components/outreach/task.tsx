// A manual outreach task (LinkedIn note, X message, warm intro, email from your own mailbox): the text with its
// citations, and the owner's actions. Copy the text, open the profile, send it yourself, then mark it sent (the
// lead moves to `sent`) or skip it. Nothing here sends anything. Used by Outreach > Tasks and the lead detail.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Task } from "../../api.ts";
import { useApi } from "../../auth.tsx";
import { citeBody } from "../../lib/citations.ts";
import { cx } from "../../lib/format.ts";
import { keys } from "../../queries.ts";
import { QueryError } from "../ui.tsx";

export const CHANNEL: Record<string, { label: string; short: string; copy: string; limit?: number }> = {
  linkedin: { label: "LinkedIn note", short: "LinkedIn note", copy: "Copy note", limit: 300 },
  x: { label: "X message", short: "X DM", copy: "Copy message" },
  intro: { label: "Warm intro request", short: "Warm intro", copy: "Copy blurb" },
  email_manual: { label: "Email from your mailbox", short: "Email", copy: "Copy email" },
  email: { label: "Email", short: "Email", copy: "Copy email" },
};

export const channelOf = (c: string) => CHANNEL[c] ?? { label: c, short: c, copy: "Copy text" };

/** The text with "[n]" after each cited phrase, n matching the lead's evidence numbers when `sources` is given. */
export function CitedBody({ body, citations, sources, className }: { body: string; citations: Task["citations"]; sources?: string[]; className?: string }) {
  const parts = citeBody(body, citations, sources);
  return (
    <p className={cx("whitespace-pre-wrap [overflow-wrap:anywhere]", className)}>
      {parts.map((p, i) =>
        p.t === "text" ? (
          p.v
        ) : (
          <a key={i} href={p.url} target="_blank" rel="noopener noreferrer nofollow" className="text-green-dark hover:text-ink">
            {" "}[{p.n}]
          </a>
        ),
      )}
    </p>
  );
}

export function CharCount({ task }: { task: Pick<Task, "body" | "channel"> }) {
  const limit = channelOf(task.channel).limit;
  if (!limit) return null;
  const over = task.body.length > limit;
  return (
    <span className={cx("text-xs/4 font-medium tabular-nums", over ? "text-[#B42318]" : "text-muted")}>
      {task.body.length} / {limit}
    </span>
  );
}

/** Copy, Open profile, Mark sent and Skip. `onDone` runs after Mark sent or Skip succeeds. */
export function TaskActions({ task, onDone, compact }: { task: Task; onDone?: (message: string) => void; compact?: boolean }) {
  const api = useApi();
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["tasks"] });
    void qc.invalidateQueries({ queryKey: keys.lead(task.lead_id) });
    void qc.invalidateQueries({ queryKey: ["leads"] });
    void qc.invalidateQueries({ queryKey: keys.summary });
  };
  const sent = useMutation({
    mutationFn: () => api.taskSent(task.id),
    onSuccess: () => {
      invalidate();
      onDone?.(`Marked sent to ${task.lead.name ?? task.lead.company ?? "the lead"}`);
    },
  });
  const skip = useMutation({
    mutationFn: () => api.taskSkip(task.id),
    onSuccess: () => {
      invalidate();
      onDone?.("Skipped");
    },
  });
  const copy = async () => {
    const text = task.channel === "email_manual" && task.subject ? `${task.subject}\n\n${task.body}` : task.body;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked; the text stays selectable.
    }
  };
  const open = task.status === "open";
  const pill = "flex h-9.5 shrink-0 items-center justify-center rounded-full px-4 text-sm/4.5 font-medium transition-colors disabled:opacity-50";
  const ch = channelOf(task.channel);
  return (
    <div className="flex flex-col gap-2">
      <div className={cx("flex flex-wrap items-center gap-2", compact && "flex-nowrap")}>
        <button type="button" onClick={() => void copy()} className={cx(pill, "bg-lime px-4.5 font-semibold text-ink hover:bg-[#b3de7a]", compact && "grow")}>
          {copied ? "Copied" : ch.copy}
        </button>
        {task.open_url ? (
          <a href={task.open_url} target="_blank" rel="noopener noreferrer nofollow" className={cx(pill, "border border-ink bg-white text-ink hover:bg-[#200D0D08]")}>
            {task.open_url.startsWith("mailto:") ? "Open in mail" : "Open profile"}
          </a>
        ) : null}
        {open ? (
          <>
            <button type="button" onClick={() => sent.mutate()} disabled={sent.isPending || skip.isPending} className={cx(pill, "border border-ink bg-white text-ink hover:bg-[#200D0D08]")}>
              {sent.isPending ? "Marking…" : "Mark sent"}
            </button>
            {compact ? null : (
              <button type="button" onClick={() => skip.mutate()} disabled={sent.isPending || skip.isPending} className={cx(pill, "px-3 text-muted hover:text-ink")}>
                Skip
              </button>
            )}
          </>
        ) : null}
      </div>
      {sent.isError ? <QueryError error={sent.error} what="marking it sent" /> : null}
      {skip.isError ? <QueryError error={skip.error} what="skipping" /> : null}
    </div>
  );
}
