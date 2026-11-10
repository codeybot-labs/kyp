//! KYP market-cap lock.
//!
//! Holds presale tokens for every launch the coordinator creates. Positions unlock in
//! public tranches when the token's FDV, measured as a TWAP over a public window,
//! reaches each milestone. There is no owner and no rescue path: tokens leave only via
//! `claim` by the position holder after a milestone qualified and the claim delay passed.
//!
//! * `ft_on_transfer` (only from the coordinator) creates a lock (`Fund`) or adds a
//!   reserved-slot position on the same terms (`Add`).
//! * `record` is a permissionless poke: reads the DCL pool (`get_pool`) and the token
//!   supply (`ft_total_supply`) and stores an observation.
//! * `qualify` is permissionless: computes the TWAP and marks every milestone whose
//!   target FDV is met. Qualification is a one-way ratchet.
//! * `claim` releases the caller's unlocked amount.

use kyp_common::{
    assert_valid_milestones, fdv_quote_at_point, twap_point, LockMsg, Observation, TwapConfig,
    TwapError, BPS_DENOM,
};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};

pub const MAX_OBSERVATIONS: usize = 512;
const GAS_GET_POOL: Gas = Gas::from_tgas(10);
const GAS_SUPPLY: Gas = Gas::from_tgas(5);
const GAS_ON_OBSERVED: Gas = Gas::from_tgas(15);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_ON_CLAIMED: Gas = Gas::from_tgas(10);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Locks,
    Positions,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Milestone {
    pub target_fdv_quote: U128,
    pub unlock_bps: u16,
    /// Unix seconds when the TWAP first met the target.
    pub qualified_at: Option<u64>,
    pub qualified_twap_point: Option<i32>,
}

#[near(serializers = [borsh])]
pub struct LockState {
    pub token_id: AccountId,
    pub pool_contract: AccountId,
    pub pool_id: String,
    pub token_is_x: bool,
    pub milestones: Vec<Milestone>,
    pub twap: TwapConfig,
    pub observations: Vec<Observation>,
    /// Latest observed ft_total_supply (minted - burned).
    pub supply: u128,
    pub total_locked: u128,
    pub total_claimed: u128,
    pub positions_count: u32,
    pub created_at: u64,
    pub last_poke_at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Position {
    pub total: U128,
    pub claimed: U128,
}

#[near(serializers = [json])]
pub struct LockView {
    pub launch_id: u64,
    pub token_id: AccountId,
    pub pool_contract: AccountId,
    pub pool_id: String,
    pub token_is_x: bool,
    pub milestones: Vec<Milestone>,
    pub twap: TwapConfig,
    pub observations_count: u32,
    pub last_observation: Option<Observation>,
    pub supply: U128,
    pub total_locked: U128,
    pub total_claimed: U128,
    pub positions_count: u32,
    pub created_at: u64,
    /// Sum of unlock_bps for milestones that are claimable now.
    pub unlocked_bps: u16,
}

#[near(serializers = [json])]
pub struct TwapStatus {
    pub ok: bool,
    pub error: Option<String>,
    pub avg_point: Option<i32>,
    pub twap_fdv_quote: Option<U128>,
    pub observations_in_window: Option<u32>,
    pub spot_point: Option<i32>,
    pub spot_fdv_quote: Option<U128>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    /// The only account allowed to create locks or add positions (via ft_transfer_call).
    pub coordinator: AccountId,
    locks: IterableMap<u64, LockState>,
    positions: LookupMap<(u64, AccountId), Position>,
}

fn now_sec() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

fn emit(event: &str, data: serde_json::Value) {
    log!(
        "EVENT_JSON:{}",
        json!({"standard": "kyp-lock", "version": "1.0.0", "event": event, "data": [data]})
    );
}

fn twap_err_str(e: TwapError) -> String {
    match e {
        TwapError::NoAnchor => "no observation at or before window start yet".into(),
        TwapError::TooFewObservations { have, need } => {
            format!("too few observations in window: {have}/{need}")
        }
        TwapError::LowLiquidity => "pool liquidity below minimum in window".into(),
        TwapError::Stale => "latest observation is stale; poke `record`".into(),
    }
}

#[near]
impl Contract {
    #[init]
    pub fn new(coordinator: AccountId) -> Self {
        Self {
            coordinator,
            locks: IterableMap::new(Key::Locks),
            positions: LookupMap::new(Key::Positions),
        }
    }

