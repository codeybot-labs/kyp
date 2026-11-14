import test from "node:test";
import assert from "node:assert/strict";
import { assertTestnet, newAccountId, validTestnetAccount, addWallet, loadWallets, removeWallet, getActive, setActive, exportWallet, parseImport,
  generateTestWallet, toNearActions, failureMessage, STORAGE_KEY, signAndSendWithTestWallet } from "./testwallet.mjs";

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
const KEY = "ed25519:" + "3".repeat(88);

test("testnet only: mainnet and non-testnet RPCs are refused", async () => {
  assert.throws(() => assertTestnet("mainnet"), /testnet-only/);
  assert.throws(() => assertTestnet("testnet", "https://rpc.mainnet.near.org"), /testnet RPC/);
  assertTestnet("testnet", "https://rpc.testnet.fastnear.com");
  await assert.rejects(generateTestWallet({ network: "mainnet", fetchImpl: () => { throw new Error("must not call"); } }), /testnet-only/);
  await assert.rejects(signAndSendWithTestWallet({ network: "mainnet", rpc: "https://rpc.mainnet.near.org", wallet: { accountId: "a.testnet", secretKey: KEY }, tx: { receiverId: "x.near", actions: [] } }), /testnet-only/);
});

test("account names are valid fresh .testnet names", () => {
  const id = newAccountId("Presaler A");
  assert.match(id, /^kyp-t-presaler-a-[a-z0-9]{8}\.testnet$/);
  assert.ok(validTestnetAccount(id));
  assert.ok(!validTestnetAccount("bob.near"));
  assert.notEqual(newAccountId(), newAccountId());
});

test("store: add, active, switch, export/import, delete", () => {
  const s = mem();
  addWallet(s, { accountId: "a-1.testnet", secretKey: KEY, label: "launcher" });
  addWallet(s, { accountId: "b-2.testnet", secretKey: KEY });
  assert.equal(loadWallets(s).length, 2);
  assert.equal(getActive(s).accountId, "a-1.testnet", "first one becomes active");
  setActive(s, "b-2.testnet");
  assert.equal(getActive(s).accountId, "b-2.testnet");
  assert.throws(() => addWallet(s, { accountId: "c.near", secretKey: KEY }), /testnet/);
  const exp = exportWallet(s, "a-1.testnet");
  assert.match(exp, /TESTNET ONLY/);
  const imp = parseImport(exp);
  assert.deepEqual([imp.accountId, imp.secretKey], ["a-1.testnet", KEY]);
  assert.equal(parseImport(KEY, "z-9.testnet").accountId, "z-9.testnet");
  assert.throws(() => parseImport("not a key", "z.testnet"), /ed25519/);
  removeWallet(s, "b-2.testnet");
  assert.equal(getActive(s).accountId, "a-1.testnet", "active falls back after delete");
  removeWallet(s, "a-1.testnet");
  assert.equal(getActive(s), null);
  s.setItem(STORAGE_KEY, "garbage");
  assert.deepEqual(loadWallets(s), []);
});

test("generate posts a fresh public key to the testnet helper and keeps the secret local", async () => {
  let sent;
  const w = await generateTestWallet({ network: "testnet", label: "x", fetchImpl: async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return { ok: true, status: 200, text: async () => "{}" }; } });
  assert.equal(sent.url, "https://helper.nearprotocol.com/account");
  assert.equal(sent.body.newAccountId, w.accountId);
  assert.match(sent.body.newAccountPublicKey, /^ed25519:/);
  assert.ok(!JSON.stringify(sent).includes(w.secretKey.slice(8)), "secret never leaves the browser");
  assert.match(w.secretKey, /^ed25519:/);
  await assert.rejects(generateTestWallet({ network: "testnet", fetchImpl: async () => ({ ok: false, status: 429, text: async () => "slow down" }) }), /429/);
});

test("site tx -> near-js function call actions; failures surface", async () => {
  const acts = await toNearActions({ receiverId: "wrap.testnet", actions: [{ method: "near_deposit", args: {}, gas: "10000000000000", deposit: "1000" }] });
  assert.equal(acts.length, 1);
  assert.equal(acts[0].functionCall.methodName, "near_deposit");
  assert.equal(acts[0].functionCall.deposit, 1000n);
  assert.equal(failureMessage({ status: { SuccessValue: "" } }), null);
  assert.equal(failureMessage({ status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "boom" } } } } } }), "boom");
});

import { MAX_WALLETS, roomLeft, generateBatch } from "./testwallet.mjs";
test("store caps at 10 wallets (re-adding an existing one is fine)", () => {
  const s = mem();
  for (let i = 0; i < MAX_WALLETS; i++) addWallet(s, { accountId: `w-${i}.testnet`, secretKey: KEY });
  assert.equal(roomLeft(s), 0);
  assert.throws(() => addWallet(s, { accountId: "w-10.testnet", secretKey: KEY }), /maximum of 10/);
  addWallet(s, { accountId: "w-3.testnet", secretKey: KEY, label: "again" });
  assert.equal(loadWallets(s).length, 10);
  removeWallet(s, "w-0.testnet");
  assert.equal(roomLeft(s), 1);
});

