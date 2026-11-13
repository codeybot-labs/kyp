import { NETWORK, setNetwork } from "../lib/config";

export default function NetworkSwitch() {
  return (
    <select
      class="btn sm ghost network-switch"
      aria-label="Network"
      value={NETWORK}
      onChange={(e) => setNetwork(e.currentTarget.value as "testnet" | "mainnet")}
      style={{ display: "inline-block" }}
    >
      <option value="testnet">Testnet</option>
      <option value="mainnet">Mainnet</option>
    </select>
  );
}
