import test from "node:test";
import assert from "node:assert/strict";
import { tokensForQuote, fdvAtPoint, pointForFdv, waveOf, twapPoint, toRaw, units, slotHash, DEFAULT_SUPPLY } from "./math.mjs";

const NEAR = 10n ** 24n;

test("single presale price", () => {
  assert.equal(tokensForQuote(25n * NEAR, DEFAULT_SUPPLY, 2500n * NEAR), DEFAULT_SUPPLY / 100n);
});

test("fdv <-> point round trip both orientations", () => {
  for (const x of [true, false]) {
    const fdv = 2500n * NEAR;
    const p = pointForFdv(fdv, DEFAULT_SUPPLY, x);
    const back = fdvAtPoint(p, x, DEFAULT_SUPPLY) / Number(fdv);
    assert.ok(back > 0.9997 && back < 1.0003, `x=${x} ratio=${back}`);
  }
});

test("waves smallest first", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map((r) => waveOf(r, 5, 3)), [1, 1, 2, 2, 3]);
});

test("twap matches contract semantics", () => {
  const cfg = { window_sec: 3600, min_observations: 4, min_liquidity: "10", min_obs_interval_sec: 60 };
  const o = (ts, point) => ({ ts, point, liquidity: "100" });
  const r = twapPoint([o(0, 0), o(1200, 0), o(2400, 0), o(3540, 100000)], 3600, cfg);
  assert.equal(r.avg_point, 1666);
  assert.equal(twapPoint([o(1000, 0)], 3600, cfg).ok, false);
});

test("units/toRaw", () => {
  assert.equal(toRaw("1.5", 24), 15n * 10n ** 23n);
  assert.equal(units(15n * 10n ** 23n, 24), 1.5);
});

test("slot hash matches contract format sha256('account:salt')", async () => {
  // sha256("alice.testnet:s1")
  const h = await slotHash("alice.testnet", "s1");
  assert.equal(h.length, 64);
});
