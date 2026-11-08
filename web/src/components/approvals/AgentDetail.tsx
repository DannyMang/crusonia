// Right pane for agent approvals: a `tool` call outside the auto-confirm policy (Allow / Deny, scope call or
// session) and an ask_operator `question` (fields -> answers). Agent payloads are untrusted: shown as text only.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { ApprovalListItem } from "../../api.ts";
import { useApi } from "../../auth.tsx";
import { cx } from "../../lib/format.ts";
import { keys } from "../../queries.ts";
import { jsonText, questionOf, toolNameOf, type QuestionField } from "./model.ts";
import { ActionBar, ActionButton, Bound, BindingStrip, DetailHead, ReasonRow, useDisarm, useKeys, type OnDecided } from "./parts.tsx";

function useInvalidate(a: ApprovalListItem) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["approvals"] });
    void qc.invalidateQueries({ queryKey: keys.summary });
    if (a.naive_session_id) void qc.invalidateQueries({ queryKey: keys.run(a.naive_session_id) });
  };
}

const aboutLead = (a: ApprovalListItem) => a.lead?.company ?? a.lead?.name ?? null;

// ---------- tool ----------

export function ToolDetail({ a, now, onDecided }: { a: ApprovalListItem; now: number; onDecided: OnDecided }) {
  const api = useApi();
  const invalidate = useInvalidate(a);
  const tool = toolNameOf(a) ?? "a tool";
  const [mode, setMode] = useState<"view" | "confirm" | "deny">("view");
  const [scope, setScope] = useState<"call" | "session">("call");
  const [reason, setReason] = useState("");
  const allow = useMutation({
    mutationFn: () => api.answer(a.code, { decision: "allow", scope }),
    onSuccess: () => onDecided(a.code, scope === "session" ? `Allowed ${tool} for the rest of this session.` : `Allowed this ${tool} call.`),
    onError: () => setMode("view"),
    onSettled: invalidate,
  });
  const deny = useMutation({
    mutationFn: () => api.answer(a.code, { decision: "deny", ...(reason.trim() ? { reason: reason.trim() } : {}) }),
    onSuccess: () => onDecided(a.code, `Denied ${tool}. The agent continues without it.`),
    onSettled: invalidate,
  });
  const busy = allow.isPending || deny.isPending;
  const pressAllow = () => {
    if (busy) return;
    if (mode === "confirm") allow.mutate();
    else setMode("confirm");
  };
  useDisarm(mode === "confirm", useCallback(() => setMode((m) => (m === "confirm" ? "view" : m)), []));
  useKeys({
    a: mode !== "deny" ? pressAllow : undefined,
    r: mode === "view" ? () => setMode("deny") : undefined,
    escape: mode !== "view" && !busy ? () => setMode("view") : undefined,
  });
  const args = (a.payload as { args?: unknown } | undefined)?.args;

  return (
    <>
      <DetailHead a={a} now={now} title={`Tool call: ${tool}`} aside={aboutLead(a)} />
      <BindingStrip>
        <Bound label="Tool">{tool}</Bound>
        {a.naive_session_id ? <Bound label="Session">{a.naive_session_id}</Bound> : null}
        {a.tool_call_id ? <Bound label="Call">{a.tool_call_id}</Bound> : null}
      </BindingStrip>
      <div className="flex min-h-0 grow flex-col gap-3 overflow-y-auto px-5 py-3.5">
        <div className="flex shrink-0 flex-col rounded-[10px] border border-[#200D0D1A]">
          <div className="flex items-baseline gap-2.5 border-b border-b-[#200D0D14] px-3.5 py-2.5">
            <div className="w-13 shrink-0 text-xs/4 font-medium text-muted">Tool</div>
            <div className="text-sm/5 font-semibold text-ink">{tool}</div>
          </div>
          <div className="flex items-baseline gap-2.5 px-3.5 pb-3 pt-2.5">
            <div className="w-13 shrink-0 text-xs/4 font-medium text-muted">Input</div>
            <pre className="min-w-0 grow whitespace-pre-wrap break-words font-sans text-[13px]/5 font-medium tabular-nums text-ink">
              {args === undefined ? "No input" : jsonText(args)}
            </pre>
          </div>
        </div>
        <section className="flex shrink-0 flex-col gap-2 rounded-[10px] border border-panel-line bg-panel px-3.5 py-3">
          <h3 className="text-[13px]/4 font-semibold text-ink">Why you are seeing this</h3>
          <p className="text-[13px]/4.75 font-medium text-ink">
            This call is outside your auto-confirm policy, so the agent paused until you decide. Allowing runs it; denying tells the agent to continue
            without it.
          </p>
          <fieldset className="flex items-center gap-2 pt-1">
            <legend className="sr-only">Allow for</legend>
            <span className="text-xs/4 font-medium text-muted">Allow for</span>
            {(
              [
                ["call", "This call only"],
                ["session", "The rest of this session"],
              ] as const
            ).map(([v, label]) => (
              <label
                key={v}
                className={cx(
                  "flex h-7 cursor-pointer items-center rounded-full border px-3 text-xs/4 font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-green",
                  scope === v ? "border-ink bg-white text-ink" : "border-[#200D0D1F] text-muted hover:text-ink",
                )}
              >
                <input type="radio" name={`scope-${a.code}`} value={v} checked={scope === v} onChange={() => setScope(v)} className="sr-only" />
                {label}
              </label>
            ))}
          </fieldset>
        </section>
      </div>
      <ActionBar
        error={allow.error ?? deny.error}
        note={
          mode === "confirm" ? (
            <>Press A or click again to allow {scope === "session" ? `${tool} for the rest of this session` : "this call"}.</>
          ) : (
            <>Tool calls nobody answers are denied automatically when the approval expires.</>
          )
        }
      >
        {mode === "deny" ? (
          <ReasonRow
            value={reason}
            onChange={setReason}
            onSubmit={() => deny.mutate()}
            onCancel={() => setMode("view")}
            loading={deny.isPending}
            submitLabel="Deny call"
            placeholder="Tell the agent why (optional)"
          />
        ) : (
          <>
            <ActionButton tone={mode === "confirm" ? "confirm" : "primary"} kbd="A" loading={allow.isPending} onClick={pressAllow}>
              {mode === "confirm" ? "Allow now?" : "Allow"}
            </ActionButton>
            <ActionButton tone="danger" kbd="R" onClick={() => setMode("deny")} disabled={busy}>
              Deny
            </ActionButton>
          </>
        )}
      </ActionBar>
    </>
  );
}

