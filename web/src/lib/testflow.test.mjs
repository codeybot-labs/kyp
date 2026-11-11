import test from "node:test";
import assert from "node:assert/strict";
import { quickStart, wrapTx, sampleLaunchParams } from "./testflow.mjs";
import { slotHash } from "./math.mjs";

test("wrapTx registers when needed, then near_deposit", () => {
  const t = wrapTx({ quote: "wrap.testnet", signer: "a.testnet", amount: "5", registered: false });
  assert.deepEqual(t.actions.map((a) => a.method), ["storage_deposit", "near_deposit"]);
  assert.equal(t.actions[1].deposit, "5");
  assert.deepEqual(wrapTx({ quote: "wrap.testnet", signer: "a.testnet", amount: "5", registered: true }).actions.map((a) => a.method), ["near_deposit"]);
});

test("sample params allowlist both presalers by hash(account:salt)", async () => {
  const p = await sampleLaunchParams({ launcher: "l.testnet", presalers: [{ account: "a.testnet", salt: "s1" }, { account: "b.testnet", salt: "s2" }], now: 100, tag: "ab" });
  assert.deepEqual(p.allowlist, [await slotHash("a.testnet", "s1"), await slotHash("b.testnet", "s2")]);
  assert.equal(p.sale_start, 100);
  assert.equal(p.fee_split.holders_account, "l.testnet");
});

test("quick start drives generate -> wrap -> create -> deposit -> launch/resume -> record on a mock chain", async () => {
  const sent = [];
  let launch = null, resumes = 0;
  const chain = {
    get_config: () => ({ token_account_deposit: "2500000000000000000000000", pool_storage_deposit: "500000000000000000000000", pool_create_deposit: "100000000000000000000000", liquidity_deposit: "0" }),
    get_launch_count: () => (launch ? 7 : 6),
    get_launch: (a) => (a.launch_id === 7 ? launch : { launcher: "someone.testnet" }),
    get_slot: () => ({ filled: false }),
    storage_balance_of: () => null, ft_balance_of: () => "0", storage_balance_bounds: () => ({ min: "1" }),
  };
  let n = 0;
  const ctx = {
    network: "testnet", rpc: "https://rpc.testnet.fastnear.com", coordinator: "c.testnet", lock: "k.testnet", quote: "wrap.testnet",
    view: async (c, m, a) => chain[m](a), now: () => 1000, sleep: async () => {},
    generate: async (label) => ({ accountId: `kyp-t-${label}-${++n}.testnet`, secretKey: "ed25519:x" }),
    send: async (w, tx) => {
      sent.push([w.accountId, tx.actions.map((a) => a.method).join("+")]);
      const m = tx.actions[0].method;
      if (m === "create_launch") launch = { launcher: w.accountId, status: "Open" };
      if (m === "launch") launch.status = "Launching";
      if (m === "resume_launch" && ++resumes === 3) launch.status = "Live";
      return { hash: `H${sent.length}` };
    },
  };
  const logs = [];
  const q = quickStart(ctx, {}, (e) => logs.push(e));
  const st = await q.runAll();
  assert.equal(st.launchId, 7);
  assert.deepEqual(sent.map((s) => s[1]), [
    "storage_deposit+near_deposit", "storage_deposit+near_deposit", "create_launch",
    "storage_deposit+storage_deposit+near_deposit+ft_transfer_call", "storage_deposit+storage_deposit+near_deposit+ft_transfer_call",
    "launch", "resume_launch", "resume_launch", "resume_launch", "record", "record", "record",
  ]);
  assert.equal(sent[2][0], st.launcher.accountId, "launcher creates");
  assert.equal(sent[3][0], st.ps[0].accountId, "presaler 1 deposits");
  assert.equal(st.ps.length, 2, "default 2 presalers");
  assert.ok(logs.filter((l) => l.hash).every((l) => l.account));
  assert.throws(() => quickStart({ ...ctx, network: "mainnet" }), /testnet-only/);
});

