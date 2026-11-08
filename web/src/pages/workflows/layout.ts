// Canvas layout and edits for the workflow builder (Paper: "Final · Workflows · Builder" > Canvas). Pure, so
// `bun test` covers it (test/web-flow-layout.test.ts).
// Layout: the trigger and the steps after it run left to right on the first row; after a step with several
// children (a condition, an approval) everything goes down. Children of a branching step sit on the next row,
// the last one under its parent and the others to its left, in `next` order.
import type { FlowStep, StepKind } from "../../api/flow-types.ts";

export const NODE_W = 146;
export const NODE_H = 64;
export const COL_W = 174; // node + 28px connector
export const PAD_X = 16;
export const PAD_Y = 40;

export type PlacedNode = { step: FlowStep; col: number; row: number; x: number; y: number };
export type Edge = {
  from: string;
  to: string;
  path: string;
  /** Where the "+" sits (centre), or null for an approval's fixed outcomes. */
  plus: { x: number; y: number } | null;
  label: { text: string; x: number; y: number } | null;
};
export type Layout = { nodes: PlacedNode[]; edges: Edge[]; after: { stepId: string; path: string; x: number; y: number } | null; width: number; height: number };

const PRIMARY = new Set(["yes", "approved"]);

export function rootOf(steps: FlowStep[]): FlowStep | undefined {
  const targets = new Set(steps.flatMap((s) => s.next));
  return steps.find((s) => s.kind === "trigger") ?? steps.find((s) => !targets.has(s.id)) ?? steps[0];
}

export function layout(steps: FlowStep[]): Layout {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const pos = new Map<string, { col: number; row: number; parent: string | null }>();
  const taken = new Set<string>();
  const key = (c: number, r: number) => `${c}:${r}`;

  const place = (id: string, col: number, row: number, flat: boolean, parent: string | null) => {
    if (pos.has(id) || !byId.has(id)) return;
    while (taken.has(key(col, row))) row++;
    taken.add(key(col, row));
    pos.set(id, { col, row, parent });
    const kids = byId.get(id)!.next.filter((k) => byId.has(k) && !pos.has(k));
    if (kids.length === 1) place(kids[0]!, flat ? col + 1 : col, flat ? row : row + 1, flat, id);
    else kids.forEach((k, i) => place(k, col - (kids.length - 1) + i, row + 1, false, id));
  };
  const root = rootOf(steps);
  if (root) place(root.id, 0, 0, true, null);
  // Anything unreachable from the root goes on its own rows at the bottom.
  for (const s of steps) if (!pos.has(s.id)) place(s.id, 0, Math.max(0, ...[...pos.values()].map((p) => p.row)) + 1, true, null);

  const minCol = Math.min(0, ...[...pos.values()].map((p) => p.col));
  const maxRow = Math.max(0, ...[...pos.values()].map((p) => p.row));
  // A row's top: 76px below the row above, 86px below an approval's row (its outcome labels need room).
  const rowY: number[] = [PAD_Y];
  for (let r = 1; r <= maxRow; r++) {
    const fromApproval = [...pos.entries()].some(([id, p]) => p.row === r - 1 && byId.get(id)!.kind === "approval");
    rowY[r] = rowY[r - 1]! + NODE_H + (fromApproval ? 86 : 76);
  }

  const nodes: PlacedNode[] = steps
    .filter((s) => pos.has(s.id))
    .map((s) => {
      const p = pos.get(s.id)!;
      const col = p.col - minCol;
      return { step: s, col, row: p.row, x: PAD_X + col * COL_W, y: rowY[p.row]! };
    });
  const at = new Map(nodes.map((n) => [n.step.id, n]));

  const edges: Edge[] = [];
  for (const parent of nodes) {
    const kids = parent.step.next.map((k) => at.get(k)).filter((n): n is PlacedNode => Boolean(n));
    const fixed = parent.step.kind === "approval";
    for (const child of kids) {
      const pcx = parent.x + NODE_W / 2;
      const ccx = child.x + NODE_W / 2;
      const branchy = kids.length > 1 || child.step.branch;
      if (child.row === parent.row) {
        const x1 = parent.x + NODE_W;
        const y = parent.y + NODE_H / 2;
        edges.push({ from: parent.step.id, to: child.step.id, path: `M${x1} ${y}H${child.x}`, plus: { x: (x1 + child.x) / 2, y }, label: null });
      } else if (!branchy && child.col === parent.col) {
        const y1 = parent.y + NODE_H;
        edges.push({ from: parent.step.id, to: child.step.id, path: `M${pcx} ${y1}V${child.y}`, plus: { x: pcx, y: (y1 + child.y) / 2 }, label: null });
      } else {
        const y1 = parent.y + NODE_H;
        const mid = y1 + (fixed ? 36 : 38);
        const path = ccx === pcx ? `M${pcx} ${y1}V${child.y}` : `M${pcx} ${y1}V${mid}H${ccx}V${child.y}`;
        const text = child.step.branch ?? null;
        edges.push({
          from: parent.step.id,
          to: child.step.id,
          path,
          plus: fixed ? null : { x: ccx, y: (mid + child.y) / 2 },
          label: text ? { text, x: ccx + (fixed ? 8 : 16), y: mid + (fixed ? 12 : 8) } : null,
        });
      }
    }
  }

  // The "+" after the last step of the main path (yes / approved / the only child).
  let after: Layout["after"] = null;
  let cur = root ? at.get(root.id) : undefined;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.step.id)) {
    seen.add(cur.step.id);
    const kids = cur.step.next.map((k) => at.get(k)).filter((n): n is PlacedNode => Boolean(n));
    if (!kids.length) break;
    cur = kids.find((k) => PRIMARY.has(k.step.branch ?? "")) ?? kids.find((k) => !k.step.branch) ?? kids[0];
  }
  if (cur && cur.step.kind !== "end") {
    if (cur.row === 0) {
      const x1 = cur.x + NODE_W;
      const y = cur.y + NODE_H / 2;
      after = { stepId: cur.step.id, path: `M${x1} ${y}H${x1 + 28}`, x: x1 + 40, y };
    } else {
      const cx = cur.x + NODE_W / 2;
      const y1 = cur.y + NODE_H;
      after = { stepId: cur.step.id, path: `M${cx} ${y1}V${y1 + 32}`, x: cx, y: y1 + 44 };
    }
  }

  const width = Math.max(...nodes.map((n) => n.x + NODE_W), after ? after.x + 12 : 0) + PAD_X;
  const height = Math.max(...nodes.map((n) => n.y + NODE_H), after ? after.y + 12 : 0) + 24;
  return { nodes, edges, after, width, height };
}

