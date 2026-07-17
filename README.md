# QuantTrading Experiment DAG

A private, CLI-first registry for reproducible experiments. Each experimental
space is a rooted directed acyclic graph (DAG): an objective anchors immutable
experiment history, while typed semantic links record support, contradiction,
and replication without distorting lineage.

## Repository layout

- `apps/web` — Next.js Web UI and versioned REST API.
- `packages/cli` — Python `qdag` command-line client and local run wrapper.
- `packages/contracts` — OpenAPI and result-manifest contracts.
- `supabase` — local Supabase configuration, SQL migrations, and database tests.
- `docs` — architecture, security, and deployment decisions.

## Prerequisites

- Node.js 20 or newer and npm.
- Python 3.11 or newer and `uv`.
- Docker Desktop.
- Supabase CLI (the npm scripts use the current CLI through `npx`).

## Local development

```bash
npm install
npm run supabase:start
cp apps/web/.env.example apps/web/.env.local
npm run dev
```

Fill `apps/web/.env.local` with the local values printed by
`npm run supabase:start`. Generate `API_TOKEN_PEPPER` with a password manager or
cryptographically secure random generator.

Run the Python CLI directly from the workspace:

```bash
uv run --project packages/cli qdag --help
```

## Verification

```bash
npm run lint
npm run typecheck
npm run test
npm run build
uv run --project packages/cli ruff check packages/cli
uv run --project packages/cli mypy packages/cli/src
```

Database migrations and policies are exercised with a local Supabase reset and
SQL tests. Never iterate on schema by applying ad hoc migrations to the hosted
project.

## Security model

The browser uses Supabase sessions and Row Level Security (RLS). The CLI uses
revocable personal tokens stored in the operating-system keyring. Server-only
credentials must be configured as Vercel secrets and must never be exposed
through `NEXT_PUBLIC_*` variables.

Evidence storage is private. Large datasets and outputs remain in their source
systems and are registered by immutable URI, version, and checksum.
