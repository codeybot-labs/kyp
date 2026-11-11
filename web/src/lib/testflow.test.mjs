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
  assert.equal(sent[3][0], st.a.accountId, "presaler A deposits");
  assert.ok(logs.filter((l) => l.hash).every((l) => l.account));
  assert.throws(() => quickStart({ ...ctx, network: "mainnet" }), /testnet-only/);
});
