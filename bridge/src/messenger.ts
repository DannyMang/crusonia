// The iMessage side of the bridge behind one small interface, so the bridge logic runs the same against
// Photon Spectrum (live) and an in-memory mock (tests and local runs).
//
// Live: Spectrum Stable (`@spectrum-ts/core` + `@spectrum-ts/imessage`) authenticates with the project ID and
// secret and holds a gRPC stream to Photon's iMessage lines. The SDK already reconnects that stream with capped,
// jittered backoff and catches up from its cursor; the supervisor below additionally restarts the whole client
// when initialization fails or the stream ends, with its own backoff, so the process never needs a manual restart.
import { describeError, log } from "./log.ts";

export type InboundMessage = {
  id: string;
  /** The sender's handle: E.164 phone or Apple ID email. */
  sender: string | undefined;
  /** Text content; undefined for reactions, attachments and other content types. */
  text: string | undefined;
  contentType: string;
  /** A tapback (content type "reaction"): its emoji and the id of the message it was put on. */
  reaction?: { emoji: string; targetId: string | undefined };
  /** Sent by our own line (an echo). Never acted on or answered. */
  fromSelf?: boolean;
  /** False for group chats. */
  isDirect: boolean;
  receivedAt: Date;
  /** Replies in the same conversation (same Photon line the owner texted). */
  reply(text: string): Promise<void>;
};

export type ConnectionState = "starting" | "connecting" | "connected" | "reconnecting" | "stopped";

export type MessengerStatus = {
  mode: "live" | "mock";
  state: ConnectionState;
  connected_since: string | null;
  last_heartbeat_at: string | null;
  last_inbound_at: string | null;
  reconnects: number;
  last_error: string | null;
};

export interface Messenger {
  start(onMessage: (m: InboundMessage) => Promise<void>): void;
  /**
   * Texts OWNER_PHONE and returns the sent message's id (what a tapback on that bubble points at), when the platform
   * reports one. Throws NotConnectedError while the connection is down.
   */
  sendToOwner(text: string): Promise<{ messageId?: string }>;
  status(): MessengerStatus;
  stop(): Promise<void>;
}

export class NotConnectedError extends Error {
  constructor() {
    super("iMessage connection is not up");
    this.name = "NotConnectedError";
  }
}

// ---------------------------------------------------------------------------------------------------------
// Live (Spectrum) with a supervisor
// ---------------------------------------------------------------------------------------------------------

/** One live client: its message stream, a way to open the owner's DM, and shutdown. */
export type Connection = {
  messages: AsyncIterable<InboundMessage>;
  /** `send` resolves to the sent message's id, if known. */
  openDm(phone: string): Promise<{ send(text: string): Promise<string | undefined> }>;
  stop(): Promise<void>;
};

export type Connect = (hooks: { onHeartbeat: () => void; signal: AbortSignal }) => Promise<Connection>;

export type BackoffOptions = { initialMs: number; maxMs: number; /** a connection up this long resets the backoff */ stableMs: number };
const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 1_000, maxMs: 60_000, stableMs: 60_000 };
const CONNECT_TIMEOUT_MS = 30_000;

export function backoffDelay(attempt: number, opts: BackoffOptions, random: () => number = Math.random): number {
  const base = Math.min(opts.initialMs * 2 ** Math.max(attempt, 0), opts.maxMs);
  return Math.round(base * (0.5 + random() * 0.5)); // jitter: 50-100% of the step
}

export class SupervisedMessenger implements Messenger {
  private state: ConnectionState = "starting";
  private conn: Connection | undefined;
  private dm: { send(text: string): Promise<string | undefined> } | undefined;
  private connectedSince: Date | null = null;
  private lastHeartbeat: Date | null = null;
  private lastInbound: Date | null = null;
  private lastError: string | null = null;
  private reconnects = 0;
  private stopping = false;
  private wake: (() => void) | undefined;
  private loop: Promise<void> | undefined;
  private readonly connect: Connect;
  private readonly ownerPhone: string;
  private readonly backoff: BackoffOptions;
  private readonly mode: "live" | "mock";

