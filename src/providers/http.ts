// Shared HTTP plumbing for the provider clients. Error messages never include request headers (keys).

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

// Wrapped so the global is always called unbound (Workers rejects some detached-`this` calls).
export const defaultFetch: FetchFn = (input, init) => fetch(input, init);

export type ProviderName = "agentmail" | "naive" | "hubspot" | "notion";

export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderName,
    message: string,
    /** HTTP status, or undefined when the request never got a response (network error, timeout). */
    readonly status: number | undefined,
    /**
     * True when the request may have taken effect anyway (no response, 408, 5xx): callers must reconcile
     * with the provider before retrying something that is not idempotent, like sending an email.
     */
    readonly ambiguous: boolean,
    /** The parsed error body, when the provider sent one (HubSpot `category`, Notion `code`, ...). */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export async function requestJson<T>(
  provider: ProviderName,
  fetchFn: FetchFn,
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const label = `${init.method ?? "GET"} ${new URL(url).pathname}`;
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 15_000) });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new ProviderError(provider, `${provider} ${label}: no response (${why})`, undefined, true);
  }
  const text = await res.text();
  if (!res.ok) {
    const ambiguous = res.status === 408 || res.status >= 500;
    throw new ProviderError(provider, `${provider} ${label} failed (${res.status}): ${text.slice(0, 300)}`, res.status, ambiguous);
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // The request succeeded, so its effect happened: ambiguous, the caller reconciles.
    throw new ProviderError(provider, `${provider} ${label}: response was not JSON`, res.status, true);
  }
}

// ---------- paced requests (CRM sync: HubSpot, Notion) ----------

/** A 429. `retryAfterMs` is when the provider said to come back (Retry-After), or its documented window. */
export class RateLimitError extends ProviderError {
  constructor(
    provider: ProviderName,
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(provider, message, 429, false);
    this.name = "RateLimitError";
  }
}

/** Retry-After is delta-seconds or an HTTP date. Undefined when absent or unparseable. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Clock and sleep, injectable so tests run instantly. */
export type Pace = { now: () => number; sleep: (ms: number) => Promise<void> };
export const realPace: Pace = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

/** Spaces calls at least `minIntervalMs` apart (one instance per client; calls are sequential). */
export class Throttle {
  private nextAt = 0;
  constructor(
    readonly minIntervalMs: number,
    private readonly pace: Pace = realPace,
  ) {}

  async wait(): Promise<void> {
    const now = this.pace.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.minIntervalMs;
    if (at > now) await this.pace.sleep(at - now);
  }
}

export type PacePolicy = {
  throttle: Throttle;
  pace: Pace;
  /** A 429 asking for at most this long is waited out in place (once); longer ones throw RateLimitError. */
  maxInlineWaitMs: number;
  /** Used when a 429 has no Retry-After header. */
  defaultRetryAfterMs: number;
};

export type PacedRequest = { method: string; url: string; headers: Record<string, string>; body?: unknown; timeoutMs?: number };

/** Path for error messages: segments that look like email addresses are replaced (no personal data in logs). */
export function safePath(url: string): string {
  return new URL(url).pathname.replace(/[^/]*(@|%40)[^/]*/gi, ":email");
}

/**
 * JSON request with pacing and 429 handling. Errors are ProviderErrors with the parsed body in `details`;
 * 408/5xx/no response are `ambiguous` (may have taken effect: callers look before they retry a create).
 */
export async function pacedJson<T>(provider: ProviderName, fetchFn: FetchFn, req: PacedRequest, policy: PacePolicy): Promise<T> {
  const label = `${req.method} ${safePath(req.url)}`;
  for (let attempt = 0; ; attempt++) {
    await policy.throttle.wait();
    let res: Response;
    try {
      res = await fetchFn(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(req.timeoutMs ?? 20_000),
      });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new ProviderError(provider, `${provider} ${label}: no response (${why})`, undefined, true);
    }
    const text = await res.text();
    if (res.status === 429) {
      const wait = parseRetryAfter(res.headers.get("retry-after"), policy.pace.now()) ?? policy.defaultRetryAfterMs;
      if (attempt === 0 && wait <= policy.maxInlineWaitMs) {
        await policy.pace.sleep(wait);
        continue;
      }
      throw new RateLimitError(provider, `${provider} ${label}: rate limited (429), retry in ${Math.ceil(wait / 1000)}s`, wait);
    }
    let data: unknown;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    if (!res.ok) {
      const ambiguous = res.status === 408 || res.status >= 500;
      const message = data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string"
        ? (data as { message: string }).message
        : text;
      throw new ProviderError(provider, `${provider} ${label} failed (${res.status}): ${message.slice(0, 300)}`, res.status, ambiguous, data);
    }
    if (text && data === undefined) throw new ProviderError(provider, `${provider} ${label}: response was not JSON`, res.status, true);
    return (data ?? {}) as T;
  }
}
