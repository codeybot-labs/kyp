// Price-chart data for a launch, built client-side from what's on-chain:
//  - the lock's recorded observations (pool point at each `record` poke), and
//  - optionally the pool's live point (DCL `get_pool.current_point`) as the latest value.
// No indexer is needed (no free RHEA indexer serves testnet; see docs/TESTNET.md).
import { fdvAtPoint } from "./math.mjs";

export const BUCKETS = [60, 300, 900, 3600, 4 * 3600, 86400];
export const MIN_POINTS = 2;

/** FDV in wNEAR, or price in wNEAR per whole token, at a DCL point. */
export function valueAt(point, { token_is_x, total_supply, decimals }, unit = "fdv") {
  const fdv = fdvAtPoint(point, token_is_x, total_supply) / 1e24;
  if (unit === "fdv") return fdv;
  return fdv / (Number(BigInt(total_supply)) / 10 ** (decimals ?? 18));
}

/** Target value for a milestone line, in the same unit. */
export function milestoneValue(targetFdvRaw, launch, unit = "fdv") {
  const fdv = Number(BigInt(targetFdvRaw) / 10n ** 18n) / 1e6; // exact to 1e-6 wNEAR
  return unit === "fdv" ? fdv : fdv / (Number(BigInt(launch.total_supply)) / 10 ** (launch.decimals ?? 18));
}

/** Sorted, de-duplicated (one value per second, last wins) series of { time, value }. */
export function seriesFrom(observations, launch, unit = "fdv", spot = null) {
  const pts = observations.map((o) => ({ time: Math.floor(o.ts), value: valueAt(o.point, launch, unit) }));
  if (spot && Number.isFinite(spot.point) && spot.ts) pts.push({ time: Math.floor(spot.ts), value: valueAt(spot.point, launch, unit) });
  pts.sort((a, b) => a.time - b.time);
  const out = [];
  for (const p of pts) {
    if (!Number.isFinite(p.value) || p.value <= 0) continue;
    if (out.length && out[out.length - 1].time === p.time) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/** Smallest bucket that gives at most `target` candles over the series span. */
export function pickBucket(series, target = 80) {
  if (series.length < 2) return BUCKETS[0];
  const span = series[series.length - 1].time - series[0].time;
  return BUCKETS.find((b) => span / b <= target) ?? BUCKETS[BUCKETS.length - 1];
}

/**
 * OHLC candles from point samples. Each candle opens at the previous candle's close (so
 * gaps between pokes don't look like jumps) and covers every sample in its bucket. Buckets
 * with no samples are skipped (no invented prices).
 */
export function buildCandles(series, bucket = pickBucket(series)) {
  const out = [];
  let prevClose = null;
  for (const p of series) {
    const t = Math.floor(p.time / bucket) * bucket;
    const c = out[out.length - 1];
    if (c && c.time === t) {
      c.high = Math.max(c.high, p.value);
      c.low = Math.min(c.low, p.value);
      c.close = p.value;
    } else {
      const open = prevClose ?? p.value;
      out.push({ time: t, open, high: Math.max(open, p.value), low: Math.min(open, p.value), close: p.value });
    }
    prevClose = p.value;
  }
  return out;
}

/** Chart state for the UI: "empty" below MIN_POINTS samples, otherwise candles + line. */
export function chartModel(observations, launch, { unit = "fdv", spot = null } = {}) {
  const line = seriesFrom(observations ?? [], launch, unit, spot);
  const milestones = (launch.milestones ?? []).map((m, i) => ({ index: i, value: milestoneValue(m.target_fdv_quote, launch, unit), unlock_bps: m.unlock_bps }));
  if (line.length < MIN_POINTS) return { empty: true, points: line.length, line, candles: [], milestones, bucket: null };
  const bucket = pickBucket(line);
  return { empty: false, points: line.length, line, candles: buildCandles(line, bucket), milestones, bucket };
}

/** Compact number for tiny/huge wNEAR values on the price axis. */
export function fmtAxis(v) {
  if (!Number.isFinite(v)) return "";
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(2) + "k";
  if (a >= 1) return v.toFixed(2);
  return v.toPrecision(3);
}
