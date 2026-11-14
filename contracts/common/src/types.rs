use near_sdk::json_types::U128;
use near_sdk::near;
use near_sdk::AccountId;

/// Hard platform ceiling: presale + reserved slots can never exceed 50% of supply.
pub const MAX_PRESALE_CAP_BPS: u16 = 5_000;
/// Cap on the operations fee share (DexScreener, listings, bots, hosting).
pub const MAX_OPERATIONS_BPS: u16 = 3_000;
/// Cap on the NEAR AI credits fee share.
pub const MAX_NEAR_AI_BPS: u16 = 2_000;
/// Basis points denominator.
pub const BPS_DENOM: u16 = 10_000;
/// A presale window can be at most 7 days long (opens up to 7 days before launch).
pub const MAX_SALE_WINDOW_SEC: u64 = 7 * 24 * 60 * 60;
/// Allowlist + reserved slots cap per launch (keeps views and the launch receipt bounded).
pub const MAX_PRESALERS: usize = 200;
/// Max milestones per launch.
pub const MAX_MILESTONES: usize = 8;
/// DCL point range (same as RHEA DCL / iZiSwap).
pub const MIN_POINT: i32 = -800_000;
pub const MAX_POINT: i32 = 800_000;

/// JustHoot-like token defaults.
pub const DEFAULT_TOTAL_SUPPLY: u128 = 1_000_000_000 * 10u128.pow(18);
pub const DEFAULT_DECIMALS: u8 = 18;

/// One public unlock milestone. `target_fdv_quote` is FDV expressed in raw
/// quote-token units (e.g. yocto-wNEAR): FDV = price x (minted - burned).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct MilestoneInput {
    pub target_fdv_quote: U128,
    /// Share of every position released at this milestone (bps, all milestones sum to 10_000).
    pub unlock_bps: u16,
}

/// Public TWAP rules a milestone must satisfy before it qualifies.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TwapConfig {
    /// Length of the averaging window in seconds (e.g. 3600).
    pub window_sec: u64,
    /// Minimum number of observations that must fall inside the window (incl. the anchor).
    pub min_observations: u32,
    /// Minimum pool liquidity (pool `liquidity` field units) every observation in the window must show.
    pub min_liquidity: U128,
    /// Delay between a milestone qualifying and tokens becoming claimable.
    pub claim_delay_sec: u64,
    /// Minimum spacing between two observations (anti-spam: one actor can't stuff the window in one block).
    pub min_obs_interval_sec: u64,
}

impl TwapConfig {
    pub fn assert_valid(&self) {
        assert!(self.window_sec >= 60, "twap window must be >= 60s");
        assert!(self.min_observations >= 2, "need at least 2 observations");
        assert!(self.min_obs_interval_sec >= 1, "min_obs_interval_sec must be >= 1");
        assert!(
            (self.min_observations as u64 - 1) * self.min_obs_interval_sec <= self.window_sec,
            "min_observations x min_obs_interval_sec does not fit in the window"
        );
    }
}

impl Default for TwapConfig {
    fn default() -> Self {
        Self {
            window_sec: 3_600,
            min_observations: 6,
            min_liquidity: U128(0),
            claim_delay_sec: 3_600,
            min_obs_interval_sec: 300,
        }
    }
}

/// Validate a milestone schedule: ascending targets, bps sum to 100%.
pub fn assert_valid_milestones(ms: &[MilestoneInput]) {
    assert!(!ms.is_empty(), "at least one milestone required");
    assert!(ms.len() <= MAX_MILESTONES, "too many milestones");
    let mut sum: u32 = 0;
    let mut prev: u128 = 0;
    for m in ms {
        assert!(m.unlock_bps > 0, "milestone unlock_bps must be > 0");
        assert!(m.target_fdv_quote.0 > prev, "milestone targets must be strictly ascending");
        prev = m.target_fdv_quote.0;
        sum += m.unlock_bps as u32;
    }
    assert_eq!(sum, BPS_DENOM as u32, "milestone unlock_bps must sum to 10000");
}

