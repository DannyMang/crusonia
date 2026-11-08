// All mock handlers, one file per area so each can evolve on its own.
import { approvalHandlers } from "./approvals.ts";
import { billingHandlers } from "./billing.ts";
import { coreLeadHandlers } from "./core-leads.ts";
import { coreHandlers } from "./core.ts";
import { flowHandlers } from "./flows.ts";
import { keyHandlers } from "./keys.ts";
import { leadHandlers } from "./leads.ts";
import { onboardingHandlers } from "./onboarding.ts";
import { summaryHandlers } from "./summary.ts";
import { workflowHandlers } from "./workflows.ts";

export const handlers = [
  ...coreHandlers,
  // Before leadHandlers: find runs, notes, tasks and traces, and stage changes that stick.
  ...coreLeadHandlers,
  ...leadHandlers,
  ...approvalHandlers,
  ...workflowHandlers,
  ...keyHandlers,
  ...onboardingHandlers,
  ...billingHandlers,
  ...summaryHandlers,
  ...flowHandlers,
];
