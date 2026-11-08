// Dashboard · Leads (Paper artboard "Dashboard · Leads"): search, real filters (stage, fit, source) mapped to
// GET /api/leads, the table grouped into Needs you / Agent working / In conversation / Closed, cursor
// pagination, CSV import and "Add leads". Production starts empty, so the empty state explains where leads come from.
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { LEAD_STAGES, type Lead, type LeadFilters, type LeadStage } from "../api.ts";
import { useApi } from "../auth.tsx";
import { Page } from "../components/AppShell.tsx";
import { Dropdown, MenuItem } from "../components/leads/Overlay.tsx";
import { Button, ButtonLink, Card, QueryError, Skeleton, StageBadge, stageLabel } from "../components/ui.tsx";
import { cx, duration, num, timeAgo } from "../lib/format.ts";
import { useMedia, usePhone } from "../lib/media.ts";
import { keys, useApprovals, useLeads } from "../queries.ts";
import { AddContactDialog, AddLeadsButton } from "./leads/AddLeads.tsx";
import { contactOf, GROUPS, groupOf, sourceLabel, type Group, type GroupKey } from "./leads/shared.ts";

const PAGE_SIZE = 50;
/** Rows shown per group before "Show N more" (only when no filter or search narrows the list). */
const PREVIEW = 4;
const FIT_STEPS = [90, 80, 70, 60, 50] as const;

// Column widths include the 12px gap (as right padding) so header and rows line up like the design.
// Column widths match the 1200px artboard from 1440px up. Narrower windows tighten the fixed columns so
// "Signal · why now" keeps room, and below 1280px (a ~784px main column) Last activity and Source are hidden.
// Phones (below 640px) keep Company, Stage and the chevron; the signal headline moves under the company.
const col = {
  company: "w-[176px] pl-4 pr-3 max-sm:w-auto min-[1440px]:w-[228px]",
  contact: "hidden w-[148px] pr-3 sm:table-cell min-[1440px]:w-[172px]",
  signal: "hidden pr-4 sm:table-cell min-[1440px]:pr-6",
  fit: "hidden w-[52px] pr-3 text-right sm:table-cell min-[1440px]:w-[60px]",
  stage: "w-[140px] pr-3 min-[1440px]:w-[148px]",
  activity: "hidden w-[96px] pr-3 xl:table-cell min-[1440px]:w-[100px]",
  source: "hidden w-[84px] pr-3 xl:table-cell",
  chevron: "w-[32px] pr-4",
};
const COLS = 8;
/** Full-width rows span only the visible columns: a colSpan wider than that adds phantom columns that take Signal's width. */
function useColSpan() {
  const wide = useMedia("(min-width: 1280px)");
  const phone = usePhone();
  return wide ? COLS : phone ? COLS - 5 : COLS - 2;
}

function useFilters() {
  const [params, setParams] = useSearchParams();
  const stageParam = params.get("stage");
  const stage = (LEAD_STAGES as readonly string[]).includes(stageParam ?? "") ? (stageParam as LeadStage) : undefined;
  const fit = Number(params.get("fit"));
  const filters: LeadFilters = {
    stage,
    min_score: Number.isInteger(fit) && fit > 0 && fit <= 100 ? fit : undefined,
    source: params.get("source") || undefined,
    q: params.get("q")?.trim() || undefined,
  };
  const update = useCallback(
    (patch: Record<string, string | number | undefined | null>, replace = false) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined || v === null || v === "") next.delete(k);
            else next.set(k, String(v));
          }
          return next;
        },
        { replace },
      ),
    [setParams],
  );
  return { filters, update, params };
}

