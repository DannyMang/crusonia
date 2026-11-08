/**
 * Only same-origin paths ("/app/leads"), never "//evil.com", "/\evil.com" or "https://…". Browsers drop tabs and newlines
 * and read backslashes as slashes in a URL, so the path is also parsed the way a browser would. Pure.
 */
export function safeNext(v: string | null | undefined): string | null {
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\")) return null;
  try {
    return new URL(v, "https://same-origin.invalid").origin === "https://same-origin.invalid" ? v : null;
  } catch {
    return null;
  }
}
