// Final · Import · Map and preview (/app/leads/import). Pick a CSV, map its columns to Crusonia fields, check the
// preview (new / duplicate / invalid, consent, source) and import. The preview writes nothing.
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useImportCommit, useImportPreview, type ImportBody, type ImportMapping, type ImportPreviewRow } from "../../api/import.ts";
import { Page } from "../../components/AppShell.tsx";
import { UploadIcon } from "../../components/icons.tsx";
import { Button, ButtonLink, EmptyState, QueryError, Skeleton } from "../../components/ui.tsx";
import { csvColumns, csvRowCount } from "../../lib/csv.ts";
import { cx, num, shortDate } from "../../lib/format.ts";
import { assignField, guessMapping, IMPORT_FIELDS, toMapping, type ImportMapField } from "../../lib/import-mapping.ts";

const MAX_BYTES = 5 * 1024 * 1024;

const FIELD_LABEL: Record<ImportMapField, string> = {
  email: "Email",
  name: "Name",
  company: "Company",
  domain: "Domain",
  title: "Title",
  consent: "Consent",
  consent_at: "Consent date",
  source: "Source",
};

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

type Picked = { name: string; csv: string; rows: number; columns: string[]; key: string };

export default function ImportCsv() {
  const navigate = useNavigate();
  const [file, setFile] = useState<Picked | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [map, setMap] = useState<Record<string, ImportMapField | "">>({});
  const [source, setSource] = useState("");
  const commit = useImportCommit();

  async function pick(f: File | undefined) {
    setPickError(null);
    if (!f) return;
    if (!/\.csv$/i.test(f.name) && f.type !== "text/csv") return setPickError("Choose a .csv file.");
    if (f.size > MAX_BYTES) return setPickError("This file is larger than 5 MB. Split it and import the parts.");
    const csv = await f.text();
    const columns = csvColumns(csv);
    if (!columns.length) return setPickError("This file is empty.");
    setFile({ name: f.name, csv, rows: csvRowCount(csv), columns, key: `${f.name}:${f.size}:${f.lastModified}` });
    setMap(guessMapping(columns));
    setSource(f.name.replace(/\.csv$/i, "").replace(/[-_]+/g, " "));
    commit.reset();
  }

  const mapping = useMemo<ImportMapping>(() => toMapping(map), [map]);
  const debouncedSource = useDebounced(source);
  const body: ImportBody | null = file ? { csv: file.csv, mapping, source: debouncedSource.trim() } : null;
  const preview = useImportPreview(body, file?.key ?? "");
  const counts = preview.data?.counts;
  const importable = (counts?.new ?? 0) + (counts?.duplicate ?? 0);
  const n = counts?.new ?? 0;

  const setField = (col: string, field: ImportMapField | "") => setMap((m) => assignField(m, col, field));

  if (commit.isSuccess) {
    const r = commit.data;
    return (
      <Page className="grow gap-5 px-4 pb-12 pt-10 sm:px-8">
        <Crumb />
        <div className="rounded-xl border border-[#200D0D1A]">
          <EmptyState
            title={`${num(r.created)} ${r.created === 1 ? "contact" : "contacts"} imported`}
            body={[r.updated ? `${num(r.updated)} merged` : null, r.skipped ? `${num(r.skipped)} skipped` : null].filter(Boolean).join(" · ") || undefined}
            action={
              <div className="flex gap-2">
                <ButtonLink to="/app/leads" variant="primary" size="md">
                  View leads
                </ButtonLink>
                <Button
                  variant="outline"
                  size="md"
                  onClick={() => {
                    commit.reset();
                    setFile(null);
                  }}
                >
                  Import another
                </Button>
              </div>
            }
          />
        </div>
      </Page>
    );
  }

  return (
    <Page className="grow gap-5 px-4 pb-12 pt-10 sm:px-8">
      <div className="flex min-h-10 flex-wrap items-center justify-between gap-3">
        <Crumb file={file} />
        <div className="flex items-center gap-2">
          <Button variant="outline" size="md" onClick={() => navigate("/app/leads")}>
            Cancel
          </Button>
          {file ? (
            <Button
              variant="primary"
              size="md"
              className="px-4.5 font-semibold"
              disabled={!importable || !mapping.email || preview.isFetching}
              loading={commit.isPending}
              onClick={() => body && commit.mutate({ ...body, source: source.trim() })}
            >
              {n === 0 && importable ? `Merge ${num(importable)} ${importable === 1 ? "contact" : "contacts"}` : `Import ${num(n)} ${n === 1 ? "contact" : "contacts"}`}
            </Button>
          ) : null}
        </div>
      </div>

      {commit.isError ? <QueryError error={commit.error} what="import" /> : null}

      {!file ? (
        <DropZone onPick={pick} error={pickError} />
      ) : (
        <div className="flex flex-col items-start gap-5 lg:flex-row">
          <section aria-label="Mapping" className="flex w-full shrink-0 flex-col overflow-clip rounded-xl border border-[#200D0D1A] lg:w-90">
            <div className="flex h-9 shrink-0 items-center border-b border-b-[#200D0D14] bg-[#200D0D06] px-4 text-xs/4 font-medium text-muted">
              <div className="min-w-0 grow basis-0">CSV column</div>
              <div className="w-37.5 shrink-0">Crusonia field</div>
            </div>
            {file.columns.map((col, i) => {
              const field = map[col] ?? "";
              return (
                <div key={col} className={cx("flex h-11.5 shrink-0 items-center gap-2 px-4", i > 0 && "border-t border-t-[#200D0D0F]")}>
                  <div className={cx("min-w-0 grow basis-0 truncate text-[13px]/4", field ? "text-ink" : "text-muted")}>{col}</div>
                  <div className="relative w-37.5 shrink-0">
                    <select
                      value={field}
                      aria-label={`Field for ${col}`}
                      onChange={(e) => setField(col, e.target.value as ImportMapField | "")}
                      className={cx(
                        "h-8 w-full appearance-none rounded-lg bg-white pl-2.5 pr-7 text-[13px]/4 font-medium outline-none focus:border-ink",
                        field ? "border border-[#200D0D1A] text-ink" : "border border-dashed border-[#200D0D33] text-muted",
                      )}
                    >
                      <option value="">Skip</option>
                      {IMPORT_FIELDS.map((f) => (
                        <option key={f} value={f}>
                          {FIELD_LABEL[f]}
                        </option>
                      ))}
                    </select>
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
                      <path d="M2.5 4l2.5 2.5L7.5 4" fill="none" stroke="#200D0D" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                </div>
              );
            })}
            <label className="flex flex-col gap-1.5 border-t border-t-[#200D0D14] bg-panel px-4 pb-4 pt-3.5">
              <span className="text-xs/4 font-medium text-muted">Source</span>
              <input
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className="h-8.5 shrink-0 rounded-lg border border-panel-line bg-white px-2.5 text-[13px]/4 font-medium text-ink outline-none focus:border-ink"
              />
            </label>
          </section>

          <PreviewTable rows={preview.data?.rows ?? null} counts={counts ?? null} loading={preview.isPending} error={preview.error} onRetry={() => void preview.refetch()} />
        </div>
      )}
    </Page>
  );
}

