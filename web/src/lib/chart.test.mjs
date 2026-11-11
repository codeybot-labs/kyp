import test from "node:test";
import assert from "node:assert/strict";
import { seriesFrom, buildCandles, pickBucket, chartModel, valueAt, milestoneValue, fmtAxis } from "./chart.mjs";

const NEAR = 10n ** 24n;
const L = { token_is_x: true, total_supply: (10n ** 27n).toString(), decimals: 18, milestones: [{ target_fdv_quote: (40n * NEAR).toString(), unlock_bps: 2500 }] };
// point -39200 ~ 20 wNEAR FDV for 1B supply (the testnet smoke launch)
const P0 = -39200;

test("valueAt: FDV in wNEAR and per-token price", () => {
  const fdv = valueAt(P0, L, "fdv");
  assert.ok(fdv > 19.5 && fdv < 20.5, String(fdv));
  const price = valueAt(P0, L, "price");
  assert.ok(Math.abs(price - fdv / 1e9) < 1e-15);
  assert.equal(milestoneValue(L.milestones[0].target_fdv_quote, L, "fdv"), 40);
  assert.equal(milestoneValue(L.milestones[0].target_fdv_quote, L, "price"), 40 / 1e9);
  // token as y: higher point = lower token price
  assert.ok(valueAt(1000, { ...L, token_is_x: false }) < valueAt(0, { ...L, token_is_x: false }));
});

test("seriesFrom sorts, keeps one value per second and appends the live spot", () => {
  const obs = [{ ts: 200, point: P0 + 100 }, { ts: 100, point: P0 }, { ts: 200, point: P0 + 200 }];
  const s = seriesFrom(obs, L, "fdv", { ts: 300, point: P0 + 300 });
  assert.deepEqual(s.map((x) => x.time), [100, 200, 300]);
  assert.equal(s[1].value, valueAt(P0 + 200, L)); // last value at t=200 wins
});

test("candles: OHLC per bucket, open = previous close, empty buckets skipped", () => {
  const s = [
    { time: 0, value: 10 }, { time: 30, value: 12 }, { time: 59, value: 9 },
    { time: 60, value: 11 },
    { time: 300, value: 15 }, // buckets 120..240 have no samples
  ];
  const c = buildCandles(s, 60);
  assert.deepEqual(c, [
    { time: 0, open: 10, high: 12, low: 9, close: 9 },
    { time: 60, open: 9, high: 11, low: 9, close: 11 },
    { time: 300, open: 11, high: 15, low: 11, close: 15 },
  ]);
});

test("pickBucket keeps candle count reasonable", () => {
  assert.equal(pickBucket([{ time: 0 }, { time: 600 }]), 60);
  assert.equal(pickBucket([{ time: 0 }, { time: 86400 }]), 3600);
  assert.equal(pickBucket([{ time: 0 }, { time: 400 * 86400 }]), 86400);
});

test("chartModel: empty state below 2 points, milestones always present", () => {
  const m0 = chartModel([], L);
  assert.equal(m0.empty, true);
  assert.equal(m0.points, 0);
  assert.equal(m0.milestones[0].value, 40);
  const m1 = chartModel([{ ts: 1, point: P0 }], L);
  assert.equal(m1.empty, true);
  const m2 = chartModel([{ ts: 1, point: P0 }, { ts: 100, point: P0 + 500 }], L, { unit: "price" });
  assert.equal(m2.empty, false);
  assert.equal(m2.candles.length, 2);
  assert.equal(m2.milestones[0].value, 40 / 1e9);
});

test("fmtAxis handles tiny per-token prices and large FDVs", () => {
  assert.equal(fmtAxis(2.07e-8), "2.07e-8");
  assert.equal(fmtAxis(20.7), "20.70");
  assert.equal(fmtAxis(2500), "2.50k");
  assert.equal(fmtAxis(1.5e6), "1.50M");
});
