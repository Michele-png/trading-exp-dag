# Deployment

## Environments

- Local development uses the Supabase CLI stack.
- Vercel Preview and Production currently share the hosted project
  `wicrpbhhsobwitimrkhs` by explicit owner decision.
- The shared project is limited to synthetic, anonymized, or non-customer
  research. It removes environment isolation: Preview writes, test cleanup, and
  schema changes can affect canonical records.
- Before storing raw or identifiable customer data, provision a separate
  company-controlled Production project and keep write-enabled development
  tooling disconnected from it.

Configure each Vercel environment independently with the variables listed in
`docs/security.md`. Set the Supabase Auth site URL and redirect allow-list to
the matching Vercel URL, including `/auth/callback`.

## Database release

1. Start or reset the local Supabase stack.
2. Run SQL tests and application integration tests.
3. Review the generated migration and run security/performance advisors.
4. Push the reviewed migration to the shared hosted project.
5. Run browser and CLI smoke tests against Preview.
6. Promote the verified commit to Production without reapplying the migration.

Do not use ad hoc remote DDL as a substitute for committed migrations.

## Vercel

The existing Vercel project is `trading-exp-dag`. Configure its monorepo root
directory as `apps/web`, retain GitHub preview deployments, and use Node.js 24
or a compatible supported release.

QDAG enforces access with Supabase sessions and scoped personal API tokens.
Do not enable Vercel Authentication on deployments used by the CLI because it
intercepts requests before QDAG can validate the personal token.

The source repository is `Michele-png/trading-exp-dag` and is connected to this
Vercel project for Git-based deployments. Do not create a second Vercel project.

## Free-tier durability

Supabase Free does not provide the same automated backup guarantees as paid
plans, and database backups do not contain Storage objects. Run `qdag backup`
regularly and verify restore bundles. Keep at least one encrypted copy outside
the development machine.
