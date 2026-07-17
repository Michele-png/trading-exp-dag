import { z } from "zod";

export const identifierSchema = z.uuid();
export const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/i, "Expected a SHA-256 hex digest")
  .transform((value) => value.toLowerCase());

export const nodeKindSchema = z.enum([
  "objective",
  "experiment",
  "synthesis",
]);
export const operationalStateSchema = z.enum([
  "draft",
  "open",
  "planned",
  "ready",
  "running",
  "completed",
  "failed",
  "cancelled",
  "archived",
]);
export const conclusionStateSchema = z.enum([
  "pending",
  "supported",
  "refuted",
  "mixed",
  "inconclusive",
]);
export const preregistrationStateSchema = z.enum([
  "preregistered",
  "retrospective",
  "unspecified",
]);
export const semanticLinkTypeSchema = z.enum([
  "supports",
  "contradicts",
  "replicates",
]);

const nullableText = z.string().trim().max(20_000).nullable().optional();
const workspaceScopedSchema = z.object({
  workspaceId: identifierSchema,
});

export const revisionContentSchema = z.object({
  title: z.string().trim().min(1).max(240),
  hypothesis: nullableText,
  method: nullableText,
  successCriteria: nullableText,
  preregistrationState: preregistrationStateSchema.default("unspecified"),
  conclusion: nullableText,
  notes: nullableText,
});

export const createSpaceSchema = workspaceScopedSchema.extend({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  objective: revisionContentSchema,
});

export const updateSpaceSchema = workspaceScopedSchema.extend({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2_000).nullable().optional(),
  archived: z.boolean().optional(),
});

export const createNodeSchema = workspaceScopedSchema.extend({
  spaceId: identifierSchema,
  kind: nodeKindSchema.exclude(["objective"]),
  revision: revisionContentSchema,
  lineageParentIds: z.array(identifierSchema).max(20).default([]),
});

export const updateNodeSchema = workspaceScopedSchema.extend({
  operationalState: operationalStateSchema.optional(),
  conclusionState: conclusionStateSchema.optional(),
});

export const createRevisionSchema = workspaceScopedSchema.extend({
  content: revisionContentSchema,
  editorial: z.boolean().default(false),
  correctionReason: z.string().trim().min(1).max(1_000).optional(),
});

export const finalizeNodeSchema = workspaceScopedSchema.extend({
  revisionId: identifierSchema.optional(),
  conclusionState: conclusionStateSchema.optional(),
});

export const archiveNodeSchema = workspaceScopedSchema.extend({
  reason: z.string().trim().min(1).max(1_000),
});

export const createLineageEdgeSchema = workspaceScopedSchema.extend({
  spaceId: identifierSchema,
  parentNodeId: identifierSchema,
  childNodeId: identifierSchema,
});

export const deleteLineageEdgeSchema = workspaceScopedSchema.extend({
  edgeId: identifierSchema,
});

export const createSemanticLinkSchema = workspaceScopedSchema.extend({
  spaceId: identifierSchema,
  sourceNodeId: identifierSchema,
  targetNodeId: identifierSchema,
  linkType: semanticLinkTypeSchema,
  rationale: z.string().trim().max(2_000).nullable().optional(),
});

export const deleteSemanticLinkSchema = workspaceScopedSchema.extend({
  linkId: identifierSchema,
});

export const startRunSchema = workspaceScopedSchema.extend({
  nodeId: identifierSchema,
  revisionId: identifierSchema,
  command: z.string().trim().max(8_000).nullable().optional(),
  seed: z.number().int().nullable().optional(),
  parameters: z.record(z.string(), z.unknown()).default({}),
  environment: z.record(z.string(), z.unknown()).default({}),
  startedAt: z.iso.datetime().optional(),
});

export const completeRunSchema = workspaceScopedSchema.extend({
  completedAt: z.iso.datetime().optional(),
  exitCode: z.number().int().min(0).max(255).default(0),
  resultManifest: z.record(z.string(), z.unknown()).default({}),
  metrics: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        value: z.number().finite(),
        unit: z.string().trim().max(40).nullable().optional(),
        step: z.number().int().nonnegative().nullable().optional(),
      }),
    )
    .max(1_000)
    .default([]),
});

