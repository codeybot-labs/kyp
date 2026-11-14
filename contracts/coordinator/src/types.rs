use kyp_common::{FeeExtra, FeeSplit, MilestoneInput, TwapConfig};
use near_sdk::json_types::U128;
use near_sdk::{near, AccountId, NearToken};

pub type Hash = [u8; 32];

pub fn to_hex(h: &Hash) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(64);
    for b in h {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0xf) as usize] as char);
    }
    s
}

pub fn from_hex(s: &str) -> Hash {
    let b = s.as_bytes();
    assert!(b.len() == 64, "slot hash must be 32 bytes hex");
    let nib = |c: u8| -> u8 {
        match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            b'A'..=b'F' => c - b'A' + 10,
            _ => panic!("bad hex"),
        }
    };
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = (nib(b[2 * i]) << 4) | nib(b[2 * i + 1]);
    }
    out
}

/// Per-step gas for the pool steps of `launch` / `resume_launch`. Stored under its own storage
/// key (not inside the contract struct), so it can be added to an already-deployed coordinator
/// without a state migration. Defaults keep the original one-transaction flow for the mock.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct StepGas {
    /// false: both pool deposits run in parallel and both `add_liquidity` ranges in one batch
    /// (fits one 300 Tgas `launch` against the mock). true: one deposit or one range per step,
    /// each with the gas below; a step that doesn't fit in the remaining gas pauses the launch
    /// (`launch_paused` event) and `resume_launch` continues it in a new transaction.
    pub split_pool_steps: bool,
    /// Gas attached to each `ft_transfer_call` into the pool (RHEA testnet DCL: ~920 Tgas burnt).
    pub pool_deposit_tgas: u64,
    /// Gas attached to each `add_liquidity` call.
    pub add_liquidity_tgas: u64,
}

impl Default for StepGas {
    fn default() -> Self {
        Self { split_pool_steps: false, pool_deposit_tgas: 50, add_liquidity_tgas: 25 }
    }
}

