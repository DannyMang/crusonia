// Onboarding step 4's progress line. Pure, so `bun test` covers it. A find session saves what it has and stops (the playbook
// allows it five turns), so "25" is an upper limit: once the session has ended, no more leads are coming from it.

export type FindProgress = { finished: boolean; complete: boolean; title: string; status: string; hint: string | null };

export function findProgress(found: number, target: number, sessionStatus: string | null | undefined, hasRun: boolean): FindProgress {
  const finished = sessionStatus === "done" || sessionStatus === "error";
  const complete = found >= target || finished;
  const title = complete ? (found ? "Your first leads are in" : "No leads from this search") : hasRun || found ? "Your first leads are coming in" : "Your first leads";
  if (complete) {
    return {
      finished,
      complete,
      title,
      status: found >= target ? `Found ${target}` : `Found ${found}`,
      hint: found >= target ? null : found ? `This search found ${found} of the ${target} it looked for` : `This search found none of the ${target} it looked for`,
    };
  }
  return { finished, complete, title, status: `Found ${found} of ${target}`, hint: found ? "looking for more" : "waiting for the first lead" };
}
