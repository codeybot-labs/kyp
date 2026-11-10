import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import { api } from "../lib/source";
import { demo } from "../lib/demo";
import { cliCall } from "../lib/near";
import { CONFIG } from "../lib/config";
import { slotHash, tokensForQuote, toRaw } from "../lib/math.mjs";
import { isReserved, type LaunchView } from "../lib/model";
import { WithLaunch, useLive, useNow, fmtQ, fmtT, usdOf, dur, act, Cli, quote } from "./ui";

function Body(p: { l: LaunchView }) {
  const l = () => p.l;
  const now = useNow();
  const isDemo = api.mode() === "demo";
  const [account, setAccount] = createSignal("");
  const [salt, setSalt] = createSignal("");
  const [amount, setAmount] = createSignal("10");
  const [hash, setHash] = createSignal("");
  createEffect(async () => {
    const a = account().trim(), s = salt().trim();
    setHash(a && s ? await slotHash(a, s) : "");
  });
  const [slot, { refetch }] = createResource(() => [hash(), l().total_raised] as const, ([h]) => (h ? api.slot(l().id, h) : Promise.resolve(null)));
  const [invites] = useLive(() => (isDemo ? demo.invites(l().id) : Promise.resolve([])));

  const amountRaw = () => { try { return toRaw(amount() || "0", 24); } catch { return 0n; } };
  const tokens = () => tokensForQuote(amountRaw(), l().total_supply, l().opening_fdv_quote);
  const reserved = () => slot() && isReserved(slot()!.kind);
  const open = () => l().status === "Open" && now() >= l().sale_start && now() < l().sale_end;
  const refundable = () => l().status === "Cancelled" || (l().status === "Open" && now() >= l().sale_end);
  const roomCap = () => BigInt(l().open_cap_quote) - BigInt(l().total_raised);
  const msg = (kind: "Deposit" | "BuyReserved") => JSON.stringify({ [kind]: { launch_id: l().id, salt: salt().trim() } });

  return (
    <div class="grid g2" style={{ "align-items": "start" }}>
      <div class="card stack">
        <div class="card-title"><h2>{reserved() && l().status === "Live" ? "Buy your reserved slot" : "Presale deposit"}</h2>
          <span class={`pill ${open() ? "open" : ""}`}>{open() ? `closes in ${dur(l().sale_end - now())}` : l().status === "Live" ? "Live — reserved slots only" : l().status}</span>
        </div>
        <label class="field"><span>Your NEAR account</span><input placeholder="you.testnet" value={account()} onInput={(e) => setAccount(e.currentTarget.value)} /></label>
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
        <Show when={!reserved()}>
          <label class="field"><span>Amount</span>
            <div class="input-suffix"><input inputmode="decimal" value={amount()} onInput={(e) => setAmount(e.currentTarget.value)} /><em>wNEAR</em></div>
            <small>Per wallet {fmtQ(l().wallet_min, 0)} – {fmtQ(l().wallet_max, 0)} · {fmtQ(roomCap() > 0n ? roomCap() : 0n, 0)} left under the cap. Any excess is refunded automatically.</small>
          </label>
          <div class="kv">
            <span>You get (locked)</span><span>{fmtT(tokens())} ${l().symbol}</span>
            <span>Price</span><span>same as every presaler and the pool open</span>
            <span>Value at opening FDV</span><span>{usdOf(amountRaw())}</span>
            <span>Value at first milestone</span><span>{l().milestones[0] ? usdOf((amountRaw() * BigInt(l().milestones[0].target_fdv_quote)) / BigInt(l().opening_fdv_quote)) : "—"}</span>
          </div>
        </Show>
        <Show when={isDemo} fallback={
          <>
            <Cli title="1. Wrap NEAR (if needed)" cmd={cliCall(CONFIG.quote, "near_deposit", {}, { deposit: `${amount() || "0"} NEAR`, gas: "30 Tgas", signer: account() || undefined })} />
            <Cli title={`2. ${reserved() ? "Buy reserved slot" : "Deposit"} (ft_transfer_call)`} cmd={cliCall(CONFIG.quote, "ft_transfer_call", {
              receiver_id: CONFIG.coordinator,
              amount: reserved() ? (slot()!.kind as any).Reserved.quote_amount : amountRaw().toString(),
              msg: msg(reserved() ? "BuyReserved" : "Deposit"),
            }, { deposit: "1 yoctoNEAR", gas: "150 Tgas", signer: account() || undefined })} />
          </>
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
        <Show when={refundable() && !isDemo}>
          <Cli title="Withdraw refund" cmd={cliCall(CONFIG.coordinator, "withdraw", { launch_id: l().id }, { gas: "50 Tgas", signer: account() || undefined })} />
        </Show>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-title"><h3>What you're agreeing to</h3></div>
          <ul class="muted" style={{ margin: 0, "padding-left": "18px", display: "grid", gap: "8px" }}>
            <li>Your deposit is escrowed until launch. It is refundable only if the launch is cancelled or misses the window ({dur(Math.max(0, l().sale_end - now()))} left).</li>
            <li>At launch, every presaler gets tokens at the same price, straight into the lock. They never sit in your wallet or the launcher's.</li>
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
