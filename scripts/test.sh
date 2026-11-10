#!/usr/bin/env bash
# Run every test: contract unit tests, wasm build, sandbox integration test, web math tests, web build.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== contract unit tests"; cargo test --workspace -q
echo "== wasm build"; ./scripts/build.sh
echo "== sandbox integration test"; (cd integration-tests && cargo test -q)
echo "== web"; (cd web && npm ci --no-audit --no-fund -q && npm test && npm run build >/dev/null && echo "web build ok")
