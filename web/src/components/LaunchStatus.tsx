import { createSignal, For, lazy, Show, Suspense } from "solid-js";
import { api } from "../lib/source";
import { demo } from "../lib/demo";
import { cliCall } from "../lib/near";
import { CONFIG, NETWORK, NETWORK_LABEL, NETWORK_NAME } from "../lib/config";
import { toRaw } from "../lib/math.mjs";
import { MilestoneLadder } from "./Terms";
import { WithLaunch, useLive, useNow, fmtQ, fmtT, usdOf, pct, dur, when, quote, Stat, act, Cli, Signable, sendTx } from "./ui";
import { account as wallet } from "../lib/wallet";
import { isLauncher, canLaunch, launchTx, launchNearNeeded, cancelLaunchTx, resumeLaunchTx, recordTx, qualifyTx, collectFeesTx } from "../lib/actions.mjs";
import type { LaunchView } from "../lib/model";

// lazy: the chart + lightweight-charts load as separate chunks, only when a launch is Live
const PriceChart = lazy(() => import("./PriceChart"));

const STEPS: [keyof LaunchView["progress"], string, string][] = [
  ["lock_funded", "Settle + lock", "Every fill priced at the one presale price; all presale tokens sent to the lock."],
  ["pool_created", "Create pool", "RHEA DCL pool created at the presale price (1% fee tier)."],
  ["token_deposited", "Deposit supply", "Remaining supply (minus reserved slots) deposited to the pool."],
  ["quote_deposited", "Deposit proceeds", "All presale wNEAR deposited as quote-side liquidity."],
  ["liquidity_added", "Seed liquidity", "Single-sided ranges: tokens above the price, wNEAR below. LP owned by the coordinator."],
];

