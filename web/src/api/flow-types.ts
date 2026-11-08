// Workflow step types, kept free of imports so pure modules (the canvas layout) and `bun test` can use them.

export type StepKind = "trigger" | "find" | "research" | "condition" | "draft" | "tasks" | "approval" | "notify" | "sync_crm" | "send" | "end";

/** One node on the canvas. `next` are child ids; a child's `branch` labels the edge into it ("yes", "approved"). */
export type FlowStep = {
  id: string;
  kind: StepKind;
  title: string;
  /** Small label above the title ("Apify", "Researcher"); defaults to the kind. */
  provider?: string | null;
  branch?: string | null;
  next: string[];
};

export type FlowSource = "user" | "claude_code" | "template";
export type TriggerKind = "schedule" | "csv_import" | "reply" | "manual";

/** `stale_days`: runs work on leads last researched this long ago. `like_rated`: its find step looks for companies like your last 👍. */
export type FlowTrigger = { kind: TriggerKind; label: string; every_hours?: number; stale_days?: number; like_rated?: boolean };

export type Qualification = {
  icp: { source: "company_summary" };
  research_questions: string[];
  evidence_required: string[];
  done_when: string;
};

export type FlowInput = Qualification & {
  name: string;
  steps: FlowStep[];
  source?: FlowSource;
  trigger?: FlowTrigger;
  enabled?: boolean;
  spend?: { cap_usd: number; period: "week" | "run" };
};
