# KYP architecture (testnet MVP)

## Contracts

```
             create_launch (payable)             ft_transfer_call(wNEAR, Deposit{id,salt})
 launcher ─────────────────────────────┐   ┌──────────────────────────────── presalers
                                        ▼   ▼
                              ┌─────────────────────┐   deploys + inits   ┌──────────────────┐
                              │   kyp coordinator   │────────────────────▶│ {sym}-{id}.kyp   │
                              │ escrow + launch FSM │◀── full supply ─────│ NEP-141 token    │
                              └─────────────────────┘                     └──────────────────┘
                     launch()  │  ①ft_transfer_call(presale tokens, Fund{positions,milestones,twap})
                               ├──────────────────────────────▶ ┌──────────────────────┐
                               │                                │ kyp lock             │◀── record()/qualify()/claim()
                               │  ②storage_deposit+create_pool  │ TWAP observer + tranches │     (anyone / presaler)
                               │  ③ft_transfer_call(token+wNEAR)└──────────────────────┘
                               │  ④add_liquidity ×2                         │ get_pool / ft_total_supply
                               └──────────────────────────────▶ ┌──────────────────────┐
                                                                │ RHEA DCL (or mock)   │
                                                                └──────────────────────┘
```

### Launch lifecycle (coordinator)

1. `create_launch(params)` — validates the public terms (cap ≤ 50%, window ≤ 7 days, wNEAR only, ascending milestones summing to 100%, first milestone above the opening FDV, fee split = 100%, ≤ 200 slots, unique hashes). Charges the launcher for the launch record's storage, then creates `{symbol}-{id}.{coordinator}`, deploys the token wasm (uploaded once with `set_token_code`) and mints the whole supply to the coordinator. Status `Creating → Open` (or `Failed` with a refund).
2. Deposits — `wNEAR.ft_transfer_call(coordinator, amount, {"Deposit":{"launch_id","salt"}})`. The slot is `sha256("{account}:{salt}")`; it must be an open (not reserved) slot. Per-wallet min/max and the open cap are enforced; the unused part is returned to the NEP-141 resolver, so excess is refunded in the same transaction.
3. `launch(id)` (launcher, before `sale_end`, min raise met, attaches NEAR for pool storage). In one transaction's promise chain:
   - **Settle**: each fill gets `tokens = quote × supply / opening_fdv`. One price for everyone, which is also the pool's opening price.
   - **① Lock**: all presale tokens → lock via `ft_transfer_call` with the positions and terms in `msg`. The lock rejects anything not sent by the coordinator, and checks positions sum to the amount.
   - **② Pool**: `storage_deposit` + `create_pool(token, wNEAR, 10000, init_point)` batched on the pool contract.
   - **③ Deposit**: remaining supply (minus reserved-slot tokens) and *all* presale wNEAR go into the pool.
   - **④ Liquidity**: two single-sided ranges: tokens strictly above the opening point, wNEAR at and below it (one `point_delta` gap). LP is owned by the coordinator and there is no method to remove it.
   - Each step has its own callback. A failed step stops the chain with progress flags kept; `resume_launch` (anyone) continues from the first incomplete step. Tokens never leave the coordinator/lock on failure.
4. Post-launch:
   - `reveal_next_wave` (anyone) once `launched_at + k × interval` has passed. `get_presalers` returns sizes for everyone and accounts only for revealed waves. Reserved buyers are revealed with the final wave.
   - Reserved slots: `wNEAR.ft_transfer_call(coordinator, ≥ amount, {"BuyReserved":{...}})` after launch. Tokens at the same presale price go into the lock as a new position on the same milestones. If the lock step fails, the whole payment is refunded.
   - Fees: anything sent with `{"Fees":{"launch_id"}}` plus reserved-slot proceeds accrue per token; `distribute_fees` (anyone) pays holders / liquidity / community accounts by the public bps. Failed legs are re-credited.
5. Refunds: `withdraw` if the launcher cancels while open, or misses `sale_end`. Deposits are committed otherwise.

### Lock

