# Know Your Cabal — proposed plan (no build yet)

Research is in [SPEC.md](./SPEC.md). Recommendation: **standalone coordinator + lock + UI**, with the trading pool on RHEA DCL. A JustHoot add-on would need their team to change `launch_meme`; do not wait on that for an MVP.

## If this plan is approved, next (testnet only)

1. **Lock the open decisions** in SPEC §4 — especially presale cap, unlock milestones, TWAP rules, what is public at sale time, and unsold reserved slots. Everything else can default to JustHoot-like (1B supply, 18 decimals, ~$5k open, wNEAR quote).
2. **Testnet contracts, private repo:** presale escrow, launch coordinator, market-cap lock (custom; existing NEAR lockups are time-based only), NEP-141 token factory. Wire pool creation to `dclv2.ref-dev.testnet`. One user transaction settles all presale fills at one price, sends tokens to the lock, and opens the pool.
3. **TWAP observer** on the lock: record DCL `current_point` + liquidity; qualify milestones only after the public window, not on spot.
4. **Thin UI:** launcher allowlist + terms, presale deposit, launch button, public terms/milestones page, post-launch reveal waves (smallest first), claim at a qualified milestone.
5. **Hold for later:** JustHoot partnership hook, competitions/bounties fee routing beyond a simple on-chain split, advisor group tooling (start with a private chat).

No mainnet deploys, no funded mainnet transactions, no posting or messaging, private repos, never print keys.

Please say which open decisions you want to set now, and whether this standalone testnet plan is the one to build.
