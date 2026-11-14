import { createSignal, For, Show } from "solid-js";
import { api } from "../lib/source";
import { NETWORK_NAME } from "../lib/config";
import { useLive, useNow, StatusPill, TokenBadge, fmtQ, usdOf, pct, dur, quote } from "./ui";
import type { LaunchView } from "../lib/model";

/** Launches made by the site's testnet "Test mode" quick start. */
export const isTestRun = (l: LaunchView) => /created by KYP Test mode/i.test(l.description ?? "");
/** Hidden from the default list: cancelled launches, and test runs that never got a deposit. */
export const isStale = (l: LaunchView, now: number) =>
  l.status === "Cancelled" || l.status === "Failed" ||
  (isTestRun(l) && l.status === "Open" && BigInt(l.total_raised || "0") === 0n && (l.filled_open_slots ?? 0) === 0) ||
  (l.status === "Open" && now >= l.sale_end && BigInt(l.total_raised || "0") === 0n);

function Card(p: { l: LaunchView; simulated: boolean }) {
  const now = useNow();
  const l = p.l;
  const raisedPct = () => Math.min(100, (quote(l.total_raised) / Math.max(1e-9, quote(l.open_cap_quote))) * 100);
  const first = l.milestones[0];
  return (
    <a class="card reveal" href={`/launch?id=${l.id}`} style={{ display: "block" }}>
      <div class="top">
        <TokenBadge symbol={l.symbol} icon={l.icon} />
        <div>
          <h3>{l.name}</h3>
          <div class="tag">${l.symbol} · #{l.id} · {l.status === "Live" ? "Live" : l.status === "Open" ? `closes in ${dur(l.sale_end - now())}` : l.status}</div>
          <Show when={p.simulated || isTestRun(l)}>
            <div style={{ "margin-top": "4px" }}><span class="pill violet" title={p.simulated ? "Simulated in your browser, not on chain" : "Created by the testnet quick start (test wallets, no real funds)"}>{p.simulated ? "Simulated preview" : "Testnet test run"}</span></div>
          </Show>
        </div>
        <div style={{ "margin-left": "auto" }}>
          <StatusPill status={l.status} saleEnd={l.sale_end} now={now()} />
        </div>
      </div>
      <div class="row between" style={{ margin: "8px 0" }}>
        <span class="sub">{fmtQ(l.total_raised, 0)} of {fmtQ(l.open_cap_quote, 0)}</span>
        <span class="sub">{l.filled_open_slots}/{l.open_slots} presalers</span>
      </div>
      <div class="bar"><i style={{ width: `${raisedPct()}%` }} /></div>
      <div class="row between" style={{ margin: "12px 0" }}>
        <span class="sub">Raise {fmtQ(l.total_raised, 0)}</span>
        <span class="sub">First unlock {first ? usdOf(first.target_fdv_quote) : "—"}</span>
      </div>
    </a>
  );
}

export default function LaunchList() {
  const [launches] = useLive(() => api.list());
  const simulated = api.mode() === "demo";
  const [showAll, setShowAll] = createSignal(false);
  const nowS = () => Math.floor(Date.now() / 1000);
  const shown = () => (launches() ?? []).filter((l) => showAll() || !isStale(l, nowS()));
  const hidden = () => (launches() ?? []).filter((l) => isStale(l, nowS())).length;
  return (
    <Show when={launches()} fallback={<div class="grid g2"><div class="card"><div class="skeleton" /></div><div class="card"><div class="skeleton" /></div></div>}>
      <Show when={simulated}>
        <div class="notice warn" style={{ "margin-bottom": "14px" }}>
          <b>Simulated preview{NETWORK_NAME === "Mainnet" ? " · Mainnet coming soon" : ""}.</b> KYP contracts are live on NEAR testnet only. The launches below are simulated in your browser, not on chain.
        </div>
      </Show>
      <Show when={shown().length} fallback={<div class="card"><h3>No launches yet</h3><p class="muted" style={{ "margin-top": "6px" }}>Be the first: <a class="link" href="/create">create a launch</a>.</p></div>}>
        <div class="grid g2"><For each={shown()}>{(l) => <Card l={l} simulated={simulated} />}</For></div>
      </Show>
      <Show when={hidden() > 0}>
        <p class="sub" style={{ "margin-top": "12px" }}>
          {showAll() ? "Showing" : "Hiding"} {hidden()} {hidden() === 1 ? "launch" : "launches"} with no deposits or cancelled (test runs).{" "}
          <button type="button" class="link" style={{ background: "none", border: "0", padding: "0", cursor: "pointer" }} onClick={() => setShowAll(!showAll())}>{showAll() ? "Hide" : "Show"}</button>
        </p>
      </Show>
    </Show>
  );
}