export default function Leads() {
  const api = useApi();
  const { filters, update, params } = useFilters();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const onSearch = useCallback((q: string) => update({ q }, true), [update]);

  const leads = useInfiniteQuery({
    queryKey: [...keys.leads(filters), "pages"],
    queryFn: ({ pageParam, signal }) => api.leads({ ...filters, limit: PAGE_SIZE, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const rows = useMemo(() => leads.data?.pages.flatMap((p) => p.data) ?? [], [leads.data]);
  const filtered = Boolean(filters.stage || filters.min_score || filters.source || filters.q);

  // Remember every source we have seen so the Source filter can offer them even while one is selected.
  const [sources, setSources] = useState<string[]>([]);
  useEffect(() => {
    const seen = new Set(rows.map((l) => l.source).filter(Boolean));
    if (filters.source) seen.add(filters.source);
    setSources((prev) => {
      const merged = [...new Set([...prev, ...seen])].sort((a, b) => sourceLabel(a).localeCompare(sourceLabel(b)));
      return merged.length === prev.length ? prev : merged;
    });
  }, [rows, filters.source]);

  const loading = leads.isPending;
  const totallyEmpty = !loading && !leads.isError && rows.length === 0 && !filtered;

  return (
    <Page className="gap-5 px-4 pb-12 pt-6 sm:px-8 sm:pt-10">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-3 sm:h-10">
        <h1 className="text-xl/7 font-semibold tracking-[-0.01em] text-ink">Leads</h1>
        <div className="flex w-full flex-wrap items-center gap-2.5 sm:w-auto">
          <ReviewLink />
          <SearchBox value={filters.q ?? ""} onChange={onSearch} params={params} />
          <Button variant="outline" size="md" className="gap-1.5" onClick={() => navigate("/app/leads/import")}>
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden className="shrink-0">
              <path
                d="M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 002 2h12a2 2 0 002-2v-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Import CSV
          </Button>
          <AddLeadsButton />
        </div>
      </div>

      <FilterBar
        filters={filters}
        update={update}
        sources={sources}
        count={rows.length}
        more={Boolean(leads.hasNextPage)}
        updatedAt={leads.dataUpdatedAt}
        loading={loading}
        fetching={leads.isFetching && !leads.isFetchingNextPage}
      />

      {leads.isError && !leads.data ? (
        <QueryError error={leads.error} what="your leads" onRetry={() => void leads.refetch()} />
      ) : totallyEmpty ? (
        <NoLeadsYet onImport={() => navigate("/app/leads/import")} onAdd={() => setAdding(true)} />
      ) : (
        <LeadTable
          rows={rows}
          loading={loading}
          filtered={filtered}
          onClear={() => update({ stage: null, fit: null, source: null, q: null })}
          footer={
            leads.hasNextPage ? (
              <div className="flex h-11 items-center justify-between border-t border-t-[#200D0D14] bg-[#200D0D06] px-4">
                <div className="text-xs/4 font-medium text-muted">Showing the newest {num(rows.length)}</div>
                <Button variant="soft" loading={leads.isFetchingNextPage} onClick={() => void leads.fetchNextPage()}>
                  Load more
                </Button>
              </div>
            ) : null
          }
        />
      )}

      <AddContactDialog open={adding} onClose={() => setAdding(false)} />
    </Page>
  );
}

// ---------- header ----------

function SearchBox({ value, onChange, params }: { value: string; onChange: (q: string) => void; params: URLSearchParams }) {
  const [text, setText] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  const location = useLocation();
  const navigate = useNavigate();

  // Follow the URL when it changes from outside (back/forward, Clear filters).
  const lastSent = useRef(value);
  useEffect(() => {
    if (value !== lastSent.current) {
      lastSent.current = value;
      setText(value);
    }
  }, [value]);

  // Debounce typing into ?q=.
  useEffect(() => {
    if (text.trim() === lastSent.current) return;
    const t = setTimeout(() => {
      lastSent.current = text.trim();
      onChange(text.trim());
    }, 250);
    return () => clearTimeout(t);
  }, [text, onChange]);

  // The sidebar search and ⌘K open /app/leads?focus=search: focus the box, then drop the flag from the URL.
  const wantsFocus = params.get("focus") === "search";
  useEffect(() => {
    if (!wantsFocus) return;
    input.current?.focus();
    input.current?.select();
    const next = new URLSearchParams(location.search);
    next.delete("focus");
    const qs = next.toString();
    navigate({ pathname: location.pathname, search: qs ? `?${qs}` : "" }, { replace: true });
  }, [wantsFocus, location.key, location.pathname, location.search, navigate]);

  return (
    <label className="flex h-9 w-full shrink-0 items-center gap-2 sm:w-60 rounded-[10px] border border-[#200D0D1A] px-3 focus-within:border-ink">
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden className="shrink-0">
        <circle cx="11" cy="11" r="7" fill="none" stroke="rgb(32 13 13 / 45%)" strokeWidth="2" />
        <path d="M20 20l-3.5-3.5" fill="none" stroke="rgb(32 13 13 / 45%)" strokeWidth="2" />
      </svg>
      <input
        ref={input}
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && text) {
            e.preventDefault();
            setText("");
          }
        }}
        placeholder="Search leads"
        aria-label="Search leads by company, domain, name or email"
        className="min-w-0 grow bg-transparent text-[13px]/4 text-ink placeholder:text-[#200D0D73] focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
    </label>
  );
}

// ---------- filters ----------

type FilterKey = "stage" | "fit" | "source";

function Chip({ label, value, open, onClick }: { label: string; value: string; open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={onClick}
      className="flex h-7.5 items-center gap-1.25 rounded-full bg-lime px-3 hover:bg-[#b3de7a]"
    >
      <span className="text-[13px]/4 text-muted">{label}</span>
      <span className="text-[13px]/4 font-medium tabular-nums text-ink">{value}</span>
    </button>
  );
}

function FilterBar({
  filters,
  update,
  sources,
  count,
  more,
  updatedAt,
  loading,
  fetching,
}: {
  filters: LeadFilters;
  update: (patch: Record<string, string | number | undefined | null>) => void;
  sources: string[];
  count: number;
  more: boolean;
  updatedAt: number;
  loading: boolean;
  fetching: boolean;
}) {
  const [open, setOpen] = useState<FilterKey | "add" | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const toggle = (k: FilterKey | "add") => setOpen((v) => (v === k ? null : k));
  const pick = (patch: Record<string, string | number | null>) => {
    update(patch);
    setOpen(null);
  };
  const any = Boolean(filters.stage || filters.min_score || filters.source);

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 sm:h-8">
      <div className="flex flex-wrap items-center gap-2">
        <Dropdown
          open={open === "add"}
          onClose={close}
          trigger={
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={open === "add"}
              onClick={() => toggle("add")}
              className="flex h-7.5 items-center gap-1.5 rounded-full border border-[#200D0D26] px-3 hover:bg-[#200D0D08]"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden className="shrink-0">
                <path d="M4 6h16M7 12h10M10 18h4" fill="none" stroke="#200D0D" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span className="text-[13px]/4 font-medium text-ink">Add filter</span>
            </button>
          }
        >
          <div role="menu" aria-label="Add filter">
            <MenuItem onSelect={() => setOpen("stage")} hint="Where the lead is in the pipeline">
              Stage
            </MenuItem>
            <MenuItem onSelect={() => setOpen("fit")} hint="Minimum fit score from research">
              Fit score
            </MenuItem>
            <MenuItem onSelect={() => setOpen("source")} hint="Where the lead came from">
              Source
            </MenuItem>
            {any ? (
              <div className="mt-1 border-t border-t-[#200D0D14] pt-1">
                <MenuItem onSelect={() => pick({ stage: null, fit: null, source: null })}>Clear filters</MenuItem>
              </div>
            ) : null}
          </div>
        </Dropdown>

        <Dropdown
          open={open === "stage"}
          onClose={close}
          className="max-h-[360px] w-56 overflow-y-auto"
          trigger={<Chip label="Stage" value={filters.stage ? stageLabel(filters.stage) : "Any"} open={open === "stage"} onClick={() => toggle("stage")} />}
        >
          <div role="menu" aria-label="Stage">
            <MenuItem checked={!filters.stage} onSelect={() => pick({ stage: null })}>
              Any stage
            </MenuItem>
            {GROUPS.map((g) => (
              <div key={g.key} className="mt-1 border-t border-t-[#200D0D14] pt-1">
                <div className="px-2.5 pb-0.5 pt-1 text-[11px]/3.5 font-semibold text-muted">{g.title}</div>
                {g.stages.map((s) => (
                  <MenuItem key={s} checked={filters.stage === s} onSelect={() => pick({ stage: s })}>
                    {stageLabel(s)}
                  </MenuItem>
                ))}
              </div>
            ))}
          </div>
        </Dropdown>

        <Dropdown
          open={open === "fit"}
          onClose={close}
          className="w-44"
          trigger={
            <Chip label="Fit ≥" value={filters.min_score ? String(filters.min_score) : "Any"} open={open === "fit"} onClick={() => toggle("fit")} />
          }
        >
          <div role="menu" aria-label="Minimum fit">
            <MenuItem checked={!filters.min_score} onSelect={() => pick({ fit: null })}>
              Any fit
            </MenuItem>
            {FIT_STEPS.map((n) => (
              <MenuItem key={n} checked={filters.min_score === n} onSelect={() => pick({ fit: n })}>
                <span className="tabular-nums">{n}</span> and up
              </MenuItem>
            ))}
          </div>
        </Dropdown>

        <Dropdown
          open={open === "source"}
          onClose={close}
          className="max-h-[320px] w-56 overflow-y-auto"
          trigger={<Chip label="Source" value={filters.source ? sourceLabel(filters.source) : "Any"} open={open === "source"} onClick={() => toggle("source")} />}
        >
          <div role="menu" aria-label="Source">
            <MenuItem checked={!filters.source} onSelect={() => pick({ source: null })}>
              Any source
            </MenuItem>
            {sources.map((s) => (
              <MenuItem key={s} checked={filters.source === s} onSelect={() => pick({ source: s })} hint={sourceLabel(s) !== s ? s : undefined}>
                {sourceLabel(s)}
              </MenuItem>
            ))}
            {!sources.length ? <div className="px-2.5 py-2 text-xs/4 font-medium text-muted">Sources appear once you have leads.</div> : null}
          </div>
        </Dropdown>
      </div>
      <div className="shrink-0 text-[13px]/4 text-faint" aria-live="polite">
        {loading ? (
          "Loading leads…"
        ) : (
          <>
            {num(count)}
            {more ? "+" : ""} {count === 1 && !more ? "lead matches" : "leads match"} · {fetching ? "updating…" : <UpdatedAgo at={updatedAt} />}
          </>
        )}
      </div>
    </div>
  );
}

