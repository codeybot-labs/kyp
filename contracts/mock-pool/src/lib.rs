//! MOCK — a tiny stand-in for RHEA DCL (`dclv2.ref-dev.testnet`) used by tests and the
//! demo deployment. It implements exactly the subset of the DCL interface KYP calls,
//! with the same method names and JSON shapes:
//!
//! * `storage_deposit`, `create_pool(token_a, token_b, fee, init_point)`
//! * `ft_on_transfer` with msg `""` (deposit), `add_liquidity(...)` -> lpt id
//! * `get_pool(pool_id)` -> `{pool_id, token_x, token_y, fee, point_delta, current_point, liquidity, liquidity_x, state}`
//!
//! It does NOT swap or compute concentrated liquidity. `liquidity` is simply the sum of
//! raw amounts added. Price moves are simulated by the owner via `mock_set_point`.

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise, PromiseOrValue};
use std::collections::HashMap;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Pools,
    Deposits,
    ChargedFees,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PoolView {
    pub pool_id: String,
    pub token_x: AccountId,
    pub token_y: AccountId,
    pub fee: u32,
    pub point_delta: i32,
    pub current_point: i32,
    pub liquidity: U128,
    pub liquidity_x: U128,
    pub total_x: U128,
    pub total_y: U128,
    pub state: String,
    pub positions: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    pools: IterableMap<String, PoolView>,
    deposits: LookupMap<(AccountId, AccountId), u128>,
    charged_fees: LookupMap<String, (u128, u128)>,
}