test("batch: sequential, throttled, retries a transient error, keeps going past a hard failure, respects room", async () => {
  const sleeps = [], events = [];
  let calls = 0;
  const added = [];
  const r = await generateBatch({
    count: 4, room: 10, label: "x", sleep: async (ms) => { sleeps.push(ms); }, onProgress: (p) => events.push(`${p.i}:${p.status}`),
    generate: async (label) => {
      calls++;
      if (calls === 2) throw new Error("Testnet faucet refused (503): busy"); // wallet 2, first try
      if (label === "x-3") throw new Error("Testnet faucet refused (500): down");   // wallet 3 always fails
      return { accountId: `kyp-t-${label}-${calls}.testnet` };
    },
    add: (w) => added.push(w.accountId),
  });
  assert.equal(r.created.length, 3);
  assert.deepEqual(r.errors.map((e) => e.i), [2]);
  assert.match(r.errors[0].error, /500/);
  assert.ok(events.includes("1:retry") && events.includes("1:ok") && events.includes("2:error") && events.includes("3:ok"));
  assert.ok(sleeps.includes(1500) && sleeps.includes(4000), "gap between calls + backoff on failure");
  assert.equal(added.length, 3);
  const capped = await generateBatch({ count: 10, room: 2, generate: async (l) => ({ accountId: l }), add: () => {}, sleep: async () => {} });
  assert.equal(capped.created.length, 2);
  assert.equal(capped.skipped, 8);
  await assert.rejects(generateBatch({ count: 1, room: 0, generate: async () => ({}), add: () => {} }), /maximum of 10/);
  const clamp = await generateBatch({ count: 50, room: 10, generate: async (l) => ({ accountId: l }), add: () => {}, sleep: async () => {} });
  assert.equal(clamp.created.length, 10, "never more than 10 per batch");
});

import { isRateLimit, createFundedByWallet } from "./testwallet.mjs";
test("faucet rate limit stops the batch instead of hammering it", async () => {
  assert.ok(isRateLimit(new Error("Testnet faucet refused (429): Rate limit exceeded, retry in 12 hours.")));
  assert.ok(!isRateLimit(new Error("Testnet faucet refused (500): down")));
  let calls = 0; const ev = [];
  const r = await generateBatch({ count: 5, room: 10, sleep: async () => {}, onProgress: (p) => ev.push(`${p.i}:${p.status}`), add: () => {},
    generate: async (l) => { if (++calls === 2) throw new Error("Testnet faucet refused (429): Rate limit exceeded"); return { accountId: l }; } });
  assert.equal(calls, 2, "no retries on a rate limit");
  assert.equal(r.created.length, 1);
  assert.ok(r.rateLimited);
  assert.deepEqual(ev.filter((e) => e.endsWith("error")), ["1:error", "2:error", "3:error", "4:error"]);
});

test("fallback: a funded test wallet creates + funds a new account via the testnet registrar", async () => {
  let sent;
  const w = await createFundedByWallet({ network: "testnet", rpc: "https://rpc.testnet.fastnear.com", funder: { accountId: "rich.testnet", secretKey: KEY }, label: "p",
    send: async (a) => { sent = a; return { hash: "H" }; },
    fetchImpl: async () => ({ json: async () => ({ result: { amount: "2000000000000000000000000" } }) }) });
  assert.equal(sent.tx.receiverId, "testnet");
  assert.equal(sent.tx.actions[0].method, "create_account");
  assert.equal(sent.tx.actions[0].args.new_account_id, w.accountId);
  assert.match(sent.tx.actions[0].args.new_public_key, /^ed25519:/);
  assert.equal(sent.tx.actions[0].deposit, "2000000000000000000000000");
  assert.ok(!JSON.stringify(sent.tx).includes(w.secretKey.slice(8)));
  assert.equal(w.fundedBy, "rich.testnet");
  await assert.rejects(createFundedByWallet({ network: "testnet", rpc: "https://rpc.testnet.fastnear.com", funder: { accountId: "rich.testnet", secretKey: KEY }, send: async () => ({ hash: "H" }), fetchImpl: async () => ({ json: async () => ({ error: {} }) }) }), /did not create/);
  await assert.rejects(createFundedByWallet({ network: "mainnet", rpc: "https://rpc.mainnet.near.org", funder: {} }), /testnet-only/);
});

import { isUncertainSendError, waitForTx, txHash } from "./testwallet.mjs";
test("uncertain send errors are looked up on chain before failing", async () => {
  assert.ok(isUncertainSendError(new Error("Transaction has expired")));
  assert.ok(isUncertainSendError({ type: "TimeoutError", message: "x" }));
  assert.ok(!isUncertainSendError(new Error("Smart contract panicked: launcher only")));
  let calls = 0;
  const provider = { viewTransactionStatus: async () => { if (++calls < 3) throw new Error("[-32000] UNKNOWN_TRANSACTION"); return { status: { SuccessValue: "" } }; } };
  assert.deepEqual(await waitForTx({ provider, hash: "h", accountId: "a.testnet", sleep: async () => {} }), { status: { SuccessValue: "" } });
  const never = { viewTransactionStatus: async () => { throw new Error("UNKNOWN_TRANSACTION"); } };
  assert.equal(await waitForTx({ provider: never, hash: "h", accountId: "a.testnet", tries: 2, sleep: async () => {} }), null);
  assert.equal((await txHash(new Uint8Array([1, 2, 3]))).length > 40, true);
});
