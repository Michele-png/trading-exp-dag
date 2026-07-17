import "server-only";

import type { SupabaseClient, User } from "@supabase/supabase-js";

import type {
  ConclusionState,
  NodeKind,
  OperationalState,
  PreregistrationState,
  SemanticLinkType,
} from "@/lib/contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { asRecord, asRecordArray, stringValue } from "@/lib/utils";
import type {
  EvidenceView,
  LineageEdgeView,
  MetricView,
  NodeRevisionView,
  NodeView,
  RunView,
  SemanticLinkView,
  SpaceSummary,
  SpaceView,
  WorkspaceSummary,
} from "@/lib/view-models";

export class UiDataError extends Error {}

async function query(
  promise: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await promise;
  if (error) throw new UiDataError(error.message);
  return asRecordArray(data);
}

export async function getAuthenticatedUser(): Promise<{
  client: SupabaseClient;
  user: User | null;
}> {
  const client = await createServerSupabaseClient();
  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  return { client, user: error ? null : user };
}

function operational(
  revision: Record<string, unknown>,
  node: Record<string, unknown>,
): OperationalState {
  if (node.archived_at) return "archived";
  if (revision.state === "draft") return "draft";
  const value = revision.operational_state;
  return value === "planned" ||
    value === "ready" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
    ? value
    : "planned";
}

function conclusion(revision: Record<string, unknown>): ConclusionState {
  const declared = asRecord(revision.metadata).declared_conclusion_state;
  if (
    declared === "supported" ||
    declared === "refuted" ||
    declared === "mixed" ||
    declared === "inconclusive"
  ) {
    return declared;
  }
  if (revision.conclusion_state === "supported") return "supported";
  if (revision.conclusion_state === "contradicted") return "refuted";
  if (revision.conclusion_state === "inconclusive") return "inconclusive";
  return "pending";
}

function nodeKind(
  node: Record<string, unknown>,
  revision: Record<string, unknown>,
): NodeKind {
  if (node.kind === "objective") return "objective";
  return asRecord(revision.metadata).record_kind === "synthesis"
    ? "synthesis"
    : "experiment";
}

function preregistration(
  revision: Record<string, unknown>,
): PreregistrationState {
  if (revision.retrospective === true) return "retrospective";
  if (revision.preregistered_at) return "preregistered";
  return "unspecified";
}

function revisionView(
  row: Record<string, unknown>,
  fallbackNodeId: string,
): NodeRevisionView {
  const metadata = asRecord(row.metadata);
  return {
    id: stringValue(row, "id"),
    nodeId: stringValue(row, "node_id", fallbackNodeId),
    revisionNumber:
      typeof row.revision_number === "number" ? row.revision_number : 1,
    title: stringValue(row, "title", "Untitled node"),
    hypothesis:
      typeof row.hypothesis === "string" ? row.hypothesis : null,
    method: typeof row.method === "string" ? row.method : null,
    successCriteria:
      typeof metadata.success_criteria === "string"
        ? metadata.success_criteria
        : null,
    preregistrationState: preregistration(row),
    conclusion:
      typeof row.conclusion === "string" ? row.conclusion : null,
    notes:
      typeof metadata.notes === "string" ? metadata.notes : null,
    editorial:
      row.state === "draft" &&
      typeof row.revision_number === "number" &&
      row.revision_number > 1,
    correctionReason:
      typeof row.change_summary === "string"
        ? row.change_summary
        : null,
    createdAt:
      typeof row.created_at === "string" ? row.created_at : null,
  };
}

