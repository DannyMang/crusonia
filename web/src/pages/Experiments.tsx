// Dashboard · Experiments (Paper artboard "Dashboard · Experiments"): A/B tests over the stable lead variants.
// Left: experiments grouped Running / Stopped with sends against the stop rule. Right: the selected one (route
// param, else the first running) with per-arm results and cumulative replies, or the "New experiment" form.
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { isApiError, type Experiment } from "../api.ts";
import { Page } from "../components/AppShell.tsx";
import { arm, dayLabel, isLive, sendProgress } from "../components/experiments/derive.ts";
import { ExperimentDetail } from "../components/experiments/ExperimentDetail.tsx";
import { NewExperimentForm, type Enrollment } from "../components/experiments/NewExperimentForm.tsx";
import { PlusIcon, SearchIcon, XIcon } from "../components/icons.tsx";
import { QueryError, Skeleton } from "../components/ui.tsx";
import { cx, shortDate } from "../lib/format.ts";
import { useExperiment, useExperiments } from "../queries.ts";

export default function Experiments() {
  const { id } = useParams();
  const navigate = useNavigate();
  const list = useExperiments();
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ id: string; enrollment: Enrollment } | null>(null);
  const missing = isApiError(list.error) && list.error.missingRoute;

  const all = list.data ?? [];
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((e) => [e.name, e.hypothesis, e.segment, e.variants?.A?.name, e.variants?.B?.name].some((s) => s?.toLowerCase().includes(needle)));
  }, [all, q]);
  const running = shown.filter(isLive);
  const stopped = shown.filter((e) => !isLive(e));
  const selectedId = id ?? all.find(isLive)?.id ?? all[0]?.id;
  const detail = useExperiment(selectedId);
  const selected = detail.data?.experiment ?? all.find((e) => e.id === selectedId);

  const empty = list.isSuccess && all.length === 0;
  const canCreate = !missing && !list.isPending;
  const startCreating = () => {
    setCreated(null);
    setCreating(true);
  };

  return (
    <Page className="h-screen min-h-[640px] gap-5 px-8 pb-6 pt-8">
      <header className="flex h-9 shrink-0 items-center justify-between gap-6">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-xl/7 font-semibold tracking-[-0.01em] text-ink">Experiments</h1>
          <p className="truncate text-[13px]/4 font-medium text-muted">A/B tests on signals and messages, with a stop rule set up front.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {!empty && !missing ? (
            <label className="flex h-8 w-55 shrink-0 items-center gap-2 rounded-[10px] border border-[#200D0D1A] px-3 focus-within:border-[#200D0D59]">
              <SearchIcon width={14} height={14} className="text-[rgb(32_13_13/45%)]" />
              <span className="sr-only">Search experiments</span>
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search experiments"
                className="min-w-0 grow bg-transparent text-[13px]/4 text-ink placeholder:text-[#200D0D73] focus:outline-none"
              />
            </label>
          ) : null}
          {canCreate ? (
            <button
              type="button"
              onClick={startCreating}
              disabled={creating}
              className="flex h-8 items-center gap-1.5 rounded-full bg-lime px-3.5 text-[13px]/4 font-medium text-ink hover:bg-[#b3de7a] disabled:opacity-60"
            >
              <PlusIcon width={12} height={12} />
              New experiment
            </button>
          ) : null}
        </div>
      </header>

      {list.isError && !missing ? <QueryError error={list.error} what="Experiments" onRetry={() => void list.refetch()} /> : null}

      {(empty || missing) && !creating ? (
        <EmptyExplainer missing={missing} error={list.error} onCreate={canCreate ? startCreating : undefined} />
      ) : (
        <div className="flex min-h-0 grow overflow-clip rounded-xl border border-[#200D0D1A]">
          <div className="flex w-90 shrink-0 flex-col overflow-y-auto border-r border-r-[#200D0D1A]">
            <div className="sticky top-0 z-10 flex h-9 shrink-0 items-center justify-between border-b border-b-[#200D0D1A] bg-[#FAF9F9] px-4">
              <div className="text-xs/4 font-medium text-faint">Experiment</div>
              <div className="text-xs/4 font-medium text-faint">Sends</div>
            </div>
            {list.isPending ? (
              [0, 1, 2].map((i) => (
                <div key={i} className="flex h-16 shrink-0 flex-col justify-center gap-2 border-b border-b-[#200D0D1A] px-4">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3.5 w-36" />
                </div>
              ))
            ) : shown.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs/4 font-medium text-muted">
                {all.length ? `No experiments match “${q.trim()}”.` : "No experiments yet."}
              </div>
            ) : (
              <>
                {running.length ? <GroupHeader title="Running" count={running.length} /> : null}
                {running.map((e) => (
                  <Row key={e.id} e={e} selected={!creating && e.id === selectedId} onSelect={() => setCreating(false)} />
                ))}
                {stopped.length ? <GroupHeader title="Stopped" count={stopped.length} /> : null}
                {stopped.map((e) => (
                  <Row key={e.id} e={e} selected={!creating && e.id === selectedId} onSelect={() => setCreating(false)} />
                ))}
              </>
            )}
          </div>

          <section aria-label="Experiment detail" className="flex min-w-0 grow flex-col overflow-y-auto">
            {creating ? (
              <NewExperimentForm
                onCancel={() => setCreating(false)}
                onCreated={(e, enrollment) => {
                  setCreating(false);
                  setCreated({ id: e.id, enrollment });
                  navigate(`/app/experiments/${encodeURIComponent(e.id)}`);
                }}
              />
            ) : selected ? (
              <>
                {created && created.id === selected.id ? <CreatedNote enrollment={created.enrollment} onClose={() => setCreated(null)} /> : null}
                <ExperimentDetail e={selected} daily={detail.data?.daily ?? (detail.isError ? [] : undefined)} />
              </>
            ) : detail.isError ? (
              <div className="p-5">
                <QueryError error={detail.error} what="This experiment" onRetry={() => void detail.refetch()} />
              </div>
            ) : list.isPending || detail.isPending ? (
              <DetailSkeleton />
            ) : null}
          </section>
        </div>
      )}

      {(empty || missing) && creating ? (
        <div className="min-h-0 grow overflow-y-auto rounded-xl border border-[#200D0D1A]">
          <NewExperimentForm
            onCancel={() => setCreating(false)}
            onCreated={(e, enrollment) => {
              setCreating(false);
              setCreated({ id: e.id, enrollment });
              navigate(`/app/experiments/${encodeURIComponent(e.id)}`);
            }}
          />
        </div>
      ) : null}
    </Page>
  );
}

