// Import CSV: pick a file -> dry run (free, nothing written) shows what would happen -> import -> result.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type ChangeEvent, type DragEvent } from "react";
import { isApiError, type ImportResult } from "../../api.ts";
import { useApi } from "../../auth.tsx";
import { UploadIcon } from "../../components/icons.tsx";
import { Dialog } from "../../components/leads/Overlay.tsx";
import { Button, QueryError } from "../../components/ui.tsx";
import { cx, num, plural } from "../../lib/format.ts";

const MAX_BYTES = 5 * 1024 * 1024;

type Picked = { name: string; csv: string; rows: number };

// Reasons from the backend's import planner (src/services/csv.ts).
const SKIP_REASONS: Record<string, string> = {
  suppressed: "on the suppression list",
  duplicate_in_file: "duplicate rows in the file",
  invalid_email: "invalid email",
  missing_email_and_domain: "no email, domain or website",
  unchanged: "already up to date",
};

function skipReasons(r: ImportResult): [string, number][] {
  const raw = r.skip_reasons;
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > 0)
      .sort((a, b) => b[1] - a[1]);
  }
  const counts: Record<string, number> = {};
  for (const row of r.rows ?? []) if (row.status === "skipped") counts[row.reason] = (counts[row.reason] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

function columnsOf(r: ImportResult): [string, string][] {
  const raw = r.columns;
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string");
}

export function ImportCsvDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const [file, setFile] = useState<Picked | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const preview = useMutation({ mutationFn: (csv: string) => api.importCsv(csv, { dry_run: true }) });
  const run = useMutation({
    mutationFn: (csv: string) => api.importCsv(csv),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["leads"] });
      void qc.invalidateQueries({ queryKey: ["summary"] });
    },
  });

  function reset() {
    setFile(null);
    setPickError(null);
    preview.reset();
    run.reset();
  }

  function close() {
    onClose();
    reset();
  }

  async function pick(f: File | undefined) {
    if (!f) return;
    reset();
    if (f.size > MAX_BYTES) {
      setPickError("That file is larger than 5 MB. Split it into smaller files and import them one at a time.");
      return;
    }
    const csv = await f.text();
    const rows = Math.max(0, csv.trim().split(/\r?\n/).length - 1);
    setFile({ name: f.name, csv, rows });
    preview.mutate(csv);
  }

  const onInput = (e: ChangeEvent<HTMLInputElement>) => {
    void pick(e.target.files?.[0]);
    e.target.value = "";
  };
  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragging(false);
    void pick(e.dataTransfer.files?.[0]);
  };

  const p = preview.data;
  const done = run.data;
  const willWrite = (p?.created ?? 0) + (p?.updated ?? 0);

  return (
    <Dialog
      open={open}
      onClose={close}
      title={done ? "Import finished" : "Import leads from a CSV"}
      description={
        done
          ? undefined
          : "Columns we read: email, name (or first_name and last_name), title, company, domain, website, linkedin_url, and consent with consent_at."
      }
      footer={
        done ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="soft" onClick={close}>
              Cancel
            </Button>
            <Button
              disabled={!file || !p || willWrite === 0}
              loading={run.isPending}
              onClick={() => file && run.mutate(file.csv)}
            >
              {p && willWrite > 0 ? `Import ${plural(willWrite, "lead")}` : "Import"}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <ImportCounts result={done} final />
      ) : (
        <>
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cx(
              "flex cursor-pointer flex-col items-center gap-1.5 rounded-[10px] border border-dashed px-4 py-5 text-center transition-colors",
              dragging ? "border-green bg-panel" : "border-[#200D0D33] hover:bg-[#200D0D05]",
            )}
          >
            <input type="file" accept=".csv,text/csv" className="sr-only" onChange={onInput} />
            <UploadIcon className="text-muted" />
            {file ? (
              <>
                <span className="max-w-full truncate text-[13px]/4 font-semibold text-ink">{file.name}</span>
                <span className="text-xs/4 font-medium text-muted">
                  {plural(file.rows, "row")} · choose another file
                </span>
              </>
            ) : (
              <>
                <span className="text-[13px]/4 font-semibold text-ink">Choose a CSV file</span>
                <span className="text-xs/4 font-medium text-muted">or drop it here · up to 5 MB, 10,000 rows</span>
              </>
            )}
          </label>
          {pickError ? <div className="text-[13px]/5 font-medium text-[#B42318]">{pickError}</div> : null}
          {preview.isPending ? <div className="text-[13px]/5 font-medium text-muted">Checking the file… nothing is imported yet.</div> : null}
          {preview.isError ? <ImportError error={preview.error} /> : null}
          {p ? <ImportCounts result={p} /> : null}
          {run.isError ? <ImportError error={run.error} /> : null}
          <p className="text-xs/4.5 font-medium text-muted">
            Rows without consent are added as leads but never emailed. Existing leads are matched by email, then by domain, and only
            empty fields are filled in.
          </p>
        </>
      )}
    </Dialog>
  );
}

function ImportError({ error }: { error: unknown }) {
  if (isApiError(error) && (error.code === "invalid_csv" || error.code === "payload_too_large")) {
    return (
      <div role="alert" className="rounded-[10px] border border-[#B4231829] bg-[#FDECEB80] px-3.5 py-3 text-[13px]/5">
        <div className="font-semibold text-ink">This file can't be imported</div>
        <div className="font-medium text-muted">{error.message}</div>
      </div>
    );
  }
  return <QueryError error={error} what="CSV import" />;
}

function ImportCounts({ result, final }: { result: ImportResult; final?: boolean }) {
  const reasons = skipReasons(result);
  const columns = columnsOf(result);
  const cells: [string, number | undefined][] = [
    [final ? "Added" : "New leads", result.created],
    [final ? "Updated" : "Will update", result.updated],
    [final ? "Skipped" : "Will skip", result.skipped],
  ];
  return (
    <div className="flex flex-col gap-3">
      {!final ? <div className="text-[13px]/4 font-semibold text-ink">Preview · nothing is imported until you confirm</div> : null}
      <div className="flex rounded-[10px] border border-panel-line bg-panel py-3">
        {cells.map(([label, n], i) => (
          <div key={label} className={cx("flex grow basis-0 flex-col gap-1 px-3.5", i > 0 && "border-l border-l-panel-line")}>
            <div className="text-xs/4 font-medium text-muted">{label}</div>
            <div className="text-xl/6 font-semibold tabular-nums text-ink">{num(n ?? 0)}</div>
          </div>
        ))}
      </div>
      {reasons.length ? (
        <div className="flex flex-col gap-1">
          <div className="text-xs/4 font-medium text-muted">Skipped because</div>
          {reasons.map(([reason, n]) => (
            <div key={reason} className="flex justify-between gap-3 text-[13px]/4.5 font-medium text-ink">
              <span>{SKIP_REASONS[reason] ?? reason.replace(/_/g, " ")}</span>
              <span className="text-xs/4.5 tabular-nums">{num(n)}</span>
            </div>
          ))}
        </div>
      ) : null}
      {!final && columns.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs/4 font-medium text-muted">Matched columns</span>
          {columns.map(([field, header]) => (
            <span key={field} className="flex h-5 items-center rounded-md bg-pill px-1.75 text-[11px]/3.5 font-medium text-[#200D0DB3]">
              {field === header ? field : `${header} → ${field}`}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
