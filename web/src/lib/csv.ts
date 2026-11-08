// A small RFC 4180 CSV reader (quoted fields, "" escapes, CRLF), for the import screen's column list and the dev
// mocks. The server parses the file itself (src/services/csv.ts); this only has to agree on the header row.
// Pure, so `bun test` covers it (test/web-csv.test.ts).

export function parseCsv(text: string, maxRows = Infinity): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
      if (rows.length >= maxRows) return rows;
    } else field += ch;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== "")) rows.push(row);
  return rows;
}

/** The header row, trimmed. */
export function csvColumns(text: string): string[] {
  return (parseCsv(text, 1)[0] ?? []).map((c) => c.trim());
}

/** Data rows (header excluded). */
export function csvRowCount(text: string): number {
  return Math.max(0, parseCsv(text).length - 1);
}