function UpdatedAgo({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((now - at) / 1000));
  return <>updated {s < 5 ? "just now" : s < 60 ? `${s}s ago` : timeAgo(at, now)}</>;
}

// ---------- table ----------

function LeadTable({
  rows,
  loading,
  filtered,
  onClear,
  footer,
}: {
  rows: Lead[];
  loading: boolean;
  filtered: boolean;
  onClear: () => void;
  footer: ReactNode;
}) {
  const pending = useApprovals({ status: "pending" });
  const colSpan = useColSpan();
  const groups = useMemo(() => {
    const by = new Map<GroupKey, Lead[]>(GROUPS.map((g) => [g.key, []]));
    for (const l of rows) by.get(groupOf(l.stage).key)!.push(l);
    return GROUPS.map((g) => ({ group: g, leads: by.get(g.key)! })).filter((x) => x.leads.length);
  }, [rows]);

  // "oldest 2h 10m": the longest-waiting pending approval among the leads in "Needs you".
  const oldestWaiting = useMemo(() => {
    const ids = new Set(groups.find((g) => g.group.key === "needs")?.leads.map((l) => l.id));
    const waits = (pending.data?.data ?? []).filter((a) => a.lead_id && ids.has(a.lead_id)).map((a) => Date.now() - new Date(a.created_at).getTime());
    return waits.length ? Math.max(...waits) : null;
  }, [groups, pending.data]);

  return (
    <Card className="overflow-clip">
      <table className="w-full table-fixed border-collapse text-left">
        <thead>
          <tr className="h-9 whitespace-nowrap bg-[#200D0D06] text-xs/4 font-medium text-faint">
            <th scope="col" className={cx(col.company, "font-medium")}>Company</th>
            <th scope="col" className={cx(col.contact, "font-medium")}>Contact</th>
            <th scope="col" className={cx(col.signal, "font-medium")}>Signal · why now</th>
            <th scope="col" className={cx(col.fit, "font-medium")}>Fit</th>
            <th scope="col" className={cx(col.stage, "font-medium")}>Stage</th>
            <th scope="col" className={cx(col.activity, "font-medium")}>Last activity</th>
            <th scope="col" className={cx(col.source, "font-medium")}>Source</th>
            <th scope="col" className={col.chevron}>
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        {loading ? (
          <tbody>
            {[0, 1, 2, 3, 4].map((i) => (
              <tr key={i} className="h-15 border-t border-t-[#200D0D14]">
                <td className={col.company}>
                  <Skeleton className="h-4 w-28" />
                </td>
                <td className={col.contact}>
                  <Skeleton className="h-4 w-24" />
                </td>
                <td className={col.signal}>
                  <Skeleton className="h-4 w-48" />
                </td>
                <td className={col.fit}>
                  <Skeleton className="ml-auto h-4 w-6" />
                </td>
                <td className={col.stage}>
                  <Skeleton className="h-5.5 w-24 rounded-full" />
                </td>
                <td className={col.activity}>
                  <Skeleton className="h-4 w-14" />
                </td>
                <td className={col.source}>
                  <Skeleton className="h-4 w-12" />
                </td>
                <td className={col.chevron} />
              </tr>
            ))}
          </tbody>
        ) : groups.length ? (
          groups.map(({ group, leads }) => (
            <GroupBody key={group.key} group={group} leads={leads} preview={!filtered} oldestWaiting={group.key === "needs" ? oldestWaiting : null} colSpan={colSpan} />
          ))
        ) : (
          <tbody>
            <tr className="border-t border-t-[#200D0D14]">
              <td colSpan={colSpan} className="px-6 py-12 text-center">
                <div className="text-[15px]/5 font-semibold tracking-[-0.01em] text-ink">No leads match</div>
                <div className="mx-auto mt-1.5 max-w-md text-[13px]/5 font-medium text-muted">
                  Nothing fits this search and these filters. Try a broader search or clear the filters.
                </div>
                {filtered ? (
                  <Button variant="soft" className="mt-3.5" onClick={onClear}>
                    Clear search and filters
                  </Button>
                ) : null}
              </td>
            </tr>
          </tbody>
        )}
      </table>
      {footer}
    </Card>
  );
}

