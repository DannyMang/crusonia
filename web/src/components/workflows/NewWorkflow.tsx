// "New workflow": the one workflow the dashboard can start today. Find leads starts a paid Naive run
// (POST /api/leads/find) only after the owner opens this panel and presses Start.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../../auth.tsx";
import { keys } from "../../queries.ts";
import { Button, errorCopy } from "../ui.tsx";

const MAX = 50;

export function NewWorkflowButton() {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(25);
  const ref = useRef<HTMLDivElement>(null);
  const find = useMutation({
    mutationFn: () => api.findLeads(count),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: keys.workflows });
      setOpen(false);
      navigate(`/app/workflows/runs/${encodeURIComponent(res.session_id)}`);
    },
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const err = find.error ? errorCopy(find.error, "finding leads") : null;
  const valid = Number.isInteger(count) && count >= 1 && count <= MAX;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 items-center gap-1.5 rounded-full bg-lime px-4 text-ink transition-colors hover:bg-[#b3de7a]"
      >
        <span className="text-base/4 font-medium">+</span>
        <span className="text-sm/4.5 font-medium">New workflow</span>
      </button>
      {open ? (
        <div role="dialog" aria-label="New workflow" className="absolute right-0 top-11 z-20 flex w-80 flex-col rounded-xl border border-[#200D0D1A] bg-white p-1 shadow-[0_12px_32px_-12px_rgb(32_13_13/28%)]">
          <form
            className="flex flex-col gap-2.5 rounded-lg p-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid && !find.isPending) find.mutate();
            }}
          >
            <div className="flex flex-col gap-0.5">
              <div className="text-sm/4.5 font-semibold text-ink">Find leads</div>
              <p className="text-xs/4.25 font-medium text-muted">
                The agent searches for companies that match your profile and adds them with sources. This starts a paid agent run.
              </p>
            </div>
            <label className="flex items-center gap-2 text-[13px]/4 font-medium text-ink">
              Up to
              <input
                type="number"
                min={1}
                max={MAX}
                value={Number.isNaN(count) ? "" : count}
                onChange={(e) => setCount(e.target.valueAsNumber)}
                className="h-8 w-16 rounded-lg border border-[#200D0D26] px-2 text-[13px]/4 tabular-nums outline-none focus:border-[#200D0D59]"
              />
              leads
            </label>
            {err ? (
              <div role={err.calm ? "status" : "alert"} className={err.calm ? "text-xs/4 font-medium text-muted" : "text-xs/4 font-medium text-[#B42318]"}>
                {err.title}. {err.body}
              </div>
            ) : null}
            <Button type="submit" size="sm" loading={find.isPending} disabled={!valid} className="self-start">
              Start finding leads
            </Button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
