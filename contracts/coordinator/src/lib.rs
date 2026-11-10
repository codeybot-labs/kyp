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
//!    reserved slots, fee routing via `Fees` + `distribute_fees`.
//! 5. If the launcher never launches by `sale_end`, or cancels, presalers `withdraw`.

mod types;

pub use types::*;

use kyp_common::{
    aligned_bounds, assert_valid_milestones, dcl_pool_id, init_point_for_fdv, mul_div,
    tokens_for_quote, LockAddMsg, LockFundMsg, LockMsg, BPS_DENOM, DEFAULT_DECIMALS,
    DEFAULT_TOTAL_SUPPLY, MAX_PRESALE_CAP_BPS, MAX_PRESALERS, MAX_SALE_WINDOW_SEC,
};
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
        p.fee_split.assert_valid();
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
    pub(crate) fn liquidity_ranges(l: &Launch, point_delta: i32) -> [(i32, i32, u128, u128); 2] {
        let (lo, hi) = aligned_bounds(point_delta);
        let a = l.init_point;
        let above = (a + point_delta, hi);
        let below = (lo, a);
        let (tok, quo) = (l.lp_tokens, l.total_raised);
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
        if !p.liquidity_added {
            let ranges = Self::liquidity_ranges(&l, cfg.point_delta);
            let d1 = self.spend(launch_id, cfg.liquidity_deposit);
            let d2 = self.spend(launch_id, cfg.liquidity_deposit);
            let mut pr = Promise::new(l.pool_contract.clone());
            for ((left, right, ax, ay), d) in ranges.iter().zip([d1, d2]) {
                pr = pr.function_call(
                    "add_liquidity",
                    json!({
                        "pool_id": l.pool_id, "left_point": left, "right_point": right,
                        "amount_x": U128(*ax), "amount_y": U128(*ay),
                        "min_amount_x": U128(0), "min_amount_y": U128(0)
                    })
                    .to_string()
                    .into_bytes(),
                    d,
                    GAS_ADD_LIQUIDITY,
                );
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
        Promise::new(token.clone()).function_call(
            "ft_transfer_call",
            json!({"receiver_id": pool, "amount": U128(amount), "msg": msg}).to_string().into_bytes(),
            NearToken::from_yoctonear(1),
            GAS_FT_TRANSFER_CALL_POOL,
        )
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
                let l = self.launches.get_mut(&launch_id).unwrap();
                l.progress.liquidity_added = true;
                l.lpt_ids.push(lpt);
                self.next_step(launch_id)
            }
            Err(_) => {
                // batch is atomic: NEAR deposits came back; re-credit the budget
                let d = 2 * self.config.liquidity_deposit.as_yoctonear();
                self.launches.get_mut(&launch_id).unwrap().near_budget += d;
                self.halt(launch_id, "add_liquidity")
            }
        }
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
        let (h, lq, c) = fs.split(amount);
        let mut p: Option<Promise> = None;
        let mut legs: Vec<(AccountId, U128)> = vec![];
        for (to, a) in [(fs.holders_account, h), (fs.liquidity_account, lq), (fs.community_account, c)] {
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
