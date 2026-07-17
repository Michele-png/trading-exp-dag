# Architecture

## Product boundary

The MVP is a private registry and local execution recorder. It does not acquire
compute, infer relationships, stream logs, publish graphs, or collaborate
across accounts. Those omissions keep the first system auditable and make the
database contract stable before automation is introduced.

## Components

1. The Python CLI is the primary capture path. It calls `/api/v1`, wraps local
   commands, records safe environment metadata, and consumes a versioned JSON
   result manifest.
2. The Next.js application provides the REST API and a Web UI for inspection,
   draft editing, finalization, search, and export.
3. Supabase provides authentication, PostgreSQL, Row Level Security, and a
   private bucket for small evidence artifacts.
4. Vercel runs stateless Web/API requests. Long-running experiment processes
   remain local; a run is opened before execution and completed idempotently
   afterward.

## Graph model

Every space has exactly one objective root. Experiment nodes may have multiple
lineage parents, but all lineage remains inside the space and must be acyclic.
The database rejects cycles and rejects finalization when an experiment is not
reachable from the objective.

Lineage and interpretation are deliberately separate:

- Lineage edges capture ancestry and synthesis.
- Semantic links capture support, contradiction, and replication.
- Runs capture repeated attempts, seeds, and parameter sweeps.
- Artifacts and immutable external references capture evidence.

A contradiction is not an ancestry edge. Scientific disagreement may point
sideways or backward and must not compromise the DAG invariant.

## Lifecycle

Draft nodes may be edited or deleted. Finalization freezes the current
revision. Editorial corrections append a revision to the same node; a changed
hypothesis, method, or scientific conclusion becomes a new child experiment.
Finalized records may be archived or tombstoned but not hard-deleted.

Operational state and conclusion state are independent. A run may fail while
the experiment remains open, and a completed experiment may conclude that the
hypothesis is supported, refuted, mixed, or inconclusive.

Preregistration is encouraged rather than forced. The system records when a
hypothesis and success criteria were registered and labels retrospective
records explicitly.

## API design

The REST API is versioned under `/api/v1` and described by OpenAPI. Mutation
requests use idempotency keys so a CLI retry cannot duplicate runs, revisions,
or finalization.

Browser requests use the Supabase user JWT and therefore retain database RLS.
CLI requests use a revocable personal token. The API stores only a keyed digest
of that token, resolves an actor, and applies an explicit workspace predicate
to every elevated query.

Artifact uploads use a prepare/upload/finalize flow:

1. The API validates metadata and issues a short-lived signed upload.
2. The client uploads directly to the private bucket.
3. The API finalizes the artifact only after checking path, size, and checksum
   metadata.

## Portability

The backend is canonical. A versioned backup bundle exports records as JSON and
Markdown, includes checksums and schema versions, and can optionally include
small private artifacts. Bundles use authenticated encryption and are restored
only after checksum and safe-path validation.
