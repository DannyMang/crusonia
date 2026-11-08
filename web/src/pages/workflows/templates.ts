// Starting points for "Suggested" on the workflow list and the blank workflow behind "Build workflow". Templates start
// off: "Use" opens the builder and spends nothing until "Turn on" (a schedule that never ran is due at once).
import type { FlowInput, FlowStep } from "../../api/flow-types.ts";

const step = (id: string, kind: FlowStep["kind"], title: string, provider: string | null, next: string[] = [], branch: string | null = null): FlowStep => ({
  id,
  kind,
  title,
  provider,
  branch,
  next,
});

const ICP = { source: "company_summary" as const };

export type Template = { id: string; name: string; meta: string; input: FlowInput };

export const TEMPLATES: Template[] = [
  {
    id: "rerresearch",
    name: "Re-research stale leads",
    meta: "Every other Monday · 400 credits a week",
    input: {
      name: "Re-research stale leads",
      source: "template",
      enabled: false,
      trigger: { kind: "schedule", label: "Every other Monday", stale_days: 60 },
      spend: { cap_usd: 2, period: "week" },
      steps: [
        step("t1", "trigger", "Every other Monday", null, ["r1"]),
        step("r1", "research", "Research leads last read 60+ days ago", "Researcher", ["x1"]),
        step("x1", "sync_crm", "Update HubSpot", "Sync CRM"),
      ],
      icp: ICP,
      research_questions: ["What changed since the last research?"],
      evidence_required: ["Dated source for every change"],
      done_when: "Re-scored, with a source for each change",
    },
  },
  {
    id: "lookalikes",
    name: "Lookalikes of a lead you liked",
    meta: "Every week · 800 credits a week",
    input: {
      name: "Lookalikes of a lead you liked",
      source: "template",
      enabled: false,
      trigger: { kind: "schedule", label: "Every week", like_rated: true },
      spend: { cap_usd: 4, period: "week" },
      steps: [
        step("t1", "trigger", "Every week", null, ["f1"]),
        step("f1", "find", "Find companies like your last 👍", "Apify", ["r1"]),
        step("r1", "research", "Research, score", "Researcher", ["e1"]),
        step("e1", "end", "Done", null),
      ],
      icp: ICP,
      research_questions: ["How close is this company to the lead you liked?"],
      evidence_required: ["Source URL for the match"],
      done_when: "Scored, and the match has a source",
    },
  },
  {
    id: "event",
    name: "Event follow-up",
    meta: "On CSV upload · 400 credits a run",
    input: {
      name: "Event follow-up",
      source: "template",
      enabled: false,
      trigger: { kind: "csv_import", label: "On CSV upload" },
      spend: { cap_usd: 2, period: "run" },
      steps: [
        step("t1", "trigger", "On CSV upload", null, ["r1"]),
        step("r1", "research", "Research, score", "Researcher", ["d1"]),
        step("d1", "draft", "Draft email", "Drafter", ["a1"]),
        step("a1", "approval", "Wait for me", "Approval · 48h", ["m1", "e1"]),
        step("m1", "send", "Send draft", "AgentMail", [], "approved"),
        step("e1", "end", "Stop", "End", [], "rejected"),
      ],
      icp: ICP,
      research_questions: ["What did they ask about at the event?"],
      evidence_required: ["Opt-in on the import"],
      done_when: "Drafted for every opted-in contact",
    },
  },
];

export const BLANK: FlowInput = {
  name: "",
  source: "user",
  steps: [step("t1", "trigger", "Manual", null)],
  icp: ICP,
  research_questions: [],
  evidence_required: [],
  done_when: "",
};
