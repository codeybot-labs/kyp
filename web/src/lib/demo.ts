// DEMO MODE: a small in-browser simulation of the Know Your Cabal contracts (state in localStorage).
// It mirrors the contract rules closely enough to walk through the full flow without a
// wallet. Nothing here touches a chain.

import type {
  LaunchView, LaunchParams, LockView, Milestone, Observation, PresalerView, SlotKind, SlotView, TwapStatus, Position,
} from "./model";
import { isReserved } from "./model";
import { tokensForQuote, pointForFdv, fdvAtPoint, waveOf, twapPoint, slotHash, toRaw } from "./math.mjs";
import { CONFIG } from "./config";

const KEY = "kyp-demo-v2";
const NEAR = 10n ** 24n;
const SUPPLY = 10n ** 27n;
const POINT_DELTA = 200;

interface DemoSlot {
  hash: string; kind: SlotKind; account: string | null; deposit: string; tokens: string;
  /** demo only: the invite handed to this wallet, so you can try the flow */
  invite?: { account: string; salt: string };
}
interface DemoLock {
  milestones: Milestone[]; observations: Observation[]; positions: Record<string, Position>;
  total_locked: string; total_claimed: string; created_at: number; last_poke_at: number;
}
interface DemoLaunch { view: LaunchView; slots: DemoSlot[]; lock: DemoLock | null; pool: { point: number; liquidity: string } | null; wave_order: number[] }
interface DemoState { clockOffset: number; nextId: number; launches: DemoLaunch[]; seeded: boolean }

const realNow = () => Math.floor(Date.now() / 1000);

function load(): DemoState {
  try {
    const s = localStorage.getItem(KEY);
    if (s) return JSON.parse(s);
  } catch {}
  return { clockOffset: 0, nextId: 1, launches: [], seeded: false };
}
function save(s: DemoState) { localStorage.setItem(KEY, JSON.stringify(s)); notify(); }

const listeners = new Set<() => void>();
export function onDemoChange(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }
function notify() { listeners.forEach((f) => f()); }

export function demoNow(): number { return realNow() + load().clockOffset; }

const usdToQuote = (usd: number) => toRaw((usd / CONFIG.nearUsd).toFixed(6), 24).toString();
const q = (n: number) => (BigInt(Math.round(n * 1e6)) * NEAR / 1_000_000n).toString();

function err(msg: string): never { throw new Error(msg); }

function computeOpenCap(p: LaunchParams): bigint {
  const supply = BigInt(p.total_supply ?? SUPPLY);
  const fdv = BigInt(p.opening_fdv_quote);
  const cap = supply * BigInt(p.presale_cap_bps) / 10000n;
  const reserved = p.reserved.reduce((a, r) => a + tokensForQuote(r.quote_amount, supply, fdv), 0n);
  if (reserved >= cap) err("reserved slots exceed the presale cap");
  return (cap - reserved) * fdv / supply;
}

