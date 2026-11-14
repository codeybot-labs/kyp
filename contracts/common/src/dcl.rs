//! Exact port of RHEA DCL's (iZiSwap-derived) liquidity rounding, used to pick
//! `add_liquidity` ranges the pool can actually settle.
//!
//! Why: for a single-sided range, the DCL sizes liquidity with one formula
//! (`get_amount_x_unit_liquidity_96`, ceil) and charges with another (`get_amount_x`, ceil).
//! Both are built on `get_sqrt_price`, whose precision collapses near the edges of the point
//! range, so for some ranges the charge `need_x` comes out a few hundred million yocto ABOVE the
//! offered `amount_x`. `add_liquidity` then panics computing the refund
//! (`amount_x - need_x`, "attempt to subtract with overflow", dcl_liquidity_api.rs:209).
//! Offering less does not help (the error is relative); only the range matters. So the
//! coordinator checks each candidate range with the same integer math and moves the far end in
//! until `need <= amount`. Values are verified against `predict_add_liquidity` on
//! dclv2.ref-dev.testnet (see tests).

use crate::math::{U256, U512};

const RIGHT_MOST_POINT: i32 = 800_000;

fn pow_96() -> U256 {
    U256::one() << 96
}

fn to512(v: U256) -> U512 {
    let mut w = [0u64; 8];
    w[..4].copy_from_slice(&v.0);
    U512(w)
}

fn to256(v: U512) -> U256 {
    assert!(v.0[4..].iter().all(|x| *x == 0), "u256 overflow");
    let mut w = [0u64; 4];
    w.copy_from_slice(&v.0[..4]);
    U256(w)
}

fn mul_floor(a: U256, n: U256, d: U256) -> U256 {
    to256(to512(a) * to512(n) / to512(d))
}

fn mul_ceil(a: U256, n: U256, d: U256) -> U256 {
    let p = to512(a) * to512(n);
    let d = to512(d);
    let q = p / d;
    to256(if (p % d).is_zero() { q } else { q + U512::one() })
}

const STEPS: [(u32, &str); 19] = [
        (0x2u32, "fff97272373d413259a46990580e213a"),
        (0x4u32, "fff2e50f5f656932ef12357cf3c7fdcc"),
        (0x8u32, "ffe5caca7e10e4e61c3624eaa0941cd0"),
        (0x10u32, "ffcb9843d60f6159c9db58835c926644"),
        (0x20u32, "ff973b41fa98c081472e6896dfb254c0"),
        (0x40u32, "ff2ea16466c96a3843ec78b326b52861"),
        (0x80u32, "fe5dee046a99a2a811c461f1969c3053"),
        (0x100u32, "fcbe86c7900a88aedcffc83b479aa3a4"),
        (0x200u32, "f987a7253ac413176f2b074cf7815e54"),
        (0x400u32, "f3392b0822b70005940c7a398e4b70f3"),
        (0x800u32, "e7159475a2c29b7443b29c7fa6e889d9"),
        (0x1000u32, "d097f3bdfd2022b8845ad8f792aa5825"),
        (0x2000u32, "a9f746462d870fdf8a65dc1f90e061e5"),
        (0x4000u32, "70d869a156d2a1b890bb3df62baf32f7"),
        (0x8000u32, "31be135f97d08fd981231505542fcfa6"),
        (0x10000u32, "9aa508b5b7a84e1c677de54f3e99bc9"),
        (0x20000u32, "5d6af8dedb81196699c329225ee604"),
        (0x40000u32, "2216e584f5fa1ea926041bedfe98"),
        (0x80000u32, "48a170391f7dc42444e8fa2"),
];

/// sqrt(1.0001^point) in Q96, rounded up (same bits as the DCL).
pub fn dcl_sqrt_price_96(point: i32) -> U256 {
    let abs = point.unsigned_abs();
    assert!(abs <= RIGHT_MOST_POINT as u32, "E202: illegal point");
    let mut value = if abs & 1 != 0 {
        U256::from_str_radix("fffcb933bd6fad37aa2d162d1a594001", 16).unwrap()
    } else {
        U256::one() << 128
    };
    for (bit, hex) in STEPS.iter() {
        if abs & bit != 0 {
            value = (value * U256::from_str_radix(hex, 16).unwrap()) >> 128;
        }
    }
    if point > 0 {
        value = U256::MAX / value;
    }
    let rem = value % (U256::one() << 32);
    (value >> 32) + if rem.is_zero() { U256::zero() } else { U256::one() }
}

fn sqrt_rate_96() -> U256 {
    dcl_sqrt_price_96(1)
}

