import { describe, expect, it } from "vitest";

import {
  focusGraph,
  layoutGraph,
  validateLifecycleAction,
  type GraphEdge,
  type GraphNode,
} from "@/lib/domain";

const nodes: GraphNode[] = [
  {
    id: "root",
    title: "Objective",
    kind: "objective",
    operationalState: "open",
    conclusionState: "pending",
  },
  {
    id: "middle",
    title: "Experiment",
    kind: "experiment",
    operationalState: "open",
    conclusionState: "pending",
  },
  {
    id: "leaf",
    title: "Follow-up",
    kind: "experiment",
    operationalState: "draft",
    conclusionState: "pending",
  },
];
const edges: GraphEdge[] = [
  {
    id: "root-middle",
    source: "root",
    target: "middle",
    kind: "lineage",
  },
  {
    id: "middle-leaf",
    source: "middle",
    target: "leaf",
    kind: "lineage",
  },
  {
    id: "semantic",
    source: "root",
    target: "leaf",
    kind: "semantic",
    semanticType: "contradicts",
  },
];

describe("graph helpers", () => {
  it("focuses on ancestors while retaining visible semantic links", () => {
    const focused = focusGraph(nodes, edges, "leaf", "ancestors");

    expect(focused.nodes.map((node) => node.id)).toEqual([
      "root",
      "middle",
      "leaf",
    ]);
    expect(focused.edges).toHaveLength(3);
  });

  it("focuses on descendants only", () => {
    const focused = focusGraph(nodes, edges, "middle", "descendants");

    expect(focused.nodes.map((node) => node.id)).toEqual([
      "middle",
      "leaf",
    ]);
    expect(focused.edges.map((edge) => edge.id)).toEqual(["middle-leaf"]);
  });

  it("lays lineage out from left to right", async () => {
    const positioned = await layoutGraph(nodes, edges);
    const byId = new Map(positioned.map((node) => [node.id, node]));

    expect(byId.get("root")?.position.x).toBeLessThan(
      byId.get("middle")?.position.x ?? 0,
    );
    expect(byId.get("middle")?.position.x).toBeLessThan(
      byId.get("leaf")?.position.x ?? 0,
    );
  });
});

describe("node lifecycle", () => {
  it("requires scientific fields before finalization", () => {
    const result = validateLifecycleAction(
      {
        kind: "experiment",
        operationalState: "draft",
        finalizedRevisionId: null,
      },
      {
        type: "finalize",
        revision: {
          title: "Incomplete",
          hypothesis: "A hypothesis",
          method: null,
          successCriteria: null,
          preregistrationState: "unspecified",
          conclusion: null,
          notes: null,
        },
      },
    );

    expect(result.valid).toBe(false);
    expect(result.message).toContain("method");
  });

  it("blocks scientific corrections on finalized records", () => {
    const result = validateLifecycleAction(
      {
        kind: "experiment",
        operationalState: "open",
        finalizedRevisionId: "revision",
      },
      {
        type: "append_revision",
        editorial: true,
        correctionReason: "Clarify wording",
        changedFields: ["method"],
      },
    );

    expect(result.valid).toBe(false);
    expect(result.message).toContain("child experiment");
  });
});
