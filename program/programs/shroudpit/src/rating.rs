//! v0 rating: return per unit of volatility across rounds. Integer maths only.
//!
//!   mean  = sum(r) / n
//!   std   = sqrt( sum(r^2)/n - mean^2 )            (population, in basis points)
//!   rating = 1000 * mean / max(std, MIN_STD_BPS)
//!
//! The floor stops a single round (std = 0) from producing an unbounded score.

pub const MIN_STD_BPS: i128 = 100;

fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

pub fn pnl_bps(side: i8, leverage: u8, entry: i64, now: i64) -> i64 {
    if side == 0 || entry <= 0 {
        return 0;
    }
    let d = (now as i128 - entry as i128) * 10_000 * side as i128 * leverage as i128 / entry as i128;
    d.clamp(-10_000, 100_000) as i64
}

pub fn rating(n: u8, sum: i64, sum_sq: i64) -> i64 {
    if n == 0 {
        return 0;
    }
    let n = n as i128;
    let sum = sum as i128;
    let sum_sq = sum_sq as i128;
    let mean = sum / n;
    // variance = (n * sum_sq - sum^2) / n^2, never negative by Cauchy-Schwarz
    let var = ((n * sum_sq - sum * sum).max(0) / (n * n)) as u128;
    let std = (isqrt(var) as i128).max(MIN_STD_BPS);
    (mean * 1000 / std) as i64
}