export function validateParams(p: LaunchParams, now: number): string[] {
  const e: string[] = [];
  if (!/^[A-Z0-9]{2,10}$/.test(p.symbol)) e.push("Symbol must be 2–10 characters, A–Z or 0–9.");
  if (!p.name || p.name.length > 64) e.push("Name must be 1–64 characters.");
  if (p.presale_cap_bps <= 0 || p.presale_cap_bps > 5000) e.push("Presale cap must be between 0% and 50%.");
  if (BigInt(p.wallet_min) <= 0n || BigInt(p.wallet_min) > BigInt(p.wallet_max)) e.push("Need 0 < wallet min ≤ wallet max.");
  if (p.sale_end <= p.sale_start) e.push("Sale end must be after sale start.");
  if (p.sale_end - Math.max(p.sale_start, now) > 7 * 86400) e.push("Presale window can be at most 7 days.");
  if (!p.allowlist.length) e.push("Add at least one presale wallet.");
  if (p.allowlist.length + p.reserved.length > 200) e.push("At most 200 slots.");
  const bps = p.milestones.reduce((a, m) => a + m.unlock_bps, 0);
  if (!p.milestones.length) e.push("Add at least one unlock milestone.");
  if (bps !== 10000) e.push(`Milestone unlocks must add up to 100% (now ${bps / 100}%).`);
  let prev = 0n;
  for (const m of p.milestones) {
    if (BigInt(m.target_fdv_quote) <= prev) e.push("Milestone targets must go up.");
    prev = BigInt(m.target_fdv_quote);
  }
  if (p.milestones[0] && BigInt(p.milestones[0].target_fdv_quote) <= BigInt(p.opening_fdv_quote)) e.push("First milestone must be above the opening FDV.");
  const fs = p.fee_split;
  const fe = p.fee_extra;
  const extra = fe && ((fe.operations_bps || 0) + (fe.near_ai_bps || 0) > 0) ? fe : null;
  if (extra) {
    if (extra.operations_bps > 3000) e.push("Operations share is capped at 30%.");
    if (extra.near_ai_bps > 2000) e.push("NEAR AI credits share is capped at 20%.");
  }
  const feeSum = fs.holders_bps + fs.liquidity_bps + fs.community_bps + (extra?.operations_bps || 0) + (extra?.near_ai_bps || 0);
  const bb = p.buyback_bps || 0;
  if (bb > 2000) e.push("Lock buyback is capped at 20%.");
  if (bb > fs.liquidity_bps) e.push("Lock buyback cannot exceed the liquidity share.");
  if (feeSum !== 10000) e.push("Fee split must add up to 100%.");
  if (p.twap.window_sec < 60) e.push("TWAP window must be at least 60 seconds.");
  if (p.twap.min_observations < 2) e.push("Need at least 2 observations.");
  if ((p.twap.min_observations - 1) * p.twap.min_obs_interval_sec > p.twap.window_sec) e.push("Observations × spacing must fit in the TWAP window.");
  if (p.reveal.waves < 1 || p.reveal.waves > 10) e.push("Reveal waves must be 1–10.");
  try {
    const cap = computeOpenCap(p);
    if (BigInt(p.min_raise) > cap) e.push("Minimum raise is above the open cap.");
  } catch (x: any) { e.push(x.message); }
  const hashes = [...p.allowlist, ...p.reserved.map((r) => r.hash)];
  if (new Set(hashes).size !== hashes.length) e.push("Duplicate wallet in allowlist / reserved.");
  return e;
}

function buildView(id: number, launcher: string, p: LaunchParams, now: number): LaunchView {
  const supply = BigInt(p.total_supply ?? SUPPLY);
  const token_id = `${p.symbol.toLowerCase()}-${id}.${CONFIG.coordinator || "kyp-demo.testnet"}`;
  const quote = p.quote_token_id;
  const tokenIsX = token_id < quote;
  const pool_id = tokenIsX ? `${token_id}|${quote}|10000` : `${quote}|${token_id}|10000`;
  const raw = pointForFdv(p.opening_fdv_quote, supply, tokenIsX);
  const init_point = Math.floor(raw / POINT_DELTA) * POINT_DELTA;
  const reservedTotal = p.reserved.reduce((a, r) => a + BigInt(r.quote_amount), 0n);
  const reservedTokens = p.reserved.reduce((a, r) => a + tokensForQuote(r.quote_amount, supply, p.opening_fdv_quote), 0n);
  return {
    id, launcher, status: "Open", created_at: now, name: p.name, symbol: p.symbol, icon: p.icon, description: p.description,
    terms_uri: p.terms_uri, token_id, quote_token_id: quote, total_supply: supply.toString(), decimals: p.decimals ?? 18,
    opening_fdv_quote: p.opening_fdv_quote, presale_cap_bps: p.presale_cap_bps, min_raise: p.min_raise,
    wallet_min: p.wallet_min, wallet_max: p.wallet_max, open_cap_quote: computeOpenCap(p).toString(),
    open_slots: p.allowlist.length, reserved_slots: p.reserved.length, filled_open_slots: 0, filled_reserved_slots: 0,
    reserved_quote_total: reservedTotal.toString(), sale_start: p.sale_start, sale_end: p.sale_end,
    milestones: p.milestones, twap: p.twap, reveal: p.reveal, fee_split: p.fee_split, fee_extra: p.fee_extra ?? null, buyback_bps: p.buyback_bps ?? 0,
    total_raised: "0", presale_tokens: "0", reserved_tokens: reservedTokens.toString(), lp_tokens: "0",
    pool_contract: CONFIG.pool || "dclv2.ref-dev.testnet", pool_id, token_is_x: tokenIsX, init_point,
    progress: { lock_funded: false, pool_created: false, token_deposited: false, quote_deposited: false, liquidity_added: false },
    launched_at: null, revealed_waves: 0, next_wave_at: null, lpt_ids: [], fee_balances: [],
  };
}

