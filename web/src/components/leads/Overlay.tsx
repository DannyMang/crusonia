// Modal dialog (native <dialog>, so focus trapping, Escape and the top layer come from the browser) and a
// small anchored dropdown with outside-click / Escape dismissal. Used by the Leads and Lead detail screens.
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { cx } from "../../lib/format.ts";
import { CheckIcon, XIcon } from "../icons.tsx";

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      // A click on the backdrop lands on the <dialog> element itself.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className={cx(
        "m-auto max-h-[min(720px,90vh)] w-[480px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-xl border border-[#200D0D1A] bg-white p-0 text-xs/4 text-ink shadow-[0_24px_64px_-16px_rgb(32_13_13/35%)] backdrop:bg-[#200D0D47]",
        className,
      )}
    >
      {open ? (
        <div className="flex flex-col">
          <div className="flex items-start justify-between gap-4 px-5 pb-3 pt-4.5">
            <div className="flex flex-col gap-1">
              <h2 id={titleId} className="text-[15px]/4.5 font-semibold tracking-[-0.01em] text-ink">
                {title}
              </h2>
              {description ? <div className="text-[13px]/5 font-medium text-muted">{description}</div> : null}
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="-mr-1.5 flex size-7 shrink-0 items-center justify-center rounded-full text-faint hover:bg-[#200D0D0A]"
            >
              <XIcon />
            </button>
          </div>
          {children ? <div className="flex flex-col gap-3.5 px-5 pb-4">{children}</div> : null}
          {footer ? (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-t-[#200D0D14] bg-[#200D0D06] px-5 py-3">{footer}</div>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}

/** Wraps a trigger and renders `children` in a panel below it while `open`. */
export function Dropdown({
  open,
  onClose,
  trigger,
  children,
  align = "left",
  className,
}: {
  open: boolean;
  onClose: () => void;
  trigger: ReactNode;
  children: ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // Keep the panel inside the window: on a phone, a menu anchored to a button near either edge would hang off it
  // and scroll the page sideways. Rects are in window pixels; `translate` is in the zoomed page's CSS pixels.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!open || !el) return;
    el.style.translate = "";
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const shift = r.right > vw - 8 ? vw - 8 - r.right : r.left < 8 ? 8 - r.left : 0;
    if (!shift) return;
    const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    el.style.translate = `${shift / zoom}px 0`;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  return (
    <div ref={ref} className="relative">
      {trigger}
      {open ? (
        <div
          ref={panel}
          className={cx(
            "absolute top-full z-30 mt-1.5 flex min-w-48 flex-col rounded-[10px] border border-[#200D0D1A] bg-white p-1 shadow-[0_12px_32px_-8px_rgb(32_13_13/22%)]",
            align === "right" ? "right-0" : "left-0",
            className,
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** A row inside a Dropdown. `checked` renders it as a radio-style option. */
export function MenuItem({
  onSelect,
  checked,
  children,
  hint,
  role = checked === undefined ? "menuitem" : "menuitemradio",
}: {
  onSelect: () => void;
  checked?: boolean;
  children: ReactNode;
  hint?: ReactNode;
  role?: string;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={checked}
      onClick={onSelect}
      className="flex w-full items-start gap-2 rounded-md px-2.5 py-1.75 text-left hover:bg-[#200D0D08]"
    >
      <span className="flex min-w-0 grow flex-col items-start gap-0.5">
        <span className="text-[13px]/4 font-medium text-ink">{children}</span>
        {hint ? <span className="text-xs/4 font-medium text-muted">{hint}</span> : null}
      </span>
      {checked ? <CheckIcon className="mt-0.5 text-green" /> : null}
    </button>
  );
}

/** Labeled form field used by the leads dialogs. */
export function Field({ label, hint, children, required }: { label: string; hint?: ReactNode; children: ReactNode; required?: boolean }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px]/4 font-medium text-ink">
        {label}
        {required ? <span className="text-muted"> · required</span> : null}
      </span>
      {children}
      {hint ? <span className="text-xs/4 font-medium text-muted">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  "h-9 w-full rounded-[10px] border border-[#200D0D1A] bg-white px-3 text-[13px]/4 font-medium text-ink placeholder:font-normal placeholder:text-[#200D0D73] focus:border-ink focus:outline-none";
export const textareaClass =
  "w-full rounded-[10px] border border-[#200D0D1A] bg-white px-3 py-2.5 text-[13px]/5 font-medium text-ink placeholder:font-normal placeholder:text-[#200D0D73] focus:border-ink focus:outline-none";