/// Fee routing for fees the launch collects (LP fees owned by the coordinator, reserved-slot proceeds).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct FeeSplit {
    pub holders_bps: u16,
    pub liquidity_bps: u16,
    pub community_bps: u16,
    pub holders_account: AccountId,
    pub liquidity_account: AccountId,
    pub community_account: AccountId,
}

impl FeeSplit {
    pub fn assert_valid(&self) {
        self.assert_valid_with_extra(None);
    }
    pub fn assert_valid_with_extra(&self, extra: Option<&FeeExtra>) {
        if let Some(e) = extra {
            e.assert_valid();
        }
        let (o, a) = extra.map(|e| (e.operations_bps as u32, e.near_ai_bps as u32)).unwrap_or((0, 0));
        let s = self.holders_bps as u32 + self.liquidity_bps as u32 + self.community_bps as u32 + o + a;
        assert_eq!(s, BPS_DENOM as u32, "fee split must sum to 10000");
    }
    /// Returns (holders, liquidity, community) shares; rounding dust goes to community.
    pub fn split(&self, amount: u128) -> (u128, u128, u128) {
        let (h, l, c, _, _) = self.split_with_extra(amount, None);
        (h, l, c)
    }
    /// Returns (holders, liquidity, community, operations, near_ai); rounding dust goes to community.
    pub fn split_with_extra(&self, amount: u128, extra: Option<&FeeExtra>) -> (u128, u128, u128, u128, u128) {
        let (ob, ab) = extra.map(|e| (e.operations_bps as u128, e.near_ai_bps as u128)).unwrap_or((0, 0));
        let d = BPS_DENOM as u128;
        let h = amount * self.holders_bps as u128 / d;
        let l = amount * self.liquidity_bps as u128 / d;
        let o = amount * ob / d;
        let a = amount * ab / d;
        (h, l, amount - h - l - o - a, o, a)
    }
}

/// Optional extra fee legs, stored under a separate coordinator key so existing
/// launches do not need a state migration. Both shares are capped.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct FeeExtra {
    pub operations_bps: u16,
    pub near_ai_bps: u16,
    pub operations_account: AccountId,
    pub near_ai_account: AccountId,
}

impl FeeExtra {
    pub fn assert_valid(&self) {
        assert!(self.operations_bps <= MAX_OPERATIONS_BPS, "operations share above the 30% cap");
        assert!(self.near_ai_bps <= MAX_NEAR_AI_BPS, "NEAR AI credits share above the 20% cap");
    }
    pub fn is_empty(&self) -> bool {
        self.operations_bps == 0 && self.near_ai_bps == 0
    }
}

/// One pool observation recorded by the pokeable observer.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Observation {
    /// Seconds since unix epoch (block timestamp / 1e9).
    pub ts: u64,
    pub point: i32,
    pub liquidity: U128,
}

/// The subset of RHEA DCL `get_pool` output KYP reads. Unknown fields are ignored.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct DclPoolView {
    pub pool_id: String,
    pub token_x: AccountId,
    pub token_y: AccountId,
    pub current_point: i32,
    pub liquidity: U128,
    #[serde(default)]
    pub state: Option<String>,
}

/// DCL pool id: tokens sorted lexicographically, then fee. Returns (pool_id, token_is_x).
pub fn dcl_pool_id(token: &AccountId, quote: &AccountId, fee: u32) -> (String, bool) {
    if token.as_str() < quote.as_str() {
        (format!("{}|{}|{}", token, quote, fee), true)
    } else {
        (format!("{}|{}|{}", quote, token, fee), false)
    }
}

/// Message the coordinator sends with `ft_transfer_call` to fund a new lock.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct LockFundMsg {
    pub launch_id: u64,
    pub pool_contract: AccountId,
    pub pool_id: String,
    pub token_is_x: bool,
    pub milestones: Vec<MilestoneInput>,
    pub twap: TwapConfig,
    pub positions: Vec<(AccountId, U128)>,
}

/// Message the coordinator sends to add a reserved-slot position to an existing lock.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct LockAddMsg {
    pub launch_id: u64,
    pub account_id: AccountId,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub enum LockMsg {
    Fund(LockFundMsg),
    Add(LockAddMsg),
}