export async function loadWorkspaceDashboard(
  client: SupabaseClient,
  userId: string,
): Promise<WorkspaceSummary[]> {
  const memberships = await query(
    client
      .from("workspace_members")
      .select("*")
      .eq("user_id", userId)
      .is("removed_at", null),
  );
  const workspaceIds = memberships
    .map((membership) => stringValue(membership, "workspace_id"))
    .filter(Boolean);
  if (workspaceIds.length === 0) return [];
  const [workspaces, spaces] = await Promise.all([
    query(client.from("workspaces").select("*").in("id", workspaceIds)),
    query(
      client
        .from("spaces")
        .select("*")
        .in("workspace_id", workspaceIds)
        .is("archived_at", null),
    ),
  ]);
  const spaceIds = spaces.map((space) => stringValue(space, "id"));
  const nodes =
    spaceIds.length > 0
      ? await query(
          client.from("nodes").select("*").in("space_id", spaceIds),
        )
      : [];
  const revisionIds = nodes
    .map((node) => stringValue(node, "current_revision_id"))
    .filter(Boolean);
  const revisions =
    revisionIds.length > 0
      ? await query(
          client
            .from("node_revisions")
            .select("*")
            .in("id", revisionIds),
        )
      : [];
  const revisionById = new Map(
    revisions.map((revision) => [String(revision.id), revision]),
  );

  return workspaces.map((workspace) => {
    const workspaceId = stringValue(workspace, "id");
    const membership = memberships.find(
      (item) => item.workspace_id === workspaceId,
    );
    const workspaceSpaces: SpaceSummary[] = spaces
      .filter((space) => space.workspace_id === workspaceId)
      .map((space) => {
        const id = stringValue(space, "id");
        const spaceNodes = nodes.filter((node) => node.space_id === id);
        const states = spaceNodes.map((node) =>
          operational(
            revisionById.get(stringValue(node, "current_revision_id")) ?? {},
            node,
          ),
        );
        return {
          id,
          workspaceId,
          name: stringValue(space, "name", "Untitled space"),
          slug: stringValue(space, "slug"),
          description:
            typeof space.description === "string"
              ? space.description
              : null,
          nodeCount: spaceNodes.length,
          openCount: states.filter((state) =>
            ["draft", "planned", "ready", "running", "open"].includes(
              state,
            ),
          ).length,
          completedCount: states.filter((state) =>
            ["completed", "failed", "cancelled"].includes(state),
          ).length,
          updatedAt:
            typeof space.updated_at === "string"
              ? space.updated_at
              : null,
        };
      });
    return {
      id: workspaceId,
      name: stringValue(workspace, "name", "Workspace"),
      slug: stringValue(workspace, "slug"),
      role: stringValue(membership ?? {}, "role", "member"),
      spaces: workspaceSpaces,
    };
  });
}