export const failRunSchema = workspaceScopedSchema.extend({
  completedAt: z.iso.datetime().optional(),
  exitCode: z.number().int().min(1).max(255).nullable().optional(),
  errorCode: z.string().trim().max(120).nullable().optional(),
  errorMessage: z.string().trim().max(4_000),
});

export const artifactPrepareSchema = workspaceScopedSchema.extend({
  nodeId: identifierSchema,
  runId: identifierSchema.nullable().optional(),
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(180)
    .refine(
      (value) =>
        !value.includes("/") &&
        !value.includes("\\") &&
        value !== "." &&
        value !== "..",
      "File name must not contain path segments",
    ),
  mimeType: z.enum([
    "application/json",
    "application/pdf",
    "application/zip",
    "text/csv",
    "text/markdown",
    "text/plain",
    "image/png",
    "image/jpeg",
    "image/webp",
  ]),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
  sha256: sha256Schema,
});

export const artifactFinalizeSchema = workspaceScopedSchema.extend({
  artifactId: identifierSchema,
  sha256: sha256Schema,
});

export const createTokenSchema = workspaceScopedSchema.extend({
  name: z.string().trim().min(1).max(80),
  scopes: z
    .array(
      z.enum([
        "spaces:read",
        "spaces:write",
        "nodes:read",
        "nodes:write",
        "runs:write",
        "artifacts:write",
        "export:read",
        "import:write",
      ]),
    )
    .min(1),
  expiresAt: z.iso.datetime().nullable().optional(),
});

export const revokeTokenSchema = workspaceScopedSchema.extend({
  tokenId: identifierSchema,
});

export const searchQuerySchema = z.object({
  workspaceId: identifierSchema,
  q: z.string().trim().min(1).max(200),
  spaceId: identifierSchema.optional(),
  operationalState: operationalStateSchema.optional(),
  conclusionState: conclusionStateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const exportQuerySchema = z.object({
  workspaceId: identifierSchema,
  spaceId: identifierSchema.optional(),
  format: z.enum(["json", "markdown"]).default("json"),
});

export const backupDataSchema = z.object({
  workspaces: z.array(z.record(z.string(), z.unknown())).default([]),
  workspace_members: z.array(z.record(z.string(), z.unknown())).default([]),
  spaces: z.array(z.record(z.string(), z.unknown())).default([]),
  nodes: z.array(z.record(z.string(), z.unknown())).default([]),
  node_revisions: z.array(z.record(z.string(), z.unknown())).default([]),
  lineage_edges: z.array(z.record(z.string(), z.unknown())).default([]),
  semantic_links: z.array(z.record(z.string(), z.unknown())).default([]),
  runs: z.array(z.record(z.string(), z.unknown())).default([]),
  metric_definitions: z.array(z.record(z.string(), z.unknown())).default([]),
  metric_observations: z.array(z.record(z.string(), z.unknown())).default([]),
  code_references: z.array(z.record(z.string(), z.unknown())).default([]),
  data_references: z.array(z.record(z.string(), z.unknown())).default([]),
  artifacts: z.array(z.record(z.string(), z.unknown())).default([]),
});

export const backupBundleSchema = z.object({
  schemaVersion: z.literal("1.0"),
  exportedAt: z.iso.datetime(),
  workspaceId: identifierSchema,
  checksum: sha256Schema,
  data: backupDataSchema,
});

export const restoreBundleSchema = workspaceScopedSchema.extend({
  mode: z.enum(["validate", "restore"]).default("validate"),
  bundle: backupBundleSchema,
});

export type RevisionContent = z.infer<typeof revisionContentSchema>;
export type NodeKind = z.infer<typeof nodeKindSchema>;
export type OperationalState = z.infer<typeof operationalStateSchema>;
export type ConclusionState = z.infer<typeof conclusionStateSchema>;
export type PreregistrationState = z.infer<
  typeof preregistrationStateSchema
>;
export type SemanticLinkType = z.infer<typeof semanticLinkTypeSchema>;