fn point_delta_for_fee(fee: u32) -> i32 {
    match fee {
        100 => 1,
        400 => 8,
        2000 => 40,
        10000 => 200,
        _ => env::panic_str("unsupported fee tier"),
    }
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self { owner_id, pools: IterableMap::new(Key::Pools), deposits: LookupMap::new(Key::Deposits), charged_fees: LookupMap::new(Key::ChargedFees) }
    }

    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> near_sdk::serde_json::Value {
        let _ = (account_id, registration_only);
        near_sdk::serde_json::json!({"total": env::attached_deposit(), "available": "0"})
    }

    #[payable]
    pub fn create_pool(&mut self, token_a: AccountId, token_b: AccountId, fee: u32, init_point: i32) -> String {
        require!(token_a != token_b, "same token");
        let (x, y) = if token_a.as_str() < token_b.as_str() { (token_a, token_b) } else { (token_b, token_a) };
        let pool_id = format!("{}|{}|{}", x, y, fee);
        require!(!self.pools.contains_key(&pool_id), "pool already exists");
        let delta = point_delta_for_fee(fee);
        self.pools.insert(
            pool_id.clone(),
            PoolView {
                pool_id: pool_id.clone(),
                token_x: x,
                token_y: y,
                fee,
                point_delta: delta,
                current_point: init_point,
                liquidity: U128(0),
                liquidity_x: U128(0),
                total_x: U128(0),
                total_y: U128(0),
                state: "Running".into(),
                positions: 0,
            },
        );
        pool_id
    }

    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(msg.is_empty() || msg == "\"Deposit\"", "mock pool only accepts deposits");
        let token = env::predecessor_account_id();
        let key = (sender_id, token);
        let cur = self.deposits.get(&key).copied().unwrap_or(0);
        self.deposits.insert(key, cur + amount.0);
        PromiseOrValue::Value(U128(0))
    }

    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn add_liquidity(
        &mut self,
        pool_id: String,
        left_point: i32,
        right_point: i32,
        amount_x: U128,
        amount_y: U128,
        min_amount_x: U128,
        min_amount_y: U128,
    ) -> String {
        let _ = (min_amount_x, min_amount_y);
        require!(left_point < right_point, "bad range");
        let caller = env::predecessor_account_id();
        let pool = self.pools.get_mut(&pool_id).expect("no such pool");
        require!(left_point % pool.point_delta == 0 && right_point % pool.point_delta == 0, "points must be multiples of point_delta");
        for (tok, amt) in [(pool.token_x.clone(), amount_x.0), (pool.token_y.clone(), amount_y.0)] {
            if amt == 0 { continue; }
            let key = (caller.clone(), tok);
            let cur = self.deposits.get(&key).copied().unwrap_or(0);
            require!(cur >= amt, "insufficient deposit");
            self.deposits.insert(key, cur - amt);
        }
        pool.liquidity = U128(pool.liquidity.0 + amount_x.0 + amount_y.0);
        pool.liquidity_x = U128(pool.liquidity_x.0 + amount_x.0);
        pool.total_x = U128(pool.total_x.0 + amount_x.0);
        pool.total_y = U128(pool.total_y.0 + amount_y.0);
        pool.positions += 1;
        format!("{}#{}", pool_id, pool.positions)
    }

    pub fn get_pool(&self, pool_id: String) -> Option<PoolView> {
        self.pools.get(&pool_id).cloned()
    }

    pub fn list_pools(&self) -> Vec<PoolView> {
        self.pools.values().cloned().collect()
    }

    pub fn get_deposit(&self, account_id: AccountId, token_id: AccountId) -> U128 {
        U128(self.deposits.get(&(account_id, token_id)).copied().unwrap_or(0))
    }

    pub fn get_user_asset(&self, account_id: AccountId, token_id: AccountId) -> U128 {
        self.get_deposit(account_id, token_id)
    }

    pub fn list_user_assets(&self, account_id: AccountId) -> HashMap<AccountId, U128> {
        let mut out = HashMap::new();
        for pool in self.pools.values() {
            for tok in [pool.token_x.clone(), pool.token_y.clone()] {
                let amt = self.deposits.get(&(account_id.clone(), tok.clone())).copied().unwrap_or(0);
                if amt > 0 {
                    out.insert(tok, U128(amt));
                }
            }
        }
        out
    }

    /// Credits charged trading fees into the caller's internal deposit. `0,0` means all.
    pub fn claim_charged_fee(&mut self, pool_id: String, amount_x: U128, amount_y: U128) {
        let pool = self.pools.get(&pool_id).expect("no such pool");
        let (cx, cy) = self.charged_fees.get(&pool_id).copied().unwrap_or((0, 0));
        let take_x = if amount_x.0 == 0 { cx } else { amount_x.0.min(cx) };
        let take_y = if amount_y.0 == 0 { cy } else { amount_y.0.min(cy) };
        require!(take_x > 0 || take_y > 0, "nothing to claim");
        self.charged_fees.insert(pool_id.clone(), (cx - take_x, cy - take_y));
        let caller = env::predecessor_account_id();
        for (tok, amt) in [(pool.token_x.clone(), take_x), (pool.token_y.clone(), take_y)] {
            if amt == 0 { continue; }
            let key = (caller.clone(), tok);
            let cur = self.deposits.get(&key).copied().unwrap_or(0);
            self.deposits.insert(key, cur + amt);
        }
    }

    #[payable]
    pub fn withdraw_asset(&mut self, token_id: AccountId, amount: U128) -> Promise {
        require!(amount.0 > 0, "amount must be > 0");
        let caller = env::predecessor_account_id();
        let key = (caller.clone(), token_id.clone());
        let cur = self.deposits.get(&key).copied().unwrap_or(0);
        require!(cur >= amount.0, "insufficient deposit");
        self.deposits.insert(key, cur - amount.0);
        Promise::new(token_id).function_call(
            "ft_transfer",
            near_sdk::serde_json::json!({"receiver_id": caller, "amount": amount, "memo": "KYP DCL withdraw"}).to_string().into_bytes(),
            NearToken::from_yoctonear(1),
            near_sdk::Gas::from_tgas(10),
        )
    }

    /// MOCK ONLY: accrue trading fees on a pool, claimable by the LP via `claim_charged_fee`.
    pub fn mock_add_charged_fee(&mut self, pool_id: String, amount_x: U128, amount_y: U128) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
        require!(self.pools.contains_key(&pool_id), "no such pool");
        let (cx, cy) = self.charged_fees.get(&pool_id).copied().unwrap_or((0, 0));
        self.charged_fees.insert(pool_id, (cx + amount_x.0, cy + amount_y.0));
    }

    /// MOCK ONLY: simulate trading moving the price.
    pub fn mock_set_point(&mut self, pool_id: String, point: i32) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
        self.pools.get_mut(&pool_id).expect("no such pool").current_point = point;
    }

    /// MOCK ONLY: simulate liquidity changes.
    pub fn mock_set_liquidity(&mut self, pool_id: String, liquidity: U128) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
        self.pools.get_mut(&pool_id).expect("no such pool").liquidity = liquidity;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId { s.parse().unwrap() }

    #[test]
    fn create_deposit_add_and_view() {
        let mut c = VMContextBuilder::new();
        c.predecessor_account_id(acc("coord.testnet"));
        testing_env!(c.build());
        let mut p = Contract::new(acc("owner.testnet"));
        let id = p.create_pool(acc("wrap.testnet"), acc("owl.testnet"), 10000, 6800);
        assert_eq!(id, "owl.testnet|wrap.testnet|10000");
        c.predecessor_account_id(acc("owl.testnet"));
        testing_env!(c.build());
        let _ = p.ft_on_transfer(acc("coord.testnet"), U128(100), "".into());
        c.predecessor_account_id(acc("coord.testnet"));
        testing_env!(c.build());
        let lpt = p.add_liquidity(id.clone(), 7000, 800000, U128(100), U128(0), U128(0), U128(0));
        assert_eq!(lpt, format!("{id}#1"));
        let v = p.get_pool(id).unwrap();
        assert_eq!(v.liquidity.0, 100);
        assert_eq!(v.current_point, 6800);
    }
}
