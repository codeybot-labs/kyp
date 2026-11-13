import { onMount, Show } from "solid-js";
import { account, disconnect, initWallet, walletInitError, consumeWalletRedirect } from "../lib/wallet";
import { toast, connectWallet } from "./ui";
import { NETWORK_LABEL } from "../lib/config";

const short = (a: string) => (a.length > 22 ? `${a.slice(0, 10)}…${a.slice(-8)}` : a);

export default function WalletButton() {
  onMount(() => {
    consumeWalletRedirect(toast);
    initWallet();
  });
  return (
    <Show when={account()} fallback={
      <button class="wallet" data-testid="wallet-connect" title={walletInitError() ?? `Sign in with a ${NETWORK_LABEL} wallet`} onClick={connectWallet}>
        Connect<span class="wx"> wallet</span>
      </button>
    }>
      {(a) => (
        <button class="wallet on" data-testid="wallet-account" title={`${a()} (${NETWORK_LABEL})`} onClick={() => disconnect().then(() => toast("Wallet disconnected"))}>
          {short(a())}
        </button>
      )}
    </Show>
  );
}
