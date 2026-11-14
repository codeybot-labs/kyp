#!/usr/bin/env bash
# End-to-end smoke test against the deployed TESTNET contracts (mock pool). Never mainnet.
# Creates faucet-funded test wallets (launcher + 2 caballeros), wraps a little testnet NEAR,
# creates a launch, deposits, launches in one tx, then moves the mock price, pokes `record`,
# qualifies a milestone and claims. Keys stay in ~/.near-credentials; nothing is printed.
#
# Usage: PREFIX=kyp-sushmit RUN=1 ./scripts/smoke-testnet.sh   (RUN makes the wallet names unique)
#        PREFIX=kyp-sushmit-dcl POOLMODE=dcl WALLETS=kyp-sushmit RUN=1 ./scripts/smoke-testnet.sh
#        (real RHEA DCL: no mock price moves; does a small real swap instead of qualify/claim)
set -euo pipefail
cd "$(dirname "$0")/.."
PREFIX="${PREFIX:?set PREFIX}"; RUN="${RUN:-1}"
POOLMODE="${POOLMODE:-mock}"; W="${WALLETS:-$PREFIX}"
COORD="${PREFIX}.testnet"; LOCK="${PREFIX}-lock.testnet"; WRAP="wrap.testnet"
if [ "$POOLMODE" = "dcl" ]; then POOL="dclv2.ref-dev.testnet"; else POOL="${PREFIX}-pool.testnet"; fi
LAUNCHER="${W}-l${RUN}.testnet"; ALICE="${W}-a${RUN}.testnet"; BOB="${W}-b${RUN}.testnet"
case "$COORD" in *.near) echo "refusing: mainnet"; exit 1;; esac
NET="network-config testnet"; SIGN="sign-with-legacy-keychain send"
TXLOG="${TXLOG:-/tmp/kyp-smoke-tx.txt}"; : > "$TXLOG"
Y=000000000000000000000000   # 24 zeros (wNEAR yocto)

redact() { sed -E 's/ed25519:[A-Za-z0-9]+/ed25519:<redacted>/g'; }
tx() { # label, contract, method, args, deposit, signer, [gas]
  local out; out=$(command near contract call-function as-transaction "$2" "$3" json-args "$4" \
    prepaid-gas "${7:-300 Tgas}" attached-deposit "$5" sign-as "$6" $NET $SIGN 2>&1 | redact) || true
  local id; id=$(grep -oE 'Transaction ID: [A-Za-z0-9]+' <<<"$out" | head -1 | cut -d' ' -f3)
  echo "$1 $id" >> "$TXLOG"
  if grep -qiE 'error|failure|panicked' <<<"$out"; then echo "FAIL $1 ($id)"; grep -iE 'error|panick|Smart contract' <<<"$out" | head -5; return 1; fi
  echo "ok   $1 https://testnet.nearblocks.io/txns/$id"
}
view() { command near contract call-function as-read-only "$1" "$2" json-args "$3" $NET now 2>/dev/null | sed -n '/^[{["0-9tfn]/,$p'; }
create() { command near account view-account-summary "$1" $NET now >/dev/null 2>&1 && return 0
  command near account create-account sponsor-by-faucet-service "$1" autogenerate-new-keypair save-to-legacy-keychain $NET create 2>&1 | redact | grep -E "created|Error" ; }
hash() { printf '%s' "$1:$2" | sha256sum | cut -d' ' -f1; }

if [ -z "${LAUNCH_ID:-}" ]; then
for a in "$LAUNCHER" "$ALICE" "$BOB"; do create "$a"; done
for a in "$ALICE" "$BOB"; do
  tx "wrap_storage_$a" "$WRAP" storage_deposit "{\"account_id\":\"$a\"}" '0.00125 NEAR' "$a" '30 Tgas'
  tx "wrap_near_$a" "$WRAP" near_deposit '{}' '2 NEAR' "$a" '30 Tgas'
