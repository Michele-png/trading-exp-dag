# Changelog

## Unreleased

### Added

- Monorepo foundation for the Next.js Web/API application and Python CLI.
- Local Supabase configuration, migration workflow, and CI verification.
- Workspace-ready experiment DAG model with immutable revisions, run records,
  metrics, provenance references, private evidence, and audit history.
- Versioned REST and result-manifest contracts.
- CLI-first local execution capture, encrypted backup, and restore workflows.
- Private topological graph UI with focus navigation and node inspection.

### Security

- Row Level Security on exposed data.
- Revocable hash-only personal tokens.
- Private signed artifact access.
- Secret scanning, portable path normalization, and authenticated backup
  encryption.

### Design decisions

- Contradiction/support/replication links are semantic cross-links rather than
  lineage edges.
- Local commands remain outside Vercel; the server records their lifecycle.
- The backend is canonical, with tested portable export/import for free-tier
  durability.
