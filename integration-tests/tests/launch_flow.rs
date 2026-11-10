//! End-to-end on a local NEAR sandbox: create launch -> presale deposits -> ONE launch tx
//! (settle at one price, fund lock, create + seed pool) -> TWAP milestone -> claim ->
//! reveal waves -> reserved slot on the same lock terms.
//!
//! Run `../scripts/build.sh` first (needs res/*.wasm).

use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const SUPPLY: u128 = 1_000_000_000 * 1_000_000_000_000_000_000;

fn wasm(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/../res/{}.wasm", env!("CARGO_MANIFEST_DIR"), name))
        .unwrap_or_else(|_| panic!("missing res/{name}.wasm; run scripts/build.sh"))
}

fn slot_hash(account: &str, salt: &str) -> String {
    hex::encode(Sha256::digest(format!("{account}:{salt}").as_bytes()))
}

fn u(v: &Value) -> u128 {
    v.as_str().unwrap().parse().unwrap()
}

async fn ft_balance(token: &Contract, who: &str) -> anyhow::Result<u128> {
    let v: Value = token.view("ft_balance_of").args_json(json!({"account_id": who})).await?.json()?;
    Ok(u(&v))
}

async fn now_sec(worker: &Worker<near_workspaces::network::Sandbox>) -> anyhow::Result<u64> {
    Ok(worker.view_block().await?.timestamp() / 1_000_000_000)
}

