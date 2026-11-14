import { createEffect, createResource, createSignal, For, Match, Show, Switch } from "solid-js";
import { api } from "../lib/source";
import { demo } from "../lib/demo";
import { cliCall } from "../lib/near";
import { CONFIG } from "../lib/config";
import { slotHash, tokensForQuote, toRaw } from "../lib/math.mjs";
import { isReserved, type LaunchView } from "../lib/model";
import { WithLaunch, useLive, useNow, fmtQ, fmtT, usdOf, dur, act, Cli, quote, Signable, sendTx } from "./ui";
import { account as wallet, buildDeposit } from "../lib/wallet";
import { depositGate, depositMsg, canWithdraw, withdrawTx } from "../lib/actions.mjs";

function Body(p: { l: LaunchView }) {
  const l = () => p.l;
  const now = useNow();
  const isDemo = api.mode() === "demo";
  const [accountInput, setAccount] = createSignal("");
  // Testnet + connected wallet: you act as the wallet account. Demo: any account (simulated).
  const account = () => (!isDemo && wallet() ? wallet()! : accountInput());
  const [salt, setSalt] = createSignal("");
  // Default to the most this wallet can put in (per-wallet max, capped by room left), never more.
  const [amount, setAmount] = createSignal("");
  const [edited, setEdited] = createSignal(false);
  const [hash, setHash] = createSignal("");
  createEffect(async () => {
    const a = account().trim(), s = salt().trim();
    setHash(a && s ? await slotHash(a, s) : "");
  });
  const [slot, { refetch }] = createResource(() => [hash(), l().total_raised] as const, ([h]) => (h ? api.slot(l().id, h) : Promise.resolve(null)));
  const [invites] = useLive(() => (isDemo ? demo.invites(l().id) : Promise.resolve([])));

  const typedRaw = () => { try { return toRaw(amount() || "0", 24); } catch { return 0n; } };
  const already = () => (slot() && !isReserved(slot()!.kind) ? BigInt(slot()!.deposit || "0") : 0n);
  /** Most this wallet can still deposit: wallet_max minus what it already put in, capped by the room left. */
  const maxRaw = () => { const m = BigInt(l().wallet_max) - already(), r = roomCap(); const v = m < r ? m : r; return v > 0n ? v : 0n; };
  const amountRaw = () => { const t = typedRaw(), m = maxRaw(); return t > m ? m : t; };
  const toWhole = (raw: bigint) => { const d = 10n ** 24n, w = raw / d, f = (raw % d).toString().padStart(24, "0").slice(0, 6).replace(/0+$/, ""); return f ? `${w}.${f}` : `${w}`; };
  createEffect(() => { const m = maxRaw(); if (!edited()) setAmount(toWhole(m)); });
  const tokens = () => tokensForQuote(amountRaw(), l().total_supply, l().opening_fdv_quote);
  const reserved = () => slot() && isReserved(slot()!.kind);
  const open = () => l().status === "Open" && now() >= l().sale_start && now() < l().sale_end;
  const refundable = () => l().status === "Cancelled" || (l().status === "Open" && now() >= l().sale_end);
  const roomCap = () => BigInt(l().open_cap_quote) - BigInt(l().total_raised);
  const msg = (kind: "Deposit" | "BuyReserved") => JSON.stringify({ [kind]: { launch_id: l().id, salt: salt().trim() } });


  const cli = () => (
    <>
            <Cli title="1. Wrap NEAR (if needed)" cmd={cliCall(CONFIG.quote, "near_deposit", {}, { deposit: `${toWhole(amountRaw())} NEAR`, gas: "30 Tgas", signer: account() || undefined })} />
            <Cli title={`2. ${reserved() ? "Buy reserved slot" : "Deposit"} (ft_transfer_call)`} cmd={cliCall(CONFIG.quote, "ft_transfer_call", {
              receiver_id: CONFIG.coordinator,
              amount: reserved() ? (slot()!.kind as any).Reserved.quote_amount : amountRaw().toString(),
              msg: msg(reserved() ? "BuyReserved" : "Deposit"),
            }, { deposit: "1 yoctoNEAR", gas: "150 Tgas", signer: account() || undefined })} />
      <Show when={refundable()}>
        <Cli title="Withdraw refund" cmd={cliCall(CONFIG.coordinator, "withdraw", { launch_id: l().id }, { gas: "60 Tgas", signer: account() || undefined })} />
      </Show>
    </>
  );

  const gate = () => depositGate({ account: wallet(), slot: slot() ?? null, launch: l(), now: now() });
  const WalletActions = () => (
    <div class="stack">
      <Show when={salt().trim()} fallback={<div class="notice">Enter the invite code the launcher sent you. Only invited wallets can deposit.</div>}>
        <Show when={!slot.loading}>
          <Switch>
            <Match when={gate().reason === "not-allowlisted"}><div class="notice bad">This wallet is not on the presale list with that code.</div></Match>
            <Match when={gate().reason === "closed"}><div class="notice">The presale is not taking deposits right now.</div></Match>
            <Match when={gate().reason === "reserved-after-launch"}><div class="notice">Your reserved slot opens after launch.</div></Match>
            <Match when={gate().reason === "filled"}><div class="notice ok">Your reserved slot is filled.</div></Match>
            <Match when={gate().reason === "deposit"}>
              <div class="stack">
              <button class="btn primary" data-testid="deposit-sign" disabled={amountRaw() <= 0n || (already() === 0n && amountRaw() < BigInt(l().wallet_min))} onClick={() => sendTx(() => buildDeposit(wallet()!, amountRaw(), depositMsg("Deposit", l().id, salt().trim())), `Deposited up to ${fmtQ(amountRaw())}`, () => refetch())}>Deposit {fmtQ(amountRaw())}</button>
              <small class="sub">One wallet transaction to wNEAR: registers storage and wraps NEAR if needed, then <code>ft_transfer_call</code> to the coordinator. Any excess is refunded.</small>
              </div>
            </Match>
            <Match when={gate().reason === "buy-reserved"}>
              <button class="btn primary" onClick={() => sendTx(() => buildDeposit(wallet()!, BigInt((slot()!.kind as any).Reserved.quote_amount), depositMsg("BuyReserved", l().id, salt().trim())), "Reserved slot bought; tokens locked", () => refetch())}>Buy reserved slot ({fmtQ((slot()!.kind as any).Reserved.quote_amount)})</button>
            </Match>
          </Switch>
        </Show>
      </Show>
      <Show when={canWithdraw({ account: wallet(), launch: l(), now: now(), deposited: !!slot() && BigInt(slot()!.deposit) > 0n })}>
        <button class="btn" onClick={() => sendTx(() => withdrawTx(CONFIG.coordinator, l().id), "Refund requested", () => refetch())}>Withdraw refund ({fmtQ(slot()!.deposit)})</button>
      </Show>
    </div>
  );

  return (
    <div class="grid g2" style={{ "align-items": "start" }}>
      <div class="card stack">
        <div class="card-title"><h2>{reserved() && l().status === "Live" ? "Buy your reserved slot" : "Presale deposit"}</h2>
          <span class={`pill ${open() ? "open" : ""}`}>{open() ? `closes in ${dur(l().sale_end - now())}` : l().status === "Live" ? "Live — reserved slots only" : l().status}</span>
        </div>
        <label class="field"><span>Your NEAR account</span><input placeholder={CONFIG.exampleAccount} value={account()} disabled={!isDemo && !!wallet()} onInput={(e) => setAccount(e.currentTarget.value)} />
          <Show when={!isDemo && wallet()}><small>From your connected wallet.</small></Show></label>
        <label class="field"><span>Invite code</span><input placeholder="from the launcher, sent privately" value={salt()} onInput={(e) => setSalt(e.currentTarget.value)} />
          <small>Your slot is <code>sha256("account:code")</code>. The code never goes on-chain until you deposit, so nobody can tell who is invited.</small>
        </label>
        <Show when={hash()}>
          <Show when={!slot.loading} fallback={<div class="skeleton" />}>
            <Show when={slot()} fallback={<div class="notice bad">No slot matches this account + code.</div>}>
              {(s) => (
                <div class="notice ok">
                  {isReserved(s().kind) ? `Reserved slot · ${fmtQ((s().kind as any).Reserved.quote_amount)} at the presale price, opens after launch` : "Invited slot found"}
                  {s().filled ? ` · deposited ${fmtQ(s().deposit)}` : ""}
                </div>
              )}
            </Show>
          </Show>
        </Show>
        <Show when={!reserved() && (isDemo || !wallet() || gate().ok)}>
          <label class="field"><span>Amount</span>
            <div class="input-suffix"><input inputmode="decimal" value={amount()} onInput={(e) => { setEdited(true); setAmount(e.currentTarget.value); }} /><em>wNEAR</em></div>
            <Show when={typedRaw() > maxRaw()}><small class="warn-text" data-testid="deposit-clamped">Max for this wallet is {fmtQ(maxRaw())}, so {fmtQ(maxRaw())} will be deposited (nothing extra is wrapped).</small></Show>
            <Show when={amountRaw() > 0n && amountRaw() < BigInt(l().wallet_min) && already() === 0n}><small class="warn-text">Minimum per wallet is {fmtQ(l().wallet_min)}.</small></Show>
            <small>Per wallet {fmtQ(l().wallet_min, 0)} – {fmtQ(l().wallet_max, 0)} · {fmtQ(roomCap() > 0n ? roomCap() : 0n, 0)} left under the cap. Any excess is refunded automatically.</small>
          </label>
          <div class="kv">
            <span>You get (locked)</span><span>{fmtT(tokens())} ${l().symbol}</span>
            <span>Price</span><span>same as every caballero and the pool open</span>
            <span>Value at opening FDV</span><span>{usdOf(amountRaw())}</span>
            <span>Value at first milestone</span><span>{l().milestones[0] ? usdOf((amountRaw() * BigInt(l().milestones[0].target_fdv_quote)) / BigInt(l().opening_fdv_quote)) : "—"}</span>
          </div>
        </Show>
        <Show when={isDemo} fallback={
          <Signable note="Connect the wallet you were invited with to deposit." cli={cli()}>
            <WalletActions />
          </Signable>
        }>
          <div class="row">
            <Show when={!reserved()} fallback={
              <button class="btn primary" disabled={l().status !== "Live" || !slot() || slot()!.filled} onClick={() => act(() => demo.buyReserved(l().id, account().trim(), salt().trim()), (t) => `Bought ${fmtT(t)} ${l().symbol}, locked on the same milestones`).then(() => refetch())}>Buy reserved slot</button>
            }>
              <button class="btn primary" disabled={!open() || !slot()} onClick={() => act(() => demo.deposit(l().id, account().trim(), salt().trim(), amountRaw()), (r) => `Deposited ${fmtQ(r.accepted)}${r.refunded > 0n ? ` · ${fmtQ(r.refunded)} refunded` : ""}`).then(() => refetch())}>Deposit wNEAR</button>
            </Show>
            <Show when={refundable()}>
              <button class="btn" onClick={() => act(() => demo.withdraw(l().id, account().trim()), (a) => `Refunded ${fmtQ(a)}`).then(() => refetch())}>Withdraw refund</button>
            </Show>
          </div>
        </Show>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-title"><h3>What you're agreeing to</h3></div>
          <ul class="muted" style={{ margin: 0, "padding-left": "18px", display: "grid", gap: "8px" }}>
            <li>Your deposit is escrowed until launch. It is refundable only if the launch is cancelled or misses the window ({dur(Math.max(0, l().sale_end - now()))} left).</li>
            <li>At launch, every caballero gets tokens at the same price, straight into the lock. They never sit in your wallet or the launcher's.</li>
            <li>Tokens unlock only at the public FDV milestones (first: {l().milestones[0] ? usdOf(l().milestones[0].target_fdv_quote) : "—"}), measured as a TWAP, not spot.</li>
            <li>Your deposit size is public now. Your account is revealed after launch in wave order, smallest first.</li>
          </ul>
        </div>
        <Show when={isDemo && (invites() ?? []).length}>
          <div class="demo-bar">
            <div class="row between"><h3>Demo invites</h3><span class="sub">click to fill</span></div>
            <p class="sub" style={{ margin: "6px 0 8px" }}>In real use the launcher sends each code privately. They are shown here so you can try the flow.</p>
            <For each={invites()}>
              {(i) => (
                <button class="chip" style={{ cursor: "pointer", opacity: i.used ? 0.5 : 1 }} onClick={() => { setAccount(i.account); setSalt(i.salt); }}>
                  {isReserved(i.kind) ? "★ " : ""}{i.account} <span class="dim mono">{i.salt}</span>{i.used ? " · used" : ""}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}

export default function Deposit() {
  return <WithLaunch tab="deposit">{(L) => <Body l={L()} />}</WithLaunch>;
}
