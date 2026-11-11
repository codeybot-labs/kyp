// Live TESTNET check of the in-site test wallet code path: faucet-generated wallets sign the whole
// sample flow directly over RPC. Keys stay in memory and are never printed.
//   node scripts/testwallet-live.mjs            # RHEA DCL copy (default)
//   KYP_COORD=kyp-sushmit.testnet KYP_LOCK=kyp-sushmit-lock.testnet node scripts/testwallet-live.mjs
import { generateTestWallet, signAndSendWithTestWallet } from "../src/lib/testwallet.mjs";
import { quickStart } from "../src/lib/testflow.mjs";

const rpc = process.env.KYP_RPC || "https://rpc.testnet.fastnear.com";
const ctx = {
  network: "testnet", rpc, quote: "wrap.testnet",
  coordinator: process.env.KYP_COORD || "kyp-sushmit-dcl.testnet",
  lock: process.env.KYP_LOCK || "kyp-sushmit-dcl-lock.testnet",
  now: () => Math.floor(Date.now() / 1000),
  async view(contract, method, args) {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }) });
    const j = await r.json();
    if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error ?? j.result.error).slice(0, 200));
    return JSON.parse(Buffer.from(j.result.result).toString());
  },
  send: (wallet, tx) => signAndSendWithTestWallet({ network: "testnet", rpc, wallet, tx }),
  generate: (label) => generateTestWallet({ network: "testnet", label }),
};
const t0 = Date.now();
const q = quickStart(ctx, {}, (e) => console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s  ${e.step}${e.account ? `  [${e.account}]` : ""}${e.hash ? `  https://testnet.nearblocks.io/txns/${e.hash}` : ""}`));
try {
  await q.runAll();
  const l = await ctx.view(ctx.coordinator, "get_launch", { launch_id: q.state.launchId });
  const obs = await ctx.view(ctx.lock, "get_observations", { launch_id: q.state.launchId, from_index: 0, limit: 10 }).catch((e) => String(e));
  console.log(`OK launch #${q.state.launchId} ${l.status} pool=${l.pool_id} observations=${Array.isArray(obs) ? obs.length : obs}`);
  await new Promise((r) => setTimeout(r, 61_000)); // reveal interval
  await q.steps.reveal().then(() => console.log("reveal ok"), (e) => console.log("reveal:", e.message));
  await q.steps.claim("a").then(() => console.log("claim tx ok (unlocks only at milestones)"), (e) => console.log("claim:", e.message));
} catch (e) {
  console.error("FAILED:", e.message, e.hash ? `https://testnet.nearblocks.io/txns/${e.hash}` : "");
  process.exit(1);
}