function Crumb({ file }: { file?: Picked | null }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Link to="/app/leads" className="shrink-0 text-sm/4.5 text-muted hover:text-ink">
        Leads /
      </Link>
      <h1 className="shrink-0 text-xl/7 font-semibold tracking-[-0.01em] text-ink">Import CSV</h1>
      {file ? (
        <span className="flex h-6.5 min-w-0 items-center gap-1.5 rounded-full bg-pill px-2.5 text-xs/4 font-medium text-ink">
          <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden className="shrink-0">
            <path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z" fill="none" stroke="#200D0D" strokeWidth="2" strokeLinejoin="round" />
            <path d="M14 3v6h6" fill="none" stroke="#200D0D" strokeWidth="2" strokeLinejoin="round" />
          </svg>
          <span className="truncate">
            {file.name} · {num(file.rows)} {file.rows === 1 ? "row" : "rows"}
          </span>
        </span>
      ) : null}
    </div>
  );
}

function DropZone({ onPick, error }: { onPick: (f: File | undefined) => void; error: string | null }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e: DragEvent) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setOver(false);
        onPick(e.dataTransfer.files[0]);
      }}
      className={cx("flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-16", over ? "border-ink bg-panel" : "border-[#200D0D33]")}
    >
      <span className="flex size-9 items-center justify-center rounded-full bg-panel text-green">
        <UploadIcon />
      </span>
      <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" aria-label="CSV file" onChange={(e: ChangeEvent<HTMLInputElement>) => onPick(e.target.files?.[0])} />
      <Button variant="primary" size="md" onClick={() => input.current?.click()}>
        Choose a CSV
      </Button>
      {error ? (
        <div role="alert" className="text-[13px]/4 font-medium text-[#B42318]">
          {error}
        </div>
      ) : null}
    </div>
  );
}

const SHOWN = 6;

/** "Nov 2". A bare date (or UTC midnight) is a calendar day: shown as is, not shifted into the local time zone. */
function dayLabel(v: string): string {
  const bare = /^\d{4}-\d{2}-\d{2}$/.test(v) || /T00:00:00(\.0+)?Z$/.test(v);
  return new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(bare ? { timeZone: "UTC" } : {}) });
}