    // ---------------------------------------------------------------- funding

    /// NEP-141 receiver. Only the coordinator may fund/extend locks; any other sender is refunded.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(sender_id == self.coordinator, "only the KYP coordinator can fund locks");
        let token_id = env::predecessor_account_id();
        let parsed: LockMsg = serde_json::from_str(&msg).expect("invalid lock msg");
        match parsed {
            LockMsg::Fund(m) => {
                require!(!self.locks.contains_key(&m.launch_id), "lock already exists");
                assert_valid_milestones(&m.milestones);
                m.twap.assert_valid();
                let sum: u128 = m.positions.iter().map(|(_, a)| a.0).sum();
                require!(sum == amount.0, "positions must sum to the transferred amount");
                let mut count = 0u32;
                for (acc, a) in m.positions.iter() {
                    require!(a.0 > 0, "empty position");
                    let key = (m.launch_id, acc.clone());
                    require!(!self.positions.contains_key(&key), "duplicate position");
                    self.positions.insert(key, Position { total: *a, claimed: U128(0) });
                    count += 1;
                }
                let now = now_sec();
                self.locks.insert(
                    m.launch_id,
                    LockState {
                        token_id: token_id.clone(),
                        pool_contract: m.pool_contract,
                        pool_id: m.pool_id,
                        token_is_x: m.token_is_x,
                        milestones: m
                            .milestones
                            .into_iter()
                            .map(|x| Milestone {
                                target_fdv_quote: x.target_fdv_quote,
                                unlock_bps: x.unlock_bps,
                                qualified_at: None,
                                qualified_twap_point: None,
                            })
                            .collect(),
                        twap: m.twap,
                        observations: vec![],
                        supply: 0,
                        total_locked: amount.0,
                        total_claimed: 0,
                        positions_count: count,
                        created_at: now,
                        last_poke_at: 0,
                    },
                );
                emit(
                    "lock_created",
                    json!({"launch_id": m.launch_id, "token_id": token_id, "total_locked": amount, "positions": count}),
                );
            }
            LockMsg::Add(m) => {
                let lock = self.locks.get_mut(&m.launch_id).expect("no such lock");
                require!(lock.token_id == token_id, "wrong token for this lock");
                require!(amount.0 > 0, "empty position");
                lock.total_locked += amount.0;
                let key = (m.launch_id, m.account_id.clone());
                let mut p = self.positions.get(&key).cloned().unwrap_or_default();
                if p.total.0 == 0 {
                    lock.positions_count += 1;
                }
                p.total = U128(p.total.0 + amount.0);
                self.positions.insert(key, p);
                emit("position_added", json!({"launch_id": m.launch_id, "amount": amount}));
            }
        }
        PromiseOrValue::Value(U128(0))
    }

    // ---------------------------------------------------------------- observer

