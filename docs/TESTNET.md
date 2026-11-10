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

## Real RHEA DCL (`dclv2.ref-dev.testnet`, v2.3.14) — blocked at pool deposit

A second, separate instance points at the real testnet DCL: coordinator `kyp-sushmit-dcl.testnet`, lock `kyp-sushmit-dcl-lock.testnet` (`PREFIX=kyp-sushmit-dcl POOL=dcl ./scripts/deploy-testnet.sh`). It is **not** used by the site.

Verified against the real contract:
- `storage_deposit`: minimum is **0.5 NEAR** (`storage_balance_bounds`). Config now uses 0.5 NEAR for DCL.
- `add_liquidity` **does not accept an attached deposit**, so `liquidity_deposit` must be 0 for DCL (config now does this).
- Token deposits use `ft_transfer_call` with msg `"Deposit"` (`TokenReceiverMessage::Deposit`); an empty msg is not a deposit. Config now sets `pool_deposit_msg` to `"Deposit"` for DCL.
- `create_pool` from the coordinator inside the launch tx **works**: pool `smk1-1.kyp-sushmit-dcl.testnet|wrap.testnet|10000` was created at the presale price (point −39200, 1% tier). No pool whitelist was needed.
- `get_pool` JSON matches what the lock reads: `record` on the lock observed the real pool ([DqSV…](https://testnet.nearblocks.io/txns/DqSVjn5mWBzPKCTN9DuXCofXX5Z2QMiAEbWnDpbTL5XK)).
- Settle + lock in the same tx also worked (125M SMK1 into `kyp-sushmit-dcl-lock.testnet`).

Blocker: on this testnet contract a plain `"Deposit"` via `ft_on_transfer` burns **~920 Tgas** — measured from a plain wallet with a 1 PGas tx ([7Lin…](https://testnet.nearblocks.io/txns/7Lini8VhaTqCyE4kVC1TSG2q44zBVatH9RWSdJRzp1eF)), and the same for an unrelated third-party deposit ([DzuU…](https://testnet.nearblocks.io/txns/DzuU4cfk7Jtd4bKgMoMyVBL69urUKWJr79uMos3oKBbc)). Swaps on the same contract cost ~18 Tgas, so it looks specific to the testnet deployment's deposit path. KYP gives each pool deposit 50 Tgas, so the launch halted at `pool_deposit` ([launch tx 8j5f…](https://testnet.nearblocks.io/txns/8j5fBGmi2mpv478CMKocSiqieCWqmxpaT5PAxpnyFaak)); the DCL refunded both tokens to the coordinator. Two ~920 Tgas deposits can't fit in one 1 PGas tx, so seeding a real testnet DCL pool would need the deposits split across separate resume txs with gas set per step — a coordinator code change, not done. Mainnet `dclv2.ref-labs.near` deposit gas is unmeasured.

State left on the DCL instance: launch #1 is `Launching` (pool created, presale tokens locked, 875M SMK1 + 2.5 wNEAR held by the coordinator). Test wallet `kyp-sushmit-a1.testnet` holds 0.1 wNEAR as an internal DCL deposit from the gas measurement.
