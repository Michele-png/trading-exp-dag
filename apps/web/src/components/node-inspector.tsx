"use client";

import {
  Archive,
  Beaker,
  Check,
  ChevronRight,
  CircleDot,
  Code2,
  Database,
  Download,
  FileArchive,
  GitCommitHorizontal,
  Link2,
  LoaderCircle,
  Paperclip,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import { cn } from "@/lib/utils";
import type {
  EvidenceView,
  LineageEdgeView,
  MetricView,
  NodeRevisionView,
  NodeView,
  RunView,
  SemanticLinkView,
  SpaceView,
} from "@/lib/view-models";

type Tab = "record" | "runs" | "evidence" | "revisions" | "links";
type Notice = { type: "success" | "error"; message: string } | null;

interface NodeInspectorProps {
  space: SpaceView;
  node: NodeView | null;
  nodes: NodeView[];
  revisions: NodeRevisionView[];
  lineage: LineageEdgeView[];
  semanticLinks: SemanticLinkView[];
  runs: RunView[];
  metrics: MetricView[];
  evidence: EvidenceView[];
  onClose: () => void;
}

async function apiRequest<T>(
  url: string,
  workspaceId: string,
  options: RequestInit = {},
): Promise<T> {
  const mutation = options.method && options.method !== "GET";
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      "X-Workspace-Id": workspaceId,
      ...(mutation ? { "Idempotency-Key": crypto.randomUUID() } : {}),
      ...options.headers,
    },
  });
  const payload = (await response.json()) as {
    data?: T;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(payload.error?.message ?? "The request failed.");
  }
  return payload.data as T;
}

