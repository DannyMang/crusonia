// CSV import fields and the first guess at which column feeds which field. Pure, so `bun test` covers it
// (test/web-import.test.ts).

export const IMPORT_FIELDS = ["email", "name", "company", "domain", "title", "consent", "consent_at", "source"] as const;
export type ImportMapField = (typeof IMPORT_FIELDS)[number];

// First match wins; consent_at before consent so "Opt-in date" is not read as the opt-in itself.
const GUESS: [ImportMapField, RegExp][] = [
  ["email", /e-?mail/i],
  ["consent_at", /(opt(ed)?[\s_-]?in|consent|subscri).*\b(date|at|time|on)\b|^(date|signed up)/i],
  ["consent", /opt(ed)?[\s_-]?in|consent|subscri|permission/i],
  ["name", /^(full ?)?name$|contact|person/i],
  ["company", /company|organi[sz]ation|^org|account/i],
  ["domain", /domain|website|url|site/i],
  ["title", /title|role|position|job/i],
  ["source", /source|cohort|event|campaign/i],
];

/** CSV column -> field ("" = skip). Each field goes to at most one column. */
export function guessMapping(columns: string[]): Record<string, ImportMapField | ""> {
  const used = new Set<ImportMapField>();
  const out: Record<string, ImportMapField | ""> = {};
  for (const col of columns) {
    const hit = GUESS.find(([f, re]) => !used.has(f) && re.test(col));
    out[col] = hit ? hit[0] : "";
    if (hit) used.add(hit[0]);
  }
  return out;
}

/** Assigns `field` to `col`, taking it off any other column. */
export function assignField(map: Record<string, ImportMapField | "">, col: string, field: ImportMapField | ""): Record<string, ImportMapField | ""> {
  return Object.fromEntries(Object.entries(map).map(([c, f]) => [c, c === col ? field : field && f === field ? "" : f]));
}

/** Field -> column, as the API takes it. */
export function toMapping(map: Record<string, ImportMapField | "">): Partial<Record<ImportMapField, string>> {
  const m: Partial<Record<ImportMapField, string>> = {};
  for (const [col, field] of Object.entries(map)) if (field) m[field] = col;
  return m;
}