export async function loadSpace(
  client: SupabaseClient,
  spaceId: string,
): Promise<{
  space: SpaceView | null;
  nodes: NodeView[];
  revisions: NodeRevisionView[];
  lineage: LineageEdgeView[];
  semanticLinks: SemanticLinkView[];
  runs: RunView[];
  metrics: MetricView[];
  evidence: EvidenceView[];
}> {
  const spaceRows = await query(
    client.from("spaces").select("*").eq("id", spaceId).limit(1),
  );
  const spaceRow = spaceRows[0];
  if (!spaceRow) {
    return {
      space: null,
      nodes: [],
      revisions: [],
      lineage: [],
      semanticLinks: [],
      runs: [],
      metrics: [],
      evidence: [],
    };
  }
  const workspaceId = stringValue(spaceRow, "workspace_id");
  const nodes = await query(
    client.from("nodes").select("*").eq("space_id", spaceId),
  );
  const nodeIds = nodes.map((node) => stringValue(node, "id"));
  const [
    revisions,
    lineageRows,
    semanticRows,
    runRows,
    metricRows,
    metricDefinitions,
    artifactRows,
    codeRows,
    dataRows,
  ] =
    nodeIds.length === 0
      ? [[], [], [], [], [], [], [], [], []]
      : await Promise.all([
          query(
            client
              .from("node_revisions")
              .select("*")
              .eq("space_id", spaceId)
              .order("revision_number"),
          ),
          query(
            client
              .from("node_lineage")
              .select("*")
              .eq("space_id", spaceId),
          ),
          query(
            client
              .from("semantic_links")
              .select("*")
              .eq("space_id", spaceId)
              .is("archived_at", null),
          ),
          query(
            client.from("runs").select("*").eq("space_id", spaceId),
          ),
          query(
            client
              .from("metric_observations")
              .select("*")
              .eq("space_id", spaceId),
          ),
          query(
            client
              .from("metric_definitions")
              .select("*")
              .eq("space_id", spaceId),
          ),
          query(
            client.from("artifacts").select("*").eq("space_id", spaceId),
          ),
          query(
            client
              .from("code_references")
              .select("*")
              .eq("space_id", spaceId),
          ),
          query(
            client
              .from("data_references")
              .select("*")
              .eq("space_id", spaceId),
          ),
        ]);

  const revisionViews = revisions.map((row) =>
    revisionView(row, stringValue(row, "node_id")),
  );
  const revisionById = new Map(
    revisions.map((revision) => [String(revision.id), revision]),
  );
  const revisionViewById = new Map(
    revisionViews.map((revision) => [revision.id, revision]),
  );
  const nodeViews: NodeView[] = nodes.map((node) => {
    const id = stringValue(node, "id");
    const currentRevisionId =
      typeof node.current_revision_id === "string"
        ? node.current_revision_id
        : null;
    const rawRevision = currentRevisionId
      ? revisionById.get(currentRevisionId) ?? {}
      : {};
    const currentRevision =
      (currentRevisionId
        ? revisionViewById.get(currentRevisionId)
        : undefined) ??
      revisionViews.find((revision) => revision.nodeId === id) ??
      revisionView({}, id);
    return {
      id,
      workspaceId,
      spaceId,
      kind: nodeKind(node, rawRevision),
      operationalState: operational(rawRevision, node),
      conclusionState: conclusion(rawRevision),
      currentRevisionId,
      finalizedRevisionId: node.finalized_at
        ? currentRevisionId
        : null,
      createdAt:
        typeof node.created_at === "string" ? node.created_at : null,
      revision: currentRevision,
    };
  });
  const nodeIdByRevision = new Map(
    revisions.map((revision) => [
      String(revision.id),
      String(revision.node_id),
    ]),
  );
  const runById = new Map(
    runRows.map((run) => [String(run.id), run]),
  );
  const definitionById = new Map(
    metricDefinitions.map((definition) => [
      String(definition.id),
      definition,
    ]),
  );

  function evidenceNodeId(row: Record<string, unknown>): string {
    const revisionId = optionalId(row.node_revision_id);
    if (revisionId) return nodeIdByRevision.get(revisionId) ?? "";
    const runId = optionalId(row.run_id);
    return runId
      ? stringValue(runById.get(runId) ?? {}, "experiment_node_id")
      : "";
  }

  const objective = nodes.find((node) => node.kind === "objective");
  return {
    space: {
      id: spaceId,
      workspaceId,
      name: stringValue(spaceRow, "name", "Untitled space"),
      slug: stringValue(spaceRow, "slug"),
      description:
        typeof spaceRow.description === "string"
          ? spaceRow.description
          : null,
      objectiveNodeId: stringValue(objective ?? {}, "id"),
    },
    nodes: nodeViews,
    revisions: revisionViews,
    lineage: lineageRows.map((edge) => ({
      id: stringValue(edge, "id"),
      parentNodeId: stringValue(edge, "parent_node_id"),
      childNodeId: stringValue(edge, "child_node_id"),
    })),
    semanticLinks: semanticRows.map((link) => ({
      id: stringValue(link, "id"),
      sourceNodeId: stringValue(link, "source_node_id"),
      targetNodeId: stringValue(link, "target_node_id"),
      linkType: semanticType(link.kind),
      rationale:
        typeof link.rationale === "string" ? link.rationale : null,
    })),
    runs: runRows.map((run) => ({
      id: stringValue(run, "id"),
      nodeId: stringValue(run, "experiment_node_id"),
      status: runStatus(run.status),
      seed:
        typeof asRecord(run.environment).seed === "number"
          ? Number(asRecord(run.environment).seed)
          : null,
      startedAt:
        typeof run.started_at === "string" ? run.started_at : null,
      completedAt:
        typeof run.finished_at === "string" ? run.finished_at : null,
      exitCode:
        typeof run.exit_code === "number" ? run.exit_code : null,
      errorMessage:
        typeof run.error_message === "string"
          ? run.error_message
          : null,
    })),
    metrics: metricRows.map((metric) => {
      const definition = definitionById.get(
        String(metric.metric_definition_id),
      );
      return {
        id: stringValue(metric, "id"),
        runId: stringValue(metric, "run_id"),
        name: stringValue(definition ?? {}, "name", "Metric"),
        value:
          typeof metric.value === "number" ? metric.value : Number.NaN,
        unit:
          typeof definition?.unit === "string" ? definition.unit : null,
      };
    }),
    evidence: [
      ...artifactRows.map((artifact): EvidenceView => ({
        id: stringValue(artifact, "id"),
        nodeId: evidenceNodeId(artifact),
        type: "artifact",
        label: stringValue(artifact, "name", "Artifact"),
        detail: `${String(artifact.media_type ?? "file")} · ${String(artifact.size_bytes ?? "—")} bytes`,
        checksum:
          typeof artifact.checksum === "string"
            ? artifact.checksum
            : null,
      })),
      ...codeRows.map((reference): EvidenceView => ({
        id: stringValue(reference, "id"),
        nodeId: evidenceNodeId(reference),
        type: "code",
        label: stringValue(
          reference,
          "repository_uri",
          "Code reference",
        ),
        detail: stringValue(reference, "commit_sha"),
        checksum:
          typeof reference.content_hash === "string"
            ? reference.content_hash
            : null,
      })),
      ...dataRows.map((reference): EvidenceView => ({
        id: stringValue(reference, "id"),
        nodeId: evidenceNodeId(reference),
        type: "data",
        label: stringValue(reference, "uri", "Data reference"),
        detail: stringValue(reference, "version"),
        checksum:
          typeof reference.checksum === "string"
            ? reference.checksum
            : null,
      })),
    ],
  };
}

function optionalId(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function semanticType(value: unknown): SemanticLinkType {
  return value === "supports" ||
    value === "contradicts" ||
    value === "replicates"
    ? value
    : "supports";
}

function runStatus(value: unknown): RunView["status"] {
  if (value === "running") return "running";
  if (value === "succeeded") return "completed";
  if (value === "failed" || value === "cancelled") return "failed";
  return "queued";
}
