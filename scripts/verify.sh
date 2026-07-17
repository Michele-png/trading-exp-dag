#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

npm run lint
npm run typecheck
npm run contracts:check
npm run test:web
npm run build

uv run --project packages/cli ruff check packages/cli
uv run --project packages/cli mypy packages/cli/src
uv run --project packages/cli pytest

npx --yes supabase@latest db reset
npx --yes supabase@latest test db