  constructor(opts: { connect: Connect; ownerPhone: string; backoff?: Partial<BackoffOptions>; mode?: "live" | "mock" }) {
    this.connect = opts.connect;
    this.ownerPhone = opts.ownerPhone;
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff };
    this.mode = opts.mode ?? "live";
  }

  start(onMessage: (m: InboundMessage) => Promise<void>): void {
    if (this.loop) return;
    this.loop = this.run(onMessage);
  }

  private async run(onMessage: (m: InboundMessage) => Promise<void>) {
    let attempt = 0;
    // Messages are handled one at a time, in order, without blocking the stream.
    let queue: Promise<void> = Promise.resolve();
    while (!this.stopping) {
      this.state = attempt === 0 && this.reconnects === 0 ? "connecting" : "reconnecting";
      const started = Date.now();
      try {
        const signal = AbortSignal.timeout(CONNECT_TIMEOUT_MS);
        this.conn = await this.connect({ onHeartbeat: () => (this.lastHeartbeat = new Date()), signal });
        if (this.stopping) break;
        this.state = "connected";
        this.connectedSince = new Date();
        this.lastError = null;
        log.info("spectrum connected", { reconnects: this.reconnects });
        for await (const message of this.conn.messages) {
          this.lastInbound = new Date();
          if (Date.now() - started > this.backoff.stableMs) attempt = 0;
          queue = queue.then(() => onMessage(message)).catch((err) => log.error("inbound handler failed", { error: describeError(err) }));
          if (this.stopping) break;
        }
        if (!this.stopping) throw new Error("message stream ended");
      } catch (err) {
        if (this.stopping) break;
        this.lastError = describeError(err);
        log.warn("spectrum connection lost", { error: this.lastError, attempt });
      } finally {
        const conn = this.conn;
        this.conn = undefined;
        this.dm = undefined;
        this.connectedSince = null;
        await conn?.stop().catch((err) => log.warn("spectrum stop failed", { error: describeError(err) }));
      }
      if (this.stopping) break;
      if (Date.now() - started > this.backoff.stableMs) attempt = 0;
      const delay = backoffDelay(attempt++, this.backoff);
      this.reconnects++;
      this.state = "reconnecting";
      log.info("spectrum reconnecting", { in_ms: delay, attempt });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
    await queue;
    this.state = "stopped";
  }

  async sendToOwner(text: string): Promise<{ messageId?: string }> {
    const conn = this.conn;
    if (!conn || this.state !== "connected") throw new NotConnectedError();
    try {
      this.dm ??= await conn.openDm(this.ownerPhone);
      const messageId = await this.dm.send(text);
      return messageId ? { messageId } : {};
    } catch (err) {
      this.dm = undefined; // reopen next time
      throw err;
    }
  }

  status(): MessengerStatus {
    return {
      mode: this.mode,
      state: this.state,
      connected_since: this.connectedSince?.toISOString() ?? null,
      last_heartbeat_at: this.lastHeartbeat?.toISOString() ?? null,
      last_inbound_at: this.lastInbound?.toISOString() ?? null,
      reconnects: this.reconnects,
      last_error: this.lastError,
    };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.conn?.stop().catch(() => {});
    await this.loop;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Mock: an in-memory iMessage for tests and `SPECTRUM_MODE=mock` local runs
// ---------------------------------------------------------------------------------------------------------

export type OutboxEntry = { id: string; to: string; text: string; at: string };

export class MockMessenger implements Messenger {
  readonly outbox: OutboxEntry[] = [];
  connected = true;
  failSends = false;
  private handler: ((m: InboundMessage) => Promise<void>) | undefined;
  private seq = 0;
  private readonly ownerPhone: string;

  constructor(ownerPhone: string) {
    this.ownerPhone = ownerPhone;
  }

  start(onMessage: (m: InboundMessage) => Promise<void>): void {
    this.handler = onMessage;
  }

  async sendToOwner(text: string): Promise<{ messageId?: string }> {
    if (!this.connected) throw new NotConnectedError();
    if (this.failSends) throw new Error("mock send failure");
    const id = `mock-out-${++this.seq}`;
    this.outbox.push({ id, to: this.ownerPhone, text, at: new Date().toISOString() });
    return { messageId: id };
  }

  /**
   * Simulates an inbound iMessage (or, with `reaction`, a tapback on the message `reaction.targetId`) and waits until
   * the bridge has handled it.
   */
  async inject(input: {
    from: string;
    text?: string;
    id?: string;
    contentType?: string;
    isDirect?: boolean;
    reaction?: { emoji: string; targetId: string | undefined };
    fromSelf?: boolean;
  }): Promise<void> {
    if (!this.handler) throw new Error("MockMessenger.start() was not called");
    const from = input.from;
    await this.handler({
      id: input.id ?? `mock-${++this.seq}-${Date.now()}`,
      sender: from,
      text: input.text,
      contentType: input.contentType ?? (input.reaction ? "reaction" : input.text === undefined ? "attachment" : "text"),
      ...(input.reaction ? { reaction: input.reaction } : {}),
      ...(input.fromSelf ? { fromSelf: true } : {}),
      isDirect: input.isDirect ?? true,
      receivedAt: new Date(),
      reply: async (text) => {
        if (this.failSends) throw new Error("mock send failure");
        this.outbox.push({ id: `mock-out-${++this.seq}`, to: from, text, at: new Date().toISOString() });
      },
    });
  }

  status(): MessengerStatus {
    return {
      mode: "mock",
      state: this.connected ? "connected" : "reconnecting",
      connected_since: null,
      last_heartbeat_at: null,
      last_inbound_at: null,
      reconnects: 0,
      last_error: null,
    };
  }

  async stop(): Promise<void> {
    this.connected = false;
  }
}
