import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import {
  archiveNodeSchema,
  createRevisionSchema,
  createTokenSchema,
  revokeTokenSchema,
  sha256Schema,
} from "@/lib/contracts";
import {
  checksumBytes,
  issuePersonalToken,
  recordAuditEvent,
  revokePersonalToken,
  TokenAuthenticationError,
} from "@/lib/server/admin";
import {
  assertPrincipalBoundary,
  authenticateRequest,
  AuthenticationError,
  requireScope,
  type AuthenticatedPrincipal,
  type WorkspaceGateway,
} from "@/lib/server/auth";
import { asRecord, stringValue } from "@/lib/utils";

const MUTATION_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const DATABASE_EXPORT_TABLES = [
  "workspaces",
  "workspace_members",
  "spaces",
  "nodes",
  "node_revisions",
  "node_lineage",
  "semantic_links",
  "runs",
  "metric_definitions",
  "metric_observations",
  "code_references",
  "data_references",
  "artifacts",
] as const;
const ALLOWED_ARTIFACT_MEDIA_TYPES = new Set([
  "application/json",
  "application/pdf",
  "application/zip",
  "application/octet-stream",
  "text/csv",
  "text/markdown",
  "text/plain",
  "text/x-diff",
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

interface ApiResult {
  status: number;
  data: unknown;
  headers?: Record<string, string>;
}

interface DispatchContext {
  request: Request;
  requestId: string;
  principal: AuthenticatedPrincipal;
  segments: string[];
  body: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function ok(data: unknown, status = 200): ApiResult {
  return { status, data };
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(
      422,
      "validation_error",
      "The request payload is invalid.",
      parsed.error.flatten(),
    );
  }
  return parsed.data;
}

function requireRecord(
  rows: Record<string, unknown>[],
  resource: string,
): Record<string, unknown> {
  if (!rows[0]) {
    throw new ApiError(404, "not_found", `${resource} was not found.`);
  }
  return rows[0];
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireUuid(value: unknown, field: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) {
    throw new ApiError(
      422,
      "validation_error",
      `${field} must be a UUID.`,
    );
  }
  return parsed.data;
}

function assertOptionalWorkspace(
  principal: AuthenticatedPrincipal,
  body: Record<string, unknown>,
) {
  const workspace = body.workspaceId ?? body.workspace_id;
  if (workspace !== undefined) {
    assertPrincipalBoundary(principal, String(workspace));
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function byteaHex(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.startsWith("\\x") ? value.slice(2) : value;
}

async function executeIdempotently(
  context: DispatchContext,
  operation: () => Promise<ApiResult>,
): Promise<ApiResult> {
  if (!MUTATION_METHODS.has(context.request.method)) return operation();
  const key = context.request.headers.get("idempotency-key");
  if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ApiError(
      400,
      "idempotency_key_required",
      "Mutations require an Idempotency-Key of 8 to 128 safe characters.",
    );
  }
  const requestHash = hashJson({
    method: context.request.method,
    path: context.segments,
    body: context.body,
  });
  const existing = (
    await context.principal.gateway.select("idempotency_keys", "*", {
      filters: { key },
      single: true,
    })
  )[0];
  if (existing) {
    const sameActor =
      context.principal.kind === "token"
        ? existing.api_token_id === context.principal.tokenId
        : existing.created_by === context.principal.actorId;
    if (!sameActor) {
      throw new ApiError(
        409,
        "idempotency_conflict",
        "This idempotency key belongs to another actor.",
      );
    }
    if (byteaHex(existing.request_hash) !== requestHash) {
      throw new ApiError(
        409,
        "idempotency_conflict",
        "This idempotency key was used for a different request.",
      );
    }
    if (existing.completed_at && existing.response_status) {
      return {
        status: Number(existing.response_status),
        data: existing.response_body ?? null,
        headers: { "Idempotency-Replayed": "true" },
      };
    }
    throw new ApiError(
      409,
      "request_in_progress",
      "A request with this idempotency key is still in progress.",
    );
  }

  const recordId = randomUUID();
  await context.principal.gateway.insert("idempotency_keys", {
    id: recordId,
    key,
    request_hash: `\\x${requestHash}`,
    api_token_id: context.principal.tokenId ?? null,
    created_by:
      context.principal.kind === "user"
        ? context.principal.actorId
        : null,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
  });
  try {
    const result = await operation();
    await context.principal.gateway.update(
      "idempotency_keys",
      {
        response_status: result.status,
        response_body: result.data,
        completed_at: new Date().toISOString(),
      },
      { id: recordId },
    );
    return result;
  } catch (error) {
    await context.principal.gateway
      .delete("idempotency_keys", { id: recordId })
      .catch(() => undefined);
    throw error;
  }
}

async function audit(
  context: DispatchContext,
  input: {
    action: string;
    resourceType: string;
    resourceId?: string;
    details?: Record<string, unknown>;
  },
) {
  await recordAuditEvent({
    workspaceId: context.principal.workspaceId,
    actorId: context.principal.actorId,
    tokenId: context.principal.tokenId,
    requestId: context.requestId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    details: input.details,
  });
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 62);
  return slug || `space-${randomUUID().slice(0, 8)}`;
}

async function readSpace(
  gateway: WorkspaceGateway,
  spaceId: string,
): Promise<Record<string, unknown>> {
  return requireRecord(
    await gateway.select("spaces", "*", {
      filters: { id: spaceId },
      single: true,
    }),
    "Space",
  );
}

async function readNode(
  gateway: WorkspaceGateway,
  nodeId: string,
): Promise<Record<string, unknown>> {
  return requireRecord(
    await gateway.select("nodes", "*", {
      filters: { id: nodeId },
      single: true,
    }),
    "Experiment",
  );
}

async function readCurrentRevision(
  gateway: WorkspaceGateway,
  node: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const revisionId = stringValue(node, "current_revision_id");
  if (!revisionId) {
    throw new ApiError(
      409,
      "missing_revision",
      "The experiment does not have a current revision.",
    );
  }
  return requireRecord(
    await gateway.select("node_revisions", "*", {
      filters: {
        id: revisionId,
        node_id: stringValue(node, "id"),
      },
      single: true,
    }),
    "Revision",
  );
}

async function createSpace(context: DispatchContext): Promise<ApiResult> {
  requireScope(context.principal, "spaces:write");
  const body = asRecord(context.body);
  assertOptionalWorkspace(context.principal, body);
  const name = parse(z.string().trim().min(1).max(120), body.name);
  const objectiveInput = body.objective;
  const objective =
    typeof objectiveInput === "string"
      ? objectiveInput.trim()
      : stringValue(asRecord(objectiveInput), "title").trim();
  if (!objective) {
    throw new ApiError(
      422,
      "validation_error",
      "objective must contain non-empty text.",
    );
  }
  const id = randomUUID();
  const slug =
    optionalString(body.slug) ??
    `${slugify(name).slice(0, 55)}-${id.slice(0, 6)}`;
  const space = requireRecord(
    await context.principal.gateway.insert("spaces", {
      id,
      name,
      slug,
      description: optionalString(body.description),
      created_by: context.principal.actorId,
    }),
    "Space",
  );
  const objectiveNode = requireRecord(
    await context.principal.gateway.select("nodes", "*", {
      filters: { space_id: id, kind: "objective" },
      single: true,
    }),
    "Objective",
  );
  const revision = requireRecord(
    await context.principal.gateway.insert("node_revisions", {
      id: randomUUID(),
      space_id: id,
      node_id: objectiveNode.id,
      revision_number: 1,
      state: "draft",
      title: objective,
      created_by: context.principal.actorId,
    }),
    "Objective revision",
  );
  await context.principal.gateway.update(
    "node_revisions",
    { state: "finalized" },
    { id: String(revision.id) },
  );
  await audit(context, {
    action: "space.created",
    resourceType: "space",
    resourceId: id,
  });
  return ok(
    {
      id,
      space,
      objective: { id: objectiveNode.id, revision_id: revision.id },
    },
    201,
  );
}

function preregistrationFields(body: Record<string, unknown>) {
  const revision = asRecord(body.revision);
  const state = String(
    revision.preregistrationState ??
      body.preregistration_state ??
      "",
  );
  const retrospective =
    body.retrospective === true || state === "retrospective";
  return {
    retrospective,
    preregistered_at:
      state === "preregistered" ? new Date().toISOString() : null,
  };
}

async function createExperiment(
  context: DispatchContext,
): Promise<ApiResult> {
  requireScope(context.principal, "nodes:write");
  const body = asRecord(context.body);
  assertOptionalWorkspace(context.principal, body);
  const revisionInput = asRecord(body.revision);
  const spaceId = requireUuid(
    body.spaceId ?? body.space_id,
    "space_id",
  );
  await readSpace(context.principal.gateway, spaceId);
  const title = parse(
    z.string().trim().min(1).max(240),
    revisionInput.title ?? body.title,
  );
  const hypothesis = optionalString(
    revisionInput.hypothesis ?? body.hypothesis,
  );
  if (!hypothesis) {
    throw new ApiError(
      422,
      "validation_error",
      "hypothesis is required.",
    );
  }
  const nodeId = randomUUID();
  const revisionId = randomUUID();
  const registration = preregistrationFields(body);
  const successCriteria = optionalString(
    revisionInput.successCriteria ?? body.success_criteria,
  );
  const metadata = {
    success_criteria: successCriteria,
    notes: optionalString(revisionInput.notes ?? body.notes),
    record_kind:
      body.kind === "synthesis" ? "synthesis" : "experiment",
  };
  await context.principal.gateway.insert("nodes", {
    id: nodeId,
    space_id: spaceId,
    kind: "experiment",
    created_by: context.principal.actorId,
  });
  try {
    await context.principal.gateway.insert("node_revisions", {
      id: revisionId,
      space_id: spaceId,
      node_id: nodeId,
      revision_number: 1,
      state: "draft",
      title,
      hypothesis,
      method: optionalString(revisionInput.method ?? body.method),
      conclusion: optionalString(
        revisionInput.conclusion ?? body.conclusion,
      ),
      operational_state: "planned",
      conclusion_state: "pending",
      ...registration,
      metadata,
      created_by: context.principal.actorId,
    });
    const parents = Array.isArray(body.lineageParentIds)
      ? body.lineageParentIds
      : [];
    if (parents.length > 0) {
      await context.principal.gateway.insert(
        "node_lineage",
        parents.map((parent) => ({
          id: randomUUID(),
          space_id: spaceId,
          parent_node_id: requireUuid(parent, "lineage parent"),
          child_node_id: nodeId,
          created_by: context.principal.actorId,
        })),
      );
    }
  } catch (error) {
    await context.principal.gateway
      .delete("nodes", { id: nodeId })
      .catch(() => undefined);
    throw error;
  }
  await audit(context, {
    action: "experiment.created",
    resourceType: "node",
    resourceId: nodeId,
  });
  return ok(
    {
      id: nodeId,
      experiment_id: nodeId,
      revision_id: revisionId,
    },
    201,
  );
}

function mapConclusionState(value: unknown): {
  database:
    | "pending"
    | "supported"
    | "refuted"
    | "mixed"
    | "inconclusive";
  declared: string;
} {
  const declared = typeof value === "string" ? value : "pending";
  if (declared === "supported") {
    return { database: "supported", declared };
  }
  if (declared === "refuted" || declared === "contradicted") {
    return { database: "refuted", declared: "refuted" };
  }
  if (declared === "mixed") {
    return { database: "mixed", declared };
  }
  if (declared === "inconclusive") {
    return { database: "inconclusive", declared };
  }
  return { database: "pending", declared: "pending" };
}

async function updateDraftRevision(
  context: DispatchContext,
  nodeId: string,
): Promise<ApiResult> {
  requireScope(context.principal, "nodes:write");
  const input = parse(createRevisionSchema, context.body);
  assertPrincipalBoundary(context.principal, input.workspaceId);
  const node = await readNode(context.principal.gateway, nodeId);
  const revision = await readCurrentRevision(
    context.principal.gateway,
    node,
  );
  const previousMetadata = asRecord(revision.metadata);
  const registration =
    input.content.preregistrationState === "preregistered"
      ? {
          preregistered_at:
            revision.preregistered_at ?? new Date().toISOString(),
          retrospective: false,
        }
      : input.content.preregistrationState === "retrospective"
        ? {
            preregistered_at: null,
            retrospective: true,
          }
      : {
          preregistered_at: revision.preregistered_at ?? null,
          retrospective: revision.retrospective === true,
        };
  if (revision.state !== "draft") {
    if (!input.editorial || !input.correctionReason) {
      throw new ApiError(
        409,
        "finalized_record",
        "Scientific changes require a child experiment; editorial corrections require a reason.",
      );
    }
    const editorialRevisionId = randomUUID();
    const editorialRevision = requireRecord(
      await context.principal.gateway.insert("node_revisions", {
        id: editorialRevisionId,
        space_id: node.space_id,
        node_id: nodeId,
        revision_number: Number(revision.revision_number) + 1,
        state: "draft",
        title: input.content.title,
        hypothesis: input.content.hypothesis,
        method: input.content.method,
        conclusion: input.content.conclusion,
        operational_state: revision.operational_state,
        conclusion_state: revision.conclusion_state,
        ...registration,
        change_summary: input.correctionReason,
        metadata: {
          ...previousMetadata,
          success_criteria: input.content.successCriteria,
          notes: input.content.notes,
          editorial_correction: true,
          correction_reason: input.correctionReason,
        },
        created_by: context.principal.actorId,
      }),
      "Editorial revision",
    );
    await audit(context, {
      action: "experiment.editorial_revision_created",
      resourceType: "node_revision",
      resourceId: editorialRevisionId,
    });
    return ok({ revision: editorialRevision }, 201);
  }
  const updated = requireRecord(
    await context.principal.gateway.update(
      "node_revisions",
      {
        title: input.content.title,
        hypothesis: input.content.hypothesis,
        method: input.content.method,
        conclusion: input.content.conclusion,
        ...registration,
        metadata: {
          ...previousMetadata,
          success_criteria: input.content.successCriteria,
          notes: input.content.notes,
        },
      },
      { id: String(revision.id) },
    ),
    "Revision",
  );
  await audit(context, {
    action: "experiment.draft_updated",
    resourceType: "node_revision",
    resourceId: String(revision.id),
  });
  return ok({ revision: updated });
}

async function finalizeExperiment(
  context: DispatchContext,
  nodeId: string,
): Promise<ApiResult> {
  requireScope(context.principal, "nodes:write");
  const body = asRecord(context.body);
  assertOptionalWorkspace(context.principal, body);
  const node = await readNode(context.principal.gateway, nodeId);
  const revision = await readCurrentRevision(
    context.principal.gateway,
    node,
  );
  if (revision.state === "finalized") {
    return ok({
      id: nodeId,
      experiment_id: nodeId,
      revision_id: revision.id,
      state: "finalized",
    });
  }
  const conclusionInput = asRecord(body.conclusion);
  const declaredState =
    conclusionInput.state ?? body.conclusionState ?? body.conclusion_state;
  const conclusionState = mapConclusionState(declaredState);
  const conclusionSummary =
    optionalString(conclusionInput.summary) ??
    optionalString(revision.conclusion);
  const metadata = {
    ...asRecord(revision.metadata),
    declared_conclusion_state: conclusionState.declared,
    limitations: Array.isArray(conclusionInput.limitations)
      ? conclusionInput.limitations
      : [],
  };
  const updated = requireRecord(
    await context.principal.gateway.update(
      "node_revisions",
      {
        state: "finalized",
        conclusion: conclusionSummary,
        conclusion_state: conclusionState.database,
        operational_state:
          conclusionState.database === "pending" ? "ready" : "completed",
        metadata,
      },
      { id: String(revision.id) },
    ),
    "Revision",
  );
  await audit(context, {
    action: "experiment.finalized",
    resourceType: "node",
    resourceId: nodeId,
    details: { revision_id: revision.id },
  });
  return ok({
    id: nodeId,
    experiment_id: nodeId,
    revision: updated,
  });
}

async function archiveExperiment(
  context: DispatchContext,
  nodeId: string,
): Promise<ApiResult> {
  requireScope(context.principal, "nodes:write");
  const body = asRecord(context.body);
  const input = parse(archiveNodeSchema, {
    workspaceId:
      body.workspaceId ?? context.principal.workspaceId,
    reason: body.reason,
  });
  assertPrincipalBoundary(context.principal, input.workspaceId);
  const node = await readNode(context.principal.gateway, nodeId);
  if (!node.finalized_at) {
    throw new ApiError(
      409,
      "invalid_lifecycle_transition",
      "Delete an abandoned draft instead of archiving it.",
    );
  }
  const archivedAt = new Date().toISOString();
  await context.principal.gateway.update(
    "nodes",
    { archived_at: archivedAt },
    { id: nodeId },
  );
  const revision = await readCurrentRevision(
    context.principal.gateway,
    node,
  );
  await context.principal.gateway.update(
    "node_revisions",
    { archived_at: archivedAt },
    { id: String(revision.id) },
  );
  await audit(context, {
    action: "experiment.archived",
    resourceType: "node",
    resourceId: nodeId,
  });
  return ok({ id: nodeId, archived: true });
}

async function nodeDetail(
  context: DispatchContext,
  nodeId: string,
): Promise<ApiResult> {
  requireScope(context.principal, "nodes:read");
  const node = await readNode(context.principal.gateway, nodeId);
  const spaceId = stringValue(node, "space_id");
  const revisions = await context.principal.gateway.select(
    "node_revisions",
    "*",
    {
      filters: { node_id: nodeId, space_id: spaceId },
      order: { column: "revision_number" },
    },
  );
  const runs = await context.principal.gateway.select("runs", "*", {
    filters: { experiment_node_id: nodeId, space_id: spaceId },
    order: { column: "created_at", ascending: false },
  });
  const runIds = runs.map((run) => String(run.id));
  const [
    incoming,
    outgoing,
    semanticSource,
    semanticTarget,
    metrics,
    artifacts,
    codeReferences,
    dataReferences,
  ] = await Promise.all([
    context.principal.gateway.select("node_lineage", "*", {
      filters: { space_id: spaceId, child_node_id: nodeId },
    }),
    context.principal.gateway.select("node_lineage", "*", {
      filters: { space_id: spaceId, parent_node_id: nodeId },
    }),
    context.principal.gateway.select("semantic_links", "*", {
      filters: { space_id: spaceId, source_node_id: nodeId },
    }),
    context.principal.gateway.select("semantic_links", "*", {
      filters: { space_id: spaceId, target_node_id: nodeId },
    }),
    runIds.length
      ? context.principal.gateway.select("metric_observations", "*", {
          filters: { space_id: spaceId },
          in: { column: "run_id", values: runIds },
        })
      : Promise.resolve([]),
    context.principal.gateway.select("artifacts", "*", {
      filters: { space_id: spaceId },
    }),
    context.principal.gateway.select("code_references", "*", {
      filters: { space_id: spaceId },
    }),
    context.principal.gateway.select("data_references", "*", {
      filters: { space_id: spaceId },
    }),
  ]);
  const revisionIds = new Set(revisions.map((item) => String(item.id)));
  return ok({
    id: nodeId,
    experiment: node,
    node,
    revisions,
    lineage_edges: [...incoming, ...outgoing],
    semantic_links: [...semanticSource, ...semanticTarget],
    runs,
    metrics,
    artifacts: artifacts.filter(
      (item) =>
        revisionIds.has(String(item.node_revision_id)) ||
        runIds.includes(String(item.run_id)),
    ),
    code_references: codeReferences.filter(
      (item) =>
        revisionIds.has(String(item.node_revision_id)) ||
        runIds.includes(String(item.run_id)),
    ),
    data_references: dataReferences.filter(
      (item) =>
        revisionIds.has(String(item.node_revision_id)) ||
        runIds.includes(String(item.run_id)),
    ),
  });
}

async function createLineage(
  context: DispatchContext,
): Promise<ApiResult> {
  requireScope(context.principal, "nodes:write");
  const body = asRecord(context.body);
  assertOptionalWorkspace(context.principal, body);
  const parentId = requireUuid(
    body.parentNodeId ?? body.parent_experiment_id,
    "parent experiment",
  );
  const childId = requireUuid(
    body.childNodeId ?? body.child_experiment_id,
    "child experiment",
  );
  const [parent, child] = await Promise.all([
    readNode(context.principal.gateway, parentId),
    readNode(context.principal.gateway, childId),
  ]);
  const spaceId = stringValue(parent, "space_id");
  if (!spaceId || spaceId !== child.space_id) {
    throw new ApiError(
      422,
      "invalid_lineage",
      "Lineage endpoints must belong to the same space.",
    );
  }
  if (child.finalized_at) {
    throw new ApiError(
      409,
      "finalized_record",
      "Lineage can only be changed while the child is a draft.",
    );
  }
  const kind = parse(
    z.enum(["derived_from", "synthesizes"]),
    body.type ?? "derived_from",
  );
  const id = randomUUID();
  await context.principal.gateway.insert("node_lineage", {
    id,
    space_id: spaceId,
    parent_node_id: parentId,
    child_node_id: childId,
    kind,
    created_by: context.principal.actorId,
  });
  await audit(context, {
    action: "lineage.created",
    resourceType: "lineage_edge",
    resourceId: id,
  });
  return ok(
    {
      id,
      type: kind,
      parent_experiment_id: parentId,
      child_experiment_id: childId,
    },
    201,
  );
}

async function createSemantic(
  context: DispatchContext,
): Promise<ApiResult> {
  requireScope(context.principal, "nodes:write");
  const body = asRecord(context.body);
  assertOptionalWorkspace(context.principal, body);
  const sourceId = requireUuid(
    body.sourceNodeId ?? body.source_experiment_id,
    "source experiment",
  );
  const targetId = requireUuid(
    body.targetNodeId ?? body.target_experiment_id,
    "target experiment",
  );
  const [source, target] = await Promise.all([
    readNode(context.principal.gateway, sourceId),
    readNode(context.principal.gateway, targetId),
  ]);
  const spaceId = stringValue(source, "space_id");
  if (!spaceId || target.space_id !== spaceId) {
    throw new ApiError(
      422,
      "invalid_semantic_link",
      "Semantic links must stay inside one space.",
    );
  }
  const targetRevision = await readCurrentRevision(
    context.principal.gateway,
    target,
  );
  if (targetRevision.state !== "finalized") {
    throw new ApiError(
      409,
      "target_not_finalized",
      "A semantic link must target a finalized revision.",
    );
  }
  const kind = parse(
    z.enum(["supports", "contradicts", "replicates"]),
    body.linkType ?? body.relation,
  );
  const id = randomUUID();
  await context.principal.gateway.insert("semantic_links", {
    id,
    space_id: spaceId,
    source_node_id: sourceId,
    target_node_id: targetId,
    target_revision_id: targetRevision.id,
    kind,
    rationale: optionalString(body.rationale ?? body.note),
    created_by: context.principal.actorId,
  });
  await audit(context, {
    action: "semantic_link.created",
    resourceType: "semantic_link",
    resourceId: id,
  });
  return ok(
    {
      id,
      source_experiment_id: sourceId,
      target_experiment_id: targetId,
      relation: kind,
    },
    201,
  );
}

async function createRun(context: DispatchContext): Promise<ApiResult> {
  requireScope(context.principal, "runs:write");
  const body = asRecord(context.body);
  assertOptionalWorkspace(context.principal, body);
  const nodeId = requireUuid(
    body.nodeId ?? body.experiment_id,
    "experiment_id",
  );
  const node = await readNode(context.principal.gateway, nodeId);
  const revisionId =
    optionalString(body.revisionId ?? body.revision_id) ??
    stringValue(node, "current_revision_id");
  const revision = requireRecord(
    await context.principal.gateway.select("node_revisions", "*", {
      filters: {
        id: revisionId,
        node_id: nodeId,
        space_id: stringValue(node, "space_id"),
      },
      single: true,
    }),
    "Revision",
  );
  if (revision.state !== "draft" || node.finalized_at) {
    throw new ApiError(
      409,
      "revision_not_draft",
      "Runs require the current draft experiment revision.",
    );
  }
  const environmentInput = asRecord(body.environment);
  const parameters = asRecord(body.parameters);
  const environment: Record<string, unknown> = {
    ...environmentInput,
    client_run_id: body.client_run_id ?? null,
    seed: body.seed ?? null,
  };
  const id = randomUUID();
  await context.principal.gateway.insert("runs", {
    id,
    space_id: node.space_id,
    experiment_node_id: nodeId,
    revision_id: revisionId,
    status: body.status === "queued" ? "queued" : "running",
    command:
      optionalString(body.command) ??
      (Array.isArray(environmentInput.command)
        ? environmentInput.command.join(" ")
        : null),
    environment,
    parameters,
    started_at:
      optionalString(body.startedAt ?? body.started_at) ??
      new Date().toISOString(),
    created_by: context.principal.actorId,
  });
  await audit(context, {
    action: "run.started",
    resourceType: "run",
    resourceId: id,
  });
  return ok({ id, run_id: id, status: "running" }, 201);
}

async function readRun(
  gateway: WorkspaceGateway,
  runId: string,
): Promise<Record<string, unknown>> {
  return requireRecord(
    await gateway.select("runs", "*", {
      filters: { id: runId },
      single: true,
    }),
    "Run",
  );
}

interface ManifestMetric {
  name: string;
  value: number;
  unit: string | null;
  direction: "maximize" | "minimize" | "neutral";
  description: string | null;
  dimensions: Record<string, unknown>;
}

function manifestMetrics(body: Record<string, unknown>): ManifestMetric[] {
  const directMetrics = Array.isArray(body.metrics) ? body.metrics : null;
  if (directMetrics) {
    return directMetrics.flatMap((item) => {
      const metric = asRecord(item);
      if (
        typeof metric.name !== "string" ||
        typeof metric.value !== "number" ||
        !Number.isFinite(metric.value)
      ) {
        return [];
      }
      return [
        {
          name: metric.name,
          value: metric.value,
          unit: optionalString(metric.unit),
          direction: "neutral" as const,
          description: null,
          dimensions:
            typeof metric.step === "number"
              ? { step: metric.step }
              : {},
        },
      ];
    });
  }
  const manifest = asRecord(body.result_manifest ?? body.resultManifest);
  const metrics = asRecord(manifest.metrics);
  const parsed: ManifestMetric[] = [];
  for (const [name, raw] of Object.entries(metrics)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      parsed.push({
        name,
        value: raw,
        unit: null,
        direction: "neutral",
        description: null,
        dimensions: {},
      });
      continue;
    }
    const metric = asRecord(raw);
    if (
      typeof metric.value !== "number" ||
      !Number.isFinite(metric.value)
    ) {
      continue;
    }
    const direction =
      metric.direction === "higher_is_better"
        ? "maximize"
        : metric.direction === "lower_is_better"
          ? "minimize"
          : "neutral";
    parsed.push({
      name,
      value: metric.value,
      unit: optionalString(metric.unit),
      direction,
      description: optionalString(metric.description),
      dimensions: {
        lower_bound: metric.lower_bound ?? null,
        upper_bound: metric.upper_bound ?? null,
      },
    });
  }
  return parsed;
}

async function persistMetrics(
  context: DispatchContext,
  run: Record<string, unknown>,
  metrics: ManifestMetric[],
) {
  for (const metric of metrics) {
    let definition = (
      await context.principal.gateway.select("metric_definitions", "*", {
        filters: {
          space_id: stringValue(run, "space_id"),
          name: metric.name,
        },
        single: true,
      })
    )[0];
    if (!definition) {
      definition = requireRecord(
        await context.principal.gateway.insert("metric_definitions", {
          id: randomUUID(),
          space_id: run.space_id,
          name: metric.name,
          description: metric.description,
          unit: metric.unit,
          direction: metric.direction,
          created_by: context.principal.actorId,
        }),
        "Metric definition",
      );
    }
    await context.principal.gateway.insert("metric_observations", {
      id: randomUUID(),
      space_id: run.space_id,
      run_id: run.id,
      metric_definition_id: definition.id,
      value: metric.value,
      dimensions: metric.dimensions,
      created_by: context.principal.actorId,
    });
  }
}

async function completeRun(
  context: DispatchContext,
  runId: string,
): Promise<ApiResult> {
  requireScope(context.principal, "runs:write");
  const body = asRecord(context.body);
  assertOptionalWorkspace(context.principal, body);
  const run = await readRun(context.principal.gateway, runId);
  if (run.status === "succeeded") {
    return ok({ id: runId, run_id: runId, status: "succeeded" });
  }
  if (run.status !== "running" && run.status !== "queued") {
    throw new ApiError(
      409,
      "invalid_run_transition",
      "Only a queued or running run can complete.",
    );
  }
  const metrics = manifestMetrics(body);
  await persistMetrics(context, run, metrics);
  const resultManifest = asRecord(
    body.result_manifest ?? body.resultManifest,
  );
  const manifestParameters = asRecord(resultManifest.parameters);
  const resultMetadata = {
    ...asRecord(run.metadata),
    local_log: body.local_log ?? null,
    audit: body.audit ?? null,
    duration_seconds: body.duration_seconds ?? null,
    artifacts: body.artifacts ?? [],
  };
  await context.principal.gateway.update(
    "runs",
    {
      status: "succeeded",
      finished_at:
        optionalString(body.ended_at ?? body.completedAt) ??
        new Date().toISOString(),
      exit_code:
        typeof body.exit_code === "number"
          ? body.exit_code
          : typeof body.exitCode === "number"
            ? body.exitCode
            : 0,
      parameters:
        Object.keys(manifestParameters).length > 0
          ? manifestParameters
          : asRecord(run.parameters),
      result_manifest_version:
        optionalString(resultManifest.schema_version) ?? null,
      result_manifest: resultManifest,
      narrative: optionalString(resultManifest.narrative),
      metadata: resultMetadata,
    },
    { id: runId },
  );
  await audit(context, {
    action: "run.completed",
    resourceType: "run",
    resourceId: runId,
    details: { metric_count: metrics.length },
  });
  return ok({ id: runId, run_id: runId, status: "succeeded" });
}

async function failRun(
  context: DispatchContext,
  runId: string,
): Promise<ApiResult> {
  requireScope(context.principal, "runs:write");
  const body = asRecord(context.body);
  assertOptionalWorkspace(context.principal, body);
  const run = await readRun(context.principal.gateway, runId);
  if (run.status === "failed") {
    return ok({ id: runId, run_id: runId, status: "failed" });
  }
  if (run.status !== "running" && run.status !== "queued") {
    throw new ApiError(
      409,
      "invalid_run_transition",
      "Only a queued or running run can fail.",
    );
  }
  const errorMessage =
    optionalString(body.errorMessage ?? body.error) ??
    "The local run failed.";
  await context.principal.gateway.update(
    "runs",
    {
      status: "failed",
      finished_at:
        optionalString(body.ended_at ?? body.completedAt) ??
        new Date().toISOString(),
      exit_code:
        typeof body.exit_code === "number"
          ? body.exit_code
          : typeof body.exitCode === "number"
            ? body.exitCode
            : null,
      error_message: errorMessage,
      metadata: {
        ...asRecord(run.metadata),
        failure_kind: body.failure_kind ?? null,
        local_log: body.local_log ?? null,
        audit: body.audit ?? null,
        artifacts: body.artifacts ?? [],
      },
    },
    { id: runId },
  );
  await audit(context, {
    action: "run.failed",
    resourceType: "run",
    resourceId: runId,
  });
  return ok({ id: runId, run_id: runId, status: "failed" });
}

function safeArtifactName(fileName: string): string {
  return fileName
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

async function prepareArtifact(
  context: DispatchContext,
): Promise<ApiResult> {
  requireScope(context.principal, "artifacts:write");
  const body = asRecord(context.body);
  assertOptionalWorkspace(context.principal, body);
  const runId = optionalString(body.runId ?? body.run_id);
  const nodeId = optionalString(body.nodeId ?? body.node_id);
  let spaceId: string;
  let revisionId: string | null = null;
  if (runId) {
    const run = await readRun(context.principal.gateway, runId);
    spaceId = stringValue(run, "space_id");
  } else if (nodeId) {
    const node = await readNode(context.principal.gateway, nodeId);
    const revision = await readCurrentRevision(
      context.principal.gateway,
      node,
    );
    spaceId = stringValue(node, "space_id");
    revisionId = String(revision.id);
  } else {
    throw new ApiError(
      422,
      "validation_error",
      "An artifact must belong to a run or node revision.",
    );
  }
  const fileName = parse(
    z
      .string()
      .trim()
      .min(1)
      .max(180)
      .refine(
        (value) => !value.includes("/") && !value.includes("\\"),
        "filename cannot contain path segments",
      ),
    body.fileName ?? body.filename,
  );
  const mediaType = parse(
    z.string().trim().min(1).max(120),
    body.mimeType ?? body.media_type,
  );
  if (!ALLOWED_ARTIFACT_MEDIA_TYPES.has(mediaType)) {
    throw new ApiError(
      422,
      "unsupported_artifact_type",
      `Artifacts with media type ${mediaType} are not allowed.`,
    );
  }
  const sizeBytes = parse(
    z.number().int().positive().max(MAX_ARTIFACT_BYTES),
    body.sizeBytes ?? body.size_bytes,
  );
  const checksum = parse(sha256Schema, body.sha256);
  const id = randomUUID();
  const path = `${spaceId}/${id}/${safeArtifactName(fileName)}`;
  const artifact = requireRecord(
    await context.principal.gateway.insert("artifacts", {
      id,
      space_id: spaceId,
      node_revision_id: revisionId,
      run_id: runId,
      name: fileName,
      media_type: mediaType,
      size_bytes: sizeBytes,
      checksum_algorithm: "sha256",
      checksum,
      storage_path: path,
      owner_user_id: context.principal.actorId,
      metadata: {
        kind: body.kind ?? "artifact",
        secret_scan: body.secret_scan ?? null,
      },
      created_by: context.principal.actorId,
    }),
    "Artifact",
  );
  const signed =
    await context.principal.gateway.createSignedArtifactUpload(path);
  return ok(
    {
      artifact,
      artifactId: id,
      artifact_id: id,
      path,
      token: signed.token,
      signedUrl: signed.signedUrl,
      upload_url: signed.signedUrl,
      upload_headers: {
        "content-type": mediaType,
        "x-upsert": "false",
      },
      upload: {
        url: signed.signedUrl,
        headers: {
          "content-type": mediaType,
          "x-upsert": "false",
        },
        expires_in_seconds: 7200,
      },
    },
    201,
  );
}

async function finalizeArtifact(
  context: DispatchContext,
  artifactId: string,
): Promise<ApiResult> {
  requireScope(context.principal, "artifacts:write");
  const body = asRecord(context.body);
  assertOptionalWorkspace(context.principal, body);
  const artifact = requireRecord(
    await context.principal.gateway.select("artifacts", "*", {
      filters: { id: artifactId },
      single: true,
    }),
    "Artifact",
  );
  const checksum = parse(sha256Schema, body.sha256);
  const path = stringValue(artifact, "storage_path");
  const [info, blob] = await Promise.all([
    context.principal.gateway.artifactInfo(path),
    context.principal.gateway.downloadArtifact(path),
  ]);
  const actualSize =
    typeof asRecord(info).size === "number"
      ? Number(asRecord(info).size)
      : blob.size;
  const declaredSize =
    typeof body.size_bytes === "number"
      ? body.size_bytes
      : Number(artifact.size_bytes);
  if (actualSize !== declaredSize) {
    throw new ApiError(
      422,
      "artifact_size_mismatch",
      "The uploaded artifact size does not match its declaration.",
    );
  }
  const actualMime = blob.type.split(";", 1)[0]?.trim().toLowerCase();
  const declaredMime = String(artifact.media_type).toLowerCase();
  if (
    actualMime &&
    actualMime !== "application/octet-stream" &&
    actualMime !== declaredMime
  ) {
    throw new ApiError(
      422,
      "artifact_mime_mismatch",
      "The uploaded artifact MIME type does not match its declaration.",
    );
  }
  const actualChecksum = checksumBytes(await blob.arrayBuffer());
  if (actualChecksum !== checksum || actualChecksum !== artifact.checksum) {
    throw new ApiError(
      422,
      "artifact_checksum_mismatch",
      "The uploaded artifact checksum does not match its declaration.",
    );
  }
  await audit(context, {
    action: "artifact.verified",
    resourceType: "artifact",
    resourceId: artifactId,
    details: { checksum: actualChecksum, size_bytes: actualSize },
  });
  return ok({
    artifact: { ...artifact, verified: true },
    artifact_id: artifactId,
    sha256: actualChecksum,
    size_bytes: actualSize,
  });
}

async function searchNodes(context: DispatchContext): Promise<ApiResult> {
  requireScope(context.principal, "nodes:read");
  const url = new URL(context.request.url);
  const query = parse(
    z.string().trim().min(1).max(200),
    url.searchParams.get("q"),
  ).toLocaleLowerCase();
  const requestedSpace =
    url.searchParams.get("space_id") ??
    url.searchParams.get("spaceId");
  if (requestedSpace) await readSpace(context.principal.gateway, requestedSpace);
  const revisions = await context.principal.gateway.select(
    "node_revisions",
    "*",
    {
      filters: requestedSpace ? { space_id: requestedSpace } : {},
      order: { column: "updated_at", ascending: false },
      limit: 500,
    },
  );
  const operational =
    url.searchParams.get("operational_state") ??
    url.searchParams.get("operationalState");
  const conclusion =
    url.searchParams.get("conclusion_state") ??
    url.searchParams.get("conclusionState");
  const results = revisions
    .filter(
      (revision) =>
        (!operational ||
          revision.operational_state === operational) &&
        (!conclusion ||
          revision.conclusion_state === conclusion ||
          asRecord(revision.metadata).declared_conclusion_state ===
            conclusion),
    )
    .filter((revision) =>
      [
        revision.title,
        revision.hypothesis,
        revision.method,
        revision.conclusion,
      ]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.toLocaleLowerCase().includes(query)),
    )
    .slice(0, 100);
  return ok({ results, total: results.length });
}

function exportKey(table: string): string {
  return table === "node_lineage" ? "lineage_edges" : table;
}

async function exportRecords(context: DispatchContext): Promise<ApiResult> {
  requireScope(context.principal, "export:read");
  const url = new URL(context.request.url);
  const spaceId =
    url.searchParams.get("space_id") ??
    url.searchParams.get("spaceId");
  if (spaceId) await readSpace(context.principal.gateway, spaceId);
  const records: Record<string, Record<string, unknown>[]> = {};
  for (const table of DATABASE_EXPORT_TABLES) {
    const rows = await context.principal.gateway.select(table, "*", {
      filters:
        spaceId && table !== "workspaces" && table !== "workspace_members"
          ? table === "spaces"
            ? { id: spaceId }
            : { space_id: spaceId }
          : {},
    });
    records[exportKey(table)] = rows;
  }
  const includeArtifacts =
    url.searchParams.get("include_artifacts") === "true";
  const artifacts: Record<string, unknown>[] = [];
  if (includeArtifacts) {
    for (const artifact of records.artifacts ?? []) {
      const path = optionalString(artifact.storage_path);
      if (!path) continue;
      const signed =
        await context.principal.gateway.createSignedArtifactDownload(path);
      artifacts.push({
        path,
        download_url: signed.signedUrl,
        sha256: artifact.checksum,
        size_bytes: artifact.size_bytes,
      });
    }
  }
  const exportedAt = new Date().toISOString();
  const schemaVersions = Object.fromEntries(
    Object.keys(records).map((key) => [key, "1.0"]),
  );
  const markdown = {
    summary: [
      "# QDAG export",
      "",
      `Exported: ${exportedAt}`,
      `Workspace: ${context.principal.workspaceId}`,
      "",
      ...Object.entries(records).map(
        ([key, rows]) => `- ${key}: ${rows.length}`,
      ),
    ].join("\n"),
  };
  const bundleData = {
    schemaVersion: "1.0",
    exportedAt,
    workspaceId: context.principal.workspaceId,
    checksum: hashJson(records),
    data: records,
  };
  return ok({
    exported_at: exportedAt,
    schema_versions: schemaVersions,
    records,
    markdown,
    artifacts,
    bundle: bundleData,
  });
}

function validateImportPaths(
  records: Record<string, unknown>,
  allowedSpaceIds: Set<string>,
) {
  const artifacts = Array.isArray(records.artifacts)
    ? records.artifacts
    : [];
  for (const value of artifacts) {
    const artifact = asRecord(value);
    const path = optionalString(artifact.storage_path);
    if (!path) continue;
    const [spaceId] = path.split("/");
    if (
      !allowedSpaceIds.has(spaceId) ||
      path.includes("..") ||
      path.includes("\\") ||
      path.startsWith("/")
    ) {
      throw new ApiError(
        422,
        "unsafe_import_path",
        "The backup contains an unsafe artifact path.",
      );
    }
  }
}

async function restoreRecords(context: DispatchContext): Promise<ApiResult> {
  requireScope(context.principal, "import:write");
  const body = asRecord(context.body);
  assertOptionalWorkspace(context.principal, body);
  let records = asRecord(body.records);
  if (Object.keys(records).length === 0) {
    const bundle = asRecord(body.bundle);
    records = asRecord(bundle.data);
    const expected = optionalString(bundle.checksum);
    if (expected && hashJson(records) !== expected) {
      throw new ApiError(
        422,
        "bundle_checksum_mismatch",
        "The backup bundle checksum is invalid.",
      );
    }
  }
  if (records.lineage_edges && !records.node_lineage) {
    records.node_lineage = records.lineage_edges;
  }
  const spaces = Array.isArray(records.spaces)
    ? records.spaces.map(asRecord)
    : [];
  const allowedSpaceIds = new Set(
    spaces.map((space) => String(space.id ?? "")),
  );
  validateImportPaths(records, allowedSpaceIds);
  const mode = body.mode ?? (body.dry_run ? "validate" : "restore");
  if (mode === "validate") {
    return ok({
      valid: true,
      archive_sha256: body.archive_sha256 ?? null,
      record_resources: Object.keys(records).sort(),
    });
  }

  const actorId = context.principal.actorId;
  const existingSpaces = await context.principal.gateway.select("spaces", "*");
  const existingSpaceIds = new Set(
    existingSpaces.map((space) => String(space.id)),
  );
  const spaceArchiveTimes = new Map<string, unknown>();
  for (const row of spaces) {
    const spaceId = String(row.id ?? "");
    spaceArchiveTimes.set(spaceId, row.archived_at);
    if (existingSpaceIds.has(spaceId)) continue;
    await context.principal.gateway.insert("spaces", {
      id: spaceId,
      name: row.name,
      slug: row.slug,
      description: row.description ?? null,
      created_by: actorId,
      created_at: row.created_at,
    });
    existingSpaceIds.add(spaceId);
  }

  const importedNodes = Array.isArray(records.nodes)
    ? records.nodes.map(asRecord)
    : [];
  const nodeIdMap = new Map<string, string>();
  const nodeArchiveTimes = new Map<string, unknown>();
  for (const space of spaces) {
    const spaceId = String(space.id);
    const importedObjective = importedNodes.find(
      (node) =>
        node.space_id === spaceId && node.kind === "objective",
    );
    const currentObjective = requireRecord(
      await context.principal.gateway.select("nodes", "*", {
        filters: { space_id: spaceId, kind: "objective" },
        single: true,
      }),
      "Restored objective",
    );
    if (importedObjective) {
      nodeIdMap.set(
        String(importedObjective.id),
        String(currentObjective.id),
      );
    }
  }
  for (const node of importedNodes) {
    const sourceId = String(node.id ?? "");
    nodeArchiveTimes.set(sourceId, node.archived_at);
    if (node.kind === "objective") continue;
    nodeIdMap.set(sourceId, sourceId);
    const existing = await context.principal.gateway.select("nodes", "id", {
      filters: { id: sourceId },
      single: true,
    });
    if (existing[0]) continue;
    await context.principal.gateway.insert("nodes", {
      id: sourceId,
      space_id: node.space_id,
      kind: "experiment",
      created_by: actorId,
      created_at: node.created_at,
    });
  }

  const lineageRows = Array.isArray(records.node_lineage)
    ? records.node_lineage.map(asRecord)
    : [];
  for (const edge of lineageRows) {
    const id = String(edge.id ?? randomUUID());
    const exists = await context.principal.gateway.select(
      "node_lineage",
      "id",
      { filters: { id }, single: true },
    );
    if (exists[0]) continue;
    await context.principal.gateway.insert("node_lineage", {
      id,
      space_id: edge.space_id,
      parent_node_id:
        nodeIdMap.get(String(edge.parent_node_id)) ??
        edge.parent_node_id,
      child_node_id:
        nodeIdMap.get(String(edge.child_node_id)) ??
        edge.child_node_id,
      kind: edge.kind ?? "derived_from",
      created_by: actorId,
      created_at: edge.created_at,
    });
  }

  const importedMetricDefinitions = Array.isArray(records.metric_definitions)
    ? records.metric_definitions.map(asRecord)
    : [];
  for (const definition of importedMetricDefinitions) {
    const id = String(definition.id ?? randomUUID());
    const existing = await context.principal.gateway.select(
      "metric_definitions",
      "id",
      { filters: { id }, single: true },
    );
    if (existing[0]) continue;
    await context.principal.gateway.insert("metric_definitions", {
      ...definition,
      id,
      created_by: actorId,
    });
  }

  const importedRuns = Array.isArray(records.runs)
    ? records.runs.map(asRecord)
    : [];
  const importedRevisions = Array.isArray(records.node_revisions)
    ? records.node_revisions.map(asRecord)
    : [];
  importedRevisions.sort((left, right) => {
    const nodeOrder = String(left.node_id).localeCompare(
      String(right.node_id),
    );
    if (nodeOrder !== 0) return nodeOrder;
    return Number(left.revision_number) - Number(right.revision_number);
  });
  for (const revision of importedRevisions) {
    const id = String(revision.id ?? "");
    const existing = await context.principal.gateway.select(
      "node_revisions",
      "id",
      { filters: { id }, single: true },
    );
    const wasFinalized = revision.state === "finalized";
    if (!existing[0]) {
      await context.principal.gateway.insert("node_revisions", {
        id,
        space_id: revision.space_id,
        node_id:
          nodeIdMap.get(String(revision.node_id)) ?? revision.node_id,
        revision_number: revision.revision_number,
        state: "draft",
        title: revision.title,
        hypothesis: revision.hypothesis ?? null,
        method: revision.method ?? null,
        conclusion: revision.conclusion ?? null,
        operational_state: revision.operational_state ?? null,
        conclusion_state: revision.conclusion_state ?? null,
        preregistered_at: revision.preregistered_at ?? null,
        retrospective: revision.retrospective === true,
        change_summary: revision.change_summary ?? null,
        metadata: {
          ...asRecord(revision.metadata),
          imported_created_at: revision.created_at ?? null,
          imported_finalized_at: revision.finalized_at ?? null,
        },
        created_by: actorId,
      });
    }

    for (const run of importedRuns.filter(
      (candidate) => String(candidate.revision_id) === id,
    )) {
      const runId = String(run.id ?? randomUUID());
      const existingRun = await context.principal.gateway.select(
        "runs",
        "id",
        { filters: { id: runId }, single: true },
      );
      if (existingRun[0]) continue;
      await context.principal.gateway.insert("runs", {
        ...run,
        id: runId,
        experiment_node_id:
          nodeIdMap.get(String(run.experiment_node_id)) ??
          run.experiment_node_id,
        created_by: actorId,
      });
    }

    if (wasFinalized && !existing[0]) {
      await context.principal.gateway.update(
        "node_revisions",
        { state: "finalized" },
        { id },
      );
    }
  }

  const appendOnlyTables = [
    "metric_observations",
    "code_references",
    "data_references",
    "artifacts",
  ] as const;
  for (const table of appendOnlyTables) {
    const rawRows = records[table];
    if (!Array.isArray(rawRows)) continue;
    for (const value of rawRows) {
      const row = asRecord(value);
      const id = String(row.id ?? randomUUID());
      const existing = await context.principal.gateway.select(table, "id", {
        filters: { id },
        single: true,
      });
      if (existing[0]) continue;
      await context.principal.gateway.insert(table, {
        ...row,
        id,
        created_by: actorId,
        ...(table === "artifacts"
          ? { owner_user_id: actorId }
          : {}),
      });
    }
  }

  const semanticRows = Array.isArray(records.semantic_links)
    ? records.semantic_links.map(asRecord)
    : [];
  for (const link of semanticRows) {
    const id = String(link.id ?? randomUUID());
    const existing = await context.principal.gateway.select(
      "semantic_links",
      "id",
      { filters: { id }, single: true },
    );
    if (existing[0]) continue;
    await context.principal.gateway.insert("semantic_links", {
      id,
      space_id: link.space_id,
      source_node_id:
        nodeIdMap.get(String(link.source_node_id)) ??
        link.source_node_id,
      target_node_id:
        nodeIdMap.get(String(link.target_node_id)) ??
        link.target_node_id,
      target_revision_id: link.target_revision_id,
      kind: link.kind,
      rationale: link.rationale ?? null,
      created_by: actorId,
      created_at: link.created_at,
      archived_at: link.archived_at ?? null,
    });
  }

  for (const [sourceId, archivedAt] of nodeArchiveTimes) {
    if (!archivedAt) continue;
    await context.principal.gateway.update(
      "nodes",
      { archived_at: archivedAt },
      { id: nodeIdMap.get(sourceId) ?? sourceId },
    );
  }
  for (const [spaceId, archivedAt] of spaceArchiveTimes) {
    if (!archivedAt) continue;
    await context.principal.gateway.update(
      "spaces",
      { archived_at: archivedAt },
      { id: spaceId },
    );
  }

  const artifactPayloads = Array.isArray(body.artifacts)
    ? body.artifacts.map(asRecord)
    : [];
  let totalArtifactBytes = 0;
  for (const payload of artifactPayloads) {
    const path = parse(z.string().min(1), payload.path);
    const [spaceId] = path.split("/");
    if (
      !allowedSpaceIds.has(spaceId) ||
      path.includes("..") ||
      path.includes("\\") ||
      path.startsWith("/")
    ) {
      throw new ApiError(
        422,
        "unsafe_import_path",
        "The backup contains an unsafe artifact payload path.",
      );
    }
    const encoded = parse(z.string().min(1), payload.content_base64);
    const bytes = Buffer.from(encoded, "base64");
    totalArtifactBytes += bytes.byteLength;
    if (totalArtifactBytes > 25 * 1024 * 1024) {
      throw new ApiError(
        422,
        "artifact_restore_too_large",
        "Restored artifact payloads exceed 25 MiB.",
      );
    }
    if (
      Number(payload.size_bytes) !== bytes.byteLength ||
      parse(sha256Schema, payload.sha256) !==
        checksumBytes(bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ))
    ) {
      throw new ApiError(
        422,
        "artifact_checksum_mismatch",
        "A restored artifact payload failed checksum validation.",
      );
    }
    const artifact = requireRecord(
      await context.principal.gateway.select("artifacts", "*", {
        filters: { storage_path: path },
        single: true,
      }),
      "Artifact record",
    );
    let existingBlob: Blob | null = null;
    try {
      existingBlob =
        await context.principal.gateway.downloadArtifact(path);
    } catch {
      existingBlob = null;
    }
    if (existingBlob) {
      const existingChecksum = checksumBytes(
        await existingBlob.arrayBuffer(),
      );
      if (
        existingBlob.size !== bytes.byteLength ||
        existingChecksum !== String(payload.sha256)
      ) {
        throw new ApiError(
          409,
          "artifact_restore_conflict",
          "An existing restored artifact has different content.",
        );
      }
      continue;
    }
    await context.principal.gateway.uploadArtifact(
      path,
      bytes,
      optionalString(artifact.media_type) ?? "application/octet-stream",
    );
  }

  await audit(context, {
    action: "backup.restored",
    resourceType: "workspace",
    resourceId: context.principal.workspaceId,
    details: {
      archive_sha256: body.archive_sha256 ?? null,
      resources: Object.keys(records),
    },
  });
  return ok(
    {
      restored: true,
      archive_sha256: body.archive_sha256 ?? null,
      record_resources: Object.keys(records).sort(),
    },
    201,
  );
}

