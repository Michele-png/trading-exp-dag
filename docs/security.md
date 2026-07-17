# Security boundaries

## Credentials

Required application configuration:

- `NEXT_PUBLIC_SUPABASE_URL` — public project URL.
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — browser-safe publishable key.
- `SUPABASE_SECRET_KEY` — server-only elevated key used only by guarded CLI
  token flows.
- `API_TOKEN_PEPPER` — server-only random value used to derive stored personal
  token digests.

Migration-only credentials such as the database password and Supabase access
token stay in a local ignored environment or CI secret store. Vercel deployment
authentication is provided by its GitHub integration; the application does not
need a Vercel token.

## Authorization

- Every exposed table has RLS enabled.
- Browser authorization relies on `auth.uid()` and workspace membership.
- Authorization claims never use user-editable `user_metadata`.
- Personal access tokens are high entropy, shown once, scoped, expirable, and
  revocable. Only a keyed digest and a display prefix are persisted.
- The server-only admin client is isolated in one module. Every query made
  through it must include the resolved workspace and actor.
- Private artifacts are served with short-lived signed URLs.

## Untrusted input

Node text, logs, manifests, imported bundles, and artifact contents are
untrusted. The application:

- validates API and manifest payloads against explicit schemas;
- normalizes local paths and strips URL credentials and query strings;
- blocks high-confidence secrets in patches and opt-in logs unless the user
  explicitly overrides the warning;
- caps artifact size and allow-lists MIME categories;
- prevents archive path traversal and verifies every backup checksum;
- renders user Markdown without raw HTML;
- never evaluates commands received from the server.

## Operational checks

Before release:

1. Run RLS tests with two separate users and workspaces.
2. Run Supabase security and performance advisors.
3. Confirm Vercel has no server secret in client-visible variables.
4. Confirm Storage buckets are private.
5. Exercise token revocation and expired-token failures.
6. Restore an encrypted backup into an empty test project.
