import test from "node:test";
import assert from "node:assert/strict";
import {
  createLaunchTx, launchNearNeeded, launchTx, depositTx, depositMsg, fitsInOneTx, totalGas, TGAS,
  isLauncher, depositGate, canWithdraw, canLaunch, parseWalletRedirect, claimTx, recordTx, revealTx, withdrawTx,
} from "./actions.mjs";

const NEAR = 10n ** 24n;
const base = { quote: "wrap.testnet", coordinator: "coord.kyp.testnet", signer: "ana.testnet" };
const launch = { launcher: "owl.testnet", status: "Open", sale_start: 100, sale_end: 1000, total_raised: (60n * NEAR).toString(), min_raise: (50n * NEAR).toString() };

test("deposit: registered + enough wNEAR = single ft_transfer_call", () => {
  const tx = depositTx({ ...base, amount: 10n * NEAR, msg: depositMsg("Deposit", 3, "abc"), state: { signerRegistered: true, coordinatorRegistered: true, wnearBalance: (20n * NEAR).toString(), storageMin: "1250000000000000000000" } });
  assert.equal(tx.receiverId, "wrap.testnet");
  assert.equal(tx.actions.length, 1);
  const a = tx.actions[0];
  assert.equal(a.method, "ft_transfer_call");
  assert.equal(a.deposit, "1");
  assert.deepEqual(a.args, { receiver_id: "coord.kyp.testnet", amount: (10n * NEAR).toString(), msg: '{"Deposit":{"launch_id":3,"salt":"abc"}}' });
});

test("deposit: registers signer + coordinator and wraps only the shortfall", () => {
  const tx = depositTx({ ...base, amount: 10n * NEAR, msg: "{}", state: { signerRegistered: false, coordinatorRegistered: false, wnearBalance: (4n * NEAR).toString(), storageMin: "1250000000000000000000" } });
  assert.deepEqual(tx.actions.map((a) => a.method), ["storage_deposit", "storage_deposit", "near_deposit", "ft_transfer_call"]);
  assert.equal(tx.actions[0].args.account_id, "ana.testnet");
  assert.equal(tx.actions[1].args.account_id, "coord.kyp.testnet");
  assert.equal(tx.actions[2].deposit, (6n * NEAR).toString());
  assert.ok(fitsInOneTx(tx), `gas ${totalGas(tx) / TGAS} Tgas`);
});

test("deposit: zero amount rejected", () => {
  assert.throws(() => depositTx({ ...base, amount: 0n, msg: "{}", state: { signerRegistered: true, coordinatorRegistered: true, wnearBalance: "0", storageMin: "0" } }));
});

test("create + launch attach the right NEAR", () => {
  const c = createLaunchTx("coord", { name: "x" }, (25n * NEAR / 10n).toString());
  assert.equal(c.actions[0].deposit, (26n * NEAR / 10n).toString());
  assert.equal(c.actions[0].method, "create_launch");
  const need = launchNearNeeded({ pool_storage_deposit: (NEAR / 10n).toString(), pool_create_deposit: (NEAR / 10n).toString(), liquidity_deposit: (NEAR / 20n).toString() });
  assert.equal(need, (3n * NEAR / 10n).toString());
  assert.equal(launchTx("coord", 7, need).actions[0].args.launch_id, 7);
  for (const tx of [c, launchTx("coord", 1, need), claimTx("lock", 1), recordTx("lock", 1), revealTx("coord", 1), withdrawTx("coord", 1)]) assert.ok(fitsInOneTx(tx));
});

test("gating: launcher-only launch, allowlist-only deposit", () => {
  assert.ok(isLauncher("owl.testnet", launch));
  assert.ok(!isLauncher("ana.testnet", launch));
  assert.ok(!isLauncher(null, launch));
  assert.ok(canLaunch({ account: "owl.testnet", launch, now: 500 }));
  assert.ok(!canLaunch({ account: "ana.testnet", launch, now: 500 }));
  assert.ok(!canLaunch({ account: "owl.testnet", launch, now: 1000 }));
  assert.ok(!canLaunch({ account: "owl.testnet", launch: { ...launch, total_raised: "1" }, now: 500 }));

  assert.equal(depositGate({ account: null, slot: null, launch, now: 500 }).reason, "connect");
  assert.equal(depositGate({ account: "x.testnet", slot: null, launch, now: 500 }).reason, "not-allowlisted");
  assert.equal(depositGate({ account: "ana.testnet", slot: { kind: "Open", filled: false }, launch, now: 500 }).reason, "deposit");
  assert.equal(depositGate({ account: "ana.testnet", slot: { kind: "Open", filled: false }, launch, now: 1000 }).reason, "closed");
  const r = { kind: { Reserved: { quote_amount: "1" } }, filled: false };
  assert.equal(depositGate({ account: "ana.testnet", slot: r, launch, now: 500 }).reason, "reserved-after-launch");
  assert.equal(depositGate({ account: "ana.testnet", slot: r, launch: { ...launch, status: "Live" }, now: 500 }).reason, "buy-reserved");

  assert.ok(!canWithdraw({ account: "ana.testnet", launch, now: 500, deposited: true }));
  assert.ok(canWithdraw({ account: "ana.testnet", launch, now: 1000, deposited: true }));
  assert.ok(canWithdraw({ account: "ana.testnet", launch: { ...launch, status: "Cancelled" }, now: 1, deposited: true }));
  assert.ok(!canWithdraw({ account: "ana.testnet", launch: { ...launch, status: "Cancelled" }, now: 1, deposited: false }));
});

test("wallet redirect parsing keeps other params", () => {
  assert.equal(parseWalletRedirect("?id=3"), null);
  const ok = parseWalletRedirect("?id=3&transactionHashes=AAA,BBB");
  assert.deepEqual(ok, { hashes: ["AAA", "BBB"], error: null, cleanSearch: "?id=3" });
  const bad = parseWalletRedirect("?errorCode=userRejected&errorMessage=User%2520rejected&id=2");
  assert.equal(bad.error, "User rejected");
  assert.equal(bad.cleanSearch, "?id=2");
});
