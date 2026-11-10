import { onMount, Show } from "solid-js";
import { account, connect, disconnect, initWallet, walletInitError, consumeWalletRedirect } from "../lib/wallet";
import { toast } from "./ui";

const short = (a: string) => (a.length > 22 ? `${a.slice(0, 10)}…${a.slice(-8)}` : a);

export default function WalletButton() {
  onMount(() => {
    consumeWalletRedirect(toast);
    initWallet();
  });
  return (
    <Show when={account()} fallback={
      <button class="btn sm primary" data-testid="wallet-connect" title={walletInitError() ?? "Sign in with a NEAR testnet wallet"} onClick={() => connect().catch((e) => toast(`Wallet: ${e?.message ?? e}`, "bad"))}>
        Connect wallet
      </button>
    }>
      {(a) => (
        <div class="row" style={{ gap: "6px" }}>
          <span class="pill live mono" data-testid="wallet-account" title={`${a()} (NEAR testnet)`}><span class="dot" />{short(a())}</span>
          <button class="btn sm ghost" data-testid="wallet-disconnect" onClick={() => disconnect().then(() => toast("Wallet disconnected"))}>Disconnect</button>
        </div>
      )}
    </Show>
  );
}
