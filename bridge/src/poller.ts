// Outbound-only notices: every ~5 s the bridge asks the Worker what to text the owner (POST /webhooks/photon/poll,
// signed), texts it, and reports the result on the next poll. Nothing ever connects *to* the bridge, so the box needs
// no open port, no TLS certificate and no inbound firewall rule.
import { z } from "zod";
import { MAX_SMS_TEXT } from "./bridge.ts";
import type { Config } from "./config.ts";
import { SeenIds, signedHeaders } from "./hmac.ts";
import { describeError, log } from "./log.ts";
import { backoffDelay, type Messenger } from "./messenger.ts";
import type { FetchFn } from "./worker-client.ts";

export const POLL_PATH = "/webhooks/photon/poll";

const PollResponse = z.object({
  ok: z.literal(true),
  enabled: z.boolean(),
  notices: z.array(z.object({ id: z.string().min(1).max(100), type: z.string().max(40), text: z.string().min(1).max(MAX_SMS_TEXT) })).max(20),
  poll_after_ms: z.number().int().optional(),
});

/** `message_id`: the sent iMessage's id, so a later tapback on that bubble can be matched to its approval. */
type Ack = { id: string; ok: boolean; error?: string; message_id?: string };

export type PollerStatus = {
  last_poll_at: string | null;
  last_poll_error: string | null;
  worker_enabled: boolean | null;
  notices_sent: number;
};

class PollHttpError extends Error {
  readonly status: number;
  constructor(status: number, code: string | undefined) {
    super(`Worker answered ${status}${code ? ` ${code}` : ""}`);
    this.name = "PollHttpError";
    this.status = status;
  }
}

export class Poller {
  private readonly config: Config;
  private readonly messenger: Messenger;
  private readonly fetchFn: FetchFn;
  private readonly intervalMs: number;
  private readonly version: string;
  private acks: Ack[] = [];
  private readonly delivered = new SeenIds(60 * 60 * 1000);
  private stopped = false;
  private wake: (() => void) | undefined;
  private loop: Promise<void> | undefined;
  private lastPollAt: Date | null = null;
  private lastPollError: string | null = null;
  private workerEnabled: boolean | null = null;
  private sent = 0;

  constructor(opts: { config: Config; messenger: Messenger; fetch?: FetchFn; intervalMs?: number; version?: string }) {
    this.config = opts.config;
    this.messenger = opts.messenger;
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.intervalMs = opts.intervalMs ?? opts.config.pollIntervalMs;
    this.version = opts.version ?? "dev";
  }

  /** One poll: report status and acks, text whatever the Worker hands over. Returns how many texts went out. */
  async pollOnce(): Promise<{ delivered: number; failed: number; pollAfterMs: number }> {
    const status = this.messenger.status();
    const connected = status.state === "connected";
    const acks = this.acks.splice(0, 50);
    const body = JSON.stringify({
      bridge: {
        version: this.version.slice(0, 40),
        mode: status.mode,
        state: status.state,
        connected,
        last_heartbeat_at: status.last_heartbeat_at,
        reconnects: status.reconnects,
      },
      acks,
      max: connected ? 5 : 0, // never lease notices we cannot deliver
    });
    let json: z.infer<typeof PollResponse>;
    try {
      const res = await this.fetchFn(`${this.config.workerUrl}${POLL_PATH}`, {
        method: "POST",
        headers: signedHeaders(this.config.bridgeSecret, POLL_PATH, body),
        body,
        signal: AbortSignal.timeout(15_000),
      });
      const raw = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) throw new PollHttpError(res.status, (raw as { error?: { code?: string } } | null)?.error?.code);
      json = PollResponse.parse(raw);
    } catch (err) {
      this.acks.unshift(...acks); // report them next time
      throw err;
    }
    this.lastPollAt = new Date();
    this.lastPollError = null;
    if (this.workerEnabled !== json.enabled) log.info("worker iMessage switch", { enabled: json.enabled });
    this.workerEnabled = json.enabled;

    let delivered = 0;
    let failed = 0;
    for (const notice of json.notices) {
      // Already texted (a lease that expired before our ack arrived): confirm without texting twice.
      if (!this.delivered.claim(notice.id)) {
        this.acks.push({ id: notice.id, ok: true });
        continue;
      }
      try {
        const sent = await this.messenger.sendToOwner(notice.text);
        this.acks.push({ id: notice.id, ok: true, ...(sent.messageId ? { message_id: sent.messageId.slice(0, 200) } : {}) });
        this.sent++;
        delivered++;
        log.info("notified owner", { id: notice.id, type: notice.type });
      } catch (err) {
        this.delivered.release(notice.id);
        this.acks.push({ id: notice.id, ok: false, error: describeError(err) });
        failed++;
        log.error("notice send failed", { id: notice.id, error: describeError(err) });
      }
    }
    const after = json.poll_after_ms ?? this.intervalMs;
    return { delivered, failed, pollAfterMs: Math.min(Math.max(after, 1_000), 300_000) };
  }

  start(): void {
    if (this.loop) return;
    this.loop = this.run();
  }

  private async run() {
    let failures = 0;
    while (!this.stopped) {
      let delay: number;
      try {
        const r = await this.pollOnce();
        if (failures > 0) log.info("worker reachable again", { after_failures: failures });
        failures = 0;
        // Texts went out: poll again right away to ack them and pick up the next batch.
        delay = r.delivered > 0 && r.failed === 0 ? 250 : r.pollAfterMs;
      } catch (err) {
        failures++;
        this.lastPollError = describeError(err);
        // Log the first failure and then every 20th, so an outage does not flood the log.
        if (failures === 1 || failures % 20 === 0) log.warn("poll failed", { error: this.lastPollError, failures });
        delay = backoffDelay(failures - 1, { initialMs: this.intervalMs, maxMs: 60_000, stableMs: 0 });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
  }

  status(): PollerStatus {
    return {
      last_poll_at: this.lastPollAt?.toISOString() ?? null,
      last_poll_error: this.lastPollError,
      worker_enabled: this.workerEnabled,
      notices_sent: this.sent,
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.loop;
  }
}
