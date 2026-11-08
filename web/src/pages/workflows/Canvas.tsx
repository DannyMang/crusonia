// The builder canvas (Paper: "Final · Workflows · Builder" > Canvas): a pannable dot grid with the steps, a "+"
// on each connector and one after the last step that open the step menu, and zoom − / 100% / + / Fit.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { FlowStep, StepKind } from "../../api/workflows.ts";
import { cx } from "../../lib/format.ts";
import { appendAfter, canRemove, insertOnEdge, KIND_LABEL, layout, MENU, NODE_H, NODE_W, removeStep, renameStep } from "./layout.ts";

/** Default workflows store provider ids; templates store names. */
const PROVIDER_LABEL: Record<string, string> = { apify: "Apify", naive: "Naive", agentmail: "AgentMail", hubspot: "HubSpot", notion: "Notion" };

type View = { x: number; y: number; k: number };
type MenuAt = { x: number; y: number; insert: { parent: string; child: string } | { after: string } };

const MIN_K = 0.5;
const MAX_K = 1.5;
const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, Math.round(k * 100) / 100));

export function Canvas({ steps, onChange, className }: { steps: FlowStep[]; onChange: (steps: FlowStep[]) => void; className?: string }) {
  const lay = useMemo(() => layout(steps), [steps]);
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; ratio: number } | null>(null);

  // CSS px per pointer px: the app renders at 80% (`zoom` on <html>), so pointer deltas are scaled to match.
  const ratio = () => {
    const el = box.current;
    if (!el) return 1;
    const w = el.getBoundingClientRect().width;
    return w ? el.offsetWidth / w : 1;
  };

  const fit = () => {
    const el = box.current;
    if (!el) return;
    const k = clampK(Math.min(el.clientWidth / lay.width, el.clientHeight / lay.height, 1.25));
    setView({ k, x: Math.round((el.clientWidth - lay.width * k) / 2), y: Math.round((el.clientHeight - lay.height * k) / 2) });
  };
  const zoomBy = (d: number) => {
    const el = box.current;
    setView((v) => {
      const k = clampK(v.k + d);
      if (!el) return { ...v, k };
      // Keep the canvas centre still.
      const cx = el.clientWidth / 2;
      const cy = el.clientHeight / 2;
      return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
    });
  };

  // Start fitted when the flow is larger than the canvas (narrow windows); otherwise at 100% like the design.
  const fitted = useRef(false);
  useLayoutEffect(() => {
    if (fitted.current || !box.current || !lay.nodes.length) return;
    fitted.current = true;
    if (lay.width > box.current.clientWidth || lay.height > box.current.clientHeight) fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lay]);

  // Wheel pans; ctrl / ⌘ + wheel (and pinch) zooms. Non-passive so the page does not scroll underneath.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = ratio();
      if (e.ctrlKey || e.metaKey) zoomBy(-e.deltaY * 0.01);
      else setView((v) => ({ ...v, x: v.x - e.deltaX * r, y: v.y - e.deltaY * r }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [menu]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("[data-no-pan]")) return;
    setMenu(null);
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, ratio: ratio() };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x) * d.ratio, y: d.vy + (e.clientY - d.y) * d.ratio }));
  };
  const endDrag = () => {
    drag.current = null;
  };

  const choose = (kind: StepKind) => {
    if (!menu) return;
    onChange("after" in menu.insert ? appendAfter(steps, menu.insert.after, kind) : insertOnEdge(steps, menu.insert.parent, menu.insert.child, kind));
    setMenu(null);
  };

  const isOpen = (x: number, y: number) => menu !== null && menu.x === x && menu.y === y;
  const dot = 18 * view.k;

  return (
    <div
      ref={box}
      role="application"
      aria-label="Workflow canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className={cx("relative h-155 cursor-grab touch-none select-none overflow-hidden rounded-xl border border-[#200D0D1A] bg-white active:cursor-grabbing", className)}
      style={{
        backgroundImage: "radial-gradient(circle, rgba(32,13,13,0.16) 1px, transparent 1.2px)",
        backgroundSize: `${dot}px ${dot}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
    >
      <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, width: lay.width, height: lay.height }}>
        <svg width={lay.width} height={lay.height} className="pointer-events-none absolute left-0 top-0" aria-hidden>
          {lay.edges.map((e) => (
            <path key={`${e.from}-${e.to}`} d={e.path} fill="none" stroke="#200D0D59" strokeWidth="1.5" />
          ))}
          {lay.after ? <path d={lay.after.path} fill="none" stroke="#200D0D40" strokeWidth="1" /> : null}
        </svg>

        {lay.edges.map((e) =>
          e.label ? (
            <div key={`l-${e.from}-${e.to}`} className="pointer-events-none absolute whitespace-nowrap text-xs/4 font-medium text-muted" style={{ left: e.label.x, top: e.label.y }}>
              {e.label.text}
            </div>
          ) : null,
        )}

        {lay.nodes.map((n) => (
          <StepNode
            key={n.step.id}
            step={n.step}
            x={n.x}
            y={n.y}
            editing={editing === n.step.id}
            onEdit={() => setEditing(n.step.id)}
            onRename={(title) => {
              setEditing(null);
              if (title.trim() && title.trim() !== n.step.title) onChange(renameStep(steps, n.step.id, title.trim()));
            }}
            onRemove={canRemove(n.step) ? () => onChange(removeStep(steps, n.step.id)) : undefined}
          />
        ))}

        {lay.edges.map((e) =>
          e.plus ? (
            <PlusButton
              key={`p-${e.from}-${e.to}`}
              x={e.plus.x}
              y={e.plus.y}
              size={20}
              open={isOpen(e.plus.x, e.plus.y)}
              label="Add a step here"
              onClick={() => setMenu(isOpen(e.plus!.x, e.plus!.y) ? null : { x: e.plus!.x, y: e.plus!.y, insert: { parent: e.from, child: e.to } })}
            />
          ) : null,
        )}
        {lay.after ? (
          <PlusButton
            x={lay.after.x}
            y={lay.after.y}
            size={24}
            open={isOpen(lay.after.x, lay.after.y)}
            label="Add a step"
            onClick={() => setMenu(isOpen(lay.after!.x, lay.after!.y) ? null : { x: lay.after!.x, y: lay.after!.y, insert: { after: lay.after!.stepId } })}
          />
        ) : null}

        {menu ? <StepMenu x={menu.x - 56} y={menu.y + 42} onChoose={choose} /> : null}
      </div>

      <div data-no-pan className="absolute bottom-4 right-4 flex cursor-default items-center gap-0.5 rounded-[10px] border border-[#200D0D1A] bg-white p-1 shadow-[0_2px_8px_#200D0D14]">
        <ZoomButton label="Zoom out" onClick={() => zoomBy(-0.1)}>
          <path d="M2.5 6h7" fill="none" stroke="#200D0D" strokeWidth="1.6" strokeLinecap="round" />
        </ZoomButton>
        <button type="button" onClick={() => setView({ x: 0, y: 0, k: 1 })} title="Reset to 100%" className="h-7 w-11 shrink-0 rounded-md text-center text-xs/4 font-medium tabular-nums text-ink hover:bg-[#200D0D08]">
          {Math.round(view.k * 100)}%
        </button>
        <ZoomButton label="Zoom in" onClick={() => zoomBy(0.1)}>
          <path d="M6 2.5v7M2.5 6h7" fill="none" stroke="#200D0D" strokeWidth="1.6" strokeLinecap="round" />
        </ZoomButton>
        <span className="h-4.5 w-px shrink-0 bg-[#200D0D14]" />
        <button type="button" onClick={fit} className="flex h-7 items-center rounded-md px-2 text-xs/4 font-medium text-ink hover:bg-[#200D0D08]">
          Fit
        </button>
      </div>
    </div>
  );
}

function ZoomButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-[#200D0D08]">
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
        {children}
      </svg>
    </button>
  );
}

function StepNode({
  step,
  x,
  y,
  editing,
  onEdit,
  onRename,
  onRemove,
}: {
  step: FlowStep;
  x: number;
  y: number;
  editing: boolean;
  onEdit: () => void;
  onRename: (title: string) => void;
  onRemove?: () => void;
}) {
  const approval = step.kind === "approval";
  return (
    <div
      data-no-pan
      onDoubleClick={onEdit}
      className={cx(
        "group absolute flex cursor-default flex-col justify-center gap-0.5 rounded-[10px] bg-white px-3 shadow-[0_2px_8px_#200D0D14,0_1px_2px_#200D0D0F]",
        approval ? "border-[1.5px] border-ink" : "border border-[#200D0D33]",
      )}
      style={{ left: x, top: y, width: NODE_W, height: NODE_H }}
    >
      <div className={cx("truncate text-[11px]/3.5", approval ? "font-semibold text-ink" : "font-medium text-muted")}>{(step.provider && PROVIDER_LABEL[step.provider]) || step.provider || KIND_LABEL[step.kind]}</div>
      {editing ? (
        <input
          autoFocus
          defaultValue={step.title}
          aria-label="Step name"
          onBlur={(e) => onRename(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") onRename(step.title);
          }}
          className="-mx-1 h-5 rounded border border-[#200D0D33] px-1 text-[13px]/4.25 font-medium text-ink outline-none"
        />
      ) : (
        <div className="line-clamp-2 text-[13px]/4.25 font-medium text-ink" title={step.title}>
          {step.title}
        </div>
      )}
      {onRemove && !editing ? (
        <button
          type="button"
          aria-label={`Remove ${step.title}`}
          onClick={onRemove}
          className="absolute -right-2 -top-2 hidden size-5 items-center justify-center rounded-full border border-[#200D0D33] bg-white group-hover:flex focus-visible:flex"
        >
          <svg width="8" height="8" viewBox="0 0 12 12" aria-hidden>
            <path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="#200D0D" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

function PlusButton({ x, y, size, open, label, onClick }: { x: number; y: number; size: number; open: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      data-no-pan
      aria-label={label}
      aria-expanded={open}
      aria-haspopup="menu"
      onClick={onClick}
      className={cx("absolute flex items-center justify-center rounded-full transition-colors", open ? "bg-ink" : "border border-[#200D0D33] bg-white hover:border-ink")}
      style={{ left: x - size / 2, top: y - size / 2, width: size, height: size }}
    >
      <svg width={size > 20 ? 11 : 10} height={size > 20 ? 11 : 10} viewBox="0 0 10 10" aria-hidden>
        <path d="M5 1.5v7M1.5 5h7" fill="none" stroke={open ? "#FFFFFF" : "#200D0D"} strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
  );
}

const MENU_ICONS: Record<string, ReactNode> = {
  find: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </>
  ),
  research: (
    <>
      <path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z" />
      <path d="M14 3v6h6M8 13h8M8 17h5" />
    </>
  ),
  draft: <path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4 12.5-12.5z" />,
  approval: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.5 2.5L16 9.5" />
    </>
  ),
  notify: <path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0" />,
  sync_crm: <path d="M21 12a9 9 0 01-15.36 6.36L3 16M3 12a9 9 0 0115.36-6.36L21 8M21 3v5h-5M3 21v-5h5" />,
};

function StepMenu({ x, y, onChoose }: { x: number; y: number; onChoose: (kind: StepKind) => void }) {
  const first = useRef<HTMLButtonElement>(null);
  // Focus starts on the first item; when the menu closes (Esc, a choice) it goes back to the "+" that opened it.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    first.current?.focus();
    return () => {
      if (opener?.isConnected && (!document.activeElement || document.activeElement === document.body)) opener.focus();
    };
  }, []);
  return (
    <div
      data-no-pan
      role="menu"
      aria-label="Add a step"
      className="absolute z-10 flex w-42 cursor-default flex-col rounded-xl border border-[#200D0D1A] bg-white p-1.5 shadow-[0_12px_32px_#200D0D24,0_2px_6px_#200D0D0F]"
      style={{ left: x, top: y }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }}
    >
      {MENU.map((group, g) => (
        <div key={g} className={cx("flex flex-col", g > 0 && "mt-1 border-t border-t-[#200D0D14] pt-1")}>
          {group.map((item, i) => (
            <button
              key={item.kind}
              ref={g === 0 && i === 0 ? first : undefined}
              type="button"
              role="menuitem"
              onClick={() => onChoose(item.kind)}
              className="flex h-8.5 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm/4.5 font-medium text-ink outline-none hover:bg-panel focus-visible:bg-panel"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden fill="none" stroke="#200D0D" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                {MENU_ICONS[item.kind]}
              </svg>
              {item.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
