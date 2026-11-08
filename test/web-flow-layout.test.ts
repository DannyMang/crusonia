// The workflow builder's canvas layout and edits (web/src/pages/workflows/layout.ts).
import { describe, expect, test } from "bun:test";
import type { FlowStep } from "../web/src/api/flow-types.ts";
import { appendAfter, insertOnEdge, layout, removeStep } from "../web/src/pages/workflows/layout.ts";

const s = (id: string, kind: FlowStep["kind"], next: string[] = [], branch: string | null = null): FlowStep => ({ id, kind, title: id, provider: null, branch, next });

// "Final · Workflows · Builder": trigger → find → research → condition (no: tasks, yes: draft → approval → send / end / notify)
const sweep: FlowStep[] = [
  s("t1", "trigger", ["f1"]),
  s("f1", "find", ["r1"]),
  s("r1", "research", ["c1"]),
  s("c1", "condition", ["k1", "d1"]),
  s("k1", "tasks", [], "no"),
  s("d1", "draft", ["a1"], "yes"),
  s("a1", "approval", ["m1", "e1", "n1"]),
  s("m1", "send", [], "approved"),
  s("e1", "end", [], "rejected"),
  s("n1", "notify", [], "timed out"),
];

const at = (l: ReturnType<typeof layout>, id: string) => l.nodes.find((n) => n.step.id === id)!;

describe("layout", () => {
  const l = layout(sweep);
  test("matches the Paper positions", () => {
    expect([at(l, "t1").x, at(l, "t1").y]).toEqual([16, 40]);
    expect([at(l, "c1").x, at(l, "c1").y]).toEqual([538, 40]);
    expect([at(l, "k1").x, at(l, "k1").y]).toEqual([364, 180]);
    expect([at(l, "d1").x, at(l, "d1").y]).toEqual([538, 180]);
    expect([at(l, "a1").x, at(l, "a1").y]).toEqual([538, 320]);
    expect([at(l, "m1").x, at(l, "e1").x, at(l, "n1").x]).toEqual([190, 364, 538]);
    expect(at(l, "m1").y).toBe(470);
  });
  test("a + on every connector except an approval's outcomes, and one after the main path's last step", () => {
    expect(l.edges.filter((e) => e.plus).map((e) => `${e.from}-${e.to}`)).toEqual(["t1-f1", "f1-r1", "r1-c1", "c1-k1", "c1-d1", "d1-a1"]);
    expect(l.edges.find((e) => e.to === "k1")!.plus).toEqual({ x: 437, y: 161 });
    expect(l.after).toMatchObject({ stepId: "m1", x: 263, y: 578 });
  });
  test("branch labels", () => {
    expect(l.edges.find((e) => e.to === "d1")!.label).toEqual({ text: "yes", x: 627, y: 150 });
    expect(l.edges.find((e) => e.to === "m1")!.label).toEqual({ text: "approved", x: 271, y: 432 });
  });
  test("a lone trigger gets a + to its right", () => {
    const one = layout([s("t1", "trigger")]);
    expect(one.after).toMatchObject({ stepId: "t1", x: 202, y: 72 });
  });
});

describe("edits", () => {
  test("insert on a connector keeps the branch label on the new step", () => {
    const next = insertOnEdge(sweep, "c1", "d1", "research");
    const added = next.find((x) => !sweep.some((y) => y.id === x.id))!;
    expect(added).toMatchObject({ kind: "research", branch: "yes", next: ["d1"] });
    expect(next.find((x) => x.id === "c1")!.next).toEqual(["k1", added.id]);
    expect(next.find((x) => x.id === "d1")!.branch).toBeNull();
  });
  test("append after the last step", () => {
    const next = appendAfter(sweep, "m1", "sync_crm");
    expect(next.find((x) => x.id === "m1")!.next).toHaveLength(1);
    expect(layout(next).after?.stepId).not.toBe("m1");
  });
  test("remove reconnects the parent; the trigger and branching steps stay", () => {
    const next = removeStep(sweep, "f1");
    expect(next.find((x) => x.id === "t1")!.next).toEqual(["r1"]);
    expect(removeStep(sweep, "t1")).toBe(sweep);
    expect(removeStep(sweep, "c1")).toBe(sweep);
  });
});