function refresh(l: DemoLaunch) {
  const v = l.view;
  v.filled_open_slots = l.slots.filter((s) => s.kind === "Open" && BigInt(s.deposit) > 0n).length;
  v.filled_reserved_slots = l.slots.filter((s) => isReserved(s.kind) && BigInt(s.tokens) > 0n).length;
  v.total_raised = l.slots.filter((s) => s.kind === "Open").reduce((a, s) => a + BigInt(s.deposit), 0n).toString();
  v.next_wave_at = v.launched_at && v.revealed_waves < v.reveal.waves ? v.launched_at + (v.revealed_waves + 1) * v.reveal.interval_sec : null;
}

function get(s: DemoState, id: number): DemoLaunch {
  return s.launches.find((l) => l.view.id === id) ?? err("no such launch");
}

// ------------------------------------------------------------------ seed data

const DEFAULT_TWAP = { window_sec: 3600, min_observations: 6, min_liquidity: "1", claim_delay_sec: 3600, min_obs_interval_sec: 300 };

async function seed(s: DemoState) {
  const now = realNow();
  const fee = (sym: string) => ({
    holders_bps: 5000, liquidity_bps: 3000, community_bps: 2000,
    holders_account: `holders.${sym}.testnet`, liquidity_account: `lp.${sym}.testnet`, community_account: `bounties.${sym}.testnet`,
  });
  const invites = async (names: string[]) => Promise.all(names.map(async (n, i) => ({ account: n, salt: `demo${i}${n.length}`, hash: await slotHash(n, `demo${i}${n.length}`) })));

  // 1. OWL — live, extreme milestones
  const owlNames = ["ana.testnet", "bitpilot.testnet", "cryptokite.testnet", "dao-dana.testnet", "memesmith.testnet", "nearowl.testnet", "orbit.testnet", "pixelfox.testnet", "zed.testnet"];
  const owlAmounts = [3, 5, 8, 12, 20, 25, 40, 60, 75];
  const owlInv = await invites(owlNames);
  const whale = { account: "bigname.testnet", salt: "demo-whale" , hash: await slotHash("bigname.testnet", "demo-whale") };
  const owlP: LaunchParams = {
    name: "Night Owl", symbol: "OWL", icon: null,
    description: "Owls that stay up for the long game. Caballeros are artists, devs and two podcast hosts.",
    terms_uri: null, quote_token_id: CONFIG.quote, total_supply: null, decimals: null,
    opening_fdv_quote: usdToQuote(5000), presale_cap_bps: 2000, min_raise: q(50), wallet_min: q(2), wallet_max: q(80),
    allowlist: owlInv.map((i) => i.hash), reserved: [{ hash: whale.hash, quote_amount: q(50) }],
    sale_start: now - 4 * 86400, sale_end: now - 1 * 86400,
    milestones: [
      { target_fdv_quote: usdToQuote(1_000_000), unlock_bps: 2000 },
      { target_fdv_quote: usdToQuote(10_000_000), unlock_bps: 3000 },
      { target_fdv_quote: usdToQuote(25_000_000), unlock_bps: 5000 },
    ],
    twap: DEFAULT_TWAP, reveal: { waves: 3, interval_sec: 86400 }, fee_split: fee("owl"),
  };
  const owl: DemoLaunch = { view: buildView(s.nextId++, "owlfounder.testnet", owlP, now - 5 * 86400), slots: [], lock: null, pool: null, wave_order: [] };
  owl.slots = owlInv.map((i, k) => ({ hash: i.hash, kind: "Open", account: i.account, deposit: q(owlAmounts[k]), tokens: "0", invite: i }));
  owl.slots.push({ hash: whale.hash, kind: { Reserved: { quote_amount: q(50) } }, account: null, deposit: "0", tokens: "0", invite: whale });
  owl.view.sale_end = now + 3 * 86400; // keep window open for settle, then close
  refresh(owl);
  s.launches.push(owl);
  settle(owl, now - 30 * 3600);
  owl.view.sale_end = now - 30 * 3600;
  owl.view.revealed_waves = 1;
  // price history: a steady climb to ~8x the opening FDV over 30h
  const lock = owl.lock!;
  for (let t = now - 30 * 3600; t <= now - 120; t += 300) {
    const f = (t - (now - 30 * 3600)) / (30 * 3600);
    lock.observations.push({ ts: t, point: owl.view.init_point + Math.round(f * 20800), liquidity: "1000000000000000000000000000" });
  }
  owl.pool!.point = owl.view.init_point + 20800;
  refresh(owl);

  // 2. FROG — presale open
  const frogNames = ["alice.testnet", "bob.testnet", "carol.testnet", "dave.testnet", "erin.testnet", "frank.testnet", "grace.testnet", "heidi.testnet", "ivan.testnet", "judy.testnet", "mallory.testnet", "trent.testnet"];
  const frogInv = await invites(frogNames);
  const frogRes = await invites(["influencer.testnet", "marketmaker.testnet"]);
  const frogP: LaunchParams = {
    name: "Pond Frog", symbol: "FROG", icon: null,
    description: "A frog with a plan. 12 hand-picked caballeros, 2 reserved slots for bigger names after launch.",
    terms_uri: null, quote_token_id: CONFIG.quote, total_supply: null, decimals: null,
    opening_fdv_quote: usdToQuote(5000), presale_cap_bps: 3000, min_raise: q(100), wallet_min: q(5), wallet_max: q(60),
    allowlist: frogInv.map((i) => i.hash), reserved: frogRes.map((r) => ({ hash: r.hash, quote_amount: q(75) })),
    sale_start: now - 86400, sale_end: now + 2 * 86400 + 3600 * 5,
    milestones: [
      { target_fdv_quote: usdToQuote(2_500_000), unlock_bps: 2500 },
      { target_fdv_quote: usdToQuote(10_000_000), unlock_bps: 2500 },
      { target_fdv_quote: usdToQuote(50_000_000), unlock_bps: 5000 },
    ],
    twap: { ...DEFAULT_TWAP, window_sec: 7200, min_observations: 12 }, reveal: { waves: 4, interval_sec: 43200 }, fee_split: fee("frog"),
  };
  const frog: DemoLaunch = { view: buildView(s.nextId++, "frogking.testnet", frogP, now - 86400), slots: [], lock: null, pool: null, wave_order: [] };
  frog.slots = frogInv.map((i, k) => ({ hash: i.hash, kind: "Open", account: k < 5 ? i.account : null, deposit: k < 5 ? q([10, 25, 40, 15, 60][k]) : "0", tokens: "0", invite: i }));
  frogRes.forEach((r) => frog.slots.push({ hash: r.hash, kind: { Reserved: { quote_amount: q(75) } }, account: null, deposit: "0", tokens: "0", invite: r }));
  refresh(frog);
  s.launches.push(frog);

  s.seeded = true;
}

