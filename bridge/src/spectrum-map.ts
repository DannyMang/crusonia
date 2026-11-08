// Maps Spectrum SDK [space, message] pairs to the bridge's InboundMessage. No SDK import, so tests load it freely.
import type { InboundMessage } from "./messenger.ts";

export type RawSpace = { type?: string; send(text: string): Promise<unknown> };
export type RawMessage = {
  id: string;
  direction?: "inbound" | "outbound";
  platform?: string;
  sender?: { id?: string; address?: string; kind?: string };
  content: { type: string; text?: string; emoji?: string; target?: { id?: string } };
  timestamp?: Date;
};

/** Maps an SDK [space, message] pair to the bridge's shape; null for our own outbound echoes. */
export function toInbound(space: RawSpace, message: RawMessage): InboundMessage | null {
  if (message.direction === "outbound" || message.sender?.kind === "agent") return null;
  const contentType = message.content?.type ?? "unknown";
  return {
    id: String(message.id),
    sender: message.sender?.id ?? message.sender?.address,
    text: contentType === "text" ? message.content.text : undefined,
    contentType,
    ...(contentType === "reaction" && typeof message.content.emoji === "string"
      ? { reaction: { emoji: message.content.emoji, targetId: message.content.target?.id === undefined ? undefined : String(message.content.target.id) } }
      : {}),
    isDirect: space.type !== "group",
    receivedAt: message.timestamp instanceof Date ? message.timestamp : new Date(),
    reply: async (text) => {
      await space.send(text);
    },
  };
}
