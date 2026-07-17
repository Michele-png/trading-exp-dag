# Deployment

## Environments

- Local development uses the Supabase CLI stack.
- Vercel Preview uses the hosted development project
  `wicrpbhhsobwitimrkhs`.
- Production must use a separate Supabase project before canonical experiment
  history is stored. The write-enabled development MCP must not be pointed at
  production.

Configure each Vercel environment independently with the variables listed in
`docs/security.md`. Set the Supabase Auth site URL and redirect allow-list to
the matching Vercel URL, including `/auth/callback`.

## Database release

1. Start or reset the local Supabase stack.
2. Run SQL tests and application integration tests.
3. Review the generated migration and run security/performance advisors.
4. Push the reviewed migration to staging.
5. Run browser and CLI smoke tests.
6. Apply the same immutable migration to production.

Do not use ad hoc remote DDL as a substitute for committed migrations.

## Vercel

The existing Vercel project is `trading-exp-dag`. Configure its monorepo root
directory as `apps/web`, retain GitHub preview deployments, and use Node.js 24
or a compatible supported release.

The implementation repository was not visible through the authenticated GitHub
account during preflight. Resolve and link its actual remote before the first
Git-based production deployment; do not create a second Vercel project.

## Free-tier durability

Supabase Free does not provide the same automated backup guarantees as paid
plans, and database backups do not contain Storage objects. Run `qdag backup`
regularly and verify restore bundles. Keep at least one encrypted copy outside
the development machine.
