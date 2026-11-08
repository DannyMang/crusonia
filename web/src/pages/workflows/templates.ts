// Starting points for "Suggested" on the workflow list and the blank workflow behind "Build workflow".
import type { FlowInput, FlowStep } from "../../api/workflows.ts";

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
    meta: "Every other Monday · $2 a week",
    input: {
      name: "Re-research stale leads",
      source: "template",
      trigger: { kind: "schedule", label: "Every other Monday" },
      steps: [
        step("t1", "trigger", "Every other Monday", null, ["f1"]),
        step("f1", "find", "Leads older than 60 days", "Find", ["r1"]),
        step("r1", "research", "Research, score", "Researcher", ["x1"]),
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
    name: "Lookalikes from a new customer",
    meta: "On HubSpot closed-won · $4 a week",
    input: {
      name: "Lookalikes from a new customer",
      source: "template",
      trigger: { kind: "manual", label: "On HubSpot closed-won" },
      steps: [
        step("t1", "trigger", "On HubSpot closed-won", null, ["f1"]),
        step("f1", "find", "Find lookalike companies", "Apify · $0.40 cap", ["r1"]),
        step("r1", "research", "Research, score", "Researcher", ["n1"]),
        step("n1", "notify", "Text me", "Photon iMessage"),
      ],
      icp: ICP,
      research_questions: ["How close is this company to the new customer?"],
      evidence_required: ["Source URL for the match"],
      done_when: "Scored, and the match has a source",
    },
  },
  {
    id: "event",
    name: "Event follow-up",
    meta: "On CSV upload · $2 a run",
    input: {
      name: "Event follow-up",
      source: "template",
      trigger: { kind: "csv_import", label: "On CSV upload" },
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
