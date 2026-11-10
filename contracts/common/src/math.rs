//! Integer-only DCL price math. Price at `point` is 1.0001^point (token_y per token_x, raw units).
//! We work in Q128 fixed point with 512-bit intermediates; no floats on-chain.

use crate::types::{MAX_POINT, MIN_POINT};

#[allow(clippy::manual_div_ceil, clippy::assign_op_pattern)]
mod big {
    uint::construct_uint! { pub struct U256(4); }
    uint::construct_uint! { pub struct U512(8); }
}
pub use big::{U256, U512};

const Q: u32 = 128;

fn one_q() -> U512 {
    U512::one() << Q
}

/// 1.0001^|point| in Q128 (as U512), via exponentiation by squaring.
fn pow_abs_q128(mut e: u32) -> U512 {
    // 1.0001 = 10001 / 10000
    let mut base: U512 = (U512::from(10_001u64) << Q) / U512::from(10_000u64);
    let mut acc = one_q();
    while e > 0 {
        if e & 1 == 1 {
            acc = (acc * base) >> Q;
        }
        e >>= 1;
        if e > 0 {
            base = (base * base) >> Q;
        }
    }
    acc
}

/// Price (quote per token for token_x orientation) at `point`, Q128.
pub fn price_q128_at_point(point: i32) -> U512 {
    assert!((MIN_POINT..=MAX_POINT).contains(&point), "point out of range");
    let p = pow_abs_q128(point.unsigned_abs());
    if point >= 0 {
        p
    } else {
        (one_q() << Q) / p
    }
}

/// Quote-per-token price (Q128) given the DCL point and which side the token is on.
/// If the token is token_y, 1.0001^point is token-per-quote, so invert by negating the point.
pub fn quote_per_token_q128(point: i32, token_is_x: bool) -> U512 {
    price_q128_at_point(if token_is_x { point } else { -point })
}

/// FDV in raw quote units = price x (minted - burned).
pub fn fdv_quote_at_point(point: i32, token_is_x: bool, supply: u128) -> u128 {
    let v = (quote_per_token_q128(point, token_is_x) * U512::from(supply)) >> Q;
    if v > U512::from(u128::MAX) {
        u128::MAX
    } else {
        v.as_u128()
    }
}

/// Largest point p (token_x orientation) with 1.0001^p <= num/den.
pub fn floor_point_for_price(num: u128, den: u128) -> i32 {
    assert!(num > 0 && den > 0, "price must be positive");
    let target = (U512::from(num) << Q) / U512::from(den);
    let (mut lo, mut hi) = (MIN_POINT, MAX_POINT);
    if price_q128_at_point(lo) > target {
        return MIN_POINT;
    }
    if price_q128_at_point(hi) <= target {
        return MAX_POINT;
    }
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        if price_q128_at_point(mid) <= target {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    lo
}

/// Pool init point (token_x orientation) for a given FDV/supply price, floored to the point delta.
/// `quote_per_token = fdv_quote / supply`. If the token is token_y the pool price is the inverse.
pub fn init_point_for_fdv(fdv_quote: u128, supply: u128, token_is_x: bool, point_delta: i32) -> i32 {
    assert!(point_delta > 0, "point_delta must be > 0");
    let p = if token_is_x {
        floor_point_for_price(fdv_quote, supply)
    } else {
        floor_point_for_price(supply, fdv_quote)
    };
    p.div_euclid(point_delta) * point_delta
}

/// tokens = quote * supply / fdv (the single presale price), floor.
pub fn tokens_for_quote(quote: u128, supply: u128, fdv_quote: u128) -> u128 {
    let v = U512::from(quote) * U512::from(supply) / U512::from(fdv_quote);
    assert!(v <= U512::from(u128::MAX), "overflow");
    v.as_u128()
}

/// a * b / c with a 512-bit intermediate, floor.
pub fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    let v = U512::from(a) * U512::from(b) / U512::from(c);
    assert!(v <= U512::from(u128::MAX), "overflow");
    v.as_u128()
}

/// Largest multiple of `delta` that is <= MAX_POINT, and smallest >= MIN_POINT.
pub fn aligned_bounds(delta: i32) -> (i32, i32) {
    let hi = MAX_POINT.div_euclid(delta) * delta;
    let lo = -(MAX_POINT.div_euclid(delta) * delta);
    (lo.max(MIN_POINT), hi)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn to_f64(q: U512) -> f64 {
        // only for small-ish values in tests
        let int = (q >> Q).low_u128() as f64;
        let frac = (q & ((U512::one() << Q) - 1)) >> 64;
        int + frac.low_u64() as f64 / 2f64.powi(64)
    }

    #[test]
    fn pow_matches_float() {
        for p in [0, 1, 2, 10, 100, 6931, 46_054, 100_000, -1, -6931, -100_000] {
            let got = to_f64(price_q128_at_point(p));
            let want = 1.0001f64.powi(p);
            assert!(((got - want) / want).abs() < 1e-9, "p={p} got={got} want={want}");
        }
    }

    #[test]
    fn extremes_do_not_overflow() {
        let _ = price_q128_at_point(MAX_POINT);
        let _ = price_q128_at_point(MIN_POINT);
        assert_eq!(fdv_quote_at_point(MAX_POINT, true, u128::MAX), u128::MAX);
    }

    #[test]
    fn floor_point_roundtrip() {
        // price 2.0 -> point 6931 (1.0001^6931 = 1.99983..., 1.0001^6932 = 2.0000...)
        let p = floor_point_for_price(2, 1);
        assert!(price_q128_at_point(p) <= (U512::from(2u8) << Q));
        assert!(price_q128_at_point(p + 1) > (U512::from(2u8) << Q));
        assert_eq!(p, 6931);
        let n = floor_point_for_price(1, 2);
        assert_eq!(n, -6932);
    }

    #[test]
    fn fdv_at_init_point_is_close_to_opening() {
        let supply = 1_000_000_000u128 * 10u128.pow(18);
        // ~$5k opening at ~$2/NEAR => 2500 wNEAR (24 decimals)
        let fdv = 2_500u128 * 10u128.pow(24);
        for token_is_x in [true, false] {
            let pt = init_point_for_fdv(fdv, supply, token_is_x, 1);
            let got = fdv_quote_at_point(pt, token_is_x, supply);
            let ratio = got as f64 / fdv as f64;
            assert!(ratio > 0.9998 && ratio < 1.0002, "x={token_is_x} ratio={ratio}");
        }
    }

    #[test]
    fn delta_alignment_floors() {
        let supply = DEFAULT_SUPPLY;
        let fdv = 2_500u128 * 10u128.pow(24);
        let pt = init_point_for_fdv(fdv, supply, true, 200);
        assert_eq!(pt % 200, 0);
        assert!(fdv_quote_at_point(pt, true, supply) <= fdv);
    }
    const DEFAULT_SUPPLY: u128 = crate::types::DEFAULT_TOTAL_SUPPLY;

    #[test]
    fn tokens_for_quote_single_price() {
        let supply = DEFAULT_SUPPLY;
        let fdv = 2_500u128 * 10u128.pow(24);
        // 25 wNEAR buys 1% of supply
        assert_eq!(tokens_for_quote(25 * 10u128.pow(24), supply, fdv), supply / 100);
    }
}
