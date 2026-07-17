import ELK from "elkjs/lib/elk.bundled.js";

import type {
  ConclusionState,
  OperationalState,
  RevisionContent,
} from "@/lib/contracts";

export const MAX_INTERACTIVE_GRAPH_NODES = 500;

export interface GraphNode {
  id: string;
  title: string;
  kind: "objective" | "experiment" | "synthesis";
  operationalState: OperationalState;
  conclusionState: ConclusionState;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: "lineage" | "semantic";
  semanticType?: "supports" | "contradicts" | "replicates";
}

export type FocusMode = "overview" | "ancestors" | "descendants" | "both";

export interface FocusedGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface PositionedGraphNode extends GraphNode {
  position: { x: number; y: number };
}

export interface NodeLifecycleSnapshot {
  operationalState: OperationalState;
  finalizedRevisionId: string | null;
  kind: GraphNode["kind"];
}

export type LifecycleAction =
  | { type: "edit_draft" }
  | {
      type: "append_revision";
      editorial: boolean;
      correctionReason?: string;
      changedFields: (keyof RevisionContent)[];
    }
  | { type: "change_lineage" }
  | { type: "finalize"; revision: RevisionContent }
  | { type: "archive" }
  | { type: "delete" };

export interface LifecycleResult {
  valid: boolean;
  message?: string;
}

export function validateLifecycleAction(
  node: NodeLifecycleSnapshot,
  action: LifecycleAction,
): LifecycleResult {
  const finalized = node.finalizedRevisionId !== null;

  if (action.type === "edit_draft" || action.type === "change_lineage") {
    return finalized || node.operationalState !== "draft"
      ? {
          valid: false,
          message: "Only draft nodes can change scientific content or lineage.",
        }
      : { valid: true };
  }

  if (action.type === "delete") {
    return finalized
      ? {
          valid: false,
          message: "Finalized nodes must be archived or tombstoned.",
        }
      : { valid: true };
  }

  if (action.type === "archive") {
    return finalized
      ? { valid: true }
      : {
          valid: false,
          message: "Delete an abandoned draft instead of archiving it.",
        };
  }

  if (action.type === "finalize") {
    if (finalized) {
      return { valid: false, message: "The node is already finalized." };
    }
    if (node.kind !== "objective") {
      const missing = [
        ["hypothesis", action.revision.hypothesis],
        ["method", action.revision.method],
        ["success criteria", action.revision.successCriteria],
      ]
        .filter(([, value]) => !value?.trim())
        .map(([label]) => label);

      if (missing.length > 0) {
        return {
          valid: false,
          message: `Finalization requires ${missing.join(", ")}.`,
        };
      }
    }
    return { valid: true };
  }

  if (!finalized) {
    return { valid: true };
  }

  if (!action.editorial) {
    return {
      valid: false,
      message:
        "Scientific changes after finalization must be captured as a child experiment.",
    };
  }

  const editorialFields = new Set<keyof RevisionContent>(["title", "notes"]);
  const changesScientificContent = action.changedFields.some(
    (field) => !editorialFields.has(field),
  );

  if (changesScientificContent) {
    return {
      valid: false,
      message:
        "A correction revision may only change the title or notes; create a child experiment for scientific changes.",
    };
  }

  if (!action.correctionReason?.trim()) {
    return {
      valid: false,
      message: "Editorial corrections require a correction reason.",
    };
  }

  return { valid: true };
}

export function focusGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  selectedNodeId: string | null,
  mode: FocusMode,
): FocusedGraph {
  if (
    mode === "overview" ||
    !selectedNodeId ||
    !nodes.some((node) => node.id === selectedNodeId)
  ) {
    return { nodes, edges };
  }

  const lineage = edges.filter((edge) => edge.kind === "lineage");
  const parentsByChild = adjacency(lineage, "target", "source");
  const childrenByParent = adjacency(lineage, "source", "target");
  const visibleIds = new Set([selectedNodeId]);

  if (mode === "ancestors" || mode === "both") {
    collectConnected(selectedNodeId, parentsByChild, visibleIds);
  }
  if (mode === "descendants" || mode === "both") {
    collectConnected(selectedNodeId, childrenByParent, visibleIds);
  }

  return {
    nodes: nodes.filter((node) => visibleIds.has(node.id)),
    edges: edges.filter(
      (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
    ),
  };
}

function adjacency(
  edges: GraphEdge[],
  from: "source" | "target",
  to: "source" | "target",
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const edge of edges) {
    const connected = result.get(edge[from]) ?? [];
    connected.push(edge[to]);
    result.set(edge[from], connected);
  }
  return result;
}

function collectConnected(
  initialId: string,
  connections: Map<string, string[]>,
  collected: Set<string>,
) {
  const queue = [initialId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const connectedId of connections.get(current) ?? []) {
      if (!collected.has(connectedId)) {
        collected.add(connectedId);
        queue.push(connectedId);
      }
    }
  }
}

export async function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Promise<PositionedGraphNode[]> {
  if (nodes.length > MAX_INTERACTIVE_GRAPH_NODES) {
    throw new Error(
      `Interactive layout is limited to ${MAX_INTERACTIVE_GRAPH_NODES} nodes.`,
    );
  }

  const elk = new ELK();
  const graph = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "90",
      "elk.spacing.nodeNode": "44",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
    },
    children: nodes.map((node) => ({
      id: node.id,
      width: 250,
      height: 108,
    })),
    edges: edges
      .filter((edge) => edge.kind === "lineage")
      .map((edge) => ({
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target],
      })),
  });

  const positions = new Map(
    (graph.children ?? []).map((node) => [
      node.id,
      { x: node.x ?? 0, y: node.y ?? 0 },
    ]),
  );

  return nodes.map((node) => ({
    ...node,
    position: positions.get(node.id) ?? { x: 0, y: 0 },
  }));
}
