# KYP — Know Your Presalers

An optional, invite-only presale layer for NEAR meme launches. Launchers sell a public slice of supply (max 50%) to hand-picked wallets for up to 7 days before launch. Every fill settles at **one price inside the launch transaction**, the tokens go **straight into a lock**, and they unlock only at **public, ambitious market-cap milestones** measured as a TWAP. Presalers are revealed in waves after launch, smallest first.

> **Status: testnet MVP.** Contracts are live on NEAR **testnet** with a mock pool ([docs/TESTNET.md](docs/TESTNET.md)). Nothing is deployed to mainnet, and nothing should be without an explicit go-ahead. The site opens in a browser-only demo mode; **Use testnet** switches to live testnet reads.

- Concept and research: [docs/SPEC.md](docs/SPEC.md) · approved plan: [docs/PLAN.md](docs/PLAN.md)
- Architecture, contract flows, what's mocked and open risks: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Repo layout

| Path | What |
| --- | --- |
| `contracts/common` | Shared types, integer DCL price math (Q128, no floats), TWAP |
| `contracts/token` | NEP-141 launch token: full supply minted once to the coordinator, `ft_burn`, no owner |
| `contracts/coordinator` | Presale escrow + launch coordinator (create, deposit, one-tx launch, reserved slots, reveal waves, fee routing, refunds) |
| `contracts/lock` | Market-cap lock: milestone tranches, pokeable TWAP observer, claims; no admin |
| `contracts/mock-pool` | **Mock** of the RHEA DCL methods KYP calls (tests + demo only) |
| `integration-tests` | near-workspaces sandbox test of the whole flow |
| `web` | Astro + Solid site: launches, create, status, terms, deposit, reveal, claim |
| `scripts` | `build.sh` (wasm), `test.sh` (everything), `deploy-testnet.sh`, `smoke-testnet.sh` (testnet) |

## Defaults (all configurable per launch unless noted)

- Supply 1B, 18 decimals, opening FDV ~$5k (≈2,500 wNEAR at a $2 reference). Presale price = opening FDV / supply = pool opening price.
- Presale + reserved cap ≤ 50% of supply (platform constant). wNEAR only. Per-wallet min/max set by the launcher.
- Milestones set by the launcher, e.g. $1m → 20%, $10m → 30%, $25m → 50%. **FDV = price × (minted − burned)**, fixed in wNEAR on-chain.
- TWAP: 60 min window, ≥ 6 observations, ≥ 5 min apart, min liquidity, 60 min claim delay.
- Reveal: 3 waves, 24 h apart, smallest first. Reserved slots stay reserved for their named wallets, same price and lock terms.
- Fee split 50% holders / 30% liquidity / 20% competitions & bounties.

## Run it

