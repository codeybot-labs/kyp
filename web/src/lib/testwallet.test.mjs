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