/// What the DCL charges (`need_x`) for an x-only range `[left, right)` above the current point
/// when offered `amount_x`; None if the range gets zero liquidity.
pub fn dcl_need_x(left: i32, right: i32, amount_x: u128) -> Option<u128> {
    let rate = sqrt_rate_96();
    let sp_r = dcl_sqrt_price_96(right);
    // compute_liquidity: amount_x / x per unit liquidity (floor)
    let unit = mul_ceil(pow_96(), dcl_sqrt_price_96(right - left + 1) - rate, dcl_sqrt_price_96(right + 1) - sp_r);
    let liq = mul_floor(U256::from(amount_x), pow_96(), unit).min(U256::from(u128::MAX / 2));
    if liq.is_zero() {
        return None;
    }
    // compute_deposit_x_y -> get_amount_x(upper = true)
    let num = dcl_sqrt_price_96(right - left) - pow_96();
    let den = sp_r - mul_floor(sp_r, pow_96(), rate);
    let need = mul_ceil(liq, num, den);
    Some(if need > U256::from(u128::MAX) { u128::MAX } else { need.as_u128() })
}

/// What the DCL charges (`need_y`) for a y-only range `[left, right)` ending at the current
/// point `right` (pool price = sqrt price at `right`) when offered `amount_y`.
pub fn dcl_need_y(left: i32, right: i32, amount_y: u128) -> Option<u128> {
    if amount_y == 0 {
        return None;
    }
    let rate = sqrt_rate_96();
    let (sl, sr) = (dcl_sqrt_price_96(left), dcl_sqrt_price_96(right));
    let unit = mul_ceil(pow_96(), sr - sl, rate - pow_96());
    let liq = mul_floor(U256::from(amount_y - 1), pow_96(), unit).min(U256::from(u128::MAX / 2));
    if liq.is_zero() {
        return None;
    }
    let need = mul_ceil(liq, sr - sl, rate - pow_96());
    Some(if need > U256::from(u128::MAX) { u128::MAX } else { need.as_u128() })
}

/// Largest `right` <= `right_max` (stepping down by `delta`, at most `max_steps` times) whose
/// x-only range `[left, right)` the DCL can settle (need_x <= amount_x).
pub fn dcl_safe_right(left: i32, right_max: i32, delta: i32, amount_x: u128, max_steps: u32) -> i32 {
    let mut r = right_max;
    for _ in 0..max_steps {
        if r - delta <= left {
            break;
        }
        if matches!(dcl_need_x(left, r, amount_x), Some(n) if n <= amount_x) {
            return r;
        }
        r -= delta;
    }
    r
}

/// Smallest `left` >= `left_min` (stepping up by `delta`) whose y-only range `[left, right)`
/// the DCL can settle (need_y <= amount_y).
pub fn dcl_safe_left(left_min: i32, right: i32, delta: i32, amount_y: u128, max_steps: u32) -> i32 {
    let mut l = left_min;
    for _ in 0..max_steps {
        if l + delta >= right {
            break;
        }
        if matches!(dcl_need_y(l, right, amount_y), Some(n) if n <= amount_y) {
            return l;
        }
        l += delta;
    }
    l
}

#[cfg(test)]
mod tests {
    use super::*;

    const E24: u128 = 1_000_000_000_000_000_000_000_000;

    /// `need_x` returned by `predict_add_liquidity` on dclv2.ref-dev.testnet (2026-11-14), pool
    /// `tstpsm4-6.kyp-sushmit-dcl.testnet|wrap.testnet|10000` (current point -23200), plus the
    /// launch #5 failure log.
    #[test]
    fn matches_rhea_testnet_need_x() {
        let a = 975 * E24;
        for (right, need) in [
            (776_800, 975_000_000_000_000_000_760_893_610u128),
            (775_400, 975_000_000_000_000_000_290_134_181),
            (774_000, 974_999_999_999_999_999_123_139_568),
            (600_000, 975_000_000_000_000_000_000_015_401),
            (400_000, 974_999_999_999_999_999_999_997_790),
        ] {
            assert_eq!(dcl_need_x(-23_000, right, a), Some(need), "right {right}");
        }
        assert_eq!(dcl_need_x(-23_000, 776_800, 9675 * E24 / 10), Some(967_500_000_000_000_000_754_999_282));
    }

    #[test]
    fn matches_rhea_testnet_need_y() {
        let a = 25 * E24 / 10;
        for (left, need) in [
            (-800_000, 2_499_999_999_999_999_999_999_765u128),
            (-798_600, 2_499_999_999_999_999_999_996_482),
            (-700_000, 2_499_999_999_999_999_999_995_120),
        ] {
            assert_eq!(dcl_need_y(left, -23_200, a), Some(need), "left {left}");
        }
    }

    #[test]
    fn safe_right_never_overcharges() {
        let a = 975 * E24;
        let r = dcl_safe_right(-23_000, 776_800, 200, a, 400);
        assert!(r < 776_800);
        assert!(dcl_need_x(-23_000, r, a).unwrap() <= a);
    }
}
