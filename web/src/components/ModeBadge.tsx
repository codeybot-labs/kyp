import { Show } from "solid-js";
import { api, setMode } from "../lib/source";
import { TESTNET_CONFIGURED, CONFIG, NETWORK, NETWORK_NAME, INSTANCES, INSTANCE, setInstance } from "../lib/config";
import { resetDemo } from "../lib/demo";

export default function ModeBadge() {
  const m = api.mode();
  return (
    <div class="row" style={{ gap: "8px" }}>
      <Show when={m === "demo"} fallback={<span class="pill live" title={`coordinator ${CONFIG.coordinator}`}><span class="dot" />{NETWORK_NAME}</span>}>
        <span class="pill violet" title="Simulated chain in your browser. Nothing is signed or sent."><span class="dot" />Demo mode</span>
        <button class="btn sm ghost" title="Reset demo data" onClick={() => { resetDemo(); location.reload(); }}>Reset</button>
      </Show>
      <Show when={m !== "demo" && INSTANCES.length > 1}>
        <select class="btn sm" data-testid="instance" title="Which testnet deployment the site reads and signs against" value={INSTANCE} onChange={(e) => setInstance(e.currentTarget.value as "primary" | "alt")}>
          {INSTANCES.map((i) => <option value={i.id}>{i.label}</option>)}
        </select>
      </Show>
      <Show when={TESTNET_CONFIGURED}>
        <button class="btn sm" onClick={() => setMode(m === "demo" ? "testnet" : "demo")}>{m === "demo" ? `Use ${NETWORK}` : "Use demo"}</button>
      </Show>
    </div>
  );
}
