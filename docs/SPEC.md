# Know Your Cabal

Optional, invite-only presale for NEAR meme launches. Hand-picked wallets buy a public slice of supply up to 7 days before launch. All presale fills settle together, at the same price, in the same transaction that creates the trading pool. Those tokens go straight into a lock. Unlock is by public, ambitious market-cap milestones (e.g. $10m). Caballeros are named in waves after launch (smallest first) and sit in a private advisor group. The launcher can go live as soon as the committed slots are filled, and may keep reserved slots for later names.

This spec is research + product shape only. No MVP is built from it until the plan below is agreed.

---

## 1. JustHoot (as of 10 Nov 2026, Asia/Calcutta)

JustHoot is a live NEAR meme launchpad ([justhoot.fun](https://justhoot.fun/docs)). ~702 tokens, ~$8.0m lifetime volume. A launch creates the NEP-141 token and a RHEA DCL pool in one user transaction. No bonding curve, no graduation.

| Item | Detail |
| --- | --- |
| Supply | 1,000,000,000, 18 decimals, minted once |
| Opening FDV | $5,000 (`initial_fiat_fdv`) |
| Pool | Own pool on `dclv2.ref-labs.near`, 1% fee tier (`token\|quote\|10000`) |
| Launch cost | ~0.04 NEAR + storage (form shows the exact total) |
| First buy | Optional, up to 50% of supply, in the launch tx |
| Transfer tax | Optional, 0–5%, locked at launch; split creator / burn / holders |
| Quote | Usually wNEAR; also USDC and others. Buyers can pay via NEAR Intents |

**How a launch actually works.** The user signs one tx to `v2-launchpad.justhoot.near` (`launch_meme`). The launchpad promise-chains: price the quote in USD, create `{ticker}.v2-launchpad.justhoot.near`, mint remaining supply to `v2-pool-creator.justhoot.near`, mint the first-buy amount to the **creator**, `create_pool` on RHEA, and seed two concentrated LP ranges (token above the start tick, quote below). The first buy is a **mint at a calculated size**, not a post-pool AMM walk. The quote the creator paid is the quote-side liquidity. The launch LP is held by the pool-creator contract, not the creator.

`launch_meme` args seen on-chain: `name`, `symbol`, `icon`, `reference`, `reference_hash`, `quote_token_id`, `dev_buy_quote_max`, `transfer_fee_pips`, `shares` (`token_owner_bps`, `burn_bps`, `holders_bps`). There is **no** lock recipient, presale list, reserved-slot, or market-cap-unlock argument.

**Fees**

- Pool fee: 1% of each trade — 0.2% RHEA, 0.8% JustHoot platform.
- Optional transfer tax (0–5%) on top, on buys, sells, and sends.
- Platform 0.8% is split: 50% buyback-and-burn $HOOT, 15% flywheel (hourly buyback of the top 3 tokens), 15% $HOOT holder rewards in NEAR, 20% team.

**Contracts** (source is unpublished WASM; NearBlocks has methods + ABI on the account):

| Role | Account |
| --- | --- |
| Launchpad | `v2-launchpad.justhoot.near` |
| Pool creator (holds launch LP) | `v2-pool-creator.justhoot.near` |
| RHEA DCL | `dclv2.ref-labs.near` |
| Quote USD oracle | `aggregate-oracle.near` (`get_price_no_older_than`, max age 18,000s / 5h) |
| Intents router | `aa-router.justhoot.near` |
| $HOOT | `hoot-8ecf65.launchpad.justhoot.near` |

**API.** No documented builder SDK or partner hook. Integration surface is the on-chain methods (view + `launch_meme`). The official app also uses a public indexer at `https://api.justhoot.fun` (`/api/stats`, `/api/rooms`, `/api/trades`, `/api/tokens/…`, `/api/pools/…`, `/api/prices/…`, account positions/PnL). Fine for reads and UI; **not** a safe source for on-chain unlocks. Testnet DCL exists at `dclv2.ref-dev.testnet`; JustHoot itself is mainnet-only.

**Why an add-on cannot meet this design without JustHoot changing the contract**

- A NEAR transaction has one receiver. `launch_meme` already is that receiver, so the launcher cannot also call a lock contract in the same tx.
- First-buy tokens are minted to the creator, unlocked.
- Platform fee routing is fixed; Know Your Cabal cannot send the 0.8% to competitions or bounties.
- Same-price multi-wallet settlement, reserved slots, and MC unlocks are not in the ABI.

A later JustHoot partnership (e.g. a `lock_receiver` / presale list on `launch_meme`) would still be valuable for distribution. It is not required to ship Know Your Cabal.

---

## 2. NEAR mechanics for Know Your Cabal

**Coordinator contract (required).** One account is the user's launch-tx receiver, the same pattern JustHoot already uses. In that promise chain it must: settle the presale, mint/transfer the presale slice into the lock, create the RHEA pool, and seed LP. Promises are async; later receipts must fail closed and roll back in callbacks. Do not try to batch `create_pool` and `lock` as two actions on different receivers — NEAR will not allow it.

**Presale settlement (same price).** Do not fill caballeros through the AMM (price would walk). Escrow quote from allowlisted wallets for up to 7 days. At launch, mint a fixed token amount per committed quote at one implied price, send those tokens to the lock, and use presale proceeds (plus any leftover unsold reserved amount, per policy) as quote-side liquidity. This matches JustHoot's first-buy mint, but for many wallets, and the tokens never sit in the launcher's wallet.

**Lock contract.** Official NEAR lockup, NearDeFi `ft-lockup-contract`, Octopus `nep141-token-vesting`, and NearLock are **time-based**. None do market-cap unlocks. Know Your Cabal needs a custom NEP-141 lock: public terms, per-wallet balances, milestone schedule, permissionless `claim` once a milestone is qualified, no admin rescue of locked tokens.

**On-chain market cap — and why spot is not enough**

JustHoot's displayed MC is `pool price × supply`. Price comes from the DCL pool's `current_point` (see RHEA / `@ref-finance/ref-sdk` `getDCLPool` / `pointToPrice`). USD is `quote amount ×` `aggregate-oracle.near` / Pyth-style quote/USD. That is the right *formula* for a public milestone (recommend **FDV = price × (total supply − burned)**; circulating MC is recursive once locks start unlocking).

It is not a safe *trigger* on a thin meme pool:

- Pyth / `aggregate-oracle.near` will not have a feed for a brand-new meme token. They are only for the quote asset (wNEAR, USDC, …).
- RHEA DCL has **no** on-chain TWAP / observation methods. (Classic Ref AMM `v2.ref-finance.near` has `get_pool_twap_info_view`; JustHoot does not use that pool type.)
- Anyone can buy the tick up, hit $10m spot, claim, and dump. Extra LP can also be added and removed. JustHoot's quote oracle itself allows 5h-old prices, which is too stale for an unlock.
- The official indexer MC is off-chain and must not gate claims.

**Recommended trigger:** a pokeable TWAP inside the lock (or a sibling observer). Anyone can `record` `(timestamp, current_point, liquidity)` from `dclv2…get_pool`. A milestone qualifies only if a time-weighted average over a public window (starting point: 30–60 minutes, final values TBD) stays at or above the target, with a minimum liquidity, a minimum number of observations, a short delay before claim, and a fresh quote/USD (minutes, not hours). Spell FDV vs circulating in the public terms. Still not perfect (TWAP can be pushed with sustained flow, and DCL points can be noisy), but it removes one-block spoofing.

Testnet only until explicitly approved: coordinator, lock, token factory against `dclv2.ref-dev.testnet` and testnet oracles. Private repos. No mainnet deploys, no funded mainnet txs, no secrets in logs.

---

## 3. Recommendation: standalone first

**Ship Know Your Cabal as its own launch coordinator + lock + UI, and list the token on RHEA DCL** (same venue JustHoot uses, so DexScreener / existing NEAR wallets still work). Treat a JustHoot add-on as an optional later partnership, not the MVP path.

Reasons, in line with the note that standalone may be easier:

1. Same-tx lock, same-price multi-wallet settle, reserved slots, and MC unlocks need a coordinator we control. JustHoot's ABI cannot do this today, and its source is closed.
2. Fee routing (holders, extra LP, meme competitions, bounties) needs either a transfer tax we configure or fees from an LP position we own. We cannot redirect JustHoot's 0.8%.
3. RHEA's `create_pool` / add-liquidity path is already public; we do not need JustHoot to get a tradable pool.
4. An add-on later still makes sense for distribution, if they add a lock/presale hook. Do not block the MVP on that conversation.

The private advisor group and the post-launch reveal waves are off-chain product (e.g. Telegram + a public page driven by on-chain balances). They do not change the contract split.

---

## 4. Open decisions

1. Presale cap (JustHoot first-buy max is 50% — keep, lower?). Min/max per wallet. Payment asset (wNEAR only vs USDC too).
2. Unlock schedule: which MC targets, what % at each, any time floor in addition to MC.
3. TWAP window, min liquidity, observation count, claim delay, quote-oracle max age.
4. FDV (recommended) vs circulating MC in the public terms.
5. At sale time, are wallet addresses public, or only hashed until the post-launch reveal waves? (Terms + size are public either way.) Identities vs addresses.
6. Unsold reserved slots after launch: stay reserved for named wallets on the same lock terms, return to the pool, or go to a treasury?
7. Fee split percentages for holders / LP / competitions / bounties; transfer tax vs LP-fee claims.
8. Token defaults: match JustHoot (1B, 18 decimals, ~$5k open) or make them configurable?
9. Compliance: invite-only sale to named wallets may have securities / promo constraints by jurisdiction. Who is allowed to launch, and what is disclosed?
10. If JustHoot later offers a hook, do we add a “launch via JustHoot” path or stay standalone only?

---

## 5. Rules for any later build

Private repos. Testnet only. No mainnet. No spending, posting, or messaging. Never print keys or seed phrases.
