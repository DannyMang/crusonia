// Owner text -> command. Deliberately strict: a decision needs an explicit verb and the approval's code, so an
// ambiguous "yes" or "ok" never approves anything. Codes are the approvals' 4-character short codes
// (alphabet 23456789ABCDEFGHJKMNPQRSTUVWXYZ, see src/ids.ts in the Worker); case does not matter.

export type Command =
  | { action: "approve"; code: string }
  | { action: "reject"; code: string; reason?: string }
  | { action: "edit"; code: string; text: string }
  | { action: "answer"; code: string; text: string }
  // A tapback on one of our notices (built by the bridge from a reaction, never parsed from text): the Worker finds
  // the approval and draft version that exact bubble was sent for.
  | { action: "react"; reaction: "like" | "dislike"; message_id: string }
  | { action: "status" }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "help" };

export type ParseResult = { ok: true; command: Command } | { ok: false; reply: string };

export const HELP_TEXT = [
  "Crusonia commands:",
  "Tap 👍 on a draft or request to approve it, 👎 to reject (only that exact message's version).",
  "A <code>: approve (sends the email, or allows the agent's tool call)",
  "R <code> [reason]: reject the draft, or deny the tool call",
  "E <code> <new text>: replace the email body (you then approve the new version)",
  "<code> <answer>: answer an agent's question",
  "status: what is waiting for you",
  "pause / resume: stop or restart all sending and agent work",
].join("\n");

const UNKNOWN = "Sorry, I didn't get that. Text help for commands.";

// Explicit verbs accept any 4 letters/digits so a mistyped code gets a clear "not found" from Crusonia.
const ANY_CODE = "([A-Za-z0-9]{4})";
// A bare "<code> <answer>" only matches the real code alphabet (no 0, 1, I, L, O), so ordinary sentences
// rarely look like an answer.
const STRICT_CODE = "([2-9A-HJKMNP-Za-hjkmnp-z]{4})";

const MAX_TEXT = 10_000;

/** Turns non-breaking and zero-width spaces (which iOS sometimes inserts) into plain spaces, then trims. */
function clean(raw: string): string {
  return raw
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    .trim();
}

/** Tapback emoji -> decision: 👍 approves, 👎 rejects; every other reaction means nothing. Skin tones are ignored. */
export function tapbackDecision(emoji: string | undefined): "like" | "dislike" | undefined {
  const base = (emoji ?? "").replace(/[\uFE0E\uFE0F]|\uD83C[\uDFFB-\uDFFF]/g, "").trim();
  if (base === "👍") return "like";
  if (base === "👎") return "dislike";
  return undefined;
}

export function parseCommand(raw: string): ParseResult {
  const text = clean(raw);
  if (!text) return { ok: false, reply: UNKNOWN };
  if (text.length > MAX_TEXT + 20) return { ok: false, reply: `That message is too long (max ${MAX_TEXT} characters).` };

  const word = text.toLowerCase().replace(/[.!?]+$/, "");
  if (word === "help" || word === "?" || word === "commands" || text === "?") return { ok: true, command: { action: "help" } };
  if (word === "status") return { ok: true, command: { action: "status" } };
  if (word === "pause" || word === "stop") return { ok: true, command: { action: "pause" } };
  if (word === "resume" || word === "unpause" || word === "start") return { ok: true, command: { action: "resume" } };

  let m = new RegExp(`^(?:a|approve)\\s+${ANY_CODE}([\\s\\S]*)$`, "i").exec(text);
  if (m) {
    const code = m[1]!.toUpperCase();
    // Approving sends real email: refuse anything but the bare code (trailing punctuation is fine).
    if (m[2]!.replace(/[.!\s]+/g, "")) return { ok: false, reply: `To approve, send exactly: A ${code}` };
    return { ok: true, command: { action: "approve", code } };
  }

  m = new RegExp(`^(?:r|reject)\\s+${ANY_CODE}(?:\\s+([\\s\\S]+))?$`, "i").exec(text);
  if (m) {
    const reason = m[2]?.trim();
    return { ok: true, command: { action: "reject", code: m[1]!.toUpperCase(), ...(reason ? { reason: reason.slice(0, 1000) } : {}) } };
  }

  m = new RegExp(`^(?:e|edit)\\s+${ANY_CODE}(?:\\s+([\\s\\S]+))?$`, "i").exec(text);
  if (m) {
    const code = m[1]!.toUpperCase();
    const body = m[2]?.trim();
    if (!body) return { ok: false, reply: `Add the new email text: E ${code} <new text>` };
    return { ok: true, command: { action: "edit", code, text: body } };
  }

  m = new RegExp(`^${STRICT_CODE}\\s*[:,-]?\\s+([\\s\\S]+)$`).exec(text);
  if (m) return { ok: true, command: { action: "answer", code: m[1]!.toUpperCase(), text: m[2]!.trim() } };

  if (/^(?:a|r|e|approve|reject|edit)$/i.test(word)) return { ok: false, reply: `Add the code, e.g. ${word[0]!.toUpperCase()} 7KXM. Text status to see open codes.` };
  return { ok: false, reply: UNKNOWN };
}
