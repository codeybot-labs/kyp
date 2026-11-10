import { Show } from "solid-js";
import { api, setMode } from "../lib/source";
import { TESTNET_CONFIGURED, CONFIG } from "../lib/config";
import { resetDemo } from "../lib/demo";

export default function ModeBadge() {
  const m = api.mode();
  return (
    <div class="row" style={{ gap: "8px" }}>
      <Show when={m === "demo"} fallback={<span class="pill live" title={`coordinator ${CONFIG.coordinator}`}><span class="dot" />Testnet</span>}>
        <span class="pill violet" title="Simulated chain in your browser. Nothing is signed or sent."><span class="dot" />Demo mode</span>
        <button class="btn sm ghost" title="Reset demo data" onClick={() => { resetDemo(); location.reload(); }}>Reset</button>
      </Show>
      <Show when={TESTNET_CONFIGURED}>
        <button class="btn sm" onClick={() => setMode(m === "demo" ? "testnet" : "demo")}>{m === "demo" ? "Use testnet" : "Use demo"}</button>
      </Show>
    </div>
  );
}
