// TESTNET-ONLY in-browser test wallets. Keys are generated in the browser, kept only in this
// browser's localStorage, and used to sign testnet transactions directly over RPC. Accounts are
// created by NEAR's free testnet faucet helper (the same one near-cli-rs `sponsor-by-faucet-service`
// uses), which allows browser CORS. Nothing here may ever run on mainnet: every entry point calls
// assertTestnet(), accounts must end in ".testnet", and the RPC must be a testnet RPC.

export const TESTNET_HELPER = "https://helper.nearprotocol.com/account";
export const STORAGE_KEY = "kyp-testnet-wallets";
export const ACTIVE_KEY = "kyp-testnet-wallet-active";
export const WALLET_ID = "kyp-testnet-wallet";
export const WALLET_NAME = "Test wallet (testnet only)";

export function assertTestnet(network, rpc) {
  if (network !== "testnet") throw new Error("Test wallets are testnet-only and disabled on this network");
  if (rpc !== undefined && !/testnet/i.test(String(rpc))) throw new Error(`Test wallets need a testnet RPC, got ${rpc}`);
}

const ID_RE = /^(?=.{2,64}$)[a-z0-9]+([_-][a-z0-9]+)*\.testnet$/;
export const validTestnetAccount = (id) => ID_RE.test(String(id ?? ""));
export const validSecretKey = (k) => /^ed25519:[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(String(k ?? ""));

/** Fresh random top-level testnet name, e.g. kyp-t-launcher-k3j9x2.testnet */
export function newAccountId(label = "", rand = Math.random) {
  const tag = String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 16);
  const r = Array.from({ length: 8 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(rand() * 36)]).join("");
  return `kyp-t-${tag ? tag + "-" : ""}${r}.testnet`;
}

// ---------------------------------------------------------------- storage (localStorage-like)

export function loadWallets(storage) {
  try {
    const v = JSON.parse(storage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(v) ? v.filter((w) => validTestnetAccount(w.accountId) && validSecretKey(w.secretKey)) : [];
  } catch { return []; }
}
const save = (storage, list) => storage.setItem(STORAGE_KEY, JSON.stringify(list));
export const getActiveId = (storage) => storage.getItem(ACTIVE_KEY) || null;
export function getActive(storage) {
  const list = loadWallets(storage);
  const id = getActiveId(storage);
  return list.find((w) => w.accountId === id) ?? list[0] ?? null;
}
export function setActive(storage, accountId) {
  if (!loadWallets(storage).some((w) => w.accountId === accountId)) throw new Error("unknown test wallet");
  storage.setItem(ACTIVE_KEY, accountId);
}
export function addWallet(storage, w) {
  if (!validTestnetAccount(w.accountId)) throw new Error("Test wallets must be .testnet accounts");
  if (!validSecretKey(w.secretKey)) throw new Error("Key must look like ed25519:…");
  const list = loadWallets(storage).filter((x) => x.accountId !== w.accountId);
  list.push({ accountId: w.accountId, secretKey: w.secretKey, label: w.label || "", createdAt: w.createdAt || Date.now(), imported: !!w.imported });
  save(storage, list);
  if (!getActiveId(storage)) storage.setItem(ACTIVE_KEY, w.accountId);
  return list;
}
export function removeWallet(storage, accountId) {
  const list = loadWallets(storage).filter((x) => x.accountId !== accountId);
  save(storage, list);
  if (getActiveId(storage) === accountId) {
    if (list[0]) storage.setItem(ACTIVE_KEY, list[0].accountId); else storage.removeItem(ACTIVE_KEY);
  }
  return list;
}
export function exportWallet(storage, accountId) {
  const w = loadWallets(storage).find((x) => x.accountId === accountId);
  if (!w) throw new Error("unknown test wallet");
  return JSON.stringify({ network: "testnet", account_id: w.accountId, private_key: w.secretKey, warning: "TESTNET ONLY. Never send real funds to this account." }, null, 2);
}
/** Accepts the export JSON or a near-cli credentials file ({account_id, private_key}). */
export function parseImport(text, accountIdHint = "") {
  let accountId = accountIdHint.trim(), secretKey = "";
  const t = String(text).trim();
  if (t.startsWith("{")) {
    const j = JSON.parse(t);
    accountId = j.account_id || j.accountId || accountId;
    secretKey = j.private_key || j.secret_key || j.secretKey || "";
  } else secretKey = t;
  if (!validTestnetAccount(accountId)) throw new Error("Need a .testnet account id");
  if (!validSecretKey(secretKey)) throw new Error("Key must look like ed25519:…");
  return { accountId, secretKey, imported: true };
}

// ---------------------------------------------------------------- faucet

/** Create a new funded testnet account with a browser-generated key. Returns the wallet record. */
export async function generateTestWallet({ network, label = "", fetchImpl = fetch, helper = TESTNET_HELPER, rand } = {}) {
  assertTestnet(network);
  const { KeyPair } = await import("@near-js/crypto");
  const kp = KeyPair.fromRandom("ed25519");
  const accountId = newAccountId(label, rand);
  const r = await fetchImpl(helper, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: kp.getPublicKey().toString() }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`Testnet faucet refused (${r.status}): ${body.slice(0, 160)}`);
  return { accountId, secretKey: kp.toString(), label, createdAt: Date.now() };
}

// ---------------------------------------------------------------- signing (direct RPC)

/** Convert a site tx ({receiverId, actions:[{method,args,gas,deposit}]}) to near-js actions. */
export async function toNearActions(tx) {
  const { actionCreators } = await import("@near-js/transactions");
  return tx.actions.map((a) => actionCreators.functionCall(a.method, a.args ?? {}, BigInt(a.gas), BigInt(a.deposit ?? "0")));
}

export function failureMessage(outcome) {
  const f = outcome?.status?.Failure ?? outcome?.receipts_outcome?.map((r) => r?.outcome?.status?.Failure).find(Boolean);
  if (!f) return null;
  return f?.ActionError?.kind?.FunctionCallError?.ExecutionError ?? JSON.stringify(f).slice(0, 200);
}

/** Sign one site tx with a test wallet and send it to the testnet RPC. Returns { hash, outcome }. */
export async function signAndSendWithTestWallet({ network, rpc, wallet, tx }) {
  assertTestnet(network, rpc);
  if (!validTestnetAccount(wallet?.accountId) || !/^[a-z0-9._-]+\.testnet$/.test(String(tx?.receiverId))) throw new Error("testnet accounts only");
  const [{ Account }, { JsonRpcProvider }, { KeyPairSigner }] = await Promise.all([import("@near-js/accounts"), import("@near-js/providers"), import("@near-js/signers")]);
  const provider = new JsonRpcProvider({ url: rpc });
  const account = new Account(wallet.accountId, provider, KeyPairSigner.fromSecretKey(wallet.secretKey));
  const outcome = await account.signAndSendTransaction({ receiverId: tx.receiverId, actions: await toNearActions(tx), throwOnFailure: false });
  const hash = outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id ?? null;
  const err = failureMessage(outcome);
  if (err) { const e = new Error(err); e.hash = hash; throw e; }
  return { hash, outcome };
}

/** NEAR balance (yocto string) of an account, or null if it doesn't exist. */
export async function nearBalance(rpc, accountId, fetchImpl = fetch) {
  const r = await fetchImpl(rpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "kyp", method: "query", params: { request_type: "view_account", finality: "optimistic", account_id: accountId } }) });
  const j = await r.json();
  return j?.result?.amount ?? null;
}
