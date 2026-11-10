const env = import.meta.env;
export const CONFIG = {
  coordinator: (env.PUBLIC_KYP_COORDINATOR as string) || "",
  lock: (env.PUBLIC_KYP_LOCK as string) || "",
  pool: (env.PUBLIC_KYP_POOL as string) || "",
  quote: (env.PUBLIC_KYP_QUOTE as string) || "wrap.testnet",
  rpc: (env.PUBLIC_NEAR_RPC as string) || "https://rpc.testnet.near.org",
  nearUsd: Number(env.PUBLIC_NEAR_USD || "2.0"),
};
/** Testnet only. Mainnet is deliberately not configurable in this MVP. */
export const NETWORK = "testnet" as const;
export const TESTNET_CONFIGURED = Boolean(CONFIG.coordinator && CONFIG.lock);
