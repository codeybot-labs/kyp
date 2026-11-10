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
  position: (id: number, a: string): Promise<Position | null> => (getMode() === "demo" ? demo.position(id, a) : nullIfMissing(view(l(), "get_position", { launch_id: id, account_id: a }))),
  claimable: (id: number, a: string): Promise<string> => (getMode() === "demo" ? demo.claimable(id, a) : nullIfMissing(view<string>(l(), "claimable", { launch_id: id, account_id: a })).then((x) => x ?? "0")),
};
