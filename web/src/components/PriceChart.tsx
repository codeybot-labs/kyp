// Token price chart (TradingView Lightweight Charts™, Apache-2.0). Loaded lazily: this module
// and the charts library are split into their own chunks and only fetched on the status page.
// Data: the lock's recorded observations + the pool's live point, read over RPC. No indexer.
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { IChartApi, ISeriesApi, SeriesType, Time } from "lightweight-charts";
import type { LaunchView } from "../lib/model";
import { api } from "../lib/source";
import { chartModel, fmtAxis, MIN_POINTS } from "../lib/chart.mjs";
import { useLive } from "./ui";

type Kind = "candles" | "line";
type Unit = "fdv" | "price";
const LABEL: Record<number, string> = { 60: "1m", 300: "5m", 900: "15m", 3600: "1h", 14400: "4h", 86400: "1d" };

export default function PriceChart(p: { l: LaunchView }) {
  const [obs] = useLive(() => api.allObservations(p.l.id), 30000);
  const [spot] = useLive(() => api.spot(p.l), 30000);
  const [kind, setKind] = createSignal<Kind>("candles");
  const [unit, setUnit] = createSignal<Unit>("fdv");
  const [ready, setReady] = createSignal(false);
  const [lines, setLines] = createSignal(0);
  const [loadErr, setLoadErr] = createSignal<string | null>(null);
  const isDemo = api.mode() === "demo";
  const model = () => chartModel(obs() ?? [], p.l, { unit: unit(), spot: spot() ?? null });

  let el!: HTMLDivElement;
  let chart: IChartApi | null = null;
  let series: ISeriesApi<SeriesType> | null = null;
  let LW: typeof import("lightweight-charts") | null = null;

  onMount(async () => {
    try {
      LW = await import("lightweight-charts");
      chart = LW.createChart(el, {
        autoSize: true,
        layout: { background: { color: "transparent" }, textColor: "#8d95a3", fontSize: 11, attributionLogo: true },
        grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
        rightPriceScale: { mode: LW.PriceScaleMode.Logarithmic, borderColor: "#222831", scaleMargins: { top: 0.12, bottom: 0.08 } },
        timeScale: { borderColor: "#222831", timeVisible: true, secondsVisible: false,
          // local time; day/month/year ticks show the date (TickMarkType 0-2), others the time
          tickMarkFormatter: (t: Time, type: number) => {
            const d = new Date((t as number) * 1000);
            return type <= 2 ? d.toLocaleDateString([], { month: "short", day: "numeric" }) : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          } },
        localization: { timeFormatter: (t: Time) => new Date((t as number) * 1000).toLocaleString(), priceFormatter: fmtAxis },
        crosshair: { mode: LW.CrosshairMode.Normal },
      });
      setReady(true);
    } catch (e) {
      setLoadErr(String(e));
    }
  });
  onCleanup(() => { chart?.remove(); chart = null; });

  createEffect(() => {
    if (!ready() || !chart || !LW) return;
    const m = model();
    const k = kind();
    if (series) { chart.removeSeries(series); series = null; setLines(0); }
    if (m.empty) return;
    const targets = m.milestones.map((x) => x.value);
    const autoscaleInfoProvider = (orig: () => any) => {
      const r = orig();
      if (!r) return r;
      const lo = Math.min(r.priceRange.minValue, ...targets), hi = Math.max(r.priceRange.maxValue, ...targets);
      return { ...r, priceRange: { minValue: lo, maxValue: hi } };
    };
    const priceFormat = { type: "custom" as const, formatter: fmtAxis, minMove: 1e-15 };
    if (k === "candles") {
      const s = chart.addSeries(LW.CandlestickSeries, { upColor: "#6be3a4", downColor: "#ff7a7a", borderVisible: false, wickUpColor: "#6be3a4", wickDownColor: "#ff7a7a", priceFormat, autoscaleInfoProvider });
      s.setData(m.candles.map((c) => ({ ...c, time: c.time as Time })));
      series = s;
    } else {
      const s = chart.addSeries(LW.LineSeries, { color: "#c6f36b", lineWidth: 2, priceFormat, autoscaleInfoProvider });
      s.setData(m.line.map((x) => ({ time: x.time as Time, value: x.value })));
      series = s;
    }
    setLines(m.milestones.length);
    for (const ms of m.milestones) {
      series.createPriceLine({ price: ms.value, color: "#7cc4ff", lineWidth: 1, lineStyle: LW.LineStyle.Dashed, axisLabelVisible: true, title: `unlock ${ms.unlock_bps / 100}%` });
    }
    chart.timeScale().fitContent();
  });

  const seg = (on: boolean) => `btn sm ${on ? "" : "ghost"}`;
  return (
    <div class="stack" data-testid="price-chart" data-kind={kind()} data-milestone-lines={lines()}>
      <div class="row between" style={{ "flex-wrap": "wrap", gap: "8px" }}>
        <div class="row" style={{ gap: "6px" }}>
          <button class={seg(kind() === "candles")} data-testid="chart-kind-candles" onClick={() => setKind("candles")}>Candles</button>
          <button class={seg(kind() === "line")} data-testid="chart-kind-line" onClick={() => setKind("line")}>Line</button>
          <span style={{ width: "8px" }} />
          <button class={seg(unit() === "fdv")} data-testid="chart-unit-fdv" onClick={() => setUnit("fdv")}>FDV (wNEAR)</button>
          <button class={seg(unit() === "price")} data-testid="chart-unit-price" onClick={() => setUnit("price")}>Price (wNEAR / ${p.l.symbol})</button>
        </div>
        <div class="row" style={{ gap: "6px" }}>
          <Show when={isDemo} fallback={<span class="pill open" title="Lock observations (record) + live pool point, read over NEAR RPC">on-chain · lock observations + live pool</span>}>
            <span class="pill violet" data-testid="chart-demo" title="Simulated chain in your browser">Demo data (simulated)</span>
          </Show>
          <Show when={!model().empty && model().bucket}><span class="pill">{LABEL[model().bucket!] ?? `${model().bucket}s`} candles · {model().points} points</span></Show>
        </div>
      </div>
      <div style={{ position: "relative", height: "300px" }}>
        <div ref={el} style={{ position: "absolute", inset: "0" }} />
        <Show when={loadErr()}>
          <div class="notice warn" style={{ position: "absolute", inset: "0", display: "grid", "place-items": "center" }}>Chart failed to load: {loadErr()}</div>
        </Show>
        <Show when={!loadErr() && (obs.loading && obs() === undefined)}>
          <div class="sub" style={{ position: "absolute", inset: "0", display: "grid", "place-items": "center" }}>Loading price data…</div>
        </Show>
        <Show when={!loadErr() && obs() !== undefined && model().empty}>
          <div data-testid="chart-empty" class="notice" style={{ position: "absolute", inset: "12px", display: "grid", "place-items": "center", "text-align": "center" }}>
            <div>
              <div style={{ "font-weight": 650 }}>Not enough price data yet</div>
              <div class="sub">{model().points} of {MIN_POINTS} points. Prices come from the lock's <code>record</code> observations (anyone can poke the observer) plus the pool's live price.</div>
            </div>
          </div>
        </Show>
      </div>
      <div class="sub">
        {unit() === "fdv" ? "Fully diluted value" : "Price per token"} in wNEAR, log scale. Dashed lines: the lock's unlock thresholds. Candles are built from the recorded observations; buckets with no observation are skipped.
        {" "}Charts by <a class="link" href="https://www.tradingview.com/" target="_blank" rel="noopener">TradingView</a> Lightweight Charts™ · Copyright (c) 2025 TradingView, Inc.
      </div>
    </div>
  );
}
