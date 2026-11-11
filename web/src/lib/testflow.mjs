// TESTNET-ONLY "Test mode" quick start: a launcher + 2 presaler test wallets walk a sample launch
// end to end (wrap -> create -> deposit -> launch/resume -> record), each step signed directly by
// the right test wallet. Pure orchestration over injected `view` / `send` so node tests can drive
// it against a mock or the real testnet (scripts/testwallet-live.mjs).
import { slotHash, randomSalt } from "./math.mjs";
import { createLaunchTx, depositMsg, depositTx, launchNearNeeded, launchTx, resumeLaunchTx, recordTx, revealTx, claimTx } from "./actions.mjs";
import { assertTestnet } from "./testwallet.mjs";

const NEAR = 10n ** 24n;
const Y = (n) => (BigInt(Math.round(n * 1000)) * NEAR / 1000n).toString();

/** wNEAR wrap: register the signer (if needed) and near_deposit `amount` yocto. */
export function wrapTx({ quote, signer, amount, registered, storageMin = "1250000000000000000000" }) {
  const actions = [];
  if (!registered) actions.push({ method: "storage_deposit", args: { account_id: signer, registration_only: true }, gas: (30n * 10n ** 12n).toString(), deposit: storageMin });
  actions.push({ method: "near_deposit", args: {}, gas: (10n * 10n ** 12n).toString(), deposit: String(amount) });
  return { receiverId: quote, actions };
}

/** Sample launch params: 2 open allowlist slots, short TWAP/reveal timings so testing is quick. */
export async function sampleLaunchParams({ launcher, presalers, now, quote = "wrap.testnet", tag = "" }) {
  const sym = ("TST" + String(tag).replace(/[^a-z0-9]/gi, "").toUpperCase()).slice(0, 8);
  return {
    name: `KYP Test ${tag}`.trim(), symbol: sym, icon: null, description: "Sample launch created by KYP Test mode (testnet only, no real funds).", terms_uri: null,
    quote_token_id: quote, total_supply: null, decimals: null, opening_fdv_quote: Y(20), presale_cap_bps: 2000,
    min_raise: Y(1), wallet_min: Y(0.5), wallet_max: Y(2),
    allowlist: await Promise.all(presalers.map((p) => slotHash(p.account, p.salt))), reserved: [],
    sale_start: now, sale_end: now + 86400,
    milestones: [{ target_fdv_quote: Y(40), unlock_bps: 2500 }, { target_fdv_quote: Y(2000), unlock_bps: 7500 }],
    twap: { window_sec: 60, min_observations: 3, min_liquidity: "1", claim_delay_sec: 30, min_obs_interval_sec: 10 },
    reveal: { waves: 2, interval_sec: 60 },
    fee_split: { holders_bps: 5000, liquidity_bps: 3000, community_bps: 2000, holders_account: launcher, liquidity_account: launcher, community_account: launcher },
  };
}

async function wnear(view, quote, coordinator, signer) {
  const [mine, coord, bal, bounds] = await Promise.all([
    view(quote, "storage_balance_of", { account_id: signer }).catch(() => null),
    view(quote, "storage_balance_of", { account_id: coordinator }).catch(() => null),
    view(quote, "ft_balance_of", { account_id: signer }).catch(() => "0"),
    view(quote, "storage_balance_bounds", {}).catch(() => ({ min: "1250000000000000000000" })),
  ]);
  return { signerRegistered: mine != null, coordinatorRegistered: coord != null, wnearBalance: bal ?? "0", storageMin: bounds?.min ?? "1250000000000000000000" };
}

/** Find the newest launch by `launcher` (create_launch returns via a callback, so we look it up). */
export async function findLaunchBy(view, coordinator, launcher, scan = 20) {
  const count = Number(await view(coordinator, "get_launch_count", {}));
  for (let id = count; id > Math.max(0, count - scan); id--) {
    const l = await view(coordinator, "get_launch", { launch_id: id }).catch(() => null);
    if (l?.launcher === launcher) return id;
  }
  return null;
}

/**
 * The quick-start steps. ctx = { network, rpc, coordinator, lock, quote, view(contract, method, args),
 * send(wallet, tx) -> {hash}, generate(label) -> wallet, sleep(ms), now() (sec) }.
 * state = { launcher, a, b, salts: {a, b}, launchId } is filled in as steps run; each step logs
 * { step, hash? } through `log`. Steps are idempotent-ish so the UI can resume after a failure.
 */