// ---------- list ----------

function GroupHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex h-8.5 shrink-0 items-center gap-2 border-b border-b-[#200D0D1A] bg-[#200D0D08] px-4">
      <h2 className="text-xs/4 font-semibold text-ink">{title}</h2>
      <div className="text-xs/4 font-medium tabular-nums text-muted">· {count}</div>
    </div>
  );
}

function Row({ e, selected, onSelect }: { e: Experiment; selected: boolean; onSelect: () => void }) {
  const live = isLive(e);
  const p = sendProgress(e);
  const a = arm(e, "A");
  const b = arm(e, "B");
  return (
    <Link
      to={`/app/experiments/${encodeURIComponent(e.id)}`}
      onClick={onSelect}
      aria-current={selected ? "page" : undefined}
      className={cx(
        "flex h-16 shrink-0 flex-col justify-center gap-1.75 border-b border-b-[#200D0D1A] px-4",
        // Neutral selection with an ink edge (owner rule: no lime behind text outside buttons, pills and nav).
        selected ? "bg-[#200D0D0A] shadow-[inset_2px_0_0_#200D0D]" : "hover:bg-[#200D0D05]",
      )}
    >
      <div className="flex items-center gap-2">
        <div className={cx("min-w-0 grow truncate text-[13px]/4 text-ink", selected ? "font-semibold" : "font-medium")}>{e.name}</div>
        <div className="shrink-0 text-[11px]/3.5 font-medium tabular-nums text-ink">{p.target ? `${p.sent}/${p.target}` : p.sent}</div>
      </div>
      {live ? (
        <div className="flex items-center gap-2.5">
          <div className="min-w-0 grow truncate text-xs/4 font-medium text-muted">
            {[e.segment, e.stop_rule_met ? "stop rule met" : dayLabel(e)].filter(Boolean).join(" · ")}
          </div>
          {p.share !== null ? (
            <div className="relative h-1 w-16 shrink-0 rounded-full bg-[#200D0D14]" role="meter" aria-label="Progress to the stop rule" aria-valuenow={Math.round(p.share * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div className={cx("absolute left-0 top-0 h-1 rounded-full", selected ? "bg-ink" : "bg-[#200D0D80]")} style={{ width: `${p.share > 0 ? Math.max(p.share * 100, 4) : 0}%` }} />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="flex h-4.5 shrink-0 items-center rounded-full bg-pill px-1.75 text-[11px]/3.5 font-semibold text-[#200D0DB3]">Stopped</span>
          <div className="min-w-0 truncate text-xs/4 font-medium tabular-nums text-muted">
            A {a.positive} · B {b.positive} positive{e.stopped_at ? ` · ${shortDate(e.stopped_at)}` : ""}
          </div>
        </div>
      )}
    </Link>
  );
}

// ---------- detail extras ----------

function CreatedNote({ enrollment, onClose }: { enrollment: Enrollment; onClose: () => void }) {
  const skipped = enrollment.skipped.length;
  return (
    <div role="status" className="mx-5 mt-4 flex items-start gap-3 rounded-[10px] border border-panel-line bg-panel px-4 py-3 text-xs/4.25">
      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-green" />
      <div className="grow font-medium text-[#200D0DB3]">
        <span className="font-semibold text-ink">Experiment created.</span>{" "}
        {enrollment.enrolled ? `${enrollment.enrolled} ${enrollment.enrolled === 1 ? "lead" : "leads"} enrolled` : "No leads enrolled yet"}
        {skipped ? `, ${skipped} skipped (already in another running experiment)` : ""}. Nothing was sent.
      </div>
      <button type="button" aria-label="Dismiss" onClick={onClose} className="flex size-5 shrink-0 items-center justify-center rounded-full text-faint hover:bg-[#200D0D0A]">
        <XIcon />
      </button>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-5">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-6 w-3/4" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-36 w-full" />
      <Skeleton className="h-52 w-full" />
    </div>
  );
}

// ---------- empty ----------

const STEPS: { title: string; body: string; example: string }[] = [
  { title: "A hypothesis", body: "What you expect to work better, and for whom.", example: "The hiring-signal angle beats the funding angle" },
  { title: "Two variants", body: "Two versions of the message. Each lead stays in one variant, A or B, for the whole test.", example: "A: funding angle · B: hiring angle" },
  { title: "A stop rule", body: "Set up front, so you read the numbers when the sample is in, not when they look good.", example: "80 sends per arm or 14 days" },
];

function EmptyExplainer({ missing, error, onCreate }: { missing: boolean; error: unknown; onCreate?: () => void }) {
  return (
    <div className="flex min-h-0 grow items-center justify-center overflow-y-auto rounded-xl border border-[#200D0D1A] px-8 py-10">
      <div className="flex w-full max-w-[720px] flex-col items-center gap-6 text-center">
        <div className="flex flex-col items-center gap-2">
          <h2 className="text-[15px]/5 font-semibold tracking-[-0.01em] text-ink">No experiments yet</h2>
          <p className="max-w-130 text-[13px]/5 font-medium text-muted">
            An experiment tests one hypothesis with two message variants and compares positive replies. Crusonia shows the numbers and how big the sample is; it never
            calls a winner for you, and every send still waits for your approval.
          </p>
        </div>
        <ol className="grid w-full grid-cols-3 gap-3 text-left">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex flex-col gap-1.5 rounded-[10px] border border-[#200D0D14] bg-[#200D0D05] p-4">
              <div className="text-[11px]/3.5 font-medium tabular-nums text-faint">0{i + 1}</div>
              <div className="text-[13px]/4 font-semibold text-ink">{s.title}</div>
              <div className="text-xs/4.25 font-medium text-muted">{s.body}</div>
              <div className="mt-1 text-xs/4 font-medium text-ink">“{s.example}”</div>
            </li>
          ))}
        </ol>
        {missing ? (
          <QueryError error={error} what="This screen" className="w-full max-w-130 text-left" />
        ) : onCreate ? (
          <button type="button" onClick={onCreate} className="flex h-9 items-center gap-1.5 rounded-full bg-lime px-4 text-sm/4.5 font-medium text-ink hover:bg-[#b3de7a]">
            <PlusIcon width={12} height={12} />
            New experiment
          </button>
        ) : null}
      </div>
    </div>
  );
}