export function NodeInspector({
  space,
  node,
  nodes,
  revisions,
  lineage,
  semanticLinks,
  runs,
  metrics,
  evidence,
  onClose,
}: NodeInspectorProps) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("record");
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [polledRuns, setPolledRuns] = useState<RunView[] | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const currentRuns = polledRuns ?? runs;
  const hasActiveRuns = currentRuns.some(
    (run) => run.status === "queued" || run.status === "running",
  );

  useEffect(() => {
    closeButton.current?.focus();
  }, []);

  useEffect(() => {
    if (!node || !hasActiveRuns) {
      return;
    }
    const poll = window.setInterval(() => {
      void apiRequest<{ runs: Record<string, unknown>[] }>(
        `/api/v1/runs?node_id=${node.id}`,
        space.workspaceId,
      )
        .then(({ runs: nextRuns }) => {
          setPolledRuns(
            nextRuns.map((run) => ({
              id: String(run.id ?? ""),
              nodeId: String(run.node_id ?? node.id),
              status:
                run.status === "running" ||
                run.status === "completed" ||
                run.status === "failed"
                  ? run.status
                  : "queued",
              seed: typeof run.seed === "number" ? run.seed : null,
              startedAt:
                typeof run.started_at === "string"
                  ? run.started_at
                  : null,
              completedAt:
                typeof run.completed_at === "string"
                  ? run.completed_at
                  : null,
              exitCode:
                typeof run.exit_code === "number"
                  ? run.exit_code
                  : null,
              errorMessage:
                typeof run.error_message === "string"
                  ? run.error_message
                  : null,
            })),
          );
        })
        .catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(poll);
  }, [hasActiveRuns, node, space.workspaceId]);

  async function mutate(operation: () => Promise<unknown>, message: string) {
    setBusy(true);
    setNotice(null);
    try {
      await operation();
      setNotice({ type: "success", message });
      router.refresh();
    } catch (error) {
      setNotice({
        type: "error",
        message:
          error instanceof Error ? error.message : "The request failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function finalize() {
    if (!node) return;
    await mutate(
      () =>
        apiRequest(`/api/v1/nodes/${node.id}/finalize`, space.workspaceId, {
          method: "POST",
          body: JSON.stringify({
            workspaceId: space.workspaceId,
            revisionId: node.currentRevisionId,
            conclusionState: node.conclusionState,
          }),
        }),
      "Node finalized. Its scientific record is now immutable.",
    );
  }

  async function archive() {
    if (!node) return;
    const reason = window.prompt("Why is this node being archived?");
    if (!reason) return;
    await mutate(
      () =>
        apiRequest(`/api/v1/nodes/${node.id}/archive`, space.workspaceId, {
          method: "POST",
          body: JSON.stringify({
            workspaceId: space.workspaceId,
            reason,
          }),
        }),
      "Node archived.",
    );
  }

  async function exportRecord() {
    if (!node) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await apiRequest<{ bundle: unknown }>(
        `/api/v1/export?space_id=${space.id}`,
        space.workspaceId,
      );
      const blob = new Blob([JSON.stringify(result.bundle, null, 2)], {
        type: "application/json",
      });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `${space.slug || "qdag"}-export.json`;
      anchor.click();
      URL.revokeObjectURL(href);
    } catch (error) {
      setNotice({
        type: "error",
        message:
          error instanceof Error ? error.message : "Export failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      aria-labelledby="inspector-title"
      aria-modal="true"
      className="fixed inset-0 z-50 flex justify-end bg-black/55 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
    >
      <aside className="flex h-dvh w-full max-w-2xl flex-col border-l border-white/10 bg-[#0b101a] shadow-2xl shadow-black/50">
        <header className="flex items-start justify-between gap-5 border-b border-white/7 px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <p className="eyebrow">
              {node ? `${node.kind} node` : "New draft"}
            </p>
            <h2
              className="mt-1 truncate text-xl font-semibold text-white"
              id="inspector-title"
            >
              {node?.revision.title ?? "Create an experiment node"}
            </h2>
          </div>
          <div className="flex items-center gap-1">
            {node ? (
              <button
                aria-label="Export space record"
                className="button-ghost size-9 p-0"
                disabled={busy}
                onClick={exportRecord}
                title="Export"
                type="button"
              >
                <Download aria-hidden className="size-4" />
              </button>
            ) : null}
            <button
              aria-label="Close inspector"
              className="button-ghost size-9 p-0"
              onClick={onClose}
              ref={closeButton}
              type="button"
            >
              <X aria-hidden className="size-4" />
            </button>
          </div>
        </header>

        {node ? (
          <nav
            aria-label="Node details"
            className="flex overflow-x-auto border-b border-white/7 px-3"
          >
            {(
              [
                ["record", "Record"],
                ["runs", "Runs"],
                ["evidence", "Evidence"],
                ["revisions", "Revisions"],
                ["links", "Links"],
              ] as const
            ).map(([value, label]) => (
              <button
                aria-current={tab === value ? "page" : undefined}
                className={cn(
                  "border-b-2 px-3 py-3 text-xs font-medium transition",
                  tab === value
                    ? "border-teal-300 text-teal-200"
                    : "border-transparent text-slate-500 hover:text-slate-200",
                )}
                key={value}
                onClick={() => setTab(value)}
                type="button"
              >
                {label}
              </button>
            ))}
          </nav>
        ) : null}

        <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          {notice ? (
            <div
              className={cn(
                "mb-5 rounded-xl border px-4 py-3 text-sm",
                notice.type === "error"
                  ? "border-rose-300/15 bg-rose-300/5 text-rose-200"
                  : "border-emerald-300/15 bg-emerald-300/5 text-emerald-200",
              )}
              role={notice.type === "error" ? "alert" : "status"}
            >
              {notice.message}
            </div>
          ) : null}

          {!node ? (
            <CreateNodeForm
              busy={busy}
              nodes={nodes}
              onCreate={(input) =>
                mutate(
                  () =>
                    apiRequest("/api/v1/nodes", space.workspaceId, {
                      method: "POST",
                      body: JSON.stringify({
                        workspaceId: space.workspaceId,
                        spaceId: space.id,
                        ...input,
                      }),
                    }),
                  "Draft node created.",
                )
              }
            />
          ) : tab === "record" ? (
            <RecordTab
              busy={busy}
              node={node}
              onSave={(content) =>
                mutate(
                  () =>
                    apiRequest(
                      `/api/v1/nodes/${node.id}/revisions`,
                      space.workspaceId,
                      {
                        method: "POST",
                        body: JSON.stringify({
                          workspaceId: space.workspaceId,
                          content,
                          editorial: false,
                        }),
                      },
                    ),
                  "Draft revision saved.",
                )
              }
            />
          ) : tab === "runs" ? (
            <RunsTab metrics={metrics} runs={currentRuns} />
          ) : tab === "evidence" ? (
            <EvidenceTab
              busy={busy}
              evidence={evidence}
              node={node}
              onNotice={setNotice}
              onUploadComplete={() => router.refresh()}
              space={space}
            />
          ) : tab === "revisions" ? (
            <RevisionTab revisions={revisions} />
          ) : (
            <LinksTab
              busy={busy}
              lineage={lineage}
              node={node}
              nodes={nodes}
              onMutate={mutate}
              semanticLinks={semanticLinks}
              space={space}
            />
          )}
        </div>

        {node ? (
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/7 bg-black/10 px-5 py-4 sm:px-6">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              {node.finalizedRevisionId ? (
                <>
                  <ShieldCheck
                    aria-hidden
                    className="size-4 text-emerald-300"
                  />
                  Finalized revision
                </>
              ) : (
                <>
                  <CircleDot
                    aria-hidden
                    className="size-4 text-amber-300"
                  />
                  Mutable draft
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              {node.finalizedRevisionId &&
              node.operationalState !== "archived" ? (
                <button
                  className="button-ghost"
                  disabled={busy}
                  onClick={archive}
                  type="button"
                >
                  <Archive aria-hidden className="size-4" />
                  Archive
                </button>
              ) : null}
              {!node.finalizedRevisionId ? (
                <button
                  className="button-primary"
                  disabled={busy}
                  onClick={finalize}
                  type="button"
                >
                  {busy ? (
                    <LoaderCircle
                      aria-hidden
                      className="size-4 animate-spin"
                    />
                  ) : (
                    <Check aria-hidden className="size-4" />
                  )}
                  Finalize
                </button>
              ) : null}
            </div>
          </footer>
        ) : null}
      </aside>
    </div>
  );
}

function CreateNodeForm({
  nodes,
  busy,
  onCreate,
}: {
  nodes: NodeView[];
  busy: boolean;
  onCreate: (input: {
    kind: "experiment" | "synthesis";
    revision: Record<string, unknown>;
    lineageParentIds: string[];
  }) => Promise<void>;
}) {
  const [parents, setParents] = useState<string[]>([]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await onCreate({
      kind: data.get("kind") === "synthesis" ? "synthesis" : "experiment",
      revision: revisionFromForm(data),
      lineageParentIds: parents,
    });
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      <FormSection
        description="Drafts can be edited and re-parented until finalization."
        title="Scientific record"
      >
        <Field label="Title" name="title" required />
        <TextArea label="Hypothesis" name="hypothesis" required />
        <TextArea label="Method" name="method" required rows={5} />
        <TextArea
          label="Success criteria"
          name="successCriteria"
          required
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Node kind"
            name="kind"
            options={[
              ["experiment", "Experiment"],
              ["synthesis", "Synthesis"],
            ]}
          />
          <SelectField
            label="Registration"
            name="preregistrationState"
            options={[
              ["preregistered", "Preregistered"],
              ["retrospective", "Retrospective"],
              ["unspecified", "Unspecified"],
            ]}
          />
        </div>
      </FormSection>
      <FormSection
        description="Choose zero or more parents. Disconnected drafts cannot be finalized."
        title="Lineage parents"
      >
        <div className="space-y-2">
          {nodes.map((candidate) => (
            <label
              className="flex items-center gap-3 rounded-lg border border-white/7 px-3 py-2 text-sm text-slate-300"
              key={candidate.id}
            >
              <input
                checked={parents.includes(candidate.id)}
                className="accent-teal-300"
                onChange={(event) =>
                  setParents((current) =>
                    event.target.checked
                      ? [...current, candidate.id]
                      : current.filter((id) => id !== candidate.id),
                  )
                }
                type="checkbox"
              />
              <span className="truncate">{candidate.revision.title}</span>
            </label>
          ))}
        </div>
      </FormSection>
      <button className="button-primary w-full" disabled={busy} type="submit">
        {busy ? (
          <LoaderCircle aria-hidden className="size-4 animate-spin" />
        ) : (
          <Plus aria-hidden className="size-4" />
        )}
        Create draft
      </button>
    </form>
  );
}

function RecordTab({
  node,
  busy,
  onSave,
}: {
  node: NodeView;
  busy: boolean;
  onSave: (content: Record<string, unknown>) => Promise<void>;
}) {
  const editable = !node.finalizedRevisionId;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editable) return;
    await onSave(revisionFromForm(new FormData(event.currentTarget)));
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div className="grid grid-cols-2 gap-3">
        <Status label="Operational" value={node.operationalState} />
        <Status label="Conclusion" value={node.conclusionState} />
      </div>
      <FormSection title="Hypothesis and method">
        <Field
          defaultValue={node.revision.title}
          disabled={!editable}
          label="Title"
          name="title"
          required
        />
        <TextArea
          defaultValue={node.revision.hypothesis ?? ""}
          disabled={!editable}
          label="Hypothesis"
          name="hypothesis"
          required
        />
        <TextArea
          defaultValue={node.revision.method ?? ""}
          disabled={!editable}
          label="Method"
          name="method"
          required
          rows={6}
        />
        <TextArea
          defaultValue={node.revision.successCriteria ?? ""}
          disabled={!editable}
          label="Success criteria"
          name="successCriteria"
          required
        />
        <SelectField
          defaultValue={node.revision.preregistrationState}
          disabled={!editable}
          label="Registration"
          name="preregistrationState"
          options={[
            ["preregistered", "Preregistered"],
            ["retrospective", "Retrospective"],
            ["unspecified", "Unspecified"],
          ]}
        />
      </FormSection>
      <FormSection title="Conclusion">
        <TextArea
          defaultValue={node.revision.conclusion ?? ""}
          disabled={!editable}
          label="Scientific conclusion"
          name="conclusion"
          rows={5}
        />
        <TextArea
          defaultValue={node.revision.notes ?? ""}
          disabled={!editable}
          label="Notes"
          name="notes"
        />
      </FormSection>
      {editable ? (
        <button
          className="button-secondary w-full"
          disabled={busy}
          type="submit"
        >
          {busy ? (
            <LoaderCircle aria-hidden className="size-4 animate-spin" />
          ) : (
            <Save aria-hidden className="size-4" />
          )}
          Save draft revision
        </button>
      ) : (
        <p className="rounded-xl border border-emerald-300/10 bg-emerald-300/5 px-4 py-3 text-sm leading-6 text-emerald-100/70">
          This scientific record is finalized. Material changes belong in a
          new child experiment.
        </p>
      )}
    </form>
  );
}

function RunsTab({
  runs,
  metrics,
}: {
  runs: RunView[];
  metrics: MetricView[];
}) {
  if (runs.length === 0) {
    return (
      <InspectorEmpty
        description="Start a run through the CLI to record local execution."
        icon={Beaker}
        title="No runs recorded"
      />
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-xs leading-5 text-slate-500">
        Running states refresh every five seconds. Live logs are intentionally
        not streamed.
      </p>
      {runs.map((run) => {
        const runMetrics = metrics.filter(
          (metric) => metric.runId === run.id,
        );
        return (
          <article className="panel-muted p-4" key={run.id}>
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "size-2 rounded-full",
                    run.status === "running"
                      ? "animate-pulse bg-teal-300"
                      : run.status === "failed"
                        ? "bg-rose-300"
                        : "bg-slate-500",
                  )}
                />
                <h3 className="text-sm font-semibold capitalize text-slate-200">
                  {run.status}
                </h3>
              </div>
              <code className="text-[10px] text-slate-600">
                {run.id.slice(0, 8)}
              </code>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
              <Detail label="Seed" value={run.seed ?? "—"} />
              <Detail label="Exit code" value={run.exitCode ?? "—"} />
              <Detail
                label="Started"
                value={
                  run.startedAt
                    ? new Date(run.startedAt).toLocaleString()
                    : "—"
                }
              />
              <Detail
                label="Finished"
                value={
                  run.completedAt
                    ? new Date(run.completedAt).toLocaleString()
                    : "—"
                }
              />
            </dl>
            {run.errorMessage ? (
              <p className="mt-3 rounded-lg bg-rose-300/5 px-3 py-2 text-xs text-rose-200">
                {run.errorMessage}
              </p>
            ) : null}
            {runMetrics.length > 0 ? (
              <div className="mt-4 flex flex-wrap gap-2">
                {runMetrics.map((metric) => (
                  <span className="status-pill" key={metric.id}>
                    {metric.name}: {metric.value.toLocaleString()}
                    {metric.unit ? ` ${metric.unit}` : ""}
                  </span>
                ))}
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function EvidenceTab({
  evidence,
  node,
  space,
  busy,
  onNotice,
  onUploadComplete,
}: {
  evidence: EvidenceView[];
  node: NodeView;
  space: SpaceView;
  busy: boolean;
  onNotice: (notice: Notice) => void;
  onUploadComplete: () => void;
}) {
  const [uploading, setUploading] = useState(false);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem(
      "artifact",
    ) as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    setUploading(true);
    onNotice(null);
    try {
      const inferredMediaType =
        file.type ||
        ({
          csv: "text/csv",
          json: "application/json",
          md: "text/markdown",
          txt: "text/plain",
        }[file.name.split(".").pop()?.toLowerCase() ?? ""] ??
          "application/octet-stream");
      const digest = await crypto.subtle.digest(
        "SHA-256",
        await file.arrayBuffer(),
      );
      const sha256 = Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const prepared = await apiRequest<{
        artifactId: string;
        path: string;
        token: string;
      }>("/api/v1/artifacts/upload", space.workspaceId, {
        method: "POST",
        body: JSON.stringify({
          workspaceId: space.workspaceId,
          nodeId: node.id,
          fileName: file.name,
          mimeType: inferredMediaType,
          sizeBytes: file.size,
          sha256,
        }),
      });
      const supabase = createBrowserSupabaseClient();
      const { error } = await supabase.storage
        .from("evidence")
        .uploadToSignedUrl(prepared.path, prepared.token, file, {
          contentType: inferredMediaType,
        });
      if (error) throw error;
      await apiRequest(
        `/api/v1/artifacts/${prepared.artifactId}/finalize`,
        space.workspaceId,
        {
          method: "POST",
          body: JSON.stringify({
            workspaceId: space.workspaceId,
            sha256,
          }),
        },
      );
      onNotice({
        type: "success",
        message: "Evidence uploaded and checksum verified.",
      });
      event.currentTarget.reset();
      onUploadComplete();
    } catch (error) {
      onNotice({
        type: "error",
        message:
          error instanceof Error ? error.message : "Upload failed.",
      });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-5">
      <form className="panel-muted p-4" onSubmit={upload}>
        <label className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
          Attach small evidence
          <input
            accept=".json,.pdf,.zip,.csv,.md,.txt,.png,.jpg,.jpeg,.webp"
            className="field mt-2 block w-full file:mr-3 file:rounded-md file:border-0 file:bg-white/8 file:px-3 file:py-1.5 file:text-xs file:text-slate-200"
            disabled={busy || uploading}
            name="artifact"
            required
            type="file"
          />
        </label>
        <p className="mt-2 text-[11px] leading-5 text-slate-600">
          Private Storage, allow-listed MIME types, maximum 10 MiB. The API
          recomputes SHA-256 before finalizing.
        </p>
        <button
          className="button-secondary mt-3"
          disabled={busy || uploading}
          type="submit"
        >
          {uploading ? (
            <LoaderCircle aria-hidden className="size-4 animate-spin" />
          ) : (
            <Paperclip aria-hidden className="size-4" />
          )}
          Upload
        </button>
      </form>
      {evidence.length === 0 ? (
        <InspectorEmpty
          description="Artifacts and immutable code/data references appear here."
          icon={Paperclip}
          title="No evidence attached"
        />
      ) : (
        <div className="space-y-2">
          {evidence.map((item) => {
            const Icon =
              item.type === "code"
                ? Code2
                : item.type === "data"
                  ? Database
                  : FileArchive;
            return (
              <article
                className="flex items-start gap-3 rounded-xl border border-white/7 p-3"
                key={item.id}
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-white/5 text-slate-400">
                  <Icon aria-hidden className="size-4" />
                </span>
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-medium text-slate-200">
                    {item.label}
                  </h3>
                  <p className="mt-1 truncate text-xs text-slate-500">
                    {item.detail}
                  </p>
                  {item.checksum ? (
                    <code className="mt-2 block truncate text-[10px] text-slate-600">
                      sha256:{item.checksum}
                    </code>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RevisionTab({ revisions }: { revisions: NodeRevisionView[] }) {
  return (
    <ol className="space-y-3">
      {[...revisions].reverse().map((revision, index) => (
        <li className="relative pl-7" key={revision.id}>
          <span className="absolute left-0 top-1 grid size-5 place-items-center rounded-full border border-white/10 bg-[#131b28] text-[9px] text-slate-400">
            {revision.revisionNumber}
          </span>
          {index < revisions.length - 1 ? (
            <span className="absolute bottom-[-14px] left-[9px] top-6 w-px bg-white/8" />
          ) : null}
          <article className="panel-muted p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-slate-200">
                {revision.title}
              </h3>
              {revision.editorial ? (
                <span className="status-pill">Editorial</span>
              ) : null}
            </div>
            <p className="mt-2 text-xs text-slate-500">
              {revision.createdAt
                ? new Date(revision.createdAt).toLocaleString()
                : "Timestamp unavailable"}
            </p>
            {revision.correctionReason ? (
              <p className="mt-3 text-xs leading-5 text-slate-400">
                {revision.correctionReason}
              </p>
            ) : null}
          </article>
        </li>
      ))}
    </ol>
  );
}

function LinksTab({
  node,
  nodes,
  lineage,
  semanticLinks,
  space,
  busy,
  onMutate,
}: {
  node: NodeView;
  nodes: NodeView[];
  lineage: LineageEdgeView[];
  semanticLinks: SemanticLinkView[];
  space: SpaceView;
  busy: boolean;
  onMutate: (
    operation: () => Promise<unknown>,
    message: string,
  ) => Promise<void>;
}) {
  const nodeById = useMemo(
    () => new Map(nodes.map((item) => [item.id, item])),
    [nodes],
  );
  const incoming = lineage.filter(
    (edge) => edge.childNodeId === node.id,
  );
  const semantic = semanticLinks.filter(
    (link) =>
      link.sourceNodeId === node.id || link.targetNodeId === node.id,
  );
  const mutable = !node.finalizedRevisionId;

  async function addParent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parentNodeId = String(data.get("parentNodeId") ?? "");
    if (!parentNodeId) return;
    await onMutate(
      () =>
        apiRequest("/api/v1/lineage-edges", space.workspaceId, {
          method: "POST",
          body: JSON.stringify({
            workspaceId: space.workspaceId,
            spaceId: space.id,
            parentNodeId,
            childNodeId: node.id,
          }),
        }),
      "Lineage parent added.",
    );
  }

  async function addSemantic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const targetNodeId = String(data.get("targetNodeId") ?? "");
    if (!targetNodeId) return;
    await onMutate(
      () =>
        apiRequest("/api/v1/semantic-links", space.workspaceId, {
          method: "POST",
          body: JSON.stringify({
            workspaceId: space.workspaceId,
            spaceId: space.id,
            sourceNodeId: node.id,
            targetNodeId,
            linkType: data.get("linkType"),
            rationale: data.get("rationale") || null,
          }),
        }),
      "Semantic link added.",
    );
  }

  return (
    <div className="space-y-6">
      <FormSection
        description="Solid links determine ancestry and must remain acyclic."
        title="Lineage"
      >
        {incoming.length === 0 ? (
          <p className="text-sm text-slate-500">No lineage parents.</p>
        ) : (
          <div className="space-y-2">
            {incoming.map((edge) => (
              <div
                className="flex items-center justify-between gap-3 rounded-lg border border-white/7 px-3 py-2"
                key={edge.id}
              >
                <span className="flex min-w-0 items-center gap-2 text-sm text-slate-300">
                  <GitCommitHorizontal
                    aria-hidden
                    className="size-4 shrink-0 text-slate-500"
                  />
                  <span className="truncate">
                    {nodeById.get(edge.parentNodeId)?.revision.title ??
                      edge.parentNodeId}
                  </span>
                </span>
                {mutable ? (
                  <button
                    aria-label="Remove lineage parent"
                    className="button-ghost size-8 p-0 text-rose-300"
                    disabled={busy}
                    onClick={() =>
                      onMutate(
                        () =>
                          apiRequest(
                            "/api/v1/lineage-edges",
                            space.workspaceId,
                            {
                              method: "DELETE",
                              body: JSON.stringify({
                                workspaceId: space.workspaceId,
                                edgeId: edge.id,
                              }),
                            },
                          ),
                        "Lineage parent removed.",
                      )
                    }
                    type="button"
                  >
                    <Trash2 aria-hidden className="size-3.5" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {mutable ? (
          <form className="flex gap-2" onSubmit={addParent}>
            <select className="field min-w-0 flex-1" name="parentNodeId">
              <option value="">Select parent…</option>
              {nodes
                .filter(
                  (candidate) =>
                    candidate.id !== node.id &&
                    !incoming.some(
                      (edge) => edge.parentNodeId === candidate.id,
                    ),
                )
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.revision.title}
                  </option>
                ))}
            </select>
            <button
              aria-label="Add lineage parent"
              className="button-secondary"
              disabled={busy}
              type="submit"
            >
              <Plus aria-hidden className="size-4" />
            </button>
          </form>
        ) : null}
      </FormSection>

      <FormSection
        description="Dashed typed links express interpretation without changing the DAG."
        title="Semantic links"
      >
        {semantic.length === 0 ? (
          <p className="text-sm text-slate-500">No semantic links.</p>
        ) : (
          <div className="space-y-2">
            {semantic.map((link) => {
              const otherId =
                link.sourceNodeId === node.id
                  ? link.targetNodeId
                  : link.sourceNodeId;
              return (
                <div
                  className="rounded-lg border border-white/7 px-3 py-2"
                  key={link.id}
                >
                  <div className="flex items-center gap-2">
                    <Link2
                      aria-hidden
                      className="size-3.5 text-teal-300"
                    />
                    <span className="status-pill">{link.linkType}</span>
                    <ChevronRight
                      aria-hidden
                      className="size-3 text-slate-700"
                    />
                    <span className="min-w-0 truncate text-sm text-slate-300">
                      {nodeById.get(otherId)?.revision.title ?? otherId}
                    </span>
                  </div>
                  {link.rationale ? (
                    <p className="mt-2 text-xs leading-5 text-slate-500">
                      {link.rationale}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        <form className="space-y-2" onSubmit={addSemantic}>
          <div className="grid gap-2 sm:grid-cols-2">
            <select className="field" name="linkType">
              <option value="supports">Supports</option>
              <option value="contradicts">Contradicts</option>
              <option value="replicates">Replicates</option>
            </select>
            <select className="field min-w-0" name="targetNodeId">
              <option value="">Select target…</option>
              {nodes
                .filter((candidate) => candidate.id !== node.id)
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.revision.title}
                  </option>
                ))}
            </select>
          </div>
          <input
            className="field"
            name="rationale"
            placeholder="Rationale (optional)"
          />
          <button
            className="button-secondary"
            disabled={busy}
            type="submit"
          >
            <Plus aria-hidden className="size-4" />
            Add typed link
          </button>
        </form>
      </FormSection>
    </div>
  );
}

function revisionFromForm(data: FormData) {
  const value = (name: string) => {
    const current = String(data.get(name) ?? "").trim();
    return current || null;
  };
  return {
    title: String(data.get("title") ?? "").trim(),
    hypothesis: value("hypothesis"),
    method: value("method"),
    successCriteria: value("successCriteria"),
    preregistrationState:
      data.get("preregistrationState") || "unspecified",
    conclusion: value("conclusion"),
    notes: value("notes"),
  };
}

function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
        {description ? (
          <p className="mt-1 text-xs leading-5 text-slate-500">
            {description}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="block space-y-2 text-xs font-medium text-slate-500">
      {label}
      <input className="field block" {...props} />
    </label>
  );
}

function TextArea({
  label,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) {
  return (
    <label className="block space-y-2 text-xs font-medium text-slate-500">
      {label}
      <textarea className="field block min-h-24 resize-y" {...props} />
    </label>
  );
}

function SelectField({
  label,
  options,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  options: [string, string][];
}) {
  return (
    <label className="block space-y-2 text-xs font-medium text-slate-500">
      {label}
      <select className="field block" {...props}>
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function Status({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel-muted px-3 py-2">
      <p className="text-[10px] uppercase tracking-[0.12em] text-slate-600">
        {label}
      </p>
      <p className="mt-1 text-sm font-medium capitalize text-slate-300">
        {value}
      </p>
    </div>
  );
}

function Detail({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div>
      <dt className="text-slate-600">{label}</dt>
      <dd className="mt-1 text-slate-300">{value}</dd>
    </div>
  );
}

function InspectorEmpty({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof Beaker;
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center text-center">
      <span className="grid size-10 place-items-center rounded-xl bg-white/5 text-slate-500">
        <Icon aria-hidden className="size-4" />
      </span>
      <h3 className="mt-3 text-sm font-semibold text-slate-200">{title}</h3>
      <p className="mt-2 max-w-sm text-xs leading-5 text-slate-500">
        {description}
      </p>
    </div>
  );
}
