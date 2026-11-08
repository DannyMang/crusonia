// CSV import with a mapping and a preview: POST /api/import/preview (nothing written) then /api/import/commit.
// Contract agreed with the integrator (demo-backend). Mocked with MSW in `bun run dev:mock` (web/src/mocks/flows.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Api } from "../api.ts";
import { useApi } from "../auth.tsx";
import type { ImportMapField } from "../lib/import-mapping.ts";

export { IMPORT_FIELDS, type ImportMapField } from "../lib/import-mapping.ts";

/** Crusonia field -> CSV column name. Unmapped fields are left out. */
export type ImportMapping = Partial<Record<ImportMapField, string>>;

export type ImportBody = { csv: string; mapping: ImportMapping; source: string };

export type ImportRowStatus = "new" | "duplicate" | "invalid";

export type ImportPreviewRow = {
  row: number;
  status: ImportRowStatus;
  name: string | null;
  email: string | null;
  company: string | null;
  domain: string | null;
  title: string | null;
  consent: boolean;
  consent_at: string | null;
  source: string | null;
  /** Why a row is invalid ("email not valid"). */
  reason?: string | null;
  /** The existing lead a duplicate merges into. */
  lead_id?: string | null;
  existing_since?: string | null;
};

export type ImportPreview = {
  columns: string[];
  rows: ImportPreviewRow[];
  counts: { new: number; duplicate: number; invalid: number };
};

export type ImportCommitResult = { created: number; updated: number; skipped: number };

export function importApi(api: Api) {
  return {
    preview: (body: ImportBody, signal?: AbortSignal) => api.request<ImportPreview>("POST", "/api/import/preview", { body, signal }),
    commit: (body: ImportBody) => api.request<ImportCommitResult>("POST", "/api/import/commit", { body }),
  };
}

/** The preview for the current file + mapping + source; re-runs when any of them changes. `fileKey` names the file. */
export function useImportPreview(body: ImportBody | null, fileKey: string) {
  const api = useApi();
  return useQuery({
    queryKey: ["import-preview", fileKey, body?.mapping ?? {}, body?.source ?? ""],
    queryFn: ({ signal }) => importApi(api).preview(body!, signal),
    enabled: Boolean(body),
    placeholderData: (prev) => prev,
    staleTime: Infinity,
  });
}

export function useImportCommit() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ImportBody) => importApi(api).commit(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["leads"] });
      void qc.invalidateQueries({ queryKey: ["summary"] });
    },
  });
}
