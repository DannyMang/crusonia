// "Connect your agent" > API keys card: list, create (full key shown once) and revoke keys for MCP clients.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { isApiError, type ApiKey } from "../../api.ts";
import { useApi } from "../../auth.tsx";
import { Card, CopyButton, EmptyState, errorCopy, QueryError, Skeleton } from "../../components/ui.tsx";
import { cx, longDate, shortDate } from "../../lib/format.ts";
import { keys, useApiKeys } from "../../queries.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "Just now", "12m ago", "3h ago", "Yesterday", "3 days ago", then the date. */
function lastUsed(v: string, now = Date.now()) {
  const diff = now - new Date(v).getTime();
  if (Number.isNaN(diff)) return "—";
  if (diff < MIN) return "Just now";
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 2 * DAY) return "Yesterday";
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} days ago`;
  return shortDate(v);
}

/** POST /api/keys answer: the stored key plus the full secret, shown exactly once. */
export type CreatedKey = { api_key: ApiKey; key: string };

const limeButton = "flex h-8.75 shrink-0 items-center rounded-lg bg-lime px-5 text-sm/4.5 font-medium text-ink hover:bg-[#b3de7a] disabled:opacity-60";

export function ApiKeysCard({ created, onCreated }: { created: CreatedKey | null; onCreated: (k: CreatedKey | null) => void }) {
  const list = useApiKeys();
  const missing = isApiError(list.error) && list.error.missingRoute;
  const [creating, setCreating] = useState(false);
  // Active keys first (newest first), revoked ones after them for the record.
  const data = [...(list.data ?? [])].sort((a, b) => Number(a.status === "revoked") - Number(b.status === "revoked"));
  return (
    <Card className="flex flex-col px-6 pb-2 pt-6">
      <div className="flex items-center justify-between pb-3.5">
        <h2 className="text-[15px]/4.5 font-medium text-ink">API keys</h2>
        {!missing ? (
          <button type="button" className={limeButton} onClick={() => setCreating(true)} disabled={creating || list.isPending}>
            Create key
          </button>
        ) : null}
      </div>

      {creating ? (
        <CreateKeyForm
          onCancel={() => setCreating(false)}
          onCreated={(k) => {
            setCreating(false);
            onCreated(k);
          }}
        />
      ) : null}
      {created ? <NewKey k={created} onDone={() => onCreated(null)} /> : null}

      {list.isPending ? (
        <div className="flex flex-col">
          <Skeleton className="mb-1 h-7 w-full" />
          {[0, 1].map((i) => (
            <div key={i} className="flex h-14 items-center gap-4 border-t border-t-[#200D0D1A]">
              <Skeleton className="h-4.5 w-36" />
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 grow" />
            </div>
          ))}
        </div>
      ) : missing ? (
        <div role="status" className="mb-4 flex items-start gap-3 rounded-[10px] border border-panel-line bg-panel px-4 py-3.5 text-[13px]/5">
          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-green" />
          <div>
            <div className="font-semibold text-ink">API keys are coming online</div>
            <div className="font-medium text-muted">
              API keys come online with the next backend update; until then the owner token works (the Worker's{" "}
              <code className="text-xs text-ink">MCP_TOKEN</code>, see the README).
            </div>
          </div>
        </div>
      ) : list.isError ? (
        <QueryError error={list.error} what="API keys" onRetry={() => void list.refetch()} className="mb-4" />
      ) : data.length ? (
        <KeyTable rows={data} />
      ) : (
        <div className="border-t border-t-[#200D0D1A]">
          <EmptyState
            className="py-9"
            title="No API keys yet"
            body="Create one key per agent or machine, then put it in CRUSONIA_MCP_TOKEN (see Setup). You can revoke one without breaking the others."
          />
        </div>
      )}
    </Card>
  );
}

function CreateKeyForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (k: CreatedKey) => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const create = useMutation({
    mutationFn: (n: string) => api.createKey(n),
    onSuccess: (k) => {
      void qc.invalidateQueries({ queryKey: keys.keys });
      onCreated(k);
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (n) create.mutate(n);
  }
  const err = create.error ? errorCopy(create.error, "API keys") : null;
  return (
    <form onSubmit={submit} className="mb-3.5 flex flex-col gap-2 rounded-[10px] border border-[#200D0D14] bg-[#200D0D05] p-3.5">
      <label htmlFor="key-name" className="text-[13px]/4 font-medium text-ink">
        Name this key
      </label>
      <div className="flex items-center gap-2">
        <input
          ref={input}
          id="key-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. claude-code-laptop"
          maxLength={64}
          autoComplete="off"
          className="h-8.75 min-w-0 grow rounded-lg border border-[#200D0D26] bg-white px-3 text-sm/4.5 font-medium text-ink placeholder:text-[#200D0D59] focus:border-ink focus:outline-none"
        />
        <button type="submit" className={limeButton} disabled={!name.trim() || create.isPending}>
          {create.isPending ? "Creating…" : "Create"}
        </button>
        <button type="button" onClick={onCancel} className="flex h-8.75 shrink-0 items-center rounded-lg px-3 text-sm/4.5 font-medium text-ink hover:bg-[#200D0D0A]">
          Cancel
        </button>
      </div>
      <p className={cx("text-xs/4 font-medium", err && !err.calm ? "text-[#B42318]" : "text-faint")}>
        {err ? `${err.title}. ${err.body}` : "Name it after where it runs, so you know which one to revoke later."}
      </p>
    </form>
  );
}

/** The full key, shown exactly once right after it is created. */
function NewKey({ k, onDone }: { k: CreatedKey; onDone: () => void }) {
  return (
    <div role="status" className="mb-3.5 flex flex-col gap-2.5 rounded-[10px] border border-[#16A34A52] bg-panel p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <div className="text-sm/4.5 font-semibold text-ink">Copy “{k.api_key.name}” now</div>
          <div className="text-xs/4 font-medium text-[#200D0DB3]">You won't see this key again. If you lose it, revoke it and create another.</div>
        </div>
        <button type="button" onClick={onDone} className="flex h-7 shrink-0 items-center rounded-lg px-2.5 text-[13px]/4 font-medium text-ink hover:bg-[#200D0D0A]">
          Done
        </button>
      </div>
      <div className="flex items-center gap-3 rounded-lg border border-[#200D0D1A] bg-white py-2 pl-3.5 pr-2">
        <code className="min-w-0 grow break-all text-[13px]/4.5 font-medium text-ink">{k.key}</code>
        <CopyButton text={k.key} className="h-6" />
      </div>
      <div className="text-xs/4 font-medium text-[#200D0DB3]">
        The export line under Setup now has it filled in: run it in your shell, then add Crusonia to your agent.
      </div>
    </div>
  );
}

function KeyTable({ rows }: { rows: ApiKey[] }) {
  const th = "h-7 p-0 text-left text-xs/4 font-medium text-faint";
  return (
    <table className="w-full table-fixed border-collapse">
      <colgroup>
        <col className="w-42.5" />
        <col className="w-37.5" />
        <col className="w-30" />
        <col />
        <col className="w-16" />
      </colgroup>
      <thead>
        <tr className="border-b border-b-[#200D0D1A]">
          <th scope="col" className={th}>
            Name
          </th>
          <th scope="col" className={th}>
            Key
          </th>
          <th scope="col" className={th}>
            Created
          </th>
          <th scope="col" className={th}>
            Last used
          </th>
          <th scope="col" className={th}>
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((k, i) => {
          const revoked = k.status === "revoked" || Boolean(k.revoked_at);
          const recent = !revoked && k.last_used_at && Date.now() - new Date(k.last_used_at).getTime() < DAY;
          return (
            <tr key={k.id} className={cx(i < rows.length - 1 && "border-b border-b-[#200D0D1A]")}>
              <td className={cx("h-14 truncate p-0 pr-3 text-sm/4.5 font-medium", revoked ? "text-faint" : "text-ink")} title={k.name}>
                {k.name}
              </td>
              <td className="truncate p-0 pr-3 text-xs/4 font-medium tabular-nums text-faint">{k.prefix}…</td>
              <td className="p-0 text-xs/4 font-medium text-muted">{longDate(k.created_at)}</td>
              <td className="p-0 text-xs/4 font-medium">
                {revoked ? (
                  <span className="text-muted">{k.revoked_at ? `Revoked ${longDate(k.revoked_at)}` : "Revoked"}</span>
                ) : k.last_used_at ? (
                  <span className={cx("inline-flex items-center gap-1.5", recent ? "text-ink" : "text-muted")}>
                    {recent ? <span className="size-1.5 shrink-0 rounded-full bg-green" /> : null}
                    {lastUsed(k.last_used_at)}
                  </span>
                ) : (
                  <span className="text-muted">Never used</span>
                )}
              </td>
              <td className="p-0 text-right">
                {revoked ? (
                  <span className="inline-flex h-5 items-center rounded-full bg-pill px-2 text-[11px]/3.5 font-semibold text-[#200D0DB3]">Revoked</span>
                ) : (
                  <RevokeButton k={k} />
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function RevokeButton({ k }: { k: ApiKey }) {
  const api = useApi();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(t);
  }, [confirming]);
  const revoke = useMutation({
    mutationFn: () => api.revokeKey(k.id),
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.keys }),
  });
  // Revoking breaks every agent using the key, so it takes a second, deliberate click.
  return (
    <button
      type="button"
      onClick={() => (confirming ? revoke.mutate() : setConfirming(true))}
      disabled={revoke.isPending}
      title={revoke.isError ? errorCopy(revoke.error).body : confirming ? `Agents using ${k.name} stop working` : undefined}
      aria-label={confirming ? `Confirm revoking ${k.name}` : `Revoke ${k.name}`}
      className={cx(
        "inline-flex h-6.75 items-center whitespace-nowrap rounded-md px-2.5 text-xs/4 text-white disabled:opacity-60",
        confirming ? "bg-[#B42318] hover:bg-[#9b1f15]" : "bg-[#E5484D] hover:bg-[#d93d42]",
      )}
    >
      {revoke.isPending ? "Revoking…" : revoke.isError ? "Retry" : confirming ? "Confirm" : "Revoke"}
    </button>
  );
}
