// Honest numbers for the Experiments screen, derived only from what /api/experiments returns. The backend
// never picks a winner, so neither does this file: it reports counts, rates and whether the sample is small.
import type { ArmStats, DailyPoint, Experiment } from "../../api.ts";

export type Arm = "A" | "B";
export const ARMS: Arm[] = ["A", "B"];

const DAY = 86_400_000;
const ZERO: ArmStats = { sent: 0, replies: 0, positive: 0, cost_usd: null };

export const isLive = (e: Experiment) => e.status === "running";
export const arm = (e: Experiment, k: Arm): ArmStats => ({ ...ZERO, ...(e.stats?.[k] ?? {}) });
export const armName = (e: Experiment, k: Arm) => e.variants?.[k]?.name?.trim() || `Variant ${k}`;
export const armDescription = (e: Experiment, k: Arm) => e.variants?.[k]?.description?.trim() || null;

const utcDayIndex = (v: string | number) => Math.floor(new Date(v).getTime() / DAY);

/** Day of the experiment in UTC days (day 1 = the day it was created), up to today or the day it stopped. */
export function dayNumber(e: Experiment, now = Date.now()): number {
  const end = e.stopped_at ? utcDayIndex(e.stopped_at) : utcDayIndex(now);
  const d = end - utcDayIndex(e.created_at) + 1;
  return Number.isFinite(d) ? Math.max(1, d) : 1;
}

/** "80 sends per arm or 14 days", or null when no stop rule is set. */
export function stopRuleText(e: Experiment): string | null {
  const parts = [e.stop_rule_sends_per_arm ? `${e.stop_rule_sends_per_arm} sends per arm` : null, e.stop_rule_days ? `${e.stop_rule_days} days` : null];
  const t = parts.filter(Boolean).join(" or ");
  return t || null;
}

/** "day 6 of 14", or "day 6" when there is no day limit (or it has passed). */
export function dayLabel(e: Experiment): string {
  const d = dayNumber(e);
  const total = e.stop_rule_days;
  return total && d <= total ? `day ${d} of ${total}` : `day ${d}`;
}

export function totals(e: Experiment) {
  const a = arm(e, "A");
  const b = arm(e, "B");
  const costs = [a.cost_usd, b.cost_usd].filter((c): c is number => c !== null && c !== undefined);
  return {
    sent: a.sent + b.sent,
    replies: a.replies + b.replies,
    positive: a.positive + b.positive,
    /** null until Naive reports spend for either arm. */
    cost: costs.length ? costs.reduce((x, y) => x + y, 0) : null,
  };
}

/** Total sends vs the total the stop rule targets (both arms), e.g. 104/160; falls back to days elapsed. */
export function sendProgress(e: Experiment): { sent: number; target: number | null; share: number | null } {
  const sent = totals(e).sent;
  const per = e.stop_rule_sends_per_arm;
  if (per) return { sent, target: per * 2, share: Math.min(1, sent / (per * 2)) };
  const days = e.stop_rule_days;
  return { sent, target: null, share: days ? Math.min(1, dayNumber(e) / days) : null };
}

const rate = (s: ArmStats) => (s.sent ? s.positive / s.sent : 0);

/** Positive-reply rate gap between A and B in percentage points, and which arm is ahead (if any). */
export function positiveGap(e: Experiment) {
  const a = arm(e, "A");
  const b = arm(e, "B");
  const pts = Math.abs(rate(a) - rate(b)) * 100;
  const lead: Arm | null = rate(a) > rate(b) ? "A" : rate(b) > rate(a) ? "B" : null;
  return { a, b, pts, lead };
}

/** "52 sends per arm" when both arms match, else "52 and 49 sends". */
export function sendsText(a: ArmStats, b: ArmStats) {
  return a.sent === b.sent ? `${a.sent} sends per arm` : `${a.sent} and ${b.sent} sends`;
}

/** Plain-language read of the numbers. Never names a winner and never claims significance. */
export function verdict(e: Experiment): { title: string; body: string } {
  const { a, b, pts, lead } = positiveGap(e);
  const sends = sendsText(a, b);
  const gap = `${pts.toFixed(1)} points`;
  const counts = `${a.positive} vs ${b.positive} positive replies`;
  const small = Math.min(a.positive, b.positive) < 10;
  const enrolled = (e.enrolled?.A ?? 0) + (e.enrolled?.B ?? 0);
  if (a.sent + b.sent === 0) {
    return isLive(e)
      ? {
          title: enrolled ? "No sends yet" : "No leads enrolled yet",
          body: enrolled
            ? "Results show up here after the first approved emails go out. Each lead stays in its variant, and every send still needs your OK."
            : "Enroll leads to start: each one keeps its variant (A or B) for the whole test, and every send still needs your OK.",
        }
      : { title: "Stopped before any sends", body: "Nothing was sent while this experiment ran, so there is nothing to compare." };
  }
  if (isLive(e)) {
    const met = e.stop_rule_met ? ` The stop rule is met${e.stop_rule_reason ? ` (${e.stop_rule_reason.toLowerCase()})` : ""}: stop it to freeze the numbers.` : " Keep both arms running until the stop rule.";
    return {
      title: small ? "Small sample: not a winner yet" : "Not a winner yet",
      body: lead
        ? `${lead} is ahead by ${gap} on positive replies, but ${counts} at ${sends} can easily be chance.${met}`
        : `Both arms are level at ${counts} and ${sends}.${met}`,
    };
  }
  const title = small ? "Stopped: small sample, no winner called" : "Stopped: no winner called";
  if (!lead) return { title, body: `${counts} at ${sends}: the arms finished level. Crusonia does not call winners.` };
  return {
    title,
    body: `${counts} at ${sends}, ${lead} ahead by ${gap}. Crusonia does not call winners: ${
      small ? "with samples this small a gap can easily be chance, so re-test before you rely on it." : "treat the gap as a lead to re-test, not as proof."
    }`,
  };
}

/** Cumulative replies per arm by day, from the per-day series. */
export function cumulative(daily: DailyPoint[]): { date: string; A: number; B: number }[] {
  let A = 0;
  let B = 0;
  return daily.map((d) => {
    A += d.A_replies || 0;
    B += d.B_replies || 0;
    return { date: d.date, A, B };
  });
}