export async function ensureSeeded() {
  const s = load();
  if (s.seeded) return;
  await seed(s);
  save(s);
}

export function resetDemo() {
  localStorage.removeItem(KEY);
  notify();
}

// ------------------------------------------------------------------ engine

function settle(l: DemoLaunch, now: number) {
  const v = l.view;
  const supply = BigInt(v.total_supply);
  let presale = 0n;
  const positions: Record<string, Position> = {};
  for (const s of l.slots) {
    if (s.kind === "Open" && BigInt(s.deposit) > 0n) {
      const t = tokensForQuote(s.deposit, supply, v.opening_fdv_quote);
      s.tokens = t.toString();
      presale += t;
      positions[s.account!] = { total: t.toString(), claimed: "0" };
    }
  }
  const idx = l.slots.map((_, i) => i).filter((i) => l.slots[i].kind === "Open" && BigInt(l.slots[i].deposit) > 0n);
  idx.sort((a, b) => {
    const d = BigInt(l.slots[a].deposit) - BigInt(l.slots[b].deposit);
    return d === 0n ? (l.slots[a].hash < l.slots[b].hash ? -1 : 1) : d < 0n ? -1 : 1;
  });
  l.wave_order = idx;
  v.presale_tokens = presale.toString();
  v.lp_tokens = (supply - presale - BigInt(v.reserved_tokens)).toString();
  v.progress = { lock_funded: true, pool_created: true, token_deposited: true, quote_deposited: true, liquidity_added: true };
  v.status = "Live";
  v.launched_at = now;
  v.lpt_ids = [`${v.pool_id}#1`, `${v.pool_id}#2`];
  l.lock = {
    milestones: v.milestones.map((m) => ({ ...m, qualified_at: null, qualified_twap_point: null })),
    observations: [], positions, total_locked: presale.toString(), total_claimed: "0", created_at: now, last_poke_at: 0,
  };
  l.pool = { point: v.init_point, liquidity: (BigInt(v.lp_tokens) + BigInt(v.total_raised)).toString() };
}

