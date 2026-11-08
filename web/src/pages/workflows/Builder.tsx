// Final · Workflows · Builder. The canvas on the left, the qualification panel on the right. Edits stay local
// until "Save as version N", which creates a new immutable version (a new workflow at /app/workflows/new).
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useFlow, useFlowMutations, type FlowStep, type FlowVersion, type Qualification } from "../../api/workflows.ts";
import { Page } from "../../components/AppShell.tsx";
import { Button, QueryError, Skeleton } from "../../components/ui.tsx";
import { Canvas } from "./Canvas.tsx";
import { FlowHeader, flowPath, runsPath } from "./parts.tsx";
import { QualificationPanel } from "./Qualification.tsx";
import { BLANK } from "./templates.ts";

type Draft = { steps: FlowStep[]; q: Qualification };

const qualOf = (v: Pick<FlowVersion, "icp" | "research_questions" | "evidence_required" | "done_when">): Qualification => ({
  icp: v.icp ?? { source: "company_summary" },
  research_questions: v.research_questions ?? [],
  evidence_required: v.evidence_required ?? [],
  done_when: v.done_when ?? "",
});

export default function WorkflowBuilder() {
  const { id } = useParams();
  const isNew = !id || id === "new";
  const q = useFlow(isNew ? undefined : id);

  if (!isNew && q.isError)
    return (
      <Page className="min-h-screen gap-5 px-4 pb-9 pt-8 sm:px-8">
        <FlowHeader title="Workflow" />
        <QueryError error={q.error} what="this workflow" onRetry={() => void q.refetch()} />
      </Page>
    );
  if (!isNew && q.isPending)
    return (
      <Page className="min-h-screen gap-5 px-4 pb-9 pt-8 sm:px-8">
        <FlowHeader title={<Skeleton className="h-6 w-48" />} />
        <div className="flex gap-4">
          <Skeleton className="h-155 grow rounded-xl" />
          <Skeleton className="hidden h-155 w-85 rounded-xl lg:block" />
        </div>
      </Page>
    );

  const latest = q.data?.versions.reduce<FlowVersion | null>((a, v) => (!a || v.version > a.version ? v : a), null) ?? null;
  // Re-mount the editor when a new version lands, so the draft starts from it.
  return <Editor key={isNew ? "new" : `${id}:${latest?.version ?? 0}`} id={isNew ? null : id!} data={q.data ?? null} latest={latest} />;
}

function Editor({ id, data, latest }: { id: string | null; data: ReturnType<typeof useFlow>["data"] | null; latest: FlowVersion | null }) {
  const navigate = useNavigate();
  const m = useFlowMutations();
  const flow = data?.workflow ?? null;
  const initial = useMemo<Draft>(() => (latest ? { steps: latest.steps, q: qualOf(latest) } : { steps: BLANK.steps, q: qualOf(BLANK) }), [latest]);
  const [draft, setDraft] = useState<Draft>(initial);
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const nextVersion = (flow?.latest_version ?? latest?.version ?? 0) + 1;

  const save = () => {
    const body = { steps: draft.steps, ...draft.q };
    if (!id) {
      m.create.mutate(
        { ...body, name: name.trim(), source: "user" },
        { onSuccess: (res) => navigate(flowPath(res.workflow.id), { replace: true }) },
      );
    } else {
      m.newVersion.mutate({ id, input: { ...body, label: label.trim() || null } }, { onSuccess: () => setLabel("") });
    }
  };
  const saving = m.create.isPending || m.newVersion.isPending;
  const canSave = id ? dirty || Boolean(label.trim()) : Boolean(name.trim());
  const error = m.create.error ?? m.newVersion.error ?? m.run.error ?? m.patch.error;

  const right = id ? (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="md"
        loading={m.run.isPending}
        onClick={() => m.run.mutate({ id, body: { version: latest?.version, test_leads: 3 } }, { onSuccess: () => navigate(runsPath(id)) })}
      >
        Test on 3 leads
      </Button>
      {flow?.enabled ? (
        <Button variant="soft" size="md" loading={m.patch.isPending} onClick={() => m.patch.mutate({ id, body: { enabled: false } })}>
          Turn off
        </Button>
      ) : (
        <Button variant="primary" size="md" className="font-semibold" loading={m.patch.isPending} onClick={() => m.patch.mutate({ id, body: { enabled: true } })}>
          Turn on
        </Button>
      )}
    </div>
  ) : null;

  return (
    <Page className="min-h-screen gap-5 px-4 pb-9 pt-8 sm:px-8">
      <FlowHeader
        title={
          id ? (
            (flow?.name ?? "Workflow")
          ) : (
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name"
              aria-label="Workflow name"
              className="w-72 max-w-full rounded-md bg-transparent text-xl/7 font-semibold tracking-[-0.01em] text-ink outline-none placeholder:text-faint"
            />
          )
        }
        source={flow?.source}
        right={right}
        tabsFor={id ?? undefined}
      />
      {error ? <QueryError error={error} what="this workflow" /> : null}
      <div className="flex flex-col items-start gap-4 lg:flex-row">
        <Canvas steps={draft.steps} onChange={(steps) => setDraft((d) => ({ ...d, steps }))} className="w-full min-w-0 lg:w-auto lg:grow" />
        <QualificationPanel
          value={draft.q}
          onChange={(q) => setDraft((d) => ({ ...d, q }))}
          version={latest?.version ?? null}
          nextVersion={nextVersion}
          label={label}
          onLabel={setLabel}
          canSave={canSave}
          saving={saving}
          onSave={save}
        />
      </div>
    </Page>
  );
}