const STATUS_PILL: Record<ImportPreviewRow["status"], { label: string; className: string }> = {
  new: { label: "New", className: "bg-lime text-ink" },
  duplicate: { label: "Duplicate", className: "bg-pill text-ink" },
  invalid: { label: "Invalid", className: "border border-[#B42318] text-[#B42318]" },
};

function PreviewTable({
  rows,
  counts,
  loading,
  error,
  onRetry,
}: {
  rows: ImportPreviewRow[] | null;
  counts: { new: number; duplicate: number; invalid: number } | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const [all, setAll] = useState(false);
  const shown = rows ? (all ? rows : rows.slice(0, SHOWN)) : [];
  const more = rows ? rows.length - SHOWN : 0;
  return (
    <section aria-label="Preview" className="flex w-full min-w-0 flex-col overflow-clip rounded-xl border border-[#200D0D1A] lg:w-auto lg:grow lg:basis-0">
      <div className="flex items-center justify-between gap-3 border-b border-b-[#200D0D14] px-4 py-3.5">
        <h2 className="text-[15px]/4.5 font-medium text-ink">Preview</h2>
        {counts ? (
          <div className="text-xs/4 tabular-nums text-muted">
            {num(counts.new)} new · {num(counts.duplicate)} {counts.duplicate === 1 ? "duplicate" : "duplicates"} · {num(counts.invalid)} invalid
          </div>
        ) : null}
      </div>
      {error ? (
        <div className="p-4">
          <QueryError error={error} what="the preview" onRetry={onRetry} />
        </div>
      ) : loading ? (
        <div className="flex flex-col gap-2 p-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : !rows?.length ? (
        <EmptyState title="No rows in this file" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-left">
            <thead>
              <tr className="h-8.5 border-b border-b-[#200D0D14] bg-[#200D0D06] text-xs/4 font-medium text-muted">
                <th scope="col" className="w-27 pl-4 font-medium">
                  Status
                </th>
                <th scope="col" className="font-medium">
                  Contact
                </th>
                <th scope="col" className="w-28 font-medium xl:w-33">
                  Company
                </th>
                <th scope="col" className="w-25 font-medium">
                  Consent
                </th>
                <th scope="col" className="w-26 pr-4 font-medium xl:w-33.5">
                  Source
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <PreviewRow key={r.row} r={r} first={i === 0} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows && more > 0 ? (
        <button type="button" onClick={() => setAll((v) => !v)} className="flex h-11 shrink-0 items-center border-t border-t-[#200D0D14] px-4 text-left text-[13px]/4 font-medium text-ink hover:bg-[#200D0D04]">
          {all ? "Show fewer rows" : `Show ${num(more)} more ${more === 1 ? "row" : "rows"}`}
        </button>
      ) : null}
    </section>
  );
}

function PreviewRow({ r, first }: { r: ImportPreviewRow; first: boolean }) {
  const pill = STATUS_PILL[r.status];
  const sub =
    r.status === "invalid"
      ? `${r.email ?? "—"} · ${r.reason ?? "not valid"}`
      : r.status === "duplicate"
        ? r.lead_id
          ? `Already a lead${r.existing_since ? ` since ${shortDate(r.existing_since)}` : ""} · merges`
          : "Repeated in this file"
        : (r.email ?? "");
  return (
    <tr className={cx("h-13.5", !first && "border-t border-t-[#200D0D0F]", r.status === "duplicate" && "bg-[#200D0D06]")}>
      <td className="pl-4">
        <span className={cx("inline-flex h-5.5 items-center rounded-full px-2.25 text-xs/4 font-medium", pill.className)}>{pill.label}</span>
      </td>
      <td className="max-w-0 pr-3">
        <div className="truncate text-[13px]/4 font-medium text-ink">{r.name ?? r.email ?? "—"}</div>
        <div className={cx("truncate text-xs/4", r.status === "invalid" ? "text-[#B42318]" : "text-muted")}>{sub}</div>
      </td>
      <td className={cx("max-w-0 truncate pr-3 text-[13px]/4", r.company || r.domain ? "text-ink" : "text-muted")}>{r.company ?? r.domain ?? "—"}</td>
      <td className={cx("whitespace-nowrap pr-3 text-[13px]/4", r.consent ? "text-ink" : "text-muted")}>{r.consent ? `Yes${r.consent_at ? ` · ${dayLabel(r.consent_at)}` : ""}` : "No"}</td>
      <td className="max-w-0 truncate pr-4 text-xs/4 text-muted">{r.source ?? "—"}</td>
    </tr>
  );
}