// ---------- question ----------

export function QuestionDetail({ a, now, onDecided }: { a: ApprovalListItem; now: number; onDecided: OnDecided }) {
  const api = useApi();
  const invalidate = useInvalidate(a);
  const { prompt, fields } = questionOf(a);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const filled = (v: string | string[] | undefined) => (Array.isArray(v) ? v.length > 0 : Boolean(v?.trim()));
  const complete = fields.length > 0 && fields.every((f) => filled(answers[f.key]));
  const send = useMutation({
    mutationFn: () =>
      api.answer(a.code, {
        answers: Object.fromEntries(fields.map((f) => [f.key, Array.isArray(answers[f.key]) ? answers[f.key]! : String(answers[f.key] ?? "").trim()])),
      }),
    onSuccess: () => onDecided(a.code, `Answer sent. The agent continues from here.`),
    onSettled: invalidate,
  });
  const submit = () => {
    if (complete && !send.isPending) send.mutate();
  };
  useKeys({ a: complete ? submit : undefined });

  return (
    <>
      <DetailHead a={a} now={now} title="Question from the agent" aside={aboutLead(a)} />
      <BindingStrip>
        {a.naive_session_id ? <Bound label="Session">{a.naive_session_id}</Bound> : null}
        {a.tool_call_id ? <Bound label="Call">{a.tool_call_id}</Bound> : null}
        <Bound label="Fields">{fields.length}</Bound>
      </BindingStrip>
      <form
        className="flex min-h-0 grow flex-col gap-3 overflow-y-auto px-5 py-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        id={`answer-${a.code}`}
      >
        <div className="flex shrink-0 flex-col rounded-[10px] border border-[#200D0D1A]">
          <div className="border-b border-b-[#200D0D14] px-3.5 py-2.5">
            <p className="whitespace-pre-wrap break-words text-sm/5 font-semibold text-ink">{prompt}</p>
          </div>
          <div className="flex flex-col gap-4 px-3.5 pb-4 pt-3">
            {fields.length ? (
              fields.map((f) => (
                <Field key={f.key} field={f} value={answers[f.key]} onChange={(v) => setAnswers((prev) => ({ ...prev, [f.key]: v }))} />
              ))
            ) : (
              <p className="text-[13px]/5 font-medium text-muted">The agent did not send any fields to answer. It may ask again with a new code.</p>
            )}
          </div>
        </div>
      </form>
      <ActionBar error={send.error} note={<>Your answers go straight to the agent&rsquo;s session; it continues from there.</>}>
        <ActionButton tone="primary" kbd="A" type="submit" form={`answer-${a.code}`} loading={send.isPending} disabled={!complete}>
          Send answer
        </ActionButton>
        {!complete && fields.length ? <span className="pl-1 text-xs/4 font-medium text-muted">Answer every field to send.</span> : null}
      </ActionBar>
    </>
  );
}

function Field({ field: f, value, onChange }: { field: QuestionField; value: string | string[] | undefined; onChange: (v: string | string[]) => void }) {
  const id = `field-${f.key}`;
  if (f.options.length) {
    const selected = Array.isArray(value) ? value : value ? [value] : [];
    const toggle = (o: string) => {
      if (!f.multiple) return onChange(o);
      onChange(selected.includes(o) ? selected.filter((x) => x !== o) : [...selected, o]);
    };
    return (
      <fieldset className="flex flex-col gap-2">
        <legend className="pb-2 text-[13px]/4 font-medium text-ink">
          {f.label}
          {f.multiple ? <span className="text-muted"> · pick any</span> : null}
        </legend>
        <div className="flex flex-wrap gap-2">
          {f.options.map((o) => {
            const on = selected.includes(o);
            return (
              <label
                key={o}
                className={cx(
                  "flex h-8 cursor-pointer items-center rounded-full border px-3.5 text-[13px]/4 font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-green",
                  on ? "border-ink bg-white text-ink" : "border-[#200D0D1F] text-muted hover:text-ink",
                )}
              >
                <input type={f.multiple ? "checkbox" : "radio"} name={id} value={o} checked={on} onChange={() => toggle(o)} className="sr-only" />
                {o}
              </label>
            );
          })}
        </div>
      </fieldset>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-[13px]/4 font-medium text-ink">
        {f.label}
      </label>
      <textarea
        id={id}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        maxLength={4000}
        rows={3}
        className="resize-y rounded-[10px] border border-[#200D0D26] px-3 py-2 text-sm/5 font-medium text-ink outline-none [field-sizing:content] focus:border-[#200D0D59]"
      />
    </div>
  );
}
