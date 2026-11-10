import { For, Show } from "solid-js";
import { api } from "../lib/source";
import { useLive, useNow, StatusPill, TokenBadge, fmtQ, usdOf, pct, dur, quote } from "./ui";
import type { LaunchView } from "../lib/model";

function Card(p: { l: LaunchView }) {
  const now = useNow();
  const l = p.l;
  const raisedPct = () => Math.min(100, (quote(l.total_raised) / Math.max(1e-9, quote(l.open_cap_quote))) * 100);
  const first = l.milestones[0];
  return (
    <a class="card" href={`/launch?id=${l.id}`} style={{ display: "block" }}>
      <div class="row" style={{ gap: "12px" }}>
        <TokenBadge symbol={l.symbol} icon={l.icon} />
        <div style={{ flex: 1, "min-width": 0 }}>
          <div class="row between">
            <h3>{l.name} <span class="muted" style={{ "font-weight": 500 }}>${l.symbol}</span></h3>
            <StatusPill status={l.status} saleEnd={l.sale_end} now={now()} />
          </div>
          <div class="sub">#{l.id} · by {l.launcher}</div>
        </div>
      </div>
      <div style={{ margin: "16px 0 8px" }} class="bar"><i style={{ width: `${raisedPct()}%` }} /></div>
      <div class="row between sub num">
        <span>{fmtQ(l.total_raised, 0)} of {fmtQ(l.open_cap_quote, 0)}</span>
        <span>{l.filled_open_slots}/{l.open_slots} presalers{l.reserved_slots ? ` · ${l.reserved_slots} reserved` : ""}</span>
      </div>
      <hr class="sep" />
      <div class="grid g3" style={{ gap: "10px" }}>
        <div><div class="label">Opening FDV</div><div class="num">{usdOf(l.opening_fdv_quote)}</div></div>
        <div><div class="label">First unlock</div><div class="num">{first ? `${usdOf(first.target_fdv_quote)} · ${pct(first.unlock_bps)}` : "—"}</div></div>
        <div>
          <div class="label">{l.status === "Live" ? "Live for" : l.status === "Open" ? "Closes in" : "Status"}</div>
          <div class="num">{l.status === "Live" && l.launched_at ? dur(now() - l.launched_at) : l.status === "Open" ? dur(l.sale_end - now()) : l.status}</div>
        </div>
      </div>
    </a>
  );
}

export default function LaunchList() {
  const [launches] = useLive(() => api.list());
  return (
    <Show when={launches()} fallback={<div class="grid g2"><div class="card"><div class="skeleton" /></div><div class="card"><div class="skeleton" /></div></div>}>
      <Show when={launches()!.length} fallback={<div class="card"><h3>No launches yet</h3><p class="muted" style={{ "margin-top": "6px" }}>Be the first: <a class="link" href="/create">create a launch</a>.</p></div>}>
        <div class="grid g2"><For each={launches()}>{(l) => <Card l={l} />}</For></div>
      </Show>
    </Show>
  );
}
