// NEAR wallet login + signing via NEAR Connect (@hot-labs/near-connect), the connector NEAR docs
// recommend, on the configured network (PUBLIC_NEAR_NETWORK, default testnet). On testnet,
// mainnet-only wallets are still listed, labelled "(mainnet only)"; clicking one explains instead
// of connecting. WalletConnect-based wallets appear only when PUBLIC_WALLETCONNECT_PROJECT_ID is set. Loaded lazily in the browser. NEAR Connect keeps the session in
// localStorage/IndexedDB, so a reload keeps you signed in. Legacy wallet-selector-only wallets are
// bridged into the same modal (see wallet-bridge.ts).
// No private keys are handled here: the wallet signs.
import { createSignal } from "solid-js";
import { CONFIG, NETWORK, NETWORK_LABEL, TEST_WALLETS } from "./config";
import { prepareManifest, mainnetOnlyMessage } from "./network.mjs";
import { view } from "./near";
import { explorerTx, parseWalletRedirect, depositTx } from "./actions.mjs";

const TEST_WALLET_ID = "kyp-testnet-wallet";
type Connector = import("@hot-labs/near-connect").NearConnector;
export interface Tx { receiverId: string; actions: { method: string; args: Record<string, unknown>; gas: string; deposit: string }[] }

const [account, setAccount] = createSignal<string | null>(null);
const [walletName, setWalletName] = createSignal<string | null>(null);
const [ready, setReady] = createSignal(false);
const [busy, setBusy] = createSignal(false);
const [initError, setInitError] = createSignal<string | null>(null);
export { account, walletName, ready as walletReady, busy as walletBusy, initError as walletInitError };

const MANIFEST_URLS = [
  "https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json",
  "https://cdn.jsdelivr.net/gh/azbang/hot-connector/repository/manifest.json",
];

let connector: Connector | null = null;
let initP: Promise<void> | null = null;
/** Wallet id -> display name, for wallets listed on this network but only usable on mainnet. */
const mainnetOnly = new Map<string, string>();

/** Thrown when the user picks a mainnet-only wallet on testnet. Carries a readable explanation. */
export class MainnetOnlyWallet extends Error {
  constructor(public walletId: string, name: string) { super(mainnetOnlyMessage(name)); this.name = "MainnetOnlyWallet"; }
}

async function loadManifest() {
  for (const url of MANIFEST_URLS) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const { manifest, mainnetOnly: ids } = prepareManifest(await r.json(), NETWORK);
      for (const w of manifest.wallets) if (ids.includes(w.id)) mainnetOnly.set(w.id, w.name);
      return manifest;
    } catch { /* try next */ }
  }
  return undefined; // NearConnector falls back to its own manifest URLs (unlabelled)
}

/** WalletConnect sign client, only when a Reown project ID is configured. No ID = those wallets stay hidden. */
function walletConnectClient() {
  const projectId = CONFIG.walletConnectProjectId;
  if (!projectId) return undefined;
  return import("@walletconnect/sign-client").then((m) => m.default.init({
    projectId,
    metadata: { name: "KYP", description: "Know Your Presalers", url: location.origin, icons: [`${location.origin}/favicon.svg`] },
  }));
}

export function initWallet(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (initP) return initP;
  initP = (async () => {
    try {
      // Some legacy wallet SDKs expect Node's `global` and `Buffer` in the browser.
      (globalThis as any).global ??= globalThis;
      if (!(globalThis as any).Buffer) (globalThis as any).Buffer = (await import("buffer")).Buffer;
      // Testnet builds only: offer in-browser faucet test wallets in the picker (standard injected wallet).
      if (TEST_WALLETS) (await import("./testwallet-ui")).injectTestWallet();
      const [{ NearConnector }, manifest] = await Promise.all([import("@hot-labs/near-connect"), loadManifest()]);
      connector = new NearConnector({
        network: NETWORK,
        manifest,
        walletConnect: walletConnectClient() as any,
        features: { signAndSendTransaction: true },
        footerBranding: { icon: "/favicon.svg", heading: `KYP · ${NETWORK_LABEL}`, link: "https://wallet.near.org", linkText: "Don't have a wallet?" },
      });
      connector.on("wallet:signIn", (e) => { setAccount(e.accounts[0]?.accountId ?? null); setWalletName(e.wallet.manifest.name); });
      connector.on("wallet:signOut", () => { setAccount(null); setWalletName(null); });
      // Announce wallet-selector-only wallets before restoring, so a saved session on one of them is found.
      const { announceBridgedWallets } = await import("./wallet-bridge");
      await announceBridgedWallets(CONFIG.coordinator || CONFIG.quote).catch((e) => console.warn("legacy wallet bridge failed", e));
      // Order: NEAR Connect manifest wallets first (manifest order), then bridged ones (our order),
      // then (on testnet) the mainnet-only ones.
      await connector.whenManifestLoaded;
      const { BRIDGED_IDS } = await import("./wallet-bridge");
      // Mainnet-only wallets (testnet builds) go last.
      const rank = (id: string) => id === TEST_WALLET_ID ? -1 : (mainnetOnly.has(id) ? 2000 : 0) + (BRIDGED_IDS.includes(id) ? 1000 + BRIDGED_IDS.indexOf(id) : (connector!.manifest.wallets.findIndex((w) => w.id === id) + 1000) % 1000);
      connector.wallets.sort((a, b) => rank(a.manifest.id) - rank(b.manifest.id));
      (window as any).kypWallets = {
        network: NETWORK,
        available: () => connector!.availableWallets.map((w) => `${w.manifest.id}:${w.manifest.name}`),
        mainnetOnly: () => [...mainnetOnly.keys()],
      };
      try {
        const { wallet, accounts } = await connector.getConnectedWallet();
        setAccount(accounts[0]?.accountId ?? null);
        setWalletName(wallet.manifest.name);
      } catch { /* not signed in */ }
    } catch (e: any) {
      setInitError(e?.message ?? String(e));
      console.warn("wallet connector failed to load", e);
    } finally {
      setReady(true);
    }
  })();
  return initP;
}

