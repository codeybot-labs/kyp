import { createResource, createSignal, For, Show } from "solid-js";
import { api } from "../lib/source";
import { demo, onDemoChange } from "../lib/demo";
import { cliCall } from "../lib/near";
import { CONFIG } from "../lib/config";
import type { LaunchView } from "../lib/model";
import { WithLaunch, useLive, useNow, fmtT, usdOf, pct, dur, act, Cli, quote, tok, fdvAt } from "./ui";
import { fmtUsd } from "../lib/math.mjs";

function Body(p: { l: LaunchView }) {
  const l = () => p.l;
  const now = useNow();
  const isDemo = api.mode() === "demo";
  const [account, setAccount] = createSignal("");
  const [tick, setTick] = createSignal(0);
  onDemoChange(() => setTick((t) => t + 1));
  const [pos] = createResource(() => [account().trim(), tick(), now()] as const, async ([a]) => {
    if (!a) return null;
    const [position, claimable] = await Promise.all([api.position(l().id, a), api.claimable(l().id, a)]);
    return position ? { ...position, claimable } : null;
  });
  const [lock] = useLive(() => api.lock(p.l.id));
  const [tw] = useLive(() => api.twap(p.l.id));
  const [invites] = useLive(() => (isDemo ? demo.invites(p.l.id) : Promise.resolve([])));
  const priceNow = () => (tw()?.spot_point != null ? fdvAt(l(), tw()!.spot_point!) / (Number(BigInt(l().total_supply)) / 1e18) : quote(l().opening_fdv_quote) / (Number(BigInt(l().total_supply)) / 1e18));

  return (
    <div class="grid g2" style={{ "align-items": "start" }}>
      <div class="card stack">
        <div class="card-title"><h2>Claim unlocked tokens</h2><span class="pill">{pct(lock()?.unlocked_bps ?? 0)} unlocked</span></div>
        <Show when={l().status === "Live"} fallback={<div class="notice">Claims open after launch, once a milestone qualifies.</div>}>
          <label class="field"><span>Presaler account</span><input placeholder="you.testnet" value={account()} onInput={(e) => setAccount(e.currentTarget.value)} /></label>
          <Show when={account().trim()}>
            <Show when={pos()} fallback={<div class="notice">{pos.loading ? "Loading…" : "No locked position for this account."}</div>}>
              {(x) => {
                const total = () => BigInt(x().total);
                return (
                  <>
                    <div class="grid g3">
                      <div><div class="label">Locked total</div><div class="big num" style={{ "font-size": "22px" }}>{fmtT(x().total)}</div></div>
                      <div><div class="label">Claimed</div><div class="big num" style={{ "font-size": "22px" }}>{fmtT(x().claimed)}</div></div>
                      <div><div class="label">Claimable now</div><div class="big num" style={{ "font-size": "22px", color: "var(--accent)" }}>{fmtT(x().claimable)}</div></div>
                    </div>
                    <div class="sub">Position value at spot ≈ {fmtUsd(priceNow() * tok(x().total) * CONFIG.nearUsd)}</div>
                    <table class="t">
                      <thead><tr><th>Milestone</th><th class="r">Tranche</th><th class="r">Tokens</th><th class="r">State</th></tr></thead>
                      <tbody>
                        <For each={lock()?.milestones ?? []}>
                          {(m) => {
                            const claimAt = () => (m.qualified_at ? m.qualified_at + l().twap.claim_delay_sec : null);
                            return (
                              <tr>
                                <td class="num">{usdOf(m.target_fdv_quote)}</td>
                                <td class="r">{pct(m.unlock_bps)}</td>
                                <td class="r num">{fmtT((total() * BigInt(m.unlock_bps)) / 10000n)}</td>
                                <td class="r">{claimAt() == null ? <span class="pill">Locked</span> : now() >= claimAt()! ? <span class="pill live">Unlocked</span> : <span class="pill warn">in {dur(claimAt()! - now())}</span>}</td>
                              </tr>
                            );
                          }}
                        </For>
                      </tbody>
                    </table>
                    <Show when={isDemo} fallback={<Cli title="Claim (sign as the presaler)" cmd={cliCall(CONFIG.lock, "claim", { launch_id: l().id }, { gas: "60 Tgas", signer: account().trim() })} />}>
                      <button class="btn primary" disabled={BigInt(x().claimable) === 0n} onClick={() => act(() => demo.claim(l().id, account().trim()), (a) => `Claimed ${fmtT(a)} ${l().symbol}`)}>Claim {fmtT(x().claimable)} ${l().symbol}</button>
                    </Show>
                  </>
                );
              }}
            </Show>
          </Show>
        </Show>
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-title"><h3>How unlocks work</h3></div>
          <ol class="muted" style={{ margin: 0, "padding-left": "18px", display: "grid", gap: "8px" }}>
            <li>Anyone pokes <code>record</code> on the lock; it reads the pool's price and the token supply.</li>
            <li>When the time-weighted FDV over {dur(l().twap.window_sec)} (≥ {l().twap.min_observations} observations) is at or above a target, anyone calls <code>qualify</code>.</li>
            <li>After a {dur(l().twap.claim_delay_sec)} delay that tranche is claimable by every presaler — same terms for all, reserved slots included.</li>
            <li>No admin key can move locked tokens. Qualified milestones stay qualified.</li>
          </ol>
        </div>
        <Show when={isDemo && (invites() ?? []).some((i) => i.used)}>
          <div class="demo-bar">
            <h3>Demo presalers</h3>
            <div style={{ "margin-top": "6px" }}>
              <For each={(invites() ?? []).filter((i) => i.used)}>{(i) => <button class="chip" style={{ cursor: "pointer" }} onClick={() => setAccount(i.account)}>{i.account}</button>}</For>
            </div>
            <p class="sub" style={{ "margin-top": "8px" }}>Nothing to claim? On the <a class="link" href={`/launch?id=${l().id}`}>status page</a>, set a price above the first milestone, advance one TWAP window, then qualify.</p>
          </div>
        </Show>
      </div>
    </div>
  );
}

export default function Claim() {
  return <WithLaunch tab="claim">{(L) => <Body l={L()} />}</WithLaunch>;
}