function groupSummary(key: GroupKey, leads: Lead[], oldestWaiting: number | null): { left: string; right: ReactNode } {
  const count = (pred: (l: Lead) => boolean) => leads.filter(pred).length;
  const tally = (stages: readonly string[], label: (s: string) => string) =>
    stages
      .map((s) => [s, count((l) => l.stage === s)] as const)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${n} ${label(s)}`);
  switch (key) {
    case "needs":
      return {
        left: [`${leads.length} awaiting approval`, oldestWaiting !== null ? `oldest ${duration(oldestWaiting)}` : null].filter(Boolean).join(" · "),
        right: (
          <Link to="/app/outreach" className="hover:text-ink hover:underline">
            Review in Outreach
          </Link>
        ),
      };
    case "working": {
      const known = GROUPS[1]!.stages as readonly string[];
      const other = count((l) => !known.includes(l.stage));
      const parts = tally(known, (s) => stageLabel(s).toLowerCase());
      if (other) parts.push(`${other} other`);
      return { left: parts.join(" · "), right: null };
    }
    case "conversation": {
      const meetings = count((l) => l.stage === "meeting_booked");
      const parts = tally(["sent", "replied", "interested"], (s) => s);
      if (meetings) parts.push(`${meetings} ${meetings === 1 ? "meeting" : "meetings"} booked`);
      const synced = count((l) => Boolean(l.hubspot_id));
      return { left: parts.join(" · "), right: synced ? `${synced} synced to HubSpot` : null };
    }
    case "closed": {
      const parts = tally(["not_interested", "disqualified", "unsubscribed"], (s) => stageLabel(s).toLowerCase());
      const unsub = count((l) => l.stage === "unsubscribed");
      return { left: [String(leads.length), ...parts].join(" · "), right: unsub ? `${unsub} on the suppression list` : null };
    }
  }
}

function GroupBody({
  group,
  leads,
  preview,
  oldestWaiting,
  colSpan,
}: {
  group: Group;
  leads: Lead[];
  preview: boolean;
  oldestWaiting: number | null;
  colSpan: number;
}) {
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const limited = preview && !all && leads.length > PREVIEW + 1;
  const shown = limited ? leads.slice(0, PREVIEW) : leads;
  const hidden = limited ? leads.slice(PREVIEW) : [];
  const s = groupSummary(group.key, leads, oldestWaiting);
  return (
    <tbody>
      <tr className={cx("h-8.5 border-t border-t-[#200D0D14]", group.tint)}>
        <th scope="rowgroup" colSpan={colSpan} className="px-4 text-left font-normal">
          <div className="flex items-center justify-between gap-4">
            <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex min-w-0 items-center gap-2 text-left">
              <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden className={cx("shrink-0 transition-transform", !open && "-rotate-90")}>
                <path d="M6 9l6 6 6-6" fill="none" stroke="#200D0D" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="whitespace-nowrap text-[13px]/4 font-semibold text-ink">{group.title}</span>
              <span className="truncate text-[13px]/4 text-muted">{s.left}</span>
            </button>
            {s.right ? <div className="shrink-0 text-xs/4 text-muted">{s.right}</div> : null}
          </div>
        </th>
      </tr>
      {open ? shown.map((l) => <LeadRow key={l.id} lead={l} />) : null}
      {open && hidden.length ? (
        <tr className="h-9 border-t border-t-[#200D0D14]">
          <td colSpan={colSpan} className="px-4">
            <button type="button" onClick={() => setAll(true)} className="flex max-w-full items-center gap-2 text-left">
              <span className="whitespace-nowrap text-xs/4 font-medium text-ink hover:underline">Show {hidden.length} more</span>
              <span className="truncate text-xs/4 text-muted">
                {hidden
                  .slice(0, 4)
                  .map((l) => l.company || l.domain || l.name || l.email)
                  .filter(Boolean)
                  .join(" · ")}
                {hidden.length > 4 ? " …" : ""}
              </span>
            </button>
          </td>
        </tr>
      ) : null}
    </tbody>
  );
}

/** Splits "Hiring their first SDR · Series A $14M · job post Oct 28" into a headline and a detail line. */
function splitSignal(text: string): [string, string | null] {
  const i = text.indexOf(" · ");
  return i > 0 ? [text.slice(0, i), text.slice(i + 3)] : [text, null];
}

function LeadRow({ lead: l }: { lead: Lead }) {
  const navigate = useNavigate();
  const href = `/app/leads/${encodeURIComponent(l.id)}`;
  const contact = contactOf(l);
  const [headline, detail] = l.rationale ? splitSignal(l.rationale) : ["—", null];
  const company = l.company || l.domain || l.name || l.email || "Unnamed lead";
  const onClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("a, button")) return;
    if (e.metaKey || e.ctrlKey) window.open(href, "_blank", "noopener");
    else navigate(href);
  };
  return (
    <tr onClick={onClick} className="h-15 cursor-pointer border-t border-t-[#200D0D14] hover:bg-[#200D0D05]">
      <td className={col.company}>
        <div className="flex flex-col gap-0.5">
          <Link to={href} className="truncate text-sm/4.5 font-medium text-ink hover:underline">
            {company}
          </Link>
          {l.domain && l.domain !== company ? <div className="truncate whitespace-pre text-xs/3.5 text-faint">{l.domain}</div> : null}
          {l.rationale ? <div className="truncate text-xs/4 text-muted sm:hidden">{headline}</div> : null}
        </div>
      </td>
      <td className={col.contact}>
        {contact.primary ? (
          <div className="flex flex-col gap-0.5">
            <div className={cx("truncate text-[13px]/4 font-medium text-ink", !l.name && "text-xs/4")}>{contact.primary}</div>
            {contact.secondary ? <div className="truncate text-xs/4 text-muted">{contact.secondary}</div> : null}
          </div>
        ) : (
          <div className="text-[13px]/4 font-medium text-muted">No contact yet</div>
        )}
      </td>
      <td className={col.signal}>
        <div className="flex min-w-0 flex-col gap-0.5" title={l.rationale ?? undefined}>
          <div className={cx("text-[13px]/4", detail ? "truncate" : "line-clamp-2", l.rationale ? "text-ink" : "text-faint")}>{headline}</div>
          {detail ? <div className="truncate text-xs/4 text-muted">{detail}</div> : null}
        </div>
      </td>
      <td className={cx(col.fit, "text-[13px]/4 font-semibold tabular-nums", l.score === null ? "text-faint" : "text-ink")}>{l.score ?? "—"}</td>
      <td className={col.stage}>
        <StageBadge stage={l.stage} size="sm" />
      </td>
      <td className={cx(col.activity, "whitespace-nowrap text-[13px]/4 text-muted")}>{timeAgo(l.updated_at)}</td>
      <td className={cx(col.source, "truncate text-[13px]/4 text-ink")} title={l.source}>
        {sourceLabel(l.source)}
      </td>
      <td className={col.chevron}>
        <div className="flex justify-center">
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
            <path d="M9 6l6 6-6 6" fill="none" stroke="rgb(32 13 13 / 35%)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </td>
    </tr>
  );
}

// ---------- empty ----------

function NoLeadsYet({ onImport, onAdd }: { onImport: () => void; onAdd: () => void }) {
  const ways = [
    {
      title: "Your agent, over MCP",
      body: "Connect Claude, Cursor or any MCP client. It finds companies that fit, researches them and adds them here with sources.",
      action: (
        <ButtonLink to="/app/settings/agent" variant="soft">
          Connect your agent
        </ButtonLink>
      ),
    },
    {
      title: "Onboarding",
      body: "Tell Crusonia about your company and best customers. It proposes your ideal customer profile and finds a first batch.",
      action: <ButtonLink to="/onboarding/1">Start onboarding</ButtonLink>,
    },
    {
      title: "A CSV or a contact",
      body: "Import people who opted in, or add one by hand. Rows without consent are kept but never emailed.",
      action: (
        <div className="flex flex-wrap gap-1.5">
          <Button variant="outline" onClick={onImport}>
            Import CSV
          </Button>
          <Button variant="soft" onClick={onAdd}>
            Add a contact
          </Button>
        </div>
      ),
    },
  ];
  return (
    <Card className="overflow-clip">
      <div className="flex h-9 items-center gap-3 bg-[#200D0D06] px-4 text-xs/4 font-medium text-faint">
        <span className="w-37 max-sm:w-auto max-sm:grow min-[1440px]:w-50">Company</span>
        <span className="hidden w-34 sm:block min-[1440px]:w-40">Contact</span>
        <span className="hidden min-w-0 grow truncate sm:block">Signal · why now</span>
        <span className="hidden w-10 text-right sm:block min-[1440px]:w-12">Fit</span>
        <span className="w-32 min-[1440px]:w-34">Stage</span>
        <span className="hidden w-21 xl:block min-[1440px]:w-22">Last activity</span>
        <span className="hidden w-18 xl:block">Source</span>
        <span className="w-4" />
      </div>
      <div className="flex flex-col items-center gap-2 border-t border-t-[#200D0D14] px-4 pb-8 pt-10 text-center sm:px-6">
        <div className="mb-1 flex size-9 items-center justify-center rounded-full bg-panel text-green">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden>
            <circle cx="7" cy="6" r="2.75" />
            <path d="M1.75 15.25c0-2.7 2.35-4.5 5.25-4.5s5.25 1.8 5.25 4.5" />
            <path d="M12 3.4a2.7 2.7 0 010 5.2M13.6 10.9c1.65.6 2.65 2.1 2.65 4.35" />
          </svg>
        </div>
        <h2 className="text-[15px]/5 font-semibold tracking-[-0.01em] text-ink">No leads yet</h2>
        <p className="max-w-lg text-[13px]/5 font-medium text-muted">
          Every company your agents find lands here, grouped by what it needs: drafts waiting for you, research in progress,
          conversations and closed leads. Each one carries its signal, fit score and sources.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 px-4 pb-8 sm:grid-cols-3 sm:px-6">
        {ways.map((w, i) => (
          <div key={w.title} className="flex flex-col gap-2 rounded-[10px] border border-[#200D0D14] px-4 pb-4 pt-3.5">
            <div className="flex items-center gap-2">
              <span className="flex size-5 items-center justify-center rounded-md bg-lime text-[11px]/3 font-semibold tabular-nums text-ink">{i + 1}</span>
              <span className="text-[13px]/4 font-semibold text-ink">{w.title}</span>
            </div>
            <p className="grow text-xs/4.5 font-medium text-muted">{w.body}</p>
            <div className="pt-1">{w.action}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** "Review · 3": the leads the agent sent for review (Paper: "Final · Research · Review queue"). Hidden at zero. */
function ReviewLink() {
  const review = useLeads({ stage: "needs_review", limit: 100 });
  const n = review.data?.data.length ?? 0;
  if (!n) return null;
  return (
    <ButtonLink to="/app/leads/review" variant="outline" size="md" className="gap-2">
      Review
      <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-ink px-1.5 text-[11px]/3.5 font-semibold tabular-nums text-white">{n}</span>
    </ButtonLink>
  );
}