Prereqs: Rust (pinned by `rust-toolchain.toml`, 1.86 + `wasm32-unknown-unknown`), [cargo-near](https://github.com/near/cargo-near) ≥ 0.18, Node 22+. The integration test uses the latest stable Rust (its own `rust-toolchain.toml`) and needs OpenSSL headers.

```bash
cargo test --workspace            # 51 contract unit tests
./scripts/build.sh                # wasm into res/
cd integration-tests && cargo test -- --nocapture   # sandbox e2e (downloads near-sandbox)
cd web && npm install && npm test && npm run dev    # site on http://localhost:4321
cd web && npm run test:e2e        # headless wallet-flow check (Chrome)
./scripts/test.sh                 # all of the above
```

If `openssl-sys` can't find OpenSSL (no `pkg-config`), set `OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu OPENSSL_INCLUDE_DIR=/usr/include`.

### Site modes

- **Live testnet** (default on testnet builds that have contract IDs): the site reads live state over RPC. Writes are signed with the connected wallet (or an in-browser test wallet, below); the near-cli-rs command is still shown as a fallback when no wallet is connected. The header switch picks the deployment: **RHEA DCL** (`kyp-sushmit-dcl.testnet`, default) or **Mock pool** (`kyp-sushmit.testnet`), set with `PUBLIC_KYP_TESTNET_*` and `PUBLIC_KYP_TESTNET_ALT_*` (see `web/.env.production`).
- **Demo**: a simulated chain in `localStorage` that follows the contract rules ("Use demo" in the header). Default when no contracts are configured, and on mainnet builds unless chosen.

### Test wallets (testnet only)

`/test-wallets` (and **Test wallet (testnet only)**, first in the Connect wallet list) lets anyone test the whole flow without installing a wallet:

- **Generate test wallet**: a new ed25519 key is made in the browser, and NEAR's free testnet faucet helper (`POST https://helper.nearprotocol.com/account`, the one near-cli-rs `sponsor-by-faucet-service` uses; it allows browser CORS) creates `kyp-t-<label>-<random>.testnet` with 10 testnet NEAR. Only the public key leaves the browser. No server, nothing added to the Cloudflare Worker.
- Keys are stored **unencrypted in this browser's localStorage**, with warnings on the page. Multiple wallets, switch (**Use** signs in through NEAR Connect so every page works), **Wrap 1 NEAR**, **Export** (JSON that near-cli also reads), **Import**, **Delete**.
- Signing is direct over RPC with `@near-js/accounts` (no wallet popups), so 1000 Tgas `resume_launch` works. Every tx is linked to testnet.nearblocks.io.
- **Test mode quick start**: one click generates a launcher and two presalers, wraps wNEAR, creates a sample launch with both allowlisted, deposits 1 and 1.5 wNEAR, launches (plus the 3 `resume_launch` txs on the RHEA DCL), and records 3 TWAP observations (~90 s). Step buttons, reveal and claim are there too; the invite codes are shown so the normal Deposit page can be used instead.
- Testnet only, enforced three ways: the feature is off unless `PUBLIC_NEAR_NETWORK=testnet` (`PUBLIC_KYP_TEST_WALLETS=1` on a mainnet build fails the build), the picker entry and nav link are hidden on mainnet, and every sign/generate call refuses a non-testnet network, RPC or account.

### Network

`PUBLIC_NEAR_NETWORK=testnet|mainnet` (default **testnet**). RPC, wNEAR (`wrap.testnet` / `wrap.near`), explorer links, the MyNearWallet URL, the NEAR CLI commands, labels and the contract IDs (`PUBLIC_KYP_<NETWORK>_*`) all follow it. Contract IDs that don't fit the network fail the build, and the older unprefixed vars only apply to testnet, so testnet IDs can't leak into a mainnet build. No mainnet contracts are deployed or configured, so a mainnet build runs in demo mode.

### Price chart

The launch status page has a token price chart for Live launches, built with [TradingView Lightweight Charts™](https://www.tradingview.com/lightweight-charts/) (`lightweight-charts` 5.3.0, Apache-2.0; attribution kept, see [web/THIRD_PARTY_NOTICES.md](web/THIRD_PARTY_NOTICES.md)).

- **Views:** candles or line, FDV or per-token price in wNEAR, on a log scale. The lock's unlock thresholds are drawn as dashed price lines.
- **Data, all read client-side over NEAR RPC with no server or indexer:**
  - every observation the lock has recorded (`get_observations`, paged), plus
  - the pool's live point (`get_pool.current_point`) as the latest sample.
- **Candles:** buckets of 1m to 1d, picked to give at most ~80 candles. Each candle opens at the previous close. Buckets with no observation are skipped, so no prices are invented.
- **Empty state:** below 2 points the chart shows "Not enough price data yet".
- **Demo mode:** shows the simulated chain's observations, labelled "Demo data (simulated)".
- **Loading:** lazy. The chart component (~3 KB gz) and the library (~62 KB gz) are separate chunks, fetched only on the status page of a Live launch.
- **Why no swap history:** no free RHEA indexer serves testnet (`testnet-indexer.ref-finance.com` and `dev-indexer.ref-finance.com` don't resolve). The chart only moves when someone pokes `record`, plus the live point. Mainnet options are in [docs/TESTNET.md](docs/TESTNET.md#price-chart-data-sources).

### Wallet login

The **Connect wallet** button in the header uses [NEAR Connect](https://docs.near.org/web3-apps/tutorials/wallet-login) (`@hot-labs/near-connect`), the connector NEAR's docs currently recommend. The session persists across reloads. The connect modal lists every NEAR wallet we could find, on both networks:

- From the NEAR Connect manifest: Meteor, Intear, MyNearWallet, Ledger, Nightly, Ethereum wallets, NEAR CLI, HOT, OKX, Hana, Trezu, NEAR Mobile (mainnet; on testnet the bridged module is used).
- Bridged from `@near-wallet-selector/*` modules: Sender, HERE, Bitget, Coin98, Math, NEAR Mobile, Bitte, WELLDONE, Narwallets, Ramper, XDEFI, Arepa, SafePal and NEAR Snap (MetaMask).
- WalletConnect and Unity Wallet: only when `PUBLIC_WALLETCONNECT_PROJECT_ID` (a Reown project ID) is set. No ID is in the repo.

On **testnet**, HOT, OKX, Hana and Trezu don't support testnet. They are still listed, at the end, as "… (mainnet only)", and clicking one shows a short explanation instead of an error. On **mainnet** they connect normally. Not added: `meteor-wallet-app` (works only inside the Meteor app; Meteor is already listed) and `webauthn-wallet` (needs our own account-creation relayer).

The connected account fills the account fields. The UI is gated by account: only invited wallets see deposit, only the launcher sees launch and cancel, and only the owner can claim. Details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#wallet-login-frontend).

### Deploy

- Contracts: **live on NEAR testnet** with the **mock** pool: coordinator [`kyp-sushmit.testnet`](https://testnet.nearblocks.io/address/kyp-sushmit.testnet), lock [`kyp-sushmit-lock.testnet`](https://testnet.nearblocks.io/address/kyp-sushmit-lock.testnet), mock pool [`kyp-sushmit-pool.testnet`](https://testnet.nearblocks.io/address/kyp-sushmit-pool.testnet). The end-to-end smoke test passed on-chain (one-tx launch, lock, TWAP, qualify, claim, reveal). A second instance runs against the **real RHEA testnet DCL** (`kyp-sushmit-dcl.testnet`). There, the pool deposits run in separate `resume_launch` txs because each DCL deposit burns ~920 Tgas. Liquidity lands in the real pool and the lock reads it. Details, tx links and what's mock vs real: [docs/TESTNET.md](docs/TESTNET.md).
- Redeploy: `PREFIX=kyp-<name> KEYCHAIN=legacy ./scripts/deploy-testnet.sh` creates faucet-funded **testnet** accounts (keys saved by near-cli-rs to `~/.near-credentials` with `KEYCHAIN=legacy`, or the OS keychain by default; output is redacted) and deploys with the mock pool. `POOL=dcl` targets `dclv2.ref-dev.testnet` (0.5 NEAR storage, no deposit on `add_liquidity`, `"Deposit"` msg, split pool steps via `set_step_gas`; finish a launch with `resume_launch` at 1000 Tgas). `./scripts/smoke-testnet.sh` runs the on-chain smoke test.
- Site: live at https://kyp-web.sushmitsarmah.workers.dev as a Cloudflare Worker **static assets only** (Worker name `kyp-web`; `web/wrangler.jsonc`: no Worker script, no bindings, no KV/R2/D1). The build reads the testnet contract IDs from the committed `web/.env.production` (public account IDs only). It opens in live testnet mode on the RHEA DCL deployment (switch to Mock pool or demo in the header), with test wallets at `/test-wallets`. No WalletConnect ID. Static asset requests are free on the Workers Paid plan. Redeploy from the Mac mini with `cd web && npm run deploy`.

## Test results (local)

- `cargo test --workspace`: 57 passed (common 12, token 4, lock 9, coordinator 31, mock-pool 1).
- `integration-tests`: 2 passed. `split_pool_steps_resume_to_live` runs the RHEA-style flow (launch pauses after create_pool, 3 `resume_launch` txs to Live). One `launch` transaction settles 3 presalers at one price, funds the lock, creates and seeds the pool (33 receipts, ~41 Tgas burnt). Then a TWAP-qualified milestone, a 25% claim, wave-1 reveal, a reserved slot on the same terms and the fee split are all checked on the sandbox.
- `web`: `npm test` runs 33 unit tests (incl. `src/lib/testwallet.mjs` storage/faucet/signing guards and the `src/lib/testflow.mjs` quick start on a mock chain) (incl. `src/lib/chart.mjs` candle building): math, transaction builders and gating in `src/lib/actions.mjs`, and the network config and wallet labels in `src/lib/network.mjs`. `npm run test:e2e` builds a testnet-mode site with mocked RPC and a mock injected wallet. It checks the connect modal (including the mainnet-only labels and the click explanation), connecting through the modal, session persistence, launcher-only controls and the exact deposit and launch transactions handed to the wallet. It then builds a mainnet site (no labels, mainnet labels, testnet IDs ignored, no testnet requests) and a build with a placeholder WalletConnect ID (WalletConnect and Unity listed; the relay is blocked in the test), and the price chart (lazy chunk, candle/line toggle, milestone lines, empty state, attribution), and the test wallet (generate via a mocked faucet, wrap, connect through the picker, deposit on the normal page, all signed in-browser and decoded from the RPC request; export/delete/import; absent on mainnet): 11 steps pass, with no console errors. `npm run test:live` runs the quick start in Chrome against the **real** testnet (passed: launch #4 Live on the RHEA DCL copy), and `npm run test:live:node` does the same from Node (passed: launch #3, plus reveal). It needs Chrome (`CHROME_PATH`). Headless browser run of every page and the full demo flow had no console errors.
