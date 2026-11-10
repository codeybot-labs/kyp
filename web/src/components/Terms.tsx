import { For, Show } from "solid-js";
import { api } from "../lib/source";
import { WithLaunch, useLive, fmtQ, usdOf, pct, dur, when, quote, fmtT, Stat } from "./ui";
import { tokensForQuote } from "../lib/math.mjs";
import { CONFIG } from "../lib/config";
import type { LaunchView } from "../lib/model";

export function MilestoneLadder(p: { l: LaunchView }) {
  const [lock] = useLive(() => api.lock(p.l.id));
  const [tw] = useLive(() => api.twap(p.l.id));
  const cur = () => (tw()?.twap_fdv_quote ? quote(tw()!.twap_fdv_quote!) : tw()?.spot_fdv_quote ? quote(tw()!.spot_fdv_quote!) : quote(p.l.opening_fdv_quote));
  const open = () => quote(p.l.opening_fdv_quote);
  // log-scale progress from opening FDV to each target
  const prog = (target: number) => Math.max(0, Math.min(100, (Math.log(cur() / open()) / Math.log(target / open())) * 100));
  return (
    <div class="ladder">
      <For each={p.l.milestones}>
        {(m, i) => {
          const c = () => p.l.milestones.slice(0, i() + 1).reduce((a, x) => a + x.unlock_bps, 0);
          const ms = () => lock()?.milestones[i()];
          return (
            <div class="rung">
              <div>
                <div class="t num">{usdOf(m.target_fdv_quote)}</div>
                <div class="sub num">{fmtQ(m.target_fdv_quote, 0)} FDV</div>
              </div>
              <div>
                <div class="row between sub" style={{ "margin-bottom": "6px" }}>
                  <span>Unlocks <b style={{ color: "var(--text)" }}>{pct(m.unlock_bps)}</b> · cumulative {pct(c())}</span>
                  <span class="num">{(quote(m.target_fdv_quote) / open()).toLocaleString(undefined, { maximumFractionDigits: 0 })}× opening</span>
                </div>
                <div class="meter"><i style={{ width: `${ms()?.qualified_at ? 100 : prog(quote(m.target_fdv_quote))}%` }} /></div>
              </div>
              <div>
                <Show when={ms()?.qualified_at} fallback={<span class="pill">Locked</span>}>
                  {(t) => {
                    const claimAt = t() + p.l.twap.claim_delay_sec;
                    return <span class="pill live" title={`Qualified ${when(t())}`}><span class="dot" />{api.now() >= claimAt ? "Unlocked" : `Claimable in ${dur(claimAt - api.now())}`}</span>;
                  }}
                </Show>
              </div>
            </div>
          );
        }}
      </For>
    </div>
  );
}

export default function Terms() {
  return <WithLaunch tab="terms">{(L) => <TermsBody l={L()} />}</WithLaunch>;
}

function TermsBody(p: { l: LaunchView }) {
        const l = p.l;
        const supply = BigInt(l.total_supply);
        const perNear = Number(tokensForQuote(10n ** 24n, supply, l.opening_fdv_quote)) / 1e18;
        const capTokens = (supply * BigInt(l.presale_cap_bps)) / 10000n;
        return (
          <div class="stack">
            <div class="grid g4">
              <Stat label="Presale price" value={<>{perNear.toLocaleString(undefined, { maximumFractionDigits: 0 })}</>} sub={`$${l.symbol} per wNEAR · same for everyone`} />
              <Stat label="Opening FDV" value={usdOf(l.opening_fdv_quote)} sub={`${fmtQ(l.opening_fdv_quote, 0)} · pool opens at this price`} />
              <Stat label="Presale cap" value={pct(l.presale_cap_bps)} sub={`${fmtT(capTokens)} of ${fmtT(supply)} supply (max 50%)`} />
              <Stat label="Raise" value={fmtQ(p.l.total_raised, 0)} sub={`of ${fmtQ(l.open_cap_quote, 0)} open cap · min ${fmtQ(l.min_raise, 0)}`} />
            </div>

            <div class="card">
              <div class="card-title"><h2>Unlock milestones</h2><span class="pill">FDV = price × (minted − burned)</span></div>
              <p class="muted" style={{ "margin-bottom": "10px" }}>
                Presale tokens sit in the lock contract from the launch transaction. A tranche unlocks only when the time-weighted FDV stays at or above its target for the whole window below. Targets are fixed in wNEAR on-chain; USD is shown at a reference ${CONFIG.nearUsd}/NEAR.
              </p>
              <MilestoneLadder l={l} />
            </div>

            <div class="grid g2">
              <div class="card">
                <div class="card-title"><h3>Presale rules</h3></div>
                <div class="kv">
                  <span>Payment</span><span>wNEAR only ({l.quote_token_id})</span>
                  <span>Per wallet</span><span>{fmtQ(l.wallet_min, 0)} – {fmtQ(l.wallet_max, 0)}</span>
                  <span>Window</span><span>{when(l.sale_start)} → {when(l.sale_end)}</span>
                  <span>Invited wallets</span><span>{l.open_slots} (hashed until reveal)</span>
                  <span>Reserved slots</span><span>{l.reserved_slots} · {fmtQ(l.reserved_quote_total, 0)}</span>
                  <span>Refunds</span><span>If cancelled or not launched by window end</span>
                  <span>Settlement</span><span>All fills at one price, in the launch tx</span>
                </div>
              </div>
              <div class="card">
                <div class="card-title"><h3>TWAP rules (anti-spoof)</h3></div>
                <div class="kv">
                  <span>Averaging window</span><span>{dur(l.twap.window_sec)}</span>
                  <span>Min observations</span><span>{l.twap.min_observations}</span>
                  <span>Min spacing</span><span>{dur(l.twap.min_obs_interval_sec)}</span>
                  <span>Min pool liquidity</span><span class="mono">{l.twap.min_liquidity}</span>
                  <span>Claim delay</span><span>{dur(l.twap.claim_delay_sec)} after qualifying</span>
                  <span>Observer</span><span>Permissionless <code>record</code></span>
                </div>
              </div>
              <div class="card">
                <div class="card-title"><h3>Reveal schedule</h3></div>
                <div class="kv">
                  <span>Waves</span><span>{l.reveal.waves}, smallest presalers first</span>
                  <span>Cadence</span><span>every {dur(l.reveal.interval_sec)} after launch</span>
                  <span>Reserved buyers</span><span>with the final wave</span>
                  <span>Public now</span><span>Sizes, terms, slot count</span>
                </div>
              </div>
              <div class="card">
                <div class="card-title"><h3>Fee routing</h3></div>
                <div class="kv">
                  <span>Holders</span><span>{pct(l.fee_split.holders_bps)} → <code>{l.fee_split.holders_account}</code></span>
                  <span>Liquidity</span><span>{pct(l.fee_split.liquidity_bps)} → <code>{l.fee_split.liquidity_account}</code></span>
                  <span>Competitions & bounties</span><span>{pct(l.fee_split.community_bps)} → <code>{l.fee_split.community_account}</code></span>
                  <span>Launch LP</span><span>Owned by coordinator, no remove method</span>
                </div>
              </div>
            </div>
            <div class="card">
              <div class="card-title"><h3>Contracts</h3></div>
              <div class="kv">
                <span>Token</span><span class="mono">{l.token_id}</span>
                <span>Pool</span><span class="mono">{l.pool_contract} · {l.pool_id}</span>
                <span>Opening point</span><span class="mono">{l.init_point}</span>
                <span>Launcher</span><span class="mono">{l.launcher}</span>
              </div>
            </div>
          </div>
        );
}
