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
    <a class="card reveal" href={`/launch?id=${l.id}`} style={{ display: "block" }}>
      <div class="top">
        <TokenBadge symbol={l.symbol} icon={l.icon} />
        <div>
          <h3>{l.name}</h3>
          <div class="tag">${l.symbol} · #{l.id} · {l.status === "Live" ? "Live" : l.status === "Open" ? `closes in ${dur(l.sale_end - now())}` : l.status}</div>
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
  return (
    <Show when={launches()} fallback={<div class="grid g2"><div class="card"><div class="skeleton" /></div><div class="card"><div class="skeleton" /></div></div>}>
      <Show when={launches()!.length} fallback={<div class="card"><h3>No launches yet</h3><p class="muted" style={{ "margin-top": "6px" }}>Be the first: <a class="link" href="/create">create a launch</a>.</p></div>}>
        <div class="grid g2"><For each={launches()}>{(l) => <Card l={l} />}</For></div>
      </Show>
    </Show>
  );
}