- Positions per `(launch_id, account)`. Milestones `{target_fdv_quote, unlock_bps}` with `qualified_at`.
- `record(id)` (anyone, at least `min_obs_interval_sec` apart) reads `pool.get_pool(pool_id)` and `token.ft_total_supply()` and stores `(ts, current_point, liquidity)`. Pool id mismatch or a non-`Running` state is ignored. A 512-entry ring buffer.
- `qualify(id)` (anyone): needs an anchor observation at or before `now − window`, ≥ `min_observations` in the window, every one with liquidity ≥ `min_liquidity`, and a fresh last sample. Time-weighted mean point → FDV = 1.0001^point × supply (Q128 integer math, orientation-aware). Every milestone at or below that FDV is marked qualified (a one-way ratchet).
- `claim(id)`: after `qualified_at + claim_delay_sec`, releases `total × Σ qualified bps − claimed`. A failed transfer rolls back.
- No owner, no admin, no rescue path.

### Token

Plain NEP-141 + metadata. The full supply is minted once in `new`. `ft_burn` lowers `ft_total_supply`, which the lock uses as minted − burned. The coordinator and lock may send to unregistered accounts (the token pays that storage); no one else can trigger free registrations.

## Privacy model (decision: simplest sound design)

- **On-chain at sale time**: terms, sizes, slot count, and salted hashes `sha256(account:salt)`. Invite codes go to presalers privately.
- **Reveal**: `get_presalers` and the site only show an account once its wave is revealed, on a fixed on-chain schedule.
- **Limitation**: a deposit is a normal NEAR transaction from the presaler's account, so anyone reading raw chain data can see who deposited. The reveal is a publishing and indexing convention backed by an on-chain schedule. It is not cryptographic privacy. Real hiding would need relayed/intents deposits or ZK, which is out of scope.

## What is mocked or incomplete

| Area | Status |
| --- | --- |
| Pool | Coordinator targets RHEA DCL's method names and JSON (`storage_deposit`, `create_pool`, `ft_transfer_call` msg `""`, `add_liquidity`, `get_pool`). All tests use `contracts/mock-pool`, which implements exactly those methods with no swaps or concentrated-liquidity math. Price moves are simulated with `mock_set_point`. **Not yet verified against `dclv2.ref-dev.testnet`** (deposit amounts, registration and range rules may differ). |
| USD | Milestones are stored in wNEAR. USD is a display-only reference (`PUBLIC_NEAR_USD`). There is no on-chain quote/USD oracle yet. |
| LP fee collection | The coordinator owns the LP but has no method to claim DCL fees yet. `Fees` deposits + `distribute_fees` route whatever is sent in. |
| Holder rewards | The "holders" share goes to one account. Per-holder distribution is off-chain/later. |
| Wallet | Real NEAR login via NEAR Connect on the configured network (testnet default) (see "Wallet login" below). Signing is only exercised against mocked RPC + a mock injected wallet in `web/tests/wallet.e2e.mjs`; no real testnet transaction has been sent yet because the contracts are not deployed. |
| Advisor group | Off-chain (e.g. a private chat). Not built. |
| Testnet deploy | `scripts/deploy-testnet.sh` written, not run. |
| Frontend deploy | `web/wrangler.jsonc` ready (static assets only), not deployed: wrangler is not logged in on the build box. |

## Wallet login (frontend)

