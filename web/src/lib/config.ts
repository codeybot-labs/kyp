// Site config. PUBLIC_NEAR_NETWORK picks testnet (default) or mainnet; RPC, wNEAR, explorer,
// MyNearWallet URL and contract IDs all follow it. See network.mjs for the variable names.
import { resolveConfig } from "./network.mjs";

const R = resolveConfig(import.meta.env as Record<string, string>);
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
