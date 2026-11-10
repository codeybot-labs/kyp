import test from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, parseNetwork, prepareManifest, skippedBridgedIds, accountFitsNetwork, mainnetOnlyMessage, explorerTxUrl, MAINNET_ONLY_SUFFIX } from "./network.mjs";

const w = (id, features = {}, extra = {}) => ({ id, name: id.toUpperCase(), type: "sandbox", features, permissions: {}, ...extra });
const MANIFEST = {
  version: "1",
  wallets: [
    w("hot-wallet"), w("meteor-wallet", { mainnet: true, testnet: true }), w("mynearwallet", {}, { permissions: { allowsOpen: ["https://app.mynearwallet.com"] } }),
    w("okx-wallet"), w("near-mobile", { mainnet: true, testnet: false }), w("trezu-wallet"), w("hana-wallet"), w("wallet-connect", { testnet: true }, { permissions: { walletConnect: true } }),
  ],
};

test("network defaults to testnet; rejects junk", () => {
  assert.equal(parseNetwork(undefined), "testnet");
  assert.equal(parseNetwork(" Mainnet "), "mainnet");
  assert.throws(() => parseNetwork("betanet"));
});

test("config switches RPC, wNEAR, explorer, MyNearWallet with the network", () => {
  const t = resolveConfig({});
  assert.equal(t.network, "testnet");
  assert.equal(t.rpc, "https://rpc.testnet.near.org");
  assert.equal(t.quote, "wrap.testnet");
  assert.equal(t.myNearWallet, "https://testnet.mynearwallet.com");
  const m = resolveConfig({ PUBLIC_NEAR_NETWORK: "mainnet" });
  assert.equal(m.rpc, "https://rpc.mainnet.near.org");
  assert.equal(m.quote, "wrap.near");
  assert.equal(m.myNearWallet, "https://app.mynearwallet.com");
  assert.equal(explorerTxUrl("H", "mainnet"), "https://nearblocks.io/txns/H");
  assert.equal(explorerTxUrl("H", "testnet"), "https://testnet.nearblocks.io/txns/H");
});

test("contract IDs follow the network; testnet IDs never leak into mainnet", () => {
  const env = { PUBLIC_KYP_COORDINATOR: "c.kyp.testnet", PUBLIC_KYP_LOCK: "l.kyp.testnet", PUBLIC_NEAR_RPC: "https://my.testnet.rpc" };
  const t = resolveConfig(env);
  assert.equal(t.coordinator, "c.kyp.testnet");
  assert.equal(t.rpc, "https://my.testnet.rpc");
  assert.ok(t.configured);
  const m = resolveConfig({ ...env, PUBLIC_NEAR_NETWORK: "mainnet" });
  assert.equal(m.coordinator, ""); // legacy unprefixed vars are testnet-only
  assert.equal(m.rpc, "https://rpc.mainnet.near.org");
  assert.ok(!m.configured); // -> demo mode
  const m2 = resolveConfig({ PUBLIC_NEAR_NETWORK: "mainnet", PUBLIC_KYP_MAINNET_COORDINATOR: "c.kyp.near", PUBLIC_KYP_MAINNET_LOCK: "l.kyp.near" });
  assert.equal(m2.coordinator, "c.kyp.near");
  assert.ok(m2.configured);
  assert.throws(() => resolveConfig({ PUBLIC_NEAR_NETWORK: "mainnet", PUBLIC_KYP_MAINNET_COORDINATOR: "c.kyp.testnet" }), /not a mainnet account/);
  assert.throws(() => resolveConfig({ PUBLIC_KYP_TESTNET_LOCK: "l.kyp.near" }), /not a testnet account/);
  assert.ok(accountFitsNetwork("a".repeat(64), "mainnet"));
});

test("testnet: mainnet-only wallets stay listed, labelled, and flagged", () => {
  const { manifest, mainnetOnly } = prepareManifest(MANIFEST, "testnet");
  const byId = Object.fromEntries(manifest.wallets.map((x) => [x.id, x]));
  assert.deepEqual(mainnetOnly.sort(), ["hana-wallet", "hot-wallet", "okx-wallet", "trezu-wallet"]);
  for (const id of mainnetOnly) {
    assert.ok(byId[id].name.endsWith(MAINNET_ONLY_SUFFIX), id);
    assert.equal(byId[id].features.testnet, true, id);
  }
  assert.equal(byId["meteor-wallet"].name, "METEOR-WALLET");
  assert.equal(byId.mynearwallet.name, "MYNEARWALLET"); // works on testnet via override, not labelled
  assert.ok(byId.mynearwallet.permissions.allowsOpen.includes("https://testnet.mynearwallet.com"));
  assert.ok(!byId["near-mobile"], "testnet NEAR Mobile comes from the bridged module");
  assert.ok(byId["wallet-connect"]);
  assert.equal(MANIFEST.wallets[0].name, "HOT-WALLET", "input not mutated");
  assert.match(mainnetOnlyMessage(byId["hot-wallet"].name), /^HOT-WALLET only works on NEAR mainnet/);
});

test("mainnet: manifest untouched, no labels; bridged NEAR Mobile duplicate skipped", () => {
  const { manifest, mainnetOnly } = prepareManifest(MANIFEST, "mainnet");
  assert.deepEqual(mainnetOnly, []);
  assert.equal(manifest.wallets.length, MANIFEST.wallets.length);
  assert.ok(manifest.wallets.every((x) => !x.name.includes("mainnet only")));
  assert.ok(!manifest.wallets.find((x) => x.id === "mynearwallet").permissions.allowsOpen.includes("https://testnet.mynearwallet.com"));
  assert.deepEqual(skippedBridgedIds("mainnet"), ["near-mobile-wallet"]);
  assert.deepEqual(skippedBridgedIds("testnet"), []);
});
