#!/usr/bin/env bash
# Build all KYP contracts to wasm with cargo-near (handles nearcore wasm feature lowering).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p res
for c in token lock coordinator mock-pool; do
  # cargo-near >= 0.18 appends `--cfg near` (near-sdk-env needs it for panic messages)
  (cd "contracts/$c" && cargo near build non-reproducible-wasm --no-abi >/dev/null)
  name="kyp_${c//-/_}"
  cp "target/near/${name}/${name}.wasm" "res/${name}.wasm"
  printf "%-28s %8s bytes\n" "res/${name}.wasm" "$(wc -c < "res/${name}.wasm")"
done
