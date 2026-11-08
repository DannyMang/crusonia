// Onboarding state shared by the four steps, kept in sessionStorage (`crusonia.onboarding`) so a reload
// resumes the same run instead of starting a new paid one. The paid calls (read-website, propose) start
// here at most once per run: the run is marked as started synchronously before the request goes out, so
// React StrictMode's double effect, remounts and back/forward navigation never start a second one.
import { useSyncExternalStore } from "react";
import { isApiError, type Api, type Profile } from "../../api.ts";
import { cleanWebsite } from "../../lib/website.ts";

const KEY = "crusonia.onboarding";

export type StoredError = { status: number; code: string; message: string };

export type ReadState =
  | { status: "pending" }
  | { status: "done"; pages: { url: string; title: string }[] }
  | { status: "error"; error: StoredError }
  /** The page was reloaded while the crawl was in flight; we do not pay for a second crawl. */
  | { status: "interrupted" };

export type ProposeState =
  | { status: "starting" }
  | { status: "running"; sessionId: string }
  | { status: "done"; sessionId: string }
  | { status: "error"; error: StoredError; sessionId?: string }
  /** Reloaded before the session id came back: the user decides whether to start again. */
  | { status: "interrupted" };

export type Onboarding = {
  /** Changes whenever step 1 starts a new run, so late responses from an old run are ignored. */
  runId?: string;
  url?: string;
  description?: string;
  startedAt?: number;
  read?: ReadState;
  propose?: ProposeState;
  /** The latest proposed profile (partial while the agent is still running). */
  proposal?: Profile | null;
  /** "Continue and fill it in yourself": step 3 starts from an empty profile. */
  manual?: boolean;
  /** Unsaved edits on step 3. */
  draft?: unknown;
  /** The "Find my first 3 leads" run. */
  leads?: { sessionId: string; target: number; startedAt: number };
};

function load(): Onboarding {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Onboarding) : {};
  } catch {
    return {};
  }
}

let state: Onboarding = load();
const listeners = new Set<() => void>();
// Requests in flight in THIS page load (module state resets on reload, sessionStorage does not).
const inflight = { read: false, propose: false };

// A reload aborts in-flight fetches and their rejections still run before the page goes away. Those are not
// real failures: leave the run "pending" so the next load marks it interrupted instead of failed.
let unloading = false;
if (typeof window !== "undefined") {
  const mark = () => {
    unloading = true;
    // If the navigation is cancelled after all, this page keeps running: stop ignoring errors.
    setTimeout(() => (unloading = false), 3000);
  };
  window.addEventListener("beforeunload", mark);
  window.addEventListener("pagehide", mark);
}

function write(next: Onboarding) {
  state = next;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage full or blocked: the run still works until the tab reloads
  }
  for (const l of listeners) l();
}

export function getOnboarding(): Onboarding {
  return state;
}

export function patchOnboarding(patch: Partial<Onboarding>) {
  write({ ...state, ...patch });
}

/** Step 1: start over with a new website or description. Keeps a leads run that is already going. */
export function resetOnboarding(input: { url?: string; description?: string }) {
  write({ runId: Math.random().toString(36).slice(2), ...input, leads: state.leads });
}

export function useOnboarding(): Onboarding {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

export function toStoredError(err: unknown): StoredError {
  if (isApiError(err)) return { status: err.status, code: err.code, message: err.message };
  return { status: 0, code: "unknown", message: err instanceof Error ? err.message : String(err) };
}

/** Same rules as ApiError.notConfigured / missingRoute, for errors that went through sessionStorage. */
export function isComingOnline(e: StoredError | undefined) {
  if (!e) return false;
  return (e.status === 503 && (e.code === "not_configured" || e.code === "schema_out_of_date")) || (e.status === 404 && e.code === "not_found" && e.message.startsWith("No route for"));
}

/** A website that passes lib/website.ts, or a description. A stored url from an older build is checked again. */
export function hasValidInput(s: Pick<Onboarding, "url" | "description">): boolean {
  return s.url ? cleanWebsite(s.url) !== null : Boolean(s.description);
}

/**
 * Starts the paid crawl and the profile proposal for the current run, unless they already started.
 * Returns false when there is nothing to read (the user has not been through step 1).
 */
export function ensureStarted(api: Api): boolean {
  const s = state;
  if (!hasValidInput(s)) return false;
  const runId = s.runId;
  const stillCurrent = () => state.runId === runId;

  if (s.url && !s.read) {
    inflight.read = true;
    patchOnboarding({ read: { status: "pending" }, startedAt: s.startedAt ?? Date.now() });
    api
      .readWebsite(s.url)
      .then(
        (res) => stillCurrent() && patchOnboarding({ read: { status: "done", pages: (res.pages ?? []).map((p) => ({ url: p.url, title: p.title })) } }),
        (err) => stillCurrent() && !unloading && patchOnboarding({ read: { status: "error", error: toStoredError(err) } }),
      )
      .finally(() => {
        inflight.read = false;
      });
  } else if (s.read?.status === "pending" && !inflight.read) {
    patchOnboarding({ read: { status: "interrupted" } });
  }

  if (!state.propose) {
    startPropose(api);
  } else if (state.propose.status === "starting" && !inflight.propose) {
    patchOnboarding({ propose: { status: "interrupted" } });
  }
  return true;
}

/** Starts a (paid) proposal session. Also used by the explicit "Try again" button. */
export function startPropose(api: Api) {
  const s = state;
  const runId = s.runId;
  inflight.propose = true;
  patchOnboarding({ propose: { status: "starting" }, proposal: undefined, startedAt: s.startedAt ?? Date.now() });
  api
    .propose(s.url ? { url: s.url } : { description: s.description })
    .then(
      (res) => state.runId === runId && patchOnboarding({ propose: { status: "running", sessionId: res.session_id } }),
      (err) => state.runId === runId && !unloading && patchOnboarding({ propose: { status: "error", error: toStoredError(err) } }),
    )
    .finally(() => {
      inflight.propose = false;
    });
}

/** "fieldnote.io" from "https://fieldnote.io/x"; the description path has no host. */
export function siteHost(url: string | undefined) {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

/**
 * Short label for a source page, as in the designs: the site's own pages show as a path ("/pricing"),
 * the home page as "fieldnote.io/", other sites as host + path.
 */
export function sourceLabel(url: string, siteUrl?: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const host = u.hostname.replace(/^www\./, "");
  const path = `${u.pathname}${u.search}` || "/";
  const own = siteUrl ? host === siteHost(siteUrl) : false;
  if (own && path !== "/") return path;
  return `${host}${path}`;
}
