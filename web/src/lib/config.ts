// Site config. PUBLIC_NEAR_NETWORK picks testnet (default) or mainnet; RPC, wNEAR, explorer,
// MyNearWallet URL and contract IDs all follow it. See network.mjs for the variable names.
import { parseNetwork, resolveConfig, pickInstance } from "./network.mjs";

const NETWORK_KEY = "kyp-network";
const storedNetwork = (() => {
  try { return typeof localStorage !== "undefined" ? localStorage.getItem(NETWORK_KEY) : null; } catch { return null; }
})();
const SITE_NETWORK = parseNetwork(storedNetwork ?? import.meta.env.PUBLIC_NEAR_NETWORK);

const BASE = resolveConfig({ ...(import.meta.env as Record<string, string>), PUBLIC_NEAR_NETWORK: SITE_NETWORK });
const INSTANCE_KEY = "kyp-instance";
const R = pickInstance(BASE, typeof localStorage === "undefined" ? "primary" : localStorage.getItem(INSTANCE_KEY));
export const CONFIG = {
  coordinator: R.coordinator as string,
  lock: R.lock as string,
  pool: R.pool as string,
  quote: R.quote as string,
  rpc: R.rpc as string,
  nearUsd: R.nearUsd as number,
  walletConnectProjectId: R.walletConnectProjectId as string,
  exampleAccount: R.exampleAccount as string,
};
export const NETWORK = R.network as "testnet" | "mainnet";
export const NETWORK_LABEL = R.label as string;
/** "Testnet" / "Mainnet", for badges. */
export const NETWORK_NAME = NETWORK === "mainnet" ? "Mainnet" : "Testnet";
/** Contract accounts are set for the selected network, so the site can read live state. */
export const TESTNET_CONFIGURED = Boolean(R.configured);
export const LIVE_CONFIGURED = TESTNET_CONFIGURED;
/** Which deployment the site reads (primary = RHEA DCL copy on testnet, alt = mock-pool copy). */
export const INSTANCE = R.instance as "primary" | "alt";
export const INSTANCES = BASE.alt.configured
  ? [{ id: "primary", label: BASE.instanceLabel || "Primary", coordinator: BASE.coordinator }, { id: "alt", label: BASE.alt.label, coordinator: BASE.alt.coordinator }]
  : [];
export function setInstance(id: "primary" | "alt") { localStorage.setItem(INSTANCE_KEY, id); location.reload(); }
export function setNetwork(n: "testnet" | "mainnet") { try { localStorage.setItem(NETWORK_KEY, n); } catch {} location.reload(); }
/** KYP's own presale is only available when contracts are configured for this network. */
export const KYP_ENABLED = Boolean(CONFIG.coordinator);
/** In-browser faucet test wallets: testnet builds only (never on mainnet). */
export const TEST_WALLETS = Boolean(BASE.testWallets) && NETWORK === "testnet";