async function dispatch(context: DispatchContext): Promise<ApiResult> {
  const { principal, request, segments } = context;
  const [resource, id, action] = segments;
  const method = request.method;

  if (resource === "auth" && id === "status" && method === "GET") {
    return ok({
      authenticated: true,
      actor_id: principal.actorId,
      workspace_id: principal.workspaceId,
      principal: principal.kind,
      scopes: principal.scopes,
    });
  }

  if (resource === "auth" && id === "tokens" && !action) {
    if (principal.kind !== "user") {
      throw new ApiError(
        403,
        "user_session_required",
        "Personal tokens can only be managed from a user session.",
      );
    }
    if (method === "GET") {
      return ok({
        tokens: await principal.gateway.select(
          "api_tokens",
          "id, workspace_id, user_id, name, scopes, expires_at, revoked_at, last_used_at, created_at",
          {
            filters: { user_id: principal.actorId },
            order: { column: "created_at", ascending: false },
          },
        ),
      });
    }
    if (method === "POST") {
      const input = parse(createTokenSchema, context.body);
      assertPrincipalBoundary(principal, input.workspaceId);
      const created = await issuePersonalToken({
        workspaceId: input.workspaceId,
        actorId: principal.actorId,
        name: input.name,
        scopes: input.scopes,
        expiresAt: input.expiresAt ?? null,
      });
      await audit(context, {
        action: "api_token.created",
        resourceType: "api_token",
        resourceId: created.id,
      });
      return ok(created, 201);
    }
  }
  if (
    resource === "auth" &&
    id === "tokens" &&
    action &&
    method === "DELETE"
  ) {
    if (principal.kind !== "user") {
      throw new ApiError(
        403,
        "user_session_required",
        "Personal tokens can only be revoked from a user session.",
      );
    }
    const input = parse(revokeTokenSchema, {
      ...asRecord(context.body),
      workspaceId:
        asRecord(context.body).workspaceId ?? principal.workspaceId,
      tokenId: action,
    });
    assertPrincipalBoundary(principal, input.workspaceId);
    await revokePersonalToken({
      workspaceId: principal.workspaceId,
      actorId: principal.actorId,
      tokenId: action,
    });
    await audit(context, {
      action: "api_token.revoked",
      resourceType: "api_token",
      resourceId: action,
    });
    return ok({ id: action, revoked: true });
  }

  if (resource === "spaces" && !id) {
    if (method === "GET") {
      requireScope(principal, "spaces:read");
      const includeArchived =
        new URL(request.url).searchParams.get("include_archived") ===
        "true";
      return ok({
        spaces: await principal.gateway.select("spaces", "*", {
          filters: includeArchived ? {} : { archived_at: null },
          order: { column: "updated_at", ascending: false },
        }),
      });
    }
    if (method === "POST") return createSpace(context);
  }
  if (resource === "spaces" && id) {
    if (method === "GET") {
      requireScope(principal, "spaces:read");
      return ok({ space: await readSpace(principal.gateway, id) });
    }
    if (method === "PATCH") {
      requireScope(principal, "spaces:write");
      const body = asRecord(context.body);
      assertOptionalWorkspace(principal, body);
      const updates = {
        ...(body.name
          ? { name: parse(z.string().trim().min(1), body.name) }
          : {}),
        ...(body.description !== undefined
          ? { description: optionalString(body.description) }
          : {}),
        ...(body.archived === true
          ? { archived_at: new Date().toISOString() }
          : body.archived === false
            ? { archived_at: null }
            : {}),
      };
      const space = requireRecord(
        await principal.gateway.update("spaces", updates, { id }),
        "Space",
      );
      return ok({ space });
    }
  }

  if (
    (resource === "experiments" || resource === "nodes") &&
    !id &&
    method === "POST"
  ) {
    return createExperiment(context);
  }
  if (
    (resource === "experiments" || resource === "nodes") &&
    id &&
    !action
  ) {
    if (method === "GET") return nodeDetail(context, id);
    if (method === "PATCH") {
      const body = asRecord(context.body);
      if (body.content || body.revision) {
        return updateDraftRevision(context, id);
      }
      const node = await readNode(principal.gateway, id);
      const revision = await readCurrentRevision(principal.gateway, node);
      if (revision.state !== "draft") {
        throw new ApiError(
          409,
          "finalized_record",
          "A finalized revision cannot be edited.",
        );
      }
      const conclusion = mapConclusionState(
        body.conclusionState ?? body.conclusion_state,
      );
      const updated = await principal.gateway.update(
        "node_revisions",
        {
          ...(body.operationalState || body.operational_state
            ? {
                operational_state:
                  body.operationalState ?? body.operational_state,
              }
            : {}),
          ...(body.conclusionState || body.conclusion_state
            ? {
                conclusion_state: conclusion.database,
                metadata: {
                  ...asRecord(revision.metadata),
                  declared_conclusion_state: conclusion.declared,
                },
              }
            : {}),
        },
        { id: String(revision.id) },
      );
      return ok({ revision: updated[0] });
    }
    if (method === "DELETE") {
      requireScope(principal, "nodes:write");
      const node = await readNode(principal.gateway, id);
      if (node.finalized_at) {
        throw new ApiError(
          409,
          "finalized_record",
          "Finalized experiments must be archived.",
        );
      }
      await principal.gateway.delete("nodes", { id });
      return ok({ id, deleted: true });
    }
  }
  if (
    (resource === "experiments" || resource === "nodes") &&
    id &&
    action === "revisions"
  ) {
    if (method === "GET") {
      const node = await readNode(principal.gateway, id);
      return ok({
        revisions: await principal.gateway.select(
          "node_revisions",
          "*",
          {
            filters: {
              node_id: id,
              space_id: stringValue(node, "space_id"),
            },
            order: { column: "revision_number" },
          },
        ),
      });
    }
    if (method === "POST") return updateDraftRevision(context, id);
  }
  if (
    (resource === "experiments" || resource === "nodes") &&
    id &&
    action === "finalize" &&
    method === "POST"
  ) {
    return finalizeExperiment(context, id);
  }
  if (
    (resource === "experiments" || resource === "nodes") &&
    id &&
    action === "archive" &&
    method === "POST"
  ) {
    return archiveExperiment(context, id);
  }

  if (resource === "lineage-links" || resource === "lineage-edges") {
    if (method === "GET") {
      requireScope(principal, "nodes:read");
      const spaceId = new URL(request.url).searchParams.get("space_id");
      return ok({
        lineage_edges: await principal.gateway.select(
          "node_lineage",
          "*",
          { filters: spaceId ? { space_id: spaceId } : {} },
        ),
      });
    }
    if (method === "POST") return createLineage(context);
    if (method === "DELETE") {
      requireScope(principal, "nodes:write");
      const body = asRecord(context.body);
      assertOptionalWorkspace(principal, body);
      const edgeId = requireUuid(
        body.edgeId ?? body.edge_id,
        "edge_id",
      );
      const edge = requireRecord(
        await principal.gateway.select("node_lineage", "*", {
          filters: { id: edgeId },
          single: true,
        }),
        "Lineage edge",
      );
      const child = await readNode(
        principal.gateway,
        stringValue(edge, "child_node_id"),
      );
      if (child.finalized_at) {
        throw new ApiError(
          409,
          "finalized_record",
          "Finalized experiment lineage cannot be changed.",
        );
      }
      await principal.gateway.delete("node_lineage", { id: edgeId });
      return ok({ id: edgeId, deleted: true });
    }
  }

  if (resource === "semantic-links") {
    if (method === "GET") {
      requireScope(principal, "nodes:read");
      const spaceId = new URL(request.url).searchParams.get("space_id");
      return ok({
        semantic_links: await principal.gateway.select(
          "semantic_links",
          "*",
          { filters: spaceId ? { space_id: spaceId } : {} },
        ),
      });
    }
    if (method === "POST") return createSemantic(context);
    if (method === "DELETE") {
      requireScope(principal, "nodes:write");
      const body = asRecord(context.body);
      const linkId = requireUuid(
        body.linkId ?? body.link_id,
        "link_id",
      );
      await principal.gateway.update(
        "semantic_links",
        { archived_at: new Date().toISOString() },
        { id: linkId },
      );
      return ok({ id: linkId, archived: true });
    }
  }

  if (resource === "runs" && !id) {
    if (method === "POST") return createRun(context);
    if (method === "GET") {
      requireScope(principal, "nodes:read");
      const nodeId = new URL(request.url).searchParams.get("node_id");
      return ok({
        runs: await principal.gateway.select("runs", "*", {
          filters: nodeId ? { experiment_node_id: nodeId } : {},
          order: { column: "created_at", ascending: false },
        }),
      });
    }
  }
  if (resource === "runs" && id === "start" && method === "POST") {
    return createRun(context);
  }
  if (resource === "runs" && id && action === "complete" && method === "POST") {
    return completeRun(context, id);
  }
  if (resource === "runs" && id && action === "fail" && method === "POST") {
    return failRun(context, id);
  }

  if (
    resource === "artifacts" &&
    (id === "prepare" || id === "upload") &&
    method === "POST"
  ) {
    return prepareArtifact(context);
  }
  if (
    resource === "artifacts" &&
    id &&
    action === "finalize" &&
    method === "POST"
  ) {
    return finalizeArtifact(context, id);
  }

  if (resource === "search" && method === "GET") {
    return searchNodes(context);
  }
  if (
    (resource === "export" ||
      (resource === "backups" && id === "export")) &&
    method === "GET"
  ) {
    return exportRecords(context);
  }
  if (
    ((resource === "imports" && id === "restore") ||
      (resource === "backups" && id === "restore")) &&
    method === "POST"
  ) {
    return restoreRecords(context);
  }

  throw new ApiError(
    404,
    "endpoint_not_found",
    "The requested API endpoint does not exist.",
  );
}