function unlockedBps(l: DemoLaunch, now: number) {
  return (l.lock?.milestones ?? []).filter((m) => m.qualified_at != null && now >= m.qualified_at + l.view.twap.claim_delay_sec).reduce((a, m) => a + m.unlock_bps, 0);
}

export const demo = {
  now: demoNow,
  async list(): Promise<LaunchView[]> { await ensureSeeded(); return load().launches.map((l) => l.view).reverse(); },
  async launch(id: number): Promise<LaunchView | null> { await ensureSeeded(); return load().launches.find((l) => l.view.id === id)?.view ?? null; },
  async presalers(id: number): Promise<PresalerView[]> {
    const l = get(load(), id);
    const v = l.view;
    const n = l.wave_order.length;
    const out: PresalerView[] = l.wave_order.map((i, rank) => {
      const s = l.slots[i];
      const wave = waveOf(rank, n, v.reveal.waves);
      return { wave, kind: s.kind, quote: s.deposit, tokens: s.tokens, account_id: wave <= v.revealed_waves ? s.account : null };
    });
    for (const s of l.slots.filter((s) => isReserved(s.kind) && BigInt(s.tokens) > 0n))
      out.push({ wave: v.reveal.waves, kind: s.kind, quote: s.deposit, tokens: s.tokens, account_id: v.revealed_waves >= v.reveal.waves ? s.account : null });
    return out;
  },
  async slot(id: number, hash: string): Promise<SlotView | null> {
    const l = get(load(), id);
    const i = l.slots.findIndex((s) => s.hash === hash);
    if (i < 0) return null;
    const s = l.slots[i];
    return { index: i, kind: s.kind, filled: BigInt(s.deposit) > 0n, deposit: s.deposit, tokens: s.tokens };
  },
  async lock(id: number): Promise<LockView | null> {
    const l = get(load(), id);
    if (!l.lock) return null;
    const k = l.lock;
    return {
      launch_id: id, token_id: l.view.token_id, pool_contract: l.view.pool_contract, pool_id: l.view.pool_id, token_is_x: l.view.token_is_x,
      milestones: k.milestones, twap: l.view.twap, observations_count: k.observations.length, last_observation: k.observations.at(-1) ?? null,
      supply: l.view.total_supply, total_locked: k.total_locked, total_claimed: k.total_claimed,
      positions_count: Object.keys(k.positions).length, created_at: k.created_at, unlocked_bps: unlockedBps(l, demoNow()),
    };
  },
  async observations(id: number): Promise<Observation[]> { return get(load(), id).lock?.observations ?? []; },
  async twap(id: number): Promise<TwapStatus | null> {
    const l = get(load(), id);
    if (!l.lock) return null;
    const obs = l.lock.observations;
    const supply = l.view.total_supply;
    const spot = obs.at(-1)?.point ?? null;
    const spotFdv = spot == null ? null : BigInt(Math.floor(fdvAtPoint(spot, l.view.token_is_x, supply))).toString();
    const r = twapPoint(obs, demoNow(), l.view.twap);
    return r.ok
      ? { ok: true, error: null, avg_point: r.avg_point, twap_fdv_quote: BigInt(Math.floor(fdvAtPoint(r.avg_point, l.view.token_is_x, supply))).toString(), observations_in_window: r.observations, spot_point: spot, spot_fdv_quote: spotFdv }
      : { ok: false, error: r.error, avg_point: null, twap_fdv_quote: null, observations_in_window: null, spot_point: spot, spot_fdv_quote: spotFdv };
  },
  async position(id: number, account: string): Promise<Position | null> { return get(load(), id).lock?.positions[account] ?? null; },
  async claimable(id: number, account: string): Promise<string> {
    const l = get(load(), id);
    const p = l.lock?.positions[account];
    if (!p) return "0";
    const un = BigInt(p.total) * BigInt(unlockedBps(l, demoNow())) / 10000n;
    const c = un - BigInt(p.claimed);
    return (c > 0n ? c : 0n).toString();
  },
  /** Demo only: invites you can use to try the flow. */
  async invites(id: number) {
    const l = get(load(), id);
    return l.slots.filter((s) => s.invite).map((s) => ({ ...s.invite!, kind: s.kind, used: BigInt(s.deposit) > 0n }));
  },

  // ---------------- actions
  async create(launcher: string, p: LaunchParams, invites: { account: string; salt: string; hash: string }[]) {
    const s = load();
    const now = demoNow();
    const errs = validateParams(p, now);
    if (errs.length) err(errs[0]);
    const id = s.nextId++;
    const l: DemoLaunch = { view: buildView(id, launcher, p, now), slots: [], lock: null, pool: null, wave_order: [] };
    const inv = new Map(invites.map((i) => [i.hash, i]));
    l.slots = p.allowlist.map((h) => ({ hash: h, kind: "Open" as SlotKind, account: null, deposit: "0", tokens: "0", invite: inv.get(h) }));
    p.reserved.forEach((r) => l.slots.push({ hash: r.hash, kind: { Reserved: { quote_amount: r.quote_amount } }, account: null, deposit: "0", tokens: "0", invite: inv.get(r.hash) }));
    s.launches.push(l);
    save(s);
    return id;
  },
  async deposit(id: number, account: string, salt: string, amountRaw: bigint) {
    const s = load();
    const l = get(s, id);
    const v = l.view;
    const now = demoNow();
    if (v.status !== "Open") err("presale not open");
    if (now < v.sale_start) err("presale has not started");
    if (now >= v.sale_end) err("presale ended");
    const h = await slotHash(account, salt);
    const slot = l.slots.find((x) => x.hash === h) ?? err("wallet not on the allowlist (check account + invite code)");
    if (slot.kind !== "Open") err("this is a reserved slot; it opens after launch");
    const roomW = BigInt(v.wallet_max) - BigInt(slot.deposit);
    const roomC = BigInt(v.open_cap_quote) - BigInt(v.total_raised);
    let accept = amountRaw;
    if (roomW < accept) accept = roomW;
    if (roomC < accept) accept = roomC;
    if (accept <= 0n) err("wallet max or presale cap reached");
    if (BigInt(slot.deposit) + accept < BigInt(v.wallet_min)) err("below per-wallet minimum");
    slot.deposit = (BigInt(slot.deposit) + accept).toString();
    slot.account = account;
    refresh(l);
    save(s);
    return { accepted: accept, refunded: amountRaw - accept };
  },
  async launchNow(id: number, caller: string) {
    const s = load();
    const l = get(s, id);
    const v = l.view;
    if (caller !== v.launcher) err("launcher only");
    if (v.status !== "Open") err("launch not open");
    if (demoNow() >= v.sale_end) err("sale window over; caballeros can withdraw");
    if (BigInt(v.total_raised) === 0n || BigInt(v.total_raised) < BigInt(v.min_raise)) err("min raise not reached");
    settle(l, demoNow());
    refresh(l);
    save(s);
  },
  async cancel(id: number, caller: string) {
    const s = load(); const l = get(s, id);
    if (caller !== l.view.launcher) err("launcher only");
    if (l.view.status !== "Open") err("only an open presale can be cancelled");
    l.view.status = "Cancelled"; save(s);
  },
  async withdraw(id: number, account: string) {
    const s = load(); const l = get(s, id); const v = l.view;
    const ok = v.status === "Cancelled" || (v.status === "Open" && demoNow() >= v.sale_end);
    if (!ok) err("deposits are committed until the launch is cancelled or misses sale_end");
    const slot = l.slots.find((x) => x.account === account && BigInt(x.deposit) > 0n) ?? err("no deposit");
    const amt = slot.deposit; slot.deposit = "0"; refresh(l); save(s); return amt;
  },
  /** Demo: simulate market activity moving the pool price to a target FDV (raw quote). */
  async setPrice(id: number, fdvRaw: bigint) {
    const s = load(); const l = get(s, id);
    if (!l.pool) err("no pool yet");
    l.pool.point = pointForFdv(fdvRaw, l.view.total_supply, l.view.token_is_x) + 1;
    save(s);
  },
  async record(id: number) {
    const s = load(); const l = get(s, id); const now = demoNow();
    if (!l.lock || !l.pool) err("no lock yet");
    if (l.lock.last_poke_at && now < l.lock.last_poke_at + l.view.twap.min_obs_interval_sec) err("too soon: wait min_obs_interval_sec between observations");
    l.lock.last_poke_at = now;
    l.lock.observations.push({ ts: now, point: l.pool.point, liquidity: l.pool.liquidity });
    if (l.lock.observations.length > 512) l.lock.observations.shift();
    save(s);
  },
  /** Demo: advance the clock by `sec`, poking the observer at every allowed interval. */
  async advance(id: number | null, sec: number) {
    const s = load();
    const l = id == null ? null : s.launches.find((x) => x.view.id === id) ?? null;
    if (l?.lock && l.pool) {
      const step = l.view.twap.min_obs_interval_sec;
      let t = realNow() + s.clockOffset;
      const end = t + sec;
      while (t + step <= end) {
        t += step;
        l.lock.observations.push({ ts: t, point: l.pool.point, liquidity: l.pool.liquidity });
        l.lock.last_poke_at = t;
      }
      if (l.lock.observations.length > 512) l.lock.observations.splice(0, l.lock.observations.length - 512);
    }
    s.clockOffset += sec;
    s.launches.forEach(refresh);
    save(s);
  },
  async qualify(id: number) {
    const s = load(); const l = get(s, id); const now = demoNow();
    if (!l.lock) err("no lock");
    const r = twapPoint(l.lock.observations, now, l.view.twap);
    if (!r.ok) err(r.error);
    const fdv = fdvAtPoint(r.avg_point, l.view.token_is_x, l.view.total_supply);
    let n = 0;
    for (const m of l.lock.milestones) {
      if (m.qualified_at == null && fdv >= Number(BigInt(m.target_fdv_quote))) { m.qualified_at = now; m.qualified_twap_point = r.avg_point; n++; }
    }
    if (!n) err("TWAP FDV is below the next milestone");
    save(s);
    return n;
  },
  async claim(id: number, account: string) {
    const amt = BigInt(await demo.claimable(id, account));
    if (amt <= 0n) err("nothing to claim yet");
    const s = load(); const l = get(s, id);
    const p = l.lock!.positions[account];
    p.claimed = (BigInt(p.claimed) + amt).toString();
    l.lock!.total_claimed = (BigInt(l.lock!.total_claimed) + amt).toString();
    save(s);
    return amt;
  },
  async revealNext(id: number) {
    const s = load(); const l = get(s, id); const v = l.view;
    if (v.status !== "Live") err("launch not live");
    if (v.revealed_waves >= v.reveal.waves) err("all waves revealed");
    const at = v.launched_at! + (v.revealed_waves + 1) * v.reveal.interval_sec;
    if (demoNow() < at) err("next wave not due yet");
    v.revealed_waves++; refresh(l); save(s);
  },
  async buyReserved(id: number, account: string, salt: string) {
    const s = load(); const l = get(s, id); const v = l.view;
    if (v.status !== "Live") err("reserved slots open after launch");
    const h = await slotHash(account, salt);
    const slot = l.slots.find((x) => x.hash === h) ?? err("not a reserved slot holder");
    if (!isReserved(slot.kind)) err("not a reserved slot");
    if (BigInt(slot.deposit) > 0n) err("slot already filled");
    const price = slot.kind.Reserved.quote_amount;
    const t = tokensForQuote(price, v.total_supply, v.opening_fdv_quote);
    slot.deposit = price; slot.tokens = t.toString(); slot.account = account;
    const pos = l.lock!.positions[account] ?? { total: "0", claimed: "0" };
    pos.total = (BigInt(pos.total) + t).toString();
    l.lock!.positions[account] = pos;
    l.lock!.total_locked = (BigInt(l.lock!.total_locked) + t).toString();
    const fb = v.fee_balances.find((f) => f[0] === v.quote_token_id);
    if (fb) fb[1] = (BigInt(fb[1]) + BigInt(price)).toString(); else v.fee_balances.push([v.quote_token_id, price]);
    refresh(l); save(s);
    return t;
  },
};