// ---------- edits ----------

/** The step menu (icon + one word). */
export const MENU: { kind: StepKind; label: string }[][] = [
  [
    { kind: "find", label: "Find" },
    { kind: "research", label: "Research" },
    { kind: "draft", label: "Draft" },
  ],
  [
    { kind: "approval", label: "Approval" },
    { kind: "notify", label: "Notify" },
    { kind: "sync_crm", label: "Sync CRM" },
  ],
];

const DEFAULTS: Partial<Record<StepKind, { title: string; provider: string }>> = {
  find: { title: "Find leads", provider: "Apify · $0.40 cap" },
  research: { title: "Research, score", provider: "Researcher" },
  draft: { title: "Draft email", provider: "Drafter" },
  approval: { title: "Wait for me", provider: "Approval · 48h" },
  notify: { title: "Text me", provider: "Photon iMessage" },
  sync_crm: { title: "Update HubSpot", provider: "Sync CRM" },
};

/** Small label above a step's title. */
export const KIND_LABEL: Record<StepKind, string> = {
  trigger: "Trigger",
  find: "Find",
  research: "Researcher",
  condition: "Condition",
  draft: "Drafter",
  tasks: "Tasks",
  approval: "Approval",
  notify: "Notify",
  sync_crm: "Sync CRM",
  send: "Send",
  end: "End",
};

function newStep(steps: FlowStep[], kind: StepKind): FlowStep {
  const ids = new Set(steps.map((s) => s.id));
  let n = steps.length + 1;
  while (ids.has(`s${n}`)) n++;
  const d = DEFAULTS[kind] ?? { title: KIND_LABEL[kind], provider: KIND_LABEL[kind] };
  return { id: `s${n}`, kind, title: d.title, provider: d.provider, branch: null, next: [] };
}

/** A new step on the connector parent -> child; it takes over the child's branch label. */
export function insertOnEdge(steps: FlowStep[], parentId: string, childId: string, kind: StepKind): FlowStep[] {
  const add = newStep(steps, kind);
  const child = steps.find((s) => s.id === childId);
  add.next = [childId];
  add.branch = child?.branch ?? null;
  return [
    ...steps.map((s) => {
      if (s.id === parentId) return { ...s, next: s.next.map((k) => (k === childId ? add.id : k)) };
      if (s.id === childId) return { ...s, branch: null };
      return s;
    }),
    add,
  ];
}

/** A new step after `stepId` (the "+" after the last step). */
export function appendAfter(steps: FlowStep[], stepId: string, kind: StepKind): FlowStep[] {
  const add = newStep(steps, kind);
  return [...steps.map((s) => (s.id === stepId ? { ...s, next: [...s.next, add.id] } : s)), add];
}

/** Removes a step with at most one child, reconnecting its parent to that child. The trigger stays. */
export function removeStep(steps: FlowStep[], stepId: string): FlowStep[] {
  const gone = steps.find((s) => s.id === stepId);
  if (!gone || gone.kind === "trigger" || gone.next.length > 1) return steps;
  const child = gone.next[0];
  return steps
    .filter((s) => s.id !== stepId)
    .map((s) => {
      if (s.next.includes(stepId)) return { ...s, next: s.next.flatMap((k) => (k === stepId ? (child ? [child] : []) : [k])) };
      if (s.id === child) return { ...s, branch: gone.branch ?? s.branch ?? null };
      return s;
    });
}

export const canRemove = (step: FlowStep) => step.kind !== "trigger" && step.next.length <= 1;

export function renameStep(steps: FlowStep[], stepId: string, title: string): FlowStep[] {
  return steps.map((s) => (s.id === stepId ? { ...s, title } : s));
}
