"use client";

import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  ArrowLeft,
  Filter,
  GitBranch,
  LayoutList,
  Network,
  Plus,
  Search,
  Waypoints,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { NodeInspector } from "@/components/node-inspector";
import { EmptyState } from "@/components/ui-states";
import type {
  ConclusionState,
  OperationalState,
} from "@/lib/contracts";
import {
  focusGraph,
  layoutGraph,
  MAX_INTERACTIVE_GRAPH_NODES,
  type FocusMode,
  type GraphEdge,
  type GraphNode,
} from "@/lib/domain";
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

interface GraphExplorerProps {
  space: SpaceView;
  nodes: NodeView[];
  revisions: NodeRevisionView[];
  lineage: LineageEdgeView[];
  semanticLinks: SemanticLinkView[];
  runs: RunView[];
  metrics: MetricView[];
  evidence: EvidenceView[];
}

type GraphNodeData = {
  label: string;
  kind: GraphNode["kind"];
  operationalState: OperationalState;
  conclusionState: ConclusionState;
  selected: boolean;
};

export function GraphExplorer({
  space,
  nodes,
  revisions,
  lineage,
  semanticLinks,
  runs,
  metrics,
  evidence,
}: GraphExplorerProps) {
  const [query, setQuery] = useState("");
  const [operationalState, setOperationalState] = useState("all");
  const [conclusionState, setConclusionState] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState<FocusMode>("overview");
  const [viewMode, setViewMode] = useState<"graph" | "list">(
    nodes.length > MAX_INTERACTIVE_GRAPH_NODES ? "list" : "graph",
  );
  const [creating, setCreating] = useState(false);

  const matchingNodes = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return nodes.filter(
      (node) =>
        (operationalState === "all" ||
          node.operationalState === operationalState) &&
        (conclusionState === "all" ||
          node.conclusionState === conclusionState) &&
        (!needle ||
          [
            node.revision.title,
            node.revision.hypothesis,
            node.revision.method,
            node.revision.conclusion,
          ]
            .filter(Boolean)
            .some((value) => value?.toLocaleLowerCase().includes(needle))),
    );
  }, [conclusionState, nodes, operationalState, query]);

  const graphNodes = useMemo<GraphNode[]>(
    () =>
      matchingNodes.map((node) => ({
        id: node.id,
        title: node.revision.title,
        kind: node.kind,
        operationalState: node.operationalState,
        conclusionState: node.conclusionState,
      })),
    [matchingNodes],
  );
  const visibleIds = useMemo(
    () => new Set(graphNodes.map((node) => node.id)),
    [graphNodes],
  );
  const graphEdges = useMemo<GraphEdge[]>(
    () => [
      ...lineage
        .filter(
          (edge) =>
            visibleIds.has(edge.parentNodeId) &&
            visibleIds.has(edge.childNodeId),
        )
        .map((edge) => ({
          id: edge.id,
          source: edge.parentNodeId,
          target: edge.childNodeId,
          kind: "lineage" as const,
        })),
      ...semanticLinks
        .filter(
          (link) =>
            visibleIds.has(link.sourceNodeId) &&
            visibleIds.has(link.targetNodeId),
        )
        .map((link) => ({
          id: link.id,
          source: link.sourceNodeId,
          target: link.targetNodeId,
          kind: "semantic" as const,
          semanticType: link.linkType,
        })),
    ],
    [lineage, semanticLinks, visibleIds],
  );
  const focused = useMemo(
    () => focusGraph(graphNodes, graphEdges, selectedId, focusMode),
    [focusMode, graphEdges, graphNodes, selectedId],
  );
  const [flowNodes, setFlowNodes] = useState<Node<GraphNodeData>[]>([]);
  const selectedNode =
    nodes.find((node) => node.id === selectedId) ?? null;

  useEffect(() => {
    let cancelled = false;
    if (
      viewMode !== "graph" ||
      focused.nodes.length > MAX_INTERACTIVE_GRAPH_NODES
    ) {
      return;
    }
    void layoutGraph(focused.nodes, focused.edges).then((positioned) => {
      if (cancelled) return;
      setFlowNodes(
        positioned.map((node) => ({
          id: node.id,
          type: "experiment",
          position: node.position,
          data: {
            label: node.title,
            kind: node.kind,
            operationalState: node.operationalState,
            conclusionState: node.conclusionState,
            selected: node.id === selectedId,
          },
        })),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [focused, selectedId, viewMode]);

  const flowEdges = useMemo<Edge[]>(
    () =>
      focused.edges.map((edge) => {
        const semanticColor =
          edge.semanticType === "contradicts"
            ? "#fb7185"
            : edge.semanticType === "replicates"
              ? "#c4b5fd"
              : "#5eead4";
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label:
            edge.kind === "semantic"
              ? edge.semanticType
              : undefined,
          animated: false,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: edge.kind === "lineage" ? "#64748b" : semanticColor,
          },
          style:
            edge.kind === "lineage"
              ? { stroke: "#64748b", strokeWidth: 1.8 }
              : {
                  stroke: semanticColor,
                  strokeWidth: 1.5,
                  strokeDasharray: "6 5",
                },
          labelStyle: {
            fill: semanticColor,
            fontSize: 10,
            fontWeight: 600,
          },
          labelBgStyle: { fill: "#0d131f", fillOpacity: 0.92 },
        };
      }),
    [focused.edges],
  );

  const openCount = nodes.filter(
    (node) =>
      node.operationalState === "open" ||
      node.operationalState === "draft" ||
      node.operationalState === "planned" ||
      node.operationalState === "ready" ||
      node.operationalState === "running",
  ).length;
  const unresolvedCount = nodes.filter(
    (node) => node.conclusionState === "pending",
  ).length;
  const preregisteredCount = nodes.filter(
    (node) =>
      node.revision.preregistrationState === "preregistered",
  ).length;
  const interactive = nodes.length <= MAX_INTERACTIVE_GRAPH_NODES;

  async function exportSpace() {
    const response = await fetch(
      `/api/v1/export?space_id=${space.id}`,
      {
        headers: { "X-Workspace-Id": space.workspaceId },
      },
    );
    const payload = (await response.json()) as {
      data?: { bundle?: unknown };
      error?: { message?: string };
    };
    if (!response.ok) {
      window.alert(payload.error?.message ?? "Export failed.");
      return;
    }
    const blob = new Blob(
      [JSON.stringify(payload.data?.bundle ?? {}, null, 2)],
      { type: "application/json" },
    );
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${space.slug || "qdag"}-export.json`;
    anchor.click();
    URL.revokeObjectURL(href);
  }

  return (
    <div>
      <div className="mb-7 flex flex-col justify-between gap-5 xl:flex-row xl:items-end">
        <div>
          <Link
            className="mb-5 inline-flex items-center gap-2 text-xs font-medium text-slate-500 transition hover:text-slate-200"
            href="/"
          >
            <ArrowLeft aria-hidden className="size-3.5" />
            All spaces
          </Link>
          <p className="eyebrow">Experiment space</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.035em] text-white sm:text-4xl">
            {space.name}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
            {space.description ?? "No space description provided."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="button-secondary"
            onClick={() => {
              setCreating(true);
              setSelectedId(null);
            }}
            type="button"
          >
            <Plus aria-hidden className="size-4" />
            Draft node
          </button>
          <button
            className="button-ghost"
            onClick={exportSpace}
            type="button"
          >
            Export
          </button>
        </div>
      </div>

      <section
        aria-label="Open frontier summary"
        className="mb-5 grid gap-px overflow-hidden rounded-2xl border border-white/7 bg-white/7 sm:grid-cols-3"
      >
        <FrontierMetric label="Open frontier" value={openCount} />
        <FrontierMetric label="Awaiting conclusion" value={unresolvedCount} />
        <FrontierMetric label="Preregistered" value={preregisteredCount} />
      </section>

      <section className="panel overflow-hidden">
        <div className="border-b border-white/6 p-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">Search nodes</span>
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500"
              />
              <input
                className="field h-10 pl-9"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search hypothesis, method, or conclusion"
                type="search"
                value={query}
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Filter aria-hidden className="mx-1 size-4 text-slate-600" />
              <select
                aria-label="Operational state"
                className="field h-10 min-w-36"
                onChange={(event) =>
                  setOperationalState(event.target.value)
                }
                value={operationalState}
              >
                <option value="all">All operations</option>
                <option value="draft">Draft</option>
                <option value="planned">Planned</option>
                <option value="ready">Ready</option>
                <option value="running">Running</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
                <option value="cancelled">Cancelled</option>
                <option value="archived">Archived</option>
              </select>
              <select
                aria-label="Conclusion state"
                className="field h-10 min-w-36"
                onChange={(event) =>
                  setConclusionState(event.target.value)
                }
                value={conclusionState}
              >
                <option value="all">All conclusions</option>
                <option value="pending">Pending</option>
                <option value="supported">Supported</option>
                <option value="refuted">Refuted</option>
                <option value="mixed">Mixed</option>
                <option value="inconclusive">Inconclusive</option>
              </select>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1 rounded-lg border border-white/7 bg-black/15 p-1">
              <ViewButton
                active={viewMode === "graph"}
                disabled={!interactive}
                icon={Network}
                label="Graph"
                onClick={() => setViewMode("graph")}
              />
              <ViewButton
                active={viewMode === "list"}
                icon={LayoutList}
                label="List"
                onClick={() => setViewMode("list")}
              />
            </div>
            {viewMode === "graph" && interactive ? (
              <div className="flex flex-wrap items-center gap-1">
                {(
                  [
                    ["overview", "Overview"],
                    ["ancestors", "Ancestors"],
                    ["descendants", "Descendants"],
                    ["both", "Both"],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    className={cn(
                      "rounded-lg px-2.5 py-1.5 text-xs transition",
                      focusMode === mode
                        ? "bg-white/8 text-slate-100"
                        : "text-slate-500 hover:text-slate-200",
                    )}
                    disabled={mode !== "overview" && !selectedId}
                    key={mode}
                    onClick={() => setFocusMode(mode)}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {matchingNodes.length === 0 ? (
          <div className="p-5">
            <EmptyState
              description="Adjust the keyword or state filters to reveal nodes."
              title="No matching nodes"
            />
          </div>
        ) : viewMode === "graph" && interactive ? (
          <>
            <div
              aria-label="Topological experiment graph"
              className="h-[660px] bg-[#090e18]"
            >
              <ReactFlow
                colorMode="dark"
                edges={flowEdges}
                fitView
                fitViewOptions={{ padding: 0.2 }}
                minZoom={0.2}
                nodeTypes={{ experiment: ExperimentNode }}
                nodes={flowNodes}
                nodesConnectable={false}
                nodesDraggable={false}
                onNodeClick={(_, node) => {
                  setSelectedId(node.id);
                  setCreating(false);
                }}
                proOptions={{ hideAttribution: true }}
              >
                <Background color="#1e293b" gap={24} size={1} />
                <Controls showInteractive={false} />
                <MiniMap
                  maskColor="rgba(8,12,20,.74)"
                  nodeColor="#334155"
                  pannable
                  zoomable
                />
              </ReactFlow>
            </div>
            <GraphLegend />
          </>
        ) : (
          <AccessibleNodeList
            nodes={matchingNodes}
            onSelect={(id) => {
              setSelectedId(id);
              setCreating(false);
            }}
            selectedId={selectedId}
          />
        )}
      </section>

      {selectedNode || creating ? (
        <NodeInspector
          evidence={evidence.filter(
            (item) => item.nodeId === selectedNode?.id,
          )}
          key={selectedNode?.id ?? "new-node"}
          lineage={lineage}
          metrics={metrics}
          node={selectedNode}
          nodes={nodes}
          onClose={() => {
            setSelectedId(null);
            setCreating(false);
            setFocusMode("overview");
          }}
          revisions={revisions.filter(
            (revision) => revision.nodeId === selectedNode?.id,
          )}
          runs={runs.filter((run) => run.nodeId === selectedNode?.id)}
          semanticLinks={semanticLinks}
          space={space}
        />
      ) : null}
    </div>
  );
}

function ExperimentNode({ data }: NodeProps<Node<GraphNodeData>>) {
  return (
    <div
      className={cn(
        "w-[250px] rounded-xl border bg-[#101724] px-4 py-3 shadow-xl shadow-black/20 transition",
        data.selected
          ? "border-teal-300/60 ring-2 ring-teal-300/10"
          : "border-white/10",
      )}
    >
      <Handle
        className="!size-2 !border-0 !bg-slate-500"
        position={Position.Left}
        type="target"
      />
      <div className="flex items-center justify-between gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.13em] text-slate-500">
          {data.kind}
        </span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-medium",
            data.operationalState === "draft"
              ? "bg-amber-300/10 text-amber-200"
              : data.operationalState === "completed"
                ? "bg-violet-300/10 text-violet-200"
                : "bg-teal-300/10 text-teal-200",
          )}
        >
          {data.operationalState}
        </span>
      </div>
      <p className="mt-2 line-clamp-2 text-left text-sm font-semibold leading-5 text-slate-100">
        {data.label}
      </p>
      <p className="mt-2 text-left text-[11px] capitalize text-slate-500">
        {data.conclusionState}
      </p>
      <Handle
        className="!size-2 !border-0 !bg-slate-500"
        position={Position.Right}
        type="source"
      />
    </div>
  );
}

function AccessibleNodeList({
  nodes,
  selectedId,
  onSelect,
}: {
  nodes: NodeView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="divide-y divide-white/6" role="list">
      {nodes.map((node) => (
        <button
          aria-current={selectedId === node.id}
          className="grid w-full gap-2 px-5 py-4 text-left transition hover:bg-white/[0.035] sm:grid-cols-[1fr_auto_auto] sm:items-center"
          key={node.id}
          onClick={() => onSelect(node.id)}
          role="listitem"
          type="button"
        >
          <span>
            <span className="block text-sm font-semibold text-slate-100">
              {node.revision.title}
            </span>
            <span className="mt-1 block text-xs capitalize text-slate-500">
              {node.kind}
            </span>
          </span>
          <span className="status-pill">{node.operationalState}</span>
          <span className="status-pill">{node.conclusionState}</span>
        </button>
      ))}
    </div>
  );
}

function GraphLegend() {
  return (
    <div className="flex flex-wrap items-center gap-5 border-t border-white/6 px-4 py-3 text-[11px] text-slate-500">
      <span className="flex items-center gap-2">
        <span className="h-px w-7 bg-slate-500" />
        Lineage
      </span>
      <span className="flex items-center gap-2">
        <span className="w-7 border-t border-dashed border-teal-300" />
        Supports
      </span>
      <span className="flex items-center gap-2">
        <span className="w-7 border-t border-dashed border-rose-300" />
        Contradicts
      </span>
      <span className="flex items-center gap-2">
        <span className="w-7 border-t border-dashed border-violet-300" />
        Replicates
      </span>
      <span className="ml-auto flex items-center gap-2">
        <Waypoints aria-hidden className="size-3.5" />
        Topological layout
      </span>
    </div>
  );
}

function ViewButton({
  active,
  disabled,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  icon: typeof Network;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition",
        active
          ? "bg-white/8 text-slate-100"
          : "text-slate-500 hover:text-slate-200",
      )}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <Icon aria-hidden className="size-3.5" />
      {label}
    </button>
  );
}

function FrontierMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-3 bg-[#0e1420] px-5 py-4">
      <GitBranch aria-hidden className="size-4 text-teal-300" />
      <span className="text-xl font-semibold tabular-nums text-white">
        {value}
      </span>
      <span className="text-xs uppercase tracking-[0.11em] text-slate-500">
        {label}
      </span>
    </div>
  );
}
