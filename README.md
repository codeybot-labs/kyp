# Know Your Cabal

An optional, invite-only presale layer for NEAR meme launches. Launchers sell a public slice of supply (max 50%) to hand-picked wallets for up to 7 days before launch. Every fill settles at **one price inside the launch transaction**, the tokens go **straight into a lock**, and they unlock only at **public, ambitious market-cap milestones** measured as a TWAP. Caballeros are revealed in waves after launch, smallest first.

**Live on NEAR testnet: https://kycabal.fun**

> **Try it in 2 minutes:** open [kycabal.fun/test-wallets](https://kycabal.fun/test-wallets) → **Test mode quick start** → pick a few caballeros → **Run quick start**. The site makes throwaway faucet-funded testnet wallets in your browser, creates a launch, deposits, launches it on the real RHEA testnet DCL and records TWAP observations (~90 s). You then see the launch **Live** on the home page, with its locked presale, price chart and milestone ladder.

> **Status: testnet MVP.** Contracts are live on NEAR **testnet** only: coordinator [`kyp-sushmit-dcl.testnet`](https://testnet.nearblocks.io/address/kyp-sushmit-dcl.testnet) and lock [`kyp-sushmit-dcl-lock.testnet`](https://testnet.nearblocks.io/address/kyp-sushmit-dcl-lock.testnet) on the real RHEA testnet DCL (`dclv2.ref-dev.testnet`), plus a mock-pool copy selectable in the header ([docs/TESTNET.md](docs/TESTNET.md)). Nothing is deployed to mainnet, and nothing should be without an explicit go-ahead. A browser-only demo mode is available from the header.

- Concept and research: [docs/SPEC.md](docs/SPEC.md) · approved plan: [docs/PLAN.md](docs/PLAN.md)
- Architecture, contract flows, what's mocked and open risks: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Repo layout

| Path | What |
| --- | --- |
| `contracts/common` | Shared types, integer DCL price math (Q128, no floats), TWAP |
| `contracts/token` | NEP-141 launch token: full supply minted once to the coordinator, `ft_burn`, no owner |
| `contracts/coordinator` | Presale escrow + launch coordinator (create, deposit, one-tx launch, reserved slots, reveal waves, fee routing, refunds) |
| `contracts/lock` | Market-cap lock: milestone tranches, pokeable TWAP observer, claims; no admin |
| `contracts/mock-pool` | **Mock** of the RHEA DCL methods Know Your Cabal calls (tests + demo only) |
| `integration-tests` | near-workspaces sandbox test of the whole flow |
| `web` | Astro + Solid site: launches, create, status, terms, deposit, reveal, claim, Cabal Corner (`/corner`), flywheel (`/flywheel`) |
| `web/worker`, `web/migrations` | Cabal Corner API: a small Worker that only runs for `/api/*`, backed by Cloudflare D1 |
| `scripts` | `build.sh` (wasm), `test.sh` (everything), `deploy-testnet.sh`, `smoke-testnet.sh` (testnet) |

## Defaults (all configurable per launch unless noted)

- Supply 1B, 18 decimals, opening FDV ~$5k (≈2,500 wNEAR at a $2 reference). Presale price = opening FDV / supply = pool opening price.
- Presale + reserved cap ≤ 50% of supply (platform constant). wNEAR only. Per-wallet min/max set by the launcher.
- Milestones set by the launcher, e.g. $1m → 20%, $10m → 30%, $25m → 50%. **FDV = price × (minted − burned)**, fixed in wNEAR on-chain.
- TWAP: 60 min window, ≥ 6 observations, ≥ 5 min apart, min liquidity, 60 min claim delay.
- Reveal: 3 waves, 24 h apart, smallest first. Reserved slots stay reserved for their named wallets, same price and lock terms.
- Fee split 50% holders / 30% liquidity / 20% competitions & bounties (the live on-chain default). Optional capped legs: operations (max 30%) and NEAR AI credits (max 20%), paid to named accounts. Example: 20% operations, 10% NEAR AI credits.

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
- **How many**: pick 1–10 and they are created one at a time (1.5 s apart) with per-wallet progress. A transient faucet error is retried with backoff; one failed wallet doesn't stop the rest. **At most 10 test wallets per browser**: generate and import are blocked at 10 with a clear message.
- **Faucet rate limit**: NEAR's faucet limits each IP (we hit `429 Rate limit exceeded, retry in 12 hours` after ~20 accounts in a day). Then the batch stops hammering it and, if any stored test wallet holds ≥ 3 NEAR, new wallets are created and funded with 2 NEAR from the richest one through the `testnet` registrar (`create_account`, as near-cli `fund-myself` does). Rows show "funded by …".
- Keys are stored **unencrypted in this browser's localStorage**, with warnings on the page. Multiple wallets, switch (**Use** signs in through NEAR Connect so every page works), **Wrap 1 NEAR**, **Export** (JSON that near-cli also reads), **Import**, **Delete**.
- Signing is direct over RPC with `@near-js/accounts` (no wallet popups), so 1000 Tgas `resume_launch` works. Every tx is linked to testnet.nearblocks.io.
- **Test mode quick start**: pick 1–9 caballeros (+ the launcher = max 10 wallets). One click reuses funded test wallets you already have (toggle), generates the rest, wraps wNEAR, creates a sample launch with every caballero allowlisted (opening FDV 100 wNEAR so the 20% open cap fits 9 sample deposits; up to 3 reveal waves), deposits varied sample amounts (1, 1.5, 0.75, 1.25, 0.5, 2, 1, 1.5, 0.75 wNEAR), launches (plus the 3 `resume_launch` txs on the RHEA DCL), and records 3 TWAP observations (~90 s). Step buttons, reveal and claim are there too; the invite codes are shown so the normal Deposit page can be used instead.
- Testnet only, enforced three ways: the feature is off unless `PUBLIC_NEAR_NETWORK=testnet` (`PUBLIC_KYP_TEST_WALLETS=1` on a mainnet build fails the build), the picker entry and nav link are hidden on mainnet, and every sign/generate call refuses a non-testnet network, RPC or account.

### Cabal Corner (`/corner`, early preview)

*Where the caballeros plan the launch.* Each launch has a corner at `/corner?id=<launch>` (also the **Cabal Corner** tab on every launch page and in the nav). What runs today:

- **Roster and skills.** Caballeros join and tag their skills (dev, creator, designer, community, trader, partnerships). Revealed caballeros are tagged from the coordinator's `get_presalers` with their reveal wave.
- **Team mix.** Counts each skill against what a launch needs and flags missing or thin skills before launch.
- **Daily missions.** Three tasks a day per caballero, picked from their skills (stable per UTC day), ticked off for points.
- **Bounties and competitions.** Propose → a majority of the roster agrees → bounties are claimed, delivered (a link) and approved by majority; competitions take one entry each, one vote per caballero, and the proposer closes them on votes. Rewards are shown against the launch's on-chain community fee share (`fee_split.community_bps` and fees waiting). Caballeros can open a prefilled NEARN create-listing page and paste the listing URL onto the bounty. After the roster approves a delivery, the launcher or the community account records an on-chain `approve_bounty`; anyone can then call `pay_bounty` to pay the claimant from the undistributed community fee share. The launcher can also approve and pay in one wallet transaction.
- **No passengers.** Points over 7 days (mission 1, vote 1, proposal 2, entry 2, delivery 3, win 5). Three quiet days after joining flags a passenger.
- **Built in the open.** An activity feed logs every action. A caballero whose wave isn't revealed yet appears as an alias (`Caballero 3F2A`, salted per corner, server-side); once the chain reveals their wave, their wallet is tagged on everything they did.
- **AI agent.** A chat panel built on [assistant-ui](https://github.com/assistant-ui/assistant-ui) primitives (MIT). It answers only about Know Your Cabal, Cabal Corner, memecoin launches on NEAR, and the NEAR ecosystem, from this launch's live data (status, raise, team mix, passengers, bounties) and from 23 curated NEAR ecosystem notes retrieved with [MiniSearch](https://github.com/lucaong/minisearch) (MIT), and cites the notes it used. A small Ollama Cloud model (`gpt-oss:20b`) phrases the answer from those notes. Workers AI stays off. Calls are capped per day (150) and per IP or signed-in user (20/minute); off-topic questions, prompt-injection, and financial-advice asks are refused without calling the model. If Ollama errors or times out, the chat falls back to the notes.
- **Cabal record.** For any account: every launch it led or presold in (coordinator + lock views: role, deposit, wave, locked/claimed), plus its corner points, missions and wins on launches where it is public. Hidden caballeros' corner work stays off other people's view until reveal.

Storage and identity:

- **Synced** (when the `/api` Worker is deployed): one JSON state row per launch in **Cloudflare D1**, written through the same reducer the tests cover (`web/src/lib/corner.mjs`). Wallet identities sign a **NEP-413** message (no transaction, cannot move funds); the Worker checks the signature, the recipient host, a one-time nonce, and that the key is a full-access key of the account on-chain, then issues a 7-day session. Guests can join with a name and are labelled "guest".
- **Local** (demo mode, or wherever the API isn't deployed): the same features in `localStorage`, seeded with caballeros marked "sample", and the page says **"Preview — data is local"**.
- Cost guardrails: the Worker runs only for `/api/*` (static pages stay free asset requests), bodies are capped at 4 KB, rows per launch are capped, and writes are throttled per IP. Everything fits the Workers Paid plan's included allowances.

Run locally: `cd web && npm run dev:worker` (builds, applies the D1 migration to a local database, serves site + API on http://localhost:8787). `npm run test:corner-api` (with `BASE=http://127.0.0.1:8787`) drives the API end to end with a throwaway faucet testnet wallet.

### The flywheel: how fees go back into the project

Every trade earns fees, and Know Your Cabal puts those fees back to work for the project. Site page: [kycabal.fun/flywheel](https://kycabal.fun/flywheel).

**What's live today.** Trading fees that are deposited into the coordinator (`Fees` transfers) and reserved-slot proceeds are split on-chain by the launch's public bps — default 50% holders / 30% liquidity / 20% competitions & bounties. A launch may also add capped operations (max 30%) and NEAR AI credits (max 20%) legs, paid to named accounts. Anyone can call `distribute_fees`. The launcher can enable holder pull claims: the holders share accrues to a pot, anyone can open an epoch that snapshots total supply, and unlocked wallets prepare then claim in a later block. Anyone can call `deploy_fee_liquidity` to place leftover liquidity-share fees into coordinator-owned DCL bands around the current price and further out for support. Cabal Corner shows bounties against the community share. After a Corner vote, the launcher or the community account records `approve_bounty` on-chain; anyone can then call `pay_bounty` to pay the claimant from the undistributed community share (the launcher can also approve and pay in one transaction). They can also still pay from the community account directly. Anyone can call `collect_fees` to claim charged RHEA DCL trading fees from the coordinator-owned permanent LP into the launch's fee pool, then `distribute_fees` to pay the public split. The launcher can set a lock buyback share (taken from the liquidity slice, max 20%; default 0%, example 10%); anyone can then call `buyback_to_lock` to swap that quote on the DCL pool into the token, with a minimum output, and add it to the permanent lock. Failed swaps credit the quote back.

**Planned fee design.** Later destinations, configurable per launch (example defaults only: 20% operations, 10% NEAR AI credits, with the rest following the public split):

- **Operations (default, capped).** Live: a capped share (max 30%) is paid to the operations account the launcher names, for running costs (DexScreener, listings, bots, hosting).
- **NEAR AI credits.** Live: a capped share (max 20%) is paid to the NEAR AI credits account the launcher names, to buy credits for the project's tooling (for example the Cabal Corner agent). NEAR AI is not used to produce the project's content.
- **Content and creators.** The locked caballeros' fee share funds quality content. Caballeros agree bounties posted on [NEARN](https://nearn.io) that bring in artists and creators, who can use the best AI tools or none at all.
- **The lock.** Live: a launcher-set share (from the liquidity slice, max 20%; default 0%, example 10%) swaps on the DCL pool into the token and is added to the permanent lock. Failed swaps credit the quote back.
- **Smarter liquidity.** Fees fund liquidity in bands below the current price for support, and around it to earn more fees.
- **Partner pools.** Fees seed shared pools with other NEAR communities.
- **Open bounties.** Fees fund open NEARN bounties for memes, campaigns, dev work and translations, open to everyone.

**Roadmap: the memecoin management system.** Cabal Corner is the first piece of a bigger idea: one place that brings together everything a team needs to run a meme project after launch, without the usual friction. Next steps, not built yet: partner pools, invites that read the Cabal record directly, an agent with live NEAR market data, and per-launch channels for the caballeros. Already live or partly live: operations and NEAR AI fee legs, on-chain `approve_bounty` then permissionless `pay_bounty` from the community share, holder pull claims, `deploy_fee_liquidity` for extra DCL bands, NEARN listing links, `collect_fees` for RHEA DCL trading fees, and `buyback_to_lock`.

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
- Site: live at **https://kycabal.fun** (also https://kyp-web.sushmitsarmah.workers.dev), Cloudflare Worker `kyp-web`. The build reads the testnet contract IDs from the committed `web/.env.production` (public account IDs only) and opens in live testnet mode on the RHEA DCL deployment (switch to Mock pool or demo in the header), with test wallets at `/test-wallets`. No WalletConnect ID. `web/wrangler.jsonc` serves the static assets (free on the Workers Paid plan) and runs `web/worker/index.mjs` **only for `/api/*`** (Cabal Corner), with one D1 binding (`CORNER_DB`) and no other bindings. Before the first deploy of that config: `npx wrangler d1 create kyp-corner`, paste the id into `wrangler.jsonc`, then `npx wrangler d1 migrations apply kyp-corner --remote`. Without the API the corner runs in local preview mode. Redeploy with `cd web && npm run deploy`.

## Test results (local)

- `cargo test --workspace`: 57 passed (common 12, token 4, lock 9, coordinator 31, mock-pool 1).
- `integration-tests`: 2 passed. `split_pool_steps_resume_to_live` runs the RHEA-style flow (launch pauses after create_pool, 3 `resume_launch` txs to Live). One `launch` transaction settles 3 caballeros at one price, funds the lock, creates and seeds the pool (33 receipts, ~41 Tgas burnt). Then a TWAP-qualified milestone, a 25% claim, wave-1 reveal, a reserved slot on the same terms and the fee split are all checked on the sandbox.
- `web`: `npm test` runs 54 unit tests (incl. 13 for Cabal Corner in `src/lib/corner.test.mjs`: team mix, missions, the bounty/competition reducer, no-passengers scoring, reveal aliasing, knowledge retrieval, the agent and NEP-413 signature checks) (incl. the 10-wallet cap, throttled batches with retry and rate-limit stop, the registrar fallback, and 1/9-caballero quick starts) (incl. `src/lib/testwallet.mjs` storage/faucet/signing guards and the `src/lib/testflow.mjs` quick start on a mock chain) (incl. `src/lib/chart.mjs` candle building): math, transaction builders and gating in `src/lib/actions.mjs`, and the network config and wallet labels in `src/lib/network.mjs`. `npm run test:e2e` builds a testnet-mode site with mocked RPC and a mock injected wallet. It checks the connect modal (including the mainnet-only labels and the click explanation), connecting through the modal, session persistence, launcher-only controls and the exact deposit and launch transactions handed to the wallet. It then builds a mainnet site (no labels, mainnet labels, testnet IDs ignored, no testnet requests) and a build with a placeholder WalletConnect ID (WalletConnect and Unity listed; the relay is blocked in the test), and the price chart (lazy chunk, candle/line toggle, milestone lines, empty state, attribution), and the test wallet (generate via a mocked faucet, wrap, connect through the picker, deposit on the normal page, all signed in-browser and decoded from the RPC request; export/delete/import; absent on mainnet; a batch of 3 with a retried 503, the 429 fallback signing `testnet.create_account`, the 10-wallet cap and the 1–9 caballero picker): 12 steps pass, with no console errors. `npm run test:live` runs the quick start in Chrome against the **real** testnet (passed: launch #4 Live on the RHEA DCL copy), and `npm run test:live:node` does the same from Node (passed: launch #3, plus reveal). It needs Chrome (`CHROME_PATH`). Headless browser run of every page and the full demo flow had no console errors. `npm run test:corner-api` against `wrangler dev` with a local D1 passed (NEP-413 sign-in with a fresh faucet wallet, wrong-recipient and nonce-replay rejected, join/propose/vote, the hidden wallet aliased in a guest's view, bad links and oversized bodies rejected, the record hiding unrevealed work).

## License

MIT, see [LICENSE](LICENSE).
