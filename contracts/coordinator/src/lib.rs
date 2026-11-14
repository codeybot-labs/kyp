//! KYP coordinator: presale escrow + launch coordinator.
//!
//! Lifecycle of a launch:
//! 1. `create_launch` (launcher, payable): validates public terms, deploys the NEP-141 token as
//!    a sub-account with the whole supply minted to this contract. Status `Creating` -> `Open`.
//! 2. Presalers send the quote token (wNEAR) with `ft_transfer_call(msg = Deposit{launch_id, salt})`.
//!    `sha256("{account}:{salt}")` must match an allowlisted slot hash. Per-wallet min/max and the
//!    hard cap are enforced; any excess is refunded by the NEP-141 resolve step.
//! 3. `launch` (launcher, payable, before `sale_end`): one transaction whose promise chain
//!    a. settles every fill at ONE price (`tokens = quote x supply / opening_fdv`) and funds the
//!       lock with all presale tokens (`ft_transfer_call` -> lock),
//!    b. creates the DCL pool at that same price,
//!    c. deposits the remaining supply + all presale proceeds into the pool,
//!    d. adds single-sided liquidity ranges (token above / quote below the opening price).
//!    Each step has a callback; a failed step leaves the launch `Launching` with progress flags
//!    and `resume_launch` continues from the first incomplete step. Presale tokens never touch
//!    the launcher's or presalers' wallets. LP positions are owned by this contract and there
//!    is no method to remove them.
//! 4. Post-launch: `reveal_next_wave` (permissionless, on schedule), `BuyReserved` for named
//!    reserved slots, fee routing via `Fees` + `distribute_fees`, `collect_fees` to claim DCL trading fees, `pay_bounty` from the community share.
//! 5. If the launcher never launches by `sale_end`, or cancels, presalers `withdraw`.

mod types;

pub use types::*;

use kyp_common::{
    aligned_bounds, assert_valid_milestones, dcl_pool_id, dcl_safe_left, dcl_safe_right, init_point_for_fdv, mul_div,
    tokens_for_quote, FeeExtra, LockAddMsg, LockFundMsg, LockMsg, BPS_DENOM, DEFAULT_DECIMALS,
    DEFAULT_TOTAL_SUPPLY, MAX_POINT, MAX_PRESALE_CAP_BPS, MAX_PRESALERS, MAX_SALE_WINDOW_SEC,
};
use std::collections::HashMap;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, LazyOption};
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

const GAS_TOKEN_INIT: Gas = Gas::from_tgas(30);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FT_TRANSFER_CALL_LOCK: Gas = Gas::from_tgas(80);
const GAS_FT_TRANSFER_CALL_POOL: Gas = Gas::from_tgas(50);
const GAS_POOL_STORAGE: Gas = Gas::from_tgas(10);
const GAS_POOL_CREATE: Gas = Gas::from_tgas(20);
const GAS_ADD_LIQUIDITY: Gas = Gas::from_tgas(25);
const GAS_CB: Gas = Gas::from_tgas(10);
const GAS_CB_ADD: Gas = Gas::from_tgas(10);
const GAS_CB_SMALL: Gas = Gas::from_tgas(5);
const GAS_DCL_VIEW: Gas = Gas::from_tgas(10);
const GAS_DCL_CLAIM: Gas = Gas::from_tgas(20);
const GAS_DCL_WITHDRAW: Gas = Gas::from_tgas(40);
const GAS_CB_COLLECT: Gas = Gas::from_tgas(30);
const GAS_DCL_SWAP: Gas = Gas::from_tgas(250);
const GAS_CB_BUYBACK: Gas = Gas::from_tgas(40);
const GAS_FT_BALANCE: Gas = Gas::from_tgas(10);
const MAX_BUYBACK_BPS: u16 = 2_000;
/// Kept free when checking whether a split step fits in the remaining gas.
const GAS_STEP_RESERVE: Gas = Gas::from_tgas(5);
const STEP_GAS_KEY: &[u8] = b"step_gas";

fn fee_extra_key(launch_id: u64) -> Vec<u8> {
    format!("fee_x:{launch_id}").into_bytes()
}

fn write_fee_extra(launch_id: u64, extra: &FeeExtra) {
    env::storage_write(&fee_extra_key(launch_id), &near_sdk::borsh::to_vec(extra).unwrap());
}

fn read_fee_extra(launch_id: u64) -> Option<FeeExtra> {
    env::storage_read(&fee_extra_key(launch_id)).and_then(|b| near_sdk::borsh::from_slice(&b).ok())
}

fn community_paid_key(launch_id: u64, token_id: &AccountId) -> Vec<u8> {
    format!("fee_cp:{launch_id}:{token_id}").into_bytes()
}

fn read_community_paid(launch_id: u64, token_id: &AccountId) -> u128 {
    env::storage_read(&community_paid_key(launch_id, token_id))
        .and_then(|b| near_sdk::borsh::from_slice(&b).ok())
        .unwrap_or(0)
}

fn write_community_paid(launch_id: u64, token_id: &AccountId, amount: u128) {
    let key = community_paid_key(launch_id, token_id);
    if amount == 0 {
        env::storage_remove(&key);
    } else {
        env::storage_write(&key, &near_sdk::borsh::to_vec(&amount).unwrap());
    }
}

fn buyback_bps_key(launch_id: u64) -> Vec<u8> {
    format!("fee_bb:{launch_id}").into_bytes()
}
fn read_buyback_bps(launch_id: u64) -> u16 {
    env::storage_read(&buyback_bps_key(launch_id))
        .and_then(|b| near_sdk::borsh::from_slice(&b).ok())
        .unwrap_or(0)
}
fn write_buyback_bps(launch_id: u64, bps: u16) {
    let key = buyback_bps_key(launch_id);
    if bps == 0 {
        env::storage_remove(&key);
    } else {
        env::storage_write(&key, &near_sdk::borsh::to_vec(&bps).unwrap());
    }
}
fn buyback_paid_key(launch_id: u64, token_id: &AccountId) -> Vec<u8> {
    format!("fee_bp:{launch_id}:{token_id}").into_bytes()
}
fn read_buyback_paid(launch_id: u64, token_id: &AccountId) -> u128 {
    env::storage_read(&buyback_paid_key(launch_id, token_id))
        .and_then(|b| near_sdk::borsh::from_slice(&b).ok())
        .unwrap_or(0)
}
fn write_buyback_paid(launch_id: u64, token_id: &AccountId, amount: u128) {
    let key = buyback_paid_key(launch_id, token_id);
    if amount == 0 {
        env::storage_remove(&key);
    } else {
        env::storage_write(&key, &near_sdk::borsh::to_vec(&amount).unwrap());
    }
}
fn buyback_pend_key(launch_id: u64) -> Vec<u8> {
    format!("fee_bpend:{launch_id}").into_bytes()
}

/// In-flight buyback; stored under a separate key so Launch Borsh stays unchanged.
#[near(serializers = [borsh])]
struct BuybackPending {
    quote_reserved: u128,
    min_output: u128,
    token_wallet_before: u128,
    token_dcl_before: u128,
}
fn read_buyback_pending(launch_id: u64) -> Option<BuybackPending> {
    env::storage_read(&buyback_pend_key(launch_id)).and_then(|b| near_sdk::borsh::from_slice(&b).ok())
}
fn write_buyback_pending(launch_id: u64, p: Option<&BuybackPending>) {
    let key = buyback_pend_key(launch_id);
    match p {
        Some(p) => { env::storage_write(&key, &near_sdk::borsh::to_vec(p).unwrap()); }
        None => { env::storage_remove(&key); }
    }
}
const LIQ_TRY_PREFIX: &[u8] = b"lq_try";
/// Far-end shrink per failed add_liquidity attempt, in point_delta units (7 x 200 = 1400 points).
const NUDGE_STEPS: i32 = 7;
const MAX_LIQ_TRIES: u8 = 40;
/// Max far-end moves (point_delta each) when searching for a range the DCL can settle.
const SAFE_RANGE_STEPS: u32 = 48;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Launches,
    TokenCode,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub owner_id: AccountId,
    pub config: PlatformConfig,
    launches: IterableMap<u64, Launch>,
    token_code: LazyOption<Vec<u8>>,
    next_id: u64,
}

fn now_sec() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

fn emit(event: &str, data: serde_json::Value) {
    log!(
        "EVENT_JSON:{}",
        json!({"standard": "kyp", "version": "1.0.0", "event": event, "data": [data]})
    );
}

pub fn slot_hash(account: &AccountId, salt: &str) -> Hash {
    env::sha256_array(format!("{}:{}", account, salt).as_bytes())
}