function Body(p: { l: LaunchView }) {
  const now = useNow();
  const l = () => p.l;
  const [tw] = useLive(() => api.twap(p.l.id));
  const [lock] = useLive(() => api.lock(p.l.id));
  const raisedPct = () => Math.min(100, (quote(l().total_raised) / Math.max(1e-9, quote(l().open_cap_quote))) * 100);
  const minPct = () => Math.min(100, (quote(l().min_raise) / Math.max(1e-9, quote(l().open_cap_quote))) * 100);
  const isDemo = api.mode() === "demo";
  const [fdvUsd, setFdvUsd] = createSignal("10000000");

  return (
    <div class="stack">
      <div class="grid g4">
        <Stat label="Raised" value={fmtQ(l().total_raised, 0)} sub={`${usdOf(l().total_raised)} · min ${fmtQ(l().min_raise, 0)}`} />
        <Stat label="Presalers" value={`${l().filled_open_slots}/${l().open_slots}`} sub={`${l().filled_reserved_slots}/${l().reserved_slots} reserved filled`} />
        <Show when={l().status === "Live"} fallback={<Stat label={l().status === "Open" ? "Window closes" : "Window"} value={l().status === "Open" ? dur(l().sale_end - now()) : "—"} sub={when(l().sale_end)} />}>
          <Stat label="TWAP FDV" value={tw()?.twap_fdv_quote ? usdOf(tw()!.twap_fdv_quote!) : "—"} sub={tw()?.ok ? `${tw()!.observations_in_window} obs in window` : tw()?.error ?? "no observations"} />
        </Show>
        <Show when={l().status === "Live"} fallback={<Stat label="Opening FDV" value={usdOf(l().opening_fdv_quote)} sub="pool opens here, presale price" />}>
          <Stat label="Unlocked" value={pct(lock()?.unlocked_bps ?? 0)} sub={`${fmtT(lock()?.total_claimed ?? "0")} of ${fmtT(lock()?.total_locked ?? "0")} claimed`} />
        </Show>
      </div>

      <div class="grid g2">
        <div class="card">
          <div class="card-title"><h3>Presale</h3><span class="sub num">{raisedPct().toFixed(1)}% of open cap</span></div>
          <div class="bar" style={{ position: "relative" }}>
            <i style={{ width: `${raisedPct()}%` }} />
          </div>
          <div class="row between sub" style={{ "margin-top": "8px" }}>
            <span>min raise at {minPct().toFixed(0)}%</span>
            <span>{fmtQ(l().open_cap_quote, 0)} cap</span>
          </div>
          <hr class="sep" />
          <div class="kv">
            <span>Window</span><span>{when(l().sale_start)} → {when(l().sale_end)}</span>
            <span>Presale tokens</span><span>{l().status === "Live" || l().status === "Launching" ? fmtT(l().presale_tokens) : "set at launch"}</span>
            <span>Reserved for later</span><span>{fmtT(l().reserved_tokens)} tokens</span>
            <span>Launcher</span><span class="mono">{l().launcher}</span>
          </div>
        </div>
        <div class="card">
          <div class="card-title"><h3>Launch transaction</h3><Show when={l().launched_at}><span class="sub">{when(l().launched_at!)}</span></Show></div>
          <ul class="steps">
            <For each={STEPS}>
              {([k, t, d], i) => (
                <li>
                  <span class={`ck ${l().progress[k] ? "done" : ""}`}>{l().progress[k] ? "✓" : i() + 1}</span>
                  <div><div style={{ "font-weight": 650 }}>{t}</div><div class="sub">{d}</div></div>
                </li>
              )}
            </For>
          </ul>
          <Show when={l().status === "Launching"}>
            <div class="notice warn" style={{ "margin-top": "10px" }}>The launch is paused or a step stopped. Anyone can call <code>resume_launch</code> (up to 1000 Tgas); it continues from the first incomplete step. On the RHEA DCL each pool deposit needs its own transaction. Presale tokens are already settled at one price and locked.</div>
          </Show>
        </div>
      </div>

      <Show when={l().status === "Live"}>
        <div class="card">
          <div class="card-title">
            <h3>Market vs milestones</h3>
            <span class="sub">spot {tw()?.spot_fdv_quote ? usdOf(tw()!.spot_fdv_quote!) : "—"} · TWAP {tw()?.twap_fdv_quote ? usdOf(tw()!.twap_fdv_quote!) : "—"}</span>
          </div>
          <Suspense fallback={<div class="sub" style={{ height: "300px", display: "grid", "place-items": "center" }}>Loading chart…</div>}>
            <PriceChart l={l()} />
          </Suspense>
          <hr class="sep" />
          <MilestoneLadder l={l()} />
        </div>
        <div class="card">
          <div class="card-title"><h3>Pool</h3><span class="pill">RHEA DCL{isDemo ? " (simulated)" : ""}</span></div>
          <div class="kv">
            <span>Pool id</span><span class="mono">{l().pool_id}</span>
            <span>Token liquidity</span><span>{fmtT(l().lp_tokens)} ${l().symbol}</span>
            <span>wNEAR liquidity</span><span>{fmtQ(l().total_raised)}</span>
            <span>LP positions</span><span class="mono">{l().lpt_ids.join(", ") || "—"}</span>
            <span>Fees waiting</span><span>{l().fee_balances.length ? l().fee_balances.map(([t, b]) => (t === l().quote_token_id ? fmtQ(b) : `${b} ${t}`)).join(", ") : "none"}</span>
          </div>
        </div>
      </Show>

      <Show when={isDemo} fallback={<TestnetActions l={l()} />}>
        <div class="demo-bar stack">
          <div class="row between"><h3>Demo controls</h3><span class="sub">Simulated chain. Time: {when(now())}</span></div>
          <Show when={l().status === "Open"}>
            <div class="row">
              <button class="btn primary" onClick={() => act(() => demo.launchNow(l().id, l().launcher), "Launched: fills settled at one price, tokens locked, pool seeded.")}>Launch now (as {l().launcher})</button>
              <button class="btn" onClick={() => act(() => demo.cancel(l().id, l().launcher), "Presale cancelled; deposits refundable.")}>Cancel presale</button>
              <a class="btn ghost" href={`/deposit?id=${l().id}`}>Make a deposit →</a>
            </div>
          </Show>
          <Show when={l().status === "Live"}>
            <div class="grid g2">
              <div class="stack">
                <label class="field"><span>Simulate trading to an FDV (USD)</span>
                  <div class="row" style={{ "flex-wrap": "nowrap" }}>
                    <input value={fdvUsd()} onInput={(e) => setFdvUsd(e.currentTarget.value)} inputmode="numeric" />
                    <button class="btn" onClick={() => act(() => demo.setPrice(l().id, toRaw((Number(fdvUsd()) / CONFIG.nearUsd).toFixed(6), 24)), `Pool price moved to ~$${Number(fdvUsd()).toLocaleString()} FDV (spot)`)}>Set price</button>
                  </div>
                </label>
                <div class="sub">A spot move alone unlocks nothing. Keep it there for a full TWAP window.</div>
              </div>
              <div class="stack">
                <div class="row">
                  <button class="btn" onClick={() => act(() => demo.record(l().id), "Observation recorded")}>Poke observer</button>
                  <button class="btn" onClick={() => act(() => demo.advance(l().id, l().twap.window_sec + l().twap.min_obs_interval_sec), "Advanced one TWAP window (auto-poked)")}>+{dur(l().twap.window_sec)} window</button>
                  <button class="btn" onClick={() => act(() => demo.advance(l().id, 86400), "Advanced 1 day")}>+1 day</button>
                </div>
                <div class="row">
                  <button class="btn primary" onClick={() => act(() => demo.qualify(l().id), (n) => `${n} milestone(s) qualified. Claim opens after ${dur(l().twap.claim_delay_sec)}.`)}>Qualify milestones</button>
                  <a class="btn ghost" href={`/claim?id=${l().id}`}>Go to claim →</a>
                </div>
              </div>
            </div>
          </Show>
          <Show when={l().status === "Cancelled" || (l().status === "Open" && now() >= l().sale_end)}>
            <div class="notice">Presalers can withdraw their deposit on the <a class="link" href={`/deposit?id=${l().id}`}>deposit page</a>.</div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function TestnetActions(p: { l: LaunchView }) {
  const now = useNow();
  const me = () => wallet();
  const launcher = () => isLauncher(me(), p.l);
  const cli = (
    <>
      <Show when={p.l.status === "Open"}>
        <Cli title="Launch (launcher only)" cmd={cliCall(CONFIG.coordinator, "launch", { launch_id: p.l.id }, { deposit: "0.3 NEAR", signer: p.l.launcher })} />
      </Show>
      <Show when={p.l.status === "Launching"}>
        <Cli title="Resume launch" cmd={cliCall(CONFIG.coordinator, "resume_launch", { launch_id: p.l.id }, { deposit: "0 NEAR", gas: "1000 Tgas" })} />
      </Show>
      <Show when={p.l.status === "Live"}>
        <Cli title="Poke the TWAP observer" cmd={cliCall(CONFIG.lock, "record", { launch_id: p.l.id }, { gas: "100 Tgas" })} />
        <Cli title="Qualify milestones" cmd={cliCall(CONFIG.lock, "qualify", { launch_id: p.l.id }, { gas: "50 Tgas" })} />
      </Show>
    </>
  );
  return (
    <div class="card stack">
      <div class="card-title"><h3>Actions</h3><span class="pill">{NETWORK_NAME.toLowerCase()}{me() ? ` · ${me()}` : ""}</span></div>
      <Signable note={`Connect a ${NETWORK_LABEL} wallet to launch, poke the observer or qualify milestones.`} cli={cli}>
        <Show when={p.l.status === "Open"}>
          <Show when={launcher()} fallback={<div class="notice">Only the launcher ({p.l.launcher}) can launch or cancel this presale.</div>}>
            <div class="row">
              <button class="btn primary" data-testid="launch-sign" disabled={!canLaunch({ account: me(), launch: p.l, now: now() })} onClick={() => sendTx(async () => launchTx(CONFIG.coordinator, p.l.id, launchNearNeeded(await api.config())), "Launch sent: settling fills, funding the lock, seeding the pool")}>Launch now</button>
              <button class="btn" onClick={() => sendTx(() => cancelLaunchTx(CONFIG.coordinator, p.l.id), "Presale cancelled; deposits refundable")}>Cancel presale</button>
            </div>
            <div class="sub">Launch attaches the pool storage NEAR from the coordinator config. Needs the minimum raise and must happen before the window closes.</div>
          </Show>
        </Show>
        <Show when={p.l.status === "Launching"}>
          <button class="btn primary" onClick={() => sendTx(() => resumeLaunchTx(CONFIG.coordinator, p.l.id, (2n * 10n ** 23n).toString()), "Resume sent")}>Resume launch (attach 0.2 NEAR)</button>
        </Show>
        <Show when={p.l.status === "Live"}>
          <div class="row">
            <button class="btn" onClick={() => sendTx(() => collectFeesTx(CONFIG.coordinator, p.l.id), "Trading fees collected into the fee pool")}>Collect trading fees</button>
            <button class="btn" onClick={() => sendTx(() => recordTx(CONFIG.lock, p.l.id), "Observation recorded")}>Poke observer</button>
            <button class="btn primary" onClick={() => sendTx(() => qualifyTx(CONFIG.lock, p.l.id), "Milestones checked")}>Qualify milestones</button>
            <a class="btn ghost" href={`/claim?id=${p.l.id}`}>Go to claim →</a>
          </div>
          <div class="sub">Anyone can poke and qualify. Each call is a small gas-only transaction.</div>
        </Show>
      </Signable>
    </div>
  );
}

export default function LaunchStatus() {
  return <WithLaunch tab="launch">{(L) => <Body l={L()} />}</WithLaunch>;
}
