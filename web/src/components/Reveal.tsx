import { For, Show } from "solid-js";
import { api } from "../lib/source";
import { demo } from "../lib/demo";
import { cliCall } from "../lib/near";
import { CONFIG } from "../lib/config";
import { isReserved, type LaunchView } from "../lib/model";
import { WithLaunch, useLive, useNow, fmtQ, fmtT, dur, when, act, Cli, Signable, sendTx } from "./ui";
import { revealTx } from "../lib/actions.mjs";

function Body(p: { l: LaunchView }) {
  const l = () => p.l;
  const now = useNow();
  const [ps] = useLive(() => api.presalers(p.l.id));
  const waves = () => Array.from({ length: l().reveal.waves }, (_, i) => i + 1);
  const waveAt = (w: number) => (l().launched_at ? l().launched_at! + w * l().reveal.interval_sec : null);
  const isDemo = api.mode() === "demo";
  return (
    <div class="stack">
      <div class="card">
        <div class="card-title">
          <h2>Presalers, revealed in waves</h2>
          <span class="pill">{l().revealed_waves}/{l().reveal.waves} revealed</span>
        </div>
        <p class="muted">Sizes are public from the start. Accounts are revealed after launch, smallest positions first, one wave every {dur(l().reveal.interval_sec)}. Reserved-slot buyers are revealed with the last wave. Anyone can trigger a wave once it is due.</p>
        <Show when={l().status === "Live"} fallback={<div class="notice" style={{ "margin-top": "12px" }}>Reveal starts after launch. {l().filled_open_slots} presalers so far, all hidden.</div>}>
          <div class="row" style={{ "margin-top": "14px" }}>
            <Show when={l().next_wave_at} fallback={<span class="pill live">All waves revealed</span>}>
              {(t) => <span class="pill open">Wave {l().revealed_waves + 1} {now() >= t() ? "is due now" : `in ${dur(t() - now())}`}</span>}
            </Show>
            <Show when={isDemo}>
              <button class="btn sm primary" disabled={!l().next_wave_at || now() < l().next_wave_at!} onClick={() => act(() => demo.revealNext(l().id), "Next wave revealed")}>Reveal next wave</button>
              <button class="btn sm" onClick={() => act(() => demo.advance(l().id, l().reveal.interval_sec), `Advanced ${dur(l().reveal.interval_sec)}`)}>+{dur(l().reveal.interval_sec)} (demo)</button>
            </Show>
          </div>
          <Show when={!isDemo}>
            <div style={{ "margin-top": "12px" }}>
              <Signable note="Anyone can reveal a wave once it is due. Connect a wallet to sign." cli={<Cli title="Reveal next wave (anyone)" cmd={cliCall(CONFIG.coordinator, "reveal_next_wave", { launch_id: l().id }, { gas: "30 Tgas" })} />}>
                <button class="btn sm primary" disabled={!l().next_wave_at || now() < l().next_wave_at!} onClick={() => sendTx(() => revealTx(CONFIG.coordinator, l().id), "Next wave revealed")}>Reveal next wave</button>
              </Signable>
            </div>
          </Show>
        </Show>
      </div>
      <div class="grid g2">
        <For each={waves()}>
          {(w) => {
            const items = () => (ps() ?? []).filter((x) => x.wave === w);
            const revealed = () => w <= l().revealed_waves;
            return (
              <div class={`wave ${revealed() ? "revealed" : ""}`}>
                <div class="row between">
                  <h3>Wave {w}</h3>
                  <span class={`pill ${revealed() ? "live" : ""}`}>{revealed() ? "Revealed" : waveAt(w) ? when(waveAt(w)!) : "after launch"}</span>
                </div>
                <div class="sub" style={{ margin: "4px 0 8px" }}>{items().length} {items().length === 1 ? "presaler" : "presalers"} · {fmtQ(items().reduce((a, x) => a + BigInt(x.quote), 0n), 0)}</div>
                <For each={items()} fallback={<span class="dim sub">—</span>}>
                  {(x) => (
                    <span class={`chip ${x.account_id ? "" : "hidden"}`}>
                      {isReserved(x.kind) ? "★ " : ""}{x.account_id ?? "hidden ••••"} <span class="dim">{fmtQ(x.quote, 0)} · {fmtT(x.tokens)}</span>
                    </span>
                  )}
                </For>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}

export default function Reveal() {
  return <WithLaunch tab="reveal">{(L) => <Body l={L()} />}</WithLaunch>;
}
