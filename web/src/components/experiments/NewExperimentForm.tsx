// "New experiment" form, shown in the Experiments detail pane. POST /api/experiments with the hypothesis, the
// two variants, the stop rule and (optionally) the leads to enroll. Creating it sends nothing.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { CreateExperimentInput, Experiment } from "../../api.ts";
import { useApi } from "../../auth.tsx";
import { cx, leadTitle } from "../../lib/format.ts";
import { keys, useLeads, useProfile } from "../../queries.ts";
import { errorCopy, Skeleton } from "../ui.tsx";
import { ARM_COLOR } from "./RepliesChart.tsx";
import type { Arm } from "./derive.ts";

export type Enrollment = { enrolled: number; skipped: string[] };

const input =
  "h-9 w-full rounded-lg border border-[#200D0D26] bg-white px-3 text-[13px]/4.5 font-medium text-ink placeholder:text-[#200D0D59] focus:border-ink focus:outline-none";
const labelCls = "text-xs/4 font-medium text-muted";

function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={htmlFor} className={labelCls}>
        {label}
      </label>
      {children}
      {hint ? <div className="text-[11px]/3.5 font-medium text-faint">{hint}</div> : null}
    </div>
  );
}

const toInt = (v: string) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export function NewExperimentForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (e: Experiment, enrollment: Enrollment) => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const profile = useProfile();
  const id = useId();
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  const [name, setName] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [segment, setSegment] = useState("");
  const [sends, setSends] = useState("80");
  const [days, setDays] = useState("14");
  const [variants, setVariants] = useState<Record<Arm, { name: string; description: string }>>({
    A: { name: "", description: "" },
    B: { name: "", description: "" },
  });
  const [leadIds, setLeadIds] = useState<Set<string>>(new Set());

  const create = useMutation({
    mutationFn: (body: CreateExperimentInput) => api.createExperiment(body),
    onSuccess: ({ experiment, enrollment }) => {
      qc.setQueryData<Experiment[]>(keys.experiments, (old) => (old ? [experiment, ...old.filter((x) => x.id !== experiment.id)] : old));
      void qc.invalidateQueries({ queryKey: keys.experiments });
      onCreated(experiment, enrollment);
    },
  });

  function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!name.trim()) return;
    const v = (k: Arm) => {
      const n = variants[k].name.trim();
      const d = variants[k].description.trim();
      return n || d ? { ...(n ? { name: n } : {}), ...(d ? { description: d } : {}) } : undefined;
    };
    const A = v("A");
    const B = v("B");
    create.mutate({
      name: name.trim(),
      ...(hypothesis.trim() ? { hypothesis: hypothesis.trim() } : {}),
      ...(segment.trim() ? { segment: segment.trim() } : {}),
      ...(toInt(sends) ? { stop_rule_sends_per_arm: toInt(sends) } : {}),
      ...(toInt(days) ? { stop_rule_days: toInt(days) } : {}),
      ...(A || B ? { variants: { ...(A ? { A } : {}), ...(B ? { B } : {}) } } : {}),
      ...(leadIds.size ? { lead_ids: [...leadIds] } : {}),
    });
  }

  const err = create.error ? errorCopy(create.error, "Experiments") : null;
  return (
    <form onSubmit={submit} className="flex flex-col gap-5 px-5 pb-6 pt-4.5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg/6 font-semibold tracking-[-0.015em] text-ink">New experiment</h2>
          <p className="max-w-130 text-[13px]/4.5 font-medium text-muted">
            One hypothesis, two message variants. Each lead keeps its variant for the whole test, and every send still waits for your approval.
          </p>
        </div>
        <button type="button" onClick={onCancel} className="flex h-8 shrink-0 items-center rounded-full px-3.5 text-[13px]/4 font-medium text-ink hover:bg-[#200D0D0A]">
          Cancel
        </button>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-4">
        <Field label="Name" htmlFor={`${id}-name`}>
          <input ref={first} id={`${id}-name`} required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} placeholder="Hiring angle vs funding angle" className={input} />
        </Field>
        <Field label="Segment (optional)" htmlFor={`${id}-segment`} hint={profile.data?.segments?.length ? "Pick one of your profile's segments or type your own" : undefined}>
          <input
            id={`${id}-segment`}
            list={`${id}-segments`}
            maxLength={1000}
            value={segment}
            onChange={(e) => setSegment(e.target.value)}
            placeholder="Founder-led devtools"
            className={input}
          />
          <datalist id={`${id}-segments`}>
            {profile.data?.segments?.map((s) => <option key={s.name} value={s.name} />)}
          </datalist>
        </Field>
        <div className="col-span-2">
          <Field label="Hypothesis" htmlFor={`${id}-hyp`}>
            <textarea
              id={`${id}-hyp`}
              rows={2}
              maxLength={4000}
              value={hypothesis}
              onChange={(e) => setHypothesis(e.target.value)}
              placeholder="The hiring-signal angle gets more positive replies than the funding angle"
              className={cx(input, "h-auto resize-none py-2")}
            />
          </Field>
        </div>
        {(["A", "B"] as const).map((k) => (
          <fieldset key={k} className="flex min-w-0 flex-col gap-2 rounded-[10px] border border-[#200D0D1A] p-3.5">
            <legend className="sr-only">Variant {k}</legend>
            <div className="flex items-center gap-2">
              <span className="flex size-5.5 items-center justify-center rounded-md text-xs/3.5 font-semibold" style={{ background: ARM_COLOR[k].badgeBg, color: ARM_COLOR[k].text }}>
                {k}
              </span>
              <span className="text-[13px]/4 font-semibold text-ink">Variant {k}</span>
            </div>
            <input
              aria-label={`Variant ${k} name`}
              maxLength={200}
              value={variants[k].name}
              onChange={(e) => setVariants((v) => ({ ...v, [k]: { ...v[k], name: e.target.value } }))}
              placeholder={k === "A" ? "Funding angle" : "Hiring angle"}
              className={input}
            />
            <input
              aria-label={`Variant ${k} description`}
              maxLength={4000}
              value={variants[k].description}
              onChange={(e) => setVariants((v) => ({ ...v, [k]: { ...v[k], description: e.target.value } }))}
              placeholder={k === "A" ? "Opens with their latest funding round" : "Opens with the role they are hiring for"}
              className={input}
            />
          </fieldset>
        ))}
        <Field label="Stop after (sends per arm)" htmlFor={`${id}-sends`} hint="Leave empty for no send limit">
          <input id={`${id}-sends`} type="number" min={1} inputMode="numeric" value={sends} onChange={(e) => setSends(e.target.value)} className={cx(input, "tabular-nums")} />
        </Field>
        <Field label="Or after (days)" htmlFor={`${id}-days`} hint="Whichever comes first. Leave both empty to stop it by hand.">
          <input id={`${id}-days`} type="number" min={1} max={365} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} className={cx(input, "tabular-nums")} />
        </Field>
      </div>

      <LeadPicker selected={leadIds} onChange={setLeadIds} />

      {err ? (
        <p role="alert" className={cx("text-xs/4 font-medium", err.calm ? "text-muted" : "text-[#B42318]")}>
          {err.title}. {err.body}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={!name.trim() || create.isPending}
          className="flex h-9 items-center rounded-full bg-lime px-4 text-sm/4.5 font-medium text-ink hover:bg-[#b3de7a] disabled:opacity-60"
        >
          {create.isPending ? "Creating…" : "Create experiment"}
        </button>
        <span className="text-xs/4 font-medium text-faint">Creating it sends nothing.</span>
      </div>
    </form>
  );
}