- **Connector:** NEAR Connect (`@hot-labs/near-connect`), which NEAR's docs now recommend over Wallet Selector. Network comes from `PUBLIC_NEAR_NETWORK` (`testnet` default, or `mainnet`), resolved in `web/src/lib/network.mjs`: RPC, wNEAR, explorer, MyNearWallet URL and the per-network contract IDs follow it, and IDs that don't fit the network are rejected at build. The session survives reloads (NEAR Connect storage).
- **Wallets in the one connect modal (both networks):**
  - From the NEAR Connect manifest: Meteor, Intear, MyNearWallet, Ledger, Nightly, Ethereum wallets (MetaMask etc. via the EVM-on-NEAR module), NEAR CLI, HOT, OKX, Hana, Trezu, NEAR Mobile. MyNearWallet's manifest doesn't flag testnet, but its executor ships a testnet connector, so on testnet `network.mjs` enables it and allows `https://testnet.mynearwallet.com`.
  - Bridged from `@near-wallet-selector/*` modules (`web/src/lib/wallet-bridge.ts`, announced through NEAR Connect's standard `near-wallet-injected` event): Sender, HERE, Bitget, Coin98, Math, NEAR Mobile, Bitte, WELLDONE, Narwallets, Ramper, XDEFI, Arepa, SafePal, NEAR Snap. Extensions that aren't installed still show, and point to their install page. On mainnet the bridged NEAR Mobile is skipped (the manifest one covers it); on testnet the manifest one is dropped (it lacks testnet).
  - WalletConnect and Unity Wallet need a WalletConnect sign client. `wallet.ts` creates one (`@walletconnect/sign-client`, lazy-loaded) only when `PUBLIC_WALLETCONNECT_PROJECT_ID` is set; otherwise NEAR Connect hides them.
  - **Mainnet-only wallets on testnet:** `prepareManifest()` keeps HOT, OKX, Hana and Trezu, renames them "… (mainnet only)", and marks them testnet-visible so NEAR Connect lists them (sorted last). `connect()` opens the selector itself; if a mainnet-only wallet is picked it throws `MainnetOnlyWallet`, and the UI shows an explanation toast instead of starting the wallet. On mainnet nothing is relabelled or intercepted.
  - Any other wallet extension that announces itself to NEAR Connect shows automatically.
  - **Not added:** `meteor-wallet-app` (in-app only), `webauthn-wallet` (needs our own relayer).
- **Writes** (`web/src/lib/actions.mjs` builds them, `wallet.ts` signs them):
  - `create_launch`: attaches `token_account_deposit` from `get_config`, plus 0.1 NEAR for storage. The launcher must download the invite codes first.
  - Deposit or `BuyReserved`: one transaction to wNEAR. It runs `storage_deposit` for the signer and the coordinator if either isn't registered, `near_deposit` for any wNEAR shortfall, then `ft_transfer_call` (1 yocto).
  - Also: `withdraw`, `launch` (attaches the pool NEAR from `get_config`), `cancel_launch`, `resume_launch`, `record`, `qualify`, `claim` and `reveal_next_wave`.
- **Gating (UI only; the contracts enforce the same rules):**
  - Launch and cancel are shown only to the launcher.
  - Deposit is shown only when `sha256(account:code)` matches a slot.
  - Claim is shown only to the position owner.
  - Withdraw is shown only when the deposit is refundable.
- **Fallbacks:** in demo mode, nothing is signed. In testnet mode with no wallet connected, every write shows a "Connect wallet" prompt and the near-cli-rs command.

## Open risks

1. **Pool front-running / DoS**: the pool id is deterministic. Someone could create the DCL pool first at a bad price. Our `create_pool` then fails and the launch pauses (safe, but stuck). They can't add token-side liquidity because the coordinator holds all supply. Fix ideas: create the token in the launch transaction, or handle an existing empty pool.
2. **TWAP manipulation**: sustained buying for a full window can still lift the average. Ambitious targets, min liquidity, a claim delay, and future checks (e.g. liquidity-weighted TWAP, a max point jump per observation) reduce but don't remove this.
3. **Observer liveness**: milestones need someone to poke `record` regularly. A keeper or cron is needed, otherwise samples go stale.
4. **Gas**: the full launch used ~41 Tgas against the mock. Real DCL calls cost more. The chain is resumable, but real gas figures still need testnet measurement.
5. **DCL specifics**: the range layout (one-delta gap), deposits needed for `add_liquidity`, and whether DCL needs token whitelisting on testnet are unverified.
6. **Compliance**: an invite-only sale to named wallets may face securities or promotion rules in some places. Needs legal review before mainnet.
7. **Upgrades**: the contracts have no upgrade path by design (immutability). For mainnet, remove full-access keys after deploy and get an audit.
8. **Coordinator storage**: deposits add a few bytes per presaler on the coordinator's balance (the launch record itself is paid by the launcher).
