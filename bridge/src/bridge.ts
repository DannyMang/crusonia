// The bridge's logic, independent of HTTP and of the iMessage transport:
//   inbound  owner's 👍 / 👎 on a notice -> signed POST /webhooks/photon on the Worker -> at most one confirmation per 10 min
//   outbound notices come from the Worker through the poller (poller.ts); handleNotify serves the local operator
//            endpoint (test message). Either way only OWNER_PHONE is ever texted.
import { z } from "zod";
import { tapbackDecision } from "./commands.ts";
import type { Config } from "./config.ts";
import { SeenIds, SIGNATURE_HEADER, TIMESTAMP_HEADER, verify } from "./hmac.ts";
import { describeError, log } from "./log.ts";
import { NotConnectedError, type InboundMessage, type Messenger } from "./messenger.ts";
import { isOwner, maskHandle, normalizeHandle } from "./phone.ts";
import { postCommand, type FetchFn } from "./worker-client.ts";

export const NOTIFY_PATH = "/notify";
export const MAX_SMS_TEXT = 4_000;

const NotifySchema = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(["approval", "expiry_warning", "test", "info"]),
  text: z.string().min(1).max(MAX_SMS_TEXT),
});

export type HttpResult = { status: number; body: Record<string, unknown> };

/** Hard loop guard: at most one text that is not a notice (a tapback's confirmation) per this window. */
export const REPLY_WINDOW_MS = 10 * 60 * 1000;

export class Bridge {
  private readonly config: Config;
  private readonly messenger: Messenger;
  private readonly fetchFn: FetchFn | undefined;
  private readonly notifyIds = new SeenIds();
  // Spectrum delivers at least once (reconnect catch-up): act on each tapback once.
  private readonly inboundIds = new SeenIds(60 * 60 * 1000);
  private readonly workerRetryDelaysMs: number[] | undefined;
  private lastReplyAt = Number.NEGATIVE_INFINITY;

  constructor(opts: { config: Config; messenger: Messenger; fetch?: FetchFn; workerRetryDelaysMs?: number[] }) {
    this.config = opts.config;
    this.messenger = opts.messenger;
    this.fetchFn = opts.fetch;
    this.workerRetryDelaysMs = opts.workerRetryDelaysMs;
  }

  /**
   * Every inbound event lands here, and only one kind does anything: the owner's 👍 or 👎 on a specific bubble, in a
   * direct message. Texts, read receipts, typing, attachments, other tapbacks and our own messages are dropped without
   * a word. Never answer those: read receipts arrive with the owner as sender, so a reply to one is read, which sends
   * another receipt, which would be answered again. That loop texted the owner repeatedly.
   */
  async handleInbound(m: InboundMessage, now = Date.now()): Promise<void> {
    if (m.fromSelf) return;
    if (!isOwner(m.sender, this.config.ownerHandles)) {
      log.info("ignored event from non-owner", { from: maskHandle(m.sender), content: m.contentType });
      return;
    }
    const decision = m.contentType === "reaction" && m.isDirect ? tapbackDecision(m.reaction?.emoji) : undefined;
    const target = m.reaction?.targetId;
    if (!decision || !target) {
      log.debug("ignored owner event", { content: m.contentType });
      return;
    }
    if (!this.inboundIds.claim(m.id, now)) {
      log.debug("duplicate tapback delivery", { id: m.id });
      return;
    }
    log.info("owner tapback", { reaction: decision, id: m.id });
    const result = await postCommand(
      {
        id: m.id,
        from: normalizeHandle(m.sender) ?? this.config.ownerPhone,
        received_at: m.receivedAt.toISOString(),
        command: { action: "react", reaction: decision, message_id: target },
      },
      { workerUrl: this.config.workerUrl, secret: this.config.bridgeSecret, fetch: this.fetchFn, retryDelaysMs: this.workerRetryDelaysMs },
    );
    if (!result.reply) return; // a tapback on a bubble that is not a notice
    if (now - this.lastReplyAt < REPLY_WINDOW_MS) {
      log.info("confirmation not texted (one per 10 minutes)", { id: m.id });
      return;
    }
    this.lastReplyAt = now;
    try {
      await m.reply(result.reply);
    } catch (err) {
      log.error("reply to owner failed", { error: describeError(err) });
    }
  }

  /** POST /notify from the Worker: verify, dedupe, text the owner. */
  async handleNotify(rawBody: string, headers: { get(name: string): string | null | undefined }): Promise<HttpResult> {
    const verified = verify({
      secret: this.config.bridgeSecret,
      path: NOTIFY_PATH,
      body: rawBody,
      timestamp: headers.get(TIMESTAMP_HEADER),
      signature: headers.get(SIGNATURE_HEADER),
    });
    if (!verified.ok) {
      log.warn("rejected /notify", { reason: verified.reason });
      return { status: 401, body: { error: { code: "invalid_signature", message: verified.reason } } };
    }
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: { error: { code: "invalid_json", message: "Body is not JSON" } } };
    }
    const parsed = NotifySchema.safeParse(json);
    if (!parsed.success) {
      return { status: 400, body: { error: { code: "invalid_payload", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") } } };
    }
    const notice = parsed.data;
    if (!this.notifyIds.claim(notice.id)) return { status: 200, body: { ok: true, duplicate: true } };
    try {
      const sent = await this.messenger.sendToOwner(notice.text);
      log.info("notified owner", { type: notice.type, id: notice.id });
      return { status: 200, body: { ok: true, sent: Boolean(sent) } };
    } catch (err) {
      this.notifyIds.release(notice.id); // let the Worker's retry through
      if (err instanceof NotConnectedError) return { status: 503, body: { error: { code: "not_connected", message: err.message } } };
      log.error("notify send failed", { type: notice.type, id: notice.id, error: describeError(err) });
      return { status: 502, body: { error: { code: "send_failed", message: describeError(err) } } };
    }
  }

  /**
   * Always HTTP 200 while the process runs (Railway's healthcheck is liveness); `ok` says whether iMessage works:
   * connected, and (live mode) a Spectrum heartbeat within the last 90 s once the first one arrived (~every 10 s).
   */
  health(now = Date.now()): HttpResult {
    const status = this.messenger.status();
    const beat = status.last_heartbeat_at ? Date.parse(status.last_heartbeat_at) : null;
    const stale = status.state === "connected" && beat !== null && now - beat > 90_000;
    return { status: 200, body: { ok: status.state === "connected" && !stale, service: "crusonia-bridge", heartbeat_stale: stale, ...status } };
  }
}
