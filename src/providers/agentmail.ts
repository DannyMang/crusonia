// Thin AgentMail REST client (https://docs.agentmail.to). Only what the core loop needs: send, reply,
// and list-by-label for reconciling ambiguous sends. AgentMail is for opted-in contacts only.
import { defaultFetch, requestJson, type FetchFn } from "./http.ts";

export const AGENTMAIL_BASE = "https://api.agentmail.to/v0";

export type SendInput = { to: string; subject: string; text: string; html?: string; labels?: string[]; reply_to?: string };
export type ReplyInput = { text: string; html?: string; labels?: string[] };
export type SentMessage = { message_id: string; thread_id: string };
export type MessageItem = { message_id: string; thread_id: string; labels: string[]; timestamp: string };

export class AgentMailClient {
  constructor(
    private readonly apiKey: string,
    private readonly inboxId: string,
    private readonly fetchFn: FetchFn = defaultFetch,
    private readonly baseUrl = AGENTMAIL_BASE,
  ) {}

  private url(path: string) {
    return `${this.baseUrl}/inboxes/${encodeURIComponent(this.inboxId)}${path}`;
  }

  private headers() {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  /** POST /inboxes/{inbox_id}/messages/send. Not idempotent: callers mark the draft `sending` first. */
  send(input: SendInput): Promise<SentMessage> {
    return requestJson<SentMessage>("agentmail", this.fetchFn, this.url("/messages/send"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(input),
    });
  }

  /** POST /inboxes/{inbox_id}/messages/{message_id}/reply. Message ids look like `<abc@agentmail.to>`. */
  reply(messageId: string, input: ReplyInput): Promise<SentMessage> {
    return requestJson<SentMessage>("agentmail", this.fetchFn, this.url(`/messages/${encodeURIComponent(messageId)}/reply`), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(input),
    });
  }

  /** GET /inboxes/{inbox_id}/messages?labels=... (most recent first). */
  async listByLabels(labels: string[], limit = 5): Promise<MessageItem[]> {
    const qs = new URLSearchParams({ limit: String(limit) });
    for (const label of labels) qs.append("labels", label);
    const res = await requestJson<{ messages?: MessageItem[] }>("agentmail", this.fetchFn, this.url(`/messages?${qs}`), {
      method: "GET",
      headers: this.headers(),
    });
    return res.messages ?? [];
  }
}

/** The label that ties an AgentMail message to the draft it was sent from (used to reconcile). */
export const draftLabel = (draftId: string) => `draft-${draftId}`;
