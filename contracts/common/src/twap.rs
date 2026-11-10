//! Time-weighted average point over a trailing window.
//!
//! Observations are step samples: observation i holds from ts_i until ts_{i+1} (the last
//! one until `now`). The averaging window is [now - window, now]. An *anchor* observation
//! at or before the window start is required so the whole window is covered.

use crate::types::{Observation, TwapConfig};

#[derive(Debug, PartialEq)]
pub enum TwapError {
    NoAnchor,
    TooFewObservations { have: u32, need: u32 },
    LowLiquidity,
    Stale,
}

#[derive(Debug, PartialEq)]
pub struct TwapResult {
    /// Time-weighted mean point (floored).
    pub avg_point: i32,
    pub observations: u32,
}

/// `obs` must be sorted by ts ascending.
pub fn twap_point(obs: &[Observation], now: u64, cfg: &TwapConfig) -> Result<TwapResult, TwapError> {
    let window = cfg.window_sec;
    if now < window {
        return Err(TwapError::NoAnchor);
    }
    let start = now - window;
    // anchor = last observation with ts <= start
    let anchor_idx = match obs.iter().rposition(|o| o.ts <= start) {
        Some(i) => i,
        None => return Err(TwapError::NoAnchor),
    };
    let used = &obs[anchor_idx..];
    let count = used.len() as u32;
    if count < cfg.min_observations {
        return Err(TwapError::TooFewObservations { have: count, need: cfg.min_observations });
    }
    // Freshness: the last sample must be no older than the configured window split
    // into (min_observations - 1) intervals, i.e. the observer must keep poking.
    let max_gap = window / (cfg.min_observations as u64 - 1).max(1);
    let last = used.last().unwrap();
    if now - last.ts > max_gap {
        return Err(TwapError::Stale);
    }
    if used.iter().any(|o| o.liquidity.0 < cfg.min_liquidity.0) {
        return Err(TwapError::LowLiquidity);
    }
    let mut acc: i128 = 0;
    for (i, o) in used.iter().enumerate() {
        let from = o.ts.max(start);
        let to = if i + 1 < used.len() { used[i + 1].ts } else { now };
        let to = to.max(from);
        acc += o.point as i128 * (to - from) as i128;
    }
    let avg = acc.div_euclid(window as i128) as i32;
    Ok(TwapResult { avg_point: avg, observations: count })
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::json_types::U128;

    fn cfg() -> TwapConfig {
        TwapConfig {
            window_sec: 3600,
            min_observations: 4,
            min_liquidity: U128(10),
            claim_delay_sec: 0,
            min_obs_interval_sec: 60,
        }
    }
    fn o(ts: u64, point: i32) -> Observation {
        Observation { ts, point, liquidity: U128(100) }
    }

    #[test]
    fn steady_price() {
        let obs = vec![o(1000, 500), o(2000, 500), o(3000, 500), o(4000, 500), o(4500, 500)];
        let r = twap_point(&obs, 4600, &cfg()).unwrap();
        assert_eq!(r.avg_point, 500);
    }

    #[test]
    fn one_block_spike_is_diluted() {
        // flat at 0 for the window, then a spike to 100_000 recorded 60s before now
        let obs = vec![o(0, 0), o(1200, 0), o(2400, 0), o(3540, 100_000)];
        let r = twap_point(&obs, 3600, &cfg()).unwrap();
        // 100_000 * 60 / 3600 = 1666
        assert_eq!(r.avg_point, 1666);
    }

    #[test]
    fn needs_anchor_before_window() {
        let obs = vec![o(1000, 0), o(2000, 0), o(3000, 0), o(4000, 0)];
        assert_eq!(twap_point(&obs, 4500, &cfg()), Err(TwapError::NoAnchor));
    }

    #[test]
    fn needs_min_observations() {
        let obs = vec![o(0, 0), o(3500, 0)];
        assert_eq!(
            twap_point(&obs, 3600, &cfg()),
            Err(TwapError::TooFewObservations { have: 2, need: 4 })
        );
    }

    #[test]
    fn rejects_low_liquidity_and_stale() {
        let mut obs = vec![o(0, 0), o(1200, 0), o(2400, 0), o(3500, 0)];
        obs[2].liquidity = U128(1);
        assert_eq!(twap_point(&obs, 3600, &cfg()), Err(TwapError::LowLiquidity));
        let obs = vec![o(0, 0), o(100, 0), o(200, 0), o(300, 0)];
        assert_eq!(twap_point(&obs, 3600, &cfg()), Err(TwapError::Stale));
    }

    #[test]
    fn negative_points_floor() {
        let obs = vec![o(0, -3), o(1800, -4), o(3000, -4), o(3500, -4)];
        let r = twap_point(&obs, 3600, &cfg()).unwrap();
        // (-3*1800 + -4*1800)/3600 = -3.5 -> floor -4
        assert_eq!(r.avg_point, -4);
    }
}
