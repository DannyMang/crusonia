// All mock handlers, one file per area so each can evolve on its own.
import { approvalHandlers } from "./approvals.ts";
import { coreHandlers } from "./core.ts";
import { experimentHandlers } from "./experiments.ts";
import { keyHandlers } from "./keys.ts";
import { leadHandlers } from "./leads.ts";
import { onboardingHandlers } from "./onboarding.ts";
import { workflowHandlers } from "./workflows.ts";

export const handlers = [
  ...coreHandlers,
  ...leadHandlers,
  ...approvalHandlers,
  ...workflowHandlers,
  ...experimentHandlers,
  ...keyHandlers,
  ...onboardingHandlers,
];