async function parseRequestBody(request: Request): Promise<unknown> {
  if (!MUTATION_METHODS.has(request.method)) return undefined;
  const text = await request.text();
  if (!text) return {};
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ApiError(
      415,
      "unsupported_media_type",
      "Mutation request bodies must use application/json.",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(
      400,
      "invalid_json",
      "The request body is not valid JSON.",
    );
  }
}

function errorResponse(error: unknown, requestId: string): Response {
  let status = 500;
  let code = "internal_error";
  let message = "The request could not be completed.";
  let details: unknown;
  if (
    !(error instanceof ApiError) &&
    !(error instanceof AuthenticationError) &&
    !(error instanceof TokenAuthenticationError)
  ) {
    console.error(`[api] unexpected error ${requestId}:`, error);
  }
  if (error instanceof ApiError || error instanceof AuthenticationError) {
    status = error.status;
    code = error.code;
    message = error.message;
    details = error instanceof ApiError ? error.details : undefined;
  } else if (error instanceof TokenAuthenticationError) {
    status = error.code === "token_configuration_error" ? 503 : 401;
    code = error.code;
    message = error.message;
  } else if (
    error instanceof Error &&
    error.message.includes("is not configured")
  ) {
    status = 503;
    code = "configuration_error";
    message = error.message;
  } else if (error instanceof Error) {
    if (
      error.message.includes("duplicate key") ||
      error.message.includes("unique constraint") ||
      error.message.includes("would create a cycle")
    ) {
      status = 409;
      code = "conflict";
      message = error.message.includes("would create a cycle")
        ? "The lineage edge would create a cycle."
        : "The request conflicts with an existing record.";
    }
  }
  return Response.json(
    {
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
        requestId,
      },
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
      },
    },
  );
}

export async function handleApiRequest(
  request: Request,
  segments: string[],
): Promise<Response> {
  const requestId = randomUUID();
  try {
    const [principal, body] = await Promise.all([
      authenticateRequest(request),
      parseRequestBody(request),
    ]);
    if (principal.kind === "user" && MUTATION_METHODS.has(request.method)) {
      const origin = request.headers.get("origin");
      if (!origin || origin !== new URL(request.url).origin) {
        throw new AuthenticationError(
          "invalid_origin",
          "Browser mutations must originate from this application.",
          403,
        );
      }
    }
    const context = { request, requestId, principal, segments, body };
    const result = await executeIdempotently(context, () =>
      dispatch(context),
    );
    const compatibilityFields =
      result.data &&
      typeof result.data === "object" &&
      !Array.isArray(result.data)
        ? (result.data as Record<string, unknown>)
        : {};
    return Response.json(
      { ...compatibilityFields, data: result.data },
      {
        status: result.status,
        headers: {
          "Cache-Control": "no-store",
          "X-Request-Id": requestId,
          ...result.headers,
        },
      },
    );
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
