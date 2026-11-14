// Mirrors the JSON views of contracts/coordinator and contracts/lock. Big numbers are decimal strings.

export type LaunchStatus = "Creating" | "Open" | "Launching" | "Live" | "Cancelled" | "Failed";
export type SlotKind = "Open" | { Reserved: { quote_amount: string } };

export interface MilestoneInput { target_fdv_quote: string; unlock_bps: number }
export interface TwapConfig {
  window_sec: number; min_observations: number; min_liquidity: string;
  claim_delay_sec: number; min_obs_interval_sec: number;
}
export interface RevealConfig { waves: number; interval_sec: number }
export interface FeeSplit {
  holders_bps: number; liquidity_bps: number; community_bps: number;
  holders_account: string; liquidity_account: string; community_account: string;
}
export interface FeeExtra {
  operations_bps: number; near_ai_bps: number;
  operations_account: string; near_ai_account: string;
}
export const MAX_OPERATIONS_BPS = 3000;
export const MAX_NEAR_AI_BPS = 2000;
export interface Progress {
  lock_funded: boolean; pool_created: boolean; token_deposited: boolean;
  quote_deposited: boolean; liquidity_added: boolean;
}

export interface LaunchView {
  id: number; launcher: string; status: LaunchStatus; created_at: number;
  name: string; symbol: string; icon: string | null; description: string; terms_uri: string | null;
  token_id: string; quote_token_id: string; total_supply: string; decimals: number;
  opening_fdv_quote: string; presale_cap_bps: number; min_raise: string;
  wallet_min: string; wallet_max: string; open_cap_quote: string;
  open_slots: number; reserved_slots: number; filled_open_slots: number; filled_reserved_slots: number;
  reserved_quote_total: string; sale_start: number; sale_end: number;
  milestones: MilestoneInput[]; twap: TwapConfig; reveal: RevealConfig; fee_split: FeeSplit;
  fee_extra?: FeeExtra | null;
  total_raised: string; presale_tokens: string; reserved_tokens: string; lp_tokens: string;
  pool_contract: string; pool_id: string; token_is_x: boolean; init_point: number;
  progress: Progress; launched_at: number | null; revealed_waves: number; next_wave_at: number | null;
  lpt_ids: string[]; fee_balances: [string, string][];
}

export interface PresalerView { wave: number; kind: SlotKind; quote: string; tokens: string; account_id: string | null }
export interface SlotView { index: number; kind: SlotKind; filled: boolean; deposit: string; tokens: string }

export interface Milestone extends MilestoneInput { qualified_at: number | null; qualified_twap_point: number | null }
export interface Observation { ts: number; point: number; liquidity: string }
export interface LockView {
  launch_id: number; token_id: string; pool_contract: string; pool_id: string; token_is_x: boolean;
  milestones: Milestone[]; twap: TwapConfig; observations_count: number; last_observation: Observation | null;
  supply: string; total_locked: string; total_claimed: string; positions_count: number;
  created_at: number; unlocked_bps: number;
}
export interface TwapStatus {
  ok: boolean; error: string | null; avg_point: number | null; twap_fdv_quote: string | null;
  observations_in_window: number | null; spot_point: number | null; spot_fdv_quote: string | null;
}
export interface Position { total: string; claimed: string }

export interface LaunchParams {
  name: string; symbol: string; icon: string | null; description: string; terms_uri: string | null;
  quote_token_id: string; total_supply: string | null; decimals: number | null;
  opening_fdv_quote: string; presale_cap_bps: number; min_raise: string; wallet_min: string; wallet_max: string;
  allowlist: string[]; reserved: { hash: string; quote_amount: string }[];
  sale_start: number; sale_end: number; milestones: MilestoneInput[]; twap: TwapConfig;
  reveal: RevealConfig; fee_split: FeeSplit; fee_extra?: FeeExtra | null;
}

export const isReserved = (k: SlotKind): k is { Reserved: { quote_amount: string } } => typeof k === "object";
