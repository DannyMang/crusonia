// The owner's only input is a tapback on one of our notices: 👍 approves that exact request, 👎 rejects it. There is no
// text command channel, so the bridge has nothing to say in answer to a text, a read receipt or an attachment.

/** What the bridge sends the Worker: a tapback on the bubble with this iMessage id. */
export type Command = { action: "react"; reaction: "like" | "dislike"; message_id: string };

/** Tapback emoji -> decision: 👍 approves, 👎 rejects; every other reaction means nothing. Skin tones are ignored. */
export function tapbackDecision(emoji: string | undefined): "like" | "dislike" | undefined {
  const base = (emoji ?? "").replace(/[︎️]|\uD83C[\uDFFB-\uDFFF]/g, "").trim();
  if (base === "👍") return "like";
  if (base === "👎") return "dislike";
  return undefined;
}