done
tx "wrap_storage_launcher" "$WRAP" storage_deposit "{\"account_id\":\"$LAUNCHER\"}" '0.00125 NEAR' "$LAUNCHER" '30 Tgas'

NOW=$(date +%s)
SALT_A="smoke-a-$RUN-$NOW"; SALT_B="smoke-b-$RUN-$NOW"
SYM="SMK$RUN"
PARAMS=$(cat <<JSON
{"params":{"name":"KYP Smoke $RUN","symbol":"$SYM","icon":null,"description":"Testnet smoke test launch (mock pool).","terms_uri":null,
"quote_token_id":"$WRAP","total_supply":null,"decimals":null,"opening_fdv_quote":"20$Y","presale_cap_bps":2000,
"min_raise":"1$Y","wallet_min":"500000000000000000000000","wallet_max":"2$Y",
"allowlist":["$(hash "$ALICE" "$SALT_A")","$(hash "$BOB" "$SALT_B")"],"reserved":[],
"sale_start":$NOW,"sale_end":$((NOW+86400)),
"milestones":[{"target_fdv_quote":"40$Y","unlock_bps":2500},{"target_fdv_quote":"2000$Y","unlock_bps":7500}],
"twap":{"window_sec":60,"min_observations":3,"min_liquidity":"1","claim_delay_sec":30,"min_obs_interval_sec":10},
"reveal":{"waves":2,"interval_sec":60},
"fee_split":{"holders_bps":5000,"liquidity_bps":3000,"community_bps":2000,"holders_account":"$LAUNCHER","liquidity_account":"$LAUNCHER","community_account":"$LAUNCHER"}}}
JSON
)
tx create_launch "$COORD" create_launch "$PARAMS" '2.6 NEAR' "$LAUNCHER"
ID=$(view "$COORD" get_launch_count '{}' | tr -dc 0-9)
echo "launch_id=$ID"
dep() { tx "deposit_$1" "$WRAP" ft_transfer_call "{\"receiver_id\":\"$COORD\",\"amount\":\"$2\",\"msg\":\"{\\\"Deposit\\\":{\\\"launch_id\\\":$ID,\\\"salt\\\":\\\"$3\\\"}}\"}" '1 yoctoNEAR' "$1" '150 Tgas'; }
dep "$ALICE" "1$Y" "$SALT_A"
dep "$BOB" "1500000000000000000000000" "$SALT_B"
tx launch "$COORD" launch "{\"launch_id\":$ID}" '1 NEAR' "$LAUNCHER"
else ID=$LAUNCH_ID; fi
# split pool steps (RHEA DCL): each ~920 Tgas pool deposit runs in its own resume_launch tx
for i in 1 2 3 4 5; do
  st=$(view "$COORD" get_launch "{\"launch_id\":$ID}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["status"])')
  [ "$st" = "Launching" ] || break
  tx "resume_launch_$i" "$COORD" resume_launch "{\"launch_id\":$ID}" '0 NEAR' "$BOB" '1000 Tgas'
done
L=$(view "$COORD" get_launch "{\"launch_id\":$ID}")
echo "$L" > /tmp/kyp-smoke-launch.json
python3 - <<PY
import json; l=json.load(open('/tmp/kyp-smoke-launch.json'))
print("status", l["status"], "token", l["token_id"], "pool", l["pool_id"], "presale_tokens", l["presale_tokens"], "init_point", l["init_point"], "token_is_x", l.get("token_is_x"))
PY
TOKEN=$(python3 -c 'import json;print(json.load(open("/tmp/kyp-smoke-launch.json"))["token_id"])')
PID=$(python3 -c 'import json;print(json.load(open("/tmp/kyp-smoke-launch.json"))["pool_id"])')
IP=$(python3 -c 'import json;print(json.load(open("/tmp/kyp-smoke-launch.json"))["init_point"])')
X=$(python3 -c 'import json;l=json.load(open("/tmp/kyp-smoke-launch.json"));print(1 if l.get("token_is_x",True) else -1)')
echo "lock balance: $(view "$TOKEN" ft_balance_of "{\"account_id\":\"$LOCK\"}")"
echo "alice token balance: $(view "$TOKEN" ft_balance_of "{\"account_id\":\"$ALICE\"}")"
echo "alice position: $(view "$LOCK" get_position "{\"launch_id\":$ID,\"account_id\":\"$ALICE\"}" | tr -d '\n ')"
echo "bob position: $(view "$LOCK" get_position "{\"launch_id\":$ID,\"account_id\":\"$BOB\"}" | tr -d '\n ')"

if [ "$POOLMODE" = "dcl" ]; then
  echo "dcl pool: $(view "$POOL" get_pool "{\"pool_id\":\"$PID\"}" | tr -d '\n ')"
  for i in 1 2; do tx "record_$i" "$LOCK" record "{\"launch_id\":$ID}" '0 NEAR' "$BOB" '60 Tgas' || true; sleep 8; done
  # a small real buy on the RHEA DCL pool: 0.2 wNEAR -> token (alice registers on the token first)
  tx token_storage_alice "$TOKEN" storage_deposit "{\"account_id\":\"$ALICE\"}" '0.01 NEAR' "$ALICE" '30 Tgas' || true
  tx swap_alice "$WRAP" ft_transfer_call "{\"receiver_id\":\"$POOL\",\"amount\":\"200000000000000000000000\",\"msg\":\"{\\\"Swap\\\":{\\\"pool_ids\\\":[\\\"$PID\\\"],\\\"output_token\\\":\\\"$TOKEN\\\",\\\"min_output_amount\\\":\\\"0\\\"}}\"}" '1 yoctoNEAR' "$ALICE" '150 Tgas' || true
  echo "alice token balance after swap: $(view "$TOKEN" ft_balance_of "{\"account_id\":\"$ALICE\"}")"
  echo "dcl pool after swap: $(view "$POOL" get_pool "{\"pool_id\":\"$PID\"}" | tr -d '\n ')"
  for i in 3 4 5; do tx "record_$i" "$LOCK" record "{\"launch_id\":$ID}" '0 NEAR' "$BOB" '60 Tgas' || true; sleep 8; done
  echo "twap_status: $(view "$LOCK" twap_status "{\"launch_id\":$ID}" | tr -d '\n ')"
  echo "tx log: $TXLOG"; exit 0
fi
# simulate trading: ~3x price (1.0001^11000), above milestone 1 (2x) and below milestone 2 (100x)
HIGH=$(( IP + X * 11000 ))
tx mock_set_point "$POOL" mock_set_point "{\"pool_id\":\"$PID\",\"point\":$HIGH}" '0 NEAR' "$POOL" '30 Tgas'
for i in 1 2 3 4 5 6 7 8; do tx "record_$i" "$LOCK" record "{\"launch_id\":$ID}" '0 NEAR' "$BOB" '60 Tgas' || true; sleep 8; done
echo "twap_status: $(view "$LOCK" twap_status "{\"launch_id\":$ID}" | tr -d '\n ')"
tx qualify "$LOCK" qualify "{\"launch_id\":$ID}" '0 NEAR' "$BOB" '30 Tgas'
echo "unlocked_bps: $(view "$LOCK" unlocked_bps "{\"launch_id\":$ID}")"
sleep 35
echo "alice claimable: $(view "$LOCK" claimable "{\"launch_id\":$ID,\"account_id\":\"$ALICE\"}")"
tx claim_alice "$LOCK" claim "{\"launch_id\":$ID}" '0 NEAR' "$ALICE" '60 Tgas'
echo "alice token balance after claim: $(view "$TOKEN" ft_balance_of "{\"account_id\":\"$ALICE\"}")"
echo "lock state: $(view "$LOCK" get_lock "{\"launch_id\":$ID}" | tr -d '\n ' | head -c 1500)"
echo "tx log: $TXLOG"
