// Small display helpers shared by every screen.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const toDate = (v: string | number | Date) => (v instanceof Date ? v : new Date(v));

/** "just now", "12m ago", "2h ago", "Yesterday", "Nov 5". */
export function timeAgo(v: string | number | Date | null | undefined, now = Date.now()): string {
  if (v === null || v === undefined) return "—";
  const d = toDate(v);
  const diff = now - d.getTime();
  if (Number.isNaN(diff)) return "—";
  if (diff < MIN) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 2 * DAY) return "Yesterday";
  return shortDate(d);
}

/** Compact duration: "2h 10m", "24m", "48s". */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  const abs = Math.max(0, ms);
  if (abs < MIN) return abs < 1000 ? `${(abs / 1000).toFixed(2)}s` : `${(abs / 1000).toFixed(abs < 10_000 ? 1 : 0)}s`;
  if (abs < HOUR) return `${Math.floor(abs / MIN)}m`;
  const h = Math.floor(abs / HOUR);
  const m = Math.floor((abs % HOUR) / MIN);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Time left until an ISO timestamp: "24m", "2h 10m", or "expired". */
export function timeLeft(v: string | null | undefined, now = Date.now()): string {
  if (!v) return "—";
  const ms = toDate(v).getTime() - now;
  return ms <= 0 ? "expired" : duration(ms);
}

export function shortDate(v: string | number | Date): string {
  return toDate(v).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function longDate(v: string | number | Date): string {
  return toDate(v).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function clock(v: string | number | Date): string {
  return toDate(v).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** "Friday, Nov 7". */
export function weekdayDate(v: string | number | Date = Date.now()): string {
  return toDate(v).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

export function usd(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function num(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US");
}

export function pct(part: number, whole: number, digits = 0): string {
  if (!whole) return "—";
  return `${((part / whole) * 100).toFixed(digits)}%`;
}

export function greeting(d = new Date()): string {
  const h = d.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function initials(name: string | null | undefined, fallback = "?"): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return fallback;
  return (parts[0]![0]! + (parts.length > 1 ? parts.at(-1)![0]! : "")).toUpperCase();
}

/** "fieldnote.io" from "https://www.fieldnote.io/about". */
export function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Lead display name: company, else domain, else person, else email. */
export function leadTitle(l: { company?: string | null; domain?: string | null; name?: string | null; email?: string | null }): string {
  return l.company || l.domain || l.name || l.email || "Unnamed lead";
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
