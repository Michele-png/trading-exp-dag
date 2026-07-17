"use client";

import {
  ArrowUpRight,
  Boxes,
  CircleDot,
  Search,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { EmptyState } from "@/components/ui-states";
import { cn } from "@/lib/utils";
import type { WorkspaceSummary } from "@/lib/view-models";

export function WorkspaceDashboard({
  workspaces,
}: {
  workspaces: WorkspaceSummary[];
}) {
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const active =
    workspaces.find((workspace) => workspace.id === workspaceId) ??
    workspaces[0];
  const visibleSpaces = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!active || !normalized) return active?.spaces ?? [];
    return active.spaces.filter((space) =>
      [space.name, space.slug, space.description]
        .filter(Boolean)
        .some((value) => value?.toLocaleLowerCase().includes(normalized)),
    );
  }, [active, query]);

  if (!active) {
    return (
      <EmptyState
        description="Ask a workspace owner to add your account before signing in again."
        title="No workspace access"
      />
    );
  }

  const nodeCount = active.spaces.reduce(
    (total, space) => total + space.nodeCount,
    0,
  );
  const openCount = active.spaces.reduce(
    (total, space) => total + space.openCount,
    0,
  );
  const completedCount = active.spaces.reduce(
    (total, space) => total + space.completedCount,
    0,
  );

  return (
    <div className="space-y-8">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <p className="eyebrow">Workspace dashboard</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.035em] text-white sm:text-4xl">
            {active.name}
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            Signed in as {active.role}
          </p>
        </div>
        {workspaces.length > 1 ? (
          <label className="space-y-2 text-xs font-semibold uppercase tracking-[0.13em] text-slate-500">
            Workspace
            <select
              className="field block min-w-56 normal-case tracking-normal"
              onChange={(event) => setWorkspaceId(event.target.value)}
              value={active.id}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <section
        aria-label="Workspace summary"
        className="grid gap-3 sm:grid-cols-3"
      >
        <SummaryCard
          accent="teal"
          icon={CircleDot}
          label="Open frontier"
          value={openCount}
        />
        <SummaryCard
          accent="blue"
          icon={Boxes}
          label="Registered nodes"
          value={nodeCount}
        />
        <SummaryCard
          accent="violet"
          icon={Sparkles}
          label="Concluded"
          value={completedCount}
        />
      </section>

      <section>
        <div className="mb-4 flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">
              Experiment spaces
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Each space has one objective root and an independent DAG.
            </p>
          </div>
          <label className="relative block w-full sm:w-72">
            <span className="sr-only">Search spaces</span>
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500"
            />
            <input
              className="field h-10 pl-9"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search spaces"
              type="search"
              value={query}
            />
          </label>
        </div>
        {visibleSpaces.length === 0 ? (
          <EmptyState
            description={
              query
                ? "Try a broader keyword or clear the search."
                : "Create a space through the API or CLI to register an objective."
            }
            title={query ? "No matching spaces" : "No experiment spaces yet"}
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {visibleSpaces.map((space) => (
              <Link
                className="group panel block p-5 transition hover:-translate-y-0.5 hover:border-teal-300/20 hover:bg-white/[0.045]"
                href={`/spaces/${space.id}`}
                key={space.id}
              >
                <div className="flex items-start justify-between gap-5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "size-2 rounded-full",
                          space.openCount > 0
                            ? "bg-teal-300 shadow-[0_0_12px_rgba(94,234,212,.5)]"
                            : "bg-slate-600",
                        )}
                      />
                      <h3 className="truncate font-semibold text-slate-100">
                        {space.name}
                      </h3>
                    </div>
                    <p className="mt-2 line-clamp-2 min-h-10 text-sm leading-5 text-slate-500">
                      {space.description ?? "No description provided."}
                    </p>
                  </div>
                  <ArrowUpRight
                    aria-hidden
                    className="size-4 shrink-0 text-slate-600 transition group-hover:text-teal-300"
                  />
                </div>
                <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-white/6 pt-4">
                  <Metric label="Nodes" value={space.nodeCount} />
                  <Metric label="Open" value={space.openCount} />
                  <Metric label="Done" value={space.completedCount} />
                </dl>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  icon: Icon,
  accent,
}: {
  label: string;
  value: number;
  icon: typeof CircleDot;
  accent: "teal" | "blue" | "violet";
}) {
  const styles = {
    teal: "bg-teal-300/8 text-teal-300 border-teal-300/10",
    blue: "bg-sky-300/8 text-sky-300 border-sky-300/10",
    violet: "bg-violet-300/8 text-violet-300 border-violet-300/10",
  };
  return (
    <div className="panel flex items-center gap-4 p-5">
      <span
        className={cn(
          "grid size-11 place-items-center rounded-xl border",
          styles[accent],
        )}
      >
        <Icon aria-hidden className="size-5" />
      </span>
      <div>
        <p className="text-2xl font-semibold tabular-nums text-white">{value}</p>
        <p className="text-xs font-medium uppercase tracking-[0.12em] text-slate-500">
          {label}
        </p>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-[0.12em] text-slate-600">
        {label}
      </dt>
      <dd className="mt-1 text-sm font-semibold tabular-nums text-slate-300">
        {value}
      </dd>
    </div>
  );
}
