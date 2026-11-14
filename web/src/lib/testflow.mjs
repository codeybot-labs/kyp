// TESTNET-ONLY "Test mode" quick start: a launcher + 2 caballero test wallets walk a sample launch
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
export const LAUNCHER_NEAR = 4n * 10n ** 24n; // create 2.6 + launch ~0.6 + gas for resume_launch steps
export const MAX_PRESALERS = 9; // + the launcher = 10 test wallets (the per-browser cap)
/** Sample deposit (wNEAR) for caballero i: varied sizes inside wallet_min..wallet_max. */
export const sampleAmount = (i) => [1, 1.5, 0.75, 1.25, 0.5, 2, 1, 1.5, 0.75][i % 9];
export const clampPresalers = (n) => { const v = Math.floor(Number(n)); return Number.isFinite(v) ? Math.max(1, Math.min(MAX_PRESALERS, v)) : 2; };

export async function sampleLaunchParams({ launcher, presalers, now, quote = "wrap.testnet", tag = "" }) {
  const sym = ("TST" + String(tag).replace(/[^a-z0-9]/gi, "").toUpperCase()).slice(0, 8);
  return {
    name: `KYP Test ${tag}`.trim(), symbol: sym, icon: null, description: "Sample launch created by KYP Test mode (testnet only, no real funds).", terms_uri: null,
    quote_token_id: quote, total_supply: null, decimals: null, opening_fdv_quote: Y(100), presale_cap_bps: 2000, // open cap 20 wNEAR: room for 9 sample deposits
    min_raise: Y(1), wallet_min: Y(0.5), wallet_max: Y(2),
    allowlist: await Promise.all(presalers.map((p) => slotHash(p.account, p.salt))), reserved: [],
    sale_start: now, sale_end: now + 86400,
    milestones: [{ target_fdv_quote: Y(200), unlock_bps: 2500 }, { target_fdv_quote: Y(10000), unlock_bps: 7500 }],
    twap: { window_sec: 60, min_observations: 3, min_liquidity: "1", claim_delay_sec: 30, min_obs_interval_sec: 10 },
    reveal: { waves: Math.min(3, presalers.length), interval_sec: 60 },
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
 * send(wallet, tx) -> {hash}, generate(label) -> wallet, sleep(ms), now() (sec), presalers (1-9) }.
 * state = { launcher, ps: [wallet], salts: [salt], launchId } is filled in as steps run; each step
 * logs { step, hash?, account? } through `log`. Steps skip work already done, so the UI can resume.
 * Older saved state { a, b, salts: {a, b} } is upgraded.
 */
export function quickStart(ctx, state = {}, log = () => {}) {
  assertTestnet(ctx.network, ctx.rpc);
  if (state.a || state.b) { state.ps = [state.a, state.b].filter(Boolean); delete state.a; delete state.b; }
  if (state.salts && !Array.isArray(state.salts)) state.salts = [state.salts.a, state.salts.b];
  state.ps ??= [];
  const n = state.launchId ? state.ps.length : clampPresalers(ctx.presalers ?? (state.ps.length || 2));
  const sleep = ctx.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const send = async (step, wallet, tx) => { const r = await ctx.send(wallet, tx); log({ step, hash: r?.hash ?? null, account: wallet.accountId }); return r; };
  const name = (i) => `caballero ${i + 1}`;
  const amt = (i) => BigInt(Math.round(sampleAmount(i) * 1000)) * NEAR / 1000n;
  const needPs = () => { if (!state.launcher || state.ps.length < n) throw new Error("Generate the test-mode wallets first"); };
  const steps = {
    async wallets() {
      if (state.ps.length > n && !state.launchId) state.ps = state.ps.slice(0, n);
      // Reuse stored test wallets that hold enough NEAR first (saves faucet calls and wallet slots).
      if (ctx.reuse && (!state.launcher || state.ps.length < n)) {
        const used = () => [state.launcher?.accountId, ...state.ps.map((w) => w.accountId)].filter(Boolean);
        const pool = await ctx.reuse(used()); // [{ w, near: bigint }], richest first
        if (!state.launcher) { const k = pool.findIndex((x) => x.near >= LAUNCHER_NEAR); if (k >= 0) { state.launcher = pool.splice(k, 1)[0].w; log({ step: "reuse launcher", account: state.launcher.accountId }); } }
        while (state.ps.length < n) {
          const i = state.ps.length, k = pool.findIndex((x) => x.near >= amt(i) + NEAR / 4n);
          if (k < 0) break;
          state.ps.push(pool.splice(k, 1)[0].w); log({ step: `reuse ${name(i)}`, account: state.ps[i].accountId });
        }
      }
      const todo = (state.launcher ? 0 : 1) + Math.max(0, n - state.ps.length);
      if (ctx.room != null && todo > ctx.room()) throw new Error(`Test mode needs ${todo} new wallets but only ${ctx.room()} of the 10 test-wallet slots are free. Delete some wallets or pick fewer caballeros.`);
      if (!state.launcher) { state.launcher = await ctx.generate("launcher"); log({ step: "generate launcher", account: state.launcher.accountId }); await sleep(1500); }
      while (state.ps.length < n) {
        const w = await ctx.generate(`presaler-${state.ps.length + 1}`);
        state.ps.push(w); log({ step: `generate ${name(state.ps.length - 1)}`, account: w.accountId });
        await sleep(1500);
      }
    },
    async fund() {
      needPs();
      for (let i = 0; i < n; i++) {
        if (state.launchId && state.salts?.[i]) { // already deposited? then nothing to wrap
          const slot = await ctx.view(ctx.coordinator, "get_slot", { launch_id: state.launchId, hash: await slotHash(state.ps[i].accountId, state.salts[i]) }).catch(() => null);
          if (slot?.filled) continue;
        }
        const w = state.ps[i], s = await wnear(ctx.view, ctx.quote, ctx.coordinator, w.accountId), need = amt(i);
        if (BigInt(s.wnearBalance) < need) await send(`wrap ${sampleAmount(i)} NEAR (${name(i)})`, w, wrapTx({ quote: ctx.quote, signer: w.accountId, amount: (need - BigInt(s.wnearBalance)).toString(), registered: s.signerRegistered, storageMin: s.storageMin }));
      }
    },
    async create() {
      needPs();
      if (state.launchId) return;
      state.salts = state.ps.map((_, i) => state.salts?.[i] ?? randomSalt());
      const params = await sampleLaunchParams({ launcher: state.launcher.accountId, presalers: state.ps.map((w, i) => ({ account: w.accountId, salt: state.salts[i] })), now: ctx.now(), quote: ctx.quote, tag: state.launcher.accountId.slice(-12, -8) });
      const cfg = await ctx.view(ctx.coordinator, "get_config", {});
      const before = Number(await ctx.view(ctx.coordinator, "get_launch_count", {}).catch(() => 0));
      const newer = async () => { const id = await findLaunchBy(ctx.view, ctx.coordinator, state.launcher.accountId); return id && id > before ? id : null; };
      try {
        await send(`create launch (launcher, ${n} caballeros, ${params.reveal.waves} reveal waves)`, state.launcher, createLaunchTx(ctx.coordinator, params, cfg.token_account_deposit));
      } catch (e) {
        // e.g. "Transaction has expired" although create_launch landed: adopt the launch if it exists
        for (let i = 0; i < 6 && !state.launchId; i++) { state.launchId = await newer(); if (!state.launchId) await sleep(2000); }
        if (!state.launchId) throw e;
        log({ step: `create launch: wallet reported "${String(e?.message ?? e).slice(0, 60)}" but launch #${state.launchId} landed` });
      }
      for (let i = 0; i < 10 && !state.launchId; i++) { state.launchId = await newer(); if (!state.launchId) await sleep(1500); }
      if (!state.launchId) throw new Error("launch created but not found yet; retry this step");
      log({ step: `launch #${state.launchId} created` });
    },
    async deposit() {
      needPs();
      for (let i = 0; i < n; i++) {
        const w = state.ps[i];
        const slot = await ctx.view(ctx.coordinator, "get_slot", { launch_id: state.launchId, hash: await slotHash(w.accountId, state.salts[i]) }).catch(() => null);
        if (slot?.filled) continue;
        const s = await wnear(ctx.view, ctx.quote, ctx.coordinator, w.accountId);
        await send(`deposit ${sampleAmount(i)} wNEAR (${name(i)})`, w, depositTx({ quote: ctx.quote, coordinator: ctx.coordinator, signer: w.accountId, amount: amt(i), msg: depositMsg("Deposit", state.launchId, state.salts[i]), state: s }));
      }
    },
    async launch() {
      needPs();
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
    async record(k = 3) {
      needPs();
      for (let i = 1; i <= k; i++) {
        await send(`record TWAP observation ${i}/${k}`, state.ps[0], recordTx(ctx.lock, state.launchId));
        if (i < k) await sleep(11_000); // lock min_obs_interval_sec = 10
      }
    },
    reveal: () => send("reveal next wave", state.launcher, revealTx(ctx.coordinator, state.launchId)),
    claim: (i = 0) => send(`claim (${name(i)})`, state.ps[i], claimTx(ctx.lock, state.launchId)),
  };
  return { state, steps, async runAll() { for (const s of ["wallets", "fund", "create", "deposit", "launch", "record"]) await steps[s](); return state; } };
}
