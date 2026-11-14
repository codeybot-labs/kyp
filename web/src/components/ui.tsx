import { createResource, createSignal, onCleanup, Show, For, type JSX } from "solid-js";
import { api } from "../lib/source";
import { onDemoChange } from "../lib/demo";
import { CONFIG, NETWORK_LABEL } from "../lib/config";
import { units, fmt, fmtQuoteAmount, fmtUsd, fdvAtPoint } from "../lib/math.mjs";
import type { LaunchView, LaunchStatus } from "../lib/model";
import { account, connect, signAndSend, type Tx as WalletTx } from "../lib/wallet";

export const quote = (raw: string | bigint | number) => units(BigInt(raw), 24);
export const tok = (raw: string | bigint) => units(BigInt(raw), 18);
export const fmtQ = (raw: string | bigint, d = 2) => `${fmtQuoteAmount(quote(raw), d)} wNEAR`;
export const fmtT = (raw: string | bigint) => fmt(tok(raw), 2);
export const usdOf = (raw: string | bigint | number) => fmtUsd(quote(raw) * CONFIG.nearUsd);
export const pct = (bps: number) => `${(bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
export const fdvAt = (l: { token_is_x: boolean; total_supply: string }, point: number) => fdvAtPoint(point, l.token_is_x, l.total_supply) / 1e24;

export function launchIdFromUrl(): number {
  const p = new URLSearchParams(location.search).get("id");
  return p ? Number(p) : 1;
}

/** Re-run a fetcher whenever demo state changes, and on an interval in testnet mode. */
export function useLive<T>(fetcher: () => Promise<T>, intervalMs = 15000) {
  const [tick, setTick] = createSignal(0);
  const [res, { refetch }] = createResource(tick, () => fetcher());
  const off = onDemoChange(() => setTick((t) => t + 1));
  const iv = setInterval(() => api.mode() === "testnet" && setTick((t) => t + 1), intervalMs);
  onCleanup(() => { off(); clearInterval(iv); });
  return [res, () => { setTick((t) => t + 1); return refetch(); }] as const;
}

export function useNow(ms = 1000) {
  const [now, setNow] = createSignal(api.now());
  const iv = setInterval(() => setNow(api.now()), ms);
  const off = onDemoChange(() => setNow(api.now()));
  onCleanup(() => { clearInterval(iv); off(); });
  return now;
}

export function dur(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return `${s}s`;
}
export const when = (ts: number) => new Date(ts * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function StatusPill(p: { status: LaunchStatus; saleEnd?: number; now?: number }) {
  const map: Record<LaunchStatus, [string, string]> = {
    Creating: ["warn", "Deploying token"],
    Open: ["open", "Presale open"],
    Launching: ["warn", "Launching"],
    Live: ["live", "Live"],
    Cancelled: ["bad", "Cancelled"],
    Failed: ["bad", "Failed"],
  };
  const ended = () => p.status === "Open" && p.saleEnd && p.now && p.now >= p.saleEnd;
  return (
    <span class={`pill ${ended() ? "bad" : map[p.status][0]}`}>
      <span class="dot" />
      {ended() ? "Missed launch window" : map[p.status][1]}
    </span>
  );
}

function avatarColor(s: string) {
  const palette = ["#4df0bb", "#ffd23f", "#ff6fa5", "#b9a8ff", "#5b3df5"];
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length];
}

export function TokenBadge(p: { symbol: string; icon?: string | null; lg?: boolean }) {
  const style = { "background-color": avatarColor(p.symbol), "font-size": p.lg ? "1.3rem" : "1.1rem", width: p.lg ? "64px" : "52px", height: p.lg ? "64px" : "52px" };
  return (
    <Show when={p.icon} fallback={<div class="av" style={style}>{p.symbol.slice(0, 4)}</div>}>
      <img class="av" src={p.icon!} alt={p.symbol} style={{ ...style, "object-fit": "cover" }} />
    </Show>
  );
}

const TABS = [
  ["launch", "Status"],
  ["terms", "Terms & milestones"],
  ["deposit", "Presale deposit"],
  ["reveal", "Reveal waves"],
  ["claim", "Claim"],
  ["corner", "Cabal Corner"],
] as const;

export function LaunchHeader(p: { l: LaunchView; tab: string }) {
  const now = useNow();
  return (
    <div style={{ padding: "36px 0 8px" }}>
      <div class="row" style={{ gap: "16px" }}>
        <TokenBadge symbol={p.l.symbol} icon={p.l.icon} lg />
        <div style={{ flex: 1, "min-width": "220px" }}>
          <div class="row" style={{ gap: "10px" }}>
            <h1 style={{ "font-size": "34px" }}>{p.l.name}</h1>
            <span class="pill">${p.l.symbol}</span>
            <StatusPill status={p.l.status} saleEnd={p.l.sale_end} now={now()} />
          </div>
          <p class="muted" style={{ "margin-top": "6px", "max-width": "720px" }}>{p.l.description}</p>
        </div>
      </div>
      <nav class="subnav">
        <For each={TABS}>{([k, label]) => <a class={p.tab === k ? "on" : ""} href={`/${k}?id=${p.l.id}`}>{label}</a>}</For>
      </nav>
    </div>
  );
}

export function WithLaunch(p: { tab: string; children: (l: () => LaunchView) => JSX.Element }) {
  const id = launchIdFromUrl();
  const [l] = useLive(() => api.launch(id));
  return (
    <Show when={!l.loading || l()} fallback={<div style={{ padding: "40px 0" }} class="stack"><div class="skeleton" style={{ width: "40%", height: "36px" }} /><div class="skeleton" /><div class="skeleton" style={{ width: "70%" }} /></div>}>
      <Show when={l()} fallback={<div class="card" style={{ "margin-top": "40px" }}><h2>Launch not found</h2><p class="muted" style={{ "margin-top": "8px" }}>No launch #{id} in this mode. <a class="link" href="/">See all launches</a>.</p></div>}>
        <LaunchHeader l={l()!} tab={p.tab} />
        <div style={{ "margin-top": "18px" }}>{p.children(() => l()!)}</div>
      </Show>
    </Show>
  );
}

const [toastMsg, setToastMsg] = createSignal<{ text: string; kind: string } | null>(null);
let toastTimer: any;
export function toast(text: string, kind: "ok" | "bad" | "" = "", ms = 4200) {
  setToastMsg({ text, kind });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setToastMsg(null), ms);
}
/** Open the connect modal; a mainnet-only wallet picked on testnet gets an explanation, not an error. */
export function connectWallet() {
  return connect().catch((e) => (e?.name === "MainnetOnlyWallet" ? toast(e.message, "", 10000) : toast(`Wallet: ${e?.message ?? e}`, "bad")));
}
export function Toaster() {
  return <Show when={toastMsg()}>{(t) => <div class={`toast ${t().kind}`} data-testid="toast">{t().text}</div>}</Show>;
}

/** Wraps a demo action: runs it and shows the contract-style error if it panics. */
export async function act<T>(fn: () => Promise<T>, okText?: string | ((r: T) => string)) {
  try {
    const r = await fn();
    if (okText) toast(typeof okText === "function" ? okText(r) : okText, "ok");
    return r;
  } catch (e: any) {
    toast(e?.message ?? String(e), "bad");
    return undefined;
  }
}

export function Cli(p: { title: string; cmd: string }) {
  const [copied, setCopied] = createSignal(false);
  return (
    <div class="stack" style={{ "margin-top": "12px" }}>
      <div class="row between">
        <span class="label">{p.title}</span>
        <button class="btn sm ghost" onClick={() => { navigator.clipboard?.writeText(p.cmd); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied() ? "Copied" : "Copy"}</button>
      </div>
      <pre class="code">{p.cmd}</pre>
    </div>
  );
}

export function Stat(p: { label: string; value: JSX.Element; sub?: JSX.Element }) {
  return (
    <div class="card tight stat">
      <div class="label">{p.label}</div>
      <div class="big num">{p.value}</div>
      <Show when={p.sub}><div class="sub">{p.sub}</div></Show>
    </div>
  );
}

export function Spark(p: { points: { ts: number; v: number }[]; targets?: number[]; height?: number }) {
  const W = 600, H = p.height ?? 120;
  const d = () => {
    const pts = p.points;
    if (pts.length < 2) return { path: "", area: "", lines: [] as { y: number; v: number }[] };
    const vs = pts.map((x) => Math.log10(Math.max(x.v, 1e-9)));
    const all = [...vs, ...(p.targets ?? []).map((t) => Math.log10(t))];
    const lo = Math.min(...vs) - 0.1, hi = Math.max(...all) + 0.1;
    const t0 = pts[0].ts, t1 = pts[pts.length - 1].ts || t0 + 1;
    const X = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
    const Y = (v: number) => H - ((v - lo) / (hi - lo)) * (H - 8) - 4;
    const path = pts.map((x, i) => `${i ? "L" : "M"}${X(x.ts).toFixed(1)},${Y(vs[i]).toFixed(1)}`).join(" ");
    return { path, area: `${path} L${W},${H} L0,${H} Z`, lines: (p.targets ?? []).map((t) => ({ y: Y(Math.log10(t)), v: t })) };
  };
  return (
    <svg class="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: `${H}px` }}>
      <defs>
        <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c6f36b" stop-opacity="0.25" /><stop offset="1" stop-color="#c6f36b" stop-opacity="0" /></linearGradient>
      </defs>
      <For each={d().lines}>{(ln) => <line x1="0" x2={W} y1={ln.y} y2={ln.y} stroke="#7cc4ff" stroke-opacity="0.35" stroke-dasharray="4 6" />}</For>
      <path d={d().area} fill="url(#sg)" />
      <path d={d().path} fill="none" stroke="#c6f36b" stroke-width="2" vector-effect="non-scaling-stroke" />
    </svg>
  );
}

/** Sign + send with the connected wallet, toast the result, then run `after` (e.g. refetch). */
export async function sendTx(build: () => Promise<WalletTx | WalletTx[]> | WalletTx | WalletTx[], okText: string, after?: () => void) {
  const hashes = await act(async () => signAndSend(await build()), (h) => (h.length ? `${okText} · tx ${h.at(-1)!.slice(0, 8)}…` : okText));
  if (hashes) after?.();
  return hashes;
}

/** Testnet write area: wallet button(s) when connected, else a connect prompt + the CLI fallback. */
export function Signable(p: { children: JSX.Element; cli?: JSX.Element; note?: string }) {
  return (
    <Show when={account()} fallback={
      <div class="stack">
        <div class="notice row between">
          <span>{p.note ?? `Connect a ${NETWORK_LABEL} wallet to sign this.`}</span>
          <button class="btn sm primary" onClick={connectWallet}>Connect wallet</button>
        </div>
        <Show when={p.cli}><details><summary class="sub" style={{ cursor: "pointer" }}>Or sign with NEAR CLI</summary>{p.cli}</details></Show>
      </div>
    }>
      {p.children}
    </Show>
  );
}
