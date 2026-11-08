// Shared HTTP plumbing for the provider clients. Error messages never include request headers (keys).

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

// Wrapped so the global is always called unbound (Workers rejects some detached-`this` calls).
export const defaultFetch: FetchFn = (input, init) => fetch(input, init);

export class ProviderError extends Error {
  constructor(
    readonly provider: "agentmail" | "naive",
    message: string,
    /** HTTP status, or undefined when the request never got a response (network error, timeout). */
    readonly status: number | undefined,
    /**
     * True when the request may have taken effect anyway (no response, 408, 5xx): callers must reconcile
     * with the provider before retrying something that is not idempotent, like sending an email.
     */
    readonly ambiguous: boolean,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export async function requestJson<T>(
  provider: ProviderError["provider"],
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
