// Browser glue for TESTNET-ONLY test wallets: reactive list over localStorage, direct signing, and
// the NEAR Connect injected wallet ("Test wallet (testnet only)") so every page's signing works.
import { createSignal } from "solid-js";
import { CONFIG, NETWORK, TEST_WALLETS } from "./config";
import * as tw from "./testwallet.mjs";

export interface TestWallet { accountId: string; secretKey: string; label: string; createdAt: number; imported?: boolean }
const store = () => localStorage;
const [list, setList] = createSignal<TestWallet[]>(typeof localStorage === "undefined" ? [] : tw.loadWallets(localStorage));
const [activeId, setActiveIdSig] = createSignal<string | null>(typeof localStorage === "undefined" ? null : tw.getActive(localStorage)?.accountId ?? null);
export { list as testWallets, activeId as activeTestWallet };
const SESSION_KEY = "kyp-testnet-wallet-session";

function refresh() { setList(tw.loadWallets(store())); setActiveIdSig(tw.getActive(store())?.accountId ?? null); }
function guard() { if (!TEST_WALLETS) throw new Error("Test wallets are testnet-only and disabled on this build"); tw.assertTestnet(NETWORK, CONFIG.rpc); }

export async function generateTestWallet(label = ""): Promise<TestWallet> {
  guard();
  const w = await tw.generateTestWallet({ network: NETWORK, label });
  tw.addWallet(store(), w); refresh();
  return w as TestWallet;
}
export function importTestWallet(text: string, accountId = "", label = "imported") { guard(); const w = tw.parseImport(text, accountId); tw.addWallet(store(), { ...w, label }); refresh(); return w.accountId as string; }
export function deleteTestWallet(id: string) { tw.removeWallet(store(), id); if (localStorage.getItem(SESSION_KEY) === id) localStorage.removeItem(SESSION_KEY); refresh(); }
export function exportTestWallet(id: string): string { return tw.exportWallet(store(), id); }
export function setActiveTestWallet(id: string) { tw.setActive(store(), id); refresh(); }
export const findTestWallet = (id: string) => list().find((w) => w.accountId === id) ?? null;

/** Sign + send a site tx with a specific test wallet over RPC. */
export async function sendWithTestWallet(w: TestWallet, tx: { receiverId: string; actions: any[] }): Promise<{ hash: string | null }> {
  guard();
  // near-js providers use Node's Buffer global; polyfill it in the browser.
  if (!(globalThis as any).Buffer) (globalThis as any).Buffer = (await import("buffer")).Buffer;
  return tw.signAndSendWithTestWallet({ network: NETWORK, rpc: CONFIG.rpc, wallet: w, tx });
}

export async function testnetBalances(id: string) {
  const { view } = await import("./near");
  const [near, wnear] = await Promise.all([tw.nearBalance(CONFIG.rpc, id).catch(() => null), view<string>(CONFIG.quote, "ft_balance_of", { account_id: id }).catch(() => "0")]);
  return { near, wnear };
}

/** wallet-selector style actions (what NEAR Connect hands an injected wallet) -> site tx actions. */
function fromSelectorActions(actions: any[]) {
  return actions.map((a) => {
    const p = a.params ?? a.functionCall ?? a;
    if ((a.type && a.type !== "FunctionCall") || !p.methodName) throw new Error("Test wallet only signs function calls");
    return { method: p.methodName, args: p.args ?? {}, gas: String(p.gas ?? "30000000000000"), deposit: String(p.deposit ?? "0") };
  });
}

/** Register the test wallet with NEAR Connect (standard injected-wallet event). Testnet builds only. */
export function injectTestWallet() {
  if (!TEST_WALLETS || NETWORK !== "testnet" || typeof window === "undefined") return;
  const pub = async (w: TestWallet) => { const { KeyPair } = await import("@near-js/crypto"); return KeyPair.fromString(w.secretKey as any).getPublicKey().toString(); };
  const session = () => { const id = localStorage.getItem(SESSION_KEY); return id ? findTestWallet(id) : null; };
  const sendOne = async (signerId: string | undefined, receiverId: string, actions: any[]) => {
    const w = (signerId && findTestWallet(signerId)) || session();
    if (!w) throw new Error("No test wallet signed in");
    const { outcome } = await sendWithTestWallet(w, { receiverId, actions: fromSelectorActions(actions) }) as any;
    return outcome;
  };
  const wallet = {
    manifest: {
      id: tw.WALLET_ID, name: tw.WALLET_NAME, icon: "/favicon.svg", description: "Throwaway testnet accounts created in this browser via the free NEAR testnet faucet. Keys live in localStorage.",
      website: "/test-wallets", version: "1", executor: "", type: "injected", platform: [], permissions: {},
      features: { signMessage: false, signTransaction: false, signAndSendTransaction: true, signAndSendTransactions: true, signInWithoutAddKey: true, signInAndSignMessage: false, signInWithFunctionCallKey: false, signDelegateActions: false, mainnet: false, testnet: true },
    },
    signIn: async () => {
      let w = tw.getActive(store()) as TestWallet | null;
      if (!w) w = await generateTestWallet("wallet");
      localStorage.setItem(SESSION_KEY, w.accountId);
      return [{ accountId: w.accountId, publicKey: await pub(w) }];
    },
    signOut: async () => localStorage.removeItem(SESSION_KEY),
    getAccounts: async () => { const w = session(); return w ? [{ accountId: w.accountId, publicKey: await pub(w) }] : []; },
    signAndSendTransaction: async (p: any) => sendOne(p.signerId, p.receiverId, p.actions),
    signAndSendTransactions: async (p: any) => { const out = []; for (const t of p.transactions) out.push(await sendOne(p.signerId ?? t.signerId, t.receiverId, t.actions)); return out; },
  };
  window.addEventListener("near-selector-ready", () => window.dispatchEvent(new CustomEvent("near-wallet-injected", { detail: wallet })));
}
export const TEST_WALLET_ID = tw.WALLET_ID;