import { sampleAmount, clampPresalers, MAX_PRESALERS } from "./testflow.mjs";
function mockChain() {
  const sent = [], params = [];
  let launch = null, resumes = 0, n = 0;
  const chain = {
    get_config: () => ({ token_account_deposit: "1", pool_storage_deposit: "1", pool_create_deposit: "1", liquidity_deposit: "0" }),
    get_launch_count: () => (launch ? 1 : 0), get_launch: () => launch, get_slot: () => ({ filled: false }),
    storage_balance_of: () => ({}), ft_balance_of: () => "0", storage_balance_bounds: () => ({ min: "1" }),
  };
  const ctx = {
    network: "testnet", rpc: "https://rpc.testnet.fastnear.com", coordinator: "c.testnet", lock: "k.testnet", quote: "wrap.testnet",
    view: async (c, m, a) => chain[m](a), now: () => 1000, sleep: async () => {},
    generate: async (label) => ({ accountId: `kyp-t-${label}-${++n}.testnet`, secretKey: "ed25519:x" }),
    send: async (w, tx) => {
      const a = tx.actions.at(-1);
      sent.push({ who: w.accountId, m: a.method, args: a.args, deposit: a.deposit });
      if (a.method === "create_launch") { params.push(a.args.params); launch = { launcher: w.accountId, status: "Open" }; }
      if (a.method === "launch") launch.status = "Live";
      return { hash: "h" };
    },
  };
  return { ctx, sent, params };
}

test("quick start with 9 presalers: 10 wallets, 9 allowlisted, 3 waves, varied deposits within the cap", async () => {
  const { ctx, sent, params } = mockChain();
  const st = await quickStart({ ...ctx, presalers: 9, room: () => 10 }).runAll();
  assert.equal(st.ps.length, 9);
  assert.equal(params[0].allowlist.length, 9);
  assert.equal(params[0].reveal.waves, 3);
  const deps = sent.filter((x) => x.m === "ft_transfer_call");
  assert.equal(deps.length, 9);
  assert.equal(new Set(deps.map((d) => d.who)).size, 9);
  const total = deps.reduce((a, d) => a + BigInt(d.args.amount), 0n);
  const openCap = BigInt(params[0].opening_fdv_quote) * BigInt(params[0].presale_cap_bps) / 10000n;
  assert.ok(total <= openCap, "all 9 deposits fit the open cap");
  for (const d of deps) assert.ok(BigInt(d.args.amount) >= BigInt(params[0].wallet_min) && BigInt(d.args.amount) <= BigInt(params[0].wallet_max));
});

test("presaler count clamps to 1-9; 1 presaler = 1 wave; refuses when the 10-wallet cap has no room", async () => {
  assert.deepEqual([clampPresalers(0), clampPresalers(1), clampPresalers(9), clampPresalers(42)], [1, 1, 9, 9]);
  assert.equal(MAX_PRESALERS, 9);
  assert.equal(sampleAmount(5), 2);
  const a = mockChain();
  const st = await quickStart({ ...a.ctx, presalers: 1 }).runAll();
  assert.equal(st.ps.length, 1);
  assert.equal(a.params[0].reveal.waves, 1);
  const b = mockChain();
  await assert.rejects(quickStart({ ...b.ctx, presalers: 5, room: () => 3 }).steps.wallets(), /needs 6 new wallets but only 3/);
  assert.equal(b.sent.length, 0);
});

test("old saved state {a, b} is upgraded to ps[]", () => {
  const q = quickStart(mockChain().ctx, { launcher: { accountId: "l.testnet" }, a: { accountId: "a.testnet" }, b: { accountId: "b.testnet" }, salts: { a: "1", b: "2" } });
  assert.deepEqual(q.state.ps.map((w) => w.accountId), ["a.testnet", "b.testnet"]);
  assert.deepEqual(q.state.salts, ["1", "2"]);
});

test("reuse: funded stored wallets fill launcher/presaler slots before the faucet", async () => {
  const { ctx } = mockChain();
  const gen = [];
  const N = 10n ** 24n;
  const pool = [{ w: { accountId: "rich.testnet" }, near: 9n * N }, { w: { accountId: "poor.testnet" }, near: N / 10n }, { w: { accountId: "mid.testnet" }, near: 2n * N }];
  const q = quickStart({ ...ctx, presalers: 3, room: () => 2, reuse: async () => pool.slice(), generate: async (l) => { gen.push(l); return { accountId: `kyp-t-${l}.testnet` }; } });
  await q.steps.wallets();
  assert.equal(q.state.launcher.accountId, "rich.testnet");
  assert.deepEqual(q.state.ps.map((w) => w.accountId), ["mid.testnet", "kyp-t-presaler-2.testnet", "kyp-t-presaler-3.testnet"]);
  assert.equal(q.state.ps[0].accountId, "mid.testnet", "poor wallet skipped");
  assert.equal(gen.length, 2);
}, );
