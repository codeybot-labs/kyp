use super::*;
use kyp_common::{FeeSplit, MilestoneInput, TwapConfig};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult};

const NEAR: u128 = 10u128.pow(24);
const SUPPLY: u128 = 1_000_000_000 * 10u128.pow(18);
const T0: u64 = 1_800_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(pred: &str, ts: u64, deposit: u128) -> VMContextBuilder {
    let mut c = VMContextBuilder::new();
    c.current_account_id(acc("kyp.testnet"))
        .predecessor_account_id(acc(pred))
        .block_timestamp(ts * 1_000_000_000)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(100));
    c
}

fn set(pred: &str, ts: u64, deposit: u128) {
    testing_env!(ctx(pred, ts, deposit).build());
}

fn set_with_results(pred: &str, ts: u64, results: Vec<PromiseResult>) {
    testing_env!(
        ctx(pred, ts, 0).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

fn config() -> PlatformConfig {
    PlatformConfig {
        lock_contract: acc("lock.kyp.testnet"),
        pool_contract: acc("pool.kyp.testnet"),
        pool_fee: 10000,
        point_delta: 200,
        allowed_quote_tokens: vec![acc("wrap.testnet")],
        max_presale_cap_bps: 5000,
        token_account_deposit: NearToken::from_near(3),
        pool_storage_deposit: NearToken::from_millinear(100),
        pool_create_deposit: NearToken::from_millinear(100),
        liquidity_deposit: NearToken::from_millinear(50),
        pool_deposit_msg: "".into(),
    }
}

fn h(account: &str, salt: &str) -> String {
    to_hex(&slot_hash(&acc(account), salt))
}

/// Opening FDV 2_500 wNEAR (~$5k), 20% cap -> open cap 500 wNEAR minus reserved.
fn params() -> LaunchParams {
    LaunchParams {
        name: "Owl Meme".into(),
        symbol: "OWL".into(),
        icon: None,
        description: "hoot".into(),
        terms_uri: None,
        quote_token_id: acc("wrap.testnet"),
        total_supply: None,
        decimals: None,
        opening_fdv_quote: U128(2_500 * NEAR),
        presale_cap_bps: 2_000,
        min_raise: U128(10 * NEAR),
        wallet_min: U128(NEAR),
        wallet_max: U128(100 * NEAR),
        allowlist: vec![h("alice.testnet", "s1"), h("bob.testnet", "s2"), h("carol.testnet", "s3")],
        reserved: vec![ReservedSlotInput { hash: h("whale.testnet", "s9"), quote_amount: U128(50 * NEAR) }],
        sale_start: T0,
        sale_end: T0 + 3 * 86_400,
        milestones: vec![
            MilestoneInput { target_fdv_quote: U128(5_000_000 * NEAR), unlock_bps: 2_500 },
            MilestoneInput { target_fdv_quote: U128(20_000_000 * NEAR), unlock_bps: 7_500 },
        ],
        twap: TwapConfig::default(),
        reveal: RevealConfig { waves: 3, interval_sec: 86_400 },
        fee_split: FeeSplit {
            holders_bps: 5_000,
            liquidity_bps: 3_000,
            community_bps: 2_000,
            holders_account: acc("holders.kyp.testnet"),
            liquidity_account: acc("lp.kyp.testnet"),
            community_account: acc("bounties.kyp.testnet"),
        },
    }
}

fn new_contract() -> Contract {
    set("owner.testnet", T0, 0);
    Contract::new(acc("owner.testnet"), config())
}

fn open_launch(c: &mut Contract) -> u64 {
    set("launcher.testnet", T0, 0);
    let l = c.build_launch(acc("launcher.testnet"), params());
    let id = l.id;
    c.launches.insert(id, l);
    set_with_results("kyp.testnet", T0, vec![PromiseResult::Successful(vec![])]);
    assert!(c.on_token_deployed(id, acc("launcher.testnet"), U128(3 * NEAR), Ok(())));
    id
}

fn deposit(c: &mut Contract, who: &str, salt: &str, amount: u128, ts: u64) -> u128 {
    set("wrap.testnet", ts, 0);
    match c.ft_on_transfer(
        acc(who),
        U128(amount),
        serde_json::to_string(&CoordinatorMsg::Deposit { launch_id: 1, salt: salt.into() }).unwrap(),
    ) {
        PromiseOrValue::Value(v) => v.0,
        _ => panic!("expected value"),
    }
}

#[test]
fn create_validates_and_opens() {
    let mut c = new_contract();
    let id = open_launch(&mut c);
    let v = c.get_launch(id).unwrap();
    assert_eq!(v.status, LaunchStatus::Open);
    assert_eq!(v.token_id.as_str(), "owl-1.kyp.testnet");
    assert_eq!(v.total_supply.0, SUPPLY);
    assert_eq!(v.open_slots, 3);
    assert_eq!(v.reserved_slots, 1);
    // cap: 20% of 2500 = 500 wNEAR, minus 50 reserved
    assert_eq!(v.open_cap_quote.0, 450 * NEAR);
    assert_eq!(v.pool_id, "owl-1.kyp.testnet|wrap.testnet|10000");
    assert!(v.token_is_x);
    assert_eq!(v.init_point % 200, 0);
}

#[test]
#[should_panic(expected = "presale cap above platform max")]
fn cap_above_50_rejected() {
    let mut c = new_contract();
    let mut p = params();
    p.presale_cap_bps = 5_001;
    c.build_launch(acc("l.testnet"), p);
}

#[test]
#[should_panic(expected = "presale window max 7 days")]
fn window_max_7_days() {
    let mut c = new_contract();
    let mut p = params();
    p.sale_end = T0 + 8 * 86_400;
    c.build_launch(acc("l.testnet"), p);
}

#[test]
#[should_panic(expected = "quote token not allowed")]
fn wnear_only() {
    let mut c = new_contract();
    let mut p = params();
    p.quote_token_id = acc("usdc.testnet");
    c.build_launch(acc("l.testnet"), p);
}

#[test]
#[should_panic(expected = "first milestone must be above opening FDV")]
fn milestone_above_open() {
    let mut c = new_contract();
    let mut p = params();
    p.milestones = vec![MilestoneInput { target_fdv_quote: U128(100 * NEAR), unlock_bps: 10_000 }];
    c.build_launch(acc("l.testnet"), p);
}

#[test]
fn deposits_enforce_allowlist_limits_and_refund_excess() {
    let mut c = new_contract();
    open_launch(&mut c);
    assert_eq!(deposit(&mut c, "alice.testnet", "s1", 10 * NEAR, T0 + 10), 0);
    // over wallet max -> excess refunded
    assert_eq!(deposit(&mut c, "bob.testnet", "s2", 150 * NEAR, T0 + 20), 50 * NEAR);
    let v = c.get_launch(1).unwrap();
    assert_eq!(v.total_raised.0, 110 * NEAR);
    assert_eq!(v.filled_open_slots, 2);
    // slot lookup by hash works and does not need the account
    let s = c.get_slot(1, h("bob.testnet", "s2")).unwrap();
    assert_eq!(s.deposit.0, 100 * NEAR);
}

#[test]
#[should_panic(expected = "not on the allowlist")]
fn wrong_salt_rejected() {
    let mut c = new_contract();
    open_launch(&mut c);
    deposit(&mut c, "alice.testnet", "nope", 10 * NEAR, T0 + 10);
}

#[test]
#[should_panic(expected = "below per-wallet minimum")]
fn below_min_rejected() {
    let mut c = new_contract();
    open_launch(&mut c);
    deposit(&mut c, "alice.testnet", "s1", NEAR / 2, T0 + 10);
}

#[test]
#[should_panic(expected = "reserved slot")]
fn reserved_cannot_buy_in_presale() {
    let mut c = new_contract();
    open_launch(&mut c);
    deposit(&mut c, "whale.testnet", "s9", 10 * NEAR, T0 + 10);
}

#[test]
#[should_panic(expected = "wrong payment token")]
fn only_quote_token() {
    let mut c = new_contract();
    open_launch(&mut c);
    set("usdc.testnet", T0 + 5, 0);
    let _ = c.ft_on_transfer(
        acc("alice.testnet"),
        U128(10),
        serde_json::to_string(&CoordinatorMsg::Deposit { launch_id: 1, salt: "s1".into() }).unwrap(),
    );
}

#[test]
fn hard_cap_refunds() {
    let mut c = new_contract();
    let mut p = params();
    p.wallet_max = U128(400 * NEAR);
    set("launcher.testnet", T0, 0);
    let l = c.build_launch(acc("launcher.testnet"), p);
    c.launches.insert(1, l);
    c.launches.get_mut(&1).unwrap().status = LaunchStatus::Open;
    assert_eq!(deposit(&mut c, "alice.testnet", "s1", 400 * NEAR, T0 + 1), 0);
    // only 50 left under the 450 open cap
    assert_eq!(deposit(&mut c, "bob.testnet", "s2", 400 * NEAR, T0 + 2), 350 * NEAR);
}

fn launch_ready(c: &mut Contract) {
    open_launch(c);
    deposit(c, "alice.testnet", "s1", 10 * NEAR, T0 + 10);
    deposit(c, "bob.testnet", "s2", 100 * NEAR, T0 + 20);
    deposit(c, "carol.testnet", "s3", 40 * NEAR, T0 + 30);
}

#[test]
fn launch_settles_one_price_and_runs_steps_to_live() {
    let mut c = new_contract();
    launch_ready(&mut c);
    set("launcher.testnet", T0 + 100, NearToken::from_near(1).as_yoctonear());
    let _ = c.launch(1);
    let v = c.get_launch(1).unwrap();
    assert_eq!(v.status, LaunchStatus::Launching);
    // 150 wNEAR at 2500 wNEAR FDV = 6% of supply; everyone at the same price
    assert_eq!(v.presale_tokens.0, SUPPLY * 6 / 100);
    let per_near = SUPPLY / 2_500;
    let ps = c.get_presalers(1);
    for p in ps.iter() {
        assert_eq!(p.tokens.0, p.quote.0 / NEAR * per_near);
        assert!(p.account_id.is_none(), "hidden before reveal");
    }
    // reserved 50 wNEAR -> 2% held back, LP gets the rest
    assert_eq!(v.lp_tokens.0, SUPPLY - SUPPLY * 6 / 100 - SUPPLY * 2 / 100);

    // step a: lock funded
    set_with_results("kyp.testnet", T0 + 101, vec![]);
    let _ = c.on_lock_funded(1, Ok(U128(SUPPLY * 6 / 100)));
    assert!(c.get_launch(1).unwrap().progress.lock_funded);
    // step b: pool created
    let _ = c.on_pool_created(1, Ok("owl-1.kyp.testnet|wrap.testnet|10000".into()));
    assert!(c.get_launch(1).unwrap().progress.pool_created);
    // step c: both deposits fully used
    let lp = serde_json::to_vec(&U128(v.lp_tokens.0)).unwrap();
    let q = serde_json::to_vec(&U128(150 * NEAR)).unwrap();
    set_with_results("kyp.testnet", T0 + 102, vec![PromiseResult::Successful(lp), PromiseResult::Successful(q)]);
    let _ = c.on_deposited(1, vec![0, 1]);
    let pr = c.get_launch(1).unwrap().progress;
    assert!(pr.token_deposited && pr.quote_deposited);
    // step d: liquidity added -> live
    set_with_results("kyp.testnet", T0 + 103, vec![]);
    let _ = c.on_liquidity_added(1, Ok("pool#2".into()));
    let v = c.get_launch(1).unwrap();
    assert_eq!(v.status, LaunchStatus::Live);
    assert_eq!(v.launched_at, Some(T0 + 103));
    assert_eq!(v.next_wave_at, Some(T0 + 103 + 86_400));
}

#[test]
fn failed_step_halts_and_resume_continues() {
    let mut c = new_contract();
    launch_ready(&mut c);
    set("launcher.testnet", T0 + 100, NearToken::from_near(1).as_yoctonear());
    let _ = c.launch(1);
    set_with_results("kyp.testnet", T0 + 101, vec![]);
    let _ = c.on_lock_funded(1, Ok(U128(SUPPLY * 6 / 100)));
    let r = c.on_pool_created(1, Err(PromiseError::Failed));
    assert!(matches!(r, PromiseOrValue::Value(false)));
    let v = c.get_launch(1).unwrap();
    assert_eq!(v.status, LaunchStatus::Launching);
    assert!(v.progress.lock_funded && !v.progress.pool_created);
    // anyone can resume; it re-issues only the pool step
    set("keeper.testnet", T0 + 200, NearToken::from_near(1).as_yoctonear());
    assert!(matches!(c.resume_launch(1), PromiseOrValue::Promise(_)));
}

#[test]
fn lock_funding_failure_keeps_tokens_and_allows_resume() {
    let mut c = new_contract();
    launch_ready(&mut c);
    set("launcher.testnet", T0 + 100, NearToken::from_near(1).as_yoctonear());
    let _ = c.launch(1);
    set_with_results("kyp.testnet", T0 + 101, vec![]);
    let r = c.on_lock_funded(1, Ok(U128(0)));
    assert!(matches!(r, PromiseOrValue::Value(false)));
    assert!(!c.get_launch(1).unwrap().progress.lock_funded);
}

#[test]
#[should_panic(expected = "min raise not reached")]
fn launch_requires_min_raise() {
    let mut c = new_contract();
    open_launch(&mut c);
    deposit(&mut c, "alice.testnet", "s1", 5 * NEAR, T0 + 10);
    set("launcher.testnet", T0 + 100, NearToken::from_near(1).as_yoctonear());
    let _ = c.launch(1);
}

#[test]
#[should_panic(expected = "launcher only")]
fn only_launcher_launches() {
    let mut c = new_contract();
    launch_ready(&mut c);
    set("mallory.testnet", T0 + 100, NearToken::from_near(1).as_yoctonear());
    let _ = c.launch(1);
}

#[test]
#[should_panic(expected = "committed")]
fn no_withdraw_while_open() {
    let mut c = new_contract();
    launch_ready(&mut c);
    set("alice.testnet", T0 + 100, 0);
    let _ = c.withdraw(1);
}

#[test]
fn withdraw_after_missed_deadline() {
    let mut c = new_contract();
    launch_ready(&mut c);
    set("alice.testnet", T0 + 3 * 86_400 + 1, 0);
    let _ = c.withdraw(1);
    assert_eq!(c.get_launch(1).unwrap().total_raised.0, 140 * NEAR);
    // failed transfer rolls back
    set_with_results("kyp.testnet", T0 + 3 * 86_400 + 2, vec![]);
    c.on_withdrawn(1, 0, U128(10 * NEAR), Err(PromiseError::Failed));
    assert_eq!(c.get_launch(1).unwrap().total_raised.0, 150 * NEAR);
}

fn go_live(c: &mut Contract) {
    launch_ready(c);
    set("launcher.testnet", T0 + 100, NearToken::from_near(1).as_yoctonear());
    let _ = c.launch(1);
    let v = c.get_launch(1).unwrap();
    set_with_results("kyp.testnet", T0 + 101, vec![]);
    let _ = c.on_lock_funded(1, Ok(v.presale_tokens));
    let _ = c.on_pool_created(1, Ok(v.pool_id.clone()));
    let lp = serde_json::to_vec(&v.lp_tokens).unwrap();
    let q = serde_json::to_vec(&v.total_raised).unwrap();
    set_with_results("kyp.testnet", T0 + 102, vec![PromiseResult::Successful(lp), PromiseResult::Successful(q)]);
    let _ = c.on_deposited(1, vec![0, 1]);
    set_with_results("kyp.testnet", T0 + 103, vec![]);
    let _ = c.on_liquidity_added(1, Ok("lpt".into()));
}

#[test]
fn reveal_waves_smallest_first_on_schedule() {
    let mut c = new_contract();
    go_live(&mut c);
    let launched = T0 + 103;
    let ps = c.get_presalers(1);
    // ascending sizes 10, 40, 100 -> waves 1,2,3
    assert_eq!(ps.iter().map(|p| p.quote.0 / NEAR).collect::<Vec<_>>(), vec![10, 40, 100]);
    assert_eq!(ps.iter().map(|p| p.wave).collect::<Vec<_>>(), vec![1, 2, 3]);
    set("anyone.testnet", launched + 86_400, 0);
    assert_eq!(c.reveal_next_wave(1), 1);
    let ps = c.get_presalers(1);
    assert_eq!(ps[0].account_id.as_ref().map(|a| a.as_str()), Some("alice.testnet"));
    assert!(ps[1].account_id.is_none() && ps[2].account_id.is_none());
}

#[test]
#[should_panic(expected = "next wave not due yet")]
fn reveal_not_early() {
    let mut c = new_contract();
    go_live(&mut c);
    set("anyone.testnet", T0 + 103 + 86_399, 0);
    c.reveal_next_wave(1);
}

#[test]
fn reserved_slot_after_launch_same_terms() {
    let mut c = new_contract();
    go_live(&mut c);
    set("wrap.testnet", T0 + 500, 0);
    let r = c.ft_on_transfer(
        acc("whale.testnet"),
        U128(60 * NEAR),
        serde_json::to_string(&CoordinatorMsg::BuyReserved { launch_id: 1, salt: "s9".into() }).unwrap(),
    );
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    let tokens = SUPPLY * 2 / 100;
    set_with_results("kyp.testnet", T0 + 501, vec![]);
    let refund = c.on_reserved_locked(1, 3, U128(50 * NEAR), U128(60 * NEAR), U128(tokens), Ok(U128(tokens)));
    assert_eq!(refund.0, 10 * NEAR);
    let v = c.get_launch(1).unwrap();
    assert_eq!(v.filled_reserved_slots, 1);
    assert_eq!(v.fee_balances, vec![(acc("wrap.testnet"), U128(50 * NEAR))]);
}

#[test]
fn reserved_lock_failure_refunds_all() {
    let mut c = new_contract();
    go_live(&mut c);
    set("wrap.testnet", T0 + 500, 0);
    let _ = c.ft_on_transfer(
        acc("whale.testnet"),
        U128(50 * NEAR),
        serde_json::to_string(&CoordinatorMsg::BuyReserved { launch_id: 1, salt: "s9".into() }).unwrap(),
    );
    set_with_results("kyp.testnet", T0 + 501, vec![]);
    let refund = c.on_reserved_locked(1, 3, U128(50 * NEAR), U128(50 * NEAR), U128(1), Err(PromiseError::Failed));
    assert_eq!(refund.0, 50 * NEAR);
    assert_eq!(c.get_launch(1).unwrap().filled_reserved_slots, 0);
}

#[test]
fn liquidity_ranges_single_sided_around_price() {
    let mut c = new_contract();
    go_live(&mut c);
    let l = c.launches.get(&1).unwrap().clone();
    let r = Contract::liquidity_ranges(&l, 200);
    // token is x: token range strictly above the price, quote range ending at it
    assert!(r[0].0 > l.init_point && r[0].2 == l.lp_tokens && r[0].3 == 0);
    assert!(r[1].1 == l.init_point && r[1].2 == 0 && r[1].3 == l.total_raised);
    let mut l2 = l.clone();
    l2.token_is_x = false;
    let r2 = Contract::liquidity_ranges(&l2, 200);
    assert!(r2[0].1 == l2.init_point && r2[0].3 == l2.lp_tokens);
    assert!(r2[1].0 > l2.init_point && r2[1].2 == l2.total_raised);
}

#[test]
fn liquidity_ranges_fit_dcl_point_rules() {
    // DCL: right_point < 800_000, right - left < 800_000, multiples of point_delta
    let mut c = new_contract();
    go_live(&mut c);
    for init in [-39_200, 0, -400_000, 400_000, 799_000, -799_000] {
        let mut l = c.launches.get(&1).unwrap().clone();
        l.init_point = init;
        for is_x in [true, false] {
            l.token_is_x = is_x;
            for (left, right, _, _) in Contract::liquidity_ranges(&l, 200) {
                assert!(left >= -800_000 && right < 800_000 && left < right, "{init} {left}..{right}");
                assert!(right - left < 800_000, "width {init} {left}..{right}");
                assert!(left % 200 == 0 && right % 200 == 0);
            }
        }
    }
    let l = c.launches.get(&1).unwrap().clone();
    let r = Contract::liquidity_ranges(&l, 200);
    assert_eq!(r[0].0, l.init_point + 200, "token range starts one delta above the price");
    assert_eq!(r[1].1, l.init_point, "quote range ends at the price");
}

#[test]
fn fees_split_and_failed_legs_recredited() {
    let mut c = new_contract();
    go_live(&mut c);
    set("wrap.testnet", T0 + 600, 0);
    let _ = c.ft_on_transfer(
        acc("someone.testnet"),
        U128(100 * NEAR),
        serde_json::to_string(&CoordinatorMsg::Fees { launch_id: 1 }).unwrap(),
    );
    set("keeper.testnet", T0 + 601, 0);
    let _ = c.distribute_fees(1, acc("wrap.testnet"));
    assert_eq!(c.get_launch(1).unwrap().fee_balances[0].1 .0, 0);
    let legs = vec![
        (acc("holders.kyp.testnet"), U128(50 * NEAR)),
        (acc("lp.kyp.testnet"), U128(30 * NEAR)),
        (acc("bounties.kyp.testnet"), U128(20 * NEAR)),
    ];
    set_with_results(
        "kyp.testnet",
        T0 + 602,
        vec![PromiseResult::Successful(vec![]), PromiseResult::Failed, PromiseResult::Successful(vec![])],
    );
    let failed = c.on_fees_distributed(1, acc("wrap.testnet"), legs);
    assert_eq!(failed.0, 30 * NEAR);
    assert_eq!(c.get_launch(1).unwrap().fee_balances[0].1 .0, 30 * NEAR);
}

#[test]
fn hash_helper_matches() {
    let c = new_contract();
    assert_eq!(c.hash_slot(acc("alice.testnet"), "s1".into()), h("alice.testnet", "s1"));
    assert_eq!(from_hex(&h("a.testnet", "x")), slot_hash(&acc("a.testnet"), "x"));
}

// ------------------------------------------------------------------ split pool steps (RHEA DCL)

fn set_gas(pred: &str, ts: u64, deposit: u128, tgas: u64) {
    testing_env!(ctx(pred, ts, deposit).prepaid_gas(Gas::from_tgas(tgas)).build());
}

fn set_results_gas(pred: &str, ts: u64, tgas: u64, results: Vec<PromiseResult>) {
    testing_env!(
        ctx(pred, ts, 0).prepaid_gas(Gas::from_tgas(tgas)).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

fn dcl_gas() -> StepGas {
    StepGas { split_pool_steps: true, pool_deposit_tgas: 965, add_liquidity_tgas: 100 }
}

#[test]
fn step_gas_defaults_and_owner_only_setter() {
    let mut c = new_contract();
    assert_eq!(c.get_step_gas(), StepGas::default());
    assert!(!c.get_step_gas().split_pool_steps);
    set("owner.testnet", T0, 0);
    c.set_step_gas(dcl_gas());
    assert_eq!(c.get_step_gas(), dcl_gas());
}

#[test]
#[should_panic(expected = "owner only")]
fn step_gas_owner_only() {
    let mut c = new_contract();
    set("mallory.testnet", T0, 0);
    c.set_step_gas(dcl_gas());
}

#[test]
#[should_panic(expected = "pool_deposit_tgas 20-990")]
fn step_gas_bounds() {
    let mut c = new_contract();
    set("owner.testnet", T0, 0);
    c.set_step_gas(StepGas { split_pool_steps: true, pool_deposit_tgas: 2000, add_liquidity_tgas: 100 });
}

#[test]
fn split_steps_pause_and_resume_one_step_per_tx_to_live() {
    let mut c = new_contract();
    set("owner.testnet", T0, 0);
    c.set_step_gas(dcl_gas());
    launch_ready(&mut c);
    // launch tx (300 Tgas): settle at one price + fund the lock + create the pool
    set_gas("launcher.testnet", T0 + 100, NearToken::from_near(1).as_yoctonear(), 300);
    let _ = c.launch(1);
    let v = c.get_launch(1).unwrap();
    let per_near = SUPPLY / 2_500;
    for p in c.get_presalers(1) {
        assert_eq!(p.tokens.0, p.quote.0 / NEAR * per_near, "one price for everyone");
    }
    set_results_gas("kyp.testnet", T0 + 101, 250, vec![]);
    assert!(matches!(c.on_lock_funded(1, Ok(v.presale_tokens)), PromiseOrValue::Promise(_)), "pool creation follows lock funding");
    // the ~965 Tgas token deposit can't fit in the rest of the launch tx: pause, keep progress
    set_results_gas("kyp.testnet", T0 + 101, 200, vec![]);
    let r = c.on_pool_created(1, Ok(v.pool_id.clone()));
    assert!(matches!(r, PromiseOrValue::Value(false)));
    let l = c.get_launch(1).unwrap();
    assert_eq!(l.status, LaunchStatus::Launching);
    assert!(l.progress.lock_funded && l.progress.pool_created && !l.progress.token_deposited);
    // resume with too little gas pauses again (no panic, nothing lost)
    set_gas("keeper.testnet", T0 + 150, 0, 300);
    assert!(matches!(c.resume_launch(1), PromiseOrValue::Value(false)));
    // resume tx 1 (1 PGas): token deposit only
    set_gas("keeper.testnet", T0 + 200, 0, 1000);
    assert!(matches!(c.resume_launch(1), PromiseOrValue::Promise(_)));
    let lp = serde_json::to_vec(&v.lp_tokens).unwrap();
    set_results_gas("kyp.testnet", T0 + 201, 10, vec![PromiseResult::Successful(lp)]);
    assert!(matches!(c.on_deposited(1, vec![0]), PromiseOrValue::Value(false)), "callback pauses, quote deposit is its own tx");
    let pr = c.get_launch(1).unwrap().progress;
    assert!(pr.token_deposited && !pr.quote_deposited);
    // resume tx 2: quote deposit only
    set_gas("keeper.testnet", T0 + 300, 0, 1000);
    assert!(matches!(c.resume_launch(1), PromiseOrValue::Promise(_)));
    let q = serde_json::to_vec(&v.total_raised).unwrap();
    set_results_gas("kyp.testnet", T0 + 301, 10, vec![PromiseResult::Successful(q)]);
    let _ = c.on_deposited(1, vec![1]);
    let pr = c.get_launch(1).unwrap().progress;
    assert!(pr.token_deposited && pr.quote_deposited && !pr.liquidity_added);
    // resume tx 3: two add_liquidity ranges, one per step
    set_gas("keeper.testnet", T0 + 400, 0, 300);
    assert!(matches!(c.resume_launch(1), PromiseOrValue::Promise(_)));
    set_results_gas("kyp.testnet", T0 + 401, 180, vec![]);
    assert!(matches!(c.on_liquidity_added(1, Ok("lpt#1".into())), PromiseOrValue::Promise(_)));
    let l = c.get_launch(1).unwrap();
    assert!(!l.progress.liquidity_added);
    assert_eq!(l.lpt_ids, vec!["lpt#1".to_string()]);
    set_results_gas("kyp.testnet", T0 + 402, 70, vec![]);
    let _ = c.on_liquidity_added(1, Ok("lpt#2".into()));
    let l = c.get_launch(1).unwrap();
    assert!(l.progress.liquidity_added);
    assert_eq!(l.status, LaunchStatus::Live);
    assert_eq!(l.lpt_ids.len(), 2);
}

#[test]
fn split_failed_range_recredits_one_deposit() {
    let mut c = new_contract();
    set("owner.testnet", T0, 0);
    c.set_step_gas(dcl_gas());
    launch_ready(&mut c);
    set_gas("launcher.testnet", T0 + 100, NearToken::from_near(1).as_yoctonear(), 300);
    let _ = c.launch(1);
    let budget_before = c.launches.get(&1).unwrap().near_budget;
    c.launches.get_mut(&1).unwrap().progress = LaunchProgress { lock_funded: true, pool_created: true, token_deposited: true, quote_deposited: true, liquidity_added: false };
    set_gas("keeper.testnet", T0 + 200, 0, 300);
    let _ = c.resume_launch(1);
    let spent = budget_before - c.launches.get(&1).unwrap().near_budget;
    assert_eq!(spent, config().liquidity_deposit.as_yoctonear(), "one range = one deposit");
    set_results_gas("kyp.testnet", T0 + 201, 50, vec![]);
    let _ = c.on_liquidity_added(1, Err(PromiseError::Failed));
    assert_eq!(c.launches.get(&1).unwrap().near_budget, budget_before);
    assert_eq!(c.get_launch(1).unwrap().status, LaunchStatus::Launching);
    assert_eq!(c.get_liquidity_attempts(1), 1, "next resume nudges the range");
    // success resets the counter for the next range
    set_results_gas("kyp.testnet", T0 + 300, 50, vec![]);
    let _ = c.on_liquidity_added(1, Ok("lpt#1".into()));
    assert_eq!(c.get_liquidity_attempts(1), 0);
}

#[test]
fn liquidity_ranges_nudge_far_end_only_and_stay_legal() {
    let mut c = new_contract();
    go_live(&mut c);
    let l = c.launches.get(&1).unwrap().clone();
    let r0 = Contract::liquidity_ranges(&l, 200);
    for t in 1..=40u8 {
        let r = Contract::liquidity_ranges_nudged(&l, 200, t);
        assert_eq!(r[0].0, r0[0].0, "token range still starts one delta above the price");
        assert_eq!(r[1].1, r0[1].1, "quote range still ends at the price");
        assert_eq!(r[0].1, r0[0].1 - 1400 * t as i32);
        assert_eq!(r[1].0, r0[1].0 + 1400 * t as i32);
        for (lft, rgt, ..) in r {
            assert!(lft < rgt && lft % 200 == 0 && rgt % 200 == 0 && rgt - lft < 800_000);
        }
        assert_eq!((r[0].2, r[1].3), (r0[0].2, r0[1].3), "amounts unchanged");
    }
}
