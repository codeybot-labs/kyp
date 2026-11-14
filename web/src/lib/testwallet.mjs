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
export const MAX_WALLETS = 10; // per browser
export const capMessage = (n = MAX_WALLETS) => `This browser already holds the maximum of ${n} test wallets. Delete one to add another.`;
export const roomLeft = (storage) => Math.max(0, MAX_WALLETS - loadWallets(storage).length);

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
  const all = loadWallets(storage);
  if (!all.some((x) => x.accountId === w.accountId) && all.length >= MAX_WALLETS) throw new Error(capMessage());
  const list = all.filter((x) => x.accountId !== w.accountId);
  list.push({ accountId: w.accountId, secretKey: w.secretKey, label: w.label || "", createdAt: w.createdAt || Date.now(), imported: !!w.imported, ...(w.fundedBy ? { fundedBy: w.fundedBy } : {}) });
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

/** NEAR's faucet limits each IP (e.g. 429 "Rate limit exceeded, retry in 12 hours"); retrying soon won't help. */
export const isRateLimit = (e) => /\(429\)|rate limit/i.test(String(e?.message ?? e));

export const FALLBACK_FUND = (2n * 10n ** 24n).toString(); // 2 testnet NEAR per wallet funded from another test wallet
export const FUNDER_RESERVE = 10n ** 24n; // the funder keeps at least 1 NEAR

/**
 * Faucet fallback: `funder` (a test wallet already holding testnet NEAR) creates a new top-level
 * .testnet account through the `testnet` registrar (create_account, like near-cli fund-myself) and
 * funds it with `amount`. The new key is generated here; only its public key goes on chain.
 */
export async function createFundedByWallet({ network, rpc, funder, label = "", amount = FALLBACK_FUND, rand, fetchImpl = fetch, send = signAndSendWithTestWallet }) {
  assertTestnet(network, rpc);
  const { KeyPair } = await import("@near-js/crypto");
  const kp = KeyPair.fromRandom("ed25519");
  const accountId = newAccountId(label, rand);
  const tx = { receiverId: "testnet", actions: [{ method: "create_account", args: { new_account_id: accountId, new_public_key: kp.getPublicKey().toString() }, gas: (100n * 10n ** 12n).toString(), deposit: String(amount) }] };
  const { hash } = await send({ network, rpc, wallet: funder, tx });
  if ((await nearBalance(rpc, accountId, fetchImpl)) == null) throw Object.assign(new Error(`create_account via testnet did not create ${accountId}`), { hash });
  return { accountId, secretKey: kp.toString(), label, createdAt: Date.now(), fundedBy: funder.accountId, hash };
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

/** Errors after which a tx may still have landed (so check its status instead of failing). */
export function isUncertainSendError(e) {
  return /expired|time(d)?[ _-]?out|TIMEOUT|408|502|503|504|fetch failed|network ?error/i.test(String(e?.message ?? e) + " " + String(e?.type ?? ""));
}

/** NEAR tx hash = base58(sha256(borsh(Transaction))). */
export async function txHash(encoded) {
  const { baseEncode } = await import("@near-js/utils");
  return baseEncode(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", encoded)));
}

/** Poll tx status until it is found (returns the outcome) or `tries` run out (returns null). */
export async function waitForTx({ provider, hash, accountId, tries = 12, gapMs = 3000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  for (let i = 0; i < tries; i++) {
    try {
      const o = await provider.viewTransactionStatus(hash, accountId, "EXECUTED_OPTIMISTIC");
      if (o?.status && (o.status.SuccessValue !== undefined || o.status.Failure || o.status.SuccessReceiptId)) return o;
    } catch (e) {
      if (!/UNKNOWN_TRANSACTION|doesn't exist|not exist|timeout|expired/i.test(String(e?.message ?? e) + " " + String(e?.type ?? ""))) throw e;
    }
    await sleep(gapMs);
  }
  return null;
}

/** Sign one site tx with a test wallet and send it to the testnet RPC. Returns { hash, outcome }. */
export async function signAndSendWithTestWallet({ network, rpc, wallet, tx }) {
  assertTestnet(network, rpc);
  if (!validTestnetAccount(wallet?.accountId) || !(/^[a-z0-9._-]+\.testnet$/.test(String(tx?.receiverId)) || tx?.receiverId === "testnet")) throw new Error("testnet accounts only");
  const [{ Account }, { JsonRpcProvider }, { KeyPairSigner }] = await Promise.all([import("@near-js/accounts"), import("@near-js/providers"), import("@near-js/signers")]);
  const provider = new JsonRpcProvider({ url: rpc });
  const account = new Account(wallet.accountId, provider, KeyPairSigner.fromSecretKey(wallet.secretKey));
  const signed = await account.createSignedTransaction(tx.receiverId, await toNearActions(tx));
  const sentHash = await txHash(signed.transaction.encode());
  let outcome;
  try {
    outcome = await provider.sendTransactionUntil(signed, "EXECUTED_OPTIMISTIC");
  } catch (e) {
    // "Transaction has expired" / RPC timeouts can come back even though the tx landed (the RPC
    // re-broadcast a tx that already executed, or gave up waiting). Look it up before failing.
    if (!isUncertainSendError(e)) throw e;
    outcome = await waitForTx({ provider, hash: sentHash, accountId: wallet.accountId });
    if (!outcome) { const err = new Error(`${e?.message ?? e} (not found on chain after waiting; nothing was sent, safe to retry)`); err.hash = sentHash; throw err; }
  }
  const hash = outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id ?? sentHash;
  const err = failureMessage(outcome);
  if (err) { const e = new Error(err); e.hash = hash; throw e; }
  return { hash, outcome };
}

/** NEAR balance (yocto string) of an account, or null if it doesn't exist. */
export async function nearBalance(rpc, accountId, fetchImpl = fetch) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: "kyp", method: "query", params: { request_type: "view_account", finality: "optimistic", account_id: accountId } });
  const one = async (url) => { const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body }); if (r.ok === false) throw new Error(`RPC HTTP ${r.status}`); return r.json(); };
  let j;
  try { j = await one(rpc); }
  catch (e) { const fb = "https://rpc.testnet.near.org"; if (rpc === fb || !/testnet/.test(rpc)) throw e; j = await one(fb); } // rate-limited primary RPC
  return j?.result?.amount ?? null;
}

