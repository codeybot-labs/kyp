# KYP on NEAR testnet

Deployed 2026-11-10 (IST) with `scripts/deploy-testnet.sh` using free faucet accounts only. Testnet only: no mainnet accounts, no real funds. Keys live in `~/.near-credentials` on the deploy machine and are never committed or printed.

## Live deployment (mock pool) — used by the site

| Role | Account | Explorer |
| --- | --- | --- |
| Coordinator + escrow | `kyp-sushmit.testnet` | [https://testnet.nearblocks.io/address/kyp-sushmit.testnet](https://testnet.nearblocks.io/address/kyp-sushmit.testnet) |
| Market-cap lock | `kyp-sushmit-lock.testnet` | [https://testnet.nearblocks.io/address/kyp-sushmit-lock.testnet](https://testnet.nearblocks.io/address/kyp-sushmit-lock.testnet) |
| Pool (**mock** RHEA DCL) | `kyp-sushmit-pool.testnet` | [https://testnet.nearblocks.io/address/kyp-sushmit-pool.testnet](https://testnet.nearblocks.io/address/kyp-sushmit-pool.testnet) |
| Launch token #1 ($SMK1, deployed by the coordinator) | `smk1-1.kyp-sushmit.testnet` | [https://testnet.nearblocks.io/address/smk1-1.kyp-sushmit.testnet](https://testnet.nearblocks.io/address/smk1-1.kyp-sushmit.testnet) |
| Quote token (real) | `wrap.testnet` | |

Config: 1% fee tier (`pool_fee` 10000, `point_delta` 200), wNEAR only, presale cap max 50%.

Deploy txs: [deploy lock](https://testnet.nearblocks.io/txns/J9fSiH76ayuwBFbKJLQp3Bk4RtQ37TR73dLoUJSk4KgP), [deploy mock pool](https://testnet.nearblocks.io/txns/Ehjm73YQi1CUoTFuULWnv3gdGWmiDad7MYgtnxrjZMst), [deploy coordinator](https://testnet.nearblocks.io/txns/5VPfQ8QTHWefZosUaJyHJRiiCAQDGPGKqoqMJwEbeBMv), [set_token_code](https://testnet.nearblocks.io/txns/Bw3YWGsEeWjhMQPdBpPQQdwgohvqAa5Z9tC7AHfVwmne), wNEAR registration [coordinator](https://testnet.nearblocks.io/txns/4462ABEqH13Q3VaiDJDwrEeb8CqtXYN1stY8aeoHy444) / [pool](https://testnet.nearblocks.io/txns/7YodsNLvsKdCWcbZf4RumzR2YU41pJfG5pBdTPmQ31Zf).

## Smoke test (launch #1, mock pool) — passed

`PREFIX=kyp-sushmit RUN=1 ./scripts/smoke-testnet.sh`. Test wallets (faucet): launcher `kyp-sushmit-l1.testnet`, presalers `kyp-sushmit-a1.testnet` and `kyp-sushmit-b1.testnet`.

| Step | Result | Tx |
| --- | --- | --- |
| create_launch ($SMK1, opening FDV 20 wNEAR, 20% cap, milestones 40 wNEAR → 25%, 2,000 wNEAR → 75%) | Open, token deployed | [J6r9…](https://testnet.nearblocks.io/txns/J6r9LVBiTi1ixnvegDpLEmjY1femoJ3Jn3QGPbA6UoaE) |
| Presaler A deposits 1 wNEAR | accepted | [96uE…](https://testnet.nearblocks.io/txns/96uE7F5JsAPS29bNBaPjBxSqu59XM94Kob5iYHUatdvJ) |
| Presaler B deposits 1.5 wNEAR | accepted | [EEkA…](https://testnet.nearblocks.io/txns/EEkAacqdcHZVPnWQUBKJaZ8pf8kK7uPrAKxXVgzkSSLD) |
| launch (one tx: settle at one price, fund lock, create pool, deposit, add liquidity) | Live; 34 receipts, ~42.6 Tgas burnt, no failures | [D9Q3…](https://testnet.nearblocks.io/txns/D9Q3nVEfzUuK81sUKUSwo9joQNe3gQhUBVZx3VjbyakS) |
| Lock balance | 125,000,000 SMK1 (12.5% = 2.5 / 20) held by the lock; A 50M, B 75M; presaler wallets 0 | view |
| mock_set_point (~3× price, simulated trading) | ok | [45bM…](https://testnet.nearblocks.io/txns/45bMaAuVM4W2LtTC2HGM3WUfxmE3Kwj2ygnWdggwdVkn) |
| record × 8 (permissionless TWAP pokes) | 8 observations | e.g. [J7Ey…](https://testnet.nearblocks.io/txns/J7EyfE7PzaqGQNRut2UwfFHT8QToEVCa9FsGvwPvoyyD), [Df1B…](https://testnet.nearblocks.io/txns/Df1BJmQ32Cz2sH9SYQPFSYdUNk86gjQtuddGnGhe3yuX) |
| twap_status | ok, 4 obs in window, TWAP FDV ≈ 59.6 wNEAR | view |
| qualify | milestone 1 qualified, milestone 2 not | [91q7…](https://testnet.nearblocks.io/txns/91q7PquN7chQnHQJyXtcz7V48Ehnj5BTqy2ybfDu9SFh) |
| claim (A, after 30 s claim delay) | 12,500,000 SMK1 (25%) received | [BaeH…](https://testnet.nearblocks.io/txns/BaeHb83XRRsRfhY1992ncgquiGCD9c9e8UcyCxqQ3wn) |
| reveal_next_wave | wave 1 revealed A (smallest first); B still hidden | [ELu8…](https://testnet.nearblocks.io/txns/ELu8nbVMoQd1owqqzATNeAacQHoAyCg2ZaWMz7dxHcM2) |

Not exercised on testnet: reserved slots, fee distribution, refunds/withdraw (all covered in the sandbox integration test).

## Real RHEA DCL (`dclv2.ref-dev.testnet`, v2.3.14): working

A second, separate instance points at the real testnet DCL: coordinator `kyp-sushmit-dcl.testnet` ([explorer](https://testnet.nearblocks.io/address/kyp-sushmit-dcl.testnet)) and lock `kyp-sushmit-dcl-lock.testnet` ([explorer](https://testnet.nearblocks.io/address/kyp-sushmit-dcl-lock.testnet)). It was created with `PREFIX=kyp-sushmit-dcl POOL=dcl ./scripts/deploy-testnet.sh`. The site does not use it; it still reads the mock instance.

### What the DCL needs (checked against the live contract)
- `storage_deposit`: minimum is **0.5 NEAR**.
- `add_liquidity` takes **no attached deposit** (`liquidity_deposit` = 0).
- Token deposits are `ft_transfer_call` with msg `"Deposit"`.
- `create_pool` works from the coordinator inside the `launch` tx, with no pool whitelist.
- `get_pool` JSON matches what the lock reads.
- Points: `right_point` must be **< 800000** and `right - left` **< 800000** (otherwise `E202: illegal point`). The coordinator now clamps both ranges (token range `init+200 … 760800` at `init = -39200`).
- **Gas: one `"Deposit"` burns ~920.8 Tgas on this testnet contract**, for any token, any sender. Swaps cost ~18 Tgas.

### Coordinator change (2026-11-11): split pool steps
- New owner setting `set_step_gas({split_pool_steps, pool_deposit_tgas, add_liquidity_tgas})` / view `get_step_gas`. It is stored under its own storage key, so existing coordinators were upgraded in place with no state migration.
  - Default `{false, 50, 25}` is the original flow: the mock launch still completes in one tx.
  - DCL instance: `{true, 965, 100}`.
- In split mode:
  - The two pool deposits run one per step (token, then wNEAR), and the two `add_liquidity` ranges also run one per step.
  - Before each step the coordinator checks the remaining gas. If the step doesn't fit, it emits `launch_paused {step, need_tgas}` and stops cleanly, keeping all progress.
  - `resume_launch` (anyone, up to 1000 Tgas) continues from there.
- Settlement at one price, lock funding and pool creation still happen in the `launch` tx itself.
- DCL launch = `launch` (≈23 Tgas) + `resume_launch` ×3: token deposit (~931 Tgas), wNEAR deposit (~931 Tgas), both ranges (≈39 Tgas).
- Tests: 5 new coordinator unit tests (setter/bounds, pause/resume to Live, one re-credited deposit per failed range, DCL point rules). New sandbox test `split_pool_steps_resume_to_live` checks launch → pause → 3 resumes → Live on the mock. All 57 unit + 2 sandbox tests pass.
- Upgrade txs: [DCL coordinator](https://testnet.nearblocks.io/txns/4RBSUSQ18K4gxjp3GPwP9edBRpUBkdAxeMcPEExCwmJY), [mock coordinator](https://testnet.nearblocks.io/txns/AbCfaG9NwrtBrXV9SHCfgwYEhoqahHd6ww5sKzX8pDCt), [set_step_gas](https://testnet.nearblocks.io/txns/DiBg8dpSZGpuC7CsETFivSS8AWq38K5PQXWRiAdc9yVp). The mock coordinator keeps the defaults.

### Fresh launch #2 on the real DCL: passed
Run with `PREFIX=kyp-sushmit-dcl POOLMODE=dcl WALLETS=kyp-sushmit RUN=2 ./scripts/smoke-testnet.sh`. Faucet wallets: `kyp-sushmit-l2`, `-a2`, `-b2` (`.testnet`).

| Step | Result | Tx |
| --- | --- | --- |
| create_launch ($SMK2, same terms as #1) | Open | [GHXJ…](https://testnet.nearblocks.io/txns/GHXJ7LRjozk4KQVSNgWnUvTpxJT5ReJnkjTTodXHXKCc) |
| deposits 1 + 1.5 wNEAR | accepted | [7Epn…](https://testnet.nearblocks.io/txns/7EpnbudF6ssQTwNudkV1oXHgWkX9tVkoMB9mfnNtiBp1), [5SwK…](https://testnet.nearblocks.io/txns/5SwkdSfMnSGakkLxmVDLFm8r88RL6iRbbZLWhyKjHWmT) |
| launch: settle at one price, 125M SMK2 into the lock, real pool `smk2-2.kyp-sushmit-dcl.testnet\|wrap.testnet\|10000` created at point −39200, then `launch_paused` | ok | [Gq4e…](https://testnet.nearblocks.io/txns/Gq4efKMYBmQ2cQK2YCMeUVSfcEcooXTPnztgrmQGbRLJ) |
| resume 1: 875M SMK2 deposited into the DCL | ok (931 Tgas) | [Bicv…](https://testnet.nearblocks.io/txns/BicvyLr7HXPobHsm3L4Y3w9LKo9TeuUHirhFhoeswgVf) |
| resume 2: 2.5 wNEAR deposited | ok | [BSyK…](https://testnet.nearblocks.io/txns/BSyKVLYF52cWbVGio949EQ7cLLF73M52Lg3KHqPbSw2f) |
| resume 3: both ranges added (LPT `#2574`, `#2575`), **Live** | ok | [4CnM…](https://testnet.nearblocks.io/txns/4CnMJxWPgx1TEiDxZbf1JA6y48iibU7Na7buoks9PyBx) |
| DCL `get_pool` | `total_x` 874,999,999.9 SMK2, `total_y` 2.5 wNEAR, state Running | view |
| lock `record` on the real pool | ok | [9Gfx…](https://testnet.nearblocks.io/txns/9GfxTp7s5EEGvad9SygExJ62pPrqnGwwv7PTJ4DMTqub) |
| real swap: 0.2 wNEAR → 9.67M SMK2 (presaler A) | price moved −39200 → −38778 | [GBAk…](https://testnet.nearblocks.io/txns/GBAkv4CAVi3E3bjpYMJgLBMFTWCzLVVqmzHWVcuhVfFs) |
| `record` ×9 more, then `twap_status` | ok: 4 obs in window, TWAP point −38778, FDV ≈ 20.7 wNEAR | e.g. [dpeQ…](https://testnet.nearblocks.io/txns/dpeQpxLKa4Rffi5WVA5oVXYB7j4PHEkjf3o2YkkbNfA) |

Note: at the opening price the active liquidity is 0. The token range starts one point-delta above the price and the wNEAR range ends at it. So `twap_status` reports `pool liquidity below minimum` until the first trade, and observations taken before that trade count against the window.

### Stuck launch #1 on the DCL instance: recovered
After the upgrade + `set_step_gas`:
- [resume: token deposit](https://testnet.nearblocks.io/txns/Hj3N9ZK65tXMXcF54QSPh4cwwnzxYQjpGq8YUrFDMYoT)
- [resume: wNEAR deposit](https://testnet.nearblocks.io/txns/EvPYFNqHF5Ci5sww8AxboC25m3nsMKmcmWnnVZEREEUk)
- [resume: add_liquidity, which failed with E202](https://testnet.nearblocks.io/txns/8qSjNncgCBqVCEMnpkpWEqN9kqstLmuRRjUDXc9c3yrj). This found the point rule. The failure was handled: halted, nothing lost.
- After the range fix: [resume: both ranges, Live](https://testnet.nearblocks.io/txns/BvAPTe564McHrX57Sh3FRFcAgyAuBdCF9Sdrf4E8rQhi). LPTs `#2572`, `#2573`.

Leftovers:
- The DCL refunded ~1e8 yocto-SMK dust to the coordinator per launch (rounding).
- Test wallet `kyp-sushmit-a1.testnet` still has a 0.1 wNEAR internal DCL deposit from the earlier gas measurement ([7Lin…](https://testnet.nearblocks.io/txns/7Lini8VhaTqCyE4kVC1TSG2q44zBVatH9RWSdJRzp1eF)).
- Mainnet `dclv2.ref-labs.near` deposit gas is still unmeasured.

## Price chart data sources

Checked 2026-11-11 (IST).

| Source | Network | Status | Used |
| --- | --- | --- | --- |
| Lock `get_observations` / `get_lock` (via RPC) | testnet + mainnet | on-chain, free | **yes**, primary |
| Pool `get_pool.current_point` (RHEA DCL or mock, via RPC) | testnet + mainnet | on-chain, free | **yes**, live last point |
| `testnet-indexer.ref-finance.com`, `dev-indexer.ref-finance.com`, `indexer.rhea.finance` | testnet | DNS does not resolve | no |
| `api.ref.finance` / `api.rhea.finance` (`list-token-price`, `get-dcl-points`, `get-dcl-pools-volume`, `get-pool`) | mainnet | 200, CORS `*` | no. Prices, liquidity distribution and volume only; no candle or swap-history endpoint found |
| `api.justhoot.fun` `/api/trades?limit=` (fields: `pool_id`, `side`, `price` in wNEAR, `price_usd`, `timestamp`), `/api/prices/latest` | mainnet | 200, CORS `*` | no. A global feed of JustHoot launchpad trades; no per-token filter found (`token`, `token_id`, `pool_id` params are ignored) and KYP tokens aren't indexed there |

So candles are built from `record` observations. More frequent pokes give finer candles. On mainnet, a per-pool swap history would need an indexer (or the JustHoot feed, if they add a token filter).