fn valid_symbol(s: &str) -> bool {
    (2..=10).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, config: PlatformConfig) -> Self {
        require!(config.max_presale_cap_bps <= MAX_PRESALE_CAP_BPS, "cap above 50%");
        Self {
            owner_id,
            config,
            launches: IterableMap::new(Key::Launches),
            token_code: LazyOption::new(Key::TokenCode, None),
            next_id: 1,
        }
    }

    // ------------------------------------------------------------------ admin

    /// Owner uploads the KYP token wasm (raw bytes as the call input).
    pub fn set_token_code(&mut self) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
        let code = env::input().expect("no input");
        require!(code.len() > 1000, "code too small");
        self.token_code.set(Some(code));
    }

    /// Owner can change platform config for future launches. Existing launches keep their
    /// pool/lock settings snapshotted at create time. The 50% ceiling is a constant.
    pub fn set_config(&mut self, config: PlatformConfig) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
        require!(config.max_presale_cap_bps <= MAX_PRESALE_CAP_BPS, "cap above 50%");
        self.config = config;
    }

    pub fn get_config(&self) -> PlatformConfig {
        self.config.clone()
    }

    /// Owner sets per-step gas for the pool steps (see `StepGas`). Applies to launches that are
    /// launching now or later.
    pub fn set_step_gas(&mut self, step_gas: StepGas) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
        require!(step_gas.pool_deposit_tgas >= 20 && step_gas.pool_deposit_tgas <= 990, "pool_deposit_tgas 20-990");
        require!(step_gas.add_liquidity_tgas >= 10 && step_gas.add_liquidity_tgas <= 990, "add_liquidity_tgas 10-990");
        env::storage_write(STEP_GAS_KEY, &near_sdk::borsh::to_vec(&step_gas).unwrap());
    }

    pub fn get_step_gas(&self) -> StepGas {
        env::storage_read(STEP_GAS_KEY)
            .and_then(|b| near_sdk::borsh::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn has_token_code(&self) -> bool {
        self.token_code.is_some()
    }

    // ------------------------------------------------------------------ create

    #[payable]
    pub fn create_launch(&mut self, params: LaunchParams) -> Promise {
        let launcher = env::predecessor_account_id();
        let attached = env::attached_deposit();
        require!(attached >= self.config.token_account_deposit, "attach token_account_deposit");
        let before = env::storage_usage();
        let launch = self.build_launch(launcher.clone(), params);
        let id = launch.id;
        let token_id = launch.token_id.clone();
        let code = self.token_code.get().clone().expect("token code not set");
        let init = json!({
            "owner_id": env::current_account_id(),
            "total_supply": U128(launch.total_supply),
            "metadata": {
                "spec": "ft-1.0.0",
                "name": launch.name,
                "symbol": launch.symbol,
                "icon": launch.icon,
                "reference": null,
                "reference_hash": null,
                "decimals": launch.decimals,
            },
            "register": [env::current_account_id(), self.config.lock_contract, launch.pool_contract],
            "auto_register_senders": [env::current_account_id(), self.config.lock_contract],
        });
        self.launches.insert(id, launch);
        self.launches.flush();
        // launcher pays for the launch record's storage on the coordinator
        let storage_cost = env::storage_byte_cost().as_yoctonear() * (env::storage_usage().saturating_sub(before)) as u128;
        require!(
            attached.as_yoctonear() >= self.config.token_account_deposit.as_yoctonear() + storage_cost,
            format!("attach token_account_deposit + {} yocto for launch storage", storage_cost)
        );
        let to_token = NearToken::from_yoctonear(attached.as_yoctonear() - storage_cost);
        emit("launch_created", json!({"launch_id": id, "token_id": token_id, "launcher": launcher}));
        Promise::new(token_id)
            .create_account()
            .transfer(to_token)
            .deploy_contract(code)
            .function_call("new", init.to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_TOKEN_INIT)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CB)
                    .on_token_deployed(id, launcher, U128(to_token.as_yoctonear())),
            )
    }

    #[private]
    pub fn on_token_deployed(
        &mut self,
        launch_id: u64,
        launcher: AccountId,
        attached: U128,
        #[callback_result] res: Result<(), PromiseError>,
    ) -> bool {
        let l = self.launches.get_mut(&launch_id).expect("no launch");
        if res.is_ok() {
            l.status = LaunchStatus::Open;
            emit("launch_open", json!({"launch_id": launch_id}));
            true
        } else {
            l.status = LaunchStatus::Failed;
            // batch failed -> attached NEAR came back to us; return it to the launcher
            Promise::new(launcher).transfer(NearToken::from_yoctonear(attached.0)).detach();
            emit("launch_failed", json!({"launch_id": launch_id, "reason": "token deploy failed"}));
            false
        }
    }

    pub(crate) fn build_launch(&mut self, launcher: AccountId, p: LaunchParams) -> Launch {
        let now = now_sec();
        let cfg = &self.config;
        require!(valid_symbol(&p.symbol), "symbol must be 2-10 chars A-Z0-9");
        require!(!p.name.is_empty() && p.name.len() <= 64, "name 1-64 chars");
        require!(p.description.len() <= 1000, "description too long");
        if let Some(i) = &p.icon {
            require!(i.len() <= 4096, "icon too large (use a small data URI or URL)");
        }
        require!(cfg.allowed_quote_tokens.contains(&p.quote_token_id), "quote token not allowed (wNEAR only)");
        let supply = p.total_supply.map(|x| x.0).unwrap_or(DEFAULT_TOTAL_SUPPLY);
        let decimals = p.decimals.unwrap_or(DEFAULT_DECIMALS);
        require!(supply > 0 && p.opening_fdv_quote.0 > 0, "supply and opening FDV must be > 0");
        require!(p.presale_cap_bps > 0 && p.presale_cap_bps <= cfg.max_presale_cap_bps, "presale cap above platform max (50%)");
        require!(p.wallet_min.0 > 0 && p.wallet_min.0 <= p.wallet_max.0, "need 0 < wallet_min <= wallet_max");
        require!(p.sale_end > p.sale_start, "sale_end must be after sale_start");
        require!(p.sale_end > now, "sale_end in the past");
        require!(p.sale_start <= now + 86_400, "sale_start at most 1 day out");
        require!(p.sale_end - p.sale_start.max(now) <= MAX_SALE_WINDOW_SEC, "presale window max 7 days");
        assert_valid_milestones(&p.milestones);
        require!(p.milestones[0].target_fdv_quote.0 > p.opening_fdv_quote.0, "first milestone must be above opening FDV");
        p.twap.assert_valid();
        let fee_extra = p.fee_extra.clone().filter(|e| !e.is_empty());
        p.fee_split.assert_valid_with_extra(fee_extra.as_ref());
        require!(p.reveal.waves >= 1 && p.reveal.waves <= 10, "reveal waves 1-10");
        let n_slots = p.allowlist.len() + p.reserved.len();
        require!(!p.allowlist.is_empty(), "allowlist empty");
        require!(n_slots <= MAX_PRESALERS, "too many slots");

        let mut slots: Vec<Slot> = Vec::with_capacity(n_slots);
        for h in p.allowlist.iter() {
            slots.push(Slot { hash: from_hex(h), kind: SlotKind::Open, account: None, deposit: 0, tokens: 0, pending: false });
        }
        for r in p.reserved.iter() {
            require!(r.quote_amount.0 > 0, "reserved quote must be > 0");
            slots.push(Slot {
                hash: from_hex(&r.hash),
                kind: SlotKind::Reserved { quote_amount: r.quote_amount },
                account: None,
                deposit: 0,
                tokens: 0,
                pending: false,
            });
        }
        let mut seen: Vec<Hash> = slots.iter().map(|s| s.hash).collect();
        seen.sort();
        seen.dedup();
        require!(seen.len() == slots.len(), "duplicate slot hash");

        let cap_tokens = supply * p.presale_cap_bps as u128 / BPS_DENOM as u128;
        let reserved_tokens: u128 = p.reserved.iter().map(|r| tokens_for_quote(r.quote_amount.0, supply, p.opening_fdv_quote.0)).sum();
        require!(reserved_tokens < cap_tokens, "reserved slots exceed the presale cap");
        let open_cap_quote = mul_div(cap_tokens - reserved_tokens, p.opening_fdv_quote.0, supply);
        require!(p.min_raise.0 <= open_cap_quote, "min_raise above the open cap");
        require!(p.wallet_min.0 <= open_cap_quote, "wallet_min above the open cap");

        let id = self.next_id;
        self.next_id += 1;
        if let Some(e) = fee_extra {
            write_fee_extra(id, &e);
        }
        if let Some(bps) = p.buyback_bps.filter(|b| *b > 0) {
            require!(bps <= MAX_BUYBACK_BPS, "buyback_bps is capped at 20%");
            require!(bps <= p.fee_split.liquidity_bps, "buyback_bps cannot exceed the liquidity share");
            write_buyback_bps(id, bps);
        }
        let token_id: AccountId = format!("{}-{}.{}", p.symbol.to_lowercase(), id, env::current_account_id())
            .parse()
            .expect("token account id too long");
        let (pool_id, token_is_x) = dcl_pool_id(&token_id, &p.quote_token_id, cfg.pool_fee);
        let init_point = init_point_for_fdv(p.opening_fdv_quote.0, supply, token_is_x, cfg.point_delta);

        Launch {
            id,
            launcher,
            status: LaunchStatus::Creating,
            created_at: now,
            name: p.name,
            symbol: p.symbol,
            icon: p.icon,
            description: p.description,
            terms_uri: p.terms_uri,
            token_id,
            quote_token_id: p.quote_token_id,
            total_supply: supply,
            decimals,
            opening_fdv_quote: p.opening_fdv_quote.0,
            presale_cap_bps: p.presale_cap_bps,
            min_raise: p.min_raise.0,
            wallet_min: p.wallet_min.0,
            wallet_max: p.wallet_max.0,
            open_cap_quote,
            slots,
            sale_start: p.sale_start,
            sale_end: p.sale_end,
            milestones: p.milestones,
            twap: p.twap,
            reveal: p.reveal,
            fee_split: p.fee_split,
            total_raised: 0,
            presale_tokens: 0,
            reserved_tokens,
            lp_tokens: 0,
            pool_contract: cfg.pool_contract.clone(),
            pool_fee: cfg.pool_fee,
            pool_id,
            token_is_x,
            init_point,
            progress: LaunchProgress::default(),
            near_budget: 0,
            launched_at: None,
            revealed_waves: 0,
            wave_order: vec![],
            lpt_ids: vec![],
            fee_balances: vec![],
            fees_distributed_quote: 0,
        }
    }

    // ------------------------------------------------------------------ deposits

    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        let parsed: CoordinatorMsg = serde_json::from_str(&msg).expect("invalid msg");
        match parsed {
            CoordinatorMsg::Deposit { launch_id, salt } => {
                let refund = self.internal_deposit(launch_id, &token, &sender_id, amount.0, &salt);
                PromiseOrValue::Value(U128(refund))
            }
            CoordinatorMsg::BuyReserved { launch_id, salt } => {
                self.internal_buy_reserved(launch_id, &token, sender_id, amount.0, &salt)
            }
            CoordinatorMsg::Fees { launch_id } => {
                let l = self.launches.get_mut(&launch_id).expect("no launch");
                require!(l.status == LaunchStatus::Live, "launch not live");
                match l.fee_balances.iter_mut().find(|(t, _)| *t == token) {
                    Some((_, b)) => *b += amount.0,
                    None => l.fee_balances.push((token.clone(), amount.0)),
                }
                emit("fees_received", json!({"launch_id": launch_id, "token_id": token, "amount": amount}));
                PromiseOrValue::Value(U128(0))
            }
        }
    }

    /// Returns the refunded (unused) amount.
    pub(crate) fn internal_deposit(&mut self, launch_id: u64, token: &AccountId, sender: &AccountId, amount: u128, salt: &str) -> u128 {
        let now = now_sec();
        let l = self.launches.get_mut(&launch_id).expect("no launch");
        require!(l.status == LaunchStatus::Open, "presale not open");
        require!(*token == l.quote_token_id, "wrong payment token (wNEAR only)");
        require!(now >= l.sale_start, "presale has not started");
        require!(now < l.sale_end, "presale ended");
        let h = slot_hash(sender, salt);
        let slot = l
            .slots
            .iter_mut()
            .find(|s| s.hash == h)
            .unwrap_or_else(|| env::panic_str("wallet not on the allowlist (check account + invite code)"));
        require!(slot.kind == SlotKind::Open, "this is a reserved slot; it opens after launch");
        let room_wallet = l.wallet_max - slot.deposit;
        let room_cap = l.open_cap_quote - l.total_raised;
        let accept = amount.min(room_wallet).min(room_cap);
        require!(accept > 0, "wallet max or presale cap reached");
        require!(slot.deposit + accept >= l.wallet_min, "below per-wallet minimum");
        slot.deposit += accept;
        slot.account = Some(sender.clone());
        l.total_raised += accept;
        emit("presale_deposit", json!({"launch_id": launch_id, "amount": U128(accept), "total_raised": U128(l.total_raised)}));
        amount - accept
    }

    /// Withdraw an escrowed deposit if the launch was cancelled or never launched by `sale_end`.
    pub fn withdraw(&mut self, launch_id: u64) -> Promise {
        let now = now_sec();
        let who = env::predecessor_account_id();
        let l = self.launches.get_mut(&launch_id).expect("no launch");
        let refundable = l.status == LaunchStatus::Cancelled || (l.status == LaunchStatus::Open && now >= l.sale_end);
        require!(refundable, "deposits are committed until the launch is cancelled or misses sale_end");
        let idx = l.slots.iter().position(|s| s.account.as_ref() == Some(&who) && s.deposit > 0).expect("no deposit");
        let amount = l.slots[idx].deposit;
        l.slots[idx].deposit = 0;
        l.total_raised -= amount;
        let quote = l.quote_token_id.clone();
        Promise::new(quote)
            .function_call(
                "ft_transfer",
                json!({"receiver_id": who, "amount": U128(amount), "memo": "KYP presale refund"}).to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_FT_TRANSFER,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB_SMALL).on_withdrawn(launch_id, idx as u32, U128(amount)))
    }

    #[private]
    pub fn on_withdrawn(&mut self, launch_id: u64, slot: u32, amount: U128, #[callback_result] res: Result<(), PromiseError>) -> bool {
        if res.is_ok() {
            return true;
        }
        let l = self.launches.get_mut(&launch_id).unwrap();
        l.slots[slot as usize].deposit += amount.0;
        l.total_raised += amount.0;
        false
    }

    pub fn cancel_launch(&mut self, launch_id: u64) {
        let l = self.launches.get_mut(&launch_id).expect("no launch");
        require!(env::predecessor_account_id() == l.launcher, "launcher only");
        require!(l.status == LaunchStatus::Open, "only an open presale can be cancelled");
        l.status = LaunchStatus::Cancelled;
        emit("launch_cancelled", json!({"launch_id": launch_id}));
    }

    // ------------------------------------------------------------------ launch

    /// Settle all fills at one price, fund the lock, create + seed the pool. Launcher only.
    #[payable]
    pub fn launch(&mut self, launch_id: u64) -> PromiseOrValue<bool> {
        let now = now_sec();
        let cfg_need = self.pool_near_needed();
        let l = self.launches.get_mut(&launch_id).expect("no launch");
        require!(env::predecessor_account_id() == l.launcher, "launcher only");
        require!(l.status == LaunchStatus::Open, "launch not open");
        require!(now < l.sale_end, "sale window over; presalers can withdraw");
        require!(l.total_raised > 0 && l.total_raised >= l.min_raise, "min raise not reached");
        require!(env::attached_deposit().as_yoctonear() >= cfg_need, "attach pool storage deposits");
        l.near_budget += env::attached_deposit().as_yoctonear();

        // single price settlement
        let mut presale_tokens = 0u128;
        for s in l.slots.iter_mut() {
            if s.kind == SlotKind::Open && s.deposit > 0 {
                s.tokens = tokens_for_quote(s.deposit, l.total_supply, l.opening_fdv_quote);
                presale_tokens += s.tokens;
            }
        }
        l.presale_tokens = presale_tokens;
        l.lp_tokens = l.total_supply - presale_tokens - l.reserved_tokens;
        l.status = LaunchStatus::Launching;
        // reveal order: smallest first, ties by slot hash
        let mut order: Vec<u16> = (0..l.slots.len() as u16)
            .filter(|i| l.slots[*i as usize].kind == SlotKind::Open && l.slots[*i as usize].deposit > 0)
            .collect();
        order.sort_by(|a, b| {
            let (sa, sb) = (&l.slots[*a as usize], &l.slots[*b as usize]);
            sa.deposit.cmp(&sb.deposit).then(sa.hash.cmp(&sb.hash))
        });
        l.wave_order = order;
        emit(
            "launch_settling",
            json!({"launch_id": launch_id, "total_raised": U128(l.total_raised), "presale_tokens": U128(presale_tokens), "lp_tokens": U128(l.lp_tokens), "init_point": l.init_point}),
        );
        self.next_step(launch_id)
    }

    /// Resume a launch whose promise chain stopped at a failed step (e.g. out of gas). Anyone
    /// may call; the launcher may need to attach more NEAR for pool storage.
    #[payable]
    pub fn resume_launch(&mut self, launch_id: u64) -> PromiseOrValue<bool> {
        let l = self.launches.get_mut(&launch_id).expect("no launch");
        require!(l.status == LaunchStatus::Launching, "launch is not in progress");
        l.near_budget += env::attached_deposit().as_yoctonear();
        self.next_step(launch_id)
    }

    fn pool_near_needed(&self) -> u128 {
        self.config.pool_storage_deposit.as_yoctonear()
            + self.config.pool_create_deposit.as_yoctonear()
            + 2 * self.config.liquidity_deposit.as_yoctonear()
    }

    fn spend(&mut self, launch_id: u64, amount: NearToken) -> NearToken {
        let l = self.launches.get_mut(&launch_id).unwrap();
        require!(l.near_budget >= amount.as_yoctonear(), "launch NEAR budget exhausted; resume_launch with a deposit");
        l.near_budget -= amount.as_yoctonear();
        amount
    }

    fn lock_fund_msg(l: &Launch) -> String {
        let positions: Vec<(AccountId, U128)> = l
            .slots
            .iter()
            .filter(|s| s.kind == SlotKind::Open && s.tokens > 0)
            .map(|s| (s.account.clone().unwrap(), U128(s.tokens)))
            .collect();
        serde_json::to_string(&LockMsg::Fund(LockFundMsg {
            launch_id: l.id,
            pool_contract: l.pool_contract.clone(),
            pool_id: l.pool_id.clone(),
            token_is_x: l.token_is_x,
            milestones: l.milestones.clone(),
            twap: l.twap.clone(),
            positions,
        }))
        .unwrap()
    }

    /// The add_liquidity ranges: (left, right, amount_x, amount_y) for token side and quote side.
    #[allow(dead_code)] // un-nudged ranges; used by tests
    pub(crate) fn liquidity_ranges(l: &Launch, point_delta: i32) -> [(i32, i32, u128, u128); 2] {
        Self::liquidity_ranges_nudged(l, point_delta, 0)
    }

    /// RHEA DCL sometimes charges a few hundred million yocto MORE than `amount_x` for a
    /// single-sided range and then panics computing the refund ("attempt to subtract with
    /// overflow", dcl_liquidity_api.rs:209). The ranges are checked with an exact port of the
    /// DCL's rounding (`kyp_common::dcl`) and the far end moved in until it settles. As a
    /// fallback, each failed attempt also pulls the far end in by `NUDGE_STEPS * attempt` points
    /// (never the end at the price).
    pub(crate) fn liquidity_ranges_nudged(l: &Launch, point_delta: i32, attempt: u8) -> [(i32, i32, u128, u128); 2] {
        let nudge = NUDGE_STEPS * point_delta * attempt as i32;
        // RHEA DCL (iZi-style) rejects right_point >= MAX_POINT and ranges with
        // right - left >= MAX_POINT ("E202: illegal point"), checked on dclv2.ref-dev.testnet.
        let (lo, hi) = aligned_bounds(point_delta);
        let hi = if hi >= MAX_POINT { hi - point_delta } else { hi };
        let max_width = (MAX_POINT - 1).div_euclid(point_delta) * point_delta;
        let a = l.init_point;
        let above = (a + point_delta, hi.min(a + point_delta + max_width) - nudge);
        let below = (lo.max(a - max_width) + nudge, a);
        let (tok, quo) = (l.lp_tokens, l.total_raised);
        // The range above the price is x-only, the one below y-only. Move each far end in until
        // RHEA DCL's own rounding charges no more than we offer (see kyp_common::dcl); otherwise
        // add_liquidity panics computing the refund.
        let (amt_x, amt_y) = if l.token_is_x { (tok, quo) } else { (quo, tok) };
        let above = (above.0, dcl_safe_right(above.0, above.1, point_delta, amt_x, SAFE_RANGE_STEPS));
        let below = (dcl_safe_left(below.0, below.1, point_delta, amt_y, SAFE_RANGE_STEPS), below.1);
        if l.token_is_x {
            // x-only above the price (token for sale), y-only below (quote bids)
            [(above.0, above.1, tok, 0), (below.0, below.1, 0, quo)]
        } else {
            // token is y: y-only below, quote (x) above
            [(below.0, below.1, 0, tok), (above.0, above.1, quo, 0)]
        }
    }

    fn next_step(&mut self, launch_id: u64) -> PromiseOrValue<bool> {
        let cfg = self.config.clone();
        let l = self.launches.get(&launch_id).unwrap().clone();
        let me = env::current_account_id();
        let p = &l.progress;
        if !p.lock_funded {
            return PromiseOrValue::Promise(
                Promise::new(l.token_id.clone())
                    .function_call(
                        "ft_transfer_call",
                        json!({"receiver_id": cfg.lock_contract, "amount": U128(l.presale_tokens), "msg": Self::lock_fund_msg(&l)})
                            .to_string()
                            .into_bytes(),
                        NearToken::from_yoctonear(1),
                        GAS_FT_TRANSFER_CALL_LOCK,
                    )
                    .then(Self::ext(me).with_static_gas(GAS_CB).with_unused_gas_weight(1).on_lock_funded(launch_id)),
            );
        }
        if !p.pool_created {
            let d1 = self.spend(launch_id, cfg.pool_storage_deposit);
            let d2 = self.spend(launch_id, cfg.pool_create_deposit);
            let (a, b) = (l.token_id.clone(), l.quote_token_id.clone());
            return PromiseOrValue::Promise(
                Promise::new(l.pool_contract.clone())
                    .function_call("storage_deposit", json!({"account_id": me, "registration_only": false}).to_string().into_bytes(), d1, GAS_POOL_STORAGE)
                    .function_call(
                        "create_pool",
                        json!({"token_a": a, "token_b": b, "fee": l.pool_fee, "init_point": l.init_point}).to_string().into_bytes(),
                        d2,
                        GAS_POOL_CREATE,
                    )
                    .then(Self::ext(me).with_static_gas(GAS_CB).with_unused_gas_weight(1).on_pool_created(launch_id)),
            );
        }
        let sg = self.get_step_gas();
        if sg.split_pool_steps && (!p.token_deposited || !p.quote_deposited) {
            // one deposit per step: token side first, then the presale proceeds
            let (which, token, amount, step) = if !p.token_deposited {
                (0u8, l.token_id.clone(), l.lp_tokens, "pool_deposit_token")
            } else {
                (1u8, l.quote_token_id.clone(), l.total_raised, "pool_deposit_quote")
            };
            let g = Gas::from_tgas(sg.pool_deposit_tgas);
            if !Self::fits(g.saturating_add(GAS_CB)) {
                return self.pause(launch_id, step, g.saturating_add(GAS_CB));
            }
            return PromiseOrValue::Promise(
                Self::deposit_to_pool_gas(&token, &l.pool_contract, amount, &cfg.pool_deposit_msg, g)
                    .then(Self::ext(me).with_static_gas(GAS_CB).with_unused_gas_weight(1).on_deposited(launch_id, vec![which])),
            );
        }
        if !p.token_deposited || !p.quote_deposited {
            let mut which: Vec<u8> = vec![];
            let mut promise: Option<Promise> = None;
            if !p.token_deposited {
                which.push(0);
                promise = Some(Self::deposit_to_pool(&l.token_id, &l.pool_contract, l.lp_tokens, &cfg.pool_deposit_msg));
            }
            if !p.quote_deposited {
                which.push(1);
                let q = Self::deposit_to_pool(&l.quote_token_id, &l.pool_contract, l.total_raised, &cfg.pool_deposit_msg);
                promise = Some(match promise {
                    Some(pr) => pr.and(q),
                    None => q,
                });
            }
            return PromiseOrValue::Promise(
                promise
                    .unwrap()
                    .then(Self::ext(me).with_static_gas(GAS_CB).with_unused_gas_weight(1).on_deposited(launch_id, which)),
            );
        }
        if sg.split_pool_steps && !p.liquidity_added {
            // one range per step; lpt_ids.len() = ranges already added
            let ranges = Self::liquidity_ranges_nudged(&l, cfg.point_delta, Self::liq_tries(launch_id));
            let i = l.lpt_ids.len().min(ranges.len() - 1);
            let g = Gas::from_tgas(sg.add_liquidity_tgas);
            if !Self::fits(g.saturating_add(GAS_CB_ADD)) {
                return self.pause(launch_id, "add_liquidity", g.saturating_add(GAS_CB_ADD));
            }
            let (left, right, ax, ay) = ranges[i];
            let d = self.spend(launch_id, cfg.liquidity_deposit);
            return PromiseOrValue::Promise(
                Promise::new(l.pool_contract.clone())
                    .function_call("add_liquidity", Self::add_liquidity_args(&l.pool_id, left, right, ax, ay), d, g)
                    .then(Self::ext(me).with_static_gas(GAS_CB_ADD).with_unused_gas_weight(1).on_liquidity_added(launch_id)),
            );
        }
        if !p.liquidity_added {
            let ranges = Self::liquidity_ranges_nudged(&l, cfg.point_delta, Self::liq_tries(launch_id));
            let d1 = self.spend(launch_id, cfg.liquidity_deposit);
            let d2 = self.spend(launch_id, cfg.liquidity_deposit);
            let mut pr = Promise::new(l.pool_contract.clone());
            for ((left, right, ax, ay), d) in ranges.iter().zip([d1, d2]) {
                pr = pr.function_call("add_liquidity", Self::add_liquidity_args(&l.pool_id, *left, *right, *ax, *ay), d, GAS_ADD_LIQUIDITY);
            }
            return PromiseOrValue::Promise(pr.then(Self::ext(me).with_static_gas(GAS_CB_ADD).on_liquidity_added(launch_id)));
        }
        // all steps done
        let l = self.launches.get_mut(&launch_id).unwrap();
        if l.status == LaunchStatus::Launching {
            l.status = LaunchStatus::Live;
            l.launched_at = Some(now_sec());
            let leftover = l.near_budget;
            l.near_budget = 0;
            let launcher = l.launcher.clone();
            emit("launch_live", json!({"launch_id": launch_id, "pool_id": l.pool_id}));
            if leftover > 0 {
                Promise::new(launcher).transfer(NearToken::from_yoctonear(leftover)).detach();
            }
        }
        PromiseOrValue::Value(true)
    }

    fn deposit_to_pool(token: &AccountId, pool: &AccountId, amount: u128, msg: &str) -> Promise {
        Self::deposit_to_pool_gas(token, pool, amount, msg, GAS_FT_TRANSFER_CALL_POOL)
    }

    fn deposit_to_pool_gas(token: &AccountId, pool: &AccountId, amount: u128, msg: &str, gas: Gas) -> Promise {
        Promise::new(token.clone()).function_call(
            "ft_transfer_call",
            json!({"receiver_id": pool, "amount": U128(amount), "msg": msg}).to_string().into_bytes(),
            NearToken::from_yoctonear(1),
            gas,
        )
    }

    fn add_liquidity_args(pool_id: &str, left: i32, right: i32, ax: u128, ay: u128) -> Vec<u8> {
        json!({
            "pool_id": pool_id, "left_point": left, "right_point": right,
            "amount_x": U128(ax), "amount_y": U128(ay),
            "min_amount_x": U128(0), "min_amount_y": U128(0)
        })
        .to_string()
        .into_bytes()
    }

    /// Does `need` (plus a small reserve) fit in this receipt's remaining gas?
    fn fits(need: Gas) -> bool {
        env::prepaid_gas().saturating_sub(env::used_gas()) >= need.saturating_add(GAS_STEP_RESERVE)
    }

    /// Stop the chain cleanly (progress so far is kept); `resume_launch` with enough gas continues.
    fn pause(&mut self, launch_id: u64, step: &str, need: Gas) -> PromiseOrValue<bool> {
        emit("launch_paused", json!({"launch_id": launch_id, "step": step, "need_tgas": need.as_tgas() + GAS_STEP_RESERVE.as_tgas() + 5}));
        PromiseOrValue::Value(false)
    }

    fn halt(&mut self, launch_id: u64, step: &str) -> PromiseOrValue<bool> {
        emit("launch_step_failed", json!({"launch_id": launch_id, "step": step}));
        PromiseOrValue::Value(false)
    }

    #[private]
    pub fn on_lock_funded(&mut self, launch_id: u64, #[callback_result] res: Result<U128, PromiseError>) -> PromiseOrValue<bool> {
        let expected = self.launches.get(&launch_id).unwrap().presale_tokens;
        if matches!(res, Ok(U128(used)) if used == expected) {
            self.apply_progress(launch_id, |p| p.lock_funded = true);
            emit("presale_locked", json!({"launch_id": launch_id, "amount": U128(expected)}));
            self.next_step(launch_id)
        } else {
            // tokens were refunded by ft_resolve_transfer; nothing left the coordinator
            self.halt(launch_id, "lock_funding")
        }
    }

    #[private]
    pub fn on_pool_created(&mut self, launch_id: u64, #[callback_result] res: Result<String, PromiseError>) -> PromiseOrValue<bool> {
        let want = self.launches.get(&launch_id).unwrap().pool_id.clone();
        match res {
            Ok(id) if id == want => {
                self.apply_progress(launch_id, |p| p.pool_created = true);
                self.next_step(launch_id)
            }
            _ => self.halt(launch_id, "create_pool"),
        }
    }

    #[private]
    pub fn on_deposited(&mut self, launch_id: u64, which: Vec<u8>) -> PromiseOrValue<bool> {
        let l = self.launches.get(&launch_id).unwrap();
        let (tok_amt, quo_amt) = (l.lp_tokens, l.total_raised);
        let mut all_ok = true;
        for (i, w) in which.iter().enumerate() {
            let used: Option<U128> = env::promise_result_checked(i as u64, 64).ok().and_then(|b| serde_json::from_slice(&b).ok());
            let want = if *w == 0 { tok_amt } else { quo_amt };
            if used.map(|u| u.0) == Some(want) {
                if *w == 0 {
                    self.apply_progress(launch_id, |p| p.token_deposited = true);
                } else {
                    self.apply_progress(launch_id, |p| p.quote_deposited = true);
                }
            } else {
                all_ok = false;
            }
        }
        if all_ok {
            self.next_step(launch_id)
        } else {
            self.halt(launch_id, "pool_deposit")
        }
    }

    #[private]
    pub fn on_liquidity_added(&mut self, launch_id: u64, #[callback_result] res: Result<String, PromiseError>) -> PromiseOrValue<bool> {
        match res {
            Ok(lpt) => {
                let split = self.get_step_gas().split_pool_steps;
                Self::set_liq_tries(launch_id, 0);
                let l = self.launches.get_mut(&launch_id).unwrap();
                l.lpt_ids.push(lpt);
                // batch mode adds both ranges at once; split mode one range per step
                l.progress.liquidity_added = !split || l.lpt_ids.len() >= 2;
                self.next_step(launch_id)
            }
            Err(_) => {
                // batch is atomic: NEAR deposits came back; re-credit the budget
                let n = if self.get_step_gas().split_pool_steps { 1 } else { 2 };
                let d = n * self.config.liquidity_deposit.as_yoctonear();
                self.launches.get_mut(&launch_id).unwrap().near_budget += d;
                // next resume_launch tries a slightly different range (see liquidity_ranges_nudged)
                let t = Self::liq_tries(launch_id);
                Self::set_liq_tries(launch_id, (t + 1) % (MAX_LIQ_TRIES + 1));
                self.halt(launch_id, "add_liquidity")
            }
        }
    }

    fn liq_key(launch_id: u64) -> Vec<u8> {
        [LIQ_TRY_PREFIX, &launch_id.to_le_bytes()].concat()
    }
    /// Failed add_liquidity attempts for the range being added (kept outside the Launch struct so
    /// existing state stays readable).
    pub fn get_liquidity_attempts(&self, launch_id: u64) -> u8 {
        Self::liq_tries(launch_id)
    }
    fn liq_tries(launch_id: u64) -> u8 {
        env::storage_read(&Self::liq_key(launch_id)).and_then(|v| v.first().copied()).unwrap_or(0)
    }
    fn set_liq_tries(launch_id: u64, n: u8) {
        if n == 0 { env::storage_remove(&Self::liq_key(launch_id)); } else { env::storage_write(&Self::liq_key(launch_id), &[n]); }
    }

    fn apply_progress(&mut self, launch_id: u64, f: impl FnOnce(&mut LaunchProgress)) {
        f(&mut self.launches.get_mut(&launch_id).unwrap().progress);
    }

    // ------------------------------------------------------------------ reserved slots

    fn internal_buy_reserved(&mut self, launch_id: u64, token: &AccountId, sender: AccountId, amount: u128, salt: &str) -> PromiseOrValue<U128> {
        let lock = self.config.lock_contract.clone();
        let l = self.launches.get_mut(&launch_id).expect("no launch");
        require!(l.status == LaunchStatus::Live, "reserved slots open after launch");
        require!(*token == l.quote_token_id, "wrong payment token");
        let h = slot_hash(&sender, salt);
        let idx = l.slots.iter().position(|s| s.hash == h).unwrap_or_else(|| env::panic_str("not a reserved slot holder"));
        let s = &mut l.slots[idx];
        let price = match s.kind {
            SlotKind::Reserved { quote_amount } => quote_amount.0,
            _ => env::panic_str("not a reserved slot"),
        };
        require!(s.deposit == 0 && !s.pending, "slot already filled");
        require!(amount >= price, "send at least the reserved quote amount");
        let tokens = tokens_for_quote(price, l.total_supply, l.opening_fdv_quote);
        s.pending = true;
        s.account = Some(sender.clone());
        let token_id = l.token_id.clone();
        let msg = serde_json::to_string(&LockMsg::Add(LockAddMsg { launch_id, account_id: sender })).unwrap();
        PromiseOrValue::Promise(
            Promise::new(token_id)
                .function_call(
                    "ft_transfer_call",
                    json!({"receiver_id": lock, "amount": U128(tokens), "msg": msg}).to_string().into_bytes(),
                    NearToken::from_yoctonear(1),
                    GAS_FT_TRANSFER_CALL_POOL,
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_CB_SMALL)
                        .on_reserved_locked(launch_id, idx as u32, U128(price), U128(amount), U128(tokens)),
                ),
        )
    }

    /// Returns the amount of quote the buyer gets refunded (resolved by the quote token).
    #[private]
    pub fn on_reserved_locked(
        &mut self,
        launch_id: u64,
        slot: u32,
        price: U128,
        paid: U128,
        tokens: U128,
        #[callback_result] res: Result<U128, PromiseError>,
    ) -> U128 {
        let l = self.launches.get_mut(&launch_id).unwrap();
        let s = &mut l.slots[slot as usize];
        s.pending = false;
        if matches!(res, Ok(U128(u)) if u == tokens.0) {
            s.deposit = price.0;
            s.tokens = tokens.0;
            // proceeds follow the public fee split
            let q = l.quote_token_id.clone();
            match l.fee_balances.iter_mut().find(|(t, _)| *t == q) {
                Some((_, b)) => *b += price.0,
                None => l.fee_balances.push((q, price.0)),
            }
            emit("reserved_filled", json!({"launch_id": launch_id, "slot": slot, "tokens": tokens}));
            U128(paid.0 - price.0)
        } else {
            s.account = None;
            U128(paid.0)
        }
    }

    // ------------------------------------------------------------------ fees

    /// Permissionless: pay out a launch's accumulated fees in `token_id` per its fee split.
    pub fn distribute_fees(&mut self, launch_id: u64, token_id: AccountId) -> Promise {
        let l = self.launches.get_mut(&launch_id).expect("no launch");
        let pos = l.fee_balances.iter().position(|(t, _)| *t == token_id).expect("no fees for token");
        let amount = l.fee_balances[pos].1;
        require!(amount > 0, "nothing to distribute");
        l.fee_balances[pos].1 = 0;
        if token_id == l.quote_token_id {
            l.fees_distributed_quote += amount;
        }
        let fs = l.fee_split.clone();
        let extra = read_fee_extra(launch_id);
        let c_prepaid = read_community_paid(launch_id, &token_id);
        let b_prepaid = read_buyback_paid(launch_id, &token_id);
        let (h, lq, c, op, ai) = fs.split_with_extra(amount + c_prepaid + b_prepaid, extra.as_ref());
        let c = c.saturating_sub(c_prepaid);
        let lq = lq.saturating_sub(b_prepaid);
        write_community_paid(launch_id, &token_id, 0);
        write_buyback_paid(launch_id, &token_id, 0);
        let mut destinations = vec![
            (fs.holders_account, h),
            (fs.liquidity_account, lq),
            (fs.community_account, c),
        ];
        if let Some(e) = extra {
            destinations.push((e.operations_account, op));
            destinations.push((e.near_ai_account, ai));
        }
        let mut p: Option<Promise> = None;
        let mut legs: Vec<(AccountId, U128)> = vec![];
        for (to, a) in destinations {
            if a == 0 {
                continue;
            }
            legs.push((to.clone(), U128(a)));
            let t = Promise::new(token_id.clone()).function_call(
                "ft_transfer",
                json!({"receiver_id": to, "amount": U128(a), "memo": format!("KYP fees #{launch_id}")}).to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_FT_TRANSFER,
            );
            p = Some(match p {
                Some(x) => x.and(t),
                None => t,
            });
        }
        p.unwrap().then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CB)
                .with_unused_gas_weight(1)
                .on_fees_distributed(launch_id, token_id, legs),
        )
    }

    #[private]
    pub fn on_fees_distributed(&mut self, launch_id: u64, token_id: AccountId, legs: Vec<(AccountId, U128)>) -> U128 {
        let mut failed = 0u128;
        for (i, (_, a)) in legs.iter().enumerate() {
            if env::promise_result_checked(i as u64, 64).is_err() {
                failed += a.0;
            }
        }
        if failed > 0 {
            let l = self.launches.get_mut(&launch_id).unwrap();
            if let Some((_, b)) = l.fee_balances.iter_mut().find(|(t, _)| *t == token_id) {
                *b += failed;
            }
            if token_id == l.quote_token_id {
                l.fees_distributed_quote -= failed;
            }
        }
        U128(failed)
    }

    // ------------------------------------------------------------------ bounty payouts

    /// Pay a Cabal Corner bounty from the launch's undistributed community fee share.
    /// Only the launcher or the community account can call it. The Corner API does not
    /// sign; it only helps the caller build the transaction after a vote has passed.
    pub fn pay_bounty(
        &mut self,
        launch_id: u64,
        token_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
        bounty_ref: String,
    ) -> Promise {
        require!(amount.0 > 0, "amount must be > 0");
        require!(bounty_ref.len() <= 80, "bounty_ref too long");
        let caller = env::predecessor_account_id();
        let l = self.launches.get(&launch_id).expect("no launch");
        require!(l.status == LaunchStatus::Live, "launch not live");
        require!(
            caller == l.launcher || caller == l.fee_split.community_account,
            "only the launcher or community account can pay a bounty"
        );
        let bal = l.fee_balances.iter().find(|(t, _)| *t == token_id).map(|(_, b)| *b).unwrap_or(0);
        require!(bal >= amount.0, "not enough undistributed fees");
        let prepaid = read_community_paid(launch_id, &token_id);
        let extra = read_fee_extra(launch_id);
        let (_, _, c, _, _) = l.fee_split.split_with_extra(bal + prepaid, extra.as_ref());
        let available = c.saturating_sub(prepaid);
        require!(amount.0 <= available, "amount exceeds the remaining community share");
        let quote = l.quote_token_id.clone();
        let l = self.launches.get_mut(&launch_id).unwrap();
        let pos = l.fee_balances.iter().position(|(t, _)| *t == token_id).unwrap();
        l.fee_balances[pos].1 -= amount.0;
        if token_id == quote {
            l.fees_distributed_quote += amount.0;
        }
        write_community_paid(launch_id, &token_id, prepaid + amount.0);
        emit(
            "bounty_paid",
            json!({"launch_id": launch_id, "token_id": token_id, "receiver_id": receiver_id, "amount": amount, "bounty_ref": bounty_ref}),
        );
        Promise::new(token_id.clone())
            .function_call(
                "ft_transfer",
                json!({"receiver_id": receiver_id, "amount": amount, "memo": format!("KYP bounty #{launch_id} {bounty_ref}")})
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_FT_TRANSFER,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CB)
                    .on_bounty_paid(launch_id, token_id, amount),
            )
    }

    #[private]
    pub fn on_bounty_paid(&mut self, launch_id: u64, token_id: AccountId, amount: U128, #[callback_result] res: Result<(), PromiseError>) -> bool {
        if res.is_ok() {
            return true;
        }
        let l = self.launches.get_mut(&launch_id).unwrap();
        match l.fee_balances.iter_mut().find(|(t, _)| *t == token_id) {
            Some((_, b)) => *b += amount.0,
            None => l.fee_balances.push((token_id.clone(), amount.0)),
        }
        if token_id == l.quote_token_id {
            l.fees_distributed_quote = l.fees_distributed_quote.saturating_sub(amount.0);
        }
        let prepaid = read_community_paid(launch_id, &token_id).saturating_sub(amount.0);
        write_community_paid(launch_id, &token_id, prepaid);
        log!("bounty transfer failed; rolled back");
        false
    }

    pub fn community_fee_available(&self, launch_id: u64, token_id: AccountId) -> U128 {
        let l = match self.launches.get(&launch_id) {
            Some(l) => l,
            None => return U128(0),
        };
        let bal = l.fee_balances.iter().find(|(t, _)| *t == token_id).map(|(_, b)| *b).unwrap_or(0);
        let prepaid = read_community_paid(launch_id, &token_id);
        let extra = read_fee_extra(launch_id);
        let (_, _, c, _, _) = l.fee_split.split_with_extra(bal + prepaid, extra.as_ref());
        U128(c.saturating_sub(prepaid))
    }

    fn parse_user_assets(v: serde_json::Value) -> HashMap<AccountId, U128> {
        let mut m = HashMap::new();
        let Some(obj) = v.as_object() else { return m };
        for (k, val) in obj {
            let Ok(id) = k.parse::<AccountId>() else { continue };
            let amt = match val {
                serde_json::Value::String(s) => s.parse().ok(),
                serde_json::Value::Number(n) => n.as_u64().map(|x| x as u128),
                serde_json::Value::Object(o) => o
                    .get("0")
                    .and_then(|x| x.as_str())
                    .and_then(|s| s.parse().ok()),
                _ => None,
            };
            if let Some(a) = amt {
                m.insert(id, U128(a));
            }
        }
        m
    }

    fn credit_fee_balance(launch_id: u64, l: &mut Launch, token_id: AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        match l.fee_balances.iter_mut().find(|(t, _)| *t == token_id) {
            Some((_, b)) => *b += amount,
            None => l.fee_balances.push((token_id, amount)),
        }
        let _ = launch_id;
    }

    /// Permissionless: claim charged RHEA DCL trading fees on the coordinator-owned permanent LP,
    /// withdraw only the newly claimed amounts, and credit them to this launch's fee balances.
    /// A later `distribute_fees` pays the public split. Existing leftover DCL deposits are left alone.
    pub fn collect_fees(&mut self, launch_id: u64) -> Promise {
        let l = self.launches.get(&launch_id).expect("no launch");
        require!(l.status == LaunchStatus::Live, "launch not live");
        require!(!l.pool_id.is_empty(), "no pool");
        let me = env::current_account_id();
        Promise::new(l.pool_contract.clone())
            .function_call(
                "list_user_assets",
                json!({"account_id": me}).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_DCL_VIEW,
            )
            .then(
                Self::ext(me)
                    .with_static_gas(GAS_CB_COLLECT)
                    .on_collect_fees_baseline(launch_id),
            )
    }

    #[private]
    pub fn on_collect_fees_baseline(
        &mut self,
        launch_id: u64,
        #[callback_result] assets: Result<serde_json::Value, PromiseError>,
    ) -> Promise {
        let v = assets.unwrap_or_else(|_| env::panic_str("list_user_assets failed"));
        let baseline = Self::parse_user_assets(v);
        let l = self.launches.get(&launch_id).expect("no launch");
        Promise::new(l.pool_contract.clone())
            .function_call(
                "claim_charged_fee",
                json!({"pool_id": l.pool_id, "amount_x": U128(0), "amount_y": U128(0)}).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_DCL_CLAIM,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CB_COLLECT)
                    .on_collect_fees_claimed(launch_id, baseline),
            )
    }

    #[private]
    pub fn on_collect_fees_claimed(
        &mut self,
        launch_id: u64,
        baseline: HashMap<AccountId, U128>,
        #[callback_result] res: Result<(), PromiseError>,
    ) -> Promise {
        require!(res.is_ok(), "claim_charged_fee failed");
        let l = self.launches.get(&launch_id).expect("no launch");
        let me = env::current_account_id();
        Promise::new(l.pool_contract.clone())
            .function_call(
                "list_user_assets",
                json!({"account_id": me}).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_DCL_VIEW,
            )
            .then(
                Self::ext(me)
                    .with_static_gas(GAS_CB_COLLECT)
                    .on_collect_fees_assets(launch_id, baseline),
            )
    }

    #[private]
    pub fn on_collect_fees_assets(
        &mut self,
        launch_id: u64,
        baseline: HashMap<AccountId, U128>,
        #[callback_result] assets: Result<serde_json::Value, PromiseError>,
    ) -> Promise {
        let v = assets.unwrap_or_else(|_| env::panic_str("list_user_assets failed"));
        let after = Self::parse_user_assets(v);
        let l = self.launches.get(&launch_id).expect("no launch");
        let mut pulls: Vec<(AccountId, U128)> = vec![];
        for tok in [l.token_id.clone(), l.quote_token_id.clone()] {
            let before = baseline.get(&tok).map(|x| x.0).unwrap_or(0);
            let now = after.get(&tok).map(|x| x.0).unwrap_or(0);
            let d = now.saturating_sub(before);
            if d > 0 {
                pulls.push((tok, U128(d)));
            }
        }
        require!(!pulls.is_empty(), "nothing to collect");
        let pool = l.pool_contract.clone();
        let mut p: Option<Promise> = None;
        for (tok, amt) in &pulls {
            let t = Promise::new(pool.clone()).function_call(
                "withdraw_asset",
                json!({"token_id": tok, "amount": amt}).to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_DCL_WITHDRAW,
            );
            p = Some(match p {
                Some(x) => x.and(t),
                None => t,
            });
        }
        p.unwrap().then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CB_COLLECT)
                .on_collect_fees_withdrawn(launch_id, pulls),
        )
    }

    #[private]
    pub fn on_collect_fees_withdrawn(
        &mut self,
        launch_id: u64,
        pulls: Vec<(AccountId, U128)>,
    ) -> U128 {
        let mut credited = 0u128;
        let l = self.launches.get_mut(&launch_id).expect("no launch");
        for (i, (tok, amt)) in pulls.iter().enumerate() {
            if env::promise_result_checked(i as u64, 64).is_ok() {
                Self::credit_fee_balance(launch_id, l, tok.clone(), amt.0);
                credited += amt.0;
            }
        }
        if credited > 0 {
            emit("fees_collected", json!({"launch_id": launch_id, "amount": U128(credited)}));
        }
        U128(credited)
    }

    // ------------------------------------------------------------------ lock buyback

    fn buyback_available_of(&self, launch_id: u64, token_id: &AccountId) -> u128 {
        let Some(l) = self.launches.get(&launch_id) else { return 0 };
        let bps = read_buyback_bps(launch_id);
        if bps == 0 {
            return 0;
        }
        let bal = l.fee_balances.iter().find(|(t, _)| t == token_id).map(|(_, b)| *b).unwrap_or(0);
        let c_prepaid = read_community_paid(launch_id, token_id);
        let b_prepaid = read_buyback_paid(launch_id, token_id);
        let virtual_pot = bal + c_prepaid + b_prepaid;
        let extra = read_fee_extra(launch_id);
        let (_, lq, _, _, _) = l.fee_split.split_with_extra(virtual_pot, extra.as_ref());
        let from_liq = lq.saturating_sub(b_prepaid);
        let from_bps = (virtual_pot.saturating_mul(bps as u128) / 10_000).saturating_sub(b_prepaid);
        from_liq.min(from_bps)
    }

    fn refund_buyback(&mut self, launch_id: u64, token_id: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let l = self.launches.get_mut(&launch_id).expect("no launch");
        match l.fee_balances.iter_mut().find(|(t, _)| t == token_id) {
            Some((_, b)) => *b += amount,
            None => l.fee_balances.push((token_id.clone(), amount)),
        }
        if *token_id == l.quote_token_id {
            l.fees_distributed_quote = l.fees_distributed_quote.saturating_sub(amount);
        }
        let prepaid = read_buyback_paid(launch_id, token_id).saturating_sub(amount);
        write_buyback_paid(launch_id, token_id, prepaid);
    }

    /// Launcher-only. Buybacks are taken from the liquidity share of undistributed fees, capped at 20%.
    pub fn set_buyback_bps(&mut self, launch_id: u64, bps: u16) {
        let l = self.launches.get(&launch_id).expect("no launch");
        require!(env::predecessor_account_id() == l.launcher, "only the launcher can set buyback_bps");
        require!(bps <= MAX_BUYBACK_BPS, "buyback_bps is capped at 20%");
        require!(bps <= l.fee_split.liquidity_bps, "buyback_bps cannot exceed the liquidity share");
        write_buyback_bps(launch_id, bps);
        emit("buyback_bps_set", json!({"launch_id": launch_id, "bps": bps}));
    }

    pub fn buyback_available(&self, launch_id: u64) -> U128 {
        let Some(l) = self.launches.get(&launch_id) else { return U128(0) };
        U128(self.buyback_available_of(launch_id, &l.quote_token_id))
    }

    /// Permissionless: swap `amount` of undistributed quote fees on the DCL pool into the
    /// project token (with `min_output`) and add it to the permanent lock. Failed swaps or
    /// transfers credit the quote back to the fee pool.
    pub fn buyback_to_lock(&mut self, launch_id: u64, amount: U128, min_output: U128) -> Promise {
        require!(amount.0 > 0, "amount must be > 0");
        require!(min_output.0 > 0, "min_output must be > 0");
        require!(read_buyback_pending(launch_id).is_none(), "buyback already in progress");
        let (quote, token, pool, pool_id, live, has_pool) = {
            let l = self.launches.get(&launch_id).expect("no launch");
            (
                l.quote_token_id.clone(),
                l.token_id.clone(),
                l.pool_contract.clone(),
                l.pool_id.clone(),
                l.status == LaunchStatus::Live,
                !l.pool_id.is_empty(),
            )
        };
        require!(live, "launch not live");
        require!(has_pool, "no pool");
        let available = self.buyback_available_of(launch_id, &quote);
        require!(amount.0 <= available, "amount exceeds the remaining buyback share");
        let l = self.launches.get_mut(&launch_id).unwrap();
        let pos = l.fee_balances.iter().position(|(t, _)| *t == quote).expect("no fees for token");
        require!(l.fee_balances[pos].1 >= amount.0, "not enough undistributed fees");
        l.fee_balances[pos].1 -= amount.0;
        l.fees_distributed_quote += amount.0;
        write_buyback_paid(launch_id, &quote, read_buyback_paid(launch_id, &quote) + amount.0);
        write_buyback_pending(launch_id, Some(&BuybackPending {
            quote_reserved: amount.0,
            min_output: min_output.0,
            token_wallet_before: 0,
            token_dcl_before: 0,
        }));
        let me = env::current_account_id();
        let wallet = Promise::new(token.clone()).function_call(
            "ft_balance_of",
            json!({"account_id": me}).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_FT_BALANCE,
        );
        let dcl = Promise::new(pool.clone()).function_call(
            "get_user_asset",
            json!({"account_id": me, "token_id": token}).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_DCL_VIEW,
        );
        wallet.and(dcl).then(
            Self::ext(me)
                .with_static_gas(GAS_CB_BUYBACK)
                .on_buyback_balances(launch_id, amount, min_output, quote, token, pool, pool_id),
        )
    }

    #[private]
    pub fn on_buyback_balances(
        &mut self,
        launch_id: u64,
        amount: U128,
        min_output: U128,
        quote: AccountId,
        token: AccountId,
        pool: AccountId,
        pool_id: String,
    ) -> Promise {
        let wallet = match env::promise_result_checked(0, 128) {
            Ok(b) => serde_json::from_slice::<U128>(&b).map(|x| x.0).unwrap_or(0),
            Err(_) => 0,
        };
        let dcl = match env::promise_result_checked(1, 128) {
            Ok(b) => serde_json::from_slice::<U128>(&b).map(|x| x.0).unwrap_or(0),
            Err(_) => 0,
        };
        let Some(mut pend) = read_buyback_pending(launch_id) else {
            env::panic_str("no buyback pending");
        };
        pend.token_wallet_before = wallet;
        pend.token_dcl_before = dcl;
        write_buyback_pending(launch_id, Some(&pend));
        let me = env::current_account_id();
        let msg = json!({
            "Swap": {
                "pool_ids": [pool_id],
                "output_token": token,
                "min_output_amount": min_output,
                "skip_unwrap_near": true
            }
        })
        .to_string();
        Promise::new(quote)
            .function_call(
                "ft_transfer_call",
                json!({"receiver_id": pool, "amount": amount, "msg": msg}).to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_DCL_SWAP,
            )
            .then(
                Self::ext(me)
                    .with_static_gas(GAS_CB_BUYBACK)
                    .on_buyback_swapped(launch_id, token, pool),
            )
    }

    #[private]
    pub fn on_buyback_swapped(
        &mut self,
        launch_id: u64,
        token: AccountId,
        pool: AccountId,
        #[callback_result] unused: Result<U128, PromiseError>,
    ) -> PromiseOrValue<U128> {
        let Some(pend) = read_buyback_pending(launch_id) else {
            env::panic_str("no buyback pending");
        };
        let l = self.launches.get(&launch_id).expect("no launch");
        let quote = l.quote_token_id.clone();
        let refund_all = match &unused {
            Err(_) => true,
            Ok(u) if u.0 >= pend.quote_reserved => true,
            _ => false,
        };
        if refund_all {
            self.refund_buyback(launch_id, &quote, pend.quote_reserved);
            write_buyback_pending(launch_id, None);
            log!("buyback swap failed or produced no fill; quote credited back");
            return PromiseOrValue::Value(U128(0));
        }
        if let Ok(u) = unused {
            if u.0 > 0 {
                self.refund_buyback(launch_id, &quote, u.0);
                let mut pend = pend;
                pend.quote_reserved = pend.quote_reserved.saturating_sub(u.0);
                write_buyback_pending(launch_id, Some(&pend));
            }
        }
        let me = env::current_account_id();
        let wallet = Promise::new(token.clone()).function_call(
            "ft_balance_of",
            json!({"account_id": me}).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_FT_BALANCE,
        );
        let dcl = Promise::new(pool.clone()).function_call(
            "get_user_asset",
            json!({"account_id": me, "token_id": token}).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_DCL_VIEW,
        );
        PromiseOrValue::Promise(wallet.and(dcl).then(
            Self::ext(me)
                .with_static_gas(GAS_CB_BUYBACK)
                .on_buyback_output(launch_id, token, pool),
        ))
    }

    #[private]
    pub fn on_buyback_output(&mut self, launch_id: u64, token: AccountId, pool: AccountId) -> PromiseOrValue<U128> {
        let Some(pend) = read_buyback_pending(launch_id) else {
            env::panic_str("no buyback pending");
        };
        let wallet = match env::promise_result_checked(0, 128) {
            Ok(b) => serde_json::from_slice::<U128>(&b).map(|x| x.0).unwrap_or(0),
            Err(_) => 0,
        };
        let dcl = match env::promise_result_checked(1, 128) {
            Ok(b) => serde_json::from_slice::<U128>(&b).map(|x| x.0).unwrap_or(0),
            Err(_) => 0,
        };
        let bought_wallet = wallet.saturating_sub(pend.token_wallet_before);
        let bought_dcl = dcl.saturating_sub(pend.token_dcl_before);
        if bought_wallet == 0 && bought_dcl > 0 {
            // Output is still in the DCL internal account; withdraw then lock.
            return PromiseOrValue::Promise(
                Promise::new(pool.clone())
                    .function_call(
                        "withdraw_asset",
                        json!({"token_id": token, "amount": U128(bought_dcl)}).to_string().into_bytes(),
                        NearToken::from_yoctonear(1),
                        GAS_DCL_WITHDRAW,
                    )
                    .then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(GAS_CB_BUYBACK)
                            .on_buyback_withdrawn(launch_id, token, U128(bought_dcl)),
                    ),
            );
        }
        self.lock_buyback_tokens(launch_id, token, bought_wallet)
    }

    #[private]
    pub fn on_buyback_withdrawn(
        &mut self,
        launch_id: u64,
        token: AccountId,
        amount: U128,
        #[callback_result] res: Result<(), PromiseError>,
    ) -> PromiseOrValue<U128> {
        if res.is_err() {
            log!("buyback withdraw failed; tokens may still be in the DCL account — call resume_buyback");
            return PromiseOrValue::Value(U128(0));
        }
        self.lock_buyback_tokens(launch_id, token, amount.0)
    }

    fn lock_buyback_tokens(&mut self, launch_id: u64, token: AccountId, amount: u128) -> PromiseOrValue<U128> {
        let Some(pend) = read_buyback_pending(launch_id) else {
            env::panic_str("no buyback pending");
        };
        if amount == 0 {
            log!("buyback produced no tokens; call resume_buyback if they arrive later");
            return PromiseOrValue::Value(U128(0));
        }
        if amount < pend.min_output {
            // DCL should have rejected the swap; still lock what we got rather than leave it loose.
            log!("buyback output below min_output; locking the tokens received anyway");
        }
        let lock = self.config.lock_contract.clone();
        let msg = serde_json::to_string(&LockMsg::Add(LockAddMsg { launch_id, account_id: lock.clone() })).unwrap();
        PromiseOrValue::Promise(
            Promise::new(token)
                .function_call(
                    "ft_transfer_call",
                    json!({"receiver_id": lock, "amount": U128(amount), "msg": msg}).to_string().into_bytes(),
                    NearToken::from_yoctonear(1),
                    GAS_FT_TRANSFER_CALL_LOCK,
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_CB_BUYBACK)
                        .on_buyback_locked(launch_id, U128(amount)),
                ),
        )
    }

    #[private]
    pub fn on_buyback_locked(
        &mut self,
        launch_id: u64,
        amount: U128,
        #[callback_result] res: Result<U128, PromiseError>,
    ) -> U128 {
        // ft_transfer_call returns unused tokens; 0 unused means the lock kept the full amount.
        let kept = match res {
            Ok(U128(unused)) if unused < amount.0 => amount.0 - unused,
            _ => 0,
        };
        if kept == 0 {
            log!("buyback lock transfer failed; tokens remain on the coordinator — call resume_buyback");
            return U128(0);
        }
        write_buyback_pending(launch_id, None);
        emit("buyback_locked", json!({"launch_id": launch_id, "tokens": U128(kept)}));
        U128(kept)
    }

    /// Retry locking (or withdrawing) tokens from a buyback whose final transfer failed.
    pub fn resume_buyback(&mut self, launch_id: u64) -> Promise {
        require!(read_buyback_pending(launch_id).is_some(), "no buyback pending");
        let l = self.launches.get(&launch_id).expect("no launch");
        require!(l.status == LaunchStatus::Live, "launch not live");
        let token = l.token_id.clone();
        let pool = l.pool_contract.clone();
        let me = env::current_account_id();
        let wallet = Promise::new(token.clone()).function_call(
            "ft_balance_of",
            json!({"account_id": me}).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_FT_BALANCE,
        );
        let dcl = Promise::new(pool.clone()).function_call(
            "get_user_asset",
            json!({"account_id": me, "token_id": token}).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_DCL_VIEW,
        );
        wallet.and(dcl).then(
            Self::ext(me)
                .with_static_gas(GAS_CB_BUYBACK)
                .on_buyback_output(launch_id, token, pool),
        )
    }

    // ------------------------------------------------------------------ reveal

    /// Permissionless: reveal the next wave once its time has come (launch + k x interval).
    pub fn reveal_next_wave(&mut self, launch_id: u64) -> u8 {
        let now = now_sec();
        let l = self.launches.get_mut(&launch_id).expect("no launch");
        require!(l.status == LaunchStatus::Live, "launch not live");
        require!(l.revealed_waves < l.reveal.waves, "all waves revealed");
        let at = l.launched_at.unwrap() + (l.revealed_waves as u64 + 1) * l.reveal.interval_sec;
        require!(now >= at, "next wave not due yet");
        l.revealed_waves += 1;
        emit("wave_revealed", json!({"launch_id": launch_id, "wave": l.revealed_waves}));
        l.revealed_waves
    }

    /// Wave (1-based) for position `rank` of `n` open presalers split into `waves` chunks.
    fn wave_of(rank: usize, n: usize, waves: u8) -> u8 {
        let per = n.div_ceil(waves as usize).max(1);
        (rank / per) as u8 + 1
    }

    // ------------------------------------------------------------------ views

    pub fn get_launch(&self, launch_id: u64) -> Option<LaunchView> {
        self.launches.get(&launch_id).map(Self::view_of)
    }

    pub fn get_launches(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<LaunchView> {
        self.launches
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(20).min(50) as usize)
            .map(Self::view_of)
            .collect()
    }

    pub fn get_launch_count(&self) -> u64 {
        self.next_id - 1
    }

    /// Presalers ordered smallest first. Accounts appear only for revealed waves; reserved
    /// slot buyers are revealed with the final wave.
    pub fn get_presalers(&self, launch_id: u64) -> Vec<PresalerView> {
        let l = self.launches.get(&launch_id).expect("no launch");
        let mut out = vec![];
        let n = l.wave_order.len();
        let all_revealed = l.revealed_waves >= l.reveal.waves;
        for (rank, idx) in l.wave_order.iter().enumerate() {
            let s = &l.slots[*idx as usize];
            let wave = Self::wave_of(rank, n, l.reveal.waves);
            out.push(PresalerView {
                wave,
                kind: s.kind.clone(),
                quote: U128(s.deposit),
                tokens: U128(s.tokens),
                account_id: if wave <= l.revealed_waves { s.account.clone() } else { None },
            });
        }
        for s in l.slots.iter().filter(|s| matches!(s.kind, SlotKind::Reserved { .. }) && s.tokens > 0) {
            out.push(PresalerView {
                wave: l.reveal.waves,
                kind: s.kind.clone(),
                quote: U128(s.deposit),
                tokens: U128(s.tokens),
                account_id: if all_revealed { s.account.clone() } else { None },
            });
        }
        out
    }

    /// Look up one slot by its hash (the UI computes sha256("{account}:{salt}") locally).
    pub fn get_slot(&self, launch_id: u64, hash: String) -> Option<SlotView> {
        let l = self.launches.get(&launch_id).expect("no launch");
        let h = from_hex(&hash);
        l.slots.iter().position(|s| s.hash == h).map(|i| {
            let s = &l.slots[i];
            SlotView { index: i as u32, kind: s.kind.clone(), filled: s.deposit > 0, deposit: U128(s.deposit), tokens: U128(s.tokens) }
        })
    }

    pub fn hash_slot(&self, account_id: AccountId, salt: String) -> String {
        to_hex(&slot_hash(&account_id, &salt))
    }

    fn view_of(l: &Launch) -> LaunchView {
        let open = l.slots.iter().filter(|s| s.kind == SlotKind::Open);
        let reserved = l.slots.iter().filter(|s| s.kind != SlotKind::Open);
        let reserved_quote_total: u128 = reserved
            .clone()
            .map(|s| match s.kind {
                SlotKind::Reserved { quote_amount } => quote_amount.0,
                _ => 0,
            })
            .sum();
        LaunchView {
            id: l.id,
            launcher: l.launcher.clone(),
            status: l.status,
            created_at: l.created_at,
            name: l.name.clone(),
            symbol: l.symbol.clone(),
            icon: l.icon.clone(),
            description: l.description.clone(),
            terms_uri: l.terms_uri.clone(),
            token_id: l.token_id.clone(),
            quote_token_id: l.quote_token_id.clone(),
            total_supply: U128(l.total_supply),
            decimals: l.decimals,
            opening_fdv_quote: U128(l.opening_fdv_quote),
            presale_cap_bps: l.presale_cap_bps,
            min_raise: U128(l.min_raise),
            wallet_min: U128(l.wallet_min),
            wallet_max: U128(l.wallet_max),
            open_cap_quote: U128(l.open_cap_quote),
            open_slots: open.clone().count() as u32,
            reserved_slots: reserved.clone().count() as u32,
            filled_open_slots: open.filter(|s| s.deposit > 0).count() as u32,
            filled_reserved_slots: reserved.filter(|s| s.tokens > 0).count() as u32,
            reserved_quote_total: U128(reserved_quote_total),
            sale_start: l.sale_start,
            sale_end: l.sale_end,
            milestones: l.milestones.clone(),
            twap: l.twap.clone(),
            reveal: l.reveal.clone(),
            fee_split: l.fee_split.clone(),
            fee_extra: read_fee_extra(l.id),
            buyback_bps: read_buyback_bps(l.id),
            total_raised: U128(l.total_raised),
            presale_tokens: U128(l.presale_tokens),
            reserved_tokens: U128(l.reserved_tokens),
            lp_tokens: U128(l.lp_tokens),
            pool_contract: l.pool_contract.clone(),
            pool_id: l.pool_id.clone(),
            token_is_x: l.token_is_x,
            init_point: l.init_point,
            progress: l.progress.clone(),
            launched_at: l.launched_at,
            revealed_waves: l.revealed_waves,
            next_wave_at: match (l.launched_at, l.revealed_waves < l.reveal.waves) {
                (Some(t), true) => Some(t + (l.revealed_waves as u64 + 1) * l.reveal.interval_sec),
                _ => None,
            },
            lpt_ids: l.lpt_ids.clone(),
            fee_balances: l.fee_balances.iter().map(|(t, b)| (t.clone(), U128(*b))).collect(),
        }
    }
}

#[cfg(test)]
mod tests;