/// Platform-level settings (owner-controlled; cannot touch escrow or locks).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PlatformConfig {
    pub lock_contract: AccountId,
    /// RHEA DCL (`dclv2.ref-dev.testnet`) or the KYP mock pool.
    pub pool_contract: AccountId,
    pub pool_fee: u32,
    pub point_delta: i32,
    pub allowed_quote_tokens: Vec<AccountId>,
    /// Hard platform ceiling on presale + reserved share (bps). Default 5000 = 50%.
    pub max_presale_cap_bps: u16,
    /// NEAR the launcher attaches to `create_launch` to fund the token sub-account storage.
    pub token_account_deposit: NearToken,
    pub pool_storage_deposit: NearToken,
    pub pool_create_deposit: NearToken,
    pub liquidity_deposit: NearToken,
    /// `msg` for `ft_transfer_call` deposits into the pool (RHEA DCL: `"Deposit"`, mock: "").
    pub pool_deposit_msg: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct RevealConfig {
    /// Number of post-launch reveal waves (smallest presalers first).
    pub waves: u8,
    /// Seconds between launch and wave 1, and between waves.
    pub interval_sec: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ReservedSlotInput {
    pub hash: String,
    /// Quote amount the named wallet will pay (same single presale price).
    pub quote_amount: U128,
}

/// Everything a launcher sets. All of it is public terms except the identities behind slot hashes.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct LaunchParams {
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub description: String,
    pub terms_uri: Option<String>,
    pub quote_token_id: AccountId,
    /// Defaults to 1e27 (1B x 18 decimals).
    pub total_supply: Option<U128>,
    pub decimals: Option<u8>,
    /// Opening FDV in raw quote units. Presale price = opening_fdv_quote / total_supply.
    pub opening_fdv_quote: U128,
    /// Presale + reserved cap in bps of supply (<= platform max, 50%).
    pub presale_cap_bps: u16,
    pub min_raise: U128,
    pub wallet_min: U128,
    pub wallet_max: U128,
    /// sha256("{account_id}:{salt}") hex, one per invited wallet.
    pub allowlist: Vec<String>,
    pub reserved: Vec<ReservedSlotInput>,
    /// Unix seconds. Window may be at most 7 days.
    pub sale_start: u64,
    pub sale_end: u64,
    pub milestones: Vec<MilestoneInput>,
    pub twap: TwapConfig,
    pub reveal: RevealConfig,
    pub fee_split: FeeSplit,
    /// Optional operations + NEAR AI credit legs. Omitted on existing launches.
    #[serde(default)]
    pub fee_extra: Option<FeeExtra>,
    /// Optional buyback share of fees, taken from the liquidity slice (max 20%). Default 0.
    #[serde(default)]
    pub buyback_bps: Option<u16>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LaunchStatus {
    /// Token sub-account is being deployed.
    Creating,
    /// Presale open (or waiting for sale_start).
    Open,
    /// `launch` promise chain in flight or paused at a retryable step.
    Launching,
    Live,
    Cancelled,
    /// Token deploy failed; deposit refunded.
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum SlotKind {
    Open,
    Reserved { quote_amount: U128 },
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Slot {
    pub hash: Hash,
    pub kind: SlotKind,
    pub account: Option<AccountId>,
    pub deposit: u128,
    /// Tokens locked for this slot (set at launch / reserved fill).
    pub tokens: u128,
    /// Reserved: purchase in flight.
    pub pending: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LaunchProgress {
    pub lock_funded: bool,
    pub pool_created: bool,
    pub token_deposited: bool,
    pub quote_deposited: bool,
    pub liquidity_added: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Launch {
    pub id: u64,
    pub launcher: AccountId,
    pub status: LaunchStatus,
    pub created_at: u64,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub description: String,
    pub terms_uri: Option<String>,
    pub token_id: AccountId,
    pub quote_token_id: AccountId,
    pub total_supply: u128,
    pub decimals: u8,
    pub opening_fdv_quote: u128,
    pub presale_cap_bps: u16,
    pub min_raise: u128,
    pub wallet_min: u128,
    pub wallet_max: u128,
    pub open_cap_quote: u128,
    pub slots: Vec<Slot>,
    pub sale_start: u64,
    pub sale_end: u64,
    pub milestones: Vec<MilestoneInput>,
    pub twap: TwapConfig,
    pub reveal: RevealConfig,
    pub fee_split: FeeSplit,
    pub total_raised: u128,
    pub presale_tokens: u128,
    pub reserved_tokens: u128,
    pub lp_tokens: u128,
    pub pool_contract: AccountId,
    pub pool_fee: u32,
    pub pool_id: String,
    pub token_is_x: bool,
    pub init_point: i32,
    pub progress: LaunchProgress,
    pub near_budget: u128,
    pub launched_at: Option<u64>,
    pub revealed_waves: u8,
    /// Slot indices of open-sale presalers sorted by deposit ascending (set at launch).
    pub wave_order: Vec<u16>,
    pub lpt_ids: Vec<String>,
    /// Undistributed fee balances per token.
    pub fee_balances: Vec<(AccountId, u128)>,
    pub fees_distributed_quote: u128,
}

#[near(serializers = [json])]
pub struct LaunchView {
    pub id: u64,
    pub launcher: AccountId,
    pub status: LaunchStatus,
    pub created_at: u64,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub description: String,
    pub terms_uri: Option<String>,
    pub token_id: AccountId,
    pub quote_token_id: AccountId,
    pub total_supply: U128,
    pub decimals: u8,
    pub opening_fdv_quote: U128,
    /// Raw token units received per 1 raw quote unit is total_supply / opening_fdv_quote.
    pub presale_cap_bps: u16,
    pub min_raise: U128,
    pub wallet_min: U128,
    pub wallet_max: U128,
    pub open_cap_quote: U128,
    pub open_slots: u32,
    pub reserved_slots: u32,
    pub filled_open_slots: u32,
    pub filled_reserved_slots: u32,
    pub reserved_quote_total: U128,
    pub sale_start: u64,
    pub sale_end: u64,
    pub milestones: Vec<MilestoneInput>,
    pub twap: TwapConfig,
    pub reveal: RevealConfig,
    pub fee_split: FeeSplit,
    pub fee_extra: Option<FeeExtra>,
    pub buyback_bps: u16,
    /// When true, the holders fee share accrues to a claimable pot instead of being sent to holders_account.
    pub holder_pull: bool,
    pub total_raised: U128,
    pub presale_tokens: U128,
    pub reserved_tokens: U128,
    pub lp_tokens: U128,
    pub pool_contract: AccountId,
    pub pool_id: String,
    pub token_is_x: bool,
    pub init_point: i32,
    pub progress: LaunchProgress,
    pub launched_at: Option<u64>,
    pub revealed_waves: u8,
    pub next_wave_at: Option<u64>,
    pub lpt_ids: Vec<String>,
    pub fee_balances: Vec<(AccountId, U128)>,
}

#[near(serializers = [json])]
pub struct PresalerView {
    pub wave: u8,
    pub kind: SlotKind,
    pub quote: U128,
    pub tokens: U128,
    /// Only present once this presaler's wave is revealed.
    pub account_id: Option<AccountId>,
}

#[near(serializers = [json])]
pub struct SlotView {
    pub index: u32,
    pub kind: SlotKind,
    pub filled: bool,
    pub deposit: U128,
    pub tokens: U128,
}

/// `msg` accepted by the coordinator's `ft_on_transfer`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub enum CoordinatorMsg {
    /// Presale deposit (quote token) into an open slot.
    Deposit { launch_id: u64, salt: String },
    /// Post-launch purchase of a named reserved slot at the presale price, locked on the same terms.
    BuyReserved { launch_id: u64, salt: String },
    /// Fees for a live launch (any token); split per the public fee split.
    Fees { launch_id: u64 },
}
