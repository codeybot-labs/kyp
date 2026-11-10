// Bridge: NEAR wallets that only ship as @near-wallet-selector modules (Sender, Bitget, Coin98, ...)
// are announced to NEAR Connect as "injected" wallets, so every wallet shows in ONE modal.
// Wallets already in the NEAR Connect manifest (Meteor, Intear, MyNearWallet, Nightly, Ledger,
// Ethereum wallets, NEAR CLI) are NOT bridged; they come from NEAR Connect itself.
// Excluded on purpose: HOT + OKX (mainnet only), WalletConnect + Unity (need a Reown projectId).
import { NETWORK } from "./config";

type ConnectorAction = { type: string; params?: any };

/** Wrap a wallet-selector module factory so a crash while detecting the wallet yields a "not installed" entry. */
function orPlaceholder(factory: any, meta: { id: string; name: string; description: string; iconUrl: string; downloadUrl: string }) {
  return async (opts: any) => {
    try { return await factory(opts); } catch {
      return {
        id: meta.id, type: "injected",
        metadata: { name: meta.name, description: meta.description, iconUrl: meta.iconUrl, downloadUrl: meta.downloadUrl, deprecated: false, available: false },
        init: async () => { throw new Error(`${meta.name} is not installed`); },
      };
    }
  };
}

const BRIDGED = [
  ["sender", () => import("@near-wallet-selector/sender").then((m) => m.setupSender())],
  ["here-wallet", () => import("@near-wallet-selector/here-wallet").then((m) => m.setupHereWallet())],
  // Bitget's module throws when the extension is absent (reads window.bitkeep.near), so it gets a
  // placeholder entry that points to the install page instead of disappearing.
  ["bitget-wallet", () => import("@near-wallet-selector/bitget-wallet").then((m) => orPlaceholder(m.setupBitgetWallet(), {
    id: "bitget-wallet", name: "Bitget Wallet", description: "Browser extension wallet.",
    iconUrl: "https://web3.bitget.com/favicon.ico",
    downloadUrl: "https://chrome.google.com/webstore/detail/bitkeep-crypto-nft-wallet/jiidiaalihmmhddjgbnbgdfflelocpak",
  }))],
  ["coin98-wallet", () => import("@near-wallet-selector/coin98-wallet").then((m) => m.setupCoin98Wallet())],
  ["math-wallet", () => import("@near-wallet-selector/math-wallet").then((m) => m.setupMathWallet())],
  ["near-mobile-wallet", () => import("@near-wallet-selector/near-mobile-wallet").then((m) => m.setupNearMobileWallet())],
  ["bitte-wallet", () => import("@near-wallet-selector/bitte-wallet").then((m) => (m as any).setupBitteWallet())],
  ["welldone-wallet", () => import("@near-wallet-selector/welldone-wallet").then((m) => m.setupWelldoneWallet())],
  ["narwallets", () => import("@near-wallet-selector/narwallets").then((m) => m.setupNarwallets())],
  ["ramper-wallet", () => import("@near-wallet-selector/ramper-wallet").then((m) => m.setupRamperWallet())],
  ["xdefi", () => import("@near-wallet-selector/xdefi").then((m) => m.setupXDEFI())],
  ["arepa-wallet", () => import("@near-wallet-selector/arepa-wallet").then((m) => m.setupArepaWallet())],
] as const;

export const BRIDGED_IDS = BRIDGED.map(([id]) => `ws-${id}`);

/** Load the legacy modules (best effort, one failure doesn't block the rest) and announce them. */
export async function announceBridgedWallets(contractId: string) {
  const modules = (await Promise.all(BRIDGED.map(([id, load]) => load().catch((e) => (console.warn(`wallet module ${id} failed to load`, e), null))))).filter(Boolean);
  const { setupWalletSelector } = await import("@near-wallet-selector/core");
  const { actionCreators } = await import("@near-js/transactions");
  const selector = await setupWalletSelector({ network: NETWORK, modules: modules as any });
  const toNaj = (actions: ConnectorAction[]) =>
    actions.map((a) => {
      if (a.type !== "FunctionCall") throw new Error(`${a.type} actions are not supported here`);
      const p = a.params;
      return actionCreators.functionCall(p.methodName, p.args, BigInt(p.gas), BigInt(p.deposit));
    });

  for (const m of selector.store.getState().modules) {
    const md: any = m.metadata;
    const installed = md.available !== false;
    const manifest = {
      id: `ws-${m.id}`,
      name: md.name,
      icon: md.iconUrl,
      description: installed ? md.description ?? "" : `${md.description ?? ""} Not detected in this browser; install it first.`.trim(),
      website: md.downloadUrl ?? "",
      version: "1.0.0",
      executor: "",
      type: "injected" as const,
      platform: [] as string[],
      permissions: {},
      features: {
        signMessage: false, signTransaction: false, signAndSendTransaction: true, signAndSendTransactions: true,
        signInWithoutAddKey: true, signInAndSignMessage: false, signInWithFunctionCallKey: false,
        signDelegateActions: false, mainnet: false, testnet: true,
      },
    };
    const w = () => selector.wallet(m.id);
    const ownsSession = () => selector.store.getState().selectedWalletId === m.id;
    const wallet = {
      manifest,
      async signIn() {
        if (!installed && md.downloadUrl) { window.open(md.downloadUrl, "_blank"); throw new Error(`${md.name} is not installed`); }
        const accs = await (await w()).signIn({ contractId, methodNames: [], accounts: [] } as any);
        return (accs ?? []).map((a: any) => ({ accountId: a.accountId, publicKey: a.publicKey }));
      },
      async signInAndSignMessage() { throw new Error(`${md.name}: sign-in with message is not supported`); },
      async signOut() { if (ownsSession()) await (await w()).signOut(); },
      async getAccounts() {
        if (!ownsSession()) return [];
        return ((await (await w()).getAccounts()) ?? []).map((a: any) => ({ accountId: a.accountId, publicKey: a.publicKey }));
      },
      async signAndSendTransaction(p: { signerId?: string; receiverId: string; actions: ConnectorAction[] }) {
        return (await w()).signAndSendTransaction({ signerId: p.signerId, receiverId: p.receiverId, actions: toNaj(p.actions) } as any);
      },
      async signAndSendTransactions(p: { signerId?: string; transactions: { receiverId: string; actions: ConnectorAction[] }[] }) {
        return (await w()).signAndSendTransactions({ transactions: p.transactions.map((t) => ({ signerId: p.signerId, receiverId: t.receiverId, actions: toNaj(t.actions) })) } as any);
      },
      async signMessage() { throw new Error(`${md.name}: signMessage not supported via bridge`); },
      async signDelegateActions() { throw new Error(`${md.name}: delegate actions not supported`); },
    };
    window.dispatchEvent(new CustomEvent("near-wallet-injected", { detail: wallet }));
  }
  return selector.store.getState().modules.map((m) => m.id);
}
