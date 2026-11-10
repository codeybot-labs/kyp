// Network config (testnet | mainnet) and the wallet-list rules that depend on it. Pure, so it can be
// tested with node --test. config.ts feeds it import.meta.env; wallet.ts uses prepareManifest().
//
// Default is testnet. Mainnet only changes what the site *reads and signs against*; there are no
// mainnet contract IDs in this repo, so a mainnet build without PUBLIC_KYP_MAINNET_* vars runs in
// demo mode.

export const NETWORKS = {
  testnet: {
    id: "testnet", label: "NEAR testnet", rpc: "https://rpc.testnet.near.org", quote: "wrap.testnet",
    explorer: "https://testnet.nearblocks.io", myNearWallet: "https://testnet.mynearwallet.com", exampleAccount: "you.testnet",
  },
  mainnet: {
    id: "mainnet", label: "NEAR mainnet", rpc: "https://rpc.mainnet.near.org", quote: "wrap.near",
    explorer: "https://nearblocks.io", myNearWallet: "https://app.mynearwallet.com", exampleAccount: "you.near",
  },
};

export function parseNetwork(v) {
  const n = String(v ?? "").trim().toLowerCase();
  if (!n) return "testnet";
  if (n === "testnet" || n === "mainnet") return n;
  throw new Error(`PUBLIC_NEAR_NETWORK must be "testnet" or "mainnet", got "${v}"`);
}

const IMPLICIT = /^[0-9a-f]{64}$|^0x[0-9a-f]{40}$/;
/** True if `account` can live on `network` (named .testnet accounts only on testnet, and vice versa). */
export function accountFitsNetwork(account, network) {
  if (!account || IMPLICIT.test(account)) return true;
  return network === "testnet" ? account.endsWith(".testnet") : !account.endsWith(".testnet");
}

/**
 * Resolve the site config for the chosen network. Per-network vars win:
 *   PUBLIC_KYP_<NET>_COORDINATOR / _LOCK / _POOL / _QUOTE, PUBLIC_NEAR_<NET>_RPC
 * The older unprefixed vars (PUBLIC_KYP_COORDINATOR, PUBLIC_NEAR_RPC, ...) still work, for testnet only.
 * Contract IDs that don't fit the network (e.g. *.testnet on mainnet) are rejected.
 */
export function resolveConfig(env = {}) {
  const network = parseNetwork(env.PUBLIC_NEAR_NETWORK);
  const N = network.toUpperCase();
  const net = NETWORKS[network];
  const pick = (key, legacy) => env[key] || (network === "testnet" ? env[legacy] : "") || "";
  const cfg = {
    network,
    label: net.label,
    explorer: net.explorer,
    myNearWallet: net.myNearWallet,
    exampleAccount: net.exampleAccount,
    coordinator: pick(`PUBLIC_KYP_${N}_COORDINATOR`, "PUBLIC_KYP_COORDINATOR"),
    lock: pick(`PUBLIC_KYP_${N}_LOCK`, "PUBLIC_KYP_LOCK"),
    pool: pick(`PUBLIC_KYP_${N}_POOL`, "PUBLIC_KYP_POOL"),
    quote: pick(`PUBLIC_KYP_${N}_QUOTE`, "PUBLIC_KYP_QUOTE") || net.quote,
    rpc: pick(`PUBLIC_NEAR_${N}_RPC`, "PUBLIC_NEAR_RPC") || net.rpc,
    nearUsd: Number(env.PUBLIC_NEAR_USD || "2.0"),
    walletConnectProjectId: String(env.PUBLIC_WALLETCONNECT_PROJECT_ID || "").trim(),
  };
  for (const k of ["coordinator", "lock", "pool", "quote"]) {
    if (!accountFitsNetwork(cfg[k], network)) throw new Error(`${k} "${cfg[k]}" is not a ${network} account (PUBLIC_NEAR_NETWORK=${network})`);
  }
  cfg.configured = Boolean(cfg.coordinator && cfg.lock);
  return cfg;
}

export const MAINNET_ONLY_SUFFIX = " (mainnet only)";

/**
 * Manifest wallets whose executor handles testnet but whose manifest doesn't flag it (checked by
 * hand in the executor source): enable testnet and let the sandbox open the testnet wallet site.
 */
export const TESTNET_OVERRIDES = { mynearwallet: [NETWORKS.testnet.myNearWallet] };

/**
 * Manifest wallet id -> bridged wallet-selector id for the same wallet. On testnet the manifest
 * copy is dropped when it lacks testnet (the bridged module covers it); on mainnet the bridged copy
 * is skipped so the wallet shows once.
 */
export const MANIFEST_DUPLICATES = { "near-mobile": "near-mobile-wallet" };

/**
 * Prepare the NEAR Connect manifest for `network`. On testnet, wallets that don't support testnet
 * are KEPT (we are going to mainnet), renamed "<name> (mainnet only)" and flagged so the connector
 * shows them; `mainnetOnly` lists their ids so a click explains instead of connecting.
 * On mainnet the manifest is returned as is.
 */
export function prepareManifest(manifest, network) {
  const wallets = (manifest?.wallets ?? []).map((w) => ({ ...w, features: { ...w.features }, permissions: { ...w.permissions } }));
  const mainnetOnly = [];
  if (network !== "testnet") return { manifest: { ...manifest, wallets }, mainnetOnly };
  const out = [];
  for (const w of wallets) {
    if (w.features.testnet) { out.push(w); continue; }
    const extra = TESTNET_OVERRIDES[w.id];
    if (extra) {
      w.features.testnet = true;
      w.permissions.allowsOpen = [...(w.permissions.allowsOpen ?? []), ...extra];
      out.push(w);
      continue;
    }
    if (MANIFEST_DUPLICATES[w.id]) continue;
    w.name = `${w.name}${MAINNET_ONLY_SUFFIX}`;
    w.features.testnet = true; // so NEAR Connect lists it; wallet.ts intercepts the click
    w.mainnetOnly = true;
    mainnetOnly.push(w.id);
    out.push(w);
  }
  return { manifest: { ...manifest, wallets: out }, mainnetOnly };
}

/** Bridged wallet-selector ids to skip on `network` (duplicates of a manifest wallet). */
export function skippedBridgedIds(network) {
  return network === "mainnet" ? Object.values(MANIFEST_DUPLICATES) : [];
}

export const mainnetOnlyMessage = (name) =>
  `${name.replace(MAINNET_ONLY_SUFFIX, "")} only works on NEAR mainnet. KYP is running on testnet right now, so use a testnet wallet such as Meteor, MyNearWallet or Intear. It will work here once KYP moves to mainnet.`;

export const explorerTxUrl = (hash, network = "testnet") => `${NETWORKS[network].explorer}/txns/${hash}`;