    /// Permissionless poke: record the pool's current point + liquidity and the token supply.
    pub fn record(&mut self, launch_id: u64) -> Promise {
        let now = now_sec();
        let lock = self.locks.get_mut(&launch_id).expect("no such lock");
        require!(
            lock.last_poke_at == 0 || now >= lock.last_poke_at + lock.twap.min_obs_interval_sec,
            "too soon: wait min_obs_interval_sec between observations"
        );
        lock.last_poke_at = now;
        let pool = Promise::new(lock.pool_contract.clone()).function_call(
            "get_pool",
            json!({"pool_id": lock.pool_id}).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_GET_POOL,
        );
        let supply = Promise::new(lock.token_id.clone()).function_call(
            "ft_total_supply",
            b"{}".to_vec(),
            NearToken::from_yoctonear(0),
            GAS_SUPPLY,
        );
        pool.and(supply).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_ON_OBSERVED)
                .on_observed(launch_id),
        )
    }

    #[private]
    pub fn on_observed(&mut self, launch_id: u64) -> Option<Observation> {
        let pool_raw = match env::promise_result_checked(0, 16_384) {
            Ok(v) => v,
            Err(_) => {
                log!("get_pool failed; observation skipped");
                return None;
            }
        };
        let supply_raw = match env::promise_result_checked(1, 256) {
            Ok(v) => v,
            Err(_) => {
                log!("ft_total_supply failed; observation skipped");
                return None;
            }
        };
        let pool: kyp_common::DclPoolView = match serde_json::from_slice(&pool_raw) {
            Ok(p) => p,
            Err(_) => {
                log!("unparseable get_pool result; observation skipped");
                return None;
            }
        };
        let supply: U128 = match serde_json::from_slice(&supply_raw) {
            Ok(s) => s,
            Err(_) => return None,
        };
        self.internal_observe(launch_id, pool, supply.0)
    }

    /// Shared by the callback and unit tests.
    pub(crate) fn internal_observe(
        &mut self,
        launch_id: u64,
        pool: kyp_common::DclPoolView,
        supply: u128,
    ) -> Option<Observation> {
        let lock = self.locks.get_mut(&launch_id).expect("no such lock");
        if pool.pool_id != lock.pool_id {
            log!("pool id mismatch; observation skipped");
            return None;
        }
        if let Some(s) = &pool.state {
            if s != "Running" {
                log!("pool not running ({}); observation skipped", s);
                return None;
            }
        }
        let ts = now_sec();
        if let Some(last) = lock.observations.last() {
            if ts <= last.ts {
                return None;
            }
        }
        let obs = Observation { ts, point: pool.current_point, liquidity: pool.liquidity };
        lock.observations.push(obs);
        if lock.observations.len() > MAX_OBSERVATIONS {
            lock.observations.remove(0);
        }
        lock.supply = supply;
        Some(obs)
    }

    /// Permissionless: mark every milestone the TWAP FDV currently meets. Returns how many
    /// milestones newly qualified; panics with the reason if the TWAP is not valid yet.
    pub fn qualify(&mut self, launch_id: u64) -> u32 {
        let now = now_sec();
        let lock = self.locks.get_mut(&launch_id).expect("no such lock");
        require!(lock.supply > 0, "no supply observed yet; poke `record`");
        let r = twap_point(&lock.observations, now, &lock.twap)
            .unwrap_or_else(|e| env::panic_str(&twap_err_str(e)));
        let fdv = fdv_quote_at_point(r.avg_point, lock.token_is_x, lock.supply);
        let mut newly = 0u32;
        for (i, m) in lock.milestones.iter_mut().enumerate() {
            if m.qualified_at.is_none() && fdv >= m.target_fdv_quote.0 {
                m.qualified_at = Some(now);
                m.qualified_twap_point = Some(r.avg_point);
                newly += 1;
                emit(
                    "milestone_qualified",
                    json!({"launch_id": launch_id, "index": i, "twap_point": r.avg_point, "twap_fdv_quote": U128(fdv), "target_fdv_quote": m.target_fdv_quote}),
                );
            }
        }
        require!(newly > 0, "TWAP FDV is below the next milestone");
        newly
    }

    // ---------------------------------------------------------------- claim

    pub fn claim(&mut self, launch_id: u64) -> Promise {
        let account = env::predecessor_account_id();
        let amount = self.claimable(launch_id, account.clone()).0;
        require!(amount > 0, "nothing to claim yet");
        let key = (launch_id, account.clone());
        let p = self.positions.get_mut(&key).unwrap();
        p.claimed = U128(p.claimed.0 + amount);
        let lock = self.locks.get_mut(&launch_id).unwrap();
        lock.total_claimed += amount;
        Promise::new(lock.token_id.clone())
            .function_call(
                "ft_transfer",
                json!({"receiver_id": account, "amount": U128(amount), "memo": format!("KYP unlock #{launch_id}")})
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_FT_TRANSFER,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_CLAIMED)
                    .on_claimed(launch_id, account, U128(amount)),
            )
    }

    #[private]
    pub fn on_claimed(
        &mut self,
        launch_id: u64,
        account_id: AccountId,
        amount: U128,
        #[callback_result] res: Result<(), PromiseError>,
    ) -> bool {
        if res.is_ok() {
            emit("claimed", json!({"launch_id": launch_id, "account_id": account_id, "amount": amount}));
            return true;
        }
        // roll back
        let key = (launch_id, account_id);
        if let Some(p) = self.positions.get_mut(&key) {
            p.claimed = U128(p.claimed.0 - amount.0);
        }
        if let Some(l) = self.locks.get_mut(&launch_id) {
            l.total_claimed -= amount.0;
        }
        log!("claim transfer failed; rolled back");
        false
    }

    // ---------------------------------------------------------------- views

    pub fn unlocked_bps(&self, launch_id: u64) -> u16 {
        let lock = self.locks.get(&launch_id).expect("no such lock");
        Self::unlocked_bps_of(lock, now_sec())
    }

    fn unlocked_bps_of(lock: &LockState, now: u64) -> u16 {
        lock.milestones
            .iter()
            .filter(|m| matches!(m.qualified_at, Some(t) if now >= t + lock.twap.claim_delay_sec))
            .map(|m| m.unlock_bps)
            .sum()
    }

    pub fn claimable(&self, launch_id: u64, account_id: AccountId) -> U128 {
        let lock = self.locks.get(&launch_id).expect("no such lock");
        let p = match self.positions.get(&(launch_id, account_id)) {
            Some(p) => p,
            None => return U128(0),
        };
        let bps = Self::unlocked_bps_of(lock, now_sec()) as u128;
        let unlocked = p.total.0 * bps / BPS_DENOM as u128;
        U128(unlocked.saturating_sub(p.claimed.0))
    }

    pub fn get_position(&self, launch_id: u64, account_id: AccountId) -> Option<Position> {
        self.positions.get(&(launch_id, account_id)).cloned()
    }

    pub fn get_lock(&self, launch_id: u64) -> Option<LockView> {
        self.locks.get(&launch_id).map(|l| LockView {
            launch_id,
            token_id: l.token_id.clone(),
            pool_contract: l.pool_contract.clone(),
            pool_id: l.pool_id.clone(),
            token_is_x: l.token_is_x,
            milestones: l.milestones.clone(),
            twap: l.twap.clone(),
            observations_count: l.observations.len() as u32,
            last_observation: l.observations.last().copied(),
            supply: U128(l.supply),
            total_locked: U128(l.total_locked),
            total_claimed: U128(l.total_claimed),
            positions_count: l.positions_count,
            created_at: l.created_at,
            unlocked_bps: Self::unlocked_bps_of(l, now_sec()),
        })
    }

    pub fn get_lock_ids(&self) -> Vec<u64> {
        self.locks.keys().copied().collect()
    }

    pub fn get_observations(&self, launch_id: u64, from_index: Option<u32>, limit: Option<u32>) -> Vec<Observation> {
        let l = self.locks.get(&launch_id).expect("no such lock");
        let from = from_index.unwrap_or(0) as usize;
        let lim = limit.unwrap_or(100).min(200) as usize;
        l.observations.iter().skip(from).take(lim).copied().collect()
    }

    pub fn twap_status(&self, launch_id: u64) -> TwapStatus {
        let l = self.locks.get(&launch_id).expect("no such lock");
        let spot = l.observations.last().map(|o| o.point);
        let spot_fdv = spot.map(|p| U128(fdv_quote_at_point(p, l.token_is_x, l.supply)));
        match twap_point(&l.observations, now_sec(), &l.twap) {
            Ok(r) => TwapStatus {
                ok: true,
                error: None,
                avg_point: Some(r.avg_point),
                twap_fdv_quote: Some(U128(fdv_quote_at_point(r.avg_point, l.token_is_x, l.supply))),
                observations_in_window: Some(r.observations),
                spot_point: spot,
                spot_fdv_quote: spot_fdv,
            },
            Err(e) => TwapStatus {
                ok: false,
                error: Some(twap_err_str(e)),
                avg_point: None,
                twap_fdv_quote: None,
                observations_in_window: None,
                spot_point: spot,
                spot_fdv_quote: spot_fdv,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kyp_common::{DclPoolView, LockFundMsg, MilestoneInput, init_point_for_fdv};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const SUPPLY: u128 = 1_000_000_000 * 10u128.pow(18);
    const NEAR: u128 = 10u128.pow(24);

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(pred: &str, ts_sec: u64) -> VMContextBuilder {
        let mut c = VMContextBuilder::new();
        c.current_account_id(acc("lock.kyp.testnet"))
            .predecessor_account_id(acc(pred))
            .block_timestamp(ts_sec * 1_000_000_000)
            .account_balance(NearToken::from_near(10));
        c
    }

    fn twap() -> TwapConfig {
        TwapConfig {
            window_sec: 3600,
            min_observations: 4,
            min_liquidity: U128(1),
            claim_delay_sec: 600,
            min_obs_interval_sec: 300,
        }
    }

    /// Milestones: 100k NEAR FDV -> 25%, 1m NEAR FDV -> 75%.
    fn fund(c: &mut Contract) {
        testing_env!(ctx("owl.kyp.testnet", 1_000).build());
        let msg = LockMsg::Fund(LockFundMsg {
            launch_id: 1,
            pool_contract: acc("pool.kyp.testnet"),
            pool_id: "owl.kyp.testnet|wrap.testnet|10000".into(),
            token_is_x: true,
            milestones: vec![
                MilestoneInput { target_fdv_quote: U128(100_000 * NEAR), unlock_bps: 2_500 },
                MilestoneInput { target_fdv_quote: U128(1_000_000 * NEAR), unlock_bps: 7_500 },
            ],
            twap: twap(),
            positions: vec![(acc("alice.testnet"), U128(1_000)), (acc("bob.testnet"), U128(3_000))],
        });
        let r = c.ft_on_transfer(acc("coord.kyp.testnet"), U128(4_000), serde_json::to_string(&msg).unwrap());
        assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    }

    fn pool(point: i32) -> DclPoolView {
        DclPoolView {
            pool_id: "owl.kyp.testnet|wrap.testnet|10000".into(),
            token_x: acc("owl.kyp.testnet"),
            token_y: acc("wrap.testnet"),
            current_point: point,
            liquidity: U128(1_000),
            state: Some("Running".into()),
        }
    }

    fn observe_at(c: &mut Contract, ts: u64, point: i32) {
        testing_env!(ctx("lock.kyp.testnet", ts).build());
        c.internal_observe(1, pool(point), SUPPLY);
    }

    fn point_for_fdv(fdv: u128) -> i32 {
        init_point_for_fdv(fdv, SUPPLY, true, 1) + 1
    }

    #[test]
    fn funding_creates_positions() {
        let mut c = Contract::new(acc("coord.kyp.testnet"));
        fund(&mut c);
        let l = c.get_lock(1).unwrap();
        assert_eq!(l.total_locked.0, 4_000);
        assert_eq!(l.positions_count, 2);
        assert_eq!(c.get_position(1, acc("bob.testnet")).unwrap().total.0, 3_000);
    }

    #[test]
    #[should_panic(expected = "only the KYP coordinator")]
    fn only_coordinator_can_fund() {
        let mut c = Contract::new(acc("coord.kyp.testnet"));
        testing_env!(ctx("owl.kyp.testnet", 1_000).build());
        let _ = c.ft_on_transfer(acc("mallory.testnet"), U128(1), "{}".into());
    }

    #[test]
    #[should_panic(expected = "positions must sum")]
    fn positions_must_match_amount() {
        let mut c = Contract::new(acc("coord.kyp.testnet"));
        testing_env!(ctx("owl.kyp.testnet", 1_000).build());
        let msg = LockMsg::Fund(LockFundMsg {
            launch_id: 1,
            pool_contract: acc("pool.kyp.testnet"),
            pool_id: "x".into(),
            token_is_x: true,
            milestones: vec![MilestoneInput { target_fdv_quote: U128(1), unlock_bps: 10_000 }],
            twap: twap(),
            positions: vec![(acc("alice.testnet"), U128(10))],
        });
        let _ = c.ft_on_transfer(acc("coord.kyp.testnet"), U128(11), serde_json::to_string(&msg).unwrap());
    }

    #[test]
    fn spot_spike_does_not_unlock_but_sustained_does() {
        let mut c = Contract::new(acc("coord.kyp.testnet"));
        fund(&mut c);
        let low = point_for_fdv(5_000 * NEAR);
        let m1 = point_for_fdv(100_000 * NEAR);
        // flat at opening price for an hour
        for ts in [1_900, 2_400, 2_800, 3_200, 3_600, 4_000, 4_400, 4_800, 5_200] {
            observe_at(&mut c, ts, low);
        }
        // one-shot spike far above milestone 2
        observe_at(&mut c, 5_500, point_for_fdv(50_000_000 * NEAR));
        testing_env!(ctx("anyone.testnet", 5_560).build());
        let st = c.twap_status(1);
        assert!(st.ok);
        assert!(st.twap_fdv_quote.unwrap().0 < 100_000 * NEAR, "spike must not lift TWAP over m1");
        // sustained at m1 for > window
        for i in 0..14 {
            observe_at(&mut c, 5_800 + i * 300, m1 + 50);
        }
        testing_env!(ctx("anyone.testnet", 5_800 + 13 * 300 + 10).build());
        assert_eq!(c.qualify(1), 1);
        let l = c.get_lock(1).unwrap();
        assert!(l.milestones[0].qualified_at.is_some());
        assert!(l.milestones[1].qualified_at.is_none());
        // claim delay not passed yet
        assert_eq!(c.claimable(1, acc("alice.testnet")).0, 0);
        testing_env!(ctx("anyone.testnet", 5_800 + 13 * 300 + 10 + 600).build());
        assert_eq!(c.claimable(1, acc("alice.testnet")).0, 250);
        assert_eq!(c.claimable(1, acc("bob.testnet")).0, 750);
        assert_eq!(c.claimable(1, acc("carol.testnet")).0, 0);
    }

    #[test]
    #[should_panic(expected = "too few observations")]
    fn qualify_needs_observations() {
        let mut c = Contract::new(acc("coord.kyp.testnet"));
        fund(&mut c);
        observe_at(&mut c, 2_000, 0);
        observe_at(&mut c, 5_700, 0);
        testing_env!(ctx("anyone.testnet", 5_700).build());
        c.qualify(1);
    }

    #[test]
    #[should_panic(expected = "too soon")]
    fn record_rate_limited() {
        let mut c = Contract::new(acc("coord.kyp.testnet"));
        fund(&mut c);
        testing_env!(ctx("anyone.testnet", 2_000).build());
        let _ = c.record(1);
        testing_env!(ctx("anyone.testnet", 2_100).build());
        let _ = c.record(1);
    }

    #[test]
    fn claim_marks_and_rollback_restores() {
        let mut c = Contract::new(acc("coord.kyp.testnet"));
        fund(&mut c);
        let hi = point_for_fdv(2_000_000 * NEAR);
        for i in 0..14 {
            observe_at(&mut c, 2_000 + i * 300, hi);
        }
        let t = 2_000 + 13 * 300 + 1;
        testing_env!(ctx("anyone.testnet", t).build());
        assert_eq!(c.qualify(1), 2);
        testing_env!(ctx("alice.testnet", t + 600).build());
        let _ = c.claim(1);
        assert_eq!(c.get_position(1, acc("alice.testnet")).unwrap().claimed.0, 1_000);
        assert_eq!(c.claimable(1, acc("alice.testnet")).0, 0);
        // simulate failed transfer callback
        testing_env!(ctx("lock.kyp.testnet", t + 601).build());
        c.on_claimed(1, acc("alice.testnet"), U128(1_000), Err(PromiseError::Failed));
        assert_eq!(c.claimable(1, acc("alice.testnet")).0, 1_000);
        assert_eq!(c.get_lock(1).unwrap().total_claimed.0, 0);
    }

    #[test]
    fn add_position_same_terms() {
        let mut c = Contract::new(acc("coord.kyp.testnet"));
        fund(&mut c);
        testing_env!(ctx("owl.kyp.testnet", 3_000).build());
        let msg = LockMsg::Add(kyp_common::LockAddMsg { launch_id: 1, account_id: acc("whale.testnet") });
        let _ = c.ft_on_transfer(acc("coord.kyp.testnet"), U128(500), serde_json::to_string(&msg).unwrap());
        let l = c.get_lock(1).unwrap();
        assert_eq!(l.total_locked.0, 4_500);
        assert_eq!(l.positions_count, 3);
    }

    #[test]
    fn ignores_wrong_pool_and_paused() {
        let mut c = Contract::new(acc("coord.kyp.testnet"));
        fund(&mut c);
        testing_env!(ctx("lock.kyp.testnet", 2_000).build());
        let mut p = pool(0);
        p.pool_id = "evil".into();
        assert!(c.internal_observe(1, p, SUPPLY).is_none());
        let mut p = pool(0);
        p.state = Some("Paused".into());
        assert!(c.internal_observe(1, p, SUPPLY).is_none());
        assert_eq!(c.get_lock(1).unwrap().observations_count, 0);
    }
}
