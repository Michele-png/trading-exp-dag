import type {
  ConclusionState,
  NodeKind,
  OperationalState,
  PreregistrationState,
  SemanticLinkType,
} from "@/lib/contracts";

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
  spaces: SpaceSummary[];
}

export interface SpaceSummary {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  description: string | null;
  nodeCount: number;
  openCount: number;
  completedCount: number;
  updatedAt: string | null;
}

export interface NodeRevisionView {
  id: string;
  nodeId: string;
  revisionNumber: number;
  title: string;
  hypothesis: string | null;
  method: string | null;
  successCriteria: string | null;
  preregistrationState: PreregistrationState;
  conclusion: string | null;
  notes: string | null;
  editorial: boolean;
  correctionReason: string | null;
  createdAt: string | null;
}

export interface NodeView {
  id: string;
  workspaceId: string;
  spaceId: string;
  kind: NodeKind;
  operationalState: OperationalState;
  conclusionState: ConclusionState;
  currentRevisionId: string | null;
  finalizedRevisionId: string | null;
  createdAt: string | null;
  revision: NodeRevisionView;
}

export interface LineageEdgeView {
  id: string;
  parentNodeId: string;
  childNodeId: string;
}

export interface SemanticLinkView {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  linkType: SemanticLinkType;
  rationale: string | null;
}

export interface RunView {
  id: string;
  nodeId: string;
  status: "queued" | "running" | "completed" | "failed";
  seed: number | null;
  startedAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
  errorMessage: string | null;
}

export interface MetricView {
  id: string;
  runId: string;
  name: string;
  value: number;
  unit: string | null;
}

export interface EvidenceView {
  id: string;
  nodeId: string;
  type: "artifact" | "code" | "data";
  label: string;
  detail: string;
  checksum: string | null;
}

export interface SpaceView {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  description: string | null;
  objectiveNodeId: string;
}
