// Workflow step types, kept free of imports so pure modules (the canvas layout) and `bun test` can use them.

export type StepKind = "trigger" | "find" | "research" | "condition" | "draft" | "tasks" | "approval" | "notify" | "sync_crm" | "send" | "end";

/** One node on the canvas. `next` are child ids; a child's `branch` labels the edge into it ("yes", "approved"). */
export type FlowStep = {
  id: string;
  kind: StepKind;
  title: string;
  /** Small label above the title ("Apify · $0.40 cap", "Researcher"); defaults to the kind. */
  provider?: string | null;
  branch?: string | null;
  next: string[];
};
