// One data API for the UI. "demo" = in-browser simulation; "testnet" = live views from NEAR testnet.
import { CONFIG, TESTNET_CONFIGURED } from "./config";
import { demo } from "./demo";
import { view } from "./near";
import type { LaunchView, LockView, Observation, Position, PresalerView, SlotView, TwapStatus } from "./model";

export type Mode = "demo" | "testnet";

export function getMode(): Mode {
  if (typeof localStorage === "undefined") return "demo";
  const m = localStorage.getItem("kyp-mode");
  return m === "testnet" && TESTNET_CONFIGURED ? "testnet" : "demo";
}
export function setMode(m: Mode) { localStorage.setItem("kyp-mode", m); location.reload(); }

const c = () => CONFIG.coordinator;
const l = () => CONFIG.lock;
const nullIfMissing = async <T,>(p: Promise<T>): Promise<T | null> => { try { return await p; } catch { return null; } };

/** Subset of the coordinator's PlatformConfig the UI needs to attach the right NEAR. */
export interface ChainConfig { token_account_deposit: string; pool_storage_deposit: string; pool_create_deposit: string; liquidity_deposit: string }
let cfgP: Promise<ChainConfig> | null = null;

export const api = {
  config: (): Promise<ChainConfig> => (cfgP ??= view<ChainConfig>(c(), "get_config", {})),
  mode: getMode,
  now: (): number => (getMode() === "demo" ? demo.now() : Math.floor(Date.now() / 1000)),
  list: (): Promise<LaunchView[]> => (getMode() === "demo" ? demo.list() : view<LaunchView[]>(c(), "get_launches", { from_index: 0, limit: 50 }).then((x) => x.reverse())),
  launch: (id: number): Promise<LaunchView | null> => (getMode() === "demo" ? demo.launch(id) : view(c(), "get_launch", { launch_id: id })),
  presalers: (id: number): Promise<PresalerView[]> => (getMode() === "demo" ? demo.presalers(id) : view(c(), "get_presalers", { launch_id: id })),
  slot: (id: number, hash: string): Promise<SlotView | null> => (getMode() === "demo" ? demo.slot(id, hash) : view(c(), "get_slot", { launch_id: id, hash })),
  lock: (id: number): Promise<LockView | null> => (getMode() === "demo" ? demo.lock(id) : nullIfMissing(view(l(), "get_lock", { launch_id: id }))),
  twap: (id: number): Promise<TwapStatus | null> => (getMode() === "demo" ? demo.twap(id) : nullIfMissing(view(l(), "twap_status", { launch_id: id }))),
  observations: (id: number): Promise<Observation[]> => (getMode() === "demo" ? demo.observations(id) : nullIfMissing(view<Observation[]>(l(), "get_observations", { launch_id: id, from_index: 0, limit: 200 })).then((x) => x ?? [])),
  /** Every recorded observation (paged), for the price chart. */
  allObservations: async (id: number): Promise<Observation[]> => {
    if (getMode() === "demo") return demo.observations(id);
    const lk = await nullIfMissing(view<LockView>(l(), "get_lock", { launch_id: id }));
    const n = lk?.observations_count ?? 0;
    const out: Observation[] = [];
    for (let from = 0; from < n; from += 200) {
      const page = await nullIfMissing(view<Observation[]>(l(), "get_observations", { launch_id: id, from_index: from, limit: 200 }));
      if (!page?.length) break;
      out.push(...page);
    }
    return out;
  },
  /** Live pool point right now (DCL `get_pool.current_point`; demo: simulated pool). */
  spot: async (lv: LaunchView): Promise<{ ts: number; point: number } | null> => {
    if (getMode() === "demo") { const t = await demo.twap(lv.id); return t?.spot_point == null ? null : { ts: demo.now(), point: t.spot_point }; }
    const p = await nullIfMissing(view<{ current_point: number }>(lv.pool_contract, "get_pool", { pool_id: lv.pool_id }));
    return p && Number.isFinite(p.current_point) ? { ts: Math.floor(Date.now() / 1000), point: p.current_point } : null;
  },
  position: (id: number, a: string): Promise<Position | null> => (getMode() === "demo" ? demo.position(id, a) : nullIfMissing(view(l(), "get_position", { launch_id: id, account_id: a }))),
  claimable: (id: number, a: string): Promise<string> => (getMode() === "demo" ? demo.claimable(id, a) : nullIfMissing(view<string>(l(), "claimable", { launch_id: id, account_id: a })).then((x) => x ?? "0")),
};
