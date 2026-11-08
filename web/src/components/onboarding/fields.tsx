// Inputs for the editable profile (step 3). They look like the static text in the design until you hover or
// focus them ("Click anything to edit it").
import { forwardRef, useLayoutEffect, useRef, useState, type InputHTMLAttributes, type Ref, type TextareaHTMLAttributes } from "react";
import { cx } from "../../lib/format.ts";
import { WhiteCheck } from "./ui.tsx";

/** Focus treatment shared by every editable field: ink outline plus a soft lime ring, like step 1's input. */
export const focusRing = "focus-visible:outline-none focus:outline-none focus:[box-shadow:0_0_0_1px_#200D0D,0_0_0_4px_#BDE68966]";

/** Text that edits in place: no border until hovered, sized to its content where the browser allows. When a narrow
 *  window cuts a long value short (a segment name on a phone), it ends in an ellipsis instead of mid-letter. */
export const InlineInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function InlineInput({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      spellCheck={false}
      className={cx("-mx-1 min-w-0 text-ellipsis rounded-md bg-transparent px-1 text-ink placeholder:font-medium placeholder:text-[#200D0D4D] hover:bg-[#200D0D08] [field-sizing:content]", focusRing, className)}
      {...rest}
    />
  );
});

/** Textarea that grows with its text (no inner scrollbar). */
export function AutoTextarea({ value, className, ref, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string; ref?: Ref<HTMLTextAreaElement> }) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  const setRef = (el: HTMLTextAreaElement | null) => {
    inner.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) ref.current = el;
  };
  return <textarea ref={setRef} rows={1} value={value} className={cx("block w-full resize-none overflow-hidden bg-transparent outline-none focus-visible:outline-none", className)} {...rest} />;
}

/** The design's boxed field (company size, industry): 34px, hairline border. */
export function BoxInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        "h-8.5 w-full shrink-0 rounded-lg border border-[#200D0D1A] bg-white px-2.5 text-[13px]/4 font-medium text-ink placeholder:text-[#200D0D4D] hover:border-[#200D0D33]",
        focusRing,
        className,
      )}
      {...rest}
    />
  );
}

/** Roles as gray chips; type and press Enter (or comma) to add one, Backspace on an empty input removes the last. */
export function RolesInput({ id, roles, onChange }: { id: string; roles: string[]; onChange: (roles: string[]) => void }) {
  const [text, setText] = useState("");
  const add = (raw: string) => {
    const parts = raw
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean)
      .filter((r) => !roles.some((x) => x.toLowerCase() === r.toLowerCase()));
    if (parts.length) onChange([...roles, ...parts]);
    setText("");
  };
  return (
    <div className="flex min-h-8.5 shrink-0 flex-wrap items-center gap-1.5 rounded-lg border border-[#200D0D1A] px-1.5 py-1 hover:border-[#200D0D33] focus-within:border-ink focus-within:[box-shadow:#BDE68966_0px_0px_0px_3px]">
      {roles.map((r, i) => (
        <span key={`${r}-${i}`} className="group flex h-5.5 items-center gap-1 rounded-full bg-pill px-2 text-xs/4 font-medium text-ink">
          {r}
          <button
            type="button"
            aria-label={`Remove ${r}`}
            onClick={() => onChange(roles.filter((_, j) => j !== i))}
            className="-mr-1 hidden size-4 items-center justify-center rounded-full text-faint hover:bg-[#200D0D14] hover:text-ink group-hover:flex"
          >
            <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
              <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
        </span>
      ))}
      <input
        id={id}
        value={text}
        placeholder={roles.length ? "" : "Add a role, press Enter"}
        onChange={(e) => {
          const v = e.target.value;
          if (v.includes(",")) add(v);
          else setText(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(text);
          } else if (e.key === "Backspace" && !text && roles.length) {
            onChange(roles.slice(0, -1));
          }
        }}
        onBlur={() => text.trim() && add(text)}
        className="h-5.5 min-w-6 grow basis-6 bg-transparent px-1 text-xs/4 font-medium text-ink outline-none placeholder:text-[#200D0D4D] focus-visible:outline-none"
      />
    </div>
  );
}

/** 18px ink checkbox from the design (checked = ink fill with a white tick). */
export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx(
        "mt-px flex size-4.5 shrink-0 items-center justify-center rounded-[5px] transition-colors",
        checked ? "bg-ink hover:bg-[#3a2424]" : "border-[1.5px] border-[#200D0D40] bg-white hover:border-[#200D0D80]",
      )}
    >
      {checked ? <WhiteCheck size={10} /> : null}
    </button>
  );
}
