// Bridge -> Worker: one signed POST per owner tapback to <WORKER_URL>/webhooks/photon. The Worker dedupes by the
// iMessage event id, so retrying an ambiguous failure never applies a decision twice.
import type { Command } from "./commands.ts";
import { signedHeaders } from "./hmac.ts";
import { describeError, log } from "./log.ts";

export const WEBHOOK_PATH = "/webhooks/photon";

export type InboundEvent = {
  /** The iMessage message id from Spectrum: the Worker's idempotency key. */
  id: string;
  from: string;
  received_at: string;
  command: Command;
};

export type WorkerReply = { ok: boolean; reply: string; duplicate?: boolean };

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type WorkerClientOptions = {
  workerUrl: string;
  secret: string;
  fetch?: FetchFn;
  attempts?: number;
  retryDelaysMs?: number[];
  timeoutMs?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function postCommand(event: InboundEvent, opts: WorkerClientOptions): Promise<WorkerReply> {
  const fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
  const attempts = opts.attempts ?? 3;
  const delays = opts.retryDelaysMs ?? [1_000, 4_000];
  const body = JSON.stringify(event);
  let lastProblem = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(delays[Math.min(attempt - 1, delays.length - 1)] ?? 1_000);
    try {
      const res = await fetchFn(`${opts.workerUrl}${WEBHOOK_PATH}`, {
        method: "POST",
        headers: signedHeaders(opts.secret, WEBHOOK_PATH, body), // fresh timestamp per attempt
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
      });
      const json = (await res.json().catch(() => null)) as Partial<WorkerReply> & { error?: { code?: string; message?: string } } | null;
      if (res.ok && json && typeof json.reply === "string") return { ok: json.ok !== false, reply: json.reply, duplicate: json.duplicate };
      lastProblem = `HTTP ${res.status}${json?.error?.code ? ` ${json.error.code}` : ""}`;
      // 4xx (bad signature, invalid payload) will not get better on retry; 429 and 5xx might.
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      lastProblem = describeError(err);
    }
    log.warn("worker call failed", { problem: lastProblem, attempt: attempt + 1, event_id: event.id });
  }
  log.error("worker unreachable for command", { problem: lastProblem, event_id: event.id, action: event.command.action });
  return {
    ok: false,
    reply: `Crusonia didn't confirm that tapback (${lastProblem}). Check the app before trying again.`,
  };
}
