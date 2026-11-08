// Phone handles. iMessage senders arrive as an E.164 number or an Apple ID email; the owner is configured as
// E.164. Comparisons normalize both sides; logs only ever show a masked handle.

/** Digits with a leading +, or a lowercased email. Undefined for anything else. */
export function normalizeHandle(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (value.includes("@")) return value.toLowerCase();
  // Strip spaces, dashes, dots and parentheses that some sources keep ("+1 (415) 555-0123", "tel:+1...").
  const digits = value.replace(/^tel:/i, "").replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(digits) ? digits : undefined;
}

export function isE164(raw: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(raw.trim());
}

/** "+1******0123" / "d***@example.com": enough to recognize in a log, not enough to dial. */
export function maskHandle(raw: string | undefined | null): string {
  if (!raw) return "<none>";
  if (raw.includes("@")) {
    const [user, domain] = raw.split("@", 2);
    return `${(user ?? "").slice(0, 1)}***@${domain ?? ""}`;
  }
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.length <= 6) return "***";
  return `${digits.slice(0, 2)}${"*".repeat(Math.max(digits.length - 6, 1))}${digits.slice(-4)}`;
}

/** True only when `sender` is one of the owner's handles (OWNER_PHONE plus optional aliases). */
export function isOwner(sender: string | undefined | null, ownerHandles: readonly string[]): boolean {
  const s = normalizeHandle(sender);
  if (!s) return false;
  return ownerHandles.some((h) => normalizeHandle(h) === s);
}
