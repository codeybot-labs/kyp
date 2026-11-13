import { createEffect, createMemo, createSignal, For, Index, Show } from "solid-js";
import { api } from "../lib/source";
import { demo, validateParams } from "../lib/demo";
import { cliCall } from "../lib/near";
import { CONFIG, KYP_ENABLED, NETWORK, NETWORK_LABEL, NETWORK_NAME } from "../lib/config";
import { randomSalt, slotHash, toRaw, tokensForQuote, DEFAULT_SUPPLY } from "../lib/math.mjs";
import type { LaunchParams } from "../lib/model";
import { act, Cli, fmtQ, fmtT, pct, usdOf, Signable, sendTx } from "./ui";
import { account as wallet } from "../lib/wallet";
import { createLaunchTx } from "../lib/actions.mjs";
import { PLATFORMS, externalCommands, externalSignTxs } from "../lib/launchpads";
import NetworkSwitch from "./NetworkSwitch";
import KipSolid from "./KipSolid";

const toQ = (wnear: number | string) => toRaw(String(wnear || 0), 24).toString();
const usdToQ = (usd: number) => toQ((usd / CONFIG.nearUsd).toFixed(6));

interface Invite { account: string; salt: string; hash: string }

export default function CreateLaunch() {
  const isDemo = api.mode() === "demo";
  const [topKipOpen, setTopKipOpen] = createSignal(false);
  const [launcherInput, setLauncher] = createSignal(NETWORK === "mainnet" ? "you.near" : "you.testnet");
  const launcher = () => wallet() ?? launcherInput();
  const [savedCodes, setSavedCodes] = createSignal(false);
  const [selectedPlatforms, setSelectedPlatforms] = createSignal<("kyp" | "nearly" | "justhoot")[]>(KYP_ENABLED ? ["kyp"] : []);
  const togglePlatform = (id: "kyp" | "nearly" | "justhoot", on: boolean) => {
    if (id === "kyp" || !PLATFORMS.find((p) => p.id === id)?.enabled) return;
    const cur = selectedPlatforms();
    if (on) setSelectedPlatforms([...new Set([...cur, id])]);
    else setSelectedPlatforms(cur.filter((x) => x !== id));
  };

  const [name, setName] = createSignal("Moon Moth");
  const [symbol, setSymbol] = createSignal("MOTH");
  const [desc, setDesc] = createSignal("Drawn to the light. Hand-picked presalers who ship memes, code and calls.");
  const [icon, setIcon] = createSignal("");
  const [fdvUsd, setFdvUsd] = createSignal(5000);
  const [capPct, setCapPct] = createSignal(25);
  const [minRaise, setMinRaise] = createSignal(50);
  const [wMin, setWMin] = createSignal(5);
  const [wMax, setWMax] = createSignal(100);
  const [days, setDays] = createSignal(5);
  const [startNow, setStartNow] = createSignal(true);
  const [startAt, setStartAt] = createSignal("");
  const [wallets, setWallets] = createSignal("artist.testnet\nbuilder.testnet\ncaller.testnet\ndegen-dao.testnet\nmemelord.testnet\nnight-dev.testnet");
  const [reservedTxt, setReservedTxt] = createSignal("celebrity.testnet, 100");
  const [ms, setMs] = createSignal([{ usd: 1_000_000, pct: 20 }, { usd: 10_000_000, pct: 30 }, { usd: 25_000_000, pct: 50 }]);
  const [twapMin, setTwapMin] = createSignal(60);
  const [minObs, setMinObs] = createSignal(6);
  const [spacingMin, setSpacingMin] = createSignal(5);
  const [minLiq, setMinLiq] = createSignal("0");
  const [delayMin, setDelayMin] = createSignal(60);
  const [waves, setWaves] = createSignal(3);
  const [waveH, setWaveH] = createSignal(24);
  const [fees, setFees] = createSignal({ h: 50, l: 30, c: 20 });
  const [feeAcc, setFeeAcc] = createSignal({ h: "holders.moth.testnet", l: "lp.moth.testnet", c: "bounties.moth.testnet" });
  const [invites, setInvites] = createSignal<Invite[]>([]);
  const salts = new Map<string, string>();

  const accounts = createMemo(() => [...new Set(wallets().split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))]);
  const reservedRows = createMemo(() => reservedTxt().split("\n").map((ln) => ln.split(",").map((x) => x.trim())).filter((r) => r[0]).map(([a, amt]) => ({ account: a.toLowerCase(), amount: Number(amt || 0) })));

  createEffect(async () => {
    const all = [...accounts(), ...reservedRows().map((r) => r.account)];
    const out: Invite[] = [];
    for (const a of all) {
      if (!salts.has(a)) salts.set(a, randomSalt());
      out.push({ account: a, salt: salts.get(a)!, hash: await slotHash(a, salts.get(a)!) });
    }
    setInvites(out);
  });

  const nowSec = () => api.now();
  const params = createMemo<LaunchParams>(() => {
    const inv = new Map(invites().map((i) => [i.account, i.hash]));
    const start = startNow() || !startAt() ? nowSec() : Math.floor(new Date(startAt()).getTime() / 1000);
    return {
      name: name(), symbol: symbol().toUpperCase(), icon: icon() || null, description: desc(), terms_uri: null,
      quote_token_id: CONFIG.quote, total_supply: null, decimals: null,
      opening_fdv_quote: usdToQ(fdvUsd()), presale_cap_bps: Math.round(capPct() * 100),
      min_raise: toQ(minRaise()), wallet_min: toQ(wMin()), wallet_max: toQ(wMax()),
      allowlist: accounts().map((a) => inv.get(a)).filter(Boolean) as string[],
      reserved: reservedRows().filter((r) => inv.get(r.account)).map((r) => ({ hash: inv.get(r.account)!, quote_amount: toQ(r.amount) })),
      sale_start: start, sale_end: start + Math.round(days() * 86400),
      milestones: ms().map((m) => ({ target_fdv_quote: usdToQ(m.usd), unlock_bps: Math.round(m.pct * 100) })),
      twap: { window_sec: twapMin() * 60, min_observations: minObs(), min_liquidity: minLiq() || "0", claim_delay_sec: delayMin() * 60, min_obs_interval_sec: spacingMin() * 60 },
      reveal: { waves: waves(), interval_sec: Math.round(waveH() * 3600) },
      fee_split: { holders_bps: fees().h * 100, liquidity_bps: fees().l * 100, community_bps: fees().c * 100, holders_account: feeAcc().h, liquidity_account: feeAcc().l, community_account: feeAcc().c },
    };
  });
  const errors = createMemo(() => validateParams(params(), nowSec()));
  const externalCmds = createMemo(() => externalCommands(params(), launcher(), selectedPlatforms()));
  const capTokens = () => (DEFAULT_SUPPLY * BigInt(params().presale_cap_bps)) / 10000n;
  const perNear = () => Number(tokensForQuote(10n ** 24n, DEFAULT_SUPPLY, params().opening_fdv_quote)) / 1e18;
  const msSum = () => ms().reduce((a, m) => a + m.pct, 0);

  const csv = () => "account,invite_code,slot_hash,kind\n" + invites().map((i) => `${i.account},${i.salt},${i.hash},${reservedRows().some((r) => r.account === i.account) ? "reserved" : "open"}`).join("\n");

  const pctVar = (v: number, min: number, max: number) => ((v - min) / (max - min)) * 100 + "%";
  const num = (get: () => number, set: (n: number) => void, opts: { step?: number; min?: number; max?: number } = {}) => (
    <input type="number" value={get()} step={opts.step ?? 1} min={opts.min} max={opts.max} onInput={(e) => set(Number(e.currentTarget.value))} />
  );

  return (
    <div>
      <header class="phead full-bleed">
        <div class="wrap">
          <div>
            <h1>{KYP_ENABLED ? "Create a KYP launch" : "Cross-launch a token"}</h1>
            <p>{KYP_ENABLED ? "Pick your presalers, set public terms and ambitious unlock milestones. Everything except who is invited is public from the start." : "KYP presale is not on mainnet yet. Use this form to launch matching tokens on external NEAR launchpads."}</p>
          </div>
          <div class="stage small">
            <div class={topKipOpen() ? "open" : ""}><KipSolid alt="Kip, the KYP padlock mascot. Click Kip to open the lock." onClick={() => setTopKipOpen(!topKipOpen())} /></div>
          </div>
        </div>
      </header>

      <div class="layout" id="kyp">
        <div class="stack">
          <section class="sec stack">
            <h3>1 · Token</h3>
            <div class="g2">
              <label class="field"><span>Name</span><input value={name()} onInput={(e) => setName(e.currentTarget.value)} /></label>
              <label class="field"><span>Symbol</span><input value={symbol()} autocapitalize="characters" onInput={(e) => setSymbol(e.currentTarget.value.toUpperCase())} /></label>
            </div>
            <label class="field"><span>Description</span><input value={desc()} onInput={(e) => setDesc(e.currentTarget.value)} /></label>
            <label class="field"><span>Icon URL (optional)</span><input placeholder="https://… or data:image/svg+xml,…" value={icon()} onInput={(e) => setIcon(e.currentTarget.value)} /></label>
            <div class="sub">Supply 1,000,000,000 · 18 decimals · minted once to the coordinator · no owner, no further mint.</div>
          </section>

          <section class="sec stack">
            <h3>2 · Price & presale size</h3>
            <div class="g2">
              <label class="field">
                <span>Opening FDV (USD)</span>
                {num(fdvUsd, setFdvUsd, { step: 500 })}
                <small>{fmtQ(params().opening_fdv_quote, 0)} at ${CONFIG.nearUsd}/NEAR · {perNear().toLocaleString(undefined, { maximumFractionDigits: 0 })} {symbol()} per wNEAR</small>
              </label>
              <label class="field">
                <span>Presale cap: <b>{capPct()}</b>% of supply</span>
                <input type="range" min="1" max="50" value={capPct()} style={{ "--p": pctVar(capPct(), 1, 50) }} onInput={(e) => setCapPct(Number(e.currentTarget.value))} />
                <small>{fmtT(capTokens())} tokens · open raise cap {fmtQ(((capTokens() * BigInt(params().opening_fdv_quote)) / DEFAULT_SUPPLY), 0)} wNEAR incl. reserved</small>
              </label>
            </div>
            <div class="g3">
              <label class="field"><span>Min raise (wNEAR)</span>{num(minRaise, setMinRaise)}</label>
              <label class="field"><span>Per-wallet min</span>{num(wMin, setWMin)}</label>
              <label class="field"><span>Per-wallet max</span>{num(wMax, setWMax)}</label>
            </div>
          </section>

          <section class="sec stack">
            <h3>3 · Presale window</h3>
            <div class="g2">
              <label class="field"><span>Opens</span>
                <select value={startNow() ? "now" : "at"} onChange={(e) => setStartNow(e.currentTarget.value === "now")}>
                  <option value="now">Now</option>
                  <option value="at">At a time (≤ 1 day out)</option>
                </select>
              </label>
              <Show when={startNow()} fallback={<label class="field"><span>Start</span><input type="datetime-local" value={startAt()} onInput={(e) => setStartAt(e.currentTarget.value)} /></label>}>
                <label class="field">
                  <span>Length: <b>{days()}</b> days</span>
                  <input type="range" min="1" max="7" step="0.5" value={days()} style={{ "--p": pctVar(days(), 1, 7) }} onInput={(e) => setDays(Number(e.currentTarget.value))} />
                </label>
              </Show>
            </div>
            <Show when={!startNow()}><label class="field"><span>Length: <b>{days()}</b> days</span><input type="range" min="1" max="7" step="0.5" value={days()} style={{ "--p": pctVar(days(), 1, 7) }} onInput={(e) => setDays(Number(e.currentTarget.value))} /></label></Show>
            <div class="sub">You can launch any time once the minimum raise is in. If you don't launch by the end, presalers withdraw.</div>
          </section>

          <section class="sec stack">
            <div class="rw between"><h3>4 · Presalers</h3><span class="chip">{accounts().length} invited · {reservedRows().length} reserved</span></div>
            <label class="field"><span>Invited wallets (one per line)</span><textarea value={wallets()} onInput={(e) => setWallets(e.currentTarget.value)} /></label>
            <label class="field"><span>Reserved slots for later (account, wNEAR)</span><textarea style={{ "min-height": "64px" }} value={reservedTxt()} onInput={(e) => setReservedTxt(e.currentTarget.value)} />
              <small>Reserved wallets buy after launch at the same presale price and lock on the same milestones. Unsold slots stay reserved.</small>
            </label>
            <div class="notice">Only <code>sha256("account:code")</code> goes on-chain. Send each wallet its code privately; it uses it to deposit.</div>
            <div class="tw">
              <table class="t">
                <thead><tr><th>Wallet</th><th>Invite code</th><th>Slot hash</th></tr></thead>
                <tbody><For each={invites()}>{(i) => <tr><td>{reservedRows().some((r) => r.account === i.account) ? "★ " : ""}{i.account}</td><td class="mono">{i.salt}</td><td class="mono dim">{i.hash.slice(0, 10)}…</td></tr>}</For></tbody>
              </table>
            </div>
            <div class="rw">
              <a class="btn sm" href={`data:text/csv;charset=utf-8,${encodeURIComponent(csv())}`} download={`${symbol().toLowerCase()}-invites.csv`}>Download invites (CSV)</a>
              <span class="sub">Keep this file private.</span>
            </div>
          </section>

          <section class="sec stack">
            <div class="rw between"><h3>5 · Unlock milestones</h3><span class={`chip ${msSum() === 100 ? "live" : "warn"}`}>{msSum()}% allocated</span></div>
            <p class="sub">Make them ambitious. The community roots for presalers to get there. FDV = price × (minted − burned), measured as a TWAP.</p>
            <div class="seg">
              <For each={ms()}>{(m) => <i style={{ width: `${msSum() > 0 ? (m.pct / msSum()) * 100 : 0}%` }} />}</For>
            </div>
            <div class="stack">
              <Index each={ms()}>
                {(m, i) => (
                  <div class="rw ms">
                    <label class="field" style={{ flex: 2 }}><span>Target FDV (USD)</span><input type="number" value={m().usd} step="100000" onInput={(e) => setMs(ms().map((x, k) => (k === i ? { ...x, usd: Number(e.currentTarget.value) } : x)))} /></label>
                    <label class="field" style={{ flex: 1 }}><span>Unlock %</span><input type="number" value={m().pct} onInput={(e) => setMs(ms().map((x, k) => (k === i ? { ...x, pct: Number(e.currentTarget.value) } : x)))} /></label>
                    <button class="btn sm ghost" style={{ "margin-bottom": "2px" }} onClick={() => setMs(ms().filter((_, k) => k !== i))} aria-label="Remove milestone">✕</button>
                  </div>
                )}
              </Index>
            </div>
            <div class="rw">
              <button class="btn sm" onClick={() => setMs([...ms(), { usd: (ms().at(-1)?.usd ?? 1_000_000) * 2, pct: 0 }])}>Add milestone</button>
              <span class="sub">first unlock at {(ms()[0]?.usd / fdvUsd() || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}× the opening FDV</span>
            </div>
          </section>

          <section class="sec stack">
            <h3>6 · TWAP, reveal & fees</h3>
            <div class="g3">
              <label class="field"><span>TWAP window (min)</span>{num(twapMin, setTwapMin)}</label>
              <label class="field"><span>Min observations</span>{num(minObs, setMinObs)}</label>
              <label class="field"><span>Obs spacing (min)</span>{num(spacingMin, setSpacingMin)}</label>
              <label class="field"><span>Claim delay (min)</span>{num(delayMin, setDelayMin)}</label>
              <label class="field"><span>Min liquidity (raw)</span><input value={minLiq()} onInput={(e) => setMinLiq(e.currentTarget.value)} /></label>
              <label class="field"><span>Reveal waves</span>{num(waves, setWaves, { min: 1, max: 10 })}</label>
            </div>
            <label class="field"><span>Hours between waves</span>{num(waveH, setWaveH)}</label>
            <div class="g3">
              <label class="field"><span>Holders <b>{fees().h}</b>%</span><input type="number" value={fees().h} onInput={(e) => setFees({ ...fees(), h: Number(e.currentTarget.value) })} /><input value={feeAcc().h} onInput={(e) => setFeeAcc({ ...feeAcc(), h: e.currentTarget.value })} spellcheck={false} autocapitalize="none" /></label>
              <label class="field"><span>Liquidity <b>{fees().l}</b>%</span><input type="number" value={fees().l} onInput={(e) => setFees({ ...fees(), l: Number(e.currentTarget.value) })} /><input value={feeAcc().l} onInput={(e) => setFeeAcc({ ...feeAcc(), l: e.currentTarget.value })} spellcheck={false} autocapitalize="none" /></label>
              <label class="field"><span>Competitions & bounties <b>{fees().c}</b>%</span><input type="number" value={fees().c} onInput={(e) => setFees({ ...fees(), c: Number(e.currentTarget.value) })} /><input value={feeAcc().c} onInput={(e) => setFeeAcc({ ...feeAcc(), c: e.currentTarget.value })} spellcheck={false} autocapitalize="none" /></label>
            </div>
          </section>

          <section class="sec stack">
            <h3>7 · Launch platforms</h3>
            <Show when={KYP_ENABLED} fallback={
              <p class="sub">KYP's own presale contracts are not deployed to {NETWORK} yet. You can still use this form to cross-launch a token on the selected external launchpads. Each launchpad creates its own token and starts its own pool, independent of any KYP lock.</p>
            }>
              <p class="sub">KYP is your presale coordinator. You can also create a matching public token + pool on other NEAR launchpads for visibility. Each launchpad creates its own token and starts its own pool, independent of the KYP lock.</p>
            </Show>
            <Show when={NETWORK !== "mainnet"}><div class="notice warn">NEARly and JustHoot are only available on mainnet. On {NETWORK} you can still prepare the commands, but you will need a mainnet wallet to run them.</div></Show>
            <div class="g3">
              <For each={PLATFORMS}>{(p) => (
                <label class="field" style={{ opacity: p.enabled ? 1 : 0.6 }}>
                  <span style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                    <input type="checkbox" checked={selectedPlatforms().includes(p.id)} disabled={p.id === "kyp" || !p.enabled} onChange={(e) => togglePlatform(p.id, e.currentTarget.checked)} style={{ width: "18px", height: "18px", "min-height": "auto", "margin-right": "2px" }} />
                    <span style={{ "font-weight": 700, color: p.color }}>{p.label}</span>
                    {p.id === "kyp" && <span class="chip live">required</span>}
                  </span>
                  {p.id === "kyp" ? <small>KYP presale with locked presalers and milestone unlocks.</small> : <small>Also create a token on <a class="link" href={p.website} target="_blank" rel="noopener">{p.website}</a>.</small>}
                </label>
              )}</For>
            </div>
          </section>
        </div>

        <aside class="stack aside" style={{ position: "sticky", top: "84px" }}>
          <div class={`rev-card stack ${errors().length === 0 ? "open" : ""}`}>
            <div class="rw between">
              <h3>Review</h3>
              <div class="rk"><KipSolid class={errors().length === 0 ? "open" : ""} alt="Kip opens his lock when the terms are valid" /></div>
            </div>
            <div class="kv">
              <span>Presale price</span><span>{perNear().toLocaleString(undefined, { maximumFractionDigits: 0 })} {symbol()} / wNEAR</span>
              <span>Opening FDV</span><span>{usdOf(params().opening_fdv_quote)}</span>
              <span>Presale cap</span><span>{pct(params().presale_cap_bps)} of supply</span>
              <span>Window</span><span>{days()} days</span>
              <span>Milestones</span><span>{ms().filter((m) => m.usd > 0 && m.pct > 0).map((m) => `$${(m.usd / 1e6).toLocaleString()}m · ${m.pct}%`).join("  ") || "—"}</span>
              <span>Reveal</span><span>{waves()} waves · every {waveH()}h</span>
              <span>Fees</span><span>{fees().h}/{fees().l}/{fees().c}</span>
            </div>
            <label class="field"><span>Launcher account</span><input value={launcher()} disabled={!isDemo && !!wallet()} onInput={(e) => setLauncher(e.currentTarget.value)} />
              <Show when={!isDemo && wallet()}><small>Your connected wallet signs and becomes the launcher.</small></Show>
            </label>
            <Show when={errors().length} fallback={<div class="notice ok">Terms look valid. Same checks run on-chain.</div>}>
              <div class="notice bad"><For each={errors()}>{(e) => <div>• {e}</div>}</For></div>
            </Show>
            <Show when={KYP_ENABLED}>
              <Show when={isDemo} fallback={
                <Signable note={`Connect a ${NETWORK_LABEL} wallet to create the launch.`} cli={<Cli title={`Create on ${NETWORK} (attach 2.6 NEAR: token account + launch storage)`} cmd={cliCall(CONFIG.coordinator, "create_launch", { params: params() }, { deposit: "2.6 NEAR", signer: launcher() })} />}>
                  <label class="rw" style={{ gap: "8px" }}><input type="checkbox" checked={savedCodes()} onChange={(e) => setSavedCodes(e.currentTarget.checked)} /><span class="sub">I downloaded the invite codes (they are not stored on-chain and can't be recovered).</span></label>
                  <button class="btn sm p" data-testid="create-sign" disabled={errors().length > 0 || !savedCodes()} onClick={async () => {
                    try { localStorage.setItem(`kyp-invites-${symbol().toLowerCase()}-${Date.now()}`, csv()); } catch {}
                    const h = await sendTx(async () => createLaunchTx(CONFIG.coordinator, params(), (await api.config()).token_account_deposit), `Launch created on ${NETWORK}`);
                    if (h) location.href = "/";
                  }}>Create launch (sign with wallet)</button>
                  <div class="sub">Attaches the coordinator's token account deposit + 0.1 NEAR for storage.</div>
                </Signable>
              }>
                <button class="btn sm p" disabled={errors().length > 0} onClick={async () => {
                  const id = await act(() => demo.create(launcher(), params(), invites()), "Launch created (demo)");
                  if (id) location.href = `/launch?id=${id}`;
                }}>Create launch (demo)</button>
              </Show>
            </Show>
            <Show when={externalCmds().length}>
              <div style={{ "border-top": "1px solid rgba(255,255,255,0.10)", "padding-top": "16px", "margin-top": "12px" }}>
                <h4 style={{ "font-size": "0.95rem", "margin-bottom": "8px" }}>Cross-launch</h4>
                <p class="sub" style={{ "margin-bottom": "12px" }}>Sign with your wallet to create the selected tokens automatically, using the same name, symbol and icon.</p>
                <Show when={NETWORK === "mainnet"}>
                  <Signable note="Connect a mainnet wallet to sign the external launch transactions in one go.">
                    <button class="btn sm p" disabled={errors().length > 0} onClick={async () => { await sendTx(() => externalSignTxs(params(), selectedPlatforms()), "Cross-launched on external platforms"); }}>Sign external launch transactions</button>
                    <div class="sub">Your wallet will receive one transaction per selected launchpad.</div>
                  </Signable>
                </Show>
                <details style={{ "margin-top": "14px" }}>
                  <summary class="sub" style={{ cursor: "pointer" }}>Or run the NEAR CLI commands manually</summary>
                  <For each={externalCmds()}>{(item) => (
                    <div class="stack" style={{ "margin-top": "12px", "margin-bottom": "16px" }}>
                      <div class="row" style={{ gap: "8px", "align-items": "center" }}>
                        <span class="pill" style={{ "background-color": item.platform.color, color: "#06080d" }}>{item.platform.label}</span>
                        <span class="sub">{item.note}</span>
                      </div>
                      <For each={item.commands}>{(c) => <Cli title={c.label} cmd={c.cmd} />}</For>
                    </div>
                  )}</For>
                </details>
              </div>
            </Show>
          </div>
          <details>
            <summary class="label" style={{ cursor: "pointer" }}>create_launch params (JSON)</summary>
            <pre class="code" style={{ "margin-top": "10px", "max-height": "320px" }}>{JSON.stringify({ params: params() }, null, 2)}</pre>
          </details>
        </aside>
      </div>
    </div>
  );
}
