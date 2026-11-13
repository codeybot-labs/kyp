import { createSignal, For, onMount, Show } from "solid-js";
import { api, setMode } from "../lib/source";
import { TESTNET_CONFIGURED, CONFIG, NETWORK_NAME, INSTANCES, INSTANCE, setInstance } from "../lib/config";
import { resetDemo } from "../lib/demo";

export default function ModeBadge() {
  const m = api.mode();
  const [open, setOpen] = createSignal(false);
  const label = () => (m === "demo" ? (NETWORK_NAME === "Mainnet" ? "Mainnet preview" : "Demo mode") : NETWORK_NAME);
  let root!: HTMLDivElement;

  onMount(() => {
    const close = (e: MouseEvent) => { if (!root.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("click", close);
    document.addEventListener("keydown", esc);
  });

  const toggle = (fn: () => void) => { fn(); setOpen(false); };

  return (
    <div class="dd" ref={root}>
      <button class="dd-btn" aria-haspopup="true" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <span class="dd-label">Mode:</span>
        <span>{label()}</span>
        <i aria-hidden="true">▾</i>
      </button>
      <ul class="dd-menu" role="menu" aria-label="Network mode">
        <li role="none">
          <button role="menuitemradio" aria-checked={m === "demo"} onClick={() => toggle(() => { if (m !== "demo") setMode("demo"); })}>
            Demo mode <small>Simulated chain</small>
          </button>
        </li>
        <Show when={TESTNET_CONFIGURED}>
          <li role="none">
            <button role="menuitemradio" aria-checked={m !== "demo"} onClick={() => toggle(() => { if (m === "demo") setMode(api.mode() === "demo" ? "testnet" : "testnet"); })}>
              Testnet mode <small>{NETWORK_NAME}</small>
            </button>
          </li>
        </Show>
        <Show when={INSTANCES.length > 1}>
          <For each={INSTANCES}>
            {(i) => (
              <li role="none">
                <button role="menuitemradio" aria-checked={INSTANCE === i.id} onClick={() => toggle(() => setInstance(i.id as "primary" | "alt"))}>
                  {i.label} <small>instance</small>
                </button>
              </li>
            )}
          </For>
        </Show>
        <Show when={m === "demo"}>
          <li role="none">
            <button onClick={() => toggle(() => { resetDemo(); location.reload(); })}>
              Reset demo data
            </button>
          </li>
        </Show>
      </ul>
    </div>
  );
}