async fn deposit(wrap: &Contract, who: &Account, coord: &Contract, amount: u128, msg: Value) -> anyhow::Result<()> {
    let r = who
        .call(wrap.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": coord.id(), "amount": amount.to_string(), "msg": msg.to_string()}))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?;
    assert!(r.is_success(), "deposit failed: {:?}", r.failures());
    Ok(())
}

#[tokio::test]
async fn full_launch_flow() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;

    let mk = |name: &'static str, near: u128| {
        let root = root.clone();
        async move {
            root.create_subaccount(name)
                .initial_balance(NearToken::from_near(near))
                .transact()
                .await
                .map(|r| r.into_result().unwrap())
        }
    };
    let launcher = mk("launcher", 50).await?;
    let alice = mk("alice", 10).await?;
    let bob = mk("bob", 10).await?;
    let carol = mk("carol", 10).await?;
    let whale = mk("whale", 10).await?;
    let holders = mk("holders", 2).await?;
    let lpacct = mk("lpfund", 2).await?;
    let bounties = mk("bounties", 2).await?;

    // contracts
    let coord_acc = mk("kyp", 60).await?;
    let lock_acc = mk("lock", 20).await?;
    let pool_acc = mk("pool", 20).await?;
    let wrap_acc = mk("wrap", 20).await?;
    let coord = coord_acc.deploy(&wasm("kyp_coordinator")).await?.into_result()?;
    let lock = lock_acc.deploy(&wasm("kyp_lock")).await?.into_result()?;
    let pool = pool_acc.deploy(&wasm("kyp_mock_pool")).await?.into_result()?;
    let wrap = wrap_acc.deploy(&wasm("kyp_token")).await?.into_result()?; // stand-in for wrap.testnet (24 decimals)

    let everyone: Vec<String> = [&launcher, &alice, &bob, &carol, &whale, &holders, &lpacct, &bounties, &coord_acc, &lock_acc, &pool_acc]
        .iter()
        .map(|a| a.id().to_string())
        .collect();
    wrap.call("new")
        .args_json(json!({
            "owner_id": root.id(),
            "total_supply": (1_000_000 * NEAR).to_string(),
            "metadata": {"spec": "ft-1.0.0", "name": "Wrapped NEAR (test)", "symbol": "wNEAR", "decimals": 24},
            "register": everyone,
            "auto_register_senders": []
        }))
        .transact()
        .await?
        .into_result()?;
    for a in [&alice, &bob, &carol, &whale] {
        root.call(wrap.id(), "ft_transfer")
            .args_json(json!({"receiver_id": a.id(), "amount": (200 * NEAR).to_string()}))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?
            .into_result()?;
    }
    lock.call("new").args_json(json!({"coordinator": coord.id()})).transact().await?.into_result()?;
    pool.call("new").args_json(json!({"owner_id": root.id()})).transact().await?.into_result()?;
    coord
        .call("new")
        .args_json(json!({
            "owner_id": coord.id(),
            "config": {
                "lock_contract": lock.id(),
                "pool_contract": pool.id(),
                "pool_fee": 10000,
                "point_delta": 200,
                "allowed_quote_tokens": [wrap.id()],
                "max_presale_cap_bps": 5000,
                "token_account_deposit": NearToken::from_millinear(2500),
                "pool_storage_deposit": NearToken::from_millinear(100),
                "pool_create_deposit": NearToken::from_millinear(100),
                "liquidity_deposit": NearToken::from_millinear(50),
                "pool_deposit_msg": ""
            }
        }))
        .transact()
        .await?
        .into_result()?;
    coord.call("set_token_code").args(wasm("kyp_token")).gas(Gas::from_tgas(100)).transact().await?.into_result()?;

    // ---------------------------------------------------------------- create launch
    let t0 = now_sec(&worker).await?;
    let params = json!({
        "name": "Owl Meme", "symbol": "OWL", "icon": null, "description": "Diamond-handed owls.",
        "terms_uri": null,
        "quote_token_id": wrap.id(),
        "total_supply": null, "decimals": null,
        "opening_fdv_quote": (2_500 * NEAR).to_string(),
        "presale_cap_bps": 2000,
        "min_raise": (10 * NEAR).to_string(),
        "wallet_min": NEAR.to_string(),
        "wallet_max": (100 * NEAR).to_string(),
        "allowlist": [slot_hash(alice.id().as_str(), "salt-a"), slot_hash(bob.id().as_str(), "salt-b"), slot_hash(carol.id().as_str(), "salt-c")],
        "reserved": [{"hash": slot_hash(whale.id().as_str(), "salt-w"), "quote_amount": (50 * NEAR).to_string()}],
        "sale_start": t0, "sale_end": t0 + 3 * 86_400,
        "milestones": [
            {"target_fdv_quote": (10_000 * NEAR).to_string(), "unlock_bps": 2500},
            {"target_fdv_quote": (1_000_000 * NEAR).to_string(), "unlock_bps": 7500}
        ],
        "twap": {"window_sec": 60, "min_observations": 3, "min_liquidity": "1", "claim_delay_sec": 5, "min_obs_interval_sec": 2},
        "reveal": {"waves": 3, "interval_sec": 60},
        "fee_split": {"holders_bps": 5000, "liquidity_bps": 3000, "community_bps": 2000,
            "holders_account": holders.id(), "liquidity_account": lpacct.id(), "community_account": bounties.id()}
    });
    let r = launcher
        .call(coord.id(), "create_launch")
        .args_json(json!({"params": params}))
        .deposit(NearToken::from_millinear(2600))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    assert!(r.is_success(), "create_launch failed: {:?}", r.failures());
    let v: Value = coord.view("get_launch").args_json(json!({"launch_id": 1})).await?.json()?;
    assert_eq!(v["status"], "Open");
    let token_id = v["token_id"].as_str().unwrap().to_string();
    assert_eq!(token_id, format!("owl-1.{}", coord.id()));
    let token = Contract::from_secret_key(token_id.parse()?, coord_acc.secret_key().clone(), &worker);
    assert_eq!(ft_balance(&token, coord.id().as_str()).await?, SUPPLY);

    // ---------------------------------------------------------------- presale
    deposit(&wrap, &alice, &coord, 10 * NEAR, json!({"Deposit": {"launch_id": 1, "salt": "salt-a"}})).await?;
    deposit(&wrap, &bob, &coord, 150 * NEAR, json!({"Deposit": {"launch_id": 1, "salt": "salt-b"}})).await?; // 50 refunded
    deposit(&wrap, &carol, &coord, 40 * NEAR, json!({"Deposit": {"launch_id": 1, "salt": "salt-c"}})).await?;
    assert_eq!(ft_balance(&wrap, bob.id().as_str()).await?, 100 * NEAR);
    // wrong salt is refunded in full by the token
    deposit(&wrap, &carol, &coord, 5 * NEAR, json!({"Deposit": {"launch_id": 1, "salt": "bad"}})).await.ok();
    let v: Value = coord.view("get_launch").args_json(json!({"launch_id": 1})).await?.json()?;
    assert_eq!(u(&v["total_raised"]), 150 * NEAR);

    // ---------------------------------------------------------------- launch: ONE tx
    let r = launcher
        .call(coord.id(), "launch")
        .args_json(json!({"launch_id": 1}))
        .deposit(NearToken::from_near(1))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    println!("launch tx: success={} burnt={} Tgas receipts={}", r.is_success(), r.total_gas_burnt.as_tgas(), r.receipt_outcomes().len());
    for f in r.failures() {
        println!("failure: {:?}", f);
    }
    for l in r.logs() {
        if l.contains("launch_step_failed") {
            println!("{l}");
        }
    }
    let v: Value = coord.view("get_launch").args_json(json!({"launch_id": 1})).await?.json()?;
    println!("progress: {}", v["progress"]);
    assert_eq!(v["status"], "Live", "launch must go live in one transaction");
    let presale_tokens = u(&v["presale_tokens"]);
    assert_eq!(presale_tokens, SUPPLY * 6 / 100, "150 wNEAR at 2,500 wNEAR FDV = 6%");

    // lock holds every presale token, positions at one price
    assert_eq!(ft_balance(&token, lock.id().as_str()).await?, presale_tokens);
    let pos: Value = lock.view("get_position").args_json(json!({"launch_id": 1, "account_id": alice.id()})).await?.json()?;
    let alice_total = u(&pos["total"]);
    assert_eq!(alice_total, SUPPLY * 10 / 2_500);
    // presale tokens never touched presaler or launcher wallets
    assert_eq!(ft_balance(&token, alice.id().as_str()).await?, 0);
    assert_eq!(ft_balance(&token, launcher.id().as_str()).await?, 0);
    // pool seeded with the rest of supply (minus reserved) and all proceeds
    let pool_id = v["pool_id"].as_str().unwrap().to_string();
    let pv: Value = pool.view("get_pool").args_json(json!({"pool_id": pool_id})).await?.json()?;
    assert_eq!(pv["current_point"], v["init_point"]);
    assert_eq!(ft_balance(&token, pool.id().as_str()).await?, u(&v["lp_tokens"]));
    assert_eq!(ft_balance(&wrap, pool.id().as_str()).await?, 150 * NEAR);
    // coordinator keeps only the reserved-slot tokens
    assert_eq!(ft_balance(&token, coord.id().as_str()).await?, SUPPLY * 2 / 100);

    // ---------------------------------------------------------------- milestone via TWAP
    // Simulate trading: price to ~40k wNEAR FDV (16x), above milestone 1 (10k) but below 2 (1m).
    let init_point = v["init_point"].as_i64().unwrap();
    let high = init_point + 27_800; // 1.0001^27800 ~ 16x
    root.call(pool.id(), "mock_set_point").args_json(json!({"pool_id": pool_id, "point": high})).transact().await?.into_result()?;
    let poke = |w: &Account| {
        let w = w.clone();
        let lock_id = lock.id().clone();
        async move {
            w.call(&lock_id, "record").args_json(json!({"launch_id": 1})).gas(Gas::from_tgas(60)).transact().await
        }
    };
    // spot alone must not unlock
    poke(&carol).await?.into_result()?;
    let q = carol.call(lock.id(), "qualify").args_json(json!({"launch_id": 1})).transact().await?;
    assert!(q.is_failure(), "qualify must fail without a full TWAP window");
    assert!(format!("{:?}", q.failures()).contains("no observation at or before window start"), "panic message should surface");
    for _ in 0..14 {
        worker.fast_forward(15).await?;
        poke(&carol).await?.into_result()?;
    }
    let st: Value = lock.view("twap_status").args_json(json!({"launch_id": 1})).await?.json()?;
    println!("twap_status: {st}");
    let obs: Value = lock.view("get_observations").args_json(json!({"launch_id": 1})).await?.json()?;
    println!("observation ts: {:?} now={}", obs.as_array().unwrap().iter().map(|o| o["ts"].as_u64().unwrap()).collect::<Vec<_>>(), now_sec(&worker).await?);
    let q = carol.call(lock.id(), "qualify").args_json(json!({"launch_id": 1})).transact().await?;
    assert!(q.is_success(), "qualify failed: {:?}", q.failures());
    let lv: Value = lock.view("get_lock").args_json(json!({"launch_id": 1})).await?.json()?;
    assert!(lv["milestones"][0]["qualified_at"].is_number());
    assert!(lv["milestones"][1]["qualified_at"].is_null());

    worker.fast_forward(30).await?;
    let c = alice.call(lock.id(), "claim").args_json(json!({"launch_id": 1})).gas(Gas::from_tgas(60)).transact().await?;
    assert!(c.is_success(), "claim failed: {:?}", c.failures());
    assert_eq!(ft_balance(&token, alice.id().as_str()).await?, alice_total / 4);
    // second claim: nothing more until milestone 2
    let c2 = alice.call(lock.id(), "claim").args_json(json!({"launch_id": 1})).gas(Gas::from_tgas(60)).transact().await?;
    assert!(c2.is_failure());

    // ---------------------------------------------------------------- reveal waves
    let ps: Value = coord.view("get_presalers").args_json(json!({"launch_id": 1})).await?.json()?;
    assert!(ps.as_array().unwrap().iter().all(|p| p["account_id"].is_null()));
    worker.fast_forward(250).await?;
    let r = carol.call(coord.id(), "reveal_next_wave").args_json(json!({"launch_id": 1})).transact().await?;
    assert!(r.is_success(), "reveal failed: {:?}", r.failures());
    let ps: Value = coord.view("get_presalers").args_json(json!({"launch_id": 1})).await?.json()?;
    assert_eq!(ps[0]["account_id"], alice.id().as_str(), "smallest presaler revealed first");
    assert!(ps[1]["account_id"].is_null());

    // ---------------------------------------------------------------- reserved slot after launch
    deposit(&wrap, &whale, &coord, 60 * NEAR, json!({"BuyReserved": {"launch_id": 1, "salt": "salt-w"}})).await?;
    assert_eq!(ft_balance(&wrap, whale.id().as_str()).await?, 150 * NEAR, "excess 10 refunded");
    let pos: Value = lock.view("get_position").args_json(json!({"launch_id": 1, "account_id": whale.id()})).await?.json()?;
    assert_eq!(u(&pos["total"]), SUPPLY * 2 / 100);
    assert_eq!(ft_balance(&token, coord.id().as_str()).await?, 0);
    // whale's position follows the same milestones: 25% claimable already
    let cl: Value = lock.view("claimable").args_json(json!({"launch_id": 1, "account_id": whale.id()})).await?.json()?;
    assert_eq!(u(&cl), SUPPLY * 2 / 100 / 4);

    // ---------------------------------------------------------------- fee routing
    let r = carol
        .call(coord.id(), "distribute_fees")
        .args_json(json!({"launch_id": 1, "token_id": wrap.id()}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(r.is_success(), "distribute failed: {:?}", r.failures());
    assert_eq!(ft_balance(&wrap, holders.id().as_str()).await?, 25 * NEAR);
    assert_eq!(ft_balance(&wrap, lpacct.id().as_str()).await?, 15 * NEAR);
    assert_eq!(ft_balance(&wrap, bounties.id().as_str()).await?, 10 * NEAR);
    Ok(())
}