/** Optional: the most recent leads, each shown with the variant it will stay in. */
function LeadPicker({ selected, onChange }: { selected: Set<string>; onChange: (s: Set<string>) => void }) {
  const leads = useLeads({ limit: 50 });
  const rows = leads.data?.data ?? [];
  const all = rows.length > 0 && rows.every((l) => selected.has(l.id));
  const toggle = (leadId: string) => {
    const next = new Set(selected);
    if (next.has(leadId)) next.delete(leadId);
    else next.add(leadId);
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <div className={labelCls}>Leads to enroll (optional{selected.size ? ` · ${selected.size} selected` : ""})</div>
        {rows.length ? (
          <button type="button" onClick={() => onChange(all ? new Set() : new Set(rows.map((l) => l.id)))} className="text-xs/4 font-medium text-ink underline decoration-[#200D0D4D] underline-offset-[3px] hover:decoration-ink">
            {all ? "Clear" : `Select all ${rows.length}`}
          </button>
        ) : null}
      </div>
      <div className="max-h-48 overflow-y-auto rounded-[10px] border border-[#200D0D1A]">
        {leads.isPending ? (
          <div className="flex flex-col gap-2 p-3">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : rows.length === 0 ? (
          <div className="px-3.5 py-3 text-xs/4 font-medium text-faint">
            {leads.isError ? errorCopy(leads.error, "Leads").body : "No leads yet. You can create the experiment now and enroll leads once your agents find some."}
          </div>
        ) : (
          rows.map((l) => (
            <label key={l.id} className="flex h-9 cursor-pointer items-center gap-2.5 border-b border-b-[#200D0D0F] px-3.5 last:border-b-0 hover:bg-[#200D0D05]">
              <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l.id)} className="size-3.5 accent-[#200D0D]" />
              <span className="min-w-0 grow truncate text-[13px]/4 font-medium text-ink">{leadTitle(l)}</span>
              <span className="truncate text-xs/4 font-medium text-faint">{l.email ?? l.domain ?? ""}</span>
              <span
                className="flex size-5 shrink-0 items-center justify-center rounded-md text-[11px]/3 font-semibold"
                style={{ background: ARM_COLOR[l.variant].badgeBg, color: ARM_COLOR[l.variant].text }}
                title={`Stays in variant ${l.variant}`}
              >
                {l.variant}
              </span>
            </label>
          ))
        )}
      </div>
      <div className="text-[11px]/3.5 font-medium text-faint">Leads already in another running experiment are skipped.</div>
    </div>
  );
}
