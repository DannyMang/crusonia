// Reply classification. Keyword rules for now; `ReplyClassifier` is the hook for an LLM later.
// Inbound email is untrusted data: it is only matched against patterns here, never followed.

export const REPLY_LABELS = ["interested", "not_interested", "unsubscribe", "out_of_office", "other"] as const;
export type ReplyLabel = (typeof REPLY_LABELS)[number];

export type ReplyInput = { subject?: string | null; text?: string | null };

export interface ReplyClassifier {
  classify(input: ReplyInput): Promise<ReplyLabel>;
}

// Order matters: an unsubscribe request wins over everything, and auto-replies are recognised before
// any sentiment so "I'm out of office, interested when back" is not counted as a positive reply.
const RULES: ReadonlyArray<[ReplyLabel, RegExp[]]> = [
  [
    "unsubscribe",
    [
      /\bunsubscribe\b/,
      /\bopt(?:-|\s)?out\b/,
      /\bremove me\b/,
      /\btake me off\b/,
      /\b(?:stop|quit|don'?t|do not)\s+(?:emailing|contacting|messaging|writing to)\b/,
      /\bno (?:more|further) (?:emails?|messages|contact)\b/,
      /\bdo not contact\b/,
    ],
  ],
  [
    "out_of_office",
    [
      /\bout of (?:the )?office\b/,
      /\bauto(?:matic)?[-\s]?reply\b/,
      /\bautoreply\b/,
      /\b(?:on|currently on) (?:vacation|holiday|leave|pto|parental leave|annual leave)\b/,
      /\b(?:away|out) until\b/,
      /\blimited (?:access to|internet access)\b/,
      /\bwill (?:be back|return) on\b/,
      /\booo\b/,
    ],
  ],
  [
    "not_interested",
    [
      /\bnot interested\b/,
      /\bno thanks?\b/,
      /\bno,? thank you\b/,
      /\bnot (?:a )?(?:good )?fit\b/,
      /\bnot (?:the )?right (?:time|fit)\b/,
      /\bnot (?:looking|in the market)\b/,
      /\bwe(?:'re| are) (?:all )?set\b/,
      /\bpass(?:ing)? on this\b/,
      /\bnot for us\b/,
      /\bplease don'?t follow up\b/,
    ],
  ],
  [
    "interested",
    [
      /\binterested\b/,
      /\b(?:let'?s|happy to|glad to|love to|would like to|keen to) (?:chat|talk|connect|meet|hop on|learn more|see|try)\b/,
      /\b(?:book|schedule|set up|grab) (?:a )?(?:call|meeting|time|demo|chat)\b/,
      /\btell me more\b/,
      /\bsounds (?:good|great|interesting)\b/,
      /\bsend (?:me )?(?:more )?(?:info|details|a link|the deck)\b/,
      /\bwhen (?:are|is) (?:you|a good time)\b/,
      /\bcalendly\.com\b/,
      /\bwhat(?:'s| is) the pricing\b/,
    ],
  ],
];

export function classifyReplyText(input: ReplyInput): ReplyLabel {
  const haystack = `${input.subject ?? ""}\n${input.text ?? ""}`.toLowerCase().replace(/[’‘]/g, "'");
  for (const [label, patterns] of RULES) {
    if (patterns.some((p) => p.test(haystack))) return label;
  }
  return "other";
}

export const keywordClassifier: ReplyClassifier = {
  async classify(input) {
    return classifyReplyText(input);
  },
};

// TODO(llm-classifier): an LLM classifier implementing ReplyClassifier. It must receive the reply as
// quoted data with a fixed label set, and fall back to keywordClassifier on error or an unknown label.

/** The new text of a reply without quoted history: prefer AgentMail's extracted_text, else strip quotes. */
export function replyText(message: { extracted_text?: string | null; text?: string | null; html?: string | null }): string {
  if (message.extracted_text?.trim()) return message.extracted_text;
  const text = message.text?.trim() ? message.text : htmlToText(message.html ?? "");
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^On .+wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message/i.test(line.trim())) break;
    if (line.trimStart().startsWith(">")) continue;
    lines.push(line);
  }
  return lines.join("\n").trim();
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
}
