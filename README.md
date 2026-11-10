# KYP — Know Your Presalers

An optional, invite-only presale layer for NEAR meme launches. Launchers sell a public slice of supply (max 50%) to hand-picked wallets for up to 7 days before launch. Every fill settles at **one price inside the launch transaction**, the tokens go **straight into a lock**, and they unlock only at **public, ambitious market-cap milestones** measured as a TWAP. Presalers are revealed in waves after launch, smallest first.

> **Status: testnet MVP.** Nothing here is deployed to mainnet, and nothing should be without an explicit go-ahead. The site runs in a browser-only demo mode by default.

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
| `scripts` | `build.sh` (wasm), `test.sh` (everything), `deploy-testnet.sh` (not run yet) |

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
./scripts/test.sh                 # all of the above
```

If `openssl-sys` can't find OpenSSL (no `pkg-config`), set `OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu OPENSSL_INCLUDE_DIR=/usr/include`.

### Site modes

- **Demo** (default): a simulated chain in `localStorage` that follows the contract rules. Use the demo invites, launch, move the price, advance time, qualify, claim, reveal. "Reset" restores the seed data.
- **Testnet read**: set `PUBLIC_KYP_COORDINATOR` / `PUBLIC_KYP_LOCK` (see `web/.env.example`) and rebuild. The site reads live state over RPC and shows near-cli-rs commands for every write. There is no wallet connection yet.

### Deploy (not done yet)

- Contracts: `PREFIX=kyp-<name> ./scripts/deploy-testnet.sh` creates faucet-funded **testnet** accounts (keys saved by near-cli-rs to your keychain, never printed) and deploys with the mock pool. `POOL=dcl` targets `dclv2.ref-dev.testnet` instead (unverified).
- Site: `cd web && npm run deploy` → Cloudflare Workers **static assets only** (`web/wrangler.jsonc`: no Worker script, no bindings, no KV/R2/D1). Static asset requests are free on the Workers Paid plan.

## Test results (local)

- `cargo test --workspace`: 51 passed (common 12, token 4, lock 9, coordinator 25, mock-pool 1).
- `integration-tests`: 1 passed. One `launch` transaction settles 3 presalers at one price, funds the lock, creates and seeds the pool (33 receipts, ~41 Tgas burnt). Then a TWAP-qualified milestone, a 25% claim, wave-1 reveal, a reserved slot on the same terms and the fee split are all checked on the sandbox.
- `web`: 6 math tests pass. Headless browser run of every page and the full demo flow had no console errors.