export async function connect() {
  await initWallet();
  if (!connector) throw new Error(initError() ?? "wallet connector unavailable");
  try {
    const walletId = await connector.selectWallet();
    const name = mainnetOnly.get(walletId);
    if (name) throw new MainnetOnlyWallet(walletId, name);
    await connector.connect({ walletId });
  } catch (e: any) {
    if (e instanceof MainnetOnlyWallet) throw e;
    if (!/reject/i.test(String(e?.message ?? e))) throw e;
  }
}
/** Sign in as the active in-browser test wallet (testnet builds only), replacing any current session. */
export async function connectTestWallet() {
  if (!TEST_WALLETS) throw new Error("Test wallets are testnet-only");
  await initWallet();
  if (!connector) throw new Error(initError() ?? "wallet connector unavailable");
  try { await connector.disconnect(); } catch { /* not connected */ }
  await connector.connect({ walletId: TEST_WALLET_ID });
}
export async function disconnect() {
  await initWallet();
  if (!connector) return;
  try { await connector.disconnect(); } finally { setAccount(null); setWalletName(null); }
}
/** Wallet ids currently offered in the connect modal (for tests/diagnostics). */
export async function availableWalletIds(): Promise<string[]> {
  await initWallet();
  return connector ? connector.availableWallets.map((w) => w.manifest.id) : [];
}

/** Show the outcome of a redirect-based wallet (MyNearWallet) and clean the URL. Returns hashes. */
export function consumeWalletRedirect(notify: (text: string, kind: "ok" | "bad") => void) {
  if (typeof location === "undefined") return;
  const r = parseWalletRedirect(location.search);
  if (!r) return;
  history.replaceState(null, "", location.pathname + r.cleanSearch + location.hash);
  if (r.error) notify(`Wallet: ${r.error}`, "bad");
  else notify(`Transaction sent: ${r.hashes.at(-1)!.slice(0, 10)}…`, "ok");
}

export const txLink = (hash: string) => explorerTx(hash, NETWORK);

/** Sign and send one or more transactions with the connected wallet. */
export async function signAndSend(txs: Tx | Tx[]): Promise<string[]> {
  await initWallet();
  if (!connector || !account()) throw new Error("Connect a NEAR wallet first");
  const list = Array.isArray(txs) ? txs : [txs];
  // wallet-selector style actions; NEAR Connect accepts these directly.
  const toActions = (t: Tx) => t.actions.map((a) => ({ type: "FunctionCall", params: { methodName: a.method, args: a.args, gas: a.gas, deposit: a.deposit } }));
  const w = await connector.wallet();
  setBusy(true);
  try {
    if (list.length === 1) {
      const out: any = await w.signAndSendTransaction({ signerId: account()!, receiverId: list[0].receiverId, actions: toActions(list[0]) as any });
      throwIfFailed(out);
      return out?.transaction?.hash ? [out.transaction.hash] : [];
    }
    const outs: any = await w.signAndSendTransactions({ signerId: account()!, transactions: list.map((t) => ({ receiverId: t.receiverId, actions: toActions(t) as any })) });
    (outs ?? []).forEach(throwIfFailed);
    return (outs ?? []).map((o: any) => o?.transaction?.hash).filter(Boolean);
  } finally {
    setBusy(false);
  }
}

function throwIfFailed(out: any) {
  const f = out?.status?.Failure ?? out?.receipts_outcome?.map((r: any) => r?.outcome?.status?.Failure).find(Boolean);
  if (!f) return;
  const msg = f?.ActionError?.kind?.FunctionCallError?.ExecutionError ?? JSON.stringify(f).slice(0, 200);
  throw new Error(msg);
}

// ------------------------------------------------------------------ chain helpers for deposits

export async function wnearState(signer: string, coordinator: string) {
  const q = CONFIG.quote;
  const [mine, coord, bal, bounds] = await Promise.all([
    view<unknown>(q, "storage_balance_of", { account_id: signer }).catch(() => null),
    view<unknown>(q, "storage_balance_of", { account_id: coordinator }).catch(() => null),
    view<string>(q, "ft_balance_of", { account_id: signer }).catch(() => "0"),
    view<{ min: string }>(q, "storage_balance_bounds", {}).catch(() => ({ min: "1250000000000000000000" })),
  ]);
  return { signerRegistered: mine != null, coordinatorRegistered: coord != null, wnearBalance: bal ?? "0", storageMin: bounds.min };
}

/** Build the wNEAR deposit tx (storage + wrap handled) for `Deposit` or `BuyReserved`. */
export async function buildDeposit(signer: string, amount: bigint, msg: string): Promise<Tx> {
  const state = await wnearState(signer, CONFIG.coordinator);
  return depositTx({ quote: CONFIG.quote, coordinator: CONFIG.coordinator, signer, amount, msg, state }) as Tx;
}
