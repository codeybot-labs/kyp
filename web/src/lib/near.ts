// Read-only NEAR RPC (view calls) for the configured network. No keys, no signing.
import { CONFIG, NETWORK } from "./config";

export async function view<T>(contract: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(CONFIG.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "kyp", method: "query",
      params: { request_type: "call_function", finality: "optimistic", account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) },
    }),
  });
  const j = await res.json();
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
