// The builder's right panel (Paper: "Final · Workflows · Builder" > Qualification panel): ideal customer from the
// Company summary, research questions, evidence required, done-when, a label and "Save as version N".
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { Qualification } from "../../api/workflows.ts";
import { Spinner } from "../../components/icons.tsx";
import { cx } from "../../lib/format.ts";
import { COMPANY_SUMMARY_PATH } from "./parts.tsx";

const X = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    <path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="rgb(32 13 13 / 50%)" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);
const Plus = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="shrink-0">
    <path d="M6 2.5v7M2.5 6h7" fill="none" stroke="#200D0D" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const Section = ({ label, children, last }: { label: string; children: ReactNode; last?: boolean }) => (
  <div className={cx("flex flex-col gap-1.5 px-4.5 py-3.5", !last && "border-b border-b-[#200D0D14]")}>
    <div className="text-xs/4 font-medium text-muted">{label}</div>
    {children}
  </div>
);

function ListEditor({ items, onChange, addLabel, itemLabel }: { items: string[]; onChange: (items: string[]) => void; addLabel: string; itemLabel: string }) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const commit = () => {
    const t = text.trim();
    if (t) onChange([...items, t]);
    setText("");
    setAdding(false);
  };
  return (
    <>
      {items.map((it, i) => (
        <div key={`${i}-${it}`} className={cx("flex min-h-8 items-center justify-between gap-2", i > 0 && "border-t border-t-[#200D0D0F]")}>
          <div className="py-1.5 text-[13px]/4.5 text-ink">{it}</div>
          <button type="button" aria-label={`Remove ${itemLabel}: ${it}`} onClick={() => onChange(items.filter((_, j) => j !== i))} className="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-[#200D0D08]">
            <X />
          </button>
        </div>
      ))}
      {adding ? (
        <input
          autoFocus
          value={text}
          aria-label={addLabel}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setText("");
              setAdding(false);
            }
          }}
          className="h-8 rounded-lg border border-[#200D0D33] px-2.5 text-[13px]/4 text-ink outline-none focus:border-ink"
        />
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-1.5 self-start pt-0.5 text-[13px]/4 font-medium text-ink hover:underline">
          <Plus />
          {addLabel}
        </button>
      )}
    </>
  );
}

export function QualificationPanel({
  value,
  onChange,
  version,
  nextVersion,
  label,
  onLabel,
  canSave,
  saving,
  onSave,
}: {
  value: Qualification;
  onChange: (q: Qualification) => void;
  /** The version shown (null for a workflow not saved yet). */
  version: number | null;
  nextVersion: number;
  label: string;
  onLabel: (label: string) => void;
  canSave: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  return (
    <aside aria-label="Qualification" className="flex w-full shrink-0 flex-col rounded-xl border border-[#200D0D1A] bg-white lg:w-85">
      <div className="flex items-center justify-between border-b border-b-[#200D0D14] px-4.5 py-4">
        <h2 className="text-[15px]/4.5 font-semibold text-ink">Qualification</h2>
        {version !== null ? <span className="flex h-5.5 items-center rounded-full bg-pill px-2 text-xs/4 font-medium text-ink">v{version}</span> : null}
      </div>

      <Section label="Ideal customer">
        <div className="flex h-9 shrink-0 items-center justify-between rounded-lg border border-[#200D0D1A] px-3">
          <span className="text-[13px]/4 font-medium text-ink">From Company summary</span>
          <Link to={COMPANY_SUMMARY_PATH} className="text-xs/4 font-medium text-ink underline decoration-1 underline-offset-2">
            Settings
          </Link>
        </div>
      </Section>

      <Section label="Research questions">
        <ListEditor items={value.research_questions} onChange={(research_questions) => onChange({ ...value, research_questions })} addLabel="Add question" itemLabel="question" />
      </Section>

      <Section label="Evidence required">
        <ListEditor items={value.evidence_required} onChange={(evidence_required) => onChange({ ...value, evidence_required })} addLabel="Add requirement" itemLabel="requirement" />
      </Section>

      <Section label="Done when">
        <textarea
          value={value.done_when}
          aria-label="Done when"
          rows={1}
          onChange={(e) => onChange({ ...value, done_when: e.target.value })}
          className="field-sizing-content min-h-9 resize-none rounded-lg border border-[#200D0D1A] px-3 py-2 text-[13px]/4.5 text-ink outline-none focus:border-ink"
        />
      </Section>

      <div className="flex flex-col gap-2.5 px-4.5 pb-4.5 pt-3.5">
        <input
          value={label}
          aria-label="Version label"
          placeholder="Version label"
          onChange={(e) => onLabel(e.target.value)}
          className="h-9 shrink-0 rounded-lg border border-[#200D0D1A] px-3 text-[13px]/4 text-ink outline-none placeholder:text-faint focus:border-ink"
        />
        <button
          type="button"
          disabled={!canSave || saving}
          onClick={onSave}
          className="flex h-9.5 shrink-0 items-center justify-center gap-2 rounded-full bg-lime text-sm/4.5 font-semibold text-ink transition-colors hover:bg-[#b3de7a] disabled:opacity-60"
        >
          {saving ? <Spinner size={12} /> : null}
          Save as version {nextVersion}
        </button>
      </div>
    </aside>
  );
}
