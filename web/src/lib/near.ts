// Read-only NEAR RPC (view calls) for the configured network. No keys, no signing.
import { CONFIG, NETWORK } from "./config";

const FALLBACK_RPC = NETWORK === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org";
/** Primary RPC first; if it rate-limits (429s come back without CORS headers, so fetch throws) or
 * errors at the HTTP level, retry the same read on NEAR's public RPC. */
const RPCS = [...new Set([CONFIG.rpc, FALLBACK_RPC].filter(Boolean))];
let preferred = 0;

async function query(params: Record<string, unknown>): Promise<any> {
  let last: unknown;
  for (let k = 0; k < RPCS.length; k++) {
    const i = (preferred + k) % RPCS.length;
    try {
      const res = await fetch(RPCS[i], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "kyp", method: "query", params }) });
      if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
      const j = await res.json();
      preferred = i;
      return j;
    } catch (e) { last = e; }
  }
  throw last instanceof Error ? last : new Error("RPC unavailable");
}

export async function view<T>(contract: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const j = await query({ request_type: "call_function", finality: "optimistic", account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  if (j.error) throw new Error(j.error?.cause?.name || j.error.message || "RPC error");
  if (j.result?.error) throw new Error(j.result.error);
  const bytes = new Uint8Array(j.result.result);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/** NEAR CLI (near-cli-rs) command for a write the user signs themselves. */
export function cliCall(contract: string, method: string, args: unknown, opts: { deposit?: string; gas?: string; signer?: string } = {}) {
  const a = JSON.stringify(args).replace(/'/g, "'\\''");
  return [
    `near contract call-function as-transaction ${contract} ${method}`,
    `  json-args '${a}'`,
    `  prepaid-gas '${opts.gas ?? "300 Tgas"}' attached-deposit '${opts.deposit ?? "0 NEAR"}'`,
    `  sign-as ${opts.signer ?? `<${CONFIG.exampleAccount}>`} network-config ${NETWORK} sign-with-keychain send`,
  ].join(" \\\n");
}
