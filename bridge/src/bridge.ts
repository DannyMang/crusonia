// The bridge's logic, independent of HTTP and of the iMessage transport:
//   inbound  owner's iMessage -> parse -> signed POST /webhooks/photon on the Worker -> reply with its answer
//   outbound notices come from the Worker through the poller (poller.ts); handleNotify serves the local operator
//            endpoint (test message). Either way only OWNER_PHONE is ever texted.
import { z } from "zod";
import { HELP_TEXT, parseCommand, tapbackDecision, type Command } from "./commands.ts";
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

export class Bridge {
  private readonly config: Config;
  private readonly messenger: Messenger;
  private readonly fetchFn: FetchFn | undefined;
  private readonly notifyIds = new SeenIds();
  // Spectrum delivers at least once (reconnect catch-up): answer each inbound message once.
  private readonly inboundIds = new SeenIds(60 * 60 * 1000);
  private readonly workerRetryDelaysMs: number[] | undefined;

  constructor(opts: { config: Config; messenger: Messenger; fetch?: FetchFn; workerRetryDelaysMs?: number[] }) {
    this.config = opts.config;
    this.messenger = opts.messenger;
    this.fetchFn = opts.fetch;
    this.workerRetryDelaysMs = opts.workerRetryDelaysMs;
  }

  /** Every inbound iMessage lands here. Anything not from the owner is dropped and logged (masked). */
  async handleInbound(m: InboundMessage): Promise<void> {
    if (!isOwner(m.sender, this.config.ownerHandles)) {
      log.info("ignored message from non-owner", { from: maskHandle(m.sender), content: m.contentType });
      return;
    }
    if (!m.isDirect) {
      log.info("ignored owner message in a group chat", { content: m.contentType });
      return;
    }
    if (!this.inboundIds.claim(m.id)) {
      log.debug("duplicate inbound delivery", { id: m.id });
      return;
    }
    const reply = await this.answer(m);
    if (!reply) return; // e.g. a tapback on a message that is not one of our notices
    try {
      await m.reply(reply);
    } catch (err) {
      log.error("reply to owner failed", { error: describeError(err) });
    }
  }

  private async answer(m: InboundMessage): Promise<string> {
    let command: Command;
    if (m.contentType === "reaction") {
      // Only 👍 / 👎 on a specific bubble mean something; other tapbacks (❤️ on "Approved.") are left alone.
      const decision = tapbackDecision(m.reaction?.emoji);
      if (!decision || !m.reaction?.targetId) return "";
      command = { action: "react", reaction: decision, message_id: m.reaction.targetId };
    } else {
      if (m.text === undefined) return "I can only read text messages. Text help for commands.";
      const parsed = parseCommand(m.text);
      if (!parsed.ok) return parsed.reply;
      if (parsed.command.action === "help") return HELP_TEXT;
      command = parsed.command;
    }
    log.info("owner command", { action: command.action, id: m.id });
    const result = await postCommand(
      {
        id: m.id,
        from: normalizeHandle(m.sender) ?? this.config.ownerPhone,
        received_at: m.receivedAt.toISOString(),
        command,
      },
      { workerUrl: this.config.workerUrl, secret: this.config.bridgeSecret, fetch: this.fetchFn, retryDelaysMs: this.workerRetryDelaysMs },
    );
    return result.reply;
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