export function quickStart(ctx, state = {}, log = () => {}) {
  assertTestnet(ctx.network, ctx.rpc);
  const sleep = ctx.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const send = async (step, wallet, tx) => { const r = await ctx.send(wallet, tx); log({ step, hash: r?.hash ?? null, account: wallet.accountId }); return r; };
  const steps = {
    async wallets() {
      for (const [k, label] of [["launcher", "launcher"], ["a", "presaler-a"], ["b", "presaler-b"]]) {
        if (!state[k]) { state[k] = await ctx.generate(label); log({ step: `generate ${label}`, account: state[k].accountId }); await sleep(1500); }
      }
    },
    async fund() {
      for (const k of ["a", "b"]) {
        const w = state[k], s = await wnear(ctx.view, ctx.quote, ctx.coordinator, w.accountId);
        if (BigInt(s.wnearBalance) < 2n * NEAR) await send(`wrap 2 NEAR (${k === "a" ? "presaler A" : "presaler B"})`, w, wrapTx({ quote: ctx.quote, signer: w.accountId, amount: (2n * NEAR - BigInt(s.wnearBalance)).toString(), registered: s.signerRegistered, storageMin: s.storageMin }));
      }
    },
    async create() {
      if (state.launchId) return;
      state.salts ??= { a: randomSalt(), b: randomSalt() };
      const params = await sampleLaunchParams({ launcher: state.launcher.accountId, presalers: [{ account: state.a.accountId, salt: state.salts.a }, { account: state.b.accountId, salt: state.salts.b }], now: ctx.now(), quote: ctx.quote, tag: state.launcher.accountId.slice(-12, -8) });
      const cfg = await ctx.view(ctx.coordinator, "get_config", {});
      await send("create launch (launcher)", state.launcher, createLaunchTx(ctx.coordinator, params, cfg.token_account_deposit));
      for (let i = 0; i < 10 && !state.launchId; i++) { state.launchId = await findLaunchBy(ctx.view, ctx.coordinator, state.launcher.accountId); if (!state.launchId) await sleep(1500); }
      if (!state.launchId) throw new Error("launch created but not found yet; retry this step");
      log({ step: `launch #${state.launchId} created` });
    },
    async deposit() {
      for (const [k, amt, who] of [["a", NEAR, "presaler A"], ["b", 3n * NEAR / 2n, "presaler B"]]) {
        const w = state[k];
        const slot = await ctx.view(ctx.coordinator, "get_slot", { launch_id: state.launchId, hash: await slotHash(w.accountId, state.salts[k]) }).catch(() => null);
        if (slot?.filled) continue;
        const s = await wnear(ctx.view, ctx.quote, ctx.coordinator, w.accountId);
        await send(`deposit ${Number(amt) / 1e24} wNEAR (${who})`, w, depositTx({ quote: ctx.quote, coordinator: ctx.coordinator, signer: w.accountId, amount: amt, msg: depositMsg("Deposit", state.launchId, state.salts[k]), state: s }));
      }
    },
    async launch() {
      let l = await ctx.view(ctx.coordinator, "get_launch", { launch_id: state.launchId });
      if (l.status === "Open") {
        const cfg = await ctx.view(ctx.coordinator, "get_config", {});
        await send("launch (launcher)", state.launcher, launchTx(ctx.coordinator, state.launchId, launchNearNeeded(cfg)));
        l = await ctx.view(ctx.coordinator, "get_launch", { launch_id: state.launchId });
      }
      for (let i = 1; i <= 6 && l.status === "Launching"; i++) {
        await send(`resume_launch #${i} (1000 Tgas)`, state.launcher, resumeLaunchTx(ctx.coordinator, state.launchId));
        l = await ctx.view(ctx.coordinator, "get_launch", { launch_id: state.launchId });
      }
      if (l.status !== "Live") throw new Error(`launch is ${l.status}, expected Live`);
      log({ step: `launch #${state.launchId} is Live` });
    },
    async record(n = 3) {
      for (let i = 1; i <= n; i++) {
        await send(`record TWAP observation ${i}/${n}`, state.a, recordTx(ctx.lock, state.launchId));
        if (i < n) await sleep(11_000); // lock min_obs_interval_sec = 10
      }
    },
    reveal: () => send("reveal next wave", state.launcher, revealTx(ctx.coordinator, state.launchId)),
    claim: (k = "a") => send(`claim (${k === "a" ? "presaler A" : "presaler B"})`, state[k], claimTx(ctx.lock, state.launchId)),
  };
  return { state, steps, async runAll() { for (const s of ["wallets", "fund", "create", "deposit", "launch", "record"]) await steps[s](); return state; } };
}
