# Integration checklist

## Repository

- [x] Monorepo structure and shared contracts established.
- [x] Existing Vercel project linked locally.
- [x] Source repository remote resolved and connected to Vercel Git deployment.
- [x] No secret or local environment file is tracked.

## Database

- [x] Local reset applies all migrations.
- [x] DAG invariant and RLS SQL tests pass.
- [x] Security and performance advisors have no unresolved release blockers.
- [x] Staging migration applied from committed SQL.

## Application

- [x] Web lint, typecheck, unit tests, and production build pass.
- [x] CLI ruff, mypy, pytest, and end-to-end run capture pass.
- [x] OpenAPI and result-manifest examples validate.
- [x] Browser and CLI authorization paths are smoke-tested.

## Durability

- [x] Encrypted backup exports database records and optional artifacts.
- [x] Restore into an empty project reproduces canonical checksums.

## Deployment

- [x] Preview points to staging Supabase.
- [ ] Production uses a separate Supabase project.
- [x] Vercel server secrets are configured and not client-visible.
- [x] Supabase Auth redirect URLs match deployed environments.
- [ ] Production smoke test passes before canonical experiment history is used.
