// No 0/O/1/I/L so codes survive being read off a phone screen.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/**
 * Approval codes are one namespace across every workspace (approvals.code is the primary key) and rows are never deleted,
 * so one workspace looping drafts could use up a short code space for everyone. 6 characters give 887 million.
 */
export function shortCode(length = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

export function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

// Stable A/B assignment: same email always lands in the same variant.
export async function variantFor(email: string): Promise<"A" | "B"> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email)));
  return hash[0] % 2 === 0 ? "A" : "B";
}
