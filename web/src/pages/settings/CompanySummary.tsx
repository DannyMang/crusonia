// Settings · Company summary at /app/settings/company (Paper: naive > "Settings · Company summary" and
// "(editing)"). GTM.md is the workspace's one document about what it sells and to whom; agents and people both
// edit it, and a save overwrites it (GET/PUT /api/company-summary): there is no history. The view renders the
// markdown (React elements only, see lib/markdown.tsx); Edit swaps in the raw text.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { isApiError, type CompanySummary as Summary } from "../../api.ts";
import { useApi } from "../../auth.tsx";
import { Page } from "../../components/AppShell.tsx";
import { Button, Card, EmptyState, QueryError, Skeleton } from "../../components/ui.tsx";
import { cx, timeAgo } from "../../lib/format.ts";
import { Markdown } from "../../lib/markdown.tsx";
import { keys, useCompanySummary } from "../../queries.ts";
import { CrumbBar } from "../connect/CrumbBar.tsx";
import { SettingsTabs } from "./SettingsTabs.tsx";

/** The design's square-ish header buttons (Edit, Cancel, Save). */
const squareButton = "inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-lg px-3.5 text-[13px]/4 transition-colors disabled:cursor-default disabled:opacity-60";

export default function CompanySummary() {
  const api = useApi();
  const qc = useQueryClient();
  const summary = useCompanySummary();
  const s = summary.data;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: keys.companySummary });
    void qc.invalidateQueries({ queryKey: keys.profile });
  };

  const save = useMutation({
    mutationFn: () => api.saveCompanySummary({ markdown: text, base_version: s?.version ?? 0 }),
    onSuccess: (saved) => {
      qc.setQueryData(keys.companySummary, saved);
      invalidate();
      setEditing(false);
    },
  });

  const startEditing = () => {
    if (!s) return;
    setText(s.markdown ?? s.template ?? "");
    save.reset();
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    save.reset();
  };
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!save.isPending) save.mutate();
  };

  const tooLong = Boolean(s?.max_chars && text.length > s.max_chars);
  const conflict = isApiError(save.error) && save.error.code === "version_conflict";

  return (
    <>
      <CrumbBar here="Company summary" parent={{ label: "Settings", to: "/app/settings" }} />
      <Page>
        <div className="flex w-240 max-w-full flex-col gap-4 px-4 pb-14 pt-6 sm:px-12 sm:pt-8">
          <SettingsTabs />
          <div className="flex items-end justify-between gap-4 pb-2">
            <h1 className="text-xl/5.75 font-medium tracking-[-0.01em] text-ink">Company summary</h1>
            {editing ? (
              <div className="flex shrink-0 items-center gap-2">
                <button type="button" onClick={cancel} className={cx(squareButton, "border border-[#200D0D26] bg-white font-medium text-ink hover:bg-[#200D0D08]")}>
                  Cancel
                </button>
                <button
                  type="submit"
                  form="summary-form"
                  disabled={save.isPending || tooLong || !text.trim()}
                  className={cx(squareButton, "bg-lime font-semibold text-ink hover:bg-[#b3de7a]")}
                >
                  {save.isPending ? "Saving…" : "Save"}
                </button>
              </div>
            ) : s ? (
              <button type="button" onClick={startEditing} className={cx(squareButton, "border border-[#200D0D26] bg-white pl-3.5 pr-3 font-medium text-ink hover:bg-[#200D0D08]")}>
                {s.version ? "Edit" : "Write it"}
              </button>
            ) : null}
          </div>

          {summary.isError ? (
            <QueryError error={summary.error} what="the company summary" onRetry={() => void summary.refetch()} />
          ) : summary.isPending || !s ? (
            <SummarySkeleton />
          ) : editing ? (
            <form id="summary-form" onSubmit={submit} className="flex w-full min-w-0 flex-col gap-3.5 rounded-xl border border-[#200D0D1A] bg-white px-4 py-5 sm:px-7 sm:py-6">
              <div className="text-[15px]/4.5 font-medium text-ink">GTM.md</div>
              <SummaryTextarea value={text} onChange={setText} onSave={submit} onCancel={cancel} />
              {tooLong ? <p className="text-xs/4 font-medium text-[#B42318]">{`${text.length.toLocaleString("en-US")} / ${s.max_chars!.toLocaleString("en-US")} characters`}</p> : null}
              {save.isError ? (
                conflict ? (
                  <div role="alert" className="flex items-center justify-between gap-3 rounded-[10px] border border-[#B4231829] bg-[#FDECEB80] px-4 py-3 text-[13px]/5">
                    <span className="font-medium text-ink">{save.error.message}</span>
                    <Button variant="soft" onClick={() => void summary.refetch().then(() => save.reset())}>
                      Reload
                    </Button>
                  </div>
                ) : (
                  <QueryError error={save.error} what="saving" />
                )
              ) : null}
            </form>
          ) : s.version === 0 ? (
            <Card className="flex w-full min-w-0 flex-col">
              <EmptyState title="No company summary yet" action={<Button onClick={startEditing}>Write it</Button>} />
            </Card>
          ) : (
            <SummaryCard s={s} />
          )}
        </div>
      </Page>
    </>
  );
}

function SummaryCard({ s }: { s: Summary }) {
  return (
    <section aria-label="GTM.md" className="flex w-full min-w-0 flex-col rounded-xl border border-[#200D0D1A] bg-white px-4 pb-6 pt-5 sm:px-7 sm:pb-7 sm:pt-6">
      <div className="flex items-center justify-between border-b border-b-[#200D0D1A] pb-4">
        <div className="text-[15px]/4.5 font-medium text-ink">GTM.md</div>
        {s.updated_at ? <div className="text-[13px]/4 font-medium text-muted">{timeAgo(s.updated_at)}</div> : null}
      </div>
      <Markdown source={s.markdown ?? ""} className="pt-5" />
    </section>
  );
}

/** Raw markdown, growing with its content. ⌘/Ctrl+Enter saves, Esc cancels. */
function SummaryTextarea({ value, onChange, onSave, onCancel }: { value: string; onChange: (v: string) => void; onSave: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight + 2, 320)}px`;
  }, [value]);
  useEffect(() => ref.current?.focus(), []);
  return (
    <textarea
      ref={ref}
      value={value}
      aria-label="GTM.md"
      spellCheck
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onSave();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      className="w-full resize-none rounded-[10px] border border-[#200D0D40] bg-white px-4.5 py-4 text-sm/6 font-[450] text-ink outline-none focus:shadow-[0_0_0_3px_#BDE68966]"
    />
  );
}

function SummarySkeleton() {
  return (
    <div className="flex w-full min-w-0 flex-col gap-3 rounded-xl border border-[#200D0D1A] px-4 py-5 sm:px-7 sm:py-6">
      <Skeleton className="h-4.5 w-20" />
      <Skeleton className="mt-4 h-7 w-40" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}
