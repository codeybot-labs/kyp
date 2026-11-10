#!/usr/bin/env bash
# Deploy KYP to NEAR TESTNET. Never run against mainnet.
#
# Requires near-cli-rs (`near`). Accounts are created with the free testnet faucet and
# their keys are saved to your OS keychain by near-cli-rs. This script never prints keys.
#
# Usage: PREFIX=kyp-yourname POOL=mock ./scripts/deploy-testnet.sh
#   POOL=mock (default) deploys the KYP mock pool; POOL=dcl uses dclv2.ref-dev.testnet (unverified).
set -euo pipefail
cd "$(dirname "$0")/.."

PREFIX="${PREFIX:?set PREFIX, e.g. kyp-sushmit}"
POOL="${POOL:-mock}"
NET="network-config testnet"
SIGN="sign-with-keychain send"
COORD="${PREFIX}.testnet"
LOCK="${PREFIX}-lock.testnet"
MOCKPOOL="${PREFIX}-pool.testnet"
QUOTE="wrap.testnet"

case "$COORD" in *.near) echo "refusing: mainnet account"; exit 1;; esac

[ -f res/kyp_coordinator.wasm ] || ./scripts/build.sh

create() {
  near account create-account sponsor-by-faucet-service "$1" autogenerate-new-keypair save-to-keychain $NET create
}

for a in "$COORD" "$LOCK"; do create "$a"; done
if [ "$POOL" = "mock" ]; then create "$MOCKPOOL"; POOL_ID="$MOCKPOOL"; MSG=""; else POOL_ID="dclv2.ref-dev.testnet"; MSG=""; fi

near contract deploy "$LOCK" use-file res/kyp_lock.wasm with-init-call new \
  json-args "{\"coordinator\":\"$COORD\"}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' $NET $SIGN

if [ "$POOL" = "mock" ]; then
  near contract deploy "$MOCKPOOL" use-file res/kyp_mock_pool.wasm with-init-call new \
    json-args "{\"owner_id\":\"$MOCKPOOL\"}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' $NET $SIGN
fi

CONFIG=$(cat <<JSON
{"owner_id":"$COORD","config":{"lock_contract":"$LOCK","pool_contract":"$POOL_ID","pool_fee":10000,"point_delta":200,
"allowed_quote_tokens":["$QUOTE"],"max_presale_cap_bps":5000,"token_account_deposit":"2500000000000000000000000",
"pool_storage_deposit":"100000000000000000000000","pool_create_deposit":"100000000000000000000000",
"liquidity_deposit":"50000000000000000000000","pool_deposit_msg":"$MSG"}}
JSON
)
near contract deploy "$COORD" use-file res/kyp_coordinator.wasm with-init-call new \
  json-args "$CONFIG" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' $NET $SIGN

# token code for per-launch token sub-accounts (raw bytes)
near contract call-function as-transaction "$COORD" set_token_code file-args res/kyp_token.wasm \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as "$COORD" $NET $SIGN

# register the coordinator (and the mock pool) on wNEAR so they can receive deposits
for a in "$COORD" "$MOCKPOOL"; do
  [ "$POOL" != "mock" ] && [ "$a" = "$MOCKPOOL" ] && continue
  near contract call-function as-transaction "$QUOTE" storage_deposit json-args "{\"account_id\":\"$a\"}" \
    prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as "$COORD" $NET $SIGN
done

cat <<OUT

Deployed (testnet):
  PUBLIC_KYP_COORDINATOR=$COORD
  PUBLIC_KYP_LOCK=$LOCK
  PUBLIC_KYP_POOL=$POOL_ID
Put these in web/.env and rebuild the site to read live testnet state.
OUT