/**
 * Generate up to `count` (1-10, and never past the 10-wallet cap) wallets one at a time, with a
 * pause between faucet calls and retries with backoff on failure (e.g. 429 rate limits), so one
 * refusal doesn't sink the batch. onProgress({ i, total, status: "creating"|"ok"|"retry"|"error", accountId?, error? }).
 * Returns { created: [wallet], errors: [{ i, error }] }. `add(wallet)` stores each one as it lands.
 */
export async function generateBatch({ count, room, generate, add, label = "wallet", onProgress = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), gapMs = 1500, retries = 2, backoffMs = 4000 }) {
  const want = Math.max(1, Math.min(MAX_WALLETS, Math.floor(Number(count) || 1)));
  if (room <= 0) throw new Error(capMessage());
  const total = Math.min(want, room);
  const created = [], errors = [];
  for (let i = 0; i < total; i++) {
    if (i > 0) await sleep(gapMs);
    onProgress({ i, total, status: "creating" });
    for (let attempt = 0; ; attempt++) {
      try {
        const w = await generate(total > 1 ? `${label}-${i + 1}` : label);
        add(w); created.push(w);
        onProgress({ i, total, status: "ok", accountId: w.accountId });
        break;
      } catch (e) {
        const error = e?.message ?? String(e);
        if (isRateLimit(e)) { // faucet limit and no funded wallet to fall back on: stop, don't hammer it
          errors.push({ i, error }); onProgress({ i, total, status: "error", error });
          for (let j = i + 1; j < total; j++) onProgress({ i: j, total, status: "error", error: "skipped (faucet rate limit)" });
          return { created, errors, skipped: want - i - 1, rateLimited: true };
        }
        if (/maximum of/.test(error)) { errors.push({ i, error }); onProgress({ i, total, status: "error", error }); return { created, errors, skipped: want - i - 1 }; }
        if (attempt < retries) { onProgress({ i, total, status: "retry", error }); await sleep(backoffMs * (attempt + 1)); continue; }
        errors.push({ i, error }); onProgress({ i, total, status: "error", error });
        break;
      }
    }
  }
  return { created, errors, skipped: want - total };
}
